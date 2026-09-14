/**
 * 输入框下方的本次会话费用条（含账户余额与套餐额度）。
 *
 * ## 布局（v2.1 起改为并入产品统计行）
 *
 * 产品自己有一条统计行 `StatsPills`（显示「N 轮 · M 步 · 缓存命中 X%」），它注册在
 * `conversation.composer.dock`（order 0），并且会给根元素打上 `data-composer-stats`。
 *
 * 早先本插件另起一行渲染自己的胶囊，结果是**脱离输入框**漂在外面，与产品统计行
 * 各占一行、观感零散（用户截图反馈过）。现在默认把这些徽标 **portal 进产品那个
 * 容器**，于是与「缓存命中」并排在同一行、共用同一套对齐规则。
 *
 * 三条实现要点：
 *   1) **等锚点出现。** React 的挂载顺序不保证：产品统计行可能比我们晚渲染。
 *      因此用 MutationObserver 观察 `body`，锚点一出现就 portal 过去。
 *   2) **产品统计行会整体消失。** 没有 token 活动时 `StatsPills` 返回 null，
 *      `data-composer-stats` 随之不在。此时退回自渲染一行（`.px-cost-row`），
 *      而不是让信息凭空消失。
 *   3) **合并时不再重复 token 数。** 那一行本身已经在显示 token，我们只补费用、
 *      余额、套餐额度；退回自渲染时才把 token 数带上。
 *
 * 数据来源分三条路，各司其职、互不拖垮：
 *   - 会话投影 `tokenUsage` 给出即时可见的 token 总数（本地、零延迟）；
 *   - 宿主数据里该会话的 `cost` 给出**精确**金额（按每条请求发生时段分档计价）；
 *   - 余额与套餐各有自己的开关与缓存。
 * @module dsh-pixel-dashboard/client/SessionCost
 */

import React from 'react'
import { createPortal } from 'react-dom'
import { balanceSummary, fetchBalance } from './balance.js'
import { formatCny, formatTokens } from './format.js'
import { fetchPlans, tightestWindow, windowProgress } from './plans.js'
import { fetchDashboard } from './usage.js'

const { createElement: h, useEffect, useMemo, useState } = React

/** 费用条在下方常驻区的位置。 */
export const COST_ENTRY_ID = 'pixel-cost'

/**
 * 在 `conversation.composer.dock` 里的排序值。
 *
 * 该槽位**升序**渲染，产品统计条在 `order: 0`。用负值把我们的兜底行压在
 * 输入框与产品统计条之间（合并成功后这一行通常不渲染）。
 */
export const COST_ENTRY_ORDER = -10

/**
 * 产品统计行的锚点选择器。
 *
 * `StatsPills` 给根元素打 `data-composer-stats`（产品 CSS 也靠它收紧输入框底边距），
 * 这是**产品自己的公开标记**，不是内部类名，因此比按类名猜测稳。
 */
export const STATS_ANCHOR_SELECTOR = '[data-composer-stats]'

/** 刷新间隔：宿主快照本身有缓存，这里只是保持数值不过时。 */
const REFRESH_MS = 30_000

/**
 * 从投影结果里安全取出总量，兼容取到投影值或整条快照两种形态。
 * @param {object} projection - useProjection 的返回值。
 * @returns {object|undefined} 用量总量。
 */
export function totalsOf(projection) {
  if (projection === null || typeof projection !== 'object') return undefined
  const value = projection.val ?? projection
  const totals = value?.totals ?? value
  if (totals === null || typeof totals !== 'object') return undefined
  return totals
}

/**
 * 由投影总量算出计费 token 总数（缓存命中 + 未命中 + 写入 + 输出）。
 * @param {object|undefined} totals - 投影里的总量。
 * @returns {number|undefined} token 数；拿不到时为 undefined。
 */
export function billedTokens(totals) {
  if (totals === undefined) return undefined
  return Number(totals.uncachedInputTokens ?? 0)
    + Number(totals.outputTokens ?? 0)
    + Number(totals.cacheReadTokens ?? 0)
    + Number(totals.cacheWriteTokens ?? 0)
}

/**
 * 观察产品统计行是否存在。
 *
 * 必须观察 DOM 而不是只查一次：产品统计行与我们由不同的 fiber 挂载，先后不定；
 * 且它会在「没有 token 活动」时整体卸载，之后再回来。
 * @returns {Element|null} 锚点元素，未出现时为 null。
 */
function useStatsAnchor() {
  const [anchor, setAnchor] = useState(null)

  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return undefined
    const find = () => document.querySelector(STATS_ANCHOR_SELECTOR)
    setAnchor(find())

    if (typeof MutationObserver === 'undefined' || document.body === null || document.body === undefined) {
      return undefined
    }
    const observer = new MutationObserver(() => {
      const next = find()
      // 用函数式更新比较，避免每次 DOM 变动都触发一次重渲染
      setAnchor((prev) => (prev === next ? prev : next))
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  return anchor
}

/**
 * 一枚徽标：图标点 + 标签 + 数值。视觉对齐产品的统计胶囊（13px、tertiary 文字、
 * 24px 圆角、悬停微微加深），因此并排时不显得是「外来的」。
 * @param {object} props - tone / label / value / title / warn。
 * @returns {object} React 元素。
 */
function Pill(props) {
  const { tone, label, value, title, warn } = props
  return h(
    'span',
    {
      className: `px-pill${warn === true ? ' px-pill-warn' : ''}`,
      title: title,
    },
    h('i', { className: `px-pill-dot${tone === undefined ? '' : ` px-tone-bg-${tone}`}` }),
    label === undefined ? null : h('span', { className: 'px-pill-label' }, label),
    h('b', { className: 'px-pill-value' }, value),
  )
}

/**
 * 徽标组：本次会话费用（+ 可选 token）、账户余额、最紧的套餐额度。
 *
 * 纯展示，无取数、无副作用；容器决定把它 portal 到产品统计行还是自渲染一行。
 * @param {object} props - cost / tokens / failed / balance / plans / showTokens。
 * @returns {object|null} React 元素。
 */
export function SessionCostPills(props) {
  const { cost, tokens, failed, balance, plans, showTokens = true } = props

  const balanceText = balanceSummary(balance)
  // 套餐只显示**最紧**的那个窗口：用户真正关心「哪个快用完了」，
  // 把 5 小时 / 每周 / 每月都塞进这一行会挤成一团。
  const tightest = tightestWindow(plans)
  const tightPercent = tightest === undefined ? undefined : windowProgress(tightest.window).percent

  // 什么都没拿到、也不是失败：不渲染空壳。
  // 必须返回 null 而不是空元素：容器没有 gap，空元素会污染产品的间距节奏。
  if (cost === undefined && failed !== true && balanceText === undefined && tightest === undefined
    && (tokens === undefined || tokens === 0)) return null

  const detail = cost === undefined
    ? (failed === true ? '宿主未提供该会话的费用数据' : '正在按分档单价折算')
    : `高峰 ${formatCny(cost.peak ?? 0)} · 空闲 ${formatCny(cost.idle ?? 0)}`
  const balanceDetail = balanceText === undefined ? '' : `｜账户余额 ${balanceText}`
  const quotaDetail = tightest === undefined
    ? ''
    : `｜${tightest.provider} ${tightest.window.label}已用 ${tightest.percent.toFixed(1)}%`

  return h(
    React.Fragment,
    null,
    h(Pill, {
      tone: failed === true ? 'red' : 'pink',
      label: '本次会话',
      value: cost === undefined
        ? (failed === true ? '费用不可用' : '折算中…')
        : formatCny(cost.standard),
      warn: failed === true,
      title: `${detail}${balanceDetail}${quotaDetail}｜空闲价 = 高峰价的一半，金额为本地估算`,
    }),
    showTokens && tokens !== undefined && tokens > 0
      ? h(Pill, { tone: 'blue', value: `${formatTokens(tokens)} tokens` })
      : null,
    balanceText === undefined
      ? null
      : h(Pill, {
        tone: 'green',
        label: '余额',
        value: balanceText,
        title: `账户余额来自官方 /user/balance 接口，由本地宿主用 DSH 自己的 API Key 查询；`
          + `Key 不会离开本机${balance?.official === false ? '（当前端点不是官方公网地址）' : ''}`,
      }),
    tightest === undefined
      ? null
      : h(Pill, {
        // 超过 75% 转警戒色，与看板里的阈值保持一致
        tone: tightPercent >= 75 || tightest.window.exceeded === true ? 'red' : 'purple',
        label: tightest.window.label,
        value: `${tightest.percent.toFixed(0)}%`,
        title: `${tightest.provider} · ${tightest.window.label}额度已用 ${tightest.percent.toFixed(1)}%｜来自厂商内部接口，仅供参照`,
      }),
  )
}

/**
 * 兜底的一行（产品统计行不在时使用）。
 *
 * `conversation.composer.dock` 的容器是纵向 flex + `align-items: center` 且**没有 gap**，
 * 所以必须自己撑满宽度、并自带上边距，否则会收缩居中并贴住输入框。
 * @param {object} props - 同 {@link SessionCostPills}。
 * @returns {object|null} React 元素。
 */
export function SessionCostView(props) {
  const pills = h(SessionCostPills, props)
  // 用同样的判据决定要不要渲染外壳，避免出现「空的一行」
  const { cost, failed, balance, plans, tokens } = props
  if (cost === undefined && failed !== true && balanceSummary(balance) === undefined
    && tightestWindow(plans) === undefined && (tokens === undefined || tokens === 0)) return null

  return h('div', { className: 'px-cost-row' }, pills)
}

/**
 * 容器：取该会话的费用、余额与套餐额度，并决定渲染位置。
 * @param {object} props - 插槽提供的标准属性（含 sessionId 与 useProjection）。
 * @returns {object|null} React 元素。
 */
export function SessionCost(props) {
  const sessionId = props.sessionId
  const [state, setState] = useState({ cost: undefined, failed: false, balance: undefined, plans: undefined })
  const anchor = useStatsAnchor()

  useEffect(() => {
    if (sessionId === undefined) return undefined
    let cancelled = false
    const load = (refresh) => {
      // 三条路各取各的：任一坏掉都不该拖垮另外两个。
      fetchDashboard({ refresh })
        .then((data) => {
          if (cancelled) return
          const row = (data.sessions ?? []).find((item) => item.id === sessionId)
          // 会话在、但没带 cost：宿主是旧实现。标成失败，不要继续转圈。
          setState((prev) => ({ ...prev, cost: row?.cost, failed: row !== undefined && row.cost === undefined }))
        })
        .catch(() => {
          // 取数失败（宿主没起来 / 请求出错）也要明说，不静默停在「折算中」
          if (!cancelled) setState((prev) => ({ ...prev, cost: undefined, failed: true }))
        })
      fetchBalance({ refresh })
        .then((payload) => {
          if (!cancelled) setState((prev) => ({ ...prev, balance: payload }))
        })
        .catch(() => {
          if (!cancelled) setState((prev) => ({ ...prev, balance: undefined }))
        })
      fetchPlans({ refresh })
        .then((payload) => {
          if (!cancelled) setState((prev) => ({ ...prev, plans: payload }))
        })
        .catch(() => {
          if (!cancelled) setState((prev) => ({ ...prev, plans: undefined }))
        })
    }
    load(false)
    const handle = setInterval(() => { load(true) }, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [sessionId])

  const usage = props.useProjection?.('tokenUsage')
  const totals = useMemo(() => totalsOf(usage), [usage])

  if (sessionId === undefined) return null

  const pills = h(SessionCostPills, {
    cost: state.cost,
    failed: state.failed,
    balance: state.balance,
    plans: state.plans,
    // 并入产品统计行时不再重复 token 数——那一行本身已经在显示它
    showTokens: anchor === null,
    tokens: billedTokens(totals),
  })

  // 锚点在：并入产品统计行（与「缓存命中」同一行、同一套对齐）
  if (anchor !== null && typeof createPortal === 'function') {
    return createPortal(h('span', { className: 'px-pill-group' }, pills), anchor)
  }
  // 锚点不在（产品统计行未挂载 / 无 token 活动 / 无 DOM）：退回自渲染一行
  return h('div', { className: 'px-cost-row' }, pills)
}
