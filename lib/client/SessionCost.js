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
import { resolveAccount } from './account.js'
import { fetchBalance } from './balance.js'
import { formatCny, formatTokens } from './format.js'
import { fetchPlans } from './plans.js'
import { useSelectedPlan } from './planView.js'
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
 * 挑出这个会话用到、但**不在价目表里**的模型。
 *
 * 为什么要它：金额永远是宿主按定价表算出来的，而价目表里没有的模型会走 Flash
 * 兜底单价。看板费用明细会把它们标成「估算价」，费用条那一枚却只给一个数字——
 * 同一笔钱在同一个页面上有两种说法。这里把同一个事实带过来，让两边口径一致。
 *
 * 判据取自宿主 `models[].priced`（它由 `pricingOf()` 的可信度字段派生），
 * 而不是在这里重新猜一遍单价表。
 * @param {object|undefined} row - 宿主返回的该会话行。
 * @param {object[]|undefined} models - 宿主的模型清单（含 `priced`）。
 * @returns {string[]} 不在价目表里的模型名；没有时是空数组。
 */
export function unpricedModelsOf(row, models) {
  const used = Array.isArray(row?.models) ? row.models : []
  if (used.length === 0) return []
  const priced = new Map()
  for (const model of Array.isArray(models) ? models : []) {
    // 条目身份是 `模型@提供商`（见宿主 CAPABILITIES 的 modelProvider）；
    // 旧宿主没有 key，只有 model，两种都认。
    const key = typeof model?.key === 'string' ? model.key : model?.model
    if (typeof key === 'string') priced.set(key, model.priced !== false)
  }
  // 宿主没给这个模型的条目时**不**标估算：那说明我们并不知道，而不是知道它没价。
  return used.filter((name) => priced.get(name) === false)
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
 * 一枚徽标：图标点 + 标签 + 数值 + 可选角标。视觉对齐产品的统计胶囊（13px、
 * tertiary 文字、24px 圆角、悬停微微加深），因此并排时不显得是「外来的」。
 * @param {object} props - tone / label / value / title / warn / tag。
 * @returns {object} React 元素。
 */
function Pill(props) {
  const { tone, label, value, title, warn, tag } = props
  return h(
    'span',
    {
      className: `px-pill${warn === true ? ' px-pill-warn' : ''}`,
      title: title,
    },
    h('i', { className: `px-pill-dot${tone === undefined ? '' : ` px-tone-bg-${tone}`}` }),
    label === undefined ? null : h('span', { className: 'px-pill-label' }, label),
    h('b', { className: 'px-pill-value' }, value),
    // 角标：用来点明「这个数字是怎么来的」（如「估算」），只写进 title 是不够的
    // ——悬停提示在用户不主动悬停时等于不存在。
    tag === undefined ? null : h('span', { className: 'px-pill-tag' }, tag),
  )
}

/**
 * 徽标组：本次会话费用（+ 可选 token）、以及**按当前模型来源绑定**的那一份
 * 账户事实（官方余额或某家套餐的最紧窗口）。
 *
 * 纯展示，无取数、无副作用；容器决定把它 portal 到产品统计行还是自渲染一行。
 *
 * ## 两件事刻意分开
 *
 *   - **本次会话消费**永远显示（这正是用户要求的：它是一条与「用谁的钱」无关的
 *     事实），金额按定价表分档折算。宿主给不出时才显示「费用不可用」。
 *   - **账户那一枚**由 {@link resolveAccount} 按 provider 来源挑，只有一个，
 *     不再是余额与套餐并排。挑不出来就不渲染，而不是硬塞一个无关的数字。
 * @param {object} props - cost / tokens / failed / account / showTokens / unpriced。
 * @returns {object|null} React 元素。
 */
export function SessionCostPills(props) {
  const { cost, tokens, failed, account, showTokens = true, unpriced } = props

  // 什么都没拿到、也不是失败：不渲染空壳。
  // 必须返回 null 而不是空元素：容器没有 gap，空元素会污染产品的间距节奏。
  if (cost === undefined && failed !== true && account === undefined
    && (tokens === undefined || tokens === 0)) return null

  const detail = cost === undefined
    ? (failed === true ? '宿主未提供该会话的费用数据' : '正在按分档单价折算')
    : `高峰 ${formatCny(cost.peak ?? 0)} · 空闲 ${formatCny(cost.idle ?? 0)}`
  const accountDetail = accountDetailOf(account)
  // 「缺少计算公式」这件事必须说出来：那个模型不在价目表里，金额是**按 Flash
  // 单价估的**，跟看板费用明细里标的「估算价」是同一件事。
  const unpricedList = Array.isArray(unpriced) ? unpriced.filter((name) => name !== '') : []
  const unpricedDetail = unpricedList.length === 0
    ? ''
    : `｜注意：${unpricedList.join('、')} 不在价目表里，暂按 Flash 单价估算`

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
      tag: unpricedList.length === 0 ? undefined : '估算',
      title: `${detail}${accountDetail}${unpricedDetail}｜空闲价 = 高峰价的一半，金额为本地估算`,
    }),
    showTokens && tokens !== undefined && tokens > 0
      ? h(Pill, { tone: 'blue', value: `${formatTokens(tokens)} tokens` })
      : null,
    h(AccountPill, { account }),
  )
}

/**
 * 账户事实 → 徽标悬停说明里补充的那一句。
 * @param {object|undefined} account - {@link resolveAccount} 的结果。
 * @returns {string} 形如 `｜账户余额 ¥12.34`；没有时是空串。
 */
function accountDetailOf(account) {
  if (account === undefined) return ''
  if (account.kind === 'balance') return `｜账户余额 ${account.text}`
  if (account.kind === 'plan') return `｜${account.label} ${account.plan.window.label}已用 ${account.plan.percent.toFixed(1)}%`
  if (account.kind === 'unavailable') return `｜${account.label} 不可用`
  return ''
}

/**
 * 那一枚账户徽标：按来源不同渲染成余额或套餐窗口。
 * @param {object} props - account。
 * @returns {object|null} React 元素。
 */
function AccountPill(props) {
  const { account } = props
  if (account === undefined || account === null) return null

  if (account.kind === 'balance') {
    return h(Pill, {
      tone: 'green',
      label: '余额',
      value: account.text,
      title: '账户余额来自官方 /user/balance 接口，由本地宿主用 DSH 自己的 API Key 查询；'
        + `Key 不会离开本机${account.payload?.official === false ? '（当前端点不是官方公网地址）' : ''}`
        + '。当前会话走的是 DeepSeek 官方 API，因此显示它。',
    })
  }

  if (account.kind === 'plan') {
    const { plan } = account
    const percent = plan.percent
    return h(Pill, {
      // 超过 75% 转警戒色，与看板里的阈值保持一致
      tone: percent >= 75 || plan.window.exceeded === true ? 'red' : 'purple',
      label: account.label,
      value: `${percent.toFixed(0)}%`,
      title: `${account.fullLabel ?? account.label} · ${plan.window.label}额度已用 ${percent.toFixed(1)}%`
        + `｜来自厂商内部接口，仅供参照｜当前会话走的是这一家，因此显示它`
        + (account.source === 'selected' ? '（你在看板上手动指定了监看这一家）' : ''),
    })
  }

  if (account.kind === 'unavailable') {
    // 拿不到就说出来。静默不渲染会让人以为是插件坏了。
    return h(Pill, {
      tone: 'red',
      label: account.label,
      value: '不可用',
      warn: true,
      title: `${account.reason ?? '暂时取不到数据'}｜这一枚是按当前模型来源绑定的，切换模型或修好凭据后会自动恢复`,
    })
  }

  return null
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
  const { cost, failed, account, tokens } = props
  // 用同样的判据决定要不要渲染外壳，避免出现「空的一行」
  if (cost === undefined && failed !== true && account === undefined
    && (tokens === undefined || tokens === 0)) return null

  return h('div', { className: 'px-cost-row' }, h(SessionCostPills, props))
}

/**
 * 容器：取该会话的费用、余额与套餐额度，按当前模型来源挑出该显示的那一枚，
 * 并决定渲染位置。
 *
 * 取数三条路各取各的（会话费用 / 余额 / 套餐），任一坏掉都不该拖垮另外两个。
 * 模型来源走的是 DSH 自己的 `modelSelection` 投影，**不额外发请求**。
 * @param {object} props - 插槽提供的标准属性（含 sessionId 与 useProjection）。
 * @returns {object|null} React 元素。
 */
export function SessionCost(props) {
  const sessionId = props.sessionId
  const [state, setState] = useState({
    cost: undefined, failed: false, balance: undefined, plans: undefined, unpriced: [],
  })
  const anchor = useStatsAnchor()
  // 用户在看板上手动指定的「当前监看的套餐」（undefined = 自动）。
  const selectedPlan = useSelectedPlan()

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
          setState((prev) => ({
            ...prev,
            cost: row?.cost,
            failed: row !== undefined && row.cost === undefined,
            // 这个会话用到的模型里，哪些不在价目表里？金额仍是宿主按 Flash 兜底
            // 单价算的，界面上要标成「估算」——与看板费用明细的口径一致。
            unpriced: unpricedModelsOf(row, data.models),
          }))
        })
        .catch(() => {
          // 取数失败（宿主没起来 / 请求出错）也要明说，不静默停在「折算中」
          if (!cancelled) setState((prev) => ({ ...prev, cost: undefined, failed: true, unpriced: [] }))
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
  // 当前会话正在用的模型路由（DSH 逐请求记录的事实）。拿不到时 resolveAccount
  // 会走回落链，而不是随便挑一个账户显示。
  const selection = props.useProjection?.('modelSelection')
  const totals = useMemo(() => totalsOf(usage), [usage])

  const account = useMemo(
    () => resolveAccount({ selection, balance: state.balance, plans: state.plans, selectedPlan }),
    [selection, state.balance, state.plans, selectedPlan],
  )

  if (sessionId === undefined) return null

  const pills = h(SessionCostPills, {
    cost: state.cost,
    failed: state.failed,
    account,
    unpriced: state.unpriced,
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
