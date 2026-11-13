/**
 * 「图二」那一套彩色富信息的会话详情视图。
 *
 * ## 为什么单独成一个文件
 *
 * 这四个组件（{@link HeroCard} / {@link DetailRow} / {@link TimingBreakdownView} /
 * {@link SessionDetail}）是**两处共用**的：
 *   - 看板「消费 Top 会话」展开时（`dashboard.js` 的 `TopSessions`）；
 *   - 会话标签页「费用」（`sessionView.js` 的 `SessionCostPanel`）的第一行与第二行。
 *
 * 早先它们只住在 `dashboard.js` 里，费用页要复用就只能复制一份——两份视觉实现
 * 迟早漂移（这一轮之前正是「克制配色」把费用页做成了中性墨色，而看板还留着彩色）。
 * 因此把「图二的实现」抽到这里，两个页面 import 同一份。
 *
 * ## 视觉口径（**不要重写**）
 *
 * 用户明确说过喜欢这一版：hero 卡带左侧色条、耗时是三色堆叠条、明细是标签-色点-值。
 * 配色与版式全部在 `theme.js` 的 DASHBOARD 常量里（`.px-hero*` / `.px-timing*` /
 * `.px-drow*` / `.px-peak*`），本文件只负责结构与读数，一行样式都不写。
 * @module dsh-pixel-dashboard/client/sessionDetailView
 */

import React from 'react'
import { formatCny, formatDurationMs, formatTokens } from './format.js'

const { createElement: h } = React

/**
 * 详情里的一枚「主打指标」卡（hero）。
 *
 * ## 视觉层级
 *
 * 十来个数字做成同样大小会变成数字墙。这里分两层：
 *   - **hero**：最该被第一眼看到（金额、token、耗时、工具次数）——大号数字 + 左侧色条；
 *   - **明细**：其余数字用小号标签-值行，靠虚线分隔，安静地排在下面。
 * @param {object} props - tone / label / value / foot。
 * @returns {object} React 元素。
 */
export function HeroCard(props) {
  const { tone, label, value, foot } = props
  return h('div', { className: `px-hero px-hero-${tone ?? 'accent'}` },
    h('span', { className: 'px-hero-label' }, label),
    h('span', { className: 'px-hero-value' }, value),
    foot === undefined || foot === '' ? null : h('span', { className: 'px-hero-foot' }, foot))
}

/**
 * 明细行：左侧色点 + 标签，右侧数值。
 *
 * 色点与 hero 的色条用同一套语义色，于是「这个数属于哪一类」不用读文字就知道。
 * @param {object} props - tone / label / value / title。
 * @returns {object} React 元素。
 */
export function DetailRow(props) {
  const { tone, label, value, title } = props
  return h('div', { className: 'px-drow', title },
    h('span', { className: 'px-drow-label' },
      h('span', { className: `px-dot px-dot-${tone ?? 'blue'}` }),
      label),
    h('span', { className: 'px-drow-value' }, value))
}

/**
 * 会话耗时构成：横向堆叠条 + 图例。
 *
 * ## 为什么不用环形图（上一版被否）
 *
 * 环形图的问题是**读数成本高**：要顺着弧长目测比例，且中间的总时长与三段的关系
 * 不明显。用户明确说不喜欢，而且他先前就表达过偏好「条形」。
 *
 * ## 这一版的做法
 *
 * 一条横向堆叠条把三段按比例铺开（谁占得多一眼可见），下面三行图例给出
 * 精确百分比与时长。总时长放在条的**左端**作为锚点——先看到「总共多久」，
 * 再看「花在哪」，符合阅读顺序。
 *
 * ## 配色
 *
 * 等待（暖黄）→ 回复（蓝）→ 工具（青绿），沿用项目既有马卡龙 token。
 * @param {object} props - timing。
 * @returns {object} React 元素。
 */
export function TimingBreakdownView(props) {
  const { timing } = props
  const ttft = Number(timing?.ttftMs ?? 0)
  const gen = Number(timing?.genMs ?? 0)
  const tools = Number(timing?.toolsMs ?? 0)
  const total = ttft + gen + tools

  if (!Number.isFinite(total) || total <= 0) {
    return h('div', { className: 'px-timing px-timing-empty' },
      h('span', { className: 'px-timing-empty-title' }, '耗时构成'),
      h('span', { className: 'px-muted' },
        '这份日志里没有 step 计时（可能是更早版本写入的日志，或该会话没有完整跑过一轮）。'))
  }

  const segments = [
    { key: 'wait', value: ttft, tone: 'yellow', label: '等待模型' },
    { key: 'reply', value: gen, tone: 'blue', label: '模型回复' },
    { key: 'tools', value: tools, tone: 'green', label: '工具执行' },
  ].filter((segment) => segment.value > 0)
  const percent = (value) => Math.round((value / total) * 100)

  return h('div', { className: 'px-timing' },
    // 左端：总时长锚点
    h('div', { className: 'px-timing-total' },
      h('b', null, formatDurationMs(total)),
      h('span', null, '模型在干活'),
      // 平均每轮放在这里：它是「总时长 ÷ 轮次」，与总时长同源，放一起最自然。
      Number(timing.turns) > 0
        ? h('span', { className: 'px-timing-avg' }, `平均每轮 ${formatDurationMs(total / Number(timing.turns))}`)
        : null),
    // 中间：堆叠条
    h('div', { className: 'px-timing-main' },
      h('div', { className: 'px-timing-bar' },
        segments.map((segment) => h('span', {
          key: segment.key,
          className: `px-timing-seg px-timing-seg-${segment.tone}`,
          style: { width: `${(segment.value / total) * 100}%` },
          title: `${segment.label} ${formatDurationMs(segment.value)}（${percent(segment.value)}%）`,
        }))),
      // 图例：色点 + 名称 + 百分比 + 时长
      h('div', { className: 'px-timing-legend' },
        segments.map((segment) => h('span', { key: segment.key, className: 'px-timing-item' },
          h('span', { className: `px-tdot px-tdot-${segment.tone}` }),
          h('span', { className: 'px-timing-item-name' }, segment.label),
          h('span', { className: 'px-timing-item-pct' }, `${percent(segment.value)}%`),
          h('span', { className: 'px-timing-item-ms' }, formatDurationMs(segment.value))))),
      // 「思考」无法切分：如实说明，不给假数。
      h('p', { className: 'px-timing-note' },
        '「模型思考」与「模型回复」在同一条消息里到达，日志层面无法分离，',
        '因此合并计入「模型回复」。')))
}

/**
 * 一个会话的用量详情（就地展开）。
 *
 * ## 布局（三轮迭代后的定稿）
 *
 *   1. 团队标签页（有成员时）
 *   2. 四枚 hero 指标：金额 / Token / 模型耗时 / 工具次数
 *   3. 耗时构成横向堆叠条——回答「时间花在哪」
 *   4. 两栏明细：花费与时段 / 时间与模型
 *   5. 请求分布条
 *
 * ## 时间口径（用户纠正的关键点）
 *
 * 「活跃时长 = 创建到最后使用」被用户否掉了：会话放三周再用，会被算成几百小时。
 * 现在 hero 里的「模型耗时」= 等待 + 回复 + 工具，即**模型真正在干活的那段时间**；
 * 「平均每轮」= 模型耗时 / 轮次。这才是「我花了多少时间等它」。
 *
 * ## `models` 的兜底
 *
 * 看板展开时 `lead` 是 `/data` 的会话行（带 `models`），但**团队成员**来自
 * `data.teams[].members`，那一份没有 `models` 字段。原来这里直接
 * `session.models.join()`，一切到成员标签页就抛 TypeError（整块详情变白）。
 * 因此只对这一个字段收口，读数与视觉都不变。
 * @param {object} props - lead / members / timezone。
 * @returns {object} React 元素。
 */
export function SessionDetail(props) {
  const { lead, members } = props
  const [picked, setPicked] = React.useState(-1)
  const list = Array.isArray(members) ? members : []
  const index = picked >= 0 && picked < list.length ? picked : -1
  const session = index < 0 ? lead : list[index]

  const totals = session.totals ?? {}
  const cost = session.cost ?? {}
  const timing = session.timing ?? {}
  const activeMs = Number(timing.totalMs ?? 0)
  const turns = Number(session.turns ?? 0)
  const avgTurnMs = activeMs > 0 && turns > 0 ? activeMs / turns : undefined
  const maxTurnMs = Number.isFinite(session.maxTurnMs) && session.maxTurnMs > 0 ? session.maxTurnMs : undefined

  const peek = totals.peak ?? {}
  const pello = totals.idle ?? {}
  const peakTokens = Number(peek.local ?? 0)
  const idleTokens = Number(pello.local ?? 0)
  const peakRequests = Number(peek.requests ?? 0)
  const idleRequests = Number(pello.requests ?? 0)
  const totalRequests = peakRequests + idleRequests
  const peakRatio = totalRequests > 0 ? peakRequests / totalRequests : undefined
  const hitBase = Number(totals.cacheHit ?? 0) + Number(totals.cacheMiss ?? 0) + Number(totals.cacheWrite ?? 0)
  const hitRate = hitBase > 0 ? Math.round((Number(totals.cacheHit ?? 0) / hitBase) * 100) : undefined

  // 团队标签用 DSH 官方称呼（Lead / 成员名），不用内部视角的「本会话」。
  const labelOf = (member, i) => {
    if (i < 0) return 'Lead'
    const name = typeof member.memberName === 'string' ? member.memberName.trim() : ''
    return name !== '' ? name : `成员 ${i + 1}`
  }
  const tabs = list.length === 0
    ? null
    : h('div', { className: 'px-dtabs', role: 'tablist' },
      [-1, ...list.keys()].map((i) => h('button', {
        key: i,
        type: 'button',
        role: 'tab',
        'aria-selected': index === i,
        className: `px-dtab${index === i ? ' px-dtab-on' : ''}`,
        title: (i < 0 ? lead : list[i]).id,
        onClick: (event) => { event.stopPropagation(); setPicked(i) },
      }, labelOf(i < 0 ? lead : list[i], i))))

  return h('div', {
    className: 'px-session-detail',
    onClick: (event) => { event.stopPropagation() },
  },
  tabs,
  h('div', { className: 'px-heroes' },
    h(HeroCard, { tone: 'accent', label: '估算金额', value: formatCny(Number(cost.standard ?? 0)),
      foot: Number(cost.saved ?? 0) > 0
        ? `错峰省下 ${formatCny(Number(cost.saved ?? 0))}`
        : '全部落在高峰时段' }),
    h(HeroCard, { tone: 'blue', label: '总 Token', value: formatTokens(Number(totals.local ?? 0)),
      foot: `${totalRequests} 次请求` }),
    // 模型耗时而不是「活跃时长」——见函数说明里的口径纠正。
    h(HeroCard, { tone: 'green', label: '模型耗时', value: activeMs > 0 ? formatDurationMs(activeMs) : '—',
      foot: avgTurnMs === undefined ? '等待 + 回复 + 工具' : `平均每轮 ${formatDurationMs(avgTurnMs)}` }),
    h(HeroCard, { tone: 'purple', label: '工具调用', value: Number.isFinite(session.toolCalls) ? `${session.toolCalls} 次` : '—',
      foot: maxTurnMs === undefined ? undefined : `最久一轮 ${formatDurationMs(maxTurnMs)}` })),

  // 耗时构成：横向堆叠条 + 图例（替代上一版的环形图——用户明确不喜欢）。
  h(TimingBreakdownView, { timing: { ...timing, turns: Number(session.turns ?? 0) } }),

  h('div', { className: 'px-dcols' },
    h('div', { className: 'px-dcol' },
      h('b', { className: 'px-dcol-title' }, '花费与时段'),
      h(DetailRow, { tone: 'yellow', label: '峰时 Token', value: formatTokens(peakTokens),
        title: `高峰时段发出 ${peakRequests} 次请求` }),
      h(DetailRow, { tone: 'blue', label: '闲时 Token', value: formatTokens(idleTokens),
        title: `空闲时段发出 ${idleRequests} 次请求` }),
      h(DetailRow, { tone: 'purple', label: '峰时占比', value: peakRatio === undefined ? '—' : `${Math.round(peakRatio * 100)}%`,
        title: '按请求数计：峰时请求 / 总请求' }),
      hitRate === undefined ? null : h(DetailRow, { tone: 'green', label: '缓存命中率', value: `${hitRate}%`,
        title: '命中 / (命中 + 未命中 + 写入)' })),
    h('div', { className: 'px-dcol' },
      h('b', { className: 'px-dcol-title' }, '时间与模型'),
      h(DetailRow, {
        tone: 'accent',
        label: '模型 × 提供商',
        value: (Array.isArray(session.models) ? session.models.join('、') : '') || '—',
      }))),

  peakRatio === undefined
    ? null
    : h('div', { className: 'px-dpeak' },
      h('div', { className: 'px-dpeak-head' },
        h('b', { className: 'px-dcol-title' }, '请求分布'),
        h('span', { className: 'px-dpeak-split' },
          h('span', { className: 'px-peak-peak' }, `峰时 ${Math.round(peakRatio * 100)}%`),
          h('span', { className: 'px-peak-idle' }, `闲时 ${Math.round((1 - peakRatio) * 100)}%`))),
      h('div', {
        className: 'px-peak-bar',
        title: `峰时 ${peakRequests} 次 / 闲时 ${idleRequests} 次请求`,
      },
      h('span', { className: 'px-peak-fill', style: { width: `${Math.round(peakRatio * 100)}%` } }),
      h('span', { className: 'px-peak-rest' }))))
}
