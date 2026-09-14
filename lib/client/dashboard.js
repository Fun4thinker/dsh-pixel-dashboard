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
import {
  fetchPlans,
  formatReset,
  providerStatus,
  quotaTone,
  windowProgress,
  WINDOW_ORDER,
} from './plans.js'
import {
  formatCountdown,
  formatCny,
  formatDateTime,
  formatMinuteOfDay,
  formatTokens,
  minuteOfDay,
} from './format.js'
import { ActivityCalendar, BarList, DonutChart, TrendChart, useCountUp } from './graph.js'
import {
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
  const { options, value, onChange } = props
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
    { className: 'px-seg', ref: listRef, role: 'tablist' },
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

/** 带色点标题的卡片外壳。 */
function Panel(props) {
  return h(
    'section',
    { className: 'px-panel px-rise', style: { animationDelay: `${props.delay ?? 0}ms` } },
    h('header', { className: 'px-panel-head' },
      h('span', { className: 'px-panel-title' },
        h('i', { className: `px-panel-dot px-tone-bg-${props.tone ?? 'pink'}` }),
        props.title),
      props.extra === undefined ? null : h('span', { className: 'px-panel-extra' }, props.extra)),
    h('div', { className: 'px-panel-body' }, props.children),
  )
}

/** 键值行。 */
function Row(props) {
  return h('div', { className: 'px-row' }, h('span', null, props.label), h('b', null, props.value))
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
  const range = RANGES.find((item) => item.id === rangeId) ?? RANGES[1]
  const period = usePeriod(data, now)

  const points = useMemo(() => recentDays(data.days, range.days), [data.days, range.days])
  const rangeTotals = useMemo(() => sumRows(points), [points])
  const rangeByModel = useMemo(() => sumByModel(points.map((point) => point.byModel)), [points])
  const rangeCost = useMemo(() => priceByModel(rangeByModel, data.pricing), [rangeByModel, data.pricing])
  const todayCost = useMemo(
    () => priceByModel(data.days.at(-1)?.byModel ?? {}, data.pricing),
    [data.days, data.pricing],
  )

  const overview = data.overview
  const activeInRange = points.filter((point) => Number(point.totals.requests) > 0).length
  const split = splitTokens(rangeByModel)
  const peakShare = split.peak + split.idle > 0 ? split.peak / (split.peak + split.idle) : 0

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
        tone: period.peak ? 'red' : 'green',
        delay: 220,
        extra: h('span', { className: `px-badge${period.peak ? '' : ' ok'}` },
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
        compact: true,
      }))),

    h(Panel, { title: `${range.label} Token 趋势`, tone: 'blue', delay: 300 },
      h(TrendChart, { points, series: SERIES, formatAxis: formatTokens, formatValue: formatTokens })),

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
      '，费用为本地估算，实际账单以服务商为准。'),
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

  return h('div', { className: 'px-quota' },
    h('div', { className: 'px-quota-head' },
      h('span', { className: 'px-quota-name' }, win?.label ?? win?.window ?? '额度'),
      h('span', { className: `px-quota-percent px-tone-${tone}` },
        progress.usable ? `${progress.percent.toFixed(1)}%` : '—'),
      // 超限要明说：百分比 >100 时数字本身已经说明，但加一个徽标更醒目
      progress.over ? h('span', { className: 'px-badge' }, '已超限') : null),
    h('div', { className: 'px-quota-track' },
      h('span', {
        className: `px-quota-fill px-tone-bg-${tone}`,
        // 条宽用夹取值；数字用真值（见 windowProgress）
        style: { width: `${progress.barPercent}%` },
      })),
    parts.length === 0
      ? null
      : h('div', { className: 'px-quota-foot' }, parts.join(' · ')))
}

/**
 * 一家厂商的额度区块。
 * @param {object} props - provider / now。
 * @returns {object} React 元素。
 */
function ProviderQuota(props) {
  const { provider, now } = props
  const status = providerStatus(provider)
  const windows = WINDOW_ORDER
    .map((key) => (provider?.windows ?? []).find((win) => win.window === key))
    .filter(Boolean)

  return h('div', { className: 'px-plan' },
    h('div', { className: 'px-plan-head' },
      h('b', { className: 'px-plan-name' }, provider?.name ?? '未知厂商'),
      provider?.plan === undefined || provider.plan === '' ? null : h('span', { className: 'px-badge ok' }, provider.plan),
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
    windows.length === 0
      ? null
      : h('div', { className: 'px-quota-list' }, windows.map((win) => h(QuotaWindow, { key: win.window, win, now }))),
    provider?.endpoint === undefined
      ? null
      : h('p', { className: 'px-muted px-note' }, `数据源：${provider.endpoint}（未文档化的内部接口，可能随官方改动失效）`),
  )
}

/**
 * 订阅套餐额度面板：每家的各窗口进度 + 开关 + 隐私说明。
 *
 * 这里刻意**不做**任何金额换算：智谱的积分与 Command Code 的美元信用额是两套
 * 互不相通的单位，混在一起加总只会得到一个没有意义的数字。
 * @param {object} props - payload / error / busy / now / onToggle。
 * @returns {object} React 元素。
 */
function PlansPanel(props) {
  const { payload, error, busy, now, onToggle, compact } = props
  const enabled = payload?.enabled !== false
  const locked = payload?.lockedByEnv === true
  const providers = Array.isArray(payload?.providers) ? payload.providers : []

  return h('div', { className: compact === true ? 'px-account-col' : null },
    h('div', { className: 'px-balance-head' },
      h('div', { className: 'px-balance-total' },
        h('span', { className: 'px-balance-currency' }, '智谱（5 小时 / 每周）· Command Code（+ 每月）')),
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

    providers.length === 0
      ? null
      : h('div', { className: 'px-plan-list' }, providers.map((provider) => h(ProviderQuota, { key: provider.id, provider, now }))),

    // 充值 / 管理入口：看到额度快满时最自然的下一步
    h('p', { className: 'px-links' },
      h('a', { href: 'https://commandcode.ai/studio', target: '_blank', rel: 'noreferrer' }, 'Command Code 工作室 ↗'),
      h('span', { className: 'px-links-sep' }, '·'),
      h('a', { href: 'https://www.bigmodel.cn/coding-plan/personal/usage', target: '_blank', rel: 'noreferrer' }, '智谱套餐用量 ↗'),
      h('span', { className: 'px-links-sep' }, '·'),
      h('a', { href: 'https://console.volcengine.com/ark', target: '_blank', rel: 'noreferrer' }, '火山方舟控制台 ↗')),

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
        '上，要的是账号的 AccessKey ID / Secret Access Key（',
        h('b', null, '不是'),
        '方舟推理用的 ark- 开头的 Key，那把在网关会被直接拒绝），'
        + '请到火山引擎控制台「访问控制 → 访问密钥」创建，并配成 VOLC_ACCESS_KEY_ID 与 VOLC_SECRET_ACCESS_KEY。')),
  )
}

/** 模型分布：环图 + 条形占比（按当前时间窗口）。 */
function ModelBreakdown(props) {
  const { models, rangeByModel, rangeTotals } = props
  const rows = models.map((model, index) => {
    const usage = rangeByModel[model.model] ?? { local: 0 }
    const share = rangeTotals.local > 0 ? (Number(usage.local ?? 0) / rangeTotals.local) * 100 : 0
    return {
      key: model.model,
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
        `共 ${models.length} 个模型 · 用量最多：${models[0]?.label ?? '—'}`)))
}

/**
 * 费用明细表：逐模型列出用量与金额，并在表下给出单价来源。
 *
 * 两种口径要分开表达，否则会误导：
 *   - **分时**（DeepSeek）逐模型列出高峰 / 空闲 token 与「空闲 / 高峰」双档单价；
 *   - **不分时**（智谱 GLM 等）高峰与空闲同价，因此**只显示一列 token**、
 *     单价也只写一个值——硬摆一对相同的「空闲 / 高峰」数字纯属噪音。
 */
function CostTable(props) {
  const { models, rangeByModel, pricing, rangeCost, split, rangeLabel } = props
  const rows = models
    .map((model) => {
      const usage = rangeByModel[model.model]
      if (usage === undefined) return null
      const rates = ratesFor(pricing, model.model)
      return {
        model: model.model,
        label: model.label,
        rates,
        // 不分时的模型 peak 与 idle 相同；按 peak 判定即可
        flat: Number(rates.cacheMiss?.peak ?? 0) === Number(rates.cacheMiss?.idle ?? 0)
          && Number(rates.output?.peak ?? 0) === Number(rates.output?.idle ?? 0),
        // 宿主标注的可信度：兜底价要显式说明，别让猜的数字看起来像官方价
        priced: model.priced !== false,
        tiered: model.tiered === true,
        vendor: model.vendor ?? '',
        cost: priceByModel({ [model.model]: usage }, pricing),
        peak: peakTokensOf(usage),
        idle: idleTokensOf(usage),
        total: Number(usage.local ?? 0),
      }
    })
    .filter(Boolean)

  if (rows.length === 0) return h('p', { className: 'px-muted' }, '当前时间窗口内没有模型调用。')

  const anyFlat = rows.some((row) => row.flat)
  const anyTiered = rows.some((row) => row.tiered)
  const anyUnpriced = rows.some((row) => !row.priced)

  return h('div', null,
    h('div', { className: 'px-table-wrap' },
      h('table', { className: 'px-table' },
        h('thead', null,
          h('tr', null,
            h('th', null, '模型'),
            h('th', null, anyFlat ? 'Token' : '高峰 token'),
            anyFlat ? null : h('th', null, '空闲 token'),
            h('th', null, `${rangeLabel}金额`))),
        h('tbody', null,
          rows.map((row) =>
            h('tr', { key: row.model },
              h('td', null,
                h('b', null, row.label),
                h('span', { className: 'px-muted px-mono' }, ` ${row.model}`),
                row.priced ? null : h('span', { className: 'px-badge' }, '估算价'),
                row.tiered ? h('span', { className: 'px-badge' }, '按最低档') : null),
              h('td', null, formatTokens(row.flat ? row.total : row.peak)),
              row.flat ? null : h('td', null, formatTokens(row.idle)),
              h('td', null, formatCny(row.cost.standard)))),
          h('tr', { className: 'px-row-total' },
            h('td', null, '合计'),
            h('td', null, formatTokens(anyFlat ? split.peak + split.idle : split.peak)),
            anyFlat ? null : h('td', null, formatTokens(split.idle)),
            h('td', null, formatCny(rangeCost.standard)))))),
    h('div', { className: 'px-rate-list' },
      rows.map((row, index) =>
        h('div', { key: `rate-${row.model}`, className: 'px-rate' },
          h('i', { className: `px-rate-swatch ${toneFill(TONES[index % TONES.length])}` }),
          h('b', null, row.label),
          h('span', null, row.flat
            // 不分时：只写一个价，不要摆一对相同的数字
            ? `缓存命中 ¥${row.rates.cacheHit.peak} · 未命中 ¥${row.rates.cacheMiss.peak} · 输出 ¥${row.rates.output.peak}`
            : `缓存命中 ¥${row.rates.cacheHit.idle} / ¥${row.rates.cacheHit.peak}`),
          row.flat ? null : h('span', null, `未命中 ¥${row.rates.cacheMiss.idle} / ¥${row.rates.cacheMiss.peak}`),
          row.flat ? null : h('span', null, `输出 ¥${row.rates.output.idle} / ¥${row.rates.output.peak}`),
          row.vendor === '' ? null : h('span', { className: 'px-muted' }, row.vendor)))),
    h('p', { className: 'px-muted px-note' },
      anyFlat
        ? `单价单位元 / 百万 token；标「不分时」的模型高峰与空闲同价，故只列一个价与一列 token。`
        : `单价写作「空闲 / 高峰」，单位元 / 百万 token。`,
      `${rangeLabel}内若全部落在空闲时段可省 ${formatCny(rangeCost.saved)}。`,
      anyTiered ? '标「按最低档」的模型官方按输入长度分档定价，这里只按最低档估算。' : '',
      anyUnpriced ? '标「估算价」的模型不在价目表里，暂按 Flash 单价估算，仅供参考。' : ''))
}

/** 会话清单表。 */
function SessionTable(props) {
  const { sessions, timezone } = props
  if (sessions.length === 0) return h('p', { className: 'px-muted' }, '还没有会话记录。')
  return h('div', { className: 'px-table-wrap' },
    h('table', { className: 'px-table' },
      h('thead', null,
        h('tr', null,
          h('th', null, '会话'),
          h('th', null, '工作区'),
          h('th', null, '模型'),
          h('th', null, '轮次'),
          h('th', null, 'Token'),
          h('th', null, '开始时间'))),
      h('tbody', null,
        sessions.slice(0, 40).map((session) =>
          h('tr', { key: session.id },
            h('td', { className: 'px-mono', title: session.id }, `${session.id.slice(8, 16)}…`),
            h('td', null,
              session.workspace,
              session.live ? h('span', { className: 'px-badge ok' }, '进行中') : null),
            h('td', null, session.models.join(', ') || '—'),
            h('td', null, String(session.turns)),
            h('td', null, formatTokens(session.totals.local)),
            h('td', null, formatDateTime(session.createdAt, timezone)))))))
}
