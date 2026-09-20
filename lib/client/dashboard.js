/**
 * 用量看板主体：总览指标、时段状态与倒计时、活跃日历、Token 趋势、
 * 模型分布、费用估算与会话清单。只读投影，不修改任何会话状态。
 *
 * 计费口径与官方一致：高峰（周一至周五 9:00–12:00、14:00–18:00）与空闲
 * 时段分别按各自单价计价，空闲价为高峰价的一半；历史用量按每条请求
 * 实际发生的时段归档，因此费用不是用一个折扣近似出来的。
 * @module dsh-pixel-dashboard/client/dashboard
 */

import React from 'react'
import {
  balanceAvailable,
  balanceStatus,
  fetchBalance,
  formatMoney,
  setToggle,
} from './balance.js'
import { notifyStore } from './Notifier.js'
import {
  NOTIFY_DEFAULTS,
  NOTIFY_FLAGS,
  PERMISSION_TEXT,
  balanceAlerts,
  composeRecentLine,
  permissionOf,
  quotaAlerts,
  requestPermission,
  saveNotify,
} from './notify.js'
import {
  fetchPlans,
  formatReset,
  partitionProviders,
  providerChoices,
  providerStatus,
  quotaTone,
  tightestWindow,
  windowProgress,
  WINDOW_ORDER,
} from './plans.js'
import { planViewStore, useSelectedPlan } from './planView.js'
import { PLAN_SHORT } from './provider.js'
import {
  formatCountdown,
  formatCny,
  formatCnyAxis,
  formatDateTime,
  formatMinuteOfDay,
  formatTokens,
  minuteOfDay,
} from './format.js'
import { ActivityCalendar, BarList, DonutChart, TrendChart, useCountUp } from './graph.js'
import {
  dailyCosts,
  dimensionSeries,
  fetchDashboard,
  priceByModel,
  ratesFor,
  recentDays,
  sumByModel,
  sumRows,
  TONES,
  toneFill,
} from './usage.js'

const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

/** 趋势窗口选项。 */
const RANGES = [
  { id: '7', label: '7 日', days: 7 },
  { id: '30', label: '30 日', days: 30 },
  { id: '90', label: '90 日', days: 90 },
]

/** 折线序列：缓存命中输入 / 未缓存输入 / 输出。 */
const SERIES = [
  { key: 'cacheHit', label: '缓存命中输入', tone: 'blue' },
  { key: 'cacheMiss', label: '未缓存输入', tone: 'purple' },
  { key: 'output', label: '输出', tone: 'pink' },
]

/**
 * Token 趋势的分组维度选项。
 *
 * `type` 是逐日行上已经算好的三段字段，另外两个维度要现场按 `byModel` 聚合
 * （见 `dimensionSeries`）。**只显示一个维度**而不是把三个叠加：三种维度会把
 * 同一个 token 数重复计入，叠在一起就得到一个假的总量。
 */
const TREND_DIMENSIONS = [
  { id: 'type', label: '构成' },
  { id: 'model', label: '模型' },
  { id: 'provider', label: '提供商' },
]

/**
 * 按模型 / 提供商分组时最多画几条线。
 *
 * 老账本里能出现十几个 `模型@提供商` 条目，全画上去就是一团互相压住的线，
 * 图例也会长到把面板撑开。超出的合成「其他」（见 `dimensionSeries`）。
 */
const TREND_SERIES_LIMIT = 5

/** 消费估计趋势的序列定义（单条：每日金额）。 */
const COST_SERIES = [{ key: 'cost', label: '每日消费估计', tone: 'pink' }]

/** 把高峰窗口数组渲染成 `9:00–12:00、14:00–18:00`。 */
function formatWindows(windows) {
  return (windows ?? [])
    .map((w) => `${formatMinuteOfDay(w.startMinute)}–${formatMinuteOfDay(w.endMinute)}`)
    .join('、')
}

/** 一份用量里落在高峰的 token 数。 */
function peakTokensOf(usage) {
  return Number(usage?.peak?.cacheMiss ?? 0) + Number(usage?.peak?.cacheHit ?? 0) + Number(usage?.peak?.output ?? 0)
}

/** 一份用量里落在空闲的 token 数。 */
function idleTokensOf(usage) {
  return Number(usage?.idle?.cacheMiss ?? 0) + Number(usage?.idle?.cacheHit ?? 0) + Number(usage?.idle?.output ?? 0)
}

/** 合计一组用量里的高峰 / 空闲 token。 */
function splitTokens(byModel) {
  let peak = 0
  let idle = 0
  for (const usage of Object.values(byModel ?? {})) {
    peak += peakTokensOf(usage)
    idle += idleTokensOf(usage)
  }
  return { peak, idle }
}

/**
 * 分段控件：滑块随选中项平移，而不是整块重绘。
 * @param {object} props - 组件属性。
 * @returns {object} React 元素。
 */
function Segmented(props) {
  const { options, value, onChange, className } = props
  const listRef = useRef(null)
  const [thumb, setThumb] = useState({ left: 3, width: 0 })

  useEffect(() => {
    const host = listRef.current
    if (host === null) return undefined
    const sync = () => {
      const index = options.findIndex((item) => item.id === value)
      // children[0] 是滑块本身，所以按钮要往后偏一位
      const target = host.children[index + 1]
      if (target === undefined) return
      setThumb({ left: target.offsetLeft, width: target.offsetWidth })
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(sync)
    observer.observe(host)
    return () => { observer.disconnect() }
  }, [value, options])

  return h(
    'div',
    { className: `px-seg${className === undefined ? '' : ` ${className}`}`, ref: listRef, role: 'tablist' },
    h('span', {
      className: 'px-seg-thumb',
      style: { transform: `translateX(${thumb.left - 3}px)`, width: thumb.width },
    }),
    options.map((item) =>
      h('button', {
        key: item.id,
        type: 'button',
        role: 'tab',
        className: 'px-seg-btn',
        'aria-selected': item.id === value,
        onClick: () => { onChange(item.id) },
      }, item.label)),
  )
}

/** 滚动计数的指标值。 */
function Metric(props) {
  const animated = useCountUp(props.value, props.duration ?? 620)
  return h(React.Fragment, null, props.format(animated))
}

/** 一张指标卡。 */
function StatCard(props) {
  const { tone, label, value, format, foot, delay } = props
  return h(
    'div',
    { className: `px-stat px-stat-${tone} px-rise`, style: { animationDelay: `${delay ?? 0}ms` } },
    h('div', { className: 'px-stat-label' }, label),
    h('div', { className: 'px-stat-value' }, h(Metric, { value, format })),
    h('div', { className: 'px-stat-foot' }, foot),
  )
}

/**
 * 带色点标题的卡片外壳。
 *
 * `collapsible` 为真时标题行变成一枚可点的展开/收起开关：看板上「会话清单」
 * 与「最近通知」这类**明细**信息量很大但不必常看，默认收起能让整页一屏看完
 * 主要指标。收起时标题行与右边的摘要**照常显示**——收起的是内容，不是信息本身。
 * @param {object} props - title / tone / extra / delay / collapsible / defaultOpen。
 * @returns {object} React 元素。
 */
function Panel(props) {
  const { collapsible = false, defaultOpen = true } = props
  const [open, setOpen] = useState(defaultOpen)
  const expanded = collapsible ? open : true

  const title = h('span', { className: 'px-panel-title' },
    // 折叠开关自带一枚小三角，与色点并排；展开方向随状态旋转。
    collapsible
      ? h('i', { className: `px-caret${expanded ? ' open' : ''}`, 'aria-hidden': 'true' })
      : h('i', { className: `px-panel-dot px-tone-bg-${props.tone ?? 'pink'}` }),
    props.title)

  return h(
    'section',
    { className: `px-panel px-rise${collapsible ? ' px-panel-collapsible' : ''}`, style: { animationDelay: `${props.delay ?? 0}ms` } },
    h('header', { className: 'px-panel-head' },
      collapsible
        ? h('button', {
          type: 'button',
          className: 'px-panel-toggle',
          'aria-expanded': expanded,
          onClick: () => { setOpen((prev) => !prev) },
        }, title, h('span', { className: 'px-panel-toggle-hint' }, expanded ? '收起' : '展开'))
        : title,
      props.extra === undefined ? null : h('span', { className: 'px-panel-extra' }, props.extra)),
    expanded ? h('div', { className: 'px-panel-body' }, props.children) : null,
  )
}

/** 键值行。 */
function Row(props) {
  return h('div', { className: 'px-row' }, h('span', null, props.label), h('b', null, props.value))
}

/**
 * 「最近通知」里的一行：带会话 id 时整行可点，点了切到那条会话。
 *
 * 无会话 id 的行退回普通 {@link Row}——**不**渲染成按钮。给一个点不动的
 * 行加上可点的外观（或反过来）都会让人以为坏了，而余额 / 套餐阈值那类预警
 * 本来就不属于任何会话。
 * @param {object} props - label / value / sessionId / onOpen。
 * @returns {object} React 元素。
 */
function RecentRow(props) {
  const { label, value, sessionId, onOpen } = props
  if (sessionId === undefined || sessionId === '') return h(Row, { label, value })
  return h('button', {
    type: 'button',
    className: 'px-row px-row-clickable',
    title: '点击切到这条会话',
    onClick: () => { onOpen?.(sessionId) },
  },
  h('span', null, label),
  h('b', null, value))
}

/**
 * 面板内部的**轻量折叠区**：一行标题 + 可点的三角，默认收起。
 *
 * 与 {@link Panel} 的 `collapsible` 是两件事：那个折叠的是整张卡片，这个折叠的是
 * 卡片里的一段明细（「最近通知」「会话清单」这类）。用同一个交互语言（三角朝右
 * 是收起、朝下是展开），因此用户不必学两套。
 *
 * 收起时标题行右侧仍显示 `summary`（例如「12 条」）：收起的是**内容**，不是
 * 「这里有多少东西」这个事实。
 *
 * 刻意用自绘 `button` 而不是原生 `<details>`：`/period` 与主题都靠 CSS 类名下发，
 * 原生 `<details>` 的展开态在静态渲染里不可控，而渲染闸门需要在**默认态**下断言
 * 「内容确实没渲染出来」。按钮 + state 是这一层唯一可被静态渲染断言的形式。
 * @param {object} props - title / hint / summary / defaultOpen / className / children。
 * @returns {object} React 元素。
 */
function Collapse(props) {
  const { title, hint, summary, defaultOpen = false, className } = props
  const [open, setOpen] = useState(defaultOpen)

  return h('div', { className: `px-collapse${open ? ' open' : ''}${className === undefined ? '' : ` ${className}`}` },
    h('button', {
      type: 'button',
      className: 'px-collapse-head',
      'aria-expanded': open,
      onClick: () => { setOpen((prev) => !prev) },
    },
    h('i', { className: `px-caret${open ? ' open' : ''}`, 'aria-hidden': 'true' }),
    h('b', null, title),
    hint === undefined ? null : h('span', { className: 'px-muted' }, hint),
    h('span', { className: 'px-collapse-summary' }, summary ?? (open ? '收起' : '展开'))),
    // 内容**不渲染**而不是 display:none：收起的意义正是省掉那一块的高度，
    // 而 display:none 仍会参与 React 树的构建与静态渲染输出。
    open ? h('div', { className: 'px-collapse-body' }, props.children) : null)
}

/**
 * 时段倒计时：展示层每秒重算。
 * 宿主给出下一次切换的毫秒数，这里只做本地递减，不必每秒问服务端。
 * @param {object} data - 看板数据。
 * @param {number} now - 当前时刻。
 * @returns {object|null} 状态。
 */
function usePeriod(data, now) {
  return useMemo(() => {
    if (data === null || data.period === undefined) return null
    const elapsed = Math.max(0, now - Number(data.generatedAt ?? now))
    return {
      peak: data.period.peak === true,
      remainMs: Math.max(0, Number(data.period.nextChangeMs ?? 0) - elapsed),
      minute: minuteOfDay(now, data.timezone),
    }
  }, [data, now])
}

/** 骨架屏：首次加载占位，避免白屏跳动。 */
function Loading() {
  return h('div', { className: 'px-root px-center' },
    h('div', { className: 'px-loading px-rise' },
      h('div', { style: { fontWeight: 600, color: 'var(--px-ink)' } }, '正在汇总会话用量…'),
      h('div', { className: 'px-skeleton' }),
      h('div', null, '首次扫描全部会话日志，稍等片刻')))
}

/** 顶栏标记：像素柱状图。 */
function MarkIcon() {
  return h('svg', { width: 18, height: 18, viewBox: '0 0 20 20', 'aria-hidden': 'true' },
    [[3, 11], [8, 7], [13, 3]].map(([x, y], index) =>
      h('rect', {
        key: index,
        x,
        y,
        width: 4,
        height: 17 - y,
        rx: 1,
        fill: 'currentColor',
        opacity: 0.55 + index * 0.2,
      })))
}

/**
 * 看板容器：取数、刷新、每秒重算倒计时，把结果交给纯展示的 View。
 *
 * 余额与看板数据分开持有：余额有自己的开关与 60s 缓存，且**失败不该影响看板**，
 * 因此不塞进同一次取数的成败里。
 * @returns {object} React 元素。
 */
export function Dashboard() {
  const [state, setState] = useState({ status: 'loading', data: null, error: '' })
  const [now, setNow] = useState(() => Date.now())
  const [balance, setBalance] = useState({ payload: undefined, busy: false, error: '' })
  const [plans, setPlans] = useState({ payload: undefined, busy: false, error: '' })

  const load = useCallback((refresh) => {
    setState((prev) => ({ ...prev, status: prev.data === null ? 'loading' : 'refreshing' }))
    fetchDashboard({ refresh })
      .then((data) => { setState({ status: 'ready', data, error: '' }) })
      .catch((error) => { setState({ status: 'error', data: null, error: String(error?.message ?? error) }) })
  }, [])

  const loadBalance = useCallback((refresh) => {
    fetchBalance({ refresh })
      .then((payload) => { setBalance((prev) => ({ ...prev, payload, error: '' })) })
      .catch((error) => {
        // 余额取不到时保留上一次的数值，只在明细区给出提示——
        // 把已经拿到的余额擦掉只会让人以为余额没了。
        setBalance((prev) => ({ ...prev, error: String(error?.message ?? error) }))
      })
  }, [])

  const loadPlans = useCallback((refresh) => {
    fetchPlans({ refresh })
      .then((payload) => { setPlans((prev) => ({ ...prev, payload, error: '' })) })
      .catch((error) => {
        setPlans((prev) => ({ ...prev, error: String(error?.message ?? error) }))
      })
  }, [])

  const toggle = useCallback((target, enabled, setter, reload) => {
    setter((prev) => ({ ...prev, busy: true }))
    setToggle(target, enabled)
      .then((result) => {
        const message = result?.lockedByEnv === true ? (result.message ?? '已被环境变量关闭') : ''
        setter((prev) => ({ ...prev, busy: false, error: message }))
        // 重新取一次：宿主下次会回报新的 enabled 状态。
        reload(true)
      })
      .catch((error) => {
        setter((prev) => ({ ...prev, busy: false, error: String(error?.message ?? error) }))
      })
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchDashboard({})
      .then((data) => { if (!cancelled) setState({ status: 'ready', data, error: '' }) })
      .catch((error) => {
        if (!cancelled) setState({ status: 'error', data: null, error: String(error?.message ?? error) })
      })
    fetchBalance({})
      .then((payload) => { if (!cancelled) setBalance((prev) => ({ ...prev, payload })) })
      .catch((error) => { if (!cancelled) setBalance((prev) => ({ ...prev, error: String(error?.message ?? error) })) })
    fetchPlans({})
      .then((payload) => { if (!cancelled) setPlans((prev) => ({ ...prev, payload })) })
      .catch((error) => { if (!cancelled) setPlans((prev) => ({ ...prev, error: String(error?.message ?? error) })) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const handle = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(handle) }
  }, [])

  if (state.status === 'error') {
    return h('div', { className: 'px-root' },
      h(Panel, { title: '看板数据读取失败', tone: 'red' },
        h('p', { className: 'px-muted' }, state.error),
        h('button', { className: 'px-btn primary', onClick: () => { load(true) } }, '重试')))
  }
  if (state.data === null) return h(Loading)

  return h(View, {
    data: state.data,
    now,
    refreshing: state.status === 'refreshing',
    onRefresh: () => { load(true); loadBalance(true); loadPlans(true) },
    balance: balance.payload,
    balanceError: balance.error,
    balanceBusy: balance.busy,
    onToggleBalance: (enabled) => { toggle('balance', enabled, setBalance, loadBalance) },
    plans: plans.payload,
    plansError: plans.error,
    plansBusy: plans.busy,
    onTogglePlans: (enabled) => { toggle('plans', enabled, setPlans, loadPlans) },
  })
}

/**
 * 看板展示层：给定数据与当前时刻即渲染整页，无取数、无副作用。
 * @param {object} props - data / now / refreshing / onRefresh / balance* / plans*。
 * @returns {object} React 元素。
 */
export function View(props) {
  const {
    data, now, refreshing, onRefresh,
    balance, balanceError, balanceBusy, onToggleBalance,
    plans, plansError, plansBusy, onTogglePlans,
  } = props
  const [rangeId, setRangeId] = useState('30')
  /**
   * Token 趋势的分组维度。
   *
   * 三种维度回答三个不同问题，**不互相替代**，因此做成切换而不是叠加：
   *   - 构成（缓存命中 / 未缓存 / 输出）：量花在哪一段；
   *   - 模型：哪个模型用得最多（同一个模型跨提供商合并，否则会重复计数）；
   *   - 提供商：量从哪条路由来。
   */
  const [trendBy, setTrendBy] = useState('type')
  const range = RANGES.find((item) => item.id === rangeId) ?? RANGES[1]
  const period = usePeriod(data, now)
  // 用户在看板上手动指定的「当前监看的套餐」（undefined = 自动挑最紧的那一家）。
  // 与输入框下方那一枚**共用同一个存储**：两边读同一份，切换立刻同步。
  const selectedPlan = useSelectedPlan()

  const points = useMemo(() => recentDays(data.days, range.days), [data.days, range.days])
  const rangeTotals = useMemo(() => sumRows(points), [points])
  const rangeByModel = useMemo(() => sumByModel(points.map((point) => point.byModel)), [points])
  const rangeCost = useMemo(() => priceByModel(rangeByModel, data.pricing), [rangeByModel, data.pricing])
  // 「今日」按宿主的 `overview.today`（站点时区的今天）去 days 里定位，
  // 找不到就是今天还没有任何请求——此时费用是 0，而不是「最后有数据那天」的费用。
  // 旧宿主没有这个字段时才退回 days.at(-1)（可能偏一天，但至少不空白）。
  const todayCost = useMemo(() => {
    const key = data.overview?.today
    const row = typeof key === 'string' && key !== ''
      ? data.days.find((day) => day.key === key)
      : data.days.at(-1)
    return priceByModel(row?.byModel ?? {}, data.pricing)
  }, [data.days, data.pricing, data.overview?.today])

  const overview = data.overview
  const activeInRange = points.filter((point) => Number(point.totals.requests) > 0).length
  const split = splitTokens(rangeByModel)
  const peakShare = split.peak + split.idle > 0 ? split.peak / (split.peak + split.idle) : 0

  // Token 趋势按维度摊开：`type` 直接用逐日行上的三段字段（recentDays 已经算好），
  // 模型 / 提供商则从每天的 byModel 现场聚合（见 dimensionSeries 的注释）。
  const trend = useMemo(() => {
    if (trendBy === 'type') return { series: SERIES, points }
    return dimensionSeries(points, data.models, trendBy, { limit: TREND_SERIES_LIMIT })
  }, [trendBy, points, data.models])

  // 消费估计趋势：与「费用估算」卡片同一口径（逐日 priceByModel 之和）。
  const costPoints = useMemo(() => dailyCosts(points, data.pricing), [points, data.pricing])

  // 切换监看的套餐：直接写共享存储，看板与输入框下方那一枚同时跟着变。
  const onSelectPlan = useCallback((planId) => { planViewStore().select(planId) }, [])

  // 余额面板的角标：只在真拿到金额、或明确是「已关闭」时才写字，
  // 其余情况留空，让面板内部那句状态说明去解释原因（降级必须可见但不喧宾夺主）。
  const balanceState = useMemo(() => {
    if (balanceError !== undefined && balanceError !== '') return { extra: '读取失败' }
    if (balance === undefined) return { extra: '读取中…' }
    const status = balanceStatus(balance)
    if (status.level === 'off') return { extra: '已关闭' }
    if (status.level !== 'ok') return { extra: '不可用' }
    const available = balanceAvailable(balance)
    return { extra: available === false ? '余额不足' : '官方接口' }
  }, [balance, balanceError])

  // 套餐面板的角标：只报「几家可用」，具体原因留给面板内部的说明行。
  const planState = useMemo(() => {
    if (plansError !== undefined && plansError !== '') return { extra: '读取失败' }
    if (plans === undefined) return { extra: '读取中…' }
    if (plans.enabled === false) return { extra: '已关闭' }
    const providers = Array.isArray(plans.providers) ? plans.providers : []
    const ok = providers.filter((provider) => provider?.ok === true).length
    if (providers.length === 0) return { extra: '无数据' }
    return { extra: ok === 0 ? '均不可用' : `${ok}/${providers.length} 家可用` }
  }, [plans, plansError])

  return h(
    'div',
    { className: 'px-root' },
    h('header', { className: 'px-topbar' },
      h('div', { className: 'px-topbar-title' },
        h('span', { className: 'px-mark' }, h(MarkIcon)),
        h('div', { className: 'px-title-text' },
          h('span', { className: 'px-title-main' }, '用量看板'),
          h('span', { className: 'px-title-sub' },
            `DSH · ${overview.sessions} 个会话 · 更新于 ${new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`))),
      h('div', { className: 'px-topbar-actions' },
        h(Segmented, { options: RANGES, value: rangeId, onChange: setRangeId }),
        h('button', {
          type: 'button',
          className: 'px-btn small',
          disabled: refreshing,
          onClick: onRefresh,
        },
        h('span', { className: refreshing ? 'px-spin' : undefined }, '⟳'),
        refreshing ? '刷新中' : '刷新'))),

    h('div', { className: 'px-stats' },
      h(StatCard, {
        tone: 'blue',
        delay: 0,
        label: '累计 Token',
        value: overview.totals.local,
        format: formatTokens,
        foot: `缓存命中 ${formatTokens(overview.totals.cacheHit)} · 模型请求 ${overview.totals.requests} 次`,
      }),
      h(StatCard, {
        tone: 'purple',
        delay: 60,
        label: `${range.label} Token`,
        value: rangeTotals.local,
        format: formatTokens,
        foot: `输出 ${formatTokens(rangeTotals.output)} · ${activeInRange} 天有请求`,
      }),
      h(StatCard, {
        tone: 'pink',
        delay: 120,
        label: `${range.label}费用估算`,
        value: rangeCost.standard,
        format: formatCny,
        foot: `今日 ${formatCny(todayCost.standard)} · 高峰占比 ${(peakShare * 100).toFixed(0)}%`,
      }),
      h(StatCard, {
        tone: 'green',
        delay: 180,
        label: '连续活跃',
        value: overview.streaks.current,
        format: (value) => `${Math.round(value)} 天`,
        foot: `最长 ${overview.streaks.longest} 天 · 累计 ${overview.activeDays} 天`,
      })),

    // 时段与计费 + 活跃日历 并排一行：计费卡片的信息量就只有几行键值对，
    // 独占整行会让它显得空荡，而日历是横向铺开的图形，给它剩下的宽度正合适。
    // 窄屏由 .px-pair 的媒体查询塌回单列（见 theme.js）。
    h('div', { className: 'px-pair' },
      h(Panel, {
        // 时段信息是**背景条件**而不是主角：倒计时改成次要位置的一行字，
        // 与计费口径合并成一张紧凑卡片，不再单独占一张大面板。
        title: '时段与计费',
        // 高峰用主题粉、空闲用绿。两态各一色，且**同一张卡片里只出现一种**——
        // 卡片标题的点与右上角那枚徽标说的是同一件事，配色必须一致。
        tone: period.peak ? 'pink' : 'green',
        delay: 220,
        // 徽标与 .px-badge.ok 是**同一套做法**（淡色底 + 同色文字 + 同色描边），
        // 只是换了色相：两态看起来才是同一种东西的两个状态，而不是两种控件。
        extra: h('span', { className: `px-badge${period.peak ? ' peak' : ' ok'}` },
          h('i', { className: 'px-pulse' }),
          period.peak ? '高峰时段计费中' : '空闲时段计费中'),
      },
      h('div', { className: 'px-period' },
        h('div', { className: 'px-period-clock' },
          h('span', { className: 'px-period-clock-label' },
            period.peak ? '距转空闲' : '距转高峰'),
          h('b', { className: 'px-period-clock-value' }, formatCountdown(period.remainMs)),
          h('span', { className: 'px-period-clock-foot' },
            `${formatMinuteOfDay(period.minute)} · ${data.timezone}`)),
        h('div', { className: 'px-rows px-period-rows' },
          h(Row, { label: '高峰时段', value: `周一至周五 ${formatWindows(data.peakRule?.windows)}` }),
          h(Row, {
            label: `${range.label}高峰 / 空闲`,
            value: `${formatCny(rangeCost.peak)} / ${formatCny(rangeCost.idle)}`,
          }),
          h(Row, { label: '若全走空闲可省', value: formatCny(rangeCost.saved) })))),

      h(Panel, {
        title: '活跃日历',
        tone: 'green',
        delay: 260,
        extra: `${overview.firstDay ?? '—'} 起 · 一年 · 每格一天`,
      },
      h(ActivityCalendar, {
        firstDay: data.heatmap.firstDay,
        days: data.heatmap.days,
        requests: data.heatmap.requests ?? [],
        sessions: data.heatmap.sessions ?? [],
        tokens: data.heatmap.tokens ?? [],
        // 每格的消费估计，与 requests 同一套 day 索引。
        // 旧宿主没有这个字段 → 悬停显示「消费估计 —」，而不是假装是 ¥0。
        costs: data.heatmap.costs ?? [],
        maxRequests: data.heatmap.maxRequests ?? 1,
      }))),

    h(Panel, {
      title: '账户与套餐',
      tone: 'blue',
      delay: 240,
      extra: h('span', { className: 'px-panel-extra' },
        [balanceState?.extra, planState?.extra].filter((x) => x !== undefined && x !== '').join(' · ')),
    },
    h('div', { className: 'px-account-grid' },
      h(BalancePanel, {
        payload: balance,
        error: balanceError,
        busy: balanceBusy,
        onToggle: onToggleBalance,
        compact: true,
      }),
      h(PlansPanel, {
        payload: plans,
        error: plansError,
        busy: plansBusy,
        now,
        onToggle: onTogglePlans,
        selected: selectedPlan,
        onSelect: onSelectPlan,
        compact: true,
      }))),

    // 两张趋势卡片**同行**（.px-trend-row）：它们回答同一段时间里的两个问题
    // （用了多少 / 花了多少），分两行会让读的人来回滚动对不上横轴。
    // 窄屏由 .px-trend-row 的媒体查询塌回单列（见 theme.js）。
    h('div', { className: 'px-trend-row' },
      h(Panel, {
        title: `${range.label} Token 趋势`,
        tone: 'blue',
        delay: 300,
        // 维度切换器放在标题行右侧：它改的正是这张卡片画什么
        extra: h(Segmented, {
          // 比顶部那个窗口切换器小一号：它是**卡片内**的次级选择，
          // 与「7 日 / 30 日 / 90 日」那种全局窗口不该看起来一样重。
          className: 'px-trend-dim',
          options: TREND_DIMENSIONS,
          value: trendBy,
          onChange: setTrendBy,
        }),
      },
      h(TrendChart, {
        points: trend.points,
        series: trend.series,
        formatAxis: formatTokens,
        formatValue: formatTokens,
      })),

      h(Panel, {
        title: `${range.label}消费估计趋势`,
        tone: 'pink',
        delay: 320,
        // 合计金额写在标题行：曲线的形状告诉「哪天贵」，这一行回答「一共多少」
        extra: formatCny(rangeCost.standard),
      },
      h(TrendChart, {
        points: costPoints,
        series: COST_SERIES,
        // 轴用紧凑金额（`¥0.038`），读数与合计仍用完整的 formatCny
        formatAxis: formatCnyAxis,
        formatValue: formatCny,
      }))),

    h(Panel, {
      title: '通知与预警',
      tone: 'green',
      delay: 320,
      extra: '任务完成 / 失败 / 等待授权 · 余额与套餐阈值',
    },
    h(NotifyPanel, { balance, plans })),

    h('div', { className: 'px-grid-2' },
      h(Panel, { title: '模型分布', tone: 'purple', delay: 340 },
        h(ModelBreakdown, { models: data.models, rangeByModel, rangeTotals })),
      h(Panel, { title: '费用明细', tone: 'pink', delay: 380 },
        h(CostTable, {
          models: data.models,
          rangeByModel,
          pricing: data.pricing,
          rangeCost,
          split,
          rangeLabel: range.label,
        }))),

    h(Panel, {
      title: '会话清单',
      tone: 'blue',
      delay: 420,
      // 明细类面板：内容多、不必常看，默认收起，标题行仍写着总数。
      collapsible: true,
      defaultOpen: false,
      extra: `共 ${data.sessions.length} 个 · 显示最近 40 个`,
    },
    h(SessionTable, { sessions: data.sessions, timezone: data.timezone })),

    h('p', { className: 'px-source' },
      '单价与时段口径来自 ',
      h('a', {
        href: data.pricing?.source ?? 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
        target: '_blank',
        rel: 'noreferrer',
      }, 'DeepSeek 官方定价页'),
      // 「实际账单以服务商为准」在买断制下是误导：第三方中转 / Coding Plan
      // 不按 token 计费，所以这里的金额与它们毫无关系，而不是「略有出入」。
      '。所有金额都是按各模型官方单价做的估算——第三方中转与 Coding Plan 是买断制，'
      + '不按 token 计费，不在此估算范围内。'),
  )
}

/**
 * 账户余额面板：金额明细 + 开关 + 隐私说明。
 *
 * 三层信息各司其职：能显示的金额、不能显示时的**原因**、以及数据是怎么来的。
 * 只有第一层而没有后两层，用户就无从判断「余额为 —」是没配 Key 还是插件坏了。
 * @param {object} props - payload / error / busy / onToggle / compact。
 * @returns {object} React 元素。
 */
function BalancePanel(props) {
  const { payload, error, busy, onToggle, compact } = props
  const status = balanceStatus(payload)
  const enabled = payload?.enabled !== false
  const locked = payload?.lockedByEnv === true
  const rows = Array.isArray(payload?.balances) ? payload.balances : []

  return h('div', { className: compact === true ? 'px-account-col' : null },
    h('div', { className: 'px-balance-head' },
      h('div', { className: 'px-balance-total' },
        h('span', {
          className: `px-balance-amount${rows.some((row) => Number(row.total) < 0) ? ' px-negative' : ''}`,
        }, rows.length === 0
          ? '—'
          : formatMoney(rows[0].total, rows[0].currency)),
        rows.length > 1
          ? h('span', { className: 'px-balance-currency' },
            rows.slice(1).map((row) => formatMoney(row.total, row.currency)).join(' · '))
          : null),
      h('label', { className: 'px-balance-toggle' },
        h('input', {
          type: 'checkbox',
          checked: enabled,
          disabled: busy === true || locked,
          onChange: (event) => { onToggle?.(event.target.checked) },
        }),
        h('span', null, locked ? '余额（环境变量已关）' : '余额'))),

    status.level === 'ok' && error === undefined
      ? null
      : h('p', { className: `px-balance-state px-${status.level === 'ok' ? 'warn' : status.level}` },
        // 明细区的提示优先用真实错误（它更具体），否则用归一状态文案
        error !== undefined && error !== '' ? `余额读取失败：${error}` : status.text),

    rows.length === 0
      ? null
      : h('div', { className: 'px-rows px-balance-rows' },
        rows.map((row) =>
          h(Row, {
            key: row.currency,
            label: `${row.currency} 明细`,
            value: [
              `可用 ${formatMoney(row.total, row.currency)}`,
              `充值 ${formatMoney(row.toppedUp, row.currency)}`,
              `赠送 ${formatMoney(row.granted, row.currency)}`,
            ].join(' · '),
          }))),

    // 充值 / 查看账单的入口：这是「看到余额不够」之后最自然的下一步动作
    h('p', { className: 'px-links' },
      h('a', {
        href: 'https://platform.deepseek.com/usage',
        target: '_blank',
        rel: 'noreferrer',
      }, 'DeepSeek 官方用量与充值 ↗')),

    // 隐私说明折进原生 <details>：信息仍然可查（点击展开），但默认不再占版面。
    // 用 <details> 而不是自建折叠，是为了不引入状态与 JS——它在任何环境下都能用。
    h('details', { className: 'px-details' },
      h('summary', null, '数据来源与隐私'),
      h('p', { className: 'px-balance-privacy' },
        '余额由本地宿主用 DSH 自己给官方 provider 用的那把 API Key 查询，',
        h('b', null, 'Key 不会离开本机'),
        '，浏览器端只收到金额。数据源：',
        payload?.baseURL === undefined ? '官方 /user/balance 接口' : `${payload.baseURL}/user/balance`,
        payload?.keySource === undefined ? '' : `（凭据来源：${payload.keySource}）`,
        payload?.official === false
          ? '。注意：当前 llm-deepseek 的 baseURL 不是官方公网地址，余额可能来自自建端点。'
          : '。')),
  )
}

/**
 * 一个额度窗口：进度条 + 剩余量 + 重置倒计时。
 *
 * 只有百分比而没有绝对值时（官方向下取整，可能失真）会标出来，
 * 而不是把取整后的数字当成精确值展示。
 *
 * **百分比未知时不许显示成 0%**：官方只报了余额的窗口（Command Code 的月度就是
 * 这样）没有已用、没有总额，百分比是未知而不是零。这时数字显示 `—`、进度条不画，
 * 脚注照实说明原因（`window.note`，没有 note 时给一句通用的）。
 * @param {object} props - win / now。
 * @returns {object} React 元素。
 */
function QuotaWindow(props) {
  const { win, now } = props
  const progress = windowProgress(win)
  const tone = quotaTone(progress.percent, progress.over)
  const reset = formatReset(win?.resetAt, now)
  const parts = []
  if (progress.remainingText !== '—') parts.push(`剩余 ${progress.remainingText}`)
  if (progress.totalText !== '—') parts.push(`总额 ${progress.totalText}`)
  if (reset !== undefined) parts.push(reset)
  if (progress.estimated) parts.push('官方只给了百分比')
  if (progress.note !== '') parts.push(progress.note)
  else if (progress.usable && !progress.percentKnown) parts.push('官方只报了余额，没有已用额度')

  return h('div', { className: 'px-quota' },
    h('div', { className: 'px-quota-head' },
      h('span', { className: 'px-quota-name' }, win?.label ?? win?.window ?? '额度'),
      h('span', { className: `px-quota-percent px-tone-${tone}` },
        progress.percentKnown ? `${progress.percent.toFixed(1)}%` : '—'),
      // 超限要明说：百分比 >100 时数字本身已经说明，但加一个徽标更醒目
      progress.over ? h('span', { className: 'px-badge' }, '已超限') : null),
    h('div', { className: 'px-quota-track' },
      // 未知百分比不画条：一条 0% 的空条看起来就像「一点没用」，而事实是不知道
      progress.percentKnown
        ? h('span', {
          className: `px-quota-fill px-tone-bg-${tone}`,
          // 条宽用夹取值；数字用真值（见 windowProgress）
          style: { width: `${progress.barPercent}%` },
        })
        : null),
    parts.length === 0
      ? null
      : h('div', { className: 'px-quota-foot' }, parts.join(' · ')))
}

/**
 * 各家的管理 / 充值入口（**旧宿主的回落**）。
 *
 * 新宿主在每一家里交下 `setup.keyURL` / `keyURLName`（含「去哪拿凭据」的完整步骤），
 * 这里只服务没有 `setup` 的旧宿主。**注意火山的入口是 IAM 的「API 访问密钥」页，
 * 不是方舟控制台**——AK/SK 是账号级 IAM 凭据，方舟控制台给的是推理用的 `ark-` Key，
 * 那个恰好是本接口会拒掉的一把。早先这里指向方舟控制台，正是用户找不到 AK 的原因。
 */
const PLAN_LINKS = {
  zhipu: { href: 'https://www.bigmodel.cn/coding-plan/personal/usage', label: '智谱套餐用量 ↗' },
  commandcode: { href: 'https://commandcode.ai/studio', label: 'Command Code 工作室 ↗' },
  volcengine: { href: 'https://console.volcengine.com/iam/keymanage/', label: '火山引擎 API 访问密钥 ↗' },
}

/**
 * 「这家凭据怎么配」的可展开说明。
 *
 * 只有两件事要回答，**缺任何一件用户都会卡住**：
 *   1. **去哪拿**（`acquire` + `keyURL`）；
 *   2. **拿到后放哪**（`refs` + 凭据文件路径）。
 *
 * 第 2 点容易被漏掉，因为「设置 → 模型」里根本没有能填 `VOLC_ACCESS_KEY_ID` 的输入框
 * ——DSH 只会写它自己派生的 `<路由>_API_KEY`。所以这里必须把凭据文件**路径**写出来。
 * @param {object} props - setup / credentialFile / open。
 * @returns {object|null} React 元素；没有 setup 时 null。
 */
function SetupHelp(props) {
  const { setup, credentialFile, open = false } = props
  if (!hasSetupHelp(setup)) return null
  const acquire = Array.isArray(setup.acquire) ? setup.acquire : []
  const refs = Array.isArray(setup.refs) ? setup.refs : []
  const file = typeof credentialFile === 'string' && credentialFile !== '' ? credentialFile : ''

  return h('details', { className: 'px-details px-plan-setup', open },
    h('summary', null, '这家凭据怎么配'),
    acquire.length === 0
      ? null
      : h('ol', { className: 'px-plan-steps' },
        acquire.map((step, index) => h('li', { key: index }, step))),
    // 入口只在**展开时**画在这里：`<details>` 折叠时子节点仍在 DOM 里，
    // 无条件渲染会与页脚那一个入口重复，同一块里出现两个同样的链接
    // 会让「点哪个」变成多余的问题。
    !open || setup.keyURL === undefined || setup.keyURL === ''
      ? null
      : h('p', { className: 'px-plan-setup-link' },
        h('a', { href: setup.keyURL, target: '_blank', rel: 'noreferrer' },
          `${setup.keyURLName === '' ? '打开创建页' : setup.keyURLName} ↗`)),
    refs.length === 0
      ? null
      : h('div', { className: 'px-plan-setup-where' },
        h('p', null, '把下面这些项写进 DSH 凭据文件（或设成同名环境变量）：'),
        file === ''
          ? null
          : h('code', { className: 'px-plan-setup-path' }, file),
        h('ul', { className: 'px-plan-setup-refs' },
          refs.map((item) => h('li', { key: item.name },
            h('code', null, `${item.name}: ${item.example === '' ? '…' : item.example}`),
            item.note === '' ? null : h('span', { className: 'px-plan-setup-note' }, item.note))))),
    // 两条路的重载方式不同，必须分开说：凭据文件由 DSH **自动重载**（改完不必重启），
    // 环境变量在启动时就快照固定了（必须重启）。混成一句会让用户白重启一次，
    // 或者反过来一直等一个永远不会生效的值。
    h('p', { className: 'px-plan-setup-hint' },
      '凭据文件改完由 DSH 自动重载，不用重启；环境变量则要写进 ',
      h('code', null, '<DSH_HOME>/.env'),
      ' 或启动 dsh 前 export，然后重启 dsh 才生效。'),
  )
}

/**
 * 这一家有可显示的「怎么配」说明吗。
 *
 * 单独抽出来是为了让**页脚**与说明块用同一条判据：说明块为空时它自己返回 null，
 * 页脚若还按「有 setup 就不画链接」去抑制，这一家就一个入口都没有了。
 * @param {object} setup - 宿主的 setup 块。
 * @returns {boolean} 是否有内容可显示。
 */
function hasSetupHelp(setup) {
  if (setup === undefined || setup === null) return false
  const acquire = Array.isArray(setup.acquire) ? setup.acquire : []
  const refs = Array.isArray(setup.refs) ? setup.refs : []
  return acquire.length > 0 || refs.length > 0
}

/**
 * 一家厂商的额度区块。
 * @param {object} props - provider / now / current / credentialFile。
 * @returns {object} React 元素。
 */
function ProviderQuota(props) {
  const { provider, now, current = false, credentialFile } = props
  const status = providerStatus(provider)
  const windows = WINDOW_ORDER
    .map((key) => (provider?.windows ?? []).find((win) => win.window === key))
    .filter(Boolean)
  const link = PLAN_LINKS[provider?.id]
  // 新宿主的 setup 优先；旧宿主没有它时才用写死的表。
  const setup = provider?.setup
  // 缺凭据时把说明**默认展开**：那正是用户需要它的时刻。
  // 配好了就折叠起来，不占版面。
  const needsKey = provider?.ok !== true && provider?.reason === 'no-key'
  const setupURL = setup?.keyURL === undefined || setup.keyURL === '' ? undefined : setup.keyURL
  const setupLabel = setup?.keyURLName === undefined || setup.keyURLName === ''
    ? '创建页 ↗'
    : `${setup.keyURLName} ↗`
  // 入口在同一块里**只出现一次**。展开时它跟在步骤后面（就在眼前），
  // 此时页脚不再重复；折叠（或旧宿主没有 setup）时由页脚那个常驻入口承担。
  // 判据必须与 SetupHelp 自己的渲染条件一致（`hasSetupHelp`）：
  // 说明块为空时它渲染 null，页脚若还抑制链接，这一家就一个入口都没有了。
  const setupShowsLink = needsKey && hasSetupHelp(setup) && setupURL !== undefined
  const keyURL = setupShowsLink ? undefined : (setupURL ?? link?.href)
  const keyLabel = setupURL === undefined ? link?.label : setupLabel

  return h('div', { className: `px-plan${current ? ' px-plan-current' : ''}` },
    h('div', { className: 'px-plan-head' },
      h('b', { className: 'px-plan-name' }, provider?.name ?? '未知厂商'),
      provider?.plan === undefined || provider.plan === '' ? null : h('span', { className: 'px-badge ok' }, provider.plan),
      // 「当前监看」要显式标出来：切换器在它上面，用户点完得能立刻看出点中了谁。
      current ? h('span', { className: 'px-badge primary' }, '当前监看') : null,
      provider?.keyHint === undefined
        ? null
        : h('span', { className: 'px-plan-key', title: `凭据来源：${provider.keySource ?? '未知'}` },
          `${provider.keyRef ?? ''} ${provider.keyHint}`)),
    status.level === 'ok' && status.text === ''
      ? null
      : h('p', { className: `px-balance-state px-${status.level === 'ok' ? 'warn' : status.level}` }, status.text),
    provider?.warning === undefined
      ? null
      : h('p', { className: 'px-balance-state px-warn' }, provider.warning),
    h(SetupHelp, { setup, credentialFile, open: needsKey }),
    windows.length === 0
      ? null
      : h('div', { className: 'px-quota-list' }, windows.map((win) => h(QuotaWindow, { key: win.window, win, now }))),
    // 这一家的入口与这一家的数据源说明并排一行：两者都是「关于这一家」的补充信息，
    // 各占一行会让三家堆出六行来。
    h('p', { className: 'px-plan-foot' },
      keyURL === undefined
        ? null
        : h('a', { href: keyURL, target: '_blank', rel: 'noreferrer' }, keyLabel),
      provider?.endpoint === undefined
        ? null
        : h('span', { className: 'px-plan-endpoint', title: '未文档化的内部接口，可能随官方改动失效' },
          `数据源 ${provider.endpoint}`)),
  )
}

/**
 * 「当前监看哪一家」的切换器。
 *
 * 三件事刻意如此：
 *   1) **失败的厂商也列出来**。用户配错凭据时恰恰最想切过去看一眼原因；
 *      只在可用项之间切换会让人以为插件不支持那一家（见 `providerChoices`）。
 *   2) **总是给一个「自动」选项**。自动的含义是「在全部可用厂商里挑最紧的那个」，
 *      这是默认行为；没有这一项，用户点过一次之后就再也回不到自动。
 *   3) 它是**纯界面偏好**，只写浏览器本地存储，不影响宿主是否发请求
 *      （见 client/planView.js 的说明）。
 * @param {object} props - providers / selected / onSelect。
 * @returns {object|null} React 元素。
 */
function PlanSwitcher(props) {
  const { providers, selected, onSelect } = props
  if (providers.length === 0) return null

  /** 渲染一枚选项。 */
  const chip = (id, label, ok) => h('button', {
    key: id ?? 'auto',
    type: 'button',
    className: `px-plan-chip${(selected ?? undefined) === id ? ' active' : ''}${ok === false ? ' bad' : ''}`,
    'aria-pressed': (selected ?? undefined) === id,
    onClick: () => { onSelect?.(id) },
  }, label)

  return h('div', { className: 'px-plan-switch' },
    h('span', { className: 'px-plan-switch-label' }, '当前监看'),
    chip(undefined, '自动（最紧）', true),
    providers.map((provider) => chip(provider.id, PLAN_SHORT[provider.id] ?? provider.name, provider.ok)),
    h('span', { className: 'px-plan-switch-hint' },
      '只影响这里突出显示哪一家，不影响取数与预警。'),
  )
}

/**
 * 订阅套餐额度面板：每家的各窗口进度 + 切换器 + 开关 + 隐私说明。
 *
 * 这里刻意**不做**任何金额换算：智谱的积分、Command Code 的美元信用额与火山的
 * 积分是几套互不相通的单位，混在一起加总只会得到一个没有意义的数字。
 *
 * 导出是为了让渲染闸门能直接渲染它（面板在整页里是并排两栏之一，单独断言它的
 * 内部结构比从整页 HTML 里切片段更可靠）。
 * @param {object} props - payload / error / busy / now / onToggle / selected / onSelect。
 * @returns {object} React 元素。
 */
export function PlansPanel(props) {
  const { payload, error, busy, now, onToggle, selected, onSelect, compact } = props
  const enabled = payload?.enabled !== false
  const locked = payload?.lockedByEnv === true
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  const choices = providerChoices(payload)
  // 当前监看的那一家（与切换器同一条判据）。它必须留在显眼组：
  // 切换器里标着「当前监看」而下面找不到它，是自相矛盾的界面。
  const currentId = (() => {
    if (selected !== undefined && selected !== '') return selected
    return tightestWindow({ providers })?.planId
  })()
  // 没配过凭据的那几家收进折叠区（见 partitionProviders 的注释：判据是
  // 「有没有配过」而不是「成功还是失败」——配过但坏了的一直显示）。
  const { active, idle } = partitionProviders(providers, { selected, current: currentId })
  /** 渲染一家。 */
  const renderProvider = (provider) => h(ProviderQuota, {
    key: provider.id,
    provider,
    now,
    current: isCurrentPlan(selected, providers, provider.id),
    // 「配到哪」的路径由宿主解析（浏览器拿不到 env），这里只往下传。
    credentialFile: payload?.credentialFile,
  })

  return h('div', { className: compact === true ? 'px-account-col' : null },
    h('div', { className: 'px-balance-head' },
      h('div', { className: 'px-balance-total' },
        h('span', { className: 'px-balance-currency' },
          choices.length === 0 ? '智谱 · Command Code · 火山方舟' : `${choices.length} 家已配置`)),
      h('label', { className: 'px-balance-toggle' },
        h('input', {
          type: 'checkbox',
          checked: enabled,
          disabled: busy === true || locked,
          onChange: (event) => { onToggle?.(event.target.checked) },
        }),
        h('span', null, locked ? '套餐（环境变量已关）' : '套餐'))),

    error !== undefined && error !== ''
      ? h('p', { className: 'px-balance-state px-error' }, `套餐额度读取失败：${error}`)
      : null,
    payload?.enabled === false
      ? h('p', { className: 'px-balance-state px-off' },
        locked
          ? '已被环境变量 DSH_PIXEL_PLANS 关闭'
          : '已关闭，宿主不会向任何第三方端点发起请求')
      : null,

    // 切换器放在额度块**之前**：它决定下面哪一块被标成「当前监看」，
    // 摆在后面会让人先读到数据再看到「其实可以换一个看」。
    payload?.enabled === false
      ? null
      : h(PlanSwitcher, { providers: choices, selected, onSelect }),

    providers.length === 0
      ? null
      : h('div', { className: 'px-plan-list' },
        active.map(renderProvider)),

    // 没配凭据的那几家折起来：它们此刻没有任何信息量（就是「还没配」），
    // 但**不能删掉**——随着适配的第三方变多，用户需要一处能看见
    // 「插件还支持哪些家、怎么配」。标题行写明有几家，收起的是内容不是事实。
    //
    // **一家都没配时默认展开**：那时上面是空的，折叠起来整张卡片就只剩一行字，
    // 新用户既看不到支持哪些家、也无从知道该怎么配。有在用的家时才收起。
    idle.length === 0
      ? null
      : h(Collapse, {
        // 用 key 让「该展开」这件事变化时重新挂载：Collapse 的 open 是内部 state，
        // 只读初始值，光改 defaultOpen 是改不动的。
        key: `idle-${active.length === 0}`,
        title: '未配置的厂商',
        hint: active.length === 0 ? '配好凭据即可查看额度' : '配好凭据后会自动移到上面',
        summary: `${idle.length} 家`,
        defaultOpen: active.length === 0,
      },
      h('div', { className: 'px-plan-list px-plan-list-idle' },
        idle.map(renderProvider))),

    // 同上：折进 <details>，默认不占版面
    h('details', { className: 'px-details' },
      h('summary', null, '接口来源与隐私'),
      h('p', { className: 'px-balance-privacy' },
        '三家都',
        h('b', null, '没有公开文档化的额度接口'),
        '，这里用的是它们前端自己在用的内部接口；凭据只在本地宿主进程内使用，',
        h('b', null, '不会离开本机'),
        '，浏览器端只收到额度数字与打码后的凭据尾段。',
        '智谱需要',
        h('b', null, '编程套餐专属 Key'),
        '（在「个人编程套餐」里新建，与平台普通 API Key 不通用）。',
        '火山方舟的用量接口在',
        h('b', null, '控制面 OpenAPI'),
        '上，要的是',
        h('b', null, '火山账号'),
        '的 AccessKey ID / Secret Access Key（',
        h('b', null, '不是'),
        '方舟推理用的 ark- 开头的 Key，那把在网关会被直接拒绝）。这两把在火山引擎的',
        h('b', null, 'IAM「API 访问密钥」'),
        '里创建——不在方舟控制台里。每一家的「这家凭据怎么配」里有完整步骤与凭据文件路径。')),
  )
}

/**
 * 判断某一家是不是「当前监看」的那一家。
 *
 * 用户显式选过就用他选的；没选过（自动模式）则跟着**最紧**的那一个走——
 * 与输入框下方那一枚徽标用同一条判据（`tightestWindow`），否则用户会看到
 * 「下面标的是 A 家、费用条旁边显示的是 B 家」这种自相矛盾的界面。
 * @param {string|undefined} selected - 用户显式选择。
 * @param {object[]} providers - 宿主给的全部厂商。
 * @param {string} id - 待判断的厂商 id。
 * @returns {boolean} 是否是当前监看的那一家。
 */
function isCurrentPlan(selected, providers, id) {
  if (selected !== undefined && selected !== '') return selected === id
  const tightest = tightestWindow({ providers })
  return tightest !== undefined && tightest.planId === id
}

/**
 * 订阅通知运行时的快照。
 *
 * 用 `useSyncExternalStore` 而不是自己 `useState` + `useEffect` 订阅：
 * 后者在「订阅发生在首次渲染之后」的窗口里会丢掉一次变化，而这正是本面板
 * 最常见的场景（面板打开时运行时已经在跑，且刚刚发布过状态）。
 * 运行时的存储做了变化检测，因此每 4 秒的轮询不会引起无谓重渲染。
 * @param {object} store - {@link notifyStore} 的返回值。
 * @returns {object} 快照。
 */
function useNotifySnapshot(store) {
  return React.useSyncExternalStore(
    useCallback((listener) => store.subscribe(listener), [store]),
    useCallback(() => store.getSnapshot(), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
}

/**
 * 一条通知的时间戳：只写时分秒。
 * @param {number} at - 毫秒时间戳。
 * @returns {string} 形如 `14:03:21`。
 */
function clockOf(at) {
  const value = Number(at)
  if (!Number.isFinite(value) || value <= 0) return '—'
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
}

/**
 * 通知与预警面板：系统通知授权、分类开关、余额 / 套餐阈值、待办与最近通知。
 *
 * 余额与套餐的**当前值**由外层传入（`View` 已经取过一份），这里只用来做
 * 「如果现在按这个阈值判，会不会触发」的即时预览——真正的判定在运行时里，
 * 按它自己的节奏跑。这样用户调阈值时能马上看到效果，而不必等 30 秒。
 * @param {object} props - balance / plans。
 * @returns {object} React 元素。
 */
function NotifyPanel(props) {
  const { balance, plans } = props
  const store = useMemo(() => notifyStore(), [])
  const snapshot = useNotifySnapshot(store)
  const config = { ...NOTIFY_DEFAULTS, ...(snapshot.config ?? {}) }
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // 阈值输入框的草稿：输入过程中不能每敲一个字符就写盘，否则输入「10」会先
  // 提交「1」——而「1」是一个完全不同的阈值（余额低于 1 元就报警）。
  const [draft, setDraft] = useState(null)

  const save = useCallback((patch) => {
    setSaving(true)
    setError('')
    saveNotify(patch)
      .then((result) => {
        if (result?.config !== undefined) store.setConfig(result.config)
        // 落盘失败要说出来，但不能回滚界面上的选择——内存里已经生效，
        // 回滚只会让用户觉得自己没点到。
        if (result?.persisted === false) setError('设置已在本次运行内生效，但没能写进配置文件')
      })
      .catch((cause) => { setError(String(cause?.message ?? cause)) })
      .finally(() => { setSaving(false) })
  }, [store])

  const ask = useCallback(() => {
    // 申请完立刻**重新读一次**浏览器（而不是用 requestPermission 的返回值）：
    // 那个返回值在部分浏览器里与 `Notification.permission` 短暂不一致，
    // 而后者才是真正决定通知能否弹出的依据。
    requestPermission().then(() => { store.setPermission(permissionOf()) })
  }, [store])

  /**
   * 重新读一次浏览器的真实权限。
   *
   * `permissionOf()` 默认读 `globalThis`，因此这里**显式传入浏览器全局**：
   * 面板与运行时可能在不同的全局对象下被求值（打包后各自一个作用域），
   * 而权限这件事只有一个真值来源——`window`。
   */
  const recheck = useCallback(() => {
    store.setPermission(permissionOf(typeof window === 'undefined' ? globalThis : window))
  }, [store])

  /**
   * 发一条测试通知。
   *
   * 「功能到底通没通」不该靠用户去等一个真实任务跑完来推测。这一条走的是与真实
   * 提醒**完全相同**的那条路径（registry 里的同一个 notify 函数），因此它能弹
   * 就说明整条链路是好的；弹不出来，问题一定在浏览器授权或系统通知设置上。
   */
  const test = useCallback(() => {
    store.publishTest()
  }, [store])

  const permission = snapshot.permission ?? 'default'
  const rows = Array.isArray(balance?.balances) ? balance.balances : []
  const thresholds = config.warnBalance ?? {}
  const active = balanceAlerts(balance, thresholds)
  const quotaHit = quotaAlerts(plans, config.warnQuotaPercent)

  return h('div', null,
    // 浏览器授权是**前置条件**：没授权时系统通知一个都不会出现。
    // 因此这一行永远在最上面，并且状态写清楚，而不是等用户来问「为什么没提醒」。
    //
    // 三种「没授权」要分开说，因为**下一步动作完全不同**：
    //   default     → 可以申请，给按钮；
    //   denied      → 申请也没用了（浏览器不再弹框），只能去站点设置里改；
    //   unsupported → 环境根本没有这个 API，点了也没反应，别给按钮。
    // 混成一句「未授权」会让人反复点一个不会有任何反应的按钮。
    h('div', { className: 'px-notify-permission' },
      h('span', { className: `px-badge${permission === 'granted' ? ' ok' : ''}` },
        permission === 'granted'
          ? '系统通知已授权'
          : permission === 'denied'
            ? '系统通知被拒绝'
            : permission === 'unsupported' ? '本环境不支持系统通知' : '系统通知未授权'),
      h('span', { className: 'px-muted px-notify-permission-text' }, PERMISSION_TEXT[permission] ?? ''),
      permission === 'default'
        ? h('button', { type: 'button', className: 'px-btn small primary', onClick: ask }, '申请授权')
        : null,
      // 用户可以**不经过本插件**改权限（地址栏站点设置、浏览器设置页），
      // 而我们只在轮询时同步。给一个手动重检的入口，省得他改了权限还要猜
      // 「为什么这里没变」——那正是最容易让人觉得「没用明白」的地方。
      permission === 'granted'
        ? null
        : h('button', { type: 'button', className: 'px-btn small', onClick: recheck }, '重新检测'),
      // 「能不能弹」是一件必须能自证的事：不试一次，用户永远不确定是自己没配好
      // 还是功能坏了。这一枚只发一条本地通知，不依赖宿主、不依赖任何配置。
      permission === 'granted'
        ? h('button', { type: 'button', className: 'px-btn small', onClick: test }, '发一条测试通知')
        : null),

    error === '' ? null : h('p', { className: 'px-balance-state px-error' }, error),
    snapshot.error === '' || snapshot.error === undefined
      ? null
      : h('p', { className: 'px-balance-state px-warn' }, `通知取数失败：${snapshot.error}`),

    // 待办交互：这是**唯一**需要用户立刻行动的一类，因此单独拿出来放最前面，
    // 而不是混在「最近通知」里等着被翻到。
    snapshot.pending?.length > 0
      ? h('div', { className: 'px-notify-pending' },
        h('b', { className: 'px-notify-pending-title' }, `⏳ ${snapshot.pending.length} 项等待你的处理`),
        h('div', { className: 'px-rows' },
          snapshot.pending.map((item) => h(Row, {
            key: String(item.key),
            label: item.kind === 'approval'
              ? '授权'
              : item.kind === 'plan-review' ? '计划确认' : item.kind === 'question' ? '提问' : '待办',
            value: item.kind === 'approval'
              ? String(item.toolName ?? '工具调用')
              : String(item.questions?.[0]?.header ?? item.questions?.[0]?.question ?? '等待回答'),
          }))))
      : null,

    h('div', { className: 'px-notify-flags' },
      NOTIFY_FLAGS.map((flag) => h('label', {
        key: flag.key,
        className: 'px-notify-flag',
        title: flag.hint,
      },
      h('input', {
        type: 'checkbox',
        checked: config[flag.key] !== false,
        disabled: saving,
        onChange: (event) => { save({ [flag.key]: event.target.checked }) },
      }),
      h('span', null, flag.label)))),

    // ── 余额预警阈值 + 套餐额度预警 ────────────────────────────────
    // 两项阈值并排一行：它们各自的正文只有「一个标签 + 一个数字框」，
    // 各占一整行会白吃掉两倍高度。窄屏由 .px-notify-thresholds 的媒体查询塌回单列。
    h('div', { className: 'px-notify-thresholds' },
      h('div', { className: 'px-notify-threshold' },
        h('div', { className: 'px-notify-threshold-head' },
          h('b', null, '余额预警阈值'),
          h('span', { className: 'px-muted' }, '留空表示不预警该币种；低于阈值时提醒一次，恢复到阈值以上后重新武装')),
        rows.length === 0
          ? h('p', { className: 'px-muted px-note' }, '还没有拿到余额，无法设置阈值（先在上面的余额卡片里确认能取到金额）。')
          : h('div', { className: 'px-notify-inputs' },
            rows.map((row) => {
              const currency = String(row.currency ?? '')
              const current = draft?.currency === currency
                ? draft.value
                : (Number.isFinite(Number(thresholds[currency])) ? String(thresholds[currency]) : '')
              return h('label', { key: currency, className: 'px-notify-input' },
                h('span', null, `${currency} 低于`),
                h('input', {
                  type: 'number',
                  min: 0,
                  step: '0.01',
                  value: current,
                  disabled: saving,
                  placeholder: '不预警',
                  onChange: (event) => { setDraft({ currency, value: event.target.value }) },
                  // 失焦才提交：输入中的每一个中间值都是合法但错误的阈值
                  // （输入「10」会先经过「1」——那是完全不同的一个阈值）。
                  onBlur: () => {
                    // 只有真的改过才提交。`draft === null` 说明用户只是点进来又点出去，
                    // 此时若照常提交，`raw` 会落到空串、进而**删掉**已有阈值——
                    // 一个纯粹的「看了一眼」动作不该改掉配置。
                    if (draft?.currency !== currency) return
                    const raw = draft.value
                    setDraft(null)
                    const next = { ...thresholds }
                    if (String(raw).trim() === '') delete next[currency]
                    else next[currency] = Number(raw)
                    save({ warnBalance: next })
                  },
                }))
            })),
        active.length === 0
          ? null
          : h('p', { className: 'px-balance-state px-warn' },
            `按当前设置：${active.map((item) => `${item.currency} ${formatMoney(item.total, item.currency)}`).join('、')} 已低于阈值`)),

      h('div', { className: 'px-notify-threshold' },
        h('div', { className: 'px-notify-threshold-head' },
          h('b', null, '套餐额度预警'),
          h('span', { className: 'px-muted' }, '任意窗口「已用」达到这个百分比时提醒；0 表示关闭')),
        h('div', { className: 'px-notify-inputs' },
          h('label', { className: 'px-notify-input' },
            h('span', null, '已用达到'),
            h('input', {
              type: 'number',
              min: 0,
              max: 1000,
              step: 1,
              value: draft?.currency === '__quota' ? draft.value : String(config.warnQuotaPercent),
              disabled: saving,
              onChange: (event) => { setDraft({ currency: '__quota', value: event.target.value }) },
              // 与余额阈值同理：只有真的改过才提交
              onBlur: () => {
                if (draft?.currency !== '__quota') return
                const raw = draft.value
                setDraft(null)
                save({ warnQuotaPercent: Number(raw) })
              },
            }),
            h('span', null, '%'))),
        quotaHit.length === 0
          ? null
          : h('p', { className: 'px-balance-state px-warn' },
            `按当前设置：${quotaHit.slice(0, 4).map((item) => `${item.provider} ${item.label} ${item.percent.toFixed(0)}%`).join('、')} 已达阈值`))),

    // ── 最近通知（默认收起）────────────────────────────────────────
    // 它是**事后明细**：绝大多数时候有价值的是上面那句「几项等待处理」，
    // 而不是一条条翻时间戳。收起后标题行仍写着条数，信息不丢，版面省掉一大块。
    h(Collapse, {
      title: '最近通知',
      hint: snapshot.ready === true ? '本次页面会话内' : '加载中…',
      summary: snapshot.recent?.length > 0 ? `${Math.min(snapshot.recent.length, 8)} 条` : '暂无',
      defaultOpen: false,
      className: 'px-notify-recent',
    },
    snapshot.recent?.length > 0
      ? h('div', { className: 'px-rows' },
        snapshot.recent.slice(0, 8).map((item, index) => {
          const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : ''
          // 带会话 id 的才可点：余额 / 套餐阈值那类预警不属于任何会话，
          // 给它们一个点了没反应的点击区只会让人以为坏了。
          return h(RecentRow, {
            key: `${item.at}-${index}`,
            label: clockOf(item.at),
            // 被「当前会话不打扰」静默的那条照样列在这里，并明说它没弹——
            // 否则用户看到的是「别的会话完成了却什么都没发生」，只会以为功能漏了。
            value: composeRecentLine(item),
            sessionId,
            onOpen: (id) => { store.openSession(id) },
          })
        }))
      : h('p', { className: 'px-muted px-note' },
        '还没有发出过通知。让一个会话跑完（或去别的标签页等一会儿），这里就会出现记录。')),
    // 隐私与机制说明：折进 <details>，默认不占版面（与其余面板同一套做法）
    h('details', { className: 'px-details' },
      h('summary', null, '提醒是怎么触发的'),
      h('p', { className: 'px-balance-privacy' },
        '「任务完成 / 失败 / 中断」由宿主侧判定后写进一份',
        h('b', null, '仅存在于内存'),
        '的日志，浏览器每 4 秒取一次增量——因为浏览器看不到后台会话的轮次结束事件，'
        + '而那正是最需要提醒的时候。',
        '「等待授权 / 回答」直接读 DSH 自己发布的待办状态，不经过网络。',
        '「余额 / 套餐预警」在浏览器侧按 30 秒的节奏判定，且',
        h('b', null, '同一项预警持续期间只提醒一次'),
        '，恢复到阈值以上后才会重新武装。',
        '刷新页面会清空「最近通知」，一切都只在内存里，不写任何文件。')),
  )
}

/**
 * 模型分布：环图 + 条形占比（按当前时间窗口）。
 *
 * 一条 = **模型 × 提供商**，与费用明细同一口径：同一个 DeepSeek 模型经三条路由
 * 调用就是三份用量（单价与额度归属都不同），而 `模型路由名 + 模型外显名` 那种
 * 「名字里有两条信息」的展示让人分不清哪一条才是模型。
 * @param {object} props - models / rangeByModel / rangeTotals。
 * @returns {object} React 元素。
 */
function ModelBreakdown(props) {
  const { models, rangeByModel, rangeTotals } = props
  const rows = models.map((model, index) => {
    const usage = rangeByModel[entryKeyOf(model)] ?? { local: 0 }
    const share = rangeTotals.local > 0 ? (Number(usage.local ?? 0) / rangeTotals.local) * 100 : 0
    return {
      key: entryKeyOf(model),
      label: model.label,
      tone: TONES[index % TONES.length],
      value: Number(usage.local ?? 0),
      text: `${formatTokens(usage.local)} · ${share.toFixed(1)}%`,
    }
  })
  const visible = rows.filter((row) => row.value > 0)
  if (visible.length === 0) return h('p', { className: 'px-muted' }, '当前时间窗口内没有模型调用。')
  return h('div', { className: 'px-model-grid' },
    h(DonutChart, {
      slices: visible.map((row) => ({ key: row.key, value: row.value, tone: row.tone })),
      centerTitle: '窗口内 token',
      centerValue: formatTokens(rangeTotals.local),
    }),
    h('div', { className: 'px-model-side' },
      h(BarList, { rows: visible }),
      h('p', { className: 'px-muted px-note' },
        `共 ${models.length} 个「模型 × 提供商」条目 · 用量最多：${models[0]?.label ?? '—'}`)))
}

/**
 * 模型条目的身份键。
 *
 * 新宿主给的是 `模型@提供商`（见宿主 CAPABILITIES 的 `modelProvider`），
 * 旧宿主只有 `model`——两种都要认，否则整块界面会显示成「没有模型调用」。
 * @param {object} model - 宿主 models[] 里的一条。
 * @returns {string} 用于查 `byModel` 的键。
 */
function entryKeyOf(model) {
  if (typeof model?.key === 'string' && model.key !== '') return model.key
  return String(model?.model ?? '')
}

/**
 * 费用明细表：逐条目列出用量与金额，并在表下给出单价来源。
 *
 * 两种口径要分开表达，否则会误导：
 *   - **分时**（DeepSeek）逐条列出高峰 / 空闲 token 与「空闲 / 高峰」双档单价；
 *   - **不分时**（智谱 GLM 等）高峰与空闲同价，因此**只显示一列 token**、
 *     单价也只写一个值——硬摆一对相同的「空闲 / 高峰」数字纯属噪音。
 *
 * ## 表头与单元格必须**逐行**对齐（踩过的坑）
 *
 * 分时与不分时是**逐条**判定的，因此表头只能有两种形态，且必须与每一行的
 * 单元格数一致。早先表头按「有没有不分时的条目」二选一，而行是按自己的
 * `flat` 标志决定要不要多画一格——于是只要有一行判错（GLM 因为查不到价目
 * 回落成 Flash 价，被误判成分时），整张表从那一行起就错位：金额落进了
 * 「空闲 token」那一列，表头少一个，用户看到的就是「金额列也是用量」。
 * 现在两侧都走同一份 `columns`，构造上不可能再错位。
 * @param {object} props - models / rangeByModel / pricing / rangeCost / split / rangeLabel。
 * @returns {object} React 元素。
 */
function CostTable(props) {
  const { models, rangeByModel, pricing, rangeCost, split, rangeLabel } = props
  const rows = models
    .map((model, index) => {
      const key = entryKeyOf(model)
      const usage = rangeByModel[key]
      if (usage === undefined) return null
      // 价目优先用宿主**逐条**交下来的那一份（含 GLM 这类原生 id 查不到的情况），
      // 拿不到才退回整张价目表。
      const rates = model.rates ?? ratesFor(pricing, key)
      return {
        key,
        model: model.model ?? key,
        label: model.label,
        provider: typeof model.provider === 'string' ? model.provider : '',
        providerLabel: typeof model.providerLabel === 'string' ? model.providerLabel : '',
        rollup: typeof model.rollup === 'string' ? model.rollup : key,
        // 这一条合并了哪些路由 id，悬停可查（同一个模型在网关里有多个叫法是常态）
        routes: Array.isArray(model.routes) ? model.routes.filter((name) => typeof name === 'string') : [],
        rates,
        // 配色按**在 `models` 里的下标**取，与「模型分布」环图完全同源：
        // 两处若各按自己的过滤后下标取色，同一个条目会在两张图里显示成不同颜色。
        tone: TONES[index % TONES.length],
        // 不分时的模型 peak 与 idle 相同；按 peak 判定即可
        flat: Number(rates.cacheMiss?.peak ?? 0) === Number(rates.cacheMiss?.idle ?? 0)
          && Number(rates.output?.peak ?? 0) === Number(rates.output?.idle ?? 0),
        // 宿主标注的可信度：兜底价要显式说明，别让猜的数字看起来像官方价
        priced: model.priced !== false,
        tiered: model.tiered === true,
        vendor: model.vendor ?? '',
        cost: priceByModel({ [key]: usage }, pricing),
        peak: peakTokensOf(usage),
        idle: idleTokensOf(usage),
        total: Number(usage.local ?? 0),
      }
    })
    .filter(Boolean)

  if (rows.length === 0) return h('p', { className: 'px-muted' }, '当前时间窗口内没有模型调用。')

  // 分时与不分时逐条判定，因此表格允许「逐行不同」：
  // 不分时的条目自己只出 1 列 token，分时的条目出 2 列，合计行按有没有分时条目决定。
  const anyTiered = rows.some((row) => row.tiered)
  const anyUnpriced = rows.some((row) => !row.priced)
  const anyUnknownProvider = rows.some((row) => row.provider === '')

  /**
   * 单价按**模型**归组，而不是逐条（逐提供商）重复列出。
   *
   * 依据是一个事实：**价目表本身就按模型索引**（`MODEL_RATES` 的键里没有提供商，
   * 见 lib/pricing.js）。同一个模型走四条路由，`rates` 是**同一份对象**——
   * 实测本机 4 条 `deepseek-flash` 的单价逐字相同，却把
   * 「缓存命中 ¥0.02 / ¥0.04 · 未命中 ¥1 / ¥2 · 输出 ¥4 / ¥8」整整重复了 4 遍。
   * 数字一样、单位一样、厂商一样，唯一的差别在**用量**上——而用量在上面的表里。
   *
   * 归组键取 `rollup`（价目表的键），不是「价格数字相同」：后者会把两个
   * 恰好同价的**不同模型**并成一条，抹掉模型名。
   *
   * 组内**保留每一个提供商的色块**：色块与「模型分布」环图同源（见 row.tone），
   * 每个提供商在环图里占一片，因此这里也必须一个不少，否则图例就对不上号了。
   */
  const rateGroups = []
  const rateGroupIndex = new Map()
  for (const row of rows) {
    const groupKey = row.rollup === '' ? row.key : row.rollup
    const found = rateGroupIndex.get(groupKey)
    if (found === undefined) {
      rateGroupIndex.set(groupKey, { key: groupKey, first: row, rows: [row] })
      rateGroups.push(rateGroupIndex.get(groupKey))
    } else {
      found.rows.push(row)
    }
  }

  return h('div', null,
    h('div', { className: 'px-table-wrap' },
      h('table', { className: 'px-table px-cost-table' },
        h('thead', null,
          h('tr', null,
            h('th', null, '模型'),
            h('th', null, '提供商'),
            h('th', { className: 'px-num' }, '高峰 token'),
            h('th', { className: 'px-num' }, '空闲 token'),
            h('th', { className: 'px-num' }, `${rangeLabel}金额`))),
        h('tbody', null,
          rows.map((row) => {
            // 不分时：高峰与空闲同价，两个分档 token 合成一列避免出现「0」
            const peak = row.flat ? row.total : row.peak
            const idle = row.flat ? null : row.idle
            return h('tr', { key: row.key },
              h('td', null,
                h('b', null, row.label),
                // 归一后的模型键；合并了多个路由 id 时悬停能看到它们本来的名字
                h('span', {
                  className: 'px-muted px-mono',
                  title: row.routes.length > 1 ? `合并的路由 id：${row.routes.join('、')}` : undefined,
                }, ` ${row.rollup}`),
                row.priced ? null : h('span', { className: 'px-badge' }, '估算价'),
                row.tiered ? h('span', { className: 'px-badge' }, '按最低档') : null),
              h('td', null, row.provider === ''
                ? h('span', { className: 'px-muted', title: '旧账本记录里没有提供商信息' }, '来源未知')
                : (row.providerLabel === '' ? row.provider : row.providerLabel)),
              h('td', { className: 'px-num' }, formatTokens(peak)),
              // 不分时的那一格写成「—」而不是留空：留空会让人以为数据丢了
              h('td', { className: 'px-num' }, idle === null ? h('span', { className: 'px-muted' }, '—') : formatTokens(idle)),
              h('td', { className: 'px-num' }, formatCny(row.cost.standard)))
          }),
          h('tr', { className: 'px-row-total' },
            h('td', null, '合计'),
            h('td', null, ''),
            h('td', { className: 'px-num' }, formatTokens(split.peak)),
            h('td', { className: 'px-num' }, formatTokens(split.idle)),
            h('td', { className: 'px-num' }, formatCny(rangeCost.standard)))))),
    h('div', { className: 'px-rate-list' },
      // 表头：把单位和「空闲 / 高峰」的顺序**说一次**，下面每一行就不必重复，
      // 也省掉「¥0.02 / ¥0.04 哪个是哪个」的歧义。
      h('div', { className: 'px-rate-caption' },
        h('span', null, '各模型官方单价'),
        h('span', { className: 'px-rate-unit' }, '元 / 百万 token · 空闲 / 高峰')),
      rateGroups.map((group) => {
        const row = group.first
        /**
         * 这一行用**价目表里的官方模型名**，而不是 `row.label`。
         *
         * `row.label` 是 **DSH 设置里那条路由的外显名**，逐提供商不同：同一个
         * `deepseek-flash` 在 WorkBuddy 下叫「DeepSeek Flash」、在 commandcode 下叫
         * 「COD-DeepSeek V4.1 Flash」。若直接取 `group.first.label`，显示的就是
         * 「按用量排序碰巧排第一的那个提供商给它的名字」——价格明明是模型的属性，
         * 却被贴上某一家的叫法，换个窗口就会变。
         *
         * 兜底价（不在价目表里）例外：那时 `rates` 是 Flash 的兜底条目，
         * `rates.label` 会把它误标成「DeepSeek Flash」，所以退回它自己的名字。
         */
        const officialLabel = row.priced && typeof row.rates?.label === 'string' && row.rates.label !== ''
          ? row.rates.label
          : row.label
        return h('div', { key: `rate-${group.key}`, className: 'px-rate' },
          // 左列：色块 + 模型名 + 归一后的键。价格本身与提供商无关，
          // 色块只是让读者能把这一行对回到上面的用量行。
          h('span', { className: 'px-rate-who' },
            h('span', { className: 'px-rate-tones' },
              group.rows.map((item) => h('i', {
                key: item.key,
                className: `px-rate-swatch ${toneFill(item.tone)}`,
                title: item.providerLabel === '' ? '来源未知' : item.providerLabel,
              }))),
            h('b', null, officialLabel),
            h('span', { className: 'px-muted px-mono' }, group.key),
            row.priced ? null : h('span', { className: 'px-badge' }, '估算价'),
            // 哪几家的用量落在这个模型上：只在多家时才点出来，一家时是废话
            group.rows.length > 1
              ? h('span', { className: 'px-muted' }, `${group.rows.length} 个来源`)
              : null),
          h('span', { className: 'px-rate-prices' },
            h('span', null,
              h('em', null, '缓存命中'),
              h('code', null, row.flat
                // 不分时：只写一个价，不要摆一对相同的数字
                ? `¥${row.rates.cacheHit.peak}`
                : `¥${row.rates.cacheHit.idle} / ¥${row.rates.cacheHit.peak}`)),
            h('span', null,
              h('em', null, '未命中'),
              h('code', null, row.flat
                ? `¥${row.rates.cacheMiss.peak}`
                : `¥${row.rates.cacheMiss.idle} / ¥${row.rates.cacheMiss.peak}`)),
            h('span', null,
              h('em', null, '输出'),
              h('code', null, row.flat
                ? `¥${row.rates.output.peak}`
                : `¥${row.rates.output.idle} / ¥${row.rates.output.peak}`))))
      })),
    h('p', { className: 'px-muted px-note' },
      // 口径必须写清楚，否则用户会把「按官方价估算」误读成「我的实际账单」。
      // 说「各模型的官方价」而不是「DeepSeek 官方价」：表里既有 DeepSeek 也有
      // 智谱 GLM 的行，后者的官方价来自智谱，不是 DeepSeek。
      `金额口径：按各模型官方公布的单价估算，即“这些 token 若全部走官方 API 需要花多少钱”。`
      + `第三方中转与 Coding Plan 是事先一次性买断的订阅，不按 token 计费，因此不在此列。`,
      `单价单位元 / 百万 token；写成一个值的模型不分时（高峰与空闲同价），`
      + `写成两个值的按「空闲 / 高峰」分档。`,
      `${rangeLabel}内若全部落在空闲时段可省 ${formatCny(rangeCost.saved)}。`,
      anyTiered ? '标「按最低档」的模型官方按输入长度分档定价，这里只按最低档估算。' : '',
      anyUnpriced ? '标「估算价」的模型不在价目表里，暂按 Flash 单价估算，仅供参考。' : '',
      anyUnknownProvider
        ? '标「来源未知」的条目来自旧版账本——那时的记录没有提供商字段。'
          + '重新导入本机会话日志后，新旧记录会合并到同一个「模型 × 提供商」条目下。'
        : ''))
}

/**
 * 会话清单表。
 *
 * ## 为什么第一列是**标题**而不是会话 id
 *
 * 侧栏任务栏显示的是 DSH 的 `displayTitle`（持久标题 → 工作目录末段 → 会话 id）。
 * 早先这里显示 `session.id.slice(8, 16)`，用户看到的是一串十六进制，没有任何办法
 * 把它和侧栏里任何一个会话对上号——「会话清单」因此变成了一份读不懂的清单。
 * 宿主现在把同一条回落链算好的标题放进 `session.title`，这里直接用它。
 *
 * ## 工作区列并进了第一列
 *
 * 标题**本身就可能是工作目录末段**（新建会话还没生成标题时就是这样）。
 * 单开一列会让同一行左右各写一遍同样的字。这里改成：标题为主、工作区只在
 * **与标题不同**时以次要样式跟在后面，于是省掉一整列宽度。
 *
 * ## 旧宿主回落
 *
 * 旧宿主不返回 `session.title`。那时按 DSH 的同一条链退回**工作目录末段**，
 * 最后才是会话 id 片段——而不是显示空白，也不是一上来就退回十六进制。
 * 降级必须可见且**可用**。
 *
 * 导出是为了让渲染闸门能直接渲染它：会话清单**默认收起**，因此整页静态渲染
 * 里根本到不了这张表（见 `Collapse` 与 `Panel` 的说明），不导出就等于这一列
 * 永远没有被断言过。
 * @param {object} props - sessions / timezone。
 * @returns {object} React 元素。
 */
export function SessionTable(props) {
  const { sessions, timezone } = props
  if (sessions.length === 0) return h('p', { className: 'px-muted' }, '还没有会话记录。')
  return h('div', { className: 'px-table-wrap' },
    h('table', { className: 'px-table px-session-table' },
      h('thead', null,
        h('tr', null,
          h('th', null, '会话'),
          h('th', null, '模型'),
          h('th', null, '轮次'),
          h('th', null, 'Token'),
          h('th', null, '开始时间'))),
      h('tbody', null,
        sessions.slice(0, 40).map((session) => {
          const shortId = `${String(session.id).slice(8, 16)}…`
          const workspace = typeof session.workspace === 'string' ? session.workspace : ''
          const raw = typeof session.title === 'string' ? session.title.trim() : ''
          // 与 DSH 侧栏的 `displayTitleOf` 同一条回落链：持久标题 → 工作目录末段
          // → 会话 id。宿主已经算好了同样的链，这里再走一遍是为了**旧宿主**——
          // 它不返回 `title`，只有 `workspace`；那时至少显示目录名（用户认得出），
          // 而不是退回一串十六进制。链的顺序必须一致，否则两处显示的名字对不上。
          const title = raw !== '' ? raw : (workspace !== '' ? workspace : shortId)
          // 标题等于工作区名时不重复写第二遍（见函数说明）。
          const showWorkspace = workspace !== '' && workspace !== title
          return h('tr', { key: session.id },
            h('td', { className: 'px-session-cell' },
              h('span', { className: 'px-session-title', title: `${title}\n${session.id}` }, title),
              session.live ? h('span', { className: 'px-badge ok' }, '进行中') : null,
              showWorkspace
                ? h('span', { className: 'px-session-workspace', title: session.cwd ?? '' }, workspace)
                : null,
              // 会话 id 仍然可查（悬停可见、复制得到）：它是对日志与账本的
              // 唯一稳定标识，排查问题时要用，只是不该占着最显眼的位置。
              h('span', { className: 'px-session-id px-mono', title: session.id }, shortId)),
            h('td', null, session.models.join(', ') || '—'),
            h('td', null, String(session.turns)),
            h('td', null, formatTokens(session.totals.local)),
            h('td', null, formatDateTime(session.createdAt, timezone)))
        }))))
}
