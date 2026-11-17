/**
 * 全局复盘：小时使用习惯，以及工作区 / 会话 / 工具的资源账目。
 * 数据由独立只读接口按窗口聚合；不把整条会话历史冒充窗口内消耗。
 * 本模块只依赖 React 和插件自己的格式化函数，不导入 Harness Client 包。
 */
import React from 'react'
import { formatCny, formatDateTime, formatDurationMs, formatTokens } from './format.js'
import { notifyStore } from './Notifier.js'
import { reviewCache } from './reviewStore.js'
import { HeroCard } from './sessionDetailView.js'

const { createElement: h, useEffect, useMemo, useState } = React
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const HABIT_METRICS = [
  { id: 'turns', label: '对话轮次' },
  { id: 'cost', label: '估算费用' },
  { id: 'durationMs', label: '有效耗时' },
  { id: 'requests', label: '模型请求' },
]
const ENTITIES = [
  { id: 'workspaces', label: '工作区' },
  { id: 'sessions', label: '会话' },
  { id: 'tools', label: '工具调用' },
]
const MONEY_SORTS = [{ id: 'cost', label: '费用' }, { id: 'durationMs', label: '耗时' }, { id: 'tokens', label: 'Token' }]
const SESSION_SORTS = [{ id: 'activityAt', label: '最近使用' }, { id: 'cost', label: '费用' }, { id: 'durationMs', label: '有效耗时' }, { id: 'tokens', label: 'Token' }, { id: 'requests', label: '模型请求' }]
const sessionSortOf = (value) => SESSION_SORTS.some((item) => item.id === value) ? value : 'activityAt'
const TOOL_SORTS = [{ id: 'durationMs', label: '累计耗时' }, { id: 'calls', label: '调用次数' }, { id: 'maxMs', label: '单次最慢' }]
const SOURCES = [{ id: 'all', label: '全部来源' }, { id: 'builtin', label: '内置' }, { id: 'third-party', label: '第三方' }, { id: 'unknown', label: '来源未知' }]
const SOURCE_LABELS = { builtin: '内置', 'third-party': '第三方', unknown: '来源未知' }

export function reviewValue(value, metric, timezone) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return '—'
  if (metric === 'activityAt') return formatDateTime(Number(value), timezone)
  if (metric === 'cost') return formatCny(value)
  if (metric.endsWith('Ms')) return formatDurationMs(value)
  if (metric === 'tokens') return formatTokens(value)
  return `${Number(value).toLocaleString('zh-CN')} ${metric === 'turns' ? '轮' : '次'}`
}

/** 缺测永远排最后；0ms 是真实可用的测量。 */
export function rankReviewRows(rows, metric) {
  const number = (value) => value === null || value === undefined || typeof value === 'boolean'
    || typeof value === 'string' && value.trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value)
  const descending = (left, right) => left === null ? right === null ? 0 : 1 : right === null ? -1 : right - left
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) =>
    descending(number(a[metric]), number(b[metric])) || descending(number(a.cost), number(b.cost)) || String(a.id).localeCompare(String(b.id)))
}

function Choices({ options, value, onChange, label }) {
  return h('div', { className: 'px-review-choices', role: 'group', 'aria-label': label },
    options.map((option) => h('button', {
      type: 'button', key: option.id, 'aria-pressed': value === option.id,
      className: value === option.id ? 'selected' : '', onClick: () => { onChange(option.id) },
    }, option.label)))
}

function ReviewPanel({ title, hint, actions, children, className = '' }) {
  return h('section', { className: `px-panel px-review-panel ${className}`, 'aria-label': title },
    h('div', { className: 'px-review-head' },
      h('div', { className: 'px-review-heading' }, h('h2', null, title), hint ? h('span', null, hint) : null), actions),
    h('div', { className: 'px-review-body' }, children))
}

function SourceBadge({ source }) {
  const kind = Object.hasOwn(SOURCE_LABELS, source?.kind) ? source.kind : 'unknown'
  const matched = source?.method === 'declaration'
  return h('span', { className: `px-review-source ${kind}`, title: [source?.packageName || source?.label, source?.evidence].filter(Boolean).join('\n') || '没有可靠的插件归属记录' }, `${SOURCE_LABELS[kind]}${matched ? '·匹配' : ''}`)
}

/** Stable skeleton mirrors each page, rather than briefly collapsing to one line. */
export function ReviewLoading({ page = 'resources', error = false }) {
  return h('div', { className: 'px-review-skeleton', 'data-layout': page, role: 'status', 'aria-label': error ? '复盘暂不可用' : '正在整理复盘数据' },
    h(ReviewPanel, { title: page === 'habits' ? '使用习惯' : '资源去向', hint: error ? '读取失败，可在上方重试' : '正在整理，保留页面位置' },
      h('div', { className: 'px-review-skeleton-metrics', 'aria-hidden': 'true' }, [0,1,2,3].map((n) => h('i', { key: n }))),
      page === 'habits' ? h('div', { className: 'px-review-skeleton-chart', 'aria-hidden': 'true' })
        : Array.from({length:8}, (_,n) => h('div', { key:n, className:'px-review-skeleton-row', 'aria-hidden':'true' }, h('i'), h('i'), h('i')))))
}

/** Cached data keeps its old period label while a new period is pending; never relabel stale values. */
export function ReviewSection({ rangeDays, rangeLabel, revision, timezone, page = 'resources' }) {
  const [resourceScope, setResourceScope] = useState('recent')
  const scope = page === 'habits' ? 'all' : resourceScope
  const key = String(rangeDays) + ':' + scope
  const [state, setState] = useState(() => ({ key, data: reviewCache.peek(rangeDays, scope), error: '', busy: true }))
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    setState((previous) => ({ key, data: reviewCache.peek(rangeDays, scope) ?? previous.data, error: '', busy: true }))
    reviewCache.load({ days: rangeDays, scope, revision, force: retry > 0 }).then((data) => {
      if (active) setState({ key, data, error: '', busy: false })
    }, (error) => {
      if (active) setState((previous) => ({ ...previous, key, error: String(error?.message ?? error), busy: false }))
    })
    // Requests belong to the shared bounded cache, not a 3-second render's cleanup.
    return () => { active = false }
  }, [rangeDays, scope, revision, retry])

  const cached = reviewCache.peek(rangeDays, scope)
  const matching = state.data?.range?.days === Number(rangeDays) && state.data?.scope === scope ? state.data : cached
  const data = matching ?? state.data
  const switching = !!data && !matching
  const busy = state.key !== key || state.busy
  const shownLabel = data ? String(data.range?.days) + ' 日' : rangeLabel
  const scopeLabel = (value) => value === 'recent' ? '近期未归档' : '窗口全部（含归档）'
  const shownRange = shownLabel + ' · ' + scopeLabel(data?.scope)
  const requestedRange = rangeLabel + ' · ' + scopeLabel(scope)
  return h('div', { className: 'px-review px-review-page' + (switching ? ' is-switching' : ''), 'aria-busy': busy },
    page === 'resources' ? h('div', { className: 'px-review-scope-bar' },
      h(Choices, { options: [{id:'recent',label:'近期未归档'},{id:'all',label:'窗口全部（含归档）'}], value: resourceScope, label: '会话范围', onChange: setResourceScope }),
      h('span', { className:'px-review-note' }, '只显示当前时间窗口，历史账本不丢弃')) : null,
    h('div', { className: 'px-review-load-status' + (state.error ? ' error' : ''), role:'status', 'aria-live':'polite' },
      h('span', null, state.error ? state.error + (data ? '。仍显示 ' + shownRange + (switching ? '，新范围尚未应用。' : ' 的上一份数据。') : '')
        : switching ? '正在切换至 ' + requestedRange + '；下方仍显示 ' + shownRange + '…'
          : busy ? '正在后台更新，保留当前账目…' : '已更新 · ' + formatDateTime(data?.generatedAt, timezone)),
      state.error ? h('button', { type:'button', className:'px-btn small', onClick:() => { setRetry((n) => n+1) } }, '重试') : null),
    h('div', { className:'px-review-content', inert: switching ? '' : undefined }, data
      ? h(ReviewView, { data, page, rangeLabel: shownLabel, onOpenSession: (id) => notifyStore().openSession(id) })
      : h(ReviewLoading, { page, error: !!state.error })))
}

/** Page isolation prevents hidden charts/lists from lengthening the current page. */
export function ReviewView({ data, rangeLabel, onOpenSession, page = 'all' }) {
  return h(React.Fragment, null,
    page !== 'resources' ? h(UsageHabits, { data, rangeLabel }) : null,
    page !== 'habits' ? h(ResourceLedger, { data, rangeLabel, onOpenSession }) : null)
}

export function UsageHabits({ data, rangeLabel }) {
  const [metric, setMetric] = useState('turns')
  const [picked, setPicked] = useState(null)
  const hours = Array.isArray(data.hours) ? data.hours : []
  const cells = Array.isArray(data.weekHours) ? data.weekHours : []
  const total = hours.reduce((sum, point) => sum + Number(point[metric] ?? 0), 0)
  const maxHour = Math.max(0, ...hours.map((point) => Number(point[metric] ?? 0)))
  const maxCell = Math.max(0, ...cells.map((point) => Number(point[metric] ?? 0)))
  const peak = maxHour > 0 ? hours.find((point) => Number(point[metric]) === maxHour) : null
  const weekend = cells.filter((cell) => cell.weekday >= 5).reduce((sum, cell) => sum + Number(cell[metric] ?? 0), 0)
  const hourText = (hour) => `${String(hour).padStart(2, '0')}:00–${String(hour + 1).padStart(2, '0')}:00`
  const cellText = (cell) => `${cell.weekday === undefined ? '每日累计' : WEEKDAYS[cell.weekday]} ${hourText(cell.hour)} · ${reviewValue(metric === 'durationMs' && !data.coverage?.timedSessions ? null : cell[metric], metric)}`
  const selection = picked === null ? null : (picked.weekday === undefined ? hours : cells)
    .find((cell) => cell.hour === picked.hour && cell.weekday === picked.weekday)
  const metricLabel = HABIT_METRICS.find((item) => item.id === metric)?.label
  const missingTiming = metric === 'durationMs' && !data.coverage?.timedSessions

  return h(ReviewPanel, {
    title: '使用习惯', hint: `${rangeLabel} · ${data.timezone} · 全窗口（含归档）`,
    actions: h(Choices, { options: HABIT_METRICS, value: metric, label: '使用习惯统计指标', onChange: (value) => { setMetric(value); setPicked(null) } }),
  },
  h('div', { className: 'px-review-habit-summary' },
    h('span', null, metricLabel, h('b', null, metric === 'durationMs' && !data.coverage?.timedSessions ? '—' : reviewValue(total, metric))),
    h('span', null, '最集中时段', h('b', null, peak ? hourText(peak.hour) : '暂无记录')),
    h('span', null, '周末占比', h('b', null, total > 0 ? `${Math.round(weekend / total * 100)}%` : '—'))),
  h('div', { className: 'px-review-habits' },
    h('div', { className: 'px-review-hours-wrap' },
      h('h3', null, '一天中的使用分布'),
      h('div', { className: 'px-review-hours', role: 'group', 'aria-label': `24 小时${metricLabel}分布` },
        hours.map((point) => h('button', {
          type: 'button', key: point.hour, className: 'px-review-hour', disabled: missingTiming,
          title: cellText(point), 'aria-label': cellText(point),
          'aria-pressed': picked?.hour === point.hour && picked?.weekday === undefined,
          onClick: () => { setPicked({ hour: point.hour }) },
        }, h('span', { className: 'px-review-hour-rail' }, h('i', {
          style: { height: `${maxHour > 0 ? Math.max(0, Number(point[metric] ?? 0)) / maxHour * 100 : 0}%` },
        })), h('span', { className: 'px-review-hour-label' }, point.hour % 3 === 0 || point.hour === 23 ? String(point.hour).padStart(2, '0') : ''))))),
    h('div', { className: 'px-review-week-wrap' },
      h('h3', null, '一周中的使用分布'),
      h('div', { className: 'px-review-week-scroll' },
        h('div', { className: 'px-review-week', role: 'group', 'aria-label': `星期与小时${metricLabel}热力图` },
          h('span', { className: 'px-review-week-corner' }),
          Array.from({ length: 24 }, (_, hour) => h('span', { key: `h${hour}`, className: 'px-review-week-hour' }, hour % 3 === 0 || hour === 23 ? String(hour).padStart(2, '0') : '')),
          WEEKDAYS.map((label, weekday) => h(React.Fragment, { key: label },
            h('span', { className: 'px-review-week-label' }, label),
            Array.from({ length: 24 }, (_, hour) => {
              const cell = cells.find((point) => point.weekday === weekday && point.hour === hour) ?? { weekday, hour }
              const amount = Number(cell[metric] ?? 0)
              const level = maxCell > 0 && amount > 0 ? Math.max(1, Math.ceil(amount / maxCell * 4)) : 0
              return h('button', {
                type: 'button', key: hour, className: `px-review-cell level-${level}`, disabled: missingTiming,
                title: cellText(cell), 'aria-label': cellText(cell),
                'aria-pressed': picked?.hour === hour && picked?.weekday === weekday,
                onClick: () => { setPicked({ weekday, hour }) },
              })
            }))))),
      h('div', { className: 'px-review-heat-legend', 'aria-hidden': 'true' }, '少', [0, 1, 2, 3, 4].map((n) => h('i', { key: n, className: `px-review-cell level-${n}` })), '多'))),
  h('p', { className: 'px-review-selection', 'aria-live': 'polite' }, missingTiming ? '当前窗口没有可用轮次计时，空白图不代表耗时为零。' : selection ? cellText(selection) : '悬停或点击柱形、色块，查看对应时段的累计值。'),
  h('p', { className: 'px-review-note' }, metric === 'durationMs'
    ? `有效耗时已排除问答工具区间（近似），不是在线时长；已扣等待用户 ${reviewValue(data.summary?.awaitingUserMs, 'durationMs')}。${data.coverage?.timedSessions ?? 0}/${data.coverage?.sessionCount ?? 0} 个会话有计时。`
    : metric === 'turns' ? '人机对话按用户输入或手动继续进入执行日志的时刻归档，同轮多次输入只计一轮；自动续跑、子代理消息、回答问答工具不算新的人机对话。'
      : '模型请求仅表示执行工作量，不代表用户持续参与；费用按模型单价折算，不代表套餐实际扣款。'))
}

export function ResourceLedger({ data, rangeLabel, onOpenSession, initialEntity = 'workspaces', initialExpanded = '', initialSort, initialSessionSort = 'activityAt', initialPageIndex = 0 }) {
  const [entity, setEntity] = useState(initialEntity)
  const [sort, setSort] = useState(initialSort ?? (initialEntity === 'tools' ? 'durationMs' : initialEntity === 'sessions' ? 'activityAt' : 'cost'))
  const [source, setSource] = useState('all')
  const [expanded, setExpanded] = useState(initialExpanded)
  const [pageIndex, setPageIndex] = useState(() => Math.max(0, Math.trunc(Number(initialPageIndex) || 0)))
  const isTools = entity === 'tools'
  const sorted = useMemo(() => rankReviewRows((data[entity] ?? []).filter((row) => !isTools || source === 'all' || (row.source?.kind ?? 'unknown') === source), sort), [data, entity, isTools, source, sort])
  const pageCount = Math.max(1, Math.ceil(sorted.length / 8))
  const currentPage = Math.min(pageIndex, pageCount - 1)
  const rows = sorted.slice(currentPage * 8, currentPage * 8 + 8)
  useEffect(() => { setPageIndex(0); setExpanded('') }, [data.range?.days, data.scope])
  const max = Math.max(0, ...sorted.map((row) => Number(row[sort] ?? 0)))
  const sum = sorted.reduce((amount, row) => amount + Number(row[sort] ?? 0), 0)
  const summary = data.summary ?? {}
  const chooseEntity = (value) => { setEntity(value); setSort(value === 'tools' ? 'durationMs' : value === 'sessions' ? 'activityAt' : 'cost'); setExpanded(''); setPageIndex(0) }
  const open = (id) => { onOpenSession?.(id) }

  return h(ReviewPanel, {
    title: '资源去向', hint: `${rangeLabel} · 钱花在哪，时间花在哪`,
    actions: h(Choices, { options: ENTITIES, value: entity, label: '资源去向对象', onChange: chooseEntity }),
  },
  h('div', { className: 'px-heroes px-review-ledger-summary' },
    h(HeroCard, { tone: 'accent', label: '费用估算', value: formatCny(summary.cost), foot: `${summary.sessionCount ?? 0} 个会话 · 当前筛选范围` }),
    h(HeroCard, { tone: 'purple', label: '人机对话', value: reviewValue(summary.turns, 'turns'), foot: `${summary.requests ?? 0} 次模型请求（工作量）` }),
    h(HeroCard, { tone: 'green', label: '有效处理耗时', value: reviewValue(summary.durationMs, 'durationMs'), foot: '已扣除问答工具区间（近似）' }),
    h(HeroCard, { tone: 'yellow', label: '等待用户（估算）', value: reviewValue(summary.awaitingUserMs, 'durationMs'), foot: `轮次原始用时 ${reviewValue(summary.wallMs, 'durationMs')}` })),
  h('div', { className:'px-review-coverage' },
    h('span', null, data.scope === 'all' ? '窗口全部（含归档）' : '近期未归档'),
    h('span', null, `${data.coverage?.hiddenArchived ?? 0} 个归档已隐藏 · ${data.coverage?.hiddenInactive ?? 0} 个非近期已隐藏`),
    h('span', null, `计时覆盖 ${data.coverage?.timedSessions ?? 0}/${data.coverage?.sessionCount ?? 0} 个会话${(data.coverage?.timedSessions ?? 0) < (data.coverage?.sessionCount ?? 0) ? '，缺测未计入合计' : ''}`),
    data.coverage?.unknownArchive > 0 ? h('span', null, `${data.coverage.unknownArchive} 个归档状态未知${data.scope === 'recent' ? '，未计入' : ''}`) : null,
    h('span', { className:'px-review-third-party' }, `第三方工具 ${summary.thirdPartyCalls ?? 0} 次（含声明匹配）`)),
  data.scope === 'recent' && data.ledgerSummary ? h('p', { className:'px-review-note' }, `全窗口账本 ${formatCny(data.ledgerSummary.cost)}；本页仅统计当前筛选会话 ${formatCny(summary.cost)}，隐藏的记录未被删除。`) : null,
  h('div', { className: 'px-review-toolbar' },
    h(Choices, { options: isTools ? TOOL_SORTS : entity === 'sessions' ? SESSION_SORTS : MONEY_SORTS, value: sort, label: '资源排行排序', onChange: (value) => { setSort(value); setPageIndex(0); setExpanded('') } }),
    isTools ? h(Choices, { options: SOURCES, value: source, label: '工具来源筛选', onChange: (value) => { setSource(value); setExpanded(''); setPageIndex(0) } })
      : h('span', { className: 'px-review-note' }, `共 ${sorted.length} 个${entity === 'workspaces' ? '工作区' : '会话'} · 点击展开账目`)),
  sorted.length === 0 ? h('p', { className: 'px-review-empty' }, isTools ? '当前窗口没有匹配来源的工具调用。' : '当前窗口还没有资源消耗记录。') : null,
  h('div', { className: `px-review-list metric-${sort} entity-${entity}` }, rows.map((row, index) => {
    const isOpen = expanded === row.id
    const value = row[sort]
    const valueKnown = value !== null && value !== undefined
    const share = valueKnown && sum > 0 ? Number(value) / sum : 0
    const title = entity === 'workspaces' ? row.label : (isTools ? row.name : row.title)
    const detailId = `px-review-detail-${entity}-${index}`
    return h('div', { key: row.id, className: `px-review-item${isOpen ? ' open' : ''}` },
      h('button', {
        type: 'button', className: 'px-review-row', 'aria-expanded': isOpen, 'aria-controls': detailId,
        onClick: () => { setExpanded(isOpen ? '' : row.id) },
      },
      h('span', { className: 'px-review-rank', 'aria-hidden': 'true' }, String(currentPage * 8 + index + 1).padStart(2, '0')),
      h('span', { className: 'px-review-copy' },
        h('span', { className: 'px-review-row-title' }, h('b', null, title || '未命名'), isTools ? h(SourceBadge, { source: row.source }) : null,
          entity === 'sessions' && row.archived !== false ? h('span', { className: 'px-review-source unknown' }, row.archived === true ? '已归档' : '归档状态未知') : null),
        h('span', { className: 'px-review-row-meta' }, isTools
          ? `${row.source?.label || row.source?.packageName || '归属待确认'} · ${row.calls} 次 · 平均 ${reviewValue(row.avgMs, 'durationMs')} · ${row.sessionCount} 个会话 · 最近 ${formatDateTime(row.lastAt, data.timezone)}`
          : entity === 'workspaces'
            ? `${row.sessionCount} 个会话 · 对话 ${row.turns ?? 0} 轮 · 有效处理 ${reviewValue(row.durationMs, 'durationMs')}`
            : `${row.workspace || '未知工作区'} · 对话 ${row.turns ?? 0} 轮 · ${row.requests} 次模型请求 · 有效处理 ${reviewValue(row.durationMs, 'durationMs')}`)),
      h('span', { className: 'px-review-row-value' }, h('b', null, reviewValue(value, sort, data.timezone)),
        h('span', null, sort === 'activityAt' ? '最近一次自身活动' : sort === 'maxMs' ? '单次最长' : (valueKnown && sum > 0 ? `占当前列表 ${(share * 100).toFixed(1)}%` : '暂无可比数据')),
        sort === 'activityAt' ? null : h('i', { className: 'px-review-share', 'aria-hidden': 'true' }, h('i', { style: { width: `${valueKnown && max > 0 ? Number(value) / max * 100 : 0}%` } }))),
      h('span', { className: 'px-review-chevron', 'aria-hidden': 'true' }, isOpen ? '−' : '+')),
      isOpen ? h('div', { id: detailId, className: 'px-review-detail' },
        entity === 'workspaces' ? h(WorkspaceAccount, { row, data, onOpenSession: open, initialSessionSort })
          : isTools ? h(ToolAccount, { row, timezone: data.timezone, onOpenSession: open })
            : h(SessionAccount, { row, data, onOpenSession: open })) : null)
  })),
  h('nav', { className: 'px-review-pagination', 'aria-label': '资源列表分页' },
    h('span', null, sorted.length ? `第 ${currentPage * 8 + 1}–${Math.min((currentPage + 1) * 8, sorted.length)} 项，共 ${sorted.length} 项` : '暂无条目'),
    h('button', { type:'button', className:'px-btn small', disabled: currentPage === 0, onClick:() => { setPageIndex(currentPage - 1); setExpanded('') } }, '上一页'),
    h('b', null, `${currentPage + 1} / ${pageCount}`),
    h('button', { type:'button', className:'px-btn small', disabled: currentPage >= pageCount - 1, onClick:() => { setPageIndex(currentPage + 1); setExpanded('') } }, '下一页')),
  h('p', { className: 'px-review-note' }, isTools
    ? '“匹配”表示工具名与插件声明相符，不是历史执行归属的确证；内置包含官方插件，无法确认的保留来源未知。工具耗时可并行重叠，不分摊模型费用。'
    : '有效耗时＝轮次原始用时减去问答工具区间（近似）；未完成轮次不混入已完成耗时。跨会话累计不是人的在线时长；费用沿用账本口径，不代表实际扣款。'),
  data.coverage?.inheritedRequests > 0 ? h('p', { className: 'px-review-note' }, `账本中含 ${data.coverage.inheritedRequests} 条继承历史请求，费用与上方趋势保持同口径，不代表子会话新增支出；继承的轮次和工具不重复计时。`) : null)
}

export function WorkspaceAccount({ row, data, onOpenSession, initialSessionSort = 'activityAt', initialExpanded = '' }) {
  const [picked, setPicked] = useState(initialExpanded)
  const [sort, setSort] = useState(() => sessionSortOf(initialSessionSort))
  const ids = new Set(row.sessionIds ?? [])
  const sessions = rankReviewRows((data.sessions ?? []).filter((session) => ids.has(session.id)), sort)
  return h('section', { className: 'px-review-workspace', 'aria-label': '工作区会话账目' },
    h('p', { className: 'px-review-path' }, row.path || '没有工作目录信息的历史单列，不猜测归属。'),
    h('div', { className: 'px-review-workspace-toolbar' }, h('h3', null, '工作区内的会话账目'),
      h(Choices, { options: SESSION_SORTS, value: sort, label: '工作区内会话排序', onChange: setSort })),
    h('div', { className: 'px-review-child-list' },
      h('div', { className: 'px-review-child-head', 'aria-hidden': 'true' },
        ['会话', '最近使用', '费用', '有效时长', 'Token', ''].map((label, index) => h('span', { key: index }, label))),
      sessions.map((session) => {
      const detailId = `px-review-child-${encodeURIComponent(row.id)}-${encodeURIComponent(session.id)}`
      return h('div', { key: session.id, className: 'px-review-child-item', 'data-session-id': session.id },
        h('button', {
          type: 'button', className: 'px-review-child', 'aria-expanded': picked === session.id, 'aria-controls': detailId,
          'aria-label': `${session.title || session.id}；最近使用 ${formatDateTime(session.activityAt, data.timezone)}；费用 ${reviewValue(session.cost, 'cost')}；有效时长 ${reviewValue(session.durationMs, 'durationMs')}；Token ${reviewValue(session.tokens, 'tokens')}；模型请求 ${session.requests ?? 0} 次`,
          onClick: () => { setPicked(picked === session.id ? '' : session.id) },
        }, h('span', { className: 'px-review-child-name' }, h('b', null, session.title || session.id),
          h('small', null, `${session.requests ?? 0} 次模型请求`)),
        h('span', { className: 'px-review-child-recent', 'data-label': '最近使用' }, formatDateTime(session.activityAt, data.timezone)),
        h('b', { 'data-label': '费用' }, reviewValue(session.cost, 'cost')),
        h('span', { 'data-label': '有效时长' }, reviewValue(session.durationMs, 'durationMs')),
        h('span', { 'data-label': 'Token' }, reviewValue(session.tokens, 'tokens')),
        h('span', { className: 'px-review-child-toggle', 'aria-hidden': 'true' }, picked === session.id ? '−' : '+')),
        picked === session.id ? h('div', { id: detailId, className: 'px-review-child-detail' }, h(SessionAccount, { row: session, data, onOpenSession })) : null)
    })))
}

function TeamAccount({ team, onOpenSession }) {
  const members = Array.isArray(team?.members) ? team.members : []
  if (members.length === 0) return null
  return h('section', { className: 'px-review-team-account', 'aria-label': '团队成员消耗' },
    h('div', { className: 'px-review-team-heading' }, h('h3', null, '团队成员消耗'),
      h('span', { className: 'px-review-note' }, `当前范围有 ${team.visibleMemberCount ?? members.length}/${team.windowMemberCount ?? members.length} 位 · 已知团队 ${team.knownMemberCount ?? members.length} 位${team.leadKnown ? '（含 Lead）' : ''}`)),
    team.hiddenMemberCount > 0 ? h('p', { className: 'px-review-note' },
      `本窗口另有 ${team.hiddenMemberCount} 位成员因归档、状态未知或非近期未显示；切到“窗口全部（含归档）”查看，不把隐藏成员灌入当前合计。`) : null,
    team.outsideWindowMemberCount > 0 ? h('p', { className: 'px-review-note' },
      `${team.outsideWindowMemberCount} 位已知成员在当前时间窗口外，未纳入本窗口合计。`) : null,
    !team.leadInScope ? h('p', { className: 'px-review-note' }, team.leadKnown
      ? 'Lead 不在当前范围，未补入其费用或计时。' : 'Lead 记录不可用；沿用已知拓扑，不猜测缺失 Lead 的消耗。') : null,
    h('div', { className: 'px-review-team-metrics' },
      h('span', null, '范围内团队估算', h('b', null, reviewValue(team.cost, 'cost'))),
      h('span', null, 'Token', h('b', null, reviewValue(team.tokens, 'tokens'))),
      h('span', null, '模型请求', h('b', null, reviewValue(team.requests, 'requests'))),
      h('span', null, '已知有效耗时', h('b', null, reviewValue(team.durationMs, 'durationMs')))),
    h('p', { className: 'px-review-note' }, `计时覆盖 ${team.timedMemberCount ?? 0}/${members.length} 位当前成员，缺测未计入；原始用时 ${reviewValue(team.wallMs, 'durationMs')}，已扣等待 ${reviewValue(team.awaitingUserMs, 'durationMs')}（问答区间近似）。`),
    h('div', { className: 'px-review-team-scroll' },
      h('table', { className: 'px-review-team-table' },
        h('thead', null, h('tr', null, ['成员', '费用', 'Token', '模型请求', '有效时长'].map((label) => h('th', { key: label, scope: 'col' }, label)))),
        h('tbody', null, members.map((member) => h('tr', { key: member.id, 'data-member-id': member.id },
          h('td', { className: 'px-review-team-member' },
            h('button', { type: 'button', onClick: () => { onOpenSession?.(member.id) }, title: member.title }, member.name || member.title || member.id),
            h('span', null, member.role === 'lead' ? 'Lead' : '成员', member.depth > 1 ? ` · 第 ${member.depth} 层` : '', member.detached ? ' · 父链不完整' : '')),
          h('td', { 'data-label': '费用' }, reviewValue(member.cost, 'cost')),
          h('td', { 'data-label': 'Token' }, reviewValue(member.tokens, 'tokens')),
          h('td', { 'data-label': '模型请求' }, reviewValue(member.requests, 'requests')),
          h('td', { 'data-label': '有效时长' }, reviewValue(member.durationMs, 'durationMs'))))))),
    h('p', { className: 'px-review-note' }, '费用沿用窗口账本，可能含继承历史，不代表子会话新增支出；此处仅按成员分列，不叠加回本会话、工作区或总览。'))
}

export function SessionAccount({ row, data, onOpenSession }) {
  const team = (data.teams ?? []).find((item) => item.id === row.teamId && (item.members ?? []).some((member) => member.id === row.id))
  const tools = (data.tools ?? []).filter((tool) => (tool.activity ?? []).some((activity) => activity.sessionId === row.id))
  return h(React.Fragment, null,
    h('div', { className: 'px-review-detail-top' },
      h('span', { className: 'px-review-note' }, `对话 ${row.turns ?? 0} 轮 · 完成执行 ${row.completedTurns} 轮 · 最久有效处理 ${reviewValue(row.maxTurnMs, 'durationMs')} · ${row.toolCalls} 次工具调用`),
      h('button', { type: 'button', className: 'px-btn small', onClick: () => { onOpenSession(row.id) } }, '打开会话')),
    h('div', { className:'px-review-session-receipt' },
      h('span', null, '本会话估算 ', h('b', { className:'px-review-money' }, formatCny(row.cost))),
      h('span', null, '有效处理 ', h('b', { className:'px-review-effective' }, reviewValue(row.durationMs, 'durationMs'))),
      h('span', null, '已排除等待用户 ', h('b', { className:'px-review-wait' }, reviewValue(row.awaitingUserMs, 'durationMs')))),
    h('div', { className: 'px-review-account-grid' },
      h('div', { className:'px-review-account-card money' }, h('h3', null, '模型费用构成'),
        (row.models ?? []).length === 0 ? h('p', { className: 'px-review-note' }, '没有模型请求账目。') : null,
        (row.models ?? []).map((model, index) => h('div', { key: `${model.label}-${index}`, className: 'px-review-account-line px-review-model-money' },
          h('span', { className:'px-review-model-name' }, h('i', { className:`px-review-model-dot color-${index % 4}` }), model.label), h('span', { className: 'px-review-note' }, `${formatTokens(model.tokens)} Token`), h('b', null, formatCny(model.cost)),
          h('i', { className:'px-review-model-track', 'aria-hidden':'true' }, h('i', { className:`color-${index % 4}`, style:{width:`${row.cost > 0 ? model.cost / row.cost * 100 : 0}%`} }))))),
      h('div', { className:'px-review-account-card days' }, h('h3', null, '逐日账目'),
        h('div', { className: 'px-review-day-list' }, (row.days ?? []).map((day) => h('div', { key: day.key, className: 'px-review-account-line' },
          h('span', null, day.key), h('span', { className: 'px-review-note' }, reviewValue(day.durationMs, 'durationMs')), h('b', null, formatCny(day.cost))))))),
    team ? h(TeamAccount, { team, onOpenSession }) : null,
    tools.length > 0 ? h('div', { className: 'px-review-session-tools' }, h('h3', null, '最近记录中参与的工具'),
      h('div', { className: 'px-review-tool-tags' }, tools.map((tool) => h('span', { key: tool.id }, tool.name, h(SourceBadge, { source: tool.source }))))) : null)
}

function ActivityRow({ activity, timezone, onOpenSession }) {
  return h('div', { className: 'px-review-activity-row' },
    h('time', null, formatDateTime(activity.at, timezone)),
    h('button', { type: 'button', onClick: () => { onOpenSession(activity.sessionId) }, title: activity.workspace || '' }, activity.sessionTitle || activity.sessionId),
    h('span', { className: `px-review-call-status${activity.status === 'error' ? ' error' : ''}` },
      activity.turn !== undefined && activity.turn !== null ? `第 ${activity.turn} 轮 · ` : '',
      activity.status === 'error' ? '失败' : activity.durationMs === null || activity.durationMs === undefined
        ? activity.waitMs > 0 ? '等待用户（未返回）' : '未结算'
        : activity.waitMs > 0 ? '等待已排除' : '已返回'),
    h('b', null, reviewValue(activity.durationMs, 'durationMs')))
}

function ToolAccount({ row, timezone, onOpenSession }) {
  const activity = row.activity ?? []
  return h(React.Fragment, null,
    h('div', { className: 'px-review-detail-top' }, h('span', { className: 'px-review-tool-origin' },
      h(SourceBadge, { source: row.source }), h('b', null, row.source?.label || '归属待确认'),
      row.source?.packageName ? h('code', null, row.source.packageName) : null),
    h('span', { className: 'px-review-note' }, `${row.timedCalls}/${row.calls} 次调用有完整计时`)),
    row.source?.kind === 'unknown' ? h('p', { className: 'px-review-note' }, '现有记录没有可靠的插件归属，不能据工具名将其推断为第三方。') : null,
    row.source?.evidence ? h('p', { className: 'px-review-note' }, row.source.evidence) : null,
    row.waitMs > 0 ? h('p', { className:'px-review-wait-note' }, `问答区间观测等待 ${reviewValue(row.waitMs, 'durationMs')}（近似，含尚未返回部分）；未返回调用不参与耗时排行。已返回调用原始耗时 ${reviewValue(row.rawMs, 'durationMs')}，有效处理 ${reviewValue(row.durationMs, 'durationMs')}。`) : null,
    row.slowest ? h('div', { className: 'px-review-slowest' }, h('h3', null, '单次最慢'), h(ActivityRow, { activity: row.slowest, timezone, onOpenSession })) : null,
    h('h3', null, '发挥作用的时间与会话'),
    h('p', { className: 'px-review-note' }, `展示窗口内最近 ${activity.length} 次调用，共 ${row.calls} 次；以下记录不含调用参数与结果正文。`),
    h('div', { className: 'px-review-activity' }, activity.map((item, index) => h(ActivityRow, { key: `${item.sessionId}-${item.callId}-${index}`, activity: item, timezone, onOpenSession }))))
}
