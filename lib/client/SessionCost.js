/**
 * 输入框下方的本次会话费用条（含账户余额与套餐额度）。
 *
 * ## 布局：始终落在**官方统计的右边**，且**不另起一整行**
 *
 * `conversation.composer.dock` 是**横向 flex 行**（`InputBar.module.css` 的 `.dock`：
 * `display:flex` + `justify-content:center` + `gap:12px`，自古如此、各版本一致）。
 * 因此槽位里的 `order` 决定**左右**，而不是「离输入框多远」。
 *
 * 官方统计在同一槽位里有**两代契约**，本插件的目标是两代都排在官方数据右边：
 *
 *   1) **旧契约（DSH ≤ 0.2.0-rc.2）**：`StatsPills` 是**一条**登记（`order: 0`），
 *      根元素带 `data-composer-stats`。我们把徽标 **portal 进那个容器**——追加为
 *      最后一个子节点，于是自然排在官方内容之后。桌面端一直是这个观感。
 *   2) **新契约（DSH ≥ 0.2.1-alpha.1）**：官方拆成 `activity`(0) / `usage`(1) 两条
 *      登记，`data-composer-stats` **被移除**，改由每枚胶囊带 `data-composer-stat`。
 *      此时没有可 portal 的容器，我们以**同一槽位的普通一项**渲染、`order` 取一个
 *      明显大于官方胶囊的值（见 {@link COST_ENTRY_ORDER}），照样落在官方右边。
 *
 * 两个必须记住的坑：
 *   - **不要给自己 `width: 100%`。** 这一行是横向 flex，占满整行会与官方胶囊抢宽度，
 *     把「1 轮 · 38 步」「2.1M tok」挤成省略号（用户截图反馈过）。只做 inline-flex，
 *     让每个胶囊各按内容取宽。旧代码里的 `.px-cost-row` 正是这个错误的来源——它基于
 *     「容器是纵向 flex 且没有 gap」这个**错误前提**（那是 `.root`，不是 `.dock`）。
 *   - **官方统计会整体消失。** 没有 token 活动时两代契约都不渲染，此时我们单独居中
 *     一项即可，不需要为它准备另一套外壳。
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
 * 该槽位是**横向 flex 行**（左侧先渲染），所以这个值决定我们排在官方胶囊的
 * **左边还是右边**。两代官方契约的 `order` 分别是：
 *
 *   - 旧契约：`StatsPills` 一条，`order: 0`（我们 portal 进它内部，槽位里只有一个
 *     官方项，取任何值都不影响观感）；
 *   - 新契约：`activity` = 0、`usage` = 1。
 *
 * 取 `2` 使我们在两代契约里都排在官方数据**之后**（即右侧）——这正是用户偏好的
 * 桌面端布局。早先用 `-10` 是为了「贴着输入框」，而那是基于「容器是纵向排列」的
 * 错误前提：横向行里负值等于把插件胶囊排到官方数据**左边**，与官方抢宽度时还会
 * 把官方胶囊挤成省略号。
 *
 * 留出余量（不写 1 而写 2）是为了将来官方再加一枚胶囊时我们仍在其右。
 */
export const COST_ENTRY_ORDER = 2

/**
 * 旧契约的锚点选择器：`StatsPills` 的根元素。
 *
 * 只有 DSH ≤ 0.2.0-rc.2 才有这个标记；0.2.1-alpha.1 起官方把统计拆成两条登记并
 * 移除了它（见模块顶部的两代契约说明）。因此它**命中与否都不会出错**：
 * 命中就 portal 进去（追加为末子节点 = 排在官方内容右边），
 * 不命中就以槽位项渲染、靠 {@link COST_ENTRY_ORDER} 排到右边。
 */
export const STATS_ANCHOR_SELECTOR = '[data-composer-stats]'

/**
 * 新契约里**显示 token 用量**的那枚官方胶囊（DSH ≥ 0.2.1-alpha.1）。
 *
 * 官方把统计拆成 `activity`（轮次 / 步数 / 速度）与 `usage`（token 总量与缓存命中）
 * 两条登记，每枚胶囊的根元素带 `data-composer-stat="<id>"`（`StatsPills.tsx` 的
 * `PlainPill` / `DialogPill`，且写进了官方 README 与 e2e）。
 *
 * **只认 `usage` 那一枚**，不认「任意一枚官方胶囊」：token 数只有 `usage` 在显示。
 * 例如 compact 模式下 `ActivityPill` 可能在场而 `UsagePill` 因为算不出缓存命中率
 * 而不渲染——那时若按「有官方胶囊就算重复」去抑制，token 总量就会在界面上消失。
 * 本插件自己的胶囊不带这个属性，因此不会数到自己。
 */
export const OFFICIAL_USAGE_PILL_SELECTOR = '[data-composer-stat="usage"]'

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
 * 观察官方统计当前的形态（两代契约各探一次），返回可 portal 的锚点，以及
 * 「官方是否已经在显示 token 数」。
 *
 * 必须观察 DOM 而不是只查一次：官方统计与我们由不同的 fiber 挂载，先后不定；
 * 且它会在「没有 token 活动」时整体卸载，之后再回来。
 *
 * 两个返回值各自有用，且**判据不同**（这点容易写错）：
 *   - `anchor`：旧契约（≤ 0.2.0-rc.2）里那个容器。非空就 portal 进去，于是我们的
 *     徽标追加在官方内容**之后**（= 右侧），与桌面端观感一致。
 *   - `showsTokens`：官方**是否正在显示 token 总量**，用来决定要不要省掉我们那枚
 *     重复的 token。两代契约的判据不一样：旧契约的统计条本身就在显示 token；新契约
 *     则要看 `usage` 那一枚在不在（`activity` 只显示轮次/速度，不显示 token）。
 *     因此**不能**简化成「有官方胶囊就算重复」——compact 模式下可能只有 activity 在场。
 * @returns {{anchor: Element|null, showsTokens: boolean}} 官方统计的形态。
 */
function useOfficialStats() {
  const [state, setState] = useState({ anchor: null, showsTokens: false })

  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return undefined
    const read = () => {
      const anchor = document.querySelector(STATS_ANCHOR_SELECTOR)
      // 旧契约：那条统计条自己就在显示 token 数 → 命中锚点即视为重复。
      // 新契约：只有 usage 那枚显示 token（querySelector 对它返回非 null）。
      //
      // querySelector 只被调用一次是刻意的：渲染闸门的替身 document 只提供
      // querySelector（没有 querySelectorAll），所以这里必须只用它。
      const usage = anchor !== null ? anchor : document.querySelector(OFFICIAL_USAGE_PILL_SELECTOR)
      return { anchor, showsTokens: usage !== null }
    }
    setState(read())

    if (typeof MutationObserver === 'undefined' || document.body === null || document.body === undefined) {
      return undefined
    }
    const observer = new MutationObserver(() => {
      const next = read()
      // 逐字段比较，避免每次 DOM 变动都触发一次重渲染
      setState((prev) => (prev.anchor === next.anchor && prev.showsTokens === next.showsTokens ? prev : next))
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  return state
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
      // 与看板「费用明细」同一口径：这是「全走官方 API 要多少钱」的假设，
      // 不是实际账单。不说死「DeepSeek 官方」——价目表里也有智谱 GLM 的行。
      title: `${detail}${accountDetail}${unpricedDetail}｜按各模型官方单价估算`
        + `（即“这些 token 若全部走官方 API 需要花多少钱”）；`
        + `第三方中转与 Coding Plan 是买断制、不按 token 计费，不在此列`,
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
 * 独立呈现形态：把所有徽标包成一个 **inline-flex 组**。
 *
 * 这个外壳和 portal 进去时用的 `.px-pill-group` 是**同一个观感**（inline、按内容
 * 取宽、gap 12px），因为 `conversation.composer.dock` 本来就是横向 flex 行：我们
 * 只是这行里的**一项**，不该占满整行。
 *
 * 早先这里是个 `width: 100%` 的 `.px-cost-row`（还带左右内边距），前提是「容器为
 * 纵向 flex 且没有 gap」——那其实是 `.root` 的样式，不是 `.dock` 的。在横向行里
 * 占满宽度会与官方胶囊抢空间，把「1 轮 · 38 步」「2.1M tok」挤成省略号。
 * @param {object} props - 同 {@link SessionCostPills}。
 * @returns {object|null} React 元素。
 */
export function SessionCostView(props) {
  const { cost, failed, account, tokens } = props
  // 用同样的判据决定要不要渲染外壳，避免出现「空的一项」（那会多出一个 gap）
  if (cost === undefined && failed !== true && account === undefined
    && (tokens === undefined || tokens === 0)) return null

  return h('div', { className: 'px-pill-group' }, h(SessionCostPills, props))
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
  const official = useOfficialStats()
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
    // 官方正在显示 token 总数时不再重复一枚——两代契约里那都是同一个事实。
    // 用 showsTokens 而不是「官方在不在」：新契约的 activity 只显示轮次/速度，
    // 那时 token 总量仍应由我们补上（否则界面上就没有 token 了）。
    showTokens: official.showsTokens !== true,
    tokens: billedTokens(totals),
  })

  // 旧契约（≤ 0.2.0-rc.2）：portal 进官方统计容器，追加为末子节点 = 排在它右边
  if (official.anchor !== null && typeof createPortal === 'function') {
    return createPortal(h('span', { className: 'px-pill-group' }, pills), official.anchor)
  }
  // 新契约（≥ 0.2.1-alpha.1）或官方统计不在场：作为**同一横向行里的一项**渲染。
  // 顺序由 COST_ENTRY_ORDER 决定（大于官方胶囊 → 落在右边），宽度由内容决定
  // （inline-flex），所以既排在官方右边，也不会把官方胶囊挤窄。
  return h('div', { className: 'px-pill-group' }, pills)
}
