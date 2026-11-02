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
 *
 * ## 详情从 `title` 改成**可点击展开的面板**
 *
 * 用户报过：「对话框下方的计价详情……现在直接是一个裸文本浮窗，不好看」。
 * 那几个字的系统浮窗有四个问题：字号与配色听操作系统的、换行靠浏览器自己决定、
 * 鼠标一移开就消失（读不完）、而且**没法点击**——触屏与键盘用户根本打不开。
 *
 * 现在的做法是照官方统计胶囊的既有交互（`StatsPills` 的 `useStatDialog`）：
 * 徽标变成一枚 `<button aria-expanded>`，点开后把面板 portal 到 `document.body`、
 * 用 `position: fixed` 贴在徽标**上方**并夹进视口。面板内容由 `costDetail.js`
 * 折成纯数据（见那个模块的说明），这里只负责摆。
 *
 * 四条不能省的交互细节，都是踩过或必然踩到的：
 *   - **容器仍然不许 `width:100%`**：面板是 portal 出去的固定定位元素，宽度
 *     按内容取（上限 360px），与 dock 那一行无关；dock 里那一枚仍是 inline-flex。
 *   - **点外面要关、Esc 要关、滚动要关**。滚动要关是因为面板用 fixed 定位，
 *     它不会跟着输入框动；不关就会看见一个悬在空中的面板。
 *   - **`pointerdown` 而不是 `click`**：`click` 要等鼠标抬起，用户按住拖动时
 *     面板会一直开着并选中背景文字。
 *   - **收起时面板内容不渲染**。`renderToStaticMarkup` 不执行 effect，因此闸门看到的
 *     就是「默认收起」这一态——与真实首屏一致。
 * @module dsh-pixel-dashboard/client/SessionCost
 */

import React from 'react'
import { createPortal } from 'react-dom'
import { resolveAccount } from './account.js'
import { fetchBalance } from './balance.js'
import { costDetailModel } from './costDetail.js'
import { formatCny, formatTokens } from './format.js'
import { fetchPlans } from './plans.js'
import { useSelectedPlan } from './planView.js'
import { findTeamOf, teamSummaryOf } from './team.js'
import { fetchDashboard } from './usage.js'

const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

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

/** 面板与徽标之间纵向留出的距离（面板在徽标**上方**）。 */
const PANEL_GAP = 8

/** 面板与视口边缘之间必须留下的距离（与官方 stat-dialog 的 12px 一致）。 */
const PANEL_MARGIN = 12

/** 面板宽度上限：比官方 stat-dialog（440px）窄一些，它只有文字与条。 */
const PANEL_MAX_WIDTH = 360

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
 * 团队那一枚徽标的完整文案：标签、数值、角标与悬停说明。
 *
 * 抽成纯函数是为了让渲染闸门**直接断言字符串**：悬停内容在静态渲染里永远看不到
 * （`title` 只是属性），而「按成员分列」正是这个功能唯一的信息出口。
 * 面板起来之后 `title` 仍保留同一句话作为**降级通道**（无 JS 环境、以及悬停速览
 * 时不必点开也能看到），因此两者必须说同一件事。
 *
 * ## 两个取值刻意分开
 *
 * | 字段 | 用来回答 |
 * |---|---|
 * | `value` | 这个团队一共花了多少 |
 * | `tag` | 这个数字是「团队」而不是「本次会话」——不标的话两个 ¥ 并排没人分得清 |
 *
 * **不再产出 `title`。** 早先这里拼了一大段多行文本喂给 `title` 属性，落地成一个
 * 浏览器原生的裸浮窗（用户报的「不好看」正是它）。详情现在由 `costDetailModel()`
 * 折成结构化的面板内容，成员明细在面板的「成员」一节里——字符串版在这里就是
 * 第二份口径，删掉它而不是留着当备份：两处文本一定会漂移。
 * @param {object|undefined} summary - {@link teamSummaryOf} 的结果。
 * @returns {{value:string,tag:string,memberCount:number}|undefined} 文案。
 */
export function teamPillOf(summary) {
  if (summary === undefined || summary === null) return undefined
  return {
    value: formatCny(summary.cost),
    // 角标写「团队」而不是「N 人」：这一枚的价值在于「这是团队口径」，
    // 人数在详情面板里已经写清楚了，挤在 10px 的角标里反而读不出来。
    tag: '团队',
    memberCount: summary.memberCount,
  }
}

/**
 * 悬浮面板的定位：贴在锚点**上方**、水平居中，并夹进视口。
 *
 * ## 为什么不是「算一次就定」
 *
 * 官方那套 `useAnchoredPosition` 是**量两轮**：先把面板按隐藏渲染（`visibility:
 * hidden` 但仍有布局），量出它真实的高度，第二帧才把位置定下来。这里同样这么做，
 * 因为只看锚点矩形是不够的——我们不知道面板会长多高（团队模式有 N 个成员，
 * 窄屏上标题还会折行），而「高度未知就猜一个 bottom」必然在某一类会话上错位。
 *
 * ## 三条规则
 *
 *   - **优先向上弹**：锚点在输入框下方，往下弹会盖住输入框本身；
 *   - **上面放不下就翻到下面**：窗口很矮时（笔记本横向分屏）面板比上方空间还高，
 *     硬贴上去会把标题推出视口顶部；
 *   - **夹进视口**：水平方向居中，遇到左右边缘就贴边；宽度也夹到
 *     `100vw - 2*margin`，否则窄屏上右半边会被裁掉。
 *
 * 返回值里的 `placed` 是给闸门看的：它说明「位置真的算过」，而不是停在测量态。
 * @param {object} input - open / anchorRef / panelRef。
 * @returns {{style:object|undefined, placed:boolean}} 内联样式与是否已定位。
 */
function useDetailPlacement(input) {
  const { open, anchorRef, panelRef } = input
  const [placement, setPlacement] = useState({ style: undefined, placed: false })

  // 收起时把测量结果一起丢掉：下次点开必须重新量（会话换了、金额位数变了、
  // 窗口被拖过——沿用上一轮的位置必然错）。
  useEffect(() => {
    if (open !== true) setPlacement({ style: undefined, placed: false })
  }, [open])

  // useLayoutEffect 而不是 useEffect：后者在**绘制之后**才跑，用户会看到面板
  // 先在错误位置闪一下再跳过去。这个仓库的打包器按普通函数名转译，两者都能用。
  useEffect(() => {
    if (open !== true) return undefined
    const anchor = anchorRef?.current
    const panel = panelRef?.current
    if (anchor === null || anchor === undefined) return undefined
    if (typeof document === 'undefined' || typeof window === 'undefined') return undefined

    /**
     * 量一次并排布。锚点或面板还没挂上（首帧）时安静返回，下一帧由 effect
     * 依赖里的 open 变化不会再来，因此这里同时监听一次 rAF 兜底。
     */
    const place = () => {
      const node = anchorRef?.current
      if (node === null || node === undefined) return
      if (typeof node.getBoundingClientRect !== 'function') return
      const rect = node.getBoundingClientRect()
      const panelHeight = Number(panelRef?.current?.offsetHeight ?? 0)
      const viewportWidth = Number(window.innerWidth ?? 0) || 0
      const viewportHeight = Number(window.innerHeight ?? 0) || 0

      // 视口宽为 0（jsdom / 尚未布局）时不做相对计算，给一个能断言的居中布局。
      if (viewportWidth <= 0 || viewportHeight <= 0) {
        setPlacement({
          style: { position: 'fixed', left: `${PANEL_MARGIN}px`, top: `${PANEL_MARGIN}px`, width: `min(${PANEL_MAX_WIDTH}px, calc(100vw - ${PANEL_MARGIN * 2}px))` },
          placed: true,
        })
        return
      }

      const width = Math.min(PANEL_MAX_WIDTH, Math.max(0, viewportWidth - PANEL_MARGIN * 2))
      const centerX = rect.width > 0 ? rect.left + rect.width / 2 : viewportWidth / 2
      const left = Math.min(
        Math.max(PANEL_MARGIN, centerX - width / 2),
        Math.max(PANEL_MARGIN, viewportWidth - PANEL_MARGIN - width),
      )

      // 上方空间够就用 bottom 贴住锚点顶部：用 bottom 而不是 top，是因为
      // 面板高度会随后续刷新（金额位数、成员增减）变化，bottom 定位能让它在
      // 高度变化时仍然**贴着**锚点，而 top 定位会让它从锚点往上长到一半卡住。
      const spaceAbove = rect.top - PANEL_GAP - PANEL_MARGIN
      const spaceBelow = viewportHeight - rect.bottom - PANEL_GAP - PANEL_MARGIN
      const fitsAbove = panelHeight <= 0 || panelHeight <= spaceAbove
      if (fitsAbove && rect.top > 0) {
        setPlacement({
          style: { position: 'fixed', left: `${Math.round(left)}px`, bottom: `${Math.round(viewportHeight - rect.top + PANEL_GAP)}px`, width: `${Math.round(width)}px` },
          placed: true,
        })
        return
      }
      // 上面放不下、下面更宽裕：翻到下面（顶边贴住锚点底部）
      if (spaceBelow > spaceAbove) {
        setPlacement({
          style: { position: 'fixed', left: `${Math.round(left)}px`, top: `${Math.round(Math.max(PANEL_MARGIN, rect.bottom + PANEL_GAP))}px`, width: `${Math.round(width)}px` },
          placed: true,
        })
        return
      }
      // 两边都放不下：仍然向上，但贴到视口顶边，保证整块内容可达（可滚动）
      setPlacement({
        style: { position: 'fixed', left: `${Math.round(left)}px`, top: `${PANEL_MARGIN}px`, width: `${Math.round(width)}px` },
        placed: true,
      })
    }

    place()
    // 面板里可能还有一次性布局（字体加载、占比条过渡），再量一次兜住。
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => { place() })
      : undefined
    // 滚动时重新量：输入框那一块是 sticky 的，滚到吸附边界之后锚点的视口坐标
    // 会变，而面板是 fixed 定位、不会自己跟过去。capture 阶段收事件是因为
    // 真正的滚动容器是会话区，它不在 body 的事件冒泡路径上。
    const onScroll = () => { place() }
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      if (raf !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
    }
    // panelRef 是 ref，不会触发重渲染；open 变化才是重新量的时机。
  }, [open, anchorRef, panelRef])

  return placement
}

/**
 * 测量态的内联样式：**隐藏但仍参与布局**，因此 `offsetHeight` 量得到真实高度。
 *
 * 用 `visibility: hidden` 而不是 `display: none`：后者不产生盒子，量出来永远是 0，
 * 于是「上面放不下就翻到下面」这条判断永远得到 0，等于没写。
 * @returns {object} 内联样式。
 */
function measureStyle() {
  return {
    position: 'fixed',
    left: '0px',
    top: '0px',
    visibility: 'hidden',
    width: `min(${PANEL_MAX_WIDTH}px, calc(100vw - ${PANEL_MARGIN * 2}px))`,
  }
}

/**
 * 详情面板本体（**纯展示**）：抬头 + 大号金额 + 各分节 + 脚注。
 *
 * 只有一份数据来源（{@link costDetailModel}），因此面板里一个数字都不算。
 * 每条带 `share` 的行都会画一根占比条，轨道用 `--px-line`（描边色）而不是
 * `--px-surface-2`：面板本身已经是白色「块」，再铺一块米色轨道就变成
 * 「白块里嵌色块」——那正是用户报过的「东一块西一块」。
 * @param {object} props - model（{@link costDetailModel} 的结果）。
 * @returns {object|null} React 元素。
 */
export function CostDetailPanel(props) {
  const { model } = props
  if (model === undefined || model === null || model.empty === true) return null

  return h(
    'div',
    {
      className: `px-detail px-detail-tone-${model.tone}`,
      role: 'dialog',
      'aria-label': `${model.title}计价详情`,
    },
    h(
      'div',
      { className: 'px-detail-head' },
      h('span', { className: 'px-detail-mark' }),
      h('span', { className: 'px-detail-title' }, model.title),
      model.badge === undefined ? null : h('span', { className: 'px-detail-badge' }, model.badge),
      h('span', { className: 'px-detail-headline' }, model.headline),
    ),
    model.sections.map((section, index) => h(
      'section',
      { key: `${section.label}-${index}`, className: 'px-detail-section' },
      h(
        'div',
        { className: 'px-detail-section-head' },
        h('span', { className: 'px-detail-section-label' }, section.label),
        section.total === undefined ? null : h('span', { className: 'px-detail-section-total' }, section.total),
      ),
      h(
        'div',
        { className: 'px-detail-rows' },
        section.rows.map((row, rowIndex) => h(
          'div',
          { key: `${row.label}-${rowIndex}`, className: 'px-detail-row' },
          h('span', { className: 'px-detail-row-label', title: row.hint }, row.label),
          h(
            'span',
            { className: 'px-detail-row-meter' },
            Number.isFinite(row.share)
              ? h(
                'span',
                { className: 'px-detail-meter' },
                h('i', {
                  className: `px-detail-meter-fill px-detail-tone-bg-${row.tone ?? section.tone ?? model.tone}`,
                  style: { width: `${Math.round(Math.max(0, Math.min(1, row.share)) * 100)}%` },
                }),
              )
              : null,
          ),
          h('span', { className: 'px-detail-row-value' }, row.value),
        )),
      ),
    )),
    model.notes.length === 0
      ? null
      : h('div', { className: 'px-detail-notes' }, model.notes.map((note, index) => h('p', { key: index }, note))),
  )
}

/**
 * 一枚徽标：图标点 + 标签 + 数值 + 可选角标。视觉对齐产品的统计胶囊（13px、
 * tertiary 文字、24px 圆角、悬停微微加深），因此并排时不显得是「外来的」。
 *
 * 可点的那一枚渲染成 `<button>`（带 `aria-expanded` / `aria-haspopup`），
 * 不可点的（token 数、余额）仍是 `<span>`——**别让用户去点一个点了没反应的东西**。
 * @param {object} props - tone / label / value / title / warn / tag / onClick / expanded / refOf。
 * @returns {object} React 元素。
 */
function Pill(props) {
  const { tone, label, value, title, warn, tag, onClick, expanded, refOf } = props
  const className = `px-pill${warn === true ? ' px-pill-warn' : ''}${onClick === undefined ? '' : ' px-pill-button'}`
  const children = [
    h('i', { key: 'dot', className: `px-pill-dot${tone === undefined ? '' : ` px-tone-bg-${tone}`}` }),
    label === undefined ? null : h('span', { key: 'label', className: 'px-pill-label' }, label),
    h('b', { key: 'value', className: 'px-pill-value' }, value),
    // 角标：用来点明「这个数字是怎么来的」（如「估算」），只写进 title 是不够的
    // ——悬停提示在用户不主动悬停时等于不存在。
    tag === undefined ? null : h('span', { key: 'tag', className: 'px-pill-tag' }, tag),
    // 可点的那一枚才显示小三角：它是「这里有东西可展开」的唯一可见提示。
    onClick === undefined ? null : h('i', { key: 'caret', className: 'px-pill-caret', 'aria-hidden': 'true' }),
  ]

  if (onClick === undefined) {
    return h('span', { className: className, title }, children)
  }
  return h(
    'button',
    {
      type: 'button',
      className: className,
      title,
      onClick,
      'aria-haspopup': 'dialog',
      'aria-expanded': expanded === true,
      'aria-label': `${label ?? ''} ${value}，展开计价详情`.trim(),
      ref: refOf,
    },
    children,
  )
}

/**
 * 徽标组：本次会话费用（+ 可选 token）、以及**按当前模型来源绑定**的那一份
 * 账户事实（官方余额或某家套餐的最紧窗口）。
 *
 * 纯展示**外加一个可展开的详情面板**：费用那一枚（或团队那一枚）是按钮，
 * 点开后在它的上方弹出 `CostDetailPanel`。
 *
 * ## 两件事刻意分开
 *
 *   - **本次会话消费**永远显示（这正是用户要求的：它是一条与「用谁的钱」无关的
 *     事实），金额按定价表分档折算。宿主给不出时才显示「费用不可用」。
 *   - **账户那一枚**由 {@link resolveAccount} 按 provider 来源挑，只有一个，
 *     不再是余额与套餐并排。挑不出来就不渲染，而不是硬塞一个无关的数字。
 * @param {object} props - cost / tokens / failed / account / showTokens / unpriced / usage / team。
 * @returns {object|null} React 元素。
 */
export function SessionCostPills(props) {
  const { cost, tokens, failed, account, showTokens = true, unpriced, usage, team } = props
  // 详情面板默认收起：真实首屏与静态渲染里都必须是「没有浮层」这一态。
  const [open, setOpen] = useState(false)
  const anchorRef = useRef(null)
  const panelRef = useRef(null)
  // 与 `open` 同步的一份 ref：`toggle` 想读到「当前是开还是关」而不把 open 放进
  // 依赖里（那样每次开合都会重新创建回调，Pill 上的 onClick 也跟着变）。
  const openRef = useRef(false)

  // 什么都没拿到、也不是失败：不渲染空壳。
  // 必须返回 null 而不是空元素：容器没有 gap，空元素会污染产品的间距节奏。
  // 团队口径也算「拿到了东西」：成员都还没跑过请求时合计是 ¥0，那是**已知的 0**，
  // 不是「不知道」——但**空成员列表**不算（见 teamSummaryOf 的说明）。
  if (cost === undefined && failed !== true && account === undefined && team === undefined
    && (tokens === undefined || tokens === 0)) return null

  // 「缺少计算公式」这件事必须说出来：那个模型不在价目表里，金额是**按 Flash
  // 单价估的**，跟看板费用明细里标的「估算价」是同一件事。角标 + 面板脚注两处都写。
  const unpricedList = Array.isArray(unpriced) ? unpriced.filter((name) => name !== '') : []

  const model = costDetailModel({ cost, failed, team, account, usage, unpriced: unpricedList })
  // 开合状态是本组件自己的。**不在 setOpen 的更新函数里做副作用**：
  // React 在 StrictMode 下会把更新函数调用两次，副作用（回调外部、埋点之类）
  // 因此会重复执行；这里先把 next 算出来再提交。
  const toggle = useCallback(() => {
    const next = openRef.current !== true
    openRef.current = next
    setOpen(next)
  }, [])
  const closing = useCallback(() => {
    openRef.current = false
    setOpen(false)
  }, [])

  usePanelDismiss({ open, setOpen: closing, anchorRef, panelRef })
  const placement = useDetailPlacement({ open, anchorRef, panelRef })
  const panel = open === true && typeof createPortal === 'function' && typeof document !== 'undefined'
    ? createPortal(
      h(
        'div',
        {
          ref: panelRef,
          className: 'px-detail-anchor',
          // 还没量到时用测量态（隐藏但占位）。绝不能不给 style：那样面板会以
          // 静态流的方式插进 body 末尾，先在整个页面底部闪一下再跳上来。
          style: placement.placed === true ? placement.style : measureStyle(),
          'data-px-detail-placed': placement.placed === true ? 'true' : 'false',
        },
        h(CostDetailPanel, { model }),
      ),
      document.body,
    )
    : null
  // 没有 createPortal（服务端渲染 / 渲染闸门的替身环境）时**整块不渲染**：
  // 面板是固定定位的浮层，塞回 dock 那一行会把横向行撑开、与官方胶囊抢宽度。

  /**
   * 团队模式：**这一枚取代**「本次会话」那一枚，而不是并排再加一枚。
   *
   * ## 为什么是取代而不是并列
   *
   * dock 那一行是横向 flex，宽度是与官方胶囊抢的。团队合计与本次会话金额
   * 并排会多占一格，而两者的差（teammate 那部分）才是用户想看的——把它写进
   * 详情面板的「成员」一节，既省下宽度，又直接回答了「谁花的」。
   * 因此团队模式下，**本次会话的金额移到面板里**，不丢信息。
   */
  const teamText = teamPillOf(team)
  if (teamText !== undefined) {
    return h(
      React.Fragment,
      null,
      h(Pill, {
        tone: 'purple',
        label: '团队合计',
        value: teamText.value,
        tag: teamText.tag,
        onClick: toggle,
        expanded: open,
        refOf: anchorRef,
      }),
      showTokens && team.tokens !== undefined && team.tokens > 0
        ? h(Pill, { tone: 'blue', value: `${formatTokens(team.tokens)} tokens`, title: `团队合计 ${team.memberCount} 位成员` })
        : null,
      h(AccountPill, { account }),
      panel,
    )
  }

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
      // **刻意不给 `title`。** 这一枚是按钮，详情全部在面板里；再挂一段多行
      // title 就等于同时保留两条信息通道，而悬停那条正是用户嫌丑的原生裸浮窗
      // （而且是**打开的**面板之上再弹一个系统提示，两个东西会打架）。
      // 无障碍的「可展开 + 名字」由 aria-expanded / aria-label 承担。
      onClick: toggle,
      expanded: open,
      refOf: anchorRef,
    }),
    showTokens && tokens !== undefined && tokens > 0
      ? h(Pill, { tone: 'blue', value: `${formatTokens(tokens)} tokens` })
      : null,
    h(AccountPill, { account }),
    panel,
  )
}

/**
 * 面板的收起规则：点面板与徽标之外、按 Esc、改变窗口大小。
 *
 * 三条各防一类「面板挂在半空中」的观感问题：
 *   - **点外面**用 `pointerdown` 而不是 `click`：`click` 要等鼠标抬起，用户按住
 *     拖动时会一直开着，并沿途选中背景文字；
 *   - **Esc** 是无障碍的最低要求，面板带 `role="dialog"` 就必须能 Esc 关掉；
 *   - **窗口改变大小**要关：面板用 fixed 定位、宽度由上一次测量算出，窗口一变
 *     它就落在错误的位置上。换成「关掉」而不是「重算」——重算需要再量一次锚点，
 *     而用户此时多半正在拖窗口，跟着动的浮层比收起更烦人。
 *
 * ## 滚动**不在这里关**，而是重新定位（见 useDetailPlacement）
 *
 * 输入框那一块在会话区里是 sticky 的，而面板贴在它上方：用户滚会话时输入框不动，
 * 面板也不该动；但滚动会改变锚点的视口坐标（sticky 有吸附边界），
 * 所以滚完得重新量一次。为了不每滚一帧都量，这里只**清掉已定位标记**——
 * 下一帧布局稳定后 placement 会重算，而重算期间面板保持原位不闪。
 * @param {object} input - open / setOpen / anchorRef / panelRef。
 * @returns {void}
 */
function usePanelDismiss(input) {
  const { open, setOpen, anchorRef, panelRef } = input
  useEffect(() => {
    if (open !== true) return undefined
    if (typeof document === 'undefined') return undefined

    const onPointerDown = (event) => {
      const target = event?.target
      if (target === null || target === undefined) return
      const insidePanel = typeof panelRef.current?.contains === 'function' && panelRef.current.contains(target)
      const insideAnchor = typeof anchorRef.current?.contains === 'function' && anchorRef.current.contains(target)
      if (!insidePanel && !insideAnchor) setOpen(false)
    }
    const onKeyDown = (event) => { if (event?.key === 'Escape') setOpen(false) }
    const onResize = () => { setOpen(false) }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    if (typeof window !== 'undefined') window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      if (typeof window !== 'undefined') window.removeEventListener('resize', onResize)
    }
  }, [open, setOpen, anchorRef, panelRef])
}

/**
 * 那一枚账户徽标：按来源不同渲染成余额或套餐窗口。
 *
 * 它**不可点击**：账户这一节已经在费用面板里了，再给它一个自己的浮层只会让人
 * 以为点哪个都能展开，而实际上只有费用那一枚有内容。详情写进 `title`。
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
  const { cost, failed, account, tokens, team } = props
  // 用同样的判据决定要不要渲染外壳，避免出现「空的一项」（那会多出一个 gap）
  if (cost === undefined && failed !== true && account === undefined && team === undefined
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
    cost: undefined, failed: false, balance: undefined, plans: undefined, unpriced: [], team: undefined,
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
          /**
           * 团队归属：**用同一次响应**算出，不额外发请求。
           *
           * 找不到团队（单人会话 / 旧宿主没有 `teams[]`）时是 undefined，
           * 于是费用条完全退回改动前的单会话口径——见 team.js 的退化表。
           */
          const team = teamSummaryOf(findTeamOf(data, sessionId), { formatCny, formatTokens })
          // 会话在、但没带 cost：宿主是旧实现。标成失败，不要继续转圈。
          setState((prev) => ({
            ...prev,
            cost: row?.cost,
            failed: row !== undefined && row.cost === undefined,
            team,
            // 这个会话用到的模型里，哪些不在价目表里？金额仍是宿主按 Flash 兜底
            // 单价算的，界面上要标成「估算」——与看板费用明细的口径一致。
            unpriced: unpricedModelsOf(row, data.models),
          }))
        })
        .catch(() => {
          // 取数失败（宿主没起来 / 请求出错）也要明说，不静默停在「折算中」
          if (!cancelled) {
            setState((prev) => ({ ...prev, cost: undefined, failed: true, unpriced: [], team: undefined }))
          }
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
    // 团队口径：当前会话属于某个多成员团队时，这一枚换成「团队合计」，
    // 成员明细进详情面板（见 SessionCostPills 的说明）。
    team: state.team,
    // 面板里的「用量构成」一节要的是分桶数字，不是总数——投影给的就是这份，
    // 原样交下去，免得面板再去发一次请求。
    usage: totals,
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
