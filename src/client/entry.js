/**
 * dsh-pixel-dashboard 的浏览器半边：
 * 1) 装载视觉系统样式表（tokens / dashboard / pricing / accounts / session 五张，
 *    都是 .px-* 局部样式）；
 * 2) 在侧栏面板列表与主区注册用量看板；
 * 3) 在输入框下方注册本次会话费用条，在会话标签页注册「费用」（会话作用域）。
 *
 * **不再注册可选主题、也不再覆盖产品令牌。** 早先这里有「奶油·昼 / 暮色·夜」两套
 * 主题注册与一层 overrideTokens 覆盖，等于替用户改掉整个产品界面的配色；皮肤已按
 * 需求移除，产品原版的深浅色与背景完全交还 DSH。看板自己的配色不依赖它们：
 * 靠 theme.js 的 --px-* 令牌 + .px-* 选择器，深色跟随读 body 上的 data-ds-dark-theme。
 *
 * 所有副作用都挂在插件 fiber 上（ctx.effect），停止插件即完整回滚。
 * @module dsh-pixel-dashboard/client/entry
 */

import React from 'react'
import { createPortal } from 'react-dom'
import { Dashboard } from './dashboard.js'
import { SUBSCRIPTION_VALUE_MESSAGES } from './subscriptionValueLocale.js'
import { installNotifier, notifyStore } from './Notifier.js'
import { PeriodDot, panelEntryLayout, periodTitle, usePeriodPhase } from './period.js'
import { COST_ENTRY_ID, COST_ENTRY_ORDER, SessionCost } from './SessionCost.js'
import { SESSION_VIEW_ID, SessionCostView } from './sessionView.js'
import { STYLES } from './theme.js'

const { createElement: h, useEffect, useRef, useState } = React

/** 插件标识，同时用作样式标签与主题来源名。 */
const PACKAGE_ID = 'dsh-pixel-dashboard'

/** 侧栏面板与主区共用同一个 id：侧栏按钮靠它选中主区面板。 */
const PANEL_ID = 'pixel-usage'

/**
 * 会话标签页「费用」的排序与标签（契约第 4 节钉死）。
 *
 * `conversation.view` 是**会话作用域**的 list 槽位，一次只渲染一个视图，
 * 现有占用者是 chat(0) / trajectory(10) / context(20) / fleet(30) / stats(40)。
 * 取 50 使这一页排在它们**之后**：它是「回头看这笔钱花在哪」的地方，
 * 不该抢在对话视图前面。
 */
const SESSION_VIEW_ORDER = 50

/** 标签文字。用户可见文案不写 Markdown（强调用 <b>，这里不需要）。 */
const SESSION_VIEW_LABEL = '费用'

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
 * 只测量图标所在的最近原生按钮，供倒计时排版与既有文字 portal 使用。
 * 不寻找全局 DOM、不识别/绘制宿主选中态，也不修改宿主属性或样式。
 * 图标现在是普通 span，最近的 button 就是宿主行；菜单复用图标时不插入倒计时。
 */
function usePanelRow(ref) {
  const [host, setHost] = useState(null)
  const [rowWidth, setRowWidth] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (node === null || node === undefined) return undefined
    let row = node.parentElement ?? null
    for (let depth = 0; row !== null && depth < 8; depth += 1) {
      if (String(row.tagName).toUpperCase() === 'BUTTON') break
      row = row.parentElement ?? null
    }
    if (row === null || String(row.tagName).toUpperCase() !== 'BUTTON'
      || String(row.getAttribute?.('role') ?? '').startsWith('menuitem')) return undefined
    setHost(row)
    const sync = () => {
      const width = Number(row.getBoundingClientRect?.().width ?? 0)
      if (Number.isFinite(width)) setRowWidth((previous) => previous === width ? previous : width)
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(sync)
    // 图标尺寸固定，观察图标不能捕获拖动侧栏宽度；观察所在行才会正确降级文案。
    observer.observe(row)
    return () => { observer.disconnect() }
  }, [ref])
  return { host, rowWidth }
}

/**
 * 图标槽的纯展示层，只渲染继承宿主文字颜色的柱状图。
 * 倒计时由 PanelEntry 独立放到行尾；它是被动文字，不创建另一个交互目标。
 * active 只控制图标清晰度，不创建框线、底色、阴影或伪焦点。
 * @param {object} props - size / active。
 * @returns {object} React 元素。
 */
export function PanelEntryView(props) {
  const { size, active } = props
  return h(PanelIcon, { size, active })
}

/**
 * 侧栏图标槽不是另一个按钮。宿主负责点击、aria-current、焦点环与整行选中底色；
 * 本插件只提供继承 currentColor 的图标，以及行尾被动的时段文字。
 * active 直接来自 sidebar.panellist 的 owner props，不从 DOM 猜测状态。
 */
export function PanelEntry(props) {
  const active = props.active === true
  const rootRef = useRef(null)
  const phase = usePeriodPhase()
  const { host, rowWidth } = usePanelRow(rootRef)
  const layout = panelEntryLayout({ rowWidth })
  const caption = h(PeriodDot, { phase, placement: layout.placement })
  return h(React.Fragment, null,
    h('span', {
      ref: rootRef, className: 'px-panel-entry', title: periodTitle(phase),
      'data-active': active ? 'true' : 'false',
    }, h(PanelEntryView, { size: props.size, active })),
    host !== null && typeof createPortal === 'function' ? createPortal(caption, host) : null)
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

  const slots = ctx.get('slots')
  if (slots === undefined) return

  const localeService = ctx.get('locale')
  if (typeof localeService?.register === 'function') {
    ctx.effect(() => localeService.register(PACKAGE_ID, SUBSCRIPTION_VALUE_MESSAGES), 'pixel-dashboard: 套餐价值文案')
  }
  const valueText = localeService?.bind?.(PACKAGE_ID)
  slots.inject('main', () => slots.register(
    { name: 'main', key: PANEL_ID },
    () => h(Dashboard, { localeService, valueText }),
  ))

  slots.inject('sidebar.panellist', () => slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: '用量看板' },
    PanelEntry,
  ))

  // 输入框下方的本次会话费用条：session 作用域，跟随当前会话显示金额。
  slots.inject('conversation.composer.dock', () => slots.register(
    { name: 'conversation.composer.dock', id: COST_ENTRY_ID, order: COST_ENTRY_ORDER },
    SessionCost,
  ))

  // 会话标签页的「费用」：`conversation.view` 是**会话作用域**的 list 槽位，
  // 一次只渲染一个视图（现有 chat / trajectory / context / fleet / stats）。
  // order=50 落在它们之后：这一页是「读数」的地方，不该抢在对话前面。
  // 与费用条同一个 id 是刻意的——它们是同一笔钱的摘要与明细，槽位不同、互不冲突。
  slots.inject('conversation.view', () => slots.register(
    { name: 'conversation.view', id: SESSION_VIEW_ID, order: SESSION_VIEW_ORDER, label: SESSION_VIEW_LABEL },
    SessionCostView,
  ))
}
