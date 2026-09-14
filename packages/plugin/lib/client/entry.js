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
import { Dashboard } from './dashboard.js'
import { COST_ENTRY_ID, COST_ENTRY_ORDER, SessionCost } from './SessionCost.js'
import { PALETTE_OVERRIDES, PIXEL_THEMES, STYLES } from './theme.js'

const { createElement: h, useState } = React

/** 插件标识，同时用作样式标签与主题来源名。 */
const PACKAGE_ID = 'dsh-pixel-dashboard'

/** 侧栏面板与主区共用同一个 id：侧栏按钮靠它选中主区面板。 */
const PANEL_ID = 'pixel-usage'

/** 令牌覆盖层的来源标识，一个 source 只保留一层。 */
const PALETTE_SOURCE = `${PACKAGE_ID}/palette`

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
 * 侧栏按钮：悬停微亮、按下微缩，点击切到看板面板，再点一次回到会话。
 * @param {object} ctx - 插件上下文，用于取 layout 服务。
 * @returns {Function} 组件。
 */
function panelEntry(ctx) {
  return function PanelEntry(props) {
    const active = props.active === true
    const [hover, setHover] = useState(false)
    const [press, setPress] = useState(false)
    const onClick = () => {
      const layout = ctx.get('layout')
      if (layout === undefined) return
      try {
        layout.selectPanel(active ? null : PANEL_ID)
      } catch {
        // 主区面板尚未注册完成时忽略这一次点击，下次渲染即可用。
      }
    }
    return h(
      'button',
      {
        type: 'button',
        title: '用量看板',
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
          width: 30,
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
      h(PanelIcon, { size: props.size, active }),
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
