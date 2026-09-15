/**
 * dsh-pixel-dashboard 的浏览器半边：
 * 1) 装载视觉系统样式表；
 * 2) 注册「奶油·昼 / 暮色·夜」两套主题到外观设置；
 * 3) 在侧栏面板列表与主区注册用量看板。
 *
 * 所有副作用都挂在插件 fiber 上（ctx.effect），停止插件即完整回滚。
 * @module dsh-pixel-dashboard/client/entry
 */

import React from 'react'
import { createPortal } from 'react-dom'
import { Dashboard } from './dashboard.js'
import { installNotifier, notifyStore } from './Notifier.js'
import { PeriodDot, panelEntryLayout, periodTitle, usePeriodPhase } from './period.js'
import { COST_ENTRY_ID, COST_ENTRY_ORDER, SessionCost } from './SessionCost.js'
import { PALETTE_OVERRIDES, PIXEL_THEMES, STYLES } from './theme.js'

const { createElement: h, useEffect, useRef, useState } = React

/** 插件标识，同时用作样式标签与主题来源名。 */
const PACKAGE_ID = 'dsh-pixel-dashboard'

/** 侧栏面板与主区共用同一个 id：侧栏按钮靠它选中主区面板。 */
const PANEL_ID = 'pixel-usage'

/** 令牌覆盖层的来源标识，一个 source 只保留一层。 */
const PALETTE_SOURCE = `${PACKAGE_ID}/palette`

/**
 * 认「产品那一行」的宽度下限（px）。
 *
 * 只有 ≥ 这个宽度的祖先才可能是 panelRow。图标槽本身只有十几像素，
 * 因此这条判据能把「图标槽」与「整行」区分开——它是**兜底**判据，
 * 主判据是「不是我们自己渲染的按钮」（见 {@link usePanelRow}）。
 *
 * 取 120：侧栏展开时那一行有 200px 以上，收起成图标条时只有 36px 左右
 * （那时本来也不显示倒计时），中间没有别的可能值。
 */
const ROW_MIN_WIDTH = 120

/** 挂上全部样式表，返回卸载函数。 */
function installStyles() {
  const tags = []
  for (const [name, css] of STYLES) {
    const tag = document.createElement('style')
    tag.dataset.plugin = PACKAGE_ID
    tag.dataset.pluginCss = `${PACKAGE_ID}/${name}`
    tag.textContent = css
    document.head.appendChild(tag)
    tags.push(tag)
  }
  return () => {
    for (const tag of tags) tag.remove()
  }
}

/**
 * 侧栏面板图标：像素柱状图，与看板顶栏标记同一套形状语言。
 * @param {object} props - size 与 active 由侧栏面板行提供。
 * @returns {object} React 元素。
 */
function PanelIcon(props) {
  const size = Number(props.size ?? 18)
  const bars = [
    { x: 3.6, y: 11.4 },
    { x: 8.2, y: 7.4 },
    { x: 12.8, y: 3.4 },
  ]
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 20 20',
      'aria-hidden': 'true',
      style: { display: 'block' },
    },
    bars.map((bar, index) =>
      h('rect', {
        key: index,
        x: bar.x,
        y: bar.y,
        width: 3.6,
        height: 15.4 - bar.y,
        rx: 1.1,
        fill: 'currentColor',
        opacity: props.active ? 0.95 : 0.5 + index * 0.12,
      })),
  )
}

/**
 * 找到面板行里那个**产品的 row 元素**，把时段倒计时 portal 进去。
 *
 * ## 为什么必须这样做（而不是在插槽内部定位）
 *
 * 产品那一行是它自己渲染的 `[图标槽][标题]`，而我们的插槽**只占图标槽**。
 * 图标槽是内容宽度（十几像素），于是：
 *   - 我们那层 `width: 100%` 的按钮量到的只有图标那么宽；
 *   - 任何 `right: Npx` 都只在图标那一小块里生效，文字怎么也离不开图标。
 *
 * 所以改成：把倒计时 portal 进产品的 row 元素，让它成为**标题的兄弟节点**，
 * 自然落在「用量看板」右边；行宽也从这里量，档位判定才准。
 *
 * ## 认 row 的判据：**必须排除我们自己那个按钮**
 *
 * 这里踩过一次坑，值得写清楚。我们自己渲染了一个 `<button>`（那颗图标所在的
 * 可点区域），而它**套在产品的 row 按钮里面**。于是 `node.closest('button')`
 * 命中的是**我们自己**的按钮，而不是产品那一行：量到的宽度只有十几像素 →
 * 档位判定成 `none` → **倒计时什么都不显示**，且完全不报错。
 *
 * 因此判据是「往上走，取第一个 `<button>` 祖先，但跳过我们自己那个」。
 * 产品的面板行本身就是一个 `<button>`（ui-sidebar 的 `PanelRow`），
 * 所以这条判据是**结构事实**，与布局、动画、首帧宽度都无关。
 *
 * 产品换了实现（那一行不再是 button）时退回按宽度认行——那只是兜底，
 * 因为宽度在首帧 / 收起动画途中可能是 0。
 * @param {object} ref - 指向我们自己根节点的 ref。
 * @param {object} ownRef - 指向我们自己渲染的那个 `<button>` 的 ref。
 * @returns {{host:Element|null,rowWidth:number}} 落点与整行宽度。
 */
function usePanelRow(ref, ownRef) {
  const [host, setHost] = useState(null)
  const [rowWidth, setRowWidth] = useState(0)

  useEffect(() => {
    const node = ref.current
    if (node === null || node === undefined) return undefined

    /**
     * 认 row：第一个不是我们自己的 `<button>` 祖先。
     * @returns {Element|null} row 元素。
     */
    const findRow = () => {
      const own = ownRef?.current ?? null
      let candidate = node.parentElement ?? null
      let wideEnough = null
      for (let depth = 0; candidate !== null && depth < 8; depth += 1) {
        // 主判据：跳过我们自己那个按钮，取产品那一行
        if (candidate !== own && String(candidate.tagName).toUpperCase() === 'BUTTON') {
          return candidate
        }
        // 兜底：产品那一行不再是 button 时，记下第一层够宽的祖先
        if (wideEnough === null) {
          const width = Number(candidate.getBoundingClientRect?.().width ?? 0)
          if (width >= ROW_MIN_WIDTH) wideEnough = candidate
        }
        candidate = candidate.parentElement ?? null
      }
      return wideEnough
    }

    const sync = () => {
      const row = findRow()
      setHost((prev) => (prev === row ? prev : row))
      const width = Number(row?.getBoundingClientRect?.().width ?? 0)
      setRowWidth((prev) => (Math.abs(prev - width) < 0.5 ? prev : width))
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(sync)
    // 观察我们自己的节点即可：侧栏收放时它的祖先宽度变化会带动它的尺寸变化。
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [ref, ownRef])

  return { host, rowWidth }
}

/**
 * 侧栏面板行的**纯展示层**：柱状图图标，以及独立的时段指示环。
 *
 * 拆出来是为了能被渲染闸门直接断言。两部分刻意分开渲染：
 *   - 图标留在插槽里（产品给我们的是图标槽）；
 *   - 环由容器 portal 到产品的 **row 元素**里，因此它是标题的**兄弟节点**，
 *     排在「用量看板」四个字的右边。
 *
 * 排版规则见 {@link panelEntryLayout}：宽行显示「环 + 倒计时」，中等宽度只显示环，
 * 窄行（侧栏收起）把环叠回图标角上。
 *
 * 闸门只渲染图标这一部分（`inline`/`corner` 的差异在 {@link PeriodDot} 里），
 * 因此这里保持无副作用，环的落点由容器决定。
 * @param {object} props - size / active。
 * @returns {object} React 元素。
 */
export function PanelEntryView(props) {
  const { size, active } = props
  return h(PanelIcon, { size, active })
}

/**
 * 侧栏按钮：悬停微亮、按下微缩，点击切到看板面板，再点一次回到会话。
 *
 * 时段指示环通过 portal 挂到产品的 row 元素上，排在按钮**之后**，因此显示在
 * 「用量看板」四个字的右边。这样做是因为产品只把图标槽给了我们，靠插槽内部
 * 的定位永远到不了标题右边（详见 {@link usePanelRow}）。
 * @param {object} ctx - 插件上下文，用于取 layout 服务。
 * @returns {Function} 组件。
 */
function panelEntry(ctx) {
  return function PanelEntry(props) {
    const active = props.active === true
    const [hover, setHover] = useState(false)
    const [press, setPress] = useState(false)
    const rootRef = useRef(null)
    // 我们自己渲染的那个按钮：认 row 时必须把它排除掉（见 usePanelRow）
    const ownRef = useRef(null)
    // 相位在这里取：一个面板行只有一个，且按钮在应用生命周期内常驻，
    // 因此轮询不会随会话切换反复重建。
    const phase = usePeriodPhase()
    const { host, rowWidth } = usePanelRow(rootRef, ownRef)
    const layout = panelEntryLayout({ rowWidth })
    const onClick = () => {
      const layoutService = ctx.get('layout')
      if (layoutService === undefined) return
      try {
        layoutService.selectPanel(active ? null : PANEL_ID)
      } catch {
        // 主区面板尚未注册完成时忽略这一次点击，下次渲染即可用。
      }
    }

    // 倒计时文字：portal 进产品 row；拿不到 row（服务端渲染 / 结构变了）时退回
    // 渲染在插槽内——位置不如理想，但仍然看得见，不会凭空消失。
    const caption = h(PeriodDot, {
      phase,
      placement: layout.placement,
    })
    const portaled = host !== null && typeof createPortal === 'function'
      ? createPortal(caption, host)
      : caption

    return h(
      React.Fragment,
      null,
      h(
        'button',
        {
          // 我们自己那颗按钮的 ref：认产品 row 时必须跳过它（见 usePanelRow）
          ref: ownRef,
          type: 'button',
          // 时段与倒计时只走 title（悬停提示）：aria-label 每秒都变会让读屏软件
          // 反复播报同一颗按钮，而这里真正要表达的只是「用量看板」这一个可操作目标。
          title: periodTitle(phase),
          'aria-label': '用量看板',
          'aria-pressed': active,
          onClick,
          onMouseEnter: () => { setHover(true) },
          onMouseLeave: () => { setHover(false); setPress(false) },
          onMouseDown: () => { setPress(true) },
          onMouseUp: () => { setPress(false) },
          style: {
            display: 'grid',
            placeItems: 'center',
            position: 'relative',
            width: '100%',
            height: 30,
            padding: 0,
            color: 'inherit',
            cursor: 'pointer',
            background: active || hover ? 'var(--px-surface-2)' : 'transparent',
            border: `1px solid ${active ? 'var(--px-line-2)' : 'transparent'}`,
            borderRadius: '9px',
            boxShadow: active ? 'var(--px-elev-1)' : 'none',
            transform: press ? 'scale(0.94)' : 'none',
            transition: 'background-color var(--px-dur) var(--px-ease), border-color var(--px-dur) var(--px-ease), box-shadow var(--px-dur) var(--px-ease), transform var(--px-dur-fast) var(--px-ease)',
          },
        },
        // portal 落点的锚点：图标槽里的内容。
        h('span', { ref: rootRef, className: 'px-panel-entry' },
          h(PanelEntryView, { size: props.size, active })),
        // 拿不到 row 时倒计时留在这里，否则由上面的 portal 渲染。
        portaled === caption ? caption : null,
      ),
      portaled === caption ? null : portaled,
    )
  }
}

/**
 * 浏览器半边插件体。
 * @param {object} ctx - 客户端 Cordis 上下文。
 * @returns {void}
 */
export function apply(ctx) {
  ctx.effect(() => installStyles(), 'pixel-dashboard: 样式表')

  // 通知运行时**尽早**启动，且不依赖任何槽位：提醒必须在用户没打开看板时也在工作，
  // 而下面的 `slots` 缺失（旧宿主、或槽位服务尚未就绪）会让 apply 直接 return。
  // 这正是「装了却收不到提醒」最容易发生的形态，所以把它放在 return 之前。
  //
  // 面板与它之间通过 notifyStore() 这个模块级单例共享快照，不经过 Cordis 服务：
  // 多提供一个服务意味着多一个「服务没就绪」的失败面，而这里两者本就在同一个
  // 包内、同一个 fiber 上，没有解耦的必要。
  installNotifier(ctx, notifyStore())

  const theme = ctx.get('theme')

  // 默认就把配色换上：叠一层令牌覆盖在当前主题之上（不改注册表、不动用户偏好）。
  // 这是关键——注册成可选主题需要用户自己去“设置 → 外观”切换，绝大多数人不会去，
  // 结果就是插件装了但配色没生效。
  if (theme !== undefined) {
    applyPalette(ctx, theme)

    // 可选主题仍然注册：想要固定深/浅色的用户可以在外观设置里显式选它。
    ctx.effect(() => {
      const disposers = [
        theme.register({
          id: PIXEL_THEMES.day.id,
          colorScheme: PIXEL_THEMES.day.colorScheme,
          tokens: PIXEL_THEMES.day.tokens,
        }),
        theme.register({
          id: PIXEL_THEMES.night.id,
          colorScheme: PIXEL_THEMES.night.colorScheme,
          tokens: PIXEL_THEMES.night.tokens,
        }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'pixel-dashboard: 可选主题')
  }

  const slots = ctx.get('slots')
  if (slots === undefined) return

  slots.inject('main', () => slots.register(
    { name: 'main', key: PANEL_ID },
    () => h(Dashboard),
  ))

  slots.inject('sidebar.panellist', () => slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: '用量看板' },
    panelEntry(ctx),
  ))

  // 输入框下方的本次会话费用条：session 作用域，跟随当前会话显示金额。
  slots.inject('conversation.composer.dock', () => slots.register(
    { name: 'conversation.composer.dock', id: COST_ENTRY_ID, order: COST_ENTRY_ORDER },
    SessionCost,
  ))
}

/**
 * 默认就把配色换上：叠一层令牌覆盖在当前主题之上（不改注册表、不动用户偏好）。
 *
 * 这一层同时带明暗两套取值，主题服务按当前生效方案挑选，因此明暗切换
 * 自身完成——不要再监听 theme/change 重下：overrideTokens 会同步 emit
 * 同一个事件，监听器里再调用它就变成无限递归（栈溢出）。
 * @param {object} ctx - 客户端 Cordis 上下文。
 * @param {object} theme - 客户端 theme 服务。
 * @returns {void}
 */
function applyPalette(ctx, theme) {
  ctx.effect(
    () => theme.overrideTokens(PALETTE_SOURCE, PALETTE_OVERRIDES),
    'pixel-dashboard: 默认配色',
  )
}
