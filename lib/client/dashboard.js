/**
 * 用量看板主体：总览指标、时段状态与倒计时、活跃日历、Token 趋势、
 * 模型分布、费用估算与会话清单。只读投影，不修改任何会话状态。
 *
 * 计费口径与官方一致：高峰（**周一至周五、不含中国法定节假日** 9:00–12:00、
 * 14:00–18:00）与空闲时段分别按各自单价计价，空闲价为高峰价的一半；
 * 全部周末与法定节假日全天都按空闲计费（含调休上班的周末）。
 * 历史用量按每条请求实际发生的时段归档，因此费用不是用一个折扣近似出来的。
 * @module dsh-pixel-dashboard/client/dashboard
 */

import React from 'react'
// react-dom 只用来把设置弹层挂到 body 上。**用默认导入取 createPortal，不用命名导入**：
// 打包后走的是 require('react-dom')（没问题），但渲染闸门与 DOM 闸门会把
// lib/client/dashboard.js 当 ESM 直接 import，而 react-dom 在 Node 里是 CommonJS，
// 命名导出会直接抛「Named export 'createPortal' not found」——整个闸门连页面
// 都渲染不出来。默认导入在两种环境下都成立（CJS 互操作给的是 module.exports）。
import ReactDOM from 'react-dom'
import { AccountPanel } from './accountPanel.js'
import { PriceSettingsButton, PriceSettingsView } from './priceSettings.js'
// 「消费 Top 会话」点开时要在原地取这条会话的明细，因此复用会话标签页那条取数口
// （同一个 `/dsh-pixel/session`，同一套错误分类）。不复制一份 fetch：两份迟早漂移。
import { cacheRatio, fetchSession, usageBuckets } from './sessionView.js'
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
  NOTIFY_SOUND_OPTIONS,
  PERMISSION_TEXT,
  playSound,
  soundPlan,
  composeRecentLine,
  permissionOf,
  requestPermission,
  saveNotify,
} from './notify.js'
import {
  credentialRows,
  credentialSummary,
  fetchPlanCredentials,
  fetchPlans,
  formatResetLine,
  partitionProviders,
  providerChoices,
  providerStatus,
  quotaTone,
  removePlanCredentials,
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
  formatDurationMs,
  formatMinuteOfDay,
  formatSpan,
  formatTokens,
  minuteOfDay,
} from './format.js'
import {
  ActivityCalendar,
  BarChart,
  BarList,
  DonutChart,
  TrendChart,
  useCountUp,
} from './graph.js'
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
  toneBg,
} from './usage.js'

const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

/** 趋势窗口选项。 */
const RANGES = [
  { id: '7', label: '7 日', days: 7 },
  { id: '30', label: '30 日', days: 30 },
  { id: '90', label: '90 日', days: 90 },
]

/**
 * 「构成」维度的四段：缓存命中 / 未命中 / 写入 / 输出。
 *
 * **恰好四段，且四段之和等于总量。** 账本里的计费 token 是
 * `cacheHit + cacheMiss + cacheWrite + output`（见宿主 `recordOf` 的 `u`），
 * 思考 token 不计入其中（它是输出的一部分）。早先只画三段（缺写入），
 * 于是堆叠柱的高度与卡片上的「窗口 Token」永远差一截，而那种差
 * 既不报错、也不会被谁发现——用户只会觉得两个数字对不上。
 */
const TYPE_SERIES = [
  { key: 'cacheHit', label: '缓存命中', tone: 'blue' },
  { key: 'cacheMiss', label: '未命中', tone: 'purple' },
  { key: 'cacheWrite', label: '写入', tone: 'yellow' },
  { key: 'output', label: '输出', tone: 'pink' },
]

/**
 * Token 趋势的分组维度选项。
 *
 * `type`（构成）用逐日行上的四段字段画**堆叠柱**，另外两个维度要现场按
 * `byModel` 聚合（见 `dimensionSeries`）画折线。**只显示一个维度**而不是把三个
 * 叠加：三种维度会把同一个 token 数重复计入，叠在一起就得到一个假的总量。
 *
 * 顺序按用户的使用频率排：模型 → 供应商 → 构成，默认「模型」（看板首先要回答
 * 「哪个模型花得最多」）。
 */
const TREND_DIMENSIONS = [
  { id: 'model', label: '模型' },
  { id: 'provider', label: '供应商' },
  { id: 'type', label: '构成' },
]

/**
 * 按模型 / 提供商分组时最多画几条线。
 *
 * 老账本里能出现十几个 `模型@提供商` 条目，全画上去就是一团互相压住的线，
 * 图例也会长到把面板撑开。超出的合成「其他」（见 `dimensionSeries`）。
 */
const TREND_SERIES_LIMIT = 5

/**
 * 消费趋势的两条序列：官方价 / 我的价。
 *
 * **并列而不是叠加**：两根柱子回答的是同一个问题的两个答案（「按官方价多少」
 * 与「按我补的价多少」），叠起来的高度没有意义。默认只画官方价——绝大多数
 * 人没有自定义价目，多一根同高的柱子只会让人以为哪里错了。
 */
const COST_SERIES_OFFICIAL = { key: 'official', label: '官方价', tone: 'pink' }
const COST_SERIES_MINE = { key: 'mine', label: '我的价', tone: 'blue' }

/**
 * 浏览器本地偏好：**统一前缀 `px.pref.`**，全部有默认值。
 *
 * 为什么放 localStorage 而不是宿主：这些是**这台机器上这块屏幕**的显示偏好
 * （看几天、先看哪个维度、展开多少条），跟着浏览器走才合理；写进宿主配置
 * 会让它跨设备同步，反而变成「我在手机上改了一下，桌面端布局也变了」。
 *
 * 读到脏值一律回默认：localStorage 里的东西可能是别的版本写的、可能是 `null`
 * 字符串、也可能是用户手改的。**绝不把脏值传进渲染**——那正是 `NaN` 与
 * 「空图表」的来源。
 */
const PREF_PREFIX = 'px.pref.'
const PREF_DEFAULT = {
  modelMinTokens: 10_000_000,
  modelLimit: 5,
  trendDim: 'model',
  showMyRate: false,
  range: '30',
}

/**
 * 读一条偏好。
 * @param {string} key - 不含前缀的键名。
 * @returns {*} 原始字符串值；读不到（或没有 localStorage）时 undefined。
 */
function readPrefRaw(key) {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return undefined
    const value = localStorage.getItem(`${PREF_PREFIX}${key}`)
    return value === null ? undefined : value
  } catch {
    // 隐私模式 / 被禁用时 localStorage 可能直接抛错，退回默认值即可。
    return undefined
  }
}

/**
 * 写一条偏好。
 * @param {string} key - 不含前缀的键名。
 * @param {*} value - 要写入的值（布尔写成 `1` / `0`）。
 * @returns {void}
 */
function writePref(key, value) {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return
    localStorage.setItem(`${PREF_PREFIX}${key}`, String(value))
  } catch {
    // 写不进去不影响本次会话：内存里的 state 已经生效。
  }
}

/** 非负有限数：脏值回默认。 */
function prefNumber(value, fallback, min = 0) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < min) return fallback
  return number
}

/** 布尔：接受 '1' / '0' / 'true' / 'false'，其余回默认。 */
function prefBool(value, fallback) {
  if (value === undefined) return fallback
  const text = String(value).toLowerCase()
  if (text === '1' || text === 'true') return true
  if (text === '0' || text === 'false') return false
  return fallback
}

/** 枚举：不在候选里就回默认。 */
function prefEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/**
 * 一条偏好 + 它的归一化函数，做成 `useState` 的形态。
 *
 * 归一化在**读与写两侧都做**：写入时挡住调用方传进来的脏值（比如输入框里
 * 正打着的空串），读取时挡住存储里的历史脏值。
 * @param {string} key - 不含前缀的键名。
 * @param {Function} normalize - 归一化函数 `(raw) => value`。
 * @returns {[*, Function]} 当前值与 setter。
 */
function usePref(key, normalize) {
  const [value, setValue] = useState(() => normalize(readPrefRaw(key)))
  const set = useCallback((next) => {
    // 归一化 + 落盘都在**事件处理里**做，不写进 setState 的 updater：
    // updater 可能在渲染期被 React 重复调用（StrictMode / 并发渲染），
    // 在那里写 localStorage 就成了「渲染时有副作用」。
    const shaped = normalize(next)
    writePref(key, shaped)
    setValue(shaped)
  }, [key, normalize])
  return [value, set]
}

/** 把高峰窗口数组渲染成 `9:00–12:00、14:00–18:00`。 */
/**
 * 「法定节假日」那一行的取值：说明节假日全天按空闲计费，以及日历收录到哪一年。
 *
 * 两件事都必须说：**口径**（节假日全天空闲，正是它让国庆期间的周四、周五便宜下来）
 * 与**覆盖范围**（这份日历只收录到某一年）。少了后者，跨到表外年份时界面会继续按
 * 「周一至周五」判断却不说明，用户看到的就是一个悄悄错了的时段——而这类错误不报错、
 * 不崩溃，只是把高峰按空闲计价。
 *
 * 拿不到时返回「—」而不是编一句：旧宿主根本没有这条例外，写「已收录」就是在撒谎。
 * @param {object} data - 看板数据。
 * @returns {string} 形如 `全天按空闲计费 · 已收录 2026`。
 */
function holidayRuleText(data) {
  const years = data?.peakRule?.holidays?.years
  if (!Array.isArray(years) || years.length === 0) return '—'
  const list = [...years].sort((a, b) => Number(a) - Number(b)).join('、')
  return `全天按空闲计费 · 已收录 ${list}`
}

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
  // `tone` 仍然接收但**不再着色**：概览卡是中性卡（见 theme.js 里 .px-stat 的说明），
  // 四张卡用四种颜色是「配色割裂」的直接来源。保留参数是为了不改所有调用点。
  const { label, value, format, foot, delay } = props
  return h(
    'div',
    { className: 'px-stat px-rise', style: { animationDelay: `${delay ?? 0}ms` } },
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
    props.title,
    // 标题右侧的**同排**内容（目前只有「消费趋势」的合计用它）。
    // 放在标题旁边而不是卡片最右侧：那个数字是「这张卡在说多少」，
    // 与右边的控件（切换器 / 开关）不是一类东西，离得越远越难对应。
    props.titleExtra === undefined ? null : h('span', { className: 'px-panel-total' }, props.titleExtra))

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

/**
 * 像素鲸鱼头像（DeepSeek 的品牌形象）。
 *
 * 为什么自己画而不是用官方素材：插件**零依赖、离线可用**，不能去拉远程图片，
 * 也不该把别人的品牌资源打进产物里再分发。这里用 16×16 像素网格画一只蓝鲸：
 * 圆身、上翘尾鳍、一道水柱、一颗白眼。像素风与项目名同族，小尺寸下比矢量插画清楚。
 *
 * 未登录时整体降透明度并转灰：它是**占位头像**，不该看起来像已经登录了某个人。
 * @param {object} props - size 像素边长；muted 为真时画成占位态。
 * @returns {object} React 元素。
 */
function WhaleAvatar(props) {
  const size = Number(props.size ?? 34)
  const muted = props.muted === true
  /** 16×16 网格上的方块：x/y 是格坐标，w/h 是格数。 */
  const blocks = [
    // 水柱（更淡的一档）
    { x: 7, y: 2, w: 1, h: 1, tone: 'spout' },
    { x: 9, y: 2, w: 1, h: 1, tone: 'spout' },
    { x: 8, y: 3, w: 1, h: 1, tone: 'spout' },
    // 尾鳍（上翘）
    { x: 2, y: 4, w: 1, h: 1 }, { x: 3, y: 5, w: 1, h: 1 },
    { x: 1, y: 5, w: 1, h: 1 }, { x: 2, y: 6, w: 1, h: 1 },
    // 身体
    { x: 4, y: 6, w: 8, h: 1 }, { x: 3, y: 7, w: 10, h: 1 },
    { x: 3, y: 8, w: 10, h: 1 }, { x: 4, y: 9, w: 8, h: 1 },
    { x: 5, y: 10, w: 6, h: 1 },
    // 腹部（更淡，给体积感）
    { x: 4, y: 9, w: 8, h: 1, tone: 'belly' },
    { x: 5, y: 10, w: 6, h: 1, tone: 'belly' },
    // 眼睛
    { x: 10, y: 7, w: 1, h: 1, tone: 'eye' },
  ]
  const toneOf = (tone) => {
    if (tone === 'eye') return 'var(--px-whale-eye)'
    if (tone === 'belly') return 'var(--px-whale-belly)'
    if (tone === 'spout') return 'var(--px-whale-spout)'
    return 'var(--px-whale)'
  }
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    'aria-hidden': 'true',
    focusable: 'false',
    className: `px-whale${muted ? ' px-whale-muted' : ''}`,
    shapeRendering: 'crispEdges',
  }, blocks.map((block, index) => h('rect', {
    key: index,
    x: block.x, y: block.y, width: block.w, height: block.h,
    fill: toneOf(block.tone),
  })))
}

/**
 * 顶行的**用户卡**：官方账号头像 + 余额 + 官网入口。
 *
 * 用户的要求：把官方余额放到顶部那一行，做成「头像 + 余额 + 链接」的用户卡；
 * 未登录时头像用经典蓝鲸占位。
 *
 * 诚实性优先于好看：
 *   - 未登录（拿不到官方凭据）→ **不发请求**，头像转占位态，写明缺哪个引用名；
 *   - 取数失败 → 保留上一次金额（若有），并在次数旁注明失败原因；
 *   - 正常 → 直接给金额与币种，不做汇率换算。
 * @param {object} props - payload / error / busy。
 * @returns {object} React 元素。
 */
function UserBalanceCard(props) {
  const { payload, error, busy } = props
  const rows = Array.isArray(payload?.balances) ? payload.balances : []
  const amounts = rows.filter((row) => Number.isFinite(Number(row?.total)))
  /** 三种判据任一成立即算未登录（账号服务 / 旧 reason / 新 signedIn）。 */
  const signedIn = payload?.signedIn !== false
    && payload?.reason !== 'no-key'
    && payload?.reason !== 'not-signed-in'
  const failed = typeof error === 'string' && error !== ''
  const account = payload?.account
  const links = payload?.links ?? account?.links ?? {}
  /** 头像：登录后优先用官方给的 avatarUrl；没有或加载失败再退回鲸鱼。 */
  const avatarUrl = typeof account?.avatarUrl === 'string' && account.avatarUrl !== ''
    ? account.avatarUrl
    : ''

  const state = (() => {
    if (failed) return { text: `余额读取失败：${error}`, tone: 'warn' }
    if (payload === undefined) return { text: '读取中…', tone: 'muted' }
    if (payload.enabled === false) return { text: '余额查询已关闭', tone: 'muted' }
    if (!signedIn) {
      const ref = typeof payload.apiKeyEnv === 'string' && payload.apiKeyEnv !== ''
        ? `（缺 ${payload.apiKeyEnv}）`
        : ''
      return { text: `未登录官方账号${ref}`, tone: 'muted' }
    }
    if (amounts.length === 0) return { text: '官方接口没有返回余额', tone: 'muted' }
    return undefined
  })()

  /** 名称行：有账号名就写名字，否则写「DeepSeek 官方」。 */
  const nameText = signedIn
    ? (typeof account?.name === 'string' && account.name !== '' ? account.name : 'DeepSeek 官方')
    : '未登录'
  /** 副行：登录且有脱敏联系方式时显示它，否则按状态给说明。 */
  const contact = typeof account?.contact === 'string' && account.contact !== '' ? account.contact : ''

  return h('div', { className: `px-user${signedIn ? '' : ' off'}`, 'aria-label': 'DeepSeek 官方账户' },
    h('span', { className: 'px-user-avatar' },
      // 头像加载失败时静默退回鲸鱼：一张碎图比占位图更难看，也不需要惊动用户。
      avatarUrl !== '' ? h('img', {
        src: avatarUrl,
        alt: '',
        loading: 'lazy',
        referrerPolicy: 'no-referrer',
        onError: (event) => { event.currentTarget.style.display = 'none' },
      }) : null,
      h(WhaleAvatar, { size: 34 })),
    h('div', { className: 'px-user-main' },
      h('span', { className: 'px-user-name', title: nameText }, nameText),
      state === undefined
        ? h('div', { className: 'px-user-amounts' },
          amounts.map((row) => h('span', { key: row.currency, className: 'px-user-amount' },
            h('b', null, formatMoney(row.total, row.currency)),
            h('i', null, row.currency))))
        : h('span', { className: `px-user-state${state.tone === 'warn' ? ' warn' : ''}`, title: state.text }, state.text),
      contact === '' ? null : h('span', { className: 'px-user-contact' }, contact)),
    h('a', {
      className: 'px-user-link',
      href: typeof links.topUpUrl === 'string' && links.topUpUrl !== ''
        ? links.topUpUrl
        : 'https://platform.deepseek.com/usage',
      target: '_blank',
      rel: 'noreferrer',
      title: '在 DeepSeek 官网查看余额、用量与充值',
    }, signedIn ? '更多 ↗' : '去登录 ↗'))
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
      // 落在法定节假日里时宿主给出的节日名（国庆节 / 春节…），否则空串。
      // 只看 peak 无法解释「周中白天为什么便宜」，而那一刻用户最需要的就是这句解释。
      holiday: typeof data.period.holiday === 'string' ? data.period.holiday : '',
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
  // 「移除凭据」清单：与套餐额度**分开取**。两者失败互不牵连——凭据路由在旧宿主上
  // 会是 404（那时只是不画移除入口），而额度照常显示。
  //
  // 这里刻意**不带 busy**：移除过程中的「进行中」由 CredentialRemoval 自己持有。
  // 共用一个 busy 会让开关与删除互相干扰，而删除最要紧的正是防连点。
  const [credentials, setCredentials] = useState({ payload: undefined, error: '' })

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

  const loadCredentials = useCallback(() => {
    fetchPlanCredentials()
      .then((payload) => { setCredentials((prev) => ({ ...prev, payload, error: '' })) })
      .catch((error) => {
        // 旧宿主上这条路由是 404：那时**不显示错误**，只是不画移除入口。
        // 把「这台宿主没有这个功能」报成一屏红字，会让升级插件的人以为坏了。
        const message = String(error?.message ?? error)
        setCredentials((prev) => ({
          ...prev,
          error: message.includes('宿主没有') ? '' : message,
        }))
      })
  }, [])

  /**
   * 移除完成后的收尾。
   *
   * 必须**重新取一次额度**：那家现在是「未配置」了，而额度缓存（宿主 30 秒、
   * 浏览器这份）里还留着上一次成功的快照。不重取的话用户会看到「明明移除了，
   * 额度还在」——那正是最容易让人以为移除没生效的现象。
   * @param {object} body - 宿主的移除结果（含复核后的新清单）。
   */
  const afterRemoval = useCallback((body) => {
    if (body?.credentials !== undefined) {
      setCredentials((prev) => ({ ...prev, payload: body.credentials, error: '' }))
    } else {
      loadCredentials()
    }
    loadPlans(true)
  }, [loadCredentials, loadPlans])

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
    fetchPlanCredentials()
      .then((payload) => { if (!cancelled) setCredentials((prev) => ({ ...prev, payload })) })
      .catch((error) => {
        if (cancelled) return
        const message = String(error?.message ?? error)
        setCredentials((prev) => ({ ...prev, error: message.includes('宿主没有') ? '' : message }))
      })
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
    credentials: credentials.payload,
    credentialsError: credentials.error,
    onRemoved: afterRemoval,
    // 价目改完之后**重新取一次看板**：金额是按价目算出来的，不重取的话
    // 用户会看到「价改了但金额没变」——那正是最容易让人以为保存失败的现象。
    onRatesSaved: () => { load(true) },
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
    credentials, credentialsError, onRemoved,
    onRatesSaved,
  } = props
  /**
   * 四组显示偏好全部存在 localStorage（前缀 `px.pref.`），脏值回默认。
   *
   * 归一化函数用 `useCallback` 固定下来：`usePref` 的 setter 依赖它，
   * 每次渲染换一个新函数会让 setter 的引用一直变（虽然无害，但会把
   * 传给子组件的回调也一起变掉，白白触发重渲染）。
   */
  const normalizeRange = useCallback(
    (raw) => prefEnum(raw, RANGES.map((item) => item.id), PREF_DEFAULT.range),
    [],
  )
  const [rangeId, setRangeId] = usePref('range', normalizeRange)
  /**
   * Token 趋势的分组维度。
   *
   * 三种维度回答三个不同问题，**不互相替代**，因此做成切换而不是叠加：
   *   - 模型：哪个模型用得最多（同一个模型跨提供商合并，否则会重复计数）；
   *   - 供应商：量从哪条路由来；
   *   - 构成：量花在哪一段（缓存命中 / 未命中 / 写入 / 输出，堆叠柱）。
   */
  const normalizeDim = useCallback(
    (raw) => prefEnum(raw, TREND_DIMENSIONS.map((item) => item.id), PREF_DEFAULT.trendDim),
    [],
  )
  const [trendBy, setTrendBy] = usePref('trendDim', normalizeDim)
  const normalizeMinTokens = useCallback(
    (raw) => prefNumber(raw, PREF_DEFAULT.modelMinTokens, 0),
    [],
  )
  const [minTokens, setMinTokens] = usePref('modelMinTokens', normalizeMinTokens)
  const normalizeModelLimit = useCallback(
    (raw) => Math.round(prefNumber(raw, PREF_DEFAULT.modelLimit, 1)),
    [],
  )
  const [modelLimit, setModelLimit] = usePref('modelLimit', normalizeModelLimit)
  const normalizeShowMyRate = useCallback((raw) => prefBool(raw, PREF_DEFAULT.showMyRate), [])
  const [showMyRate, setShowMyRate] = usePref('showMyRate', normalizeShowMyRate)
  /** 「展开全部」是一次性的查看动作，不进偏好：下次打开仍然先看精简视图。 */
  const [expandAll, setExpandAll] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

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

  // Token 趋势按维度摊开：`type`（构成）自己攒四段做堆叠柱，
  // 模型 / 提供商则从每天的 byModel 现场聚合（见 dimensionSeries 的注释）。
  const trend = useMemo(() => {
    if (trendBy !== 'type') {
      return { ...dimensionSeries(points, data.models, trendBy, { limit: TREND_SERIES_LIMIT }), stacked: false }
    }
    // 四段一律取自当天的 `totals`（含 cacheWrite），四段之和 === 当天 local，
    // 因此堆叠柱的高度与卡片上的窗口 Token 必然对得上。
    const shaped = points.map((point) => {
      const totals = point.totals ?? {}
      const row = { key: point.key }
      for (const line of TYPE_SERIES) row[line.key] = Number(totals[line.key] ?? 0)
      return row
    })
    return { series: TYPE_SERIES, points: shaped, stacked: true }
  }, [trendBy, points, data.models])

  /**
   * 「我的单价」覆盖后的价目：把用户补的价逐条盖到宿主交下来的那份上面。
   *
   * 只覆盖、不重建：未补价的模型继续用宿主那一份（含「估算价」的兜底口径），
   * 于是「我的价」与「官方价」的差别**只来自用户改过的那几条**。
   * 覆盖两个入口（`models` 与 `rates`）是因为 `ratesFor()` 两条都会查：
   * 新宿主走 `models`，旧宿主只有整张 `rates`。
   * @type {object}
   */
  const myPricing = useMemo(() => {
    const mine = data.customRates?.rates
    if (mine === undefined || mine === null || Object.keys(mine).length === 0) return data.pricing
    const models = { ...(data.pricing?.models ?? {}) }
    const rates = { ...(data.pricing?.rates ?? {}) }
    for (const [key, rate] of Object.entries(mine)) {
      if (rate === undefined || rate === null) continue
      models[key] = rate
      rates[key] = rate
    }
    return { ...data.pricing, models, rates }
  }, [data.pricing, data.customRates])

  /**
   * 消费趋势：逐日金额柱状图。
   *
   * 默认只画官方价一根柱；勾选「我的单价」后与官方价**并列**画第二根
   * （分组柱，不是叠加——两根柱回答同一个问题的两个答案，叠起来没有意义）。
   * 两列都走 `dailyCosts()`，因此逐日相加仍等于卡片标题行那个合计。
   */
  const costPoints = useMemo(() => {
    const official = dailyCosts(points, data.pricing)
    const mine = showMyRate ? dailyCosts(points, myPricing) : null
    return official.map((row, index) => ({
      key: row.key,
      official: row.cost,
      mine: mine === null ? undefined : mine[index]?.cost,
    }))
  }, [points, data.pricing, myPricing, showMyRate])
  const costSeries = useMemo(
    () => (showMyRate ? [COST_SERIES_OFFICIAL, COST_SERIES_MINE] : [COST_SERIES_OFFICIAL]),
    [showMyRate],
  )
  /** 我的价与官方价的差额（正数 = 我填得更贵）。只改了价的模型才影响它。 */
  const myRateDelta = useMemo(() => {
    if (!showMyRate) return 0
    return priceByModel(rangeByModel, myPricing).standard - rangeCost.standard
  }, [showMyRate, rangeByModel, myPricing, rangeCost])

  /**
   * 模型分布 / 费用明细的聚焦集合。
   *
   * 两条规则按用户要求串起来：
   *   1. **消耗阈值**（默认 1000 万 token）：只统计达到阈值的模型；
   *   2. **默认显示最近使用的 N 款**（默认 5），可「展开全部」。
   * 一条都达不到阈值时**回落成用量前 5**——面板绝不空白。
   *
   * 「最近使用」不是按名字猜的：逐日行里该条目最后一次出现的下标就是它的
   * 最近使用时刻，与排序同源，因此不会出现「显示的名字与排序依据不一致」。
   * 颜色一律按**在 `models` 里的原始下标**取，与环图同源（两处各按过滤后的
   * 下标取色，同一个条目会在两张图里显示成不同颜色——这是老 bug）。
   */
  const modelFocus = useMemo(() => {
    const models = Array.isArray(data.models) ? data.models : []
    const rows = models.map((model, index) => {
      const key = entryKeyOf(model)
      const usage = rangeByModel[key]
      let lastIndex = -1
      for (let point = points.length - 1; point >= 0; point -= 1) {
        const usageOfDay = points[point]?.byModel?.[key]
        if (usageOfDay !== undefined && Number(usageOfDay.local ?? 0) > 0) { lastIndex = point; break }
      }
      return {
        model,
        key,
        tone: TONES[index % TONES.length],
        // 逐条用量原样带上：费用明细要按它算高峰 / 空闲 token 与金额，
        // 在那边再查一次 `rangeByModel` 就等于把同一份数据取两遍。
        usage: usage ?? {},
        tokens: Number(usage?.local ?? 0),
        lastIndex,
      }
    }).filter((row) => row.lastIndex >= 0 || row.tokens > 0)

    // 最近使用的排在前面；同一天用过的按用量降序，保证顺序稳定。
    const byRecency = [...rows].sort((a, b) => (b.lastIndex - a.lastIndex) || (b.tokens - a.tokens))
    const qualified = byRecency.filter((row) => row.tokens >= minTokens)
    const fellBack = qualified.length === 0
    const pool = fellBack
      ? [...rows].sort((a, b) => b.tokens - a.tokens).slice(0, Math.max(1, modelLimit))
      : qualified
    const shown = expandAll ? pool : pool.slice(0, Math.max(1, modelLimit))
    return {
      rows,
      shown,
      /** 阈值之外还剩几条候选（「展开全部」里有几条）。 */
      poolSize: pool.length,
      hiddenCount: Math.max(0, pool.length - shown.length),
      fellBack,
      // 被阈值挡在外面的条目（用来说明「合计与上表的关系」）
      rest: rows.filter((row) => !shown.some((item) => item.key === row.key)),
    }
  }, [data.models, rangeByModel, points, minTokens, modelLimit, expandAll])

  /** 上表未列出的那些模型的花费。逐条独立计算，不做减法（避免尾数漂移）。 */
  const restCost = useMemo(() => {
    if (modelFocus.rest.length === 0) return { standard: 0, count: 0 }
    const subset = {}
    for (const row of modelFocus.rest) {
      const usage = rangeByModel[row.key]
      if (usage !== undefined) subset[row.key] = usage
    }
    return { standard: priceByModel(subset, data.pricing).standard, count: Object.keys(subset).length }
  }, [modelFocus.rest, rangeByModel, data.pricing])

  /** 消费 Top 会话：按花费降序取前 8，点击进入该会话。 */
  const topSessions = useMemo(() => {
    const sessions = Array.isArray(data.sessions) ? data.sessions : []
    const numeric = (value) => (value === undefined || value === null || !Number.isFinite(Number(value))
      ? undefined
      : Number(value))
    return sessions
      .map((session) => ({
        session,
        cost: numeric(session?.cost?.standard),
        tokens: numeric(session?.totals?.local),
      }))
      .sort((a, b) => ((b.cost ?? 0) - (a.cost ?? 0)) || ((b.tokens ?? 0) - (a.tokens ?? 0)))
      .slice(0, 8)
  }, [data.sessions])

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
        refreshing ? '刷新中' : '刷新'),
        // 设置是**弹层**而不是页面上的一块：通知、单价、显示偏好都是「偶尔改一次」
        // 的东西，常驻在正文里会占掉用户每次都要滚过去的高度。
        h('button', {
          type: 'button',
          className: 'px-btn small px-settings-btn',
          'aria-haspopup': 'dialog',
          'aria-expanded': settingsOpen,
          onClick: () => { setSettingsOpen(true) },
        }, '设置'))),

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
      }),
      // 第五格：官方账号用户卡（头像 + 余额 + 官网入口）。
      // 放在顶行而不是单独一条，是因为它和上面四个一样属于「一眼要看到的现状」，
      // 再单开一条横条只会把「第二行」的那个并排卡往下推。
      h(UserBalanceCard, { payload: balance, error: balanceError, busy: balanceBusy })),

    // ── 时段与计费 ＋ 活跃日历：**第二行**（用户指定）────────────
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
          // 节假日里把节日名写进徽标：那一刻「为什么是空闲」比「是空闲」更需要说明，
          // 因为按星期几看它本该是高峰。没有节日时退回原来的四种字。
          period.peak ? '高峰时段计费中'
            : (period.holiday === '' ? '空闲时段计费中' : `${period.holiday} · 空闲计费`)),
      },
      h('div', { className: 'px-period' },
        h('div', { className: 'px-period-clock' },
          h('span', { className: 'px-period-clock-label' },
            period.peak ? '距转空闲' : '距转高峰'),
          h('b', { className: 'px-period-clock-value' }, formatCountdown(period.remainMs)),
          h('span', { className: 'px-period-clock-foot' },
            `${formatMinuteOfDay(period.minute)} · ${data.timezone}`)),
        h('div', { className: 'px-rows px-period-rows' },
          // 「周一至周五」后面必须跟上「不含法定节假日」：否则国庆期间的周四、周五
          // 明明按空闲计费，这一行却说着「高峰时段 = 周一至周五」，自相矛盾。
          // 「法定节假日」单独一行已按用户要求去掉（它把这张卡撑高，而且口径已经
          // 写在上面这一行的括号里）；节假日当天的解释改由卡片右上角的徽标承担。
          h(Row, {
            label: '高峰时段',
            value: `周一至周五（不含法定节假日）${formatWindows(data.peakRule?.windows)}`,
          }),
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
      // 构成用**堆叠柱**（四段之和 === 当天总量），模型 / 供应商用折线
      // （它们回答「谁用得多」，曲线比柱子更容易看出趋势）。
      trend.stacked
        ? h(BarChart, {
          points: trend.points,
          series: trend.series,
          stacked: true,
          formatAxis: formatTokens,
          formatValue: formatTokens,
          ariaLabel: 'token 构成堆叠柱',
        })
        : h(TrendChart, {
          points: trend.points,
          series: trend.series,
          formatAxis: formatTokens,
          formatValue: formatTokens,
        })),

      h(Panel, {
        title: `${range.label}消费趋势`,
        tone: 'pink',
        delay: 320,
        // 合计金额**跟在标题右边**（用户要求）。柱子的形状告诉「哪天贵」，
        // 这个数字回答「一共多少」；勾了「我的单价」时并排列两个合计。
        titleExtra: showMyRate && myRateDelta !== 0
          ? `官方 ${formatCny(rangeCost.standard)} · 我的 ${formatCny(rangeCost.standard + myRateDelta)}`
          : formatCny(rangeCost.standard),
        // 右侧放「我的单价」开关：它只影响这张图画几根柱子，属于这张卡自己的控件
        // （原来在设置弹层的「显示」页里，用户得翻两层才找得到）。
        extra: h('label', { className: 'px-inline-toggle', title: '勾上后与官方价并列再画一根柱子（不叠加）' },
          h('input', {
            type: 'checkbox',
            checked: showMyRate === true,
            onChange: (event) => { setShowMyRate(event.target.checked) },
          }),
          h('span', null, '我的单价')),
      },
      h(BarChart, {
        points: costPoints,
        series: costSeries,
        // 轴用紧凑金额（`¥0.038`），读数与合计仍用完整的 formatCny
        formatAxis: formatCnyAxis,
        formatValue: formatCny,
        ariaLabel: '逐日消费柱状图',
      }))),

    // ── 套餐余额：第三方订阅额度（每家一张卡，环形条 + 进度条）────────
    h(AccountPanel, {
      balance,
      balanceError,
      balanceBusy,
      onToggleBalance,
      plans,
      plansError,
      plansBusy,
      onTogglePlans,
      credentials,
      credentialsError,
      onRemoved,
      now,
      timeZone: data.timezone,
      selectedPlan,
      onSelectPlan,
    }),

    // ── 模型分布 ＋ 费用明细：同一张卡片组，共用一条阈值 / 条数工具条 ──
    // 两块必须显示**同一批**模型，否则「环图里有的、明细里没有」会把对账搞乱。
    h('div', { className: 'px-model-group' },
      h('div', { className: 'px-model-bar' },
        h('span', { className: 'px-model-bar-hint' },
          modelFocus.fellBack
            ? `没有模型达到 ${formatTokens(minTokens)}，按用量显示前 ${modelFocus.poolSize} 款`
            : `只统计 ≥ ${formatTokens(minTokens)} 的模型 · 最近使用的 ${modelFocus.shown.length} 款`),
        modelFocus.poolSize > modelFocus.shown.length
          ? h('button', {
            type: 'button',
            className: 'px-btn small',
            onClick: () => { setExpandAll(true) },
          }, `展开全部（共 ${modelFocus.poolSize} 款）`)
          : null,
        expandAll && modelFocus.poolSize > Math.max(1, modelLimit)
          ? h('button', {
            type: 'button',
            className: 'px-btn small',
            onClick: () => { setExpandAll(false) },
          }, '只看最近使用')
          : null,
        modelFocus.rest.length > 0
          ? h('span', { className: 'px-muted' },
            `另有 ${modelFocus.rest.length} 款未列出，合计 ${formatCny(restCost.standard)}`)
          : null),

      h('div', { className: 'px-grid-2' },
        h(Panel, { title: '模型分布', tone: 'purple', delay: 340 },
          h(ModelBreakdown, {
            rows: modelFocus.shown,
            rangeTotals,
            totalRows: modelFocus.rows.length,
            minTokens,
            fellBack: modelFocus.fellBack,
          })),
        h(Panel, { title: '费用明细', tone: 'pink', delay: 380 },
          h(CostTable, {
            rows: modelFocus.shown,
            pricing: data.pricing,
            myPricing,
            showMyRate,
            rangeCost,
            restCost,
            split,
            rangeLabel: range.label,
            // 补价入口交给定价工作流（费用明细里每条一个按钮，点开浮层改单个模型）
            onRatesSaved,
          })))),

    // ── 消费 Top 会话 ──────────────────────────────────────────────
    // 完整会话清单不再留在看板（它进会话标签页），这里只留「花得最多的几条」，
    // 点击进去看那条会话的账——看板要回答的是「花在哪」，不是「一共有几条会话」。
    h(Panel, {
      title: '消费 Top 会话',
      tone: 'blue',
      delay: 420,
      extra: `共 ${Array.isArray(data.sessions) ? data.sessions.length : 0} 个会话 · 按花费排序`,
    },
    h(TopSessions, { rows: topSessions, timezone: data.timezone })),

    // 底部口径说明：只留**会改变读数理解**的两句（多厂商单价怎么来、金额是什么口径）。
    // 详细的计费口径属于 README，天天摆在读数下面只会让人先跨过它才能看到数字。
    h('p', { className: 'px-source' },
      '单价与时段口径来自 ',
      h('a', {
        href: data.pricing?.source ?? 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
        target: '_blank',
        rel: 'noreferrer',
      }, '各厂商官方定价页'),
      // 「实际账单以服务商为准」在买断制下是误导：第三方中转 / Coding Plan
      // 不按 token 计费，所以这里的金额与它们毫无关系，而不是「略有出入」。
      '。金额按各模型官方单价估算；第三方中转与 Coding Plan 是买断制，不按 token 计费，不在此列。'),

    // 设置弹层放在最后：它渲染到 body 上（浮层），与页面排版无关，
    // 放这里只是让「点开设置」这个动作的入口与出口在代码里也挨着。
    h(SettingsDialog, {
      open: settingsOpen,
      onClose: () => { setSettingsOpen(false) },
      data,
      onRatesSaved,
      minTokens,
      onMinTokens: setMinTokens,
      modelLimit,
      onModelLimit: setModelLimit,
      showMyRate,
      onShowMyRate: setShowMyRate,
      trendDim: trendBy,
      onTrendDim: setTrendBy,
    }),
  )
}

/**
 * 会话的显示名：与 DSH 侧栏同一条回落链。
 *
 * 持久标题 → 工作目录末段 → 会话 id 片段。旧宿主不返回 `title`，只有 `workspace`，
 * 那时至少显示目录名（用户认得出），而不是退回一串十六进制。
 * @param {object} session - `sessions[]` 里的一行。
 * @returns {string} 显示名。
 */
function sessionTitleOf(session) {
  const raw = typeof session?.title === 'string' ? session.title.trim() : ''
  if (raw !== '') return raw
  const workspace = typeof session?.workspace === 'string' ? session.workspace.trim() : ''
  if (workspace !== '') return workspace
  return `${String(session?.id ?? '').slice(8, 16)}…`
}

/**
 * 消费 Top 会话：只留「花得最多的几条」，点标题进入该会话。
 *
 * 完整会话清单**不再留在看板**（它进会话标签页）：看板要回答的是「花在哪」，
 * 而一百多行的清单只会把「还剩多少」推到很远的地方。
 *
 * 跳转走的是通知运行时那一条已经验证过的通道（`notifyStore().openSession`），
 * 不自己找 `uiWorkspace`：那条路径已经处理了「duplicate 服务不可用」「先 focus
 * 再切会话」等一堆坑，看板没必要再实现一遍。
 * @param {object} props - rows（已排好序的 `{session,cost,tokens}`）/ timezone。
 * @returns {object} React 元素。
 */
function TopSessions(props) {
  const { rows, timezone } = props
  /**
   * 展开哪一条（**不跳转会话**）。
   *
   * 用户的要求改过一次：原来点标题是跳到那条会话，现在要「展开显示该会话的费用明细」。
   * 判据也顺手变清楚了：这张表是**看板**的读数工具（谁最贵、贵在哪），
   * 跳走会把人从"比较"拽进"单条"，反而丢上下文。
   */
  const [expanded, setExpanded] = useState('')
  /** 会话 id → { status, payload, error }：同一条反复点开不该反复取数。 */
  const [details, setDetails] = useState({})

  const load = useCallback((sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    setDetails((prev) => (prev[sessionId] === undefined || prev[sessionId].status === 'failed'
      ? { ...prev, [sessionId]: { status: 'loading' } }
      : prev))
    fetchSession(sessionId)
      .then((payload) => {
        setDetails((prev) => ({ ...prev, [sessionId]: { status: 'ready', payload } }))
      })
      .catch((error) => {
        setDetails((prev) => ({
          ...prev,
          [sessionId]: { status: 'failed', error: String(error?.message ?? error) },
        }))
      })
  }, [])

  const toggle = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    setExpanded((prev) => {
      if (prev === sessionId) return ''
      load(sessionId)
      return sessionId
    })
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return h('p', { className: 'px-muted' }, '还没有会话记录。跑一轮对话之后这里会按花费排出前几名。')
  }

  return h('div', { className: 'px-table-wrap' },
    h('table', { className: 'px-table px-top-session-table' },
      h('thead', null,
        h('tr', null,
          h('th', null, '会话'),
          h('th', { className: 'px-num' }, '花费'),
          h('th', { className: 'px-num' }, 'Token'),
          h('th', null, '最后活跃'))),
      h('tbody', null,
        rows.map(({ session, cost, tokens }) => {
          const title = sessionTitleOf(session)
          const id = String(session?.id ?? '')
          const lastAt = Number(session?.lastAt ?? 0) || Number(session?.createdAt ?? 0)
          const isOpen = expanded !== '' && expanded === id
          return [
            h('tr', {
              key: id !== '' ? id : title,
              className: `px-top-session-row${isOpen ? ' open' : ''}`,
              onClick: () => { toggle(id) },
            },
            h('td', null,
              // 标题是一枚按钮：整行可点只是鼠标方便，**键盘可达**靠它
              // （`<span onClick>` 的话 Tab 永远到不了这一行）。
              h('button', {
                type: 'button',
                className: 'px-session-open',
                'aria-expanded': isOpen,
                title: `${title}\n${id}`,
                onClick: (event) => { event.stopPropagation(); toggle(id) },
              },
              // 展开指示：小三角随状态旋转，说明「这里能点开」。
              h('i', { className: `px-caret${isOpen ? ' open' : ''}`, 'aria-hidden': 'true' }),
              h('span', null, title)),
              session?.live === true ? h('span', { className: 'px-badge ok' }, '进行中') : null),
            h('td', { className: 'px-num' },
              cost === undefined ? h('span', { className: 'px-muted' }, '—') : formatCny(cost)),
            h('td', { className: 'px-num' },
              tokens === undefined ? h('span', { className: 'px-muted' }, '—') : formatTokens(tokens)),
            h('td', null, lastAt > 0 ? formatDateTime(lastAt, timezone) : h('span', { className: 'px-muted' }, '—'))),
            isOpen
              ? h('tr', { key: `${id}-detail`, className: 'px-top-session-detail-row' },
                h('td', { colSpan: 4 }, h(SessionDetailInline, { state: details[id], timezone })))
              : null,
          ]
        }))))
}

/**
 * Top 会话里展开的那块明细：**紧凑版**，不是把整个会话标签页搬过来。
 *
 * 这里只回答「这条会话贵在哪」：峰谷拆分 + 逐模型金额（最多 6 行）。
 * 要看逐日、缓存命中率、余额绑定，去会话里的「费用」标签页——两处职责不同，
 * 都铺满会让这张表从"比较"退化成"第二份报表"。
 * @param {object} props - state（loading/ready/failed）/ timezone。
 * @returns {object} React 元素。
 */
function SessionDetailInline(props) {
  const { state } = props
  if (state === undefined || state.status === 'loading') {
    return h('p', { className: 'px-muted px-top-detail-state' }, '读取这条会话的明细…')
  }
  if (state.status === 'failed') {
    return h('p', { className: 'px-muted px-top-detail-state' }, `取不到明细：${state.error}`)
  }
  const payload = state.payload ?? {}
  const entries = Array.isArray(payload.entries) ? payload.entries : []
  const days = Array.isArray(payload.days) ? payload.days : []
  const total = payload.cost ?? {}
  if (entries.length === 0 && days.length === 0) {
    return h('p', { className: 'px-muted px-top-detail-state' }, '这条会话没有按模型的用量记录（可能是旧宿主或其它设备的历史）。')
  }
  const shown = entries.slice(0, 6)
  const rest = entries.length - shown.length
  // 缓存命中率的分母是**计费输入**（命中 + 未命中 + 写入）；没有输入时整项省略，
  // 写成 0% 会把「还没有输入」显示成「缓存完全没命中」，是两种处境。
  const totals = payload.session?.totals
  const ratio = totals === undefined ? undefined : cacheRatio(totals)
  const buckets = totals === undefined ? undefined : usageBuckets(totals)
  const team = payload.team
  const teamMembers = Array.isArray(team?.members) ? team.members : []

  return h('div', { className: 'px-top-detail' },
    // 第一行：四项事实并排（峰/谷/可省/命中率）。命中率缺就不渲染那一项。
    h('div', { className: 'px-top-detail-sum' },
      h('span', null, '高峰 ', h('b', null, formatCny(total.peak ?? 0))),
      h('span', null, '空闲 ', h('b', null, formatCny(total.idle ?? 0))),
      h('span', null, '若全走空闲可省 ', h('b', null, formatCny(total.saved ?? 0))),
      ratio === undefined
        ? null
        : h('span', null, '缓存命中率 ', h('b', null, `${(ratio * 100).toFixed(1)}%`)),
      buckets === undefined
        ? null
        : h('span', null, '计费输入 ', h('b', null, formatTokens(buckets.billed)))),

    // 团队：这条会话若是某个多成员团队的一员，把「整队花了多少、谁花得多」说清楚。
    // 少这一块，用户会以为这一行的金额就是全部（而团队口径本来就不一样）。
    team === null || team === undefined
      ? null
      : h('div', { className: 'px-top-detail-team' },
        h('span', { className: 'px-top-detail-team-title' },
          `团队成员 ${team.memberCount ?? teamMembers.length} 位 · 合计 `,
          h('b', null, formatCny(team.cost?.standard ?? 0))),
        h('ul', { className: 'px-top-detail-members' },
          teamMembers.slice(0, 4).map((member) => h('li', { key: member.id },
            h('span', { className: 'px-top-detail-model', title: member.name }, member.name ?? member.id),
            h('span', { className: 'px-num' }, formatTokens(member.totals?.local)),
            h('span', { className: 'px-num px-top-detail-cost' }, formatCny(member.cost?.standard ?? 0))))),
        teamMembers.length > 4
          ? h('p', { className: 'px-muted px-top-detail-state' }, `另有 ${teamMembers.length - 4} 位成员未列出。`)
          : null),

    h('ul', { className: 'px-top-detail-models' },
      shown.map((entry) => h('li', { key: entry.key },
        h('span', { className: 'px-top-detail-model', title: entry.key }, entry.label ?? entry.rollup ?? entry.key),
        h('span', { className: 'px-num' }, formatTokens(entry.totals?.local)),
        h('span', { className: 'px-num px-top-detail-cost' }, formatCny(entry.cost?.standard ?? 0)),
        entry.priced === false ? h('span', { className: 'px-badge' }, '估算价') : null))),
    rest > 0
      ? h('p', { className: 'px-muted px-top-detail-state' }, `另有 ${rest} 款模型未列出（去会话的「费用」标签页看全部）。`)
      : null,

    // 逐日：最多 6 天，做成一行紧凑的「日期 · 金额」而不是又一张表。
    days.length === 0
      ? null
      : h('div', { className: 'px-top-detail-days' },
        days.slice(-6).map((day) => h('span', { key: day.key, className: 'px-top-detail-day' },
          h('i', null, day.key.slice(5)),
          h('b', null, formatCny(day.cost?.standard ?? 0))))))
}

/** 设置弹层的页签：通知 / 单价 / 显示。 */
const SETTINGS_TABS = [
  { id: 'notify', label: '通知' },
  { id: 'pricing', label: '单价' },
  { id: 'display', label: '显示' },
]

/**
 * 设置弹层。
 *
 * 三块「偶尔改一次」的东西从看板正文收进来：通知开关（原先占了整整一张卡片）、
 * 单价设置、以及显示偏好（阈值 / 显示条数 / 趋势默认维度 / 是否画我的单价）。
 *
 * 四条交互约束，每条都对应一类用户打不开或关不掉：
 *   - **收起时整个节点不渲染**（不是 `display:none`）：留一个不可见的壳会挡住下面的点击，
 *     而界面上完全看不出来；
 *   - **Esc 关**：`role="dialog"` 就必须能 Esc 收起；
 *   - **点外面关**：用 `pointerdown` 而不是 `click`——后者要等鼠标抬起，用户按住拖动
 *     （比如选文字）时面板会一直开着；
 *   - **打开时把焦点移进面板**：键盘用户不必先 Tab 一圈才到内容上。
 *
 * 浮层挂到 `document.body`：留在 `.px-root` 里会被卡片的 `overflow` 与入场动画裁掉。
 * @param {object} props - open / onClose / data / onRatesSaved / 各偏好与 setter。
 * @returns {object|null} React 元素。
 */
function SettingsDialog(props) {
  const {
    open, onClose, data, onRatesSaved,
    minTokens, onMinTokens, modelLimit, onModelLimit,
    showMyRate, onShowMyRate, trendDim, onTrendDim,
  } = props
  const [tab, setTab] = useState('notify')
  const panelRef = useRef(null)
  // 阈值 / 条数用草稿：输入过程中不能每敲一个字符就改看板（「1」与「1000 万」
  // 是两个完全不同的筛选条件，中间态会让下面两张卡片连续闪烁）。
  const [wanDraft, setWanDraft] = useState('')
  const [limitDraft, setLimitDraft] = useState('')

  useEffect(() => {
    if (open !== true) return
    setWanDraft(String(Math.round(Number(minTokens) / 10_000)))
    setLimitDraft(String(Math.round(Number(modelLimit))))
  }, [open, minTokens, modelLimit])

  useEffect(() => {
    if (open !== true) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose?.()
      }
    }
    // capture 阶段收键：产品自己也监听 Esc（关输入框、退出面板），
    // 不抢在它前面的话，「关设置」会先被别的东西吃掉。
    document.addEventListener('keydown', onKey, true)
    const node = panelRef.current
    if (node !== null && typeof node.focus === 'function') node.focus()
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [open, onClose])

  if (open !== true) return null

  const commitWan = () => {
    const wan = Number(wanDraft)
    onMinTokens?.(Number.isFinite(wan) && wan >= 0 ? wan * 10_000 : PREF_DEFAULT.modelMinTokens)
  }
  const commitLimit = () => {
    const value = Number(limitDraft)
    onModelLimit?.(Number.isFinite(value) && value >= 1 ? Math.round(value) : PREF_DEFAULT.modelLimit)
  }

  const body = tab === 'notify'
    ? h(NotifyPanel)
    : tab === 'pricing'
      ? h(PriceSettingsView, { data, onSaved: onRatesSaved })
      : h('div', { className: 'px-prefs' },
        h('label', { className: 'px-pref' },
          h('span', { className: 'px-pref-label' }, '模型消耗阈值'),
          h('span', { className: 'px-pref-control' },
            h('input', {
              type: 'number',
              min: 0,
              step: 100,
              className: 'px-input px-pref-input',
              value: wanDraft,
              onChange: (event) => { setWanDraft(event.target.value) },
              onBlur: commitWan,
              onKeyDown: (event) => { if (event.key === 'Enter') commitWan() },
            }),
            h('span', { className: 'px-muted' }, '万 token')),
          h('span', { className: 'px-pref-hint' },
            '「模型分布」「费用明细」只统计窗口内消耗达到这个量的模型；一款都达不到时按用量显示前几款。')),
        h('label', { className: 'px-pref' },
          h('span', { className: 'px-pref-label' }, '默认显示条数'),
          h('span', { className: 'px-pref-control' },
            h('input', {
              type: 'number',
              min: 1,
              step: 1,
              className: 'px-input px-pref-input',
              value: limitDraft,
              onChange: (event) => { setLimitDraft(event.target.value) },
              onBlur: commitLimit,
              onKeyDown: (event) => { if (event.key === 'Enter') commitLimit() },
            }),
            h('span', { className: 'px-muted' }, '款')),
          h('span', { className: 'px-pref-hint' }, '超过这个数就收起，卡片上有「展开全部」。')),
        // 「消费趋势里显示我的单价」已**搬到消费趋势卡片上**（用户要求）：
        // 它改的是那张图画几根柱子，属于那张卡自己的控件，不该埋在设置里翻两层。
        h('label', { className: 'px-pref' },
          h('span', { className: 'px-pref-label' }, '趋势默认维度'),
          h('span', { className: 'px-pref-control' },
            h('select', {
              className: 'px-input px-pref-select',
              value: trendDim,
              onChange: (event) => { onTrendDim?.(event.target.value) },
            },
            TREND_DIMENSIONS.map((item) => h('option', { key: item.id, value: item.id }, item.label)))),
          h('span', { className: 'px-pref-hint' },
            'Token 趋势先画哪个维度；在卡片上切换也会被记住。')))

  const dialog = h('div', {
    className: 'px-modal-mask',
    onPointerDown: (event) => {
      // 只有点在遮罩本身上才关：点面板内部不该关（用户正在里面选东西）。
      if (event.target !== event.currentTarget) return
      /**
       * **正在操作原生下拉框时不要关**。
       *
       * 用户在设置里选「趋势默认维度 / 条数」时，下拉选项列表是浏览器自己画的浮层；
       * 在某些平台上点选项的那一下会把 pointerdown 派发到遮罩上，于是「刚点开下拉，
       * 整个设置面板就没了」——用户报的「下拉框会自动关闭」就是这个。
       * 判据取焦点：此刻焦点还在 select（或文本输入框）里，就说明这次点击是它的交互。
       */
      const active = typeof document === 'undefined' ? null : document.activeElement
      if (active !== null && active !== undefined) {
        const tag = String(active.tagName ?? '').toUpperCase()
        if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return
      }
      onClose?.()
    },
  },
  h('div', {
    className: 'px-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': '看板设置',
    tabIndex: -1,
    ref: panelRef,
  },
  h('header', { className: 'px-modal-head' },
    h('b', { className: 'px-modal-title' }, '设置'),
    h('button', {
      type: 'button',
      className: 'px-btn small px-modal-close',
      onClick: () => { onClose?.() },
      'aria-label': '关闭设置',
    }, '关闭')),
  h('div', { className: 'px-modal-tabs', role: 'tablist' },
    SETTINGS_TABS.map((item) => h('button', {
      key: item.id,
      type: 'button',
      role: 'tab',
      'aria-selected': tab === item.id,
      className: `px-modal-tab${tab === item.id ? ' px-modal-tab-on' : ''}`,
      onClick: () => { setTab(item.id) },
    }, item.label))),
  h('div', { className: 'px-modal-body' }, body)))

  // 服务端渲染 / 无 document 时直接内联渲染：闸门只渲染静态整页，弹层默认关闭，
  // 因此这一支实际只在「有人真的点开了设置」时成立。
  //
  // 判据里带上 `document.body`：渲染闸门给的是一个只带 head 的假 document，
  // 在那种环境下 createPortal 会直接抛（服务端渲染不支持 portal）。
  const portal = ReactDOM?.createPortal
  const canPortal = typeof document !== 'undefined' && document !== null && document.body != null
  if (!canPortal || typeof portal !== 'function') return dialog
  return portal(dialog, document.body)
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
 *
 * 重置时刻给**绝对日期 + 剩余时间**两句（见 `formatResetLine`）：月额度这种长周期，
 * 用户常常要的是「到底哪天到期」，光有「还剩 9 天」还得自己算日子。
 * @param {object} props - win / now / timeZone。
 * @returns {object} React 元素。
 */
function QuotaWindow(props) {
  const { win, now, timeZone } = props
  const progress = windowProgress(win)
  const tone = quotaTone(progress.percent, progress.over)
  const reset = formatResetLine(win?.resetAt, now, timeZone)
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
 * @param {object} props - provider / now / current / credentialFile / timeZone。
 * @returns {object} React 元素。
 */
function ProviderQuota(props) {
  const { provider, now, current = false, credentialFile, timeZone } = props
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
      : h('div', { className: 'px-quota-list' },
        windows.map((win) => h(QuotaWindow, { key: win.window, win, now, timeZone }))),
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
 * 「移除套餐凭据」区块：逐条勾选 + 二次确认。
 *
 * ## 为什么是「勾选 + 二次确认」而不是每家一个「移除」按钮
 *
 * 用户的原话是「在客户端添加主动删除套餐凭据的功能」。删的是他自己配的密钥，
 * 而且是**不可撤销**的（DSH 的凭据文件写完就没了，插件不保留副本）。因此：
 *
 *   1. **默认全部不勾选。** 一点进来就勾好了，等于把「删除」做成了默认动作；
 *   2. **点「移除」先进入确认态**，把要删的名字逐条列出来再让用户按第二次。
 *      只按一次就删，误触的代价是密钥没了。
 *
 * ## 不可移除的条目照实画出来，但不给勾选框
 *
 * 来源是启动环境变量或 `.env` 回落层时，`unset` 要么抛错、要么是**静默空操作**。
 * 画一个勾选框再让它失败，比不画更糟——用户会以为插件坏了。所以这一类**显示**、
 * 标明来源与出路，但勾选框是禁用状态，并写清为什么。
 * @param {object} props - payload / error / busy / onRemoved / credentialFile。
 * @returns {object|null} React 元素。
 */
function CredentialRemoval(props) {
  const { payload, error, busy, onRemoved, credentialFile } = props
  /** @type {[string[], Function]} 已勾选的引用名。 */
  const [picked, setPicked] = useState([])
  /** 二次确认态：按下「移除」后进入，列出将删的条目。 */
  const [confirming, setConfirming] = useState(false)
  /** 上一次移除的逐条结果（宿主的原文）。 */
  const [results, setResults] = useState(null)
  const [localError, setLocalError] = useState('')
  /**
   * 正在发请求。
   *
   * 本地状态而不是读父级的 `busy`：父级那个是**开关**用的（余额 / 套餐），
   * 与这条路径共用会让两边互相干扰。而且这里最要紧的是防连点——
   * 删密钥的请求发两次，第二次会在第一次删完之后再删一次同样的名字。
   */
  const [working, setWorking] = useState(false)
  const disabled = busy === true || working === true

  const rows = credentialRows(payload)
  const summary = credentialSummary(payload)
  // 宿主没有可写的凭据服务（老版本 / 未挂载）：整块只在有可移除项时才画，
  // 且此时必须说清「这台机器上改不了」。
  const canWrite = payload?.writable === true

  // 清单变了（移除成功后宿主会交下新的一份）就把勾选与确认态清掉：
  // 留着已失效的勾选，下一次点「移除」会去删一批用户没再看过的东西。
  useEffect(() => {
    setPicked([])
    setConfirming(false)
  }, [payload])

  if (payload === undefined || payload === null) {
    return error === undefined || error === ''
      ? null
      : h('p', { className: 'px-balance-state px-error' }, `凭据清单读取失败：${error}`)
  }
  // 一条都没配过时整块不渲染：那正是「没什么可移除」的状态，
  // 摊开一张全是「未配置」的表只是噪音。
  if (summary.configured === 0) return null

  const togglePick = (name) => {
    setResults(null)
    setLocalError('')
    setPicked((prev) => (prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]))
  }

  /** 真正发移除请求。 */
  const submit = () => {
    const refs = picked
    if (refs.length === 0 || disabled) return
    setConfirming(false)
    setLocalError('')
    setWorking(true)
    removePlanCredentials(refs)
      .then((body) => {
        setResults(body)
        onRemoved?.(body)
      })
      .catch((failure) => { setLocalError(String(failure?.message ?? failure)) })
      .finally(() => { setWorking(false) })
  }

  /** 一条凭据的勾选框 + 说明。 */
  const row = (entry) => {
    const { ref, vendor } = entry
    const id = `${vendor}:${ref.name}`
    const locked = !entry.selectable || disabled
    return h('li', { key: id, className: `px-cred-row${entry.selectable ? '' : ' locked'}` },
      h('label', { className: 'px-cred-pick' },
        h('input', {
          type: 'checkbox',
          checked: picked.includes(ref.name),
          disabled: locked,
          onChange: () => { togglePick(ref.name) },
        }),
        h('code', { className: 'px-cred-name' }, ref.name)),
      ref.configured === true
        ? h('span', { className: 'px-badge' }, '已配置')
        : h('span', { className: 'px-badge idle' }, '未配置'),
      // 打码尾段：用户据此确认删的是**哪一把**（换过 Key 的机器上这一步很关键），
      // 而它不足以还原出密钥。
      ref.hint === undefined || ref.hint === ''
        ? null
        : h('span', { className: 'px-cred-hint' }, ref.hint),
      ref.sourceLabel === undefined || ref.sourceLabel === ''
        ? null
        : h('span', { className: 'px-cred-source' }, `来自 ${ref.sourceLabel}`),
      h('span', { className: 'px-cred-purpose' }, ref.purpose ?? ''),
      // 不可移除时把「为什么」和「那该怎么办」写在原地——只画一个禁用的勾选框，
      // 用户不知道下一步该去哪。
      entry.selectable || ref.configured !== true
        ? null
        : h('span', { className: 'px-cred-blocked' }, ref.blockedReason ?? '这一条插件改不了。'))
  }

  /** 一家厂商一块。 */
  const vendorBlock = (provider) => {
    const refs = Array.isArray(provider?.refs) ? provider.refs : []
    const cli = provider?.cliFile
    const entries = credentialRows({ providers: [provider] })
    const anyConfigured = refs.some((ref) => ref.configured === true) || cli?.hasKey === true
    if (!anyConfigured) return null
    return h('div', { key: provider.id, className: 'px-cred-vendor' },
      h('b', { className: 'px-cred-vendor-name' }, provider.name ?? provider.id),
      h('ul', { className: 'px-cred-list' }, entries.map(row)),
      // CLI 密钥文件：**只提示、不提供删除**。插件一直只读别人的密钥文件，
      // 但用户必须知道「移除完这里，那家可能仍然是已配置」。
      cli === undefined || cli.hasKey !== true
        ? null
        : h('p', { className: 'px-cred-cli' },
          h('b', null, '另外还读到一份 CLI 凭据：'),
          h('code', null, cli.path ?? ''),
          ` ${cli.note ?? ''}`))
  }

  const pickedRows = rows.filter((entry) => picked.includes(entry.ref.name))

  return h('div', { className: 'px-cred' },
    h('div', { className: 'px-cred-head' },
      h('b', null, '移除套餐凭据'),
      h('span', { className: 'px-muted' },
        `已配置 ${summary.configured} 条 · 其中可直接移除 ${summary.removable} 条`)),
    h('p', { className: 'px-cred-intro' },
      '勾选之后点「移除」，宿主的凭据服务会把这些名字从',
      h('code', null, credentialFile === undefined || credentialFile === '' ? '凭据文件' : credentialFile),
      '里删掉。移除后这些厂商会回到「未配置」。',
      h('b', null, '此操作不可撤销'),
      '，插件不保留副本——但你可以按每一家「这家凭据怎么配」里的步骤重新配回来。'),

    !canWrite
      ? h('p', { className: 'px-cred-note px-warn' },
        '宿主没有可写的凭据服务，这台机器上无法移除；下面只列出各条的现状。')
      : null,

    localError === ''
      ? null
      : h('p', { className: 'px-balance-state px-error' }, localError),
    error !== undefined && error !== ''
      ? h('p', { className: 'px-balance-state px-error' }, `凭据清单读取失败：${error}`)
      : null,

    h('div', { className: 'px-cred-vendors' },
      (Array.isArray(payload.providers) ? payload.providers : []).map(vendorBlock)),

    // 逐条结果：**成功与失败都照实列出来**。只报「已完成」会让用户以为
    // 那条来自环境变量的也删掉了，而它其实一条都没动。
    results === null
      ? null
      : h('div', { className: 'px-cred-results' },
        h('b', null, '上一次移除的结果'),
        h('ul', null, (Array.isArray(results.results) ? results.results : []).map((item) => h('li', {
          key: item.name,
          className: item.ok === true ? 'ok' : 'bad',
        },
        h('code', null, item.name),
        h('span', null, item.ok === true ? '已移除' : `未移除：${item.message ?? ''}`))))),

    confirming
      ? h('div', { className: 'px-cred-confirm' },
        h('p', null, `确认要从凭据文件里删除下面 ${picked.length} 条吗？删掉之后这些厂商会回到「未配置」。`),
        h('ul', null, pickedRows.map((entry) => h('li', { key: `c-${entry.vendor}-${entry.ref.name}` },
          h('code', null, entry.ref.name),
          h('span', { className: 'px-muted' }, ` ${entry.vendorName}`)))),
        h('div', { className: 'px-cred-actions' },
          h('button', {
            type: 'button',
            className: 'px-btn danger',
            disabled: disabled,
            onClick: submit,
          }, working === true ? '移除中…' : `确认移除 ${picked.length} 条`),
          h('button', {
            type: 'button',
            className: 'px-btn',
            disabled: working === true,
            onClick: () => { setConfirming(false) },
          }, '取消')))
      : h('div', { className: 'px-cred-actions' },
        h('button', {
          type: 'button',
          className: 'px-btn danger',
          // 一条都没勾、或宿主不能写时按钮不可用：**不给一个必然失败的动作**。
          disabled: picked.length === 0 || !canWrite || disabled,
          onClick: () => { setConfirming(true) },
        }, picked.length === 0 ? '移除' : `移除选中的 ${picked.length} 条`)),
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
 * 订阅套餐额度面板：每家的各窗口进度 + 切换器 + 开关 + 隐私说明 + 移除凭据。
 *
 * 这里刻意**不做**任何金额换算：智谱的积分、Command Code 的美元信用额与火山的
 * 积分是几套互不相通的单位，混在一起加总只会得到一个没有意义的数字。
 *
 * 「移除凭据」这一块**不受套餐总开关影响**：关掉监控只是不发请求，
 * 而「我想把这家删掉」与「我要不要看它的额度」是两件事——关着开关反而更需要
 * 那个入口（用户正是准备不再用它了）。
 *
 * 导出是为了让渲染闸门能直接渲染它（面板在整页里是并排两栏之一，单独断言它的
 * 内部结构比从整页 HTML 里切片段更可靠）。
 * @param {object} props - payload / error / busy / now / onToggle / selected / onSelect
 *   / compact / timeZone / credentials / credentialsError / onRemoved。
 * @returns {object} React 元素。
 */
export function PlansPanel(props) {
  const {
    payload, error, busy, now, onToggle, selected, onSelect, compact, timeZone,
    credentials, credentialsError, onRemoved,
  } = props
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
    // 重置时刻要显示成**站点时区**下的日期：与看板其余时间口径一致。
    timeZone,
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

    // 「移除套餐凭据」：折进 <details> 且默认收起。它是**破坏性**动作，
    // 常驻展开会让误触的机会变大；而它也不是日常要看的东西。
    //
    // **一条都没配过时整块（含 summary）都不渲染**：只藏内容会让用户看到一个
    // 点开是空壳的入口——那比没有入口更让人困惑。判据放在这里而不是组件内部，
    // 正是因为 summary 也在这一层。
    credentialSummary(credentials).configured === 0
      ? null
      : h('details', { className: 'px-details px-cred-details' },
        h('summary', null, '移除套餐凭据'),
        h(CredentialRemoval, {
          payload: credentials,
          error: credentialsError,
          onRemoved,
          // 路径优先取清单自己那一份（两处都由宿主解析，值相同）；
          // 清单还没到手时退回套餐负载里的那份，免得这一行空着。
          credentialFile: credentials?.credentialFile ?? payload?.credentialFile,
        })),

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
 * 通知面板：系统通知授权、分类开关、待办与最近通知。
 *
 * 它住在**设置弹层**的「通知」页签里，不再占看板正文的一整张卡片：通知开关是
 * 「偶尔改一次」的东西，而看板要回答的是「花了多少 / 花在哪 / 还剩多少」。
 *
 * 余额预警与套餐额度预警**整体取消**（连同阈值设置）：余额在会话标签页与输入框
 * 费用条里直接看得见，实时弹通知只是重复说同一件事。因此这里只剩授权三态、
 * 开关列表、待办与最近通知。
 * @returns {object} React 元素。
 */
/**
 * 面板里的试听：用**与真实通知完全相同的发声函数**播一次。
 *
 * 为什么必须共用：如果试听另写一套，用户会听到「试听是这个声、真实通知是另一个声」
 * ——那是最难解释的一类不一致，而且只在真跑完一轮时才会暴露。
 *
 * 组件外的时间戳做去重：换选项时 `click` 与 `change` 会先后触发，不去重就会连响两声。
 * 400ms 足够覆盖这两个事件的间隔，又短到不会挡住用户「再点一次再听一次」。
 * @param {string} mode - 下拉框选项值。
 * @param {string} [url] - 自定义音频地址。
 */
let lastPreviewAt = 0
function previewOnce(mode) {
  if (mode === 'system' || mode === 'off') return
  const now = Date.now()
  if (now - lastPreviewAt < 400) return
  lastPreviewAt = now
  try {
    // 自定义音效的地址存在配置里，点击时读**最新**值（ref 由调用方更新）。
    playSound(soundPlan({ notifySound: mode, notifySoundUrl: previewUrl }))
  } catch {
    // 试听失败不影响任何设置：用户还能通过下一次真实通知确认。
  }
}

/** 最近一次渲染看到的自定义音频地址，供试听读取（避免把整份 config 传进模块级函数）。 */
let previewUrl = ''

/**
 * 通知面板（设置弹层的「通知」页签）。
 *
 * **导出是为了闸门能直接渲染它**：弹层默认关着，静态渲染整页永远看不到这块内容，
 * 而「授权三态各写不同的字」「申请授权只在 default 下出现」这些恰恰是最需要断言的
 * ——混成一句「未授权」会让用户反复点一个不会有任何反应的按钮。
 * @returns {object} React 元素。
 */
export function NotifyPanel() {
  const store = useMemo(() => notifyStore(), [])
  const snapshot = useNotifySnapshot(store)
  const config = { ...NOTIFY_DEFAULTS, ...(snapshot.config ?? {}) }
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

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
  const soundMode = typeof config.notifySound === 'string' ? config.notifySound : 'system'
  // 试听函数是模块级的（不进组件闭包），自定义音频地址在这里同步给它。
  previewUrl = typeof config.notifySoundUrl === 'string' ? config.notifySoundUrl : ''

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

    // ── 提示音 ────────────────────────────────────────────────────
    // 只影响**本插件的通知**，不动 Windows 全局声音设置：
    // 选「关闭」或任一自定义音效时，我们给系统通知加 `silent`，
    // 再由插件自己发声（内置音效现场合成，自定义给个音频地址）。
    h('div', { className: 'px-notify-flags' },
      h('label', { className: 'px-notify-flag px-notify-sound', title: '只影响 DSH 的通知气泡，不改 Windows 全局声音设置' },
        h('span', null, '提示音'),
        h('select', {
          className: 'px-input px-notify-sound-select',
          value: soundMode,
          disabled: saving,
          // 点开下拉就先响一声当前选项。
          // 原生 <select> 在「重复选中同一项」时**不触发 change**，只靠 onChange 的话
          // 「再点一次听一遍」会没声音；而加个试听按钮又多余。两个入口都接上，
          // 再用 400ms 去重，避免换选项时连响两次。
          onClick: () => { previewOnce(soundMode) },
          onChange: (event) => {
            const next = event.target.value
            save({ notifySound: next })
            // 切到能自己发声的音效就**当场试听一遍**：否则用户只能等下一次
            // 通知才知道自己选的是什么声音，选错了也无从发现。
            previewOnce(next)
          },
        },
        NOTIFY_SOUND_OPTIONS.map((option) => h('option', {
          key: option.value,
          value: option.value,
          title: option.hint,
        }, option.label))))),
    soundMode === 'system' || soundMode === 'off'
      ? null
      : h('p', { className: 'px-muted px-note px-notify-sound-note' },
        soundMode === 'system'
          ? ''
          : '「跟随系统」和「关闭」没有可试听的声音——前者交给系统，后者就是不响。'),
    soundMode === 'custom'
      ? h('div', { className: 'px-notify-flags' },
        h('label', { className: 'px-notify-flag px-notify-sound', title: 'http(s) 音频链接，或 data:audio/… 内联音频' },
          h('span', null, '音频地址'),
          h('input', {
            type: 'text',
            className: 'px-input px-notify-sound-url',
            defaultValue: config.notifySoundUrl ?? '',
            placeholder: 'https://example.com/done.mp3',
            disabled: saving,
            onBlur: (event) => { save({ notifySoundUrl: event.target.value.trim() }) },
            onKeyDown: (event) => { if (event.key === 'Enter') { save({ notifySoundUrl: event.target.value.trim() }) } },
          })))
      : null,


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
          // 带会话 id 的才可点：不属于任何会话的记录（例如权限与测试通知）
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
        '余额与套餐额度不再实时弹通知——在会话标签页与输入框上方的费用条里直接看，'
        + '比每条都提醒一次省事得多。',
        '刷新页面会清空「最近通知」，一切都只在内存里，不写任何文件。')),
  )
}

/**
 * 模型分布：环图 + 条形占比（按当前时间窗口）。
 *
 * 一条 = **模型 × 提供商**，与费用明细同一口径：同一个 DeepSeek 模型经三条路由
 * 调用就是三份用量（单价与额度归属都不同），而 `模型路由名 + 模型外显名` 那种
 * 「名字里有两条信息」的展示让人分不清哪一条才是模型。
 *
 * 只画**聚焦集合**（达到消耗阈值、最近使用的 N 款）：看这张图要回答的是「谁占大头」，
 * 一二十条长尾条目会把环图切成一圈无法辨认的细线。
 * @param {object} props - rows / rangeTotals / totalRows / minTokens / fellBack。
 * @returns {object} React 元素。
 */
function ModelBreakdown(props) {
  const { rows: focused, rangeTotals, totalRows, minTokens, fellBack } = props
  const rows = Array.isArray(focused) ? focused : []
  const visible = rows
    .filter((row) => Number(row.tokens ?? 0) > 0)
    .map((row) => {
      const share = rangeTotals.local > 0 ? (Number(row.tokens) / rangeTotals.local) * 100 : 0
      return {
        key: row.key,
        label: row.model?.label ?? row.key,
        // 颜色来自 `models` 的**原始下标**（见 View 里的 modelFocus），
        // 与费用明细、单价列表完全同源。
        tone: row.tone,
        value: Number(row.tokens),
        text: `${formatTokens(row.tokens)} · ${share.toFixed(1)}%`,
      }
    })
  if (visible.length === 0) {
    return h('p', { className: 'px-muted' }, '当前时间窗口内没有模型调用。')
  }
  const biggest = visible.reduce((best, row) => (row.value > best.value ? row : best), visible[0])
  return h('div', { className: 'px-model-grid' },
    h(DonutChart, {
      slices: visible.map((row) => ({ key: row.key, value: row.value, tone: row.tone })),
      centerTitle: '窗口内 token',
      // 中心是**整个窗口**的总量：环上只画聚焦的那几款，但「这个窗口一共用了多少」
      // 才是读者要对的那个数，换成一个「显示中的小计」会让人以为总量变小了。
      centerValue: formatTokens(rangeTotals.local),
    }),
    h('div', { className: 'px-model-side' },
      h(BarList, { rows: visible }),
      h('p', { className: 'px-muted px-note' },
        `共 ${Number(totalRows ?? visible.length)} 个「模型 × 提供商」条目 · `
        + `最大一项：${biggest.label}（${formatTokens(biggest.value)}）· `
        + (fellBack === true
          ? `没有模型达到 ${formatTokens(minTokens)}，按用量取前 ${visible.length} 款`
          : `只统计 ≥ ${formatTokens(minTokens)} 的模型`))))
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
 *
 * ## 合计行 = 上表各行之和（不是窗口合计）
 *
 * 这张表默认只列**达到消耗阈值、最近使用的那几款**（长尾条目收在「展开全部」里）。
 * 因此合计行必须是**上表几行之和**——否则「合计」与它下面看得见的明细对不上，
 * 而那种矛盾会让读者不再相信任何一个数字。窗口总计与「未列出的那部分」写在
 * 表下那一行里，两者相加就是窗口合计。
 * @param {object} props - rows / pricing / myPricing / showMyRate / rangeCost / restCost / rangeLabel / onRatesSaved。
 * @returns {object} React 元素。
 */
function CostTable(props) {
  const {
    rows: focused, pricing, myPricing, showMyRate,
    rangeCost, restCost, rangeLabel, onRatesSaved,
  } = props

  const rows = (Array.isArray(focused) ? focused : []).map((entry) => {
    const model = entry.model ?? {}
    const key = entry.key
    const usage = entry.usage ?? {}
    // 价目优先用宿主**逐条**交下来的那一份（含 GLM 这类原生 id 查不到的情况），
    // 拿不到才退回整张价目表。
    const rates = model.rates ?? ratesFor(pricing, key)
    return {
      key,
      label: typeof model.label === 'string' && model.label !== '' ? model.label : key,
      provider: typeof model.provider === 'string' ? model.provider : '',
      providerLabel: typeof model.providerLabel === 'string' ? model.providerLabel : '',
      rollup: typeof model.rollup === 'string' && model.rollup !== '' ? model.rollup : key,
      // 这一条合并了哪些路由 id，悬停可查（同一个模型在网关里有多个叫法是常态）
      routes: Array.isArray(model.routes) ? model.routes.filter((name) => typeof name === 'string') : [],
      rates,
      // 配色按**在 `models` 里的原始下标**取（由 View 的 modelFocus 算好），
      // 与「模型分布」环图完全同源。
      tone: entry.tone,
      // 不分时的模型 peak 与 idle 相同；按 peak 判定即可
      flat: Number(rates.cacheMiss?.peak ?? 0) === Number(rates.cacheMiss?.idle ?? 0)
        && Number(rates.output?.peak ?? 0) === Number(rates.output?.idle ?? 0),
      // 宿主标注的可信度：兜底价要显式说明，别让猜的数字看起来像官方价
      priced: model.priced !== false,
      tiered: model.tiered === true,
      cost: priceByModel({ [key]: usage }, pricing),
      // 「我的价」只在勾了复选框时才算：没勾的时候算出来是白算，还会让人
      // 以为界面在用一个看不见的价目。
      myCost: showMyRate === true ? priceByModel({ [key]: usage }, myPricing ?? pricing) : undefined,
      peak: peakTokensOf(usage),
      idle: idleTokensOf(usage),
      total: Number(usage.local ?? 0),
    }
  })

  if (rows.length === 0) {
    return h('p', { className: 'px-muted' },
      '当前时间窗口内没有模型调用。换一个时间窗口，或去设置里把模型消耗阈值调低。')
  }

  const anyTiered = rows.some((row) => row.tiered)
  const anyUnpriced = rows.some((row) => !row.priced)
  const anyUnknownProvider = rows.some((row) => row.provider === '')
  const anyFlat = rows.some((row) => row.flat)
  const anyMyRate = showMyRate === true

  /**
   * 单价按**模型**归组，而不是逐条（逐提供商）重复列出。
   *
   * 依据是一个事实：**价目表本身就按模型索引**（`MODEL_RATES` 的键里没有提供商）。
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

  // 合计行严格等于上表各行之和（见函数说明最后一段）
  const totalPeak = rows.reduce((sum, row) => sum + (row.flat ? row.total : row.peak), 0)
  const totalIdle = rows.reduce((sum, row) => sum + (row.flat ? 0 : row.idle), 0)
  const totalCost = rows.reduce((sum, row) => sum + row.cost.standard, 0)
  const totalMy = rows.reduce((sum, row) => sum + (row.myCost?.standard ?? 0), 0)
  const rest = restCost ?? { standard: 0, count: 0 }

  /** 某一组有没有被用户改过价（改过才多画一行「我的价」）。 */
  const myRateOf = (groupKey) => {
    if (showMyRate !== true || myPricing === undefined || myPricing === null) return undefined
    const mine = myPricing.models?.[groupKey] ?? myPricing.rates?.[groupKey]
    const official = pricing?.models?.[groupKey] ?? pricing?.rates?.[groupKey]
    if (mine === undefined || mine === official) return undefined
    return mine
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
            h('th', { className: 'px-num' }, `${rangeLabel}金额`),
            // 「我的价」只在勾选后出现：平时多一列全是同一个数的金额，
            // 只会让人以为是两条不同的账。
            anyMyRate ? h('th', { className: 'px-num' }, '我的价') : null)),
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
                row.tiered ? h('span', { className: 'px-badge' }, '按最低档') : null,
                // 补价入口：定价工作流提供（点开浮层改这一条的单价，改完金额立刻重算）。
                // `rate` 与 `pricing` 必须传：浮层要按**当前生效价**预填六个框，
                // 不传的话打开就是六个空框——用户既看不出现在是多少，也容易只填一半。
                h(PriceSettingsButton, {
                  modelKey: row.rollup,
                  label: row.label,
                  rate: row.rates,
                  pricing,
                  onSaved: onRatesSaved,
                })),
              h('td', null, row.provider === ''
                ? h('span', { className: 'px-muted', title: '旧账本记录里没有提供商信息' }, '来源未知')
                : (row.providerLabel === '' ? row.provider : row.providerLabel)),
              h('td', { className: 'px-num' }, formatTokens(peak)),
              // 不分时的那一格写成「—」而不是留空：留空会让人以为数据丢了
              h('td', { className: 'px-num' }, idle === null ? h('span', { className: 'px-muted' }, '—') : formatTokens(idle)),
              h('td', { className: 'px-num' }, formatCny(row.cost.standard)),
              anyMyRate
                ? h('td', { className: 'px-num px-my-rate' },
                  row.myCost === undefined ? h('span', { className: 'px-muted' }, '—') : formatCny(row.myCost.standard))
                : null)
          }),
          h('tr', { className: 'px-row-total' },
            h('td', null, '合计'),
            h('td', null, ''),
            h('td', { className: 'px-num' }, formatTokens(totalPeak)),
            h('td', { className: 'px-num' }, formatTokens(totalIdle)),
            h('td', { className: 'px-num' }, formatCny(totalCost)),
            anyMyRate ? h('td', { className: 'px-num px-my-rate' }, formatCny(totalMy)) : null)))),

    // 合计与窗口的关系：这张表只列了聚焦的那几款，剩下的必须有个去处，
    // 否则「合计」比上面那张概览卡小一截，读者会以为哪边算错了。
    h('p', { className: 'px-model-sum' },
      `上表合计 ${formatCny(totalCost)}`,
      rest.count > 0
        ? `（另 ${rest.count} 款未列出，合计 ${formatCny(rest.standard)}）`
        : '',
      `· 窗口合计 ${formatCny(rangeCost.standard)}`),

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
        const mine = myRateOf(group.key)
        return h('div', { key: `rate-${group.key}`, className: 'px-rate' },
          // 色块与模型名是**两个兄弟列**，不是「色块挤在名称前面」：
          //   第 1 列 = 色块（本行有几个来源就几个方块）
          //   第 2 列 = 模型名 + 归一后的键 + 来源数
          // 这一列宽度由全表最宽的那一组决定，名称左边界一致。
          h('span', { className: 'px-rate-tones' },
            group.rows.map((item) => h('i', {
              key: item.key,
              // **必须用背景色类**，不能用 `toneFill()`：后者产出的是
              // `px-tone-fill-*`，那是给 SVG 设 `fill` 的类。这里的色块是 HTML
              // 的 `<i>`，`fill` 对它的背景毫无作用——色块会变成全透明。
              className: `px-rate-swatch ${toneBg(item.tone)}`,
              title: item.providerLabel === '' ? '来源未知' : item.providerLabel,
            }))),
          h('span', { className: 'px-rate-who' },
            h('b', null, officialLabel),
            h('span', { className: 'px-muted px-mono' }, group.key),
            row.priced ? null : h('span', { className: 'px-badge' }, '估算价'),
            mine === undefined ? null : h('span', { className: 'px-badge px-my-rate-badge' }, '我的价'),
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
                : `¥${row.rates.output.idle} / ¥${row.rates.output.peak}`))),
          // 「我的价」在**同一行的第二行**里给出来：官方价与我的价的关系是
          // 「同一个模型的两种价」，并排放才看得出差多少。
          mine === undefined
            ? null
            : h('span', { className: 'px-rate-prices px-rate-mine' },
              h('span', null, h('em', null, '我的 · 缓存命中'), h('code', null, `¥${mine.cacheHit?.peak ?? 0}`)),
              h('span', null, h('em', null, '我的 · 未命中'), h('code', null, `¥${mine.cacheMiss?.peak ?? 0}`)),
              h('span', null, h('em', null, '我的 · 输出'), h('code', null, `¥${mine.output?.peak ?? 0}`))))
      })),

    // 面板底部**不写常驻说明**：单价单位、金额口径这类「恒为真」的话每块面板都
    // 摆一遍，等于让人每次看数字前先跨过一段文字（用户明确要求删过）。它们该在
    // README 的「计费口径」里。这里只留**会改变你对上面那些数字的理解**的三句。
    h('p', { className: 'px-muted px-note' },
      anyFlat
        // 表里同时有「一个价」和「两个价」的行时，必须说明差别；
        // 只写一个值的模型不分时（高峰与空闲同价），这是读者最常问的那一句。
        ? '写成一个值的模型不分时（高峰与空闲同价），写成两个值的按「空闲 / 高峰」分档。'
        : '',
      anyMyRate ? '标「我的价」的模型用你在设置里补的单价，用来和官方价对照。' : '',
      anyTiered ? '标「按最低档」的模型官方按输入长度分档定价，这里只按最低档估算。' : '',
      anyUnpriced ? '标「估算价」的模型不在价目表里，暂按 Flash 单价估算，仅供参考。' : '',
      anyUnknownProvider
        ? '标「来源未知」的条目来自旧版账本——那时的记录没有提供商字段。'
          + '重新导入本机会话日志后，新旧记录会合并到同一个「模型 × 提供商」条目下。'
        : ''))
}

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
function HeroCard(props) {
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
function DetailRow(props) {
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
function TimingBreakdownView(props) {
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
 *   3. **耗时构成环形图**——回答「时间花在哪」
 *   4. 两栏明细：花费与时段 / 时间与模型
 *   5. 请求分布条
 *
 * ## 时间口径（用户纠正的关键点）
 *
 * 「活跃时长 = 创建到最后使用」被用户否掉了：会话放三周再用，会被算成几百小时。
 * 现在 hero 里的「模型耗时」= 等待 + 回复 + 工具，即**模型真正在干活的那段时间**；
 * 「平均每轮」= 模型耗时 / 轮次。这才是「我花了多少时间等它」。
 * @param {object} props - lead / members / timezone。
 * @returns {object} React 元素。
 */
export function SessionDetail(props) {
  const { lead, members, timezone } = props
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

  // 耗时构成：环形图 + 图例（对齐 dsh-context 的耗时统计）
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
      h(DetailRow, { tone: 'accent', label: '模型 × 提供商', value: session.models.join('、') || '—' }))),

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

/**
 * 会话清单表。
 *
 * ## 设计审计（第二轮，用户要求「不要只改我说的地方」）
 *
 * 逐条问过「这样对吗、有依据吗、失效时什么样」，结论如下：
 *
 * 1. **默认排序**：按最后使用倒序。旧宿主无 `lastAt` 时退回 `createdAt`，
 *    保证排序永远稳定——否则那一批会话会挤到最前，看起来像排序坏了。
 * 2. **交互**：点标题跳会话（有副作用的导航），点其余区域就地展开（无副作用）。
 *    把跳转钉在标题上，避免「想展开却切走了会话」。
 * 3. **展开态必须看得出来**：行首 ▸/▾ 箭头 + **整行粉色底**（同一时刻只展开一行，
 *    所以不会出现用户担心的满屏碎色块）。
 * 4. **团队**：lead 行标「团队 · N 名成员」；成员不占行，展开后以**标签页**切换，
 *    标签用 DSH 官方称呼（Lead / 成员名），而不是内部视角的「本会话」。
 * 5. **时长的相对尺度**：详情里有对比条，参照系是**本列表内最久的会话**——
 *    绝对尺度会让大多数会话缩成看不见的线。
 * 6. **旧宿主兼容**：缺字段一律显示 `—`，不显示 0（「不知道」≠「零」）。
 * @param {object} props - sessions / timezone / onOpenSession。
 * @returns {object} React 元素。
 */
export function SessionTable(props) {
  const { sessions, timezone } = props
  // 一次只展开一行：多行同时展开会让表格高度剧烈跳动。
  const [expanded, setExpanded] = React.useState('')

  if (sessions.length === 0) return h('p', { className: 'px-muted' }, '还没有会话记录。')

  const lastOf = (session) => Number(session.lastAt ?? 0) || Number(session.createdAt ?? 0)
  // ── 团队归组：成员挂在 lead 下，不自己成为一行 ──────────────────────
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const membersOf = new Map()
  const roots = []
  for (const session of sessions) {
    if (session.role === 'teammate' && typeof session.teamId === 'string' && byId.has(session.teamId)) {
      const list = membersOf.get(session.teamId) ?? []
      list.push(session)
      membersOf.set(session.teamId, list)
    } else {
      roots.push(session)
    }
  }
  for (const list of membersOf.values()) {
    list.sort((a, b) => (Number(a.depth ?? 1) - Number(b.depth ?? 1)) || (lastOf(b) - lastOf(a)))
  }
  roots.sort((a, b) => lastOf(b) - lastOf(a))

  // ── 先算出所有行，再套 h() ─────────────────────────────────────────
  //
  // 早先这里是嵌套的 h(tbody, null, map(...).flat())，括号层数一多就极难数对
  // （我为这一处连续改错三次，还误伤过别的表格）。改成「先拼数组、再交给 h()」后
  // 结构一眼可数，也让「详情行」这种可变行数的拼接变得可控。
  const bodyRows = []
  for (const session of roots.slice(0, 40)) {
    const shortId = `${String(session.id).slice(8, 16)}…`
    const workspace = typeof session.workspace === 'string' ? session.workspace : ''
    const raw = typeof session.title === 'string' ? session.title.trim() : ''
    // 与 DSH 侧栏的 displayTitleOf 同一条回落链：持久标题 → 工作目录末段 → 会话 id。
    // 宿主已经算好了同样的链，这里再走一遍是为了**旧宿主**——它不返回 title，
    // 只有 workspace；那时至少显示目录名（用户认得出），而不是退回一串十六进制。
    const title = raw !== '' ? raw : (workspace !== '' ? workspace : shortId)
    const showWorkspace = workspace !== '' && workspace !== title
    const isOpen = expanded === session.id
    const members = membersOf.get(session.id) ?? []
    const openTitle = (event) => {
      if (typeof props.onOpenSession !== 'function') return
      event.stopPropagation()
      props.onOpenSession(session.id)
    }
    bodyRows.push(h('tr', {
      key: session.id,
      className: `px-session-row${isOpen ? ' px-session-row-open' : ''}`,
      'aria-expanded': isOpen,
      onClick: () => { setExpanded(isOpen ? '' : session.id) },
    },
    // 折叠箭头：可发现性的落点，展开时旋转 90°。
    h('td', { className: 'px-session-chev' },
      h('span', { className: `px-chev${isOpen ? ' px-chev-open' : ''}`, 'aria-hidden': 'true' }, '▸')),
    h('td', { className: 'px-session-when' },
      formatDateTime(Number(session.lastAt ?? 0) || session.createdAt, timezone)),
    h('td', null,
      h('div', { className: 'px-session-cell-inner' },
      h('span', {
        className: 'px-session-title px-session-link',
        role: 'link',
        tabIndex: 0,
        title: `${title}\n${session.id}`,
        onClick: openTitle,
        onKeyDown: (event) => { if (event.key === 'Enter') openTitle(event) },
      }, title),
      session.live ? h('span', { className: 'px-badge ok' }, '进行中') : null,
      // 团队标记：写明成员数，不展开也知道这个会话背后有团队。
      members.length > 0
        ? h('span', { className: 'px-badge team', title: '展开后可用标签页查看每个成员' },
          `团队 · ${members.length} 名成员`)
        : null,
      showWorkspace
        ? h('span', { className: 'px-session-workspace', title: session.cwd ?? '' }, workspace)
        : null,
      // 会话 id 只在这里以次要样式出现（悬停可复制）；**不进详情卡片**——
      // 用户明确说它对分析没用。
      h('span', { className: 'px-session-id px-mono', title: session.id }, shortId))),
    h('td', null, String(session.turns)),
    h('td', null, formatTokens(session.totals.local)),
    h('td', null, formatSpan(session.firstAt, session.lastAt))))

    if (isOpen) {
      bodyRows.push(h('tr', { key: `${session.id}-detail`, className: 'px-session-detail-row' },
        h('td', { colSpan: 6 }, h(SessionDetail, { lead: session, members, timezone }))))
    }
  }

  const headerRow = h('tr', null,
    h('th', { className: 'px-session-chev', 'aria-label': '展开' }),
    h('th', { title: '最后一次活动的时刻' }, '最后使用'),
    h('th', null, '会话'),
    h('th', null, '轮次'),
    h('th', null, 'Token'),
    h('th', { title: '从首次活动到最后一次活动的跨度——人真正付出的是时间' }, '活跃时长'))

  return h('div', { className: 'px-table-wrap' },
    h('table', { className: 'px-table px-session-table' },
      h('thead', null, headerRow),
      h('tbody', null, bodyRows)))
}
