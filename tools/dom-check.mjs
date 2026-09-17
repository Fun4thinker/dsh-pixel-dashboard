/**
 * 真实 DOM 闸门：用 jsdom + react-dom/client **真的渲染**侧栏那一行，
 * 然后断言**产出的 DOM 结构与顺序**。
 *
 * ## 为什么要单独有这一关
 *
 * 其它几关用的是 `renderToStaticMarkup`（服务端渲染），它拿不到 DOM，
 * 因此凡是「东西被放到哪里去了」这类问题都测不到——只能靠查源码字符串。
 * 而这一块连续踩过两次同一个坑：
 *   1. 倒计时用绝对定位 + `right`，而那个 right 是相对**图标槽**解析的
 *      （图标槽只有十几像素宽）→ 文字怎么都离不开柱状图标；
 *   2. 认 row 靠量宽度（≥100px），在收起动画 / 首帧没布局时会认错。
 *
 * 字符串断言对这两件事都无能为力（代码「看起来对」，但产出的 DOM 是错的）。
 * 这一关改成在**真实 DOM** 里跑，直接问结构问题：
 *   - 倒计时是不是真的挂在了产品的 row（那个 button）里？
 *   - 它是不是排在图标槽**之后**？
 *   - 一个 `<button>` 里套了插槽、插槽里套着我们的图标——`closest('button')`
 *     能不能拿到 row？
 *
 * 用 jsdom 而不是自己手搓替身：手搓替身的 `closest` / `parentElement` 都是
 * 我们自己写的，写错了就会像前两次那样「闸门全绿、线上还是错的」。
 *
 * 用法: node tools/dom-check.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** 断言工具。 */
function must(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * 取一个元素的 class 字符串。
 *
 * **不能用 `el.className`**：SVG 元素的 `className` 是一个 `SVGAnimatedString`
 * 对象（不是字符串），对它调 `.includes()` 会抛 TypeError。那虽然也算「失败」，
 * 但抛出来的是毫无信息量的错——闸门要的是**说清楚哪里不对**，
 * 所以统一走 `getAttribute('class')`。
 * @param {Element} el - 元素。
 * @returns {string} class 字符串（没有则为空串）。
 */
function classOf(el) {
  if (el === null || el === undefined) return ''
  const attr = typeof el.getAttribute === 'function' ? el.getAttribute('class') : null
  if (typeof attr === 'string') return attr
  return typeof el.className === 'string' ? el.className : ''
}

/**
 * 定位校验用的 React / react-dom。
 *
 * 与 render-check.mjs 同一套解析策略：检出位置不写死盘符，可被 DSH_CHECKOUT 覆盖。
 * @returns {string|undefined} pnpm 目录。
 */
function resolvePnpmDir() {
  const candidates = []
  const explicit = process.env.DSH_CHECKOUT
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    candidates.push(join(explicit.trim(), 'node_modules', '.pnpm'))
  }
  for (const drive of ['D:', 'E:', 'C:']) {
    candidates.push(`${drive}/deepseek-harness/node_modules/.pnpm`)
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'react@18.3.1', 'node_modules', 'react'))) return candidate
  }
  return undefined
}

const PNPM = resolvePnpmDir()
if (PNPM === undefined) {
  console.error('找不到用于校验的 React（react@18.3.1）。')
  console.error('请把 DSH 检出路径通过环境变量 DSH_CHECKOUT 指出来。')
  process.exit(1)
}
const REACT_DIR = `${PNPM}/react@18.3.1/node_modules/react`
const REACT_DOM_DIR = `${PNPM}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom`
// jsdom 从检出目录解析（本插件刻意不带任何依赖）。找不到就**明确报错**，
// 不静默跳过——静默跳过正是这一关要防的东西。
const JSDOM_DIR = [
  join(root, 'node_modules', 'jsdom'),
  join(PNPM, '..', 'jsdom'),
  'E:/deepseek-harness/node_modules/jsdom',
  'D:/deepseek-harness/node_modules/jsdom',
].find((candidate) => existsSync(join(candidate, 'lib', 'api.js')))
if (JSDOM_DIR === undefined) {
  console.error('找不到 jsdom，无法跑真实 DOM 闸门。')
  console.error('这一关刻意不静默跳过：它验的正是「东西被放到哪里去了」，')
  console.error('而字符串断言对这类问题无能为力。')
  process.exit(1)
}
if (!existsSync(`${REACT_DIR}/index.js`) || !existsSync(`${REACT_DOM_DIR}/index.js`)) {
  console.error(`pnpm 目录 ${PNPM} 里缺少 react 18.3.1 / react-dom 18.3.1`)
  process.exit(1)
}

// ── 建 jsdom 环境，并把 react / react-dom / jsdom 都接上 loader 别名 ──
const { JSDOM } = await import(pathToFileURL(join(JSDOM_DIR, 'lib', 'api.js')).href)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const { window } = dom
// React 需要的那几个全局量：插件在浏览器里能用的，这里也照实提供。
globalThis.window = window
globalThis.document = window.document
// Node 18+ 自带一个只读的全局 navigator，不能直接赋值（会 TypeError）。
Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator, configurable: true, writable: true,
})
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.MutationObserver = window.MutationObserver
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = (fn) => setTimeout(() => { fn(Date.now()) }, 0)
globalThis.cancelAnimationFrame = (handle) => { clearTimeout(handle) }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
// jsdom 没有 ResizeObserver；产品与插件都靠它观察布局。给一个**会被记录**的替身，
// 这样「观察了谁」也是可断言的，而不是让插件静默走降级分支。
const resizeObservers = []
globalThis.ResizeObserver = class FakeResizeObserver {
  constructor(callback) { this.callback = callback; this.targets = []; resizeObservers.push(this) }
  observe(target) { this.targets.push(target) }
  disconnect() { this.targets = [] }
}
// 时段路由：倒计时的相位靠它取。不 stub 的话 usePeriodPhase 会安静地降级、
// 倒计时永远不渲染，而闸门却以为「没有倒计时是正常的」。
globalThis.fetch = async (url) => {
  if (String(url).includes('/dsh-pixel/period')) {
    // generatedAt 必须是**当下**：usePeriodPhase 会按 (now - generatedAt) 本地递减，
    // 给一个远古时间戳会让剩余时间直接夹到 0（显示「0秒后空闲期」）。
    //
    // 再多给 30 秒余量：剩余时长按分钟向下取整，若正好卡在 45:00，那么挂载到
    // 断言之间哪怕只过了几毫秒，显示也会从「45分」掉到「44分」——
    // 闸门就会随机变红（实测踩过）。留出余量后这段时间无论怎么抖动都是 45 分。
    return {
      ok: true,
      status: 200,
      json: async () => phaseSnapshot({
        generatedAt: Date.now(),
        nextChangeMs: 45 * 60_000 + 30_000,
      }),
    }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

const React = (await import(pathToFileURL(`${REACT_DIR}/index.js`).href)).default
const ReactDom = await import(pathToFileURL(`${REACT_DOM_DIR}/index.js`).href)
const ReactDomClient = await import(pathToFileURL(`${REACT_DOM_DIR}/client.js`).href)
const { createRoot } = ReactDomClient

/** 让源码里的裸包名解析到上面那两份 React。 */
const ALIASES = new Map([
  ['react', pathToFileURL(`${REACT_DIR}/index.js`).href],
  ['react/jsx-runtime', pathToFileURL(`${REACT_DIR}/jsx-runtime.js`).href],
  ['react-dom', pathToFileURL(`${REACT_DIR}/index.js`).href],
  ['react-dom/client', pathToFileURL(`${REACT_DOM_DIR}/client.js`).href],
])
const { register } = await import('node:module')
register(
  `data:text/javascript,${encodeURIComponent(`
    const aliases = new Map(${JSON.stringify([...ALIASES])})
    export async function resolve(specifier, context, nextResolve) {
      const mapped = aliases.get(specifier)
      if (mapped !== undefined) return { url: mapped, shortCircuit: true }
      return nextResolve(specifier, context)
    }
  `)}`,
  import.meta.url,
)

/** 把 React 的异步更新跑完。 */
async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await React.act(async () => { await Promise.resolve() })
  }
}

// ── 复刻产品侧栏那一行的真实结构 ─────────────────────────────────
// 依据 packages/client/ui-sidebar/src/client/SidebarRoot.tsx 的 PanelRow：
//
//   <button class="panelRow">              ← 产品渲染的行（就是我们 portal 的目标）
//     <span class="panelGlyph">            ← 图标槽，flex: none（只有十几像素宽）
//       {renderSlot('sidebar.panellist')}  ← **我们的插槽长在这里**
//     </span>
//     {wide && <span class="panelTitle">用量看板</span>}   ← 标题，排在我们之后
//   </button>
//
// 这个结构是**外部事实**，因此照实复刻；结构与产品不符时这一关会失真，
// 所以下面同时断言了几个它赖以成立的前提。
/**
 * 造一行产品侧栏 DOM。
 * @param {object} [options] - wide 为 false 时模拟收起成图标条。
 * @returns {{button:Element,glyph:Element,title:Element|null}} 关键节点。
 */
function buildProductRow(options = {}) {
  const wide = options.wide !== false
  const button = window.document.createElement('button')
  button.type = 'button'
  button.className = 'panelRow'
  const glyph = window.document.createElement('span')
  glyph.className = 'panelGlyph'
  button.appendChild(glyph)
  let title = null
  if (wide) {
    title = window.document.createElement('span')
    title.className = 'panelTitle'
    title.textContent = '用量看板'
    button.appendChild(title)
  }
  window.document.body.appendChild(button)
  return { button, glyph, title }
}

/** 造一份相位快照。 */
function phaseSnapshot(options = {}) {
  const periodMs = options.periodMs ?? 180 * 60_000
  const nextChangeMs = options.nextChangeMs ?? 45 * 60_000
  return {
    generatedAt: options.generatedAt ?? 1_000_000,
    timezone: 'Asia/Shanghai',
    period: {
      peak: options.peak ?? true,
      minuteOfDay: 675,
      weekday: 4,
      nextChangeMs,
      prevChangeMs: periodMs - nextChangeMs,
      periodMs,
      nextPeak: !(options.peak ?? true),
      label: (options.peak ?? true) ? '高峰时段' : '空闲时段',
    },
  }
}

const { periodPhase, PeriodDot } = await import(
  pathToFileURL(join(root, 'lib', 'client', 'period.js')).href
)
const peakPhase = periodPhase(phaseSnapshot({ peak: true }), 1_000_000)
const idlePhase = periodPhase(phaseSnapshot({ peak: false }), 1_000_000)

/**
 * 拿到**真正的**面板入口组件（侧栏那个按钮）。
 *
 * 前面几段的断言都只渲染 `PeriodDot`，也就是倒计时**那一小块**——它们看不到
 * 组件真正长在什么里面，因此漏掉了一整类 bug：面板入口自己渲染了一个
 * `<button>`，而那个按钮套在产品的 row 按钮里面，于是「最近的 button 祖先」
 * 命中的是我们自己、而不是产品那一行。倒计时因此永远判定成「放不下」而不显示，
 * 且完全不报错。
 *
 * 这一段改成把**注册进去的那个组件**真实挂载到仿真出来的产品行里，
 * 于是「它到底把东西放哪了」才是真的被测到。
 * @returns {Promise<Function>} 面板入口组件。
 */
async function loadPanelEntryComponent() {
  let factory
  // 产物的入口靠 window.__ModuleLoader__.load({ id, factory }) 注册，
  // 与 render-check 同一套做法。
  globalThis.window.__ModuleLoader__ = {
    load: (registration) => { factory = registration.factory },
  }
  await import(pathToFileURL(join(root, 'lib', 'client.js')).href)
  if (typeof factory !== 'function') throw new Error('产物没有注册模块工厂（lib/client.js）')
  // 工厂收到的是**平台的 require**：裸包名（react / react-dom）由它解析。
  // 产物内部的模块走自己的注册表，只有这两个会落到这里。
  const platformRequire = (id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return ReactDom
    throw new Error(`dom-check 的替身平台不认识模块：${String(id)}`)
  }
  const platform = factory(platformRequire)
  const registrations = []
  // 槽位服务的最小替身：产物用 slots.inject(name, fn) 声明「我要往哪个槽里放」，
  // 回调里再 slots.register(spec, component) 真正登记。两边都记下来。
  const slots = {
    register: (spec, component) => { registrations.push({ spec, component }); return () => {} },
    inject: (name, register) => { register() },
  }
  const ctx = {
    effect: () => {},
    get: (name) => (name === 'slots' ? slots : undefined),
    provide: () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    on: () => {},
  }
  platform.apply(ctx)
  const entry = registrations.find((item) => item.spec?.name === 'sidebar.panellist')
  if (entry === undefined) {
    throw new Error(`没有注册 sidebar.panellist 槽位，实际注册了：${registrations.map((r) => r.spec?.name).join(', ')}`)
  }
  return entry.component
}

const PanelEntry = await loadPanelEntryComponent()

/** 仍然挂载着的 React 根，收尾时统一卸载。 */
const liveRoots = []

/** 渲染任意元素到指定容器。 */
async function renderInto(container, element) {
  const root2 = createRoot(container)
  liveRoots.push(root2)
  await React.act(async () => { root2.render(element) })
  await settle()
  return root2
}

/**
 * 卸载所有还挂着的根。
 *
 * 必须做：面板入口里的 `usePeriodPhase` 每秒会 `setInterval` 一次并 setState。
 * 测试跑完后那个定时器还在，下一次 tick 就会在 act 之外更新状态，React 会警告
 * 「update not wrapped in act」——而且断言可能读到「还没落地」的状态。
 * 卸载会把 effect 的清理函数跑掉，定时器随之停。
 * @returns {Promise<void>} 卸载完成。
 */
async function unmountAll() {
  const roots = liveRoots.splice(0)
  for (const root2 of roots) {
    await React.act(async () => { root2.unmount() })
  }
}

/**
 * 把**真正的面板入口组件**挂进一行仿真出来的产品 DOM。
 *
 * 产品那一行是 `<button class="panelRow">`，我们拿到的插槽在里面的
 * `<span class="panelGlyph">` 中——**这里必须照实复刻**，因为「我们自己渲染的
 * 按钮套在产品按钮里面」正是漏掉的那个 bug 的成因。
 *
 * jsdom 不做布局，`getBoundingClientRect()` 一律返回 0。所以在**挂载之前**
 * 就把 row 的宽度写死，effect 里那次测量才量得到真实值——这正是真实浏览器里
 * 的情形（挂载时布局已经就绪）。
 * @param {object} [options] - wide 为 false 时模拟收起成图标条；width 指定行宽。
 * @returns {Promise<{button:Element,glyph:Element,root:object}>} 关键节点。
 */
async function mountRealEntry(options = {}) {
  const wide = options.wide !== false
  const width = options.width ?? (wide ? 240 : 36)
  const { button, glyph } = buildProductRow({ wide })
  /** 造一个固定尺寸的 rect。 */
  const rect = (w, h) => ({
    width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0,
    toJSON() { return this },
  })
  // 产品那一行：宽栏约 200px 上下，收起约 36px
  button.getBoundingClientRect = () => rect(width, 36)
  // 图标槽：只有十几像素（这正是「往里 portal 永远到不了标题右边」的原因）
  glyph.getBoundingClientRect = () => rect(16, 16)
  const slot = window.document.createElement('span')
  glyph.appendChild(slot)
  const root2 = await renderInto(slot, React.createElement(PanelEntry, {
    size: wide ? 16 : 18,
    active: false,
  }))
  // PanelEntry 在 effect 里异步取时段相位（fetch），落地时还会再 setState 一次。
  // 不把这批更新收进 act 的话，它们会漏到测试之后，React 会警告
  // 「update not wrapped in act」——更重要的是断言可能在数据落地**之前**就跑完，
  // 那种闸门会随微任务时序时绿时红。多 settle 几轮把异步尾巴收干净。
  await settle()
  await settle()
  return { button, glyph, root: root2 }
}

const results = []

// ── 0) 真实组件挂进真实产品行：倒计时必须真的出现在行里 ──────────────
//
// 这是**最重要**的一段：它挂的是注册进侧栏槽位的那个真组件，而不是倒计时那一小块。
// 之前正是漏了这一层，才让「我们自己渲染的按钮套在产品按钮里 → 认错 row →
// 档位判定成 none → 什么都不显示」这个 bug 一路溜到用户面前。
{
  const { button, glyph } = await mountRealEntry({ wide: true, width: 240 })

  const captionInRow = button.querySelector('.px-period-inline')
  must(captionInRow !== null,
    '真实组件挂进真实产品行后，倒计时必须出现在产品的 row 里——'
    + '找不到就说明「认 row」认错了地方（例如认成了我们自己渲染的那个按钮），'
    + '那样量到的宽度只有图标那么宽，档位会判定成放不下，界面上什么都不显示')
  must(glyph.querySelector('.px-period-inline') === null,
    '倒计时不该留在图标槽里')
  must(button.contains(captionInRow), '倒计时必须是产品 row 的后代')

  // 我们自己渲染的按钮必须**不是**产品那一行：这正是认 row 时要跳过的那个
  const ourButton = glyph.querySelector('button')
  must(ourButton !== null, '面板入口应仍然渲染自己的按钮（可点区域）')
  must(ourButton !== button, '我们自己那个按钮不能就是产品那一行')
  must(button.contains(ourButton), '我们自己的按钮套在产品 row 按钮里面（这是要跳过的原因）')

  // 150 行宽的档位必须是 full：这正是否则「什么都不显示」的那条路径
  // 断言「完整文案」这个**形状**，而不是某个精确分钟数：
  // 倒计时按分钟取整，精确值会随挂载到断言之间的耗时抖动。
  // 关键是它是 `N分后空闲期` 这个完整形态，而不是空串、不是被省成只有时长。
  const text = captionInRow.textContent
  must(/^[1-9]\d*分后空闲期$/.test(text),
    `240px 宽的行应显示完整文案（形如「45分后空闲期」），实际「${text}」——`
    + '若是空串，说明档位判定成了放不下（行宽量错了：量成了我们自己那个按钮的宽度）；'
    + '若只有时长，说明档位掉到了 short')
  results.push('真实组件：倒计时落进产品 row 并显示完整文案')
  results.push('认 row 时跳过我们自己渲染的那个按钮')
  // 响应式那条路必须真的接上：没有 ResizeObserver 就只会在挂载时量一次，
  // 侧栏后来收放都不会重新判定档位。
  must(resizeObservers.length > 0 && resizeObservers.some((item) => item.targets.length > 0),
    '面板入口必须用 ResizeObserver 观察布局，否则侧栏收放后档位不会重算')
  results.push('侧栏收放会触发重新测量（ResizeObserver 已接上）')
  await unmountAll()
}

// ── 0b) 真实组件在收起成图标条时不显示 ──────────────────────────
{
  const { button } = await mountRealEntry({ wide: false, width: 36 })
  const caption = button.querySelector('.px-period-inline')
  must(caption === null,
    '侧栏收起（36px）时真实组件不该显示倒计时——没有横向空间')
  results.push('真实组件：收起成图标条时不显示')
  await unmountAll()
}

// ── 1) 倒计时真的挂在产品的 row（button）里，且在图标槽之后 ────────
{
  const { button, glyph, title } = buildProductRow({ wide: true })
  const host = window.document.createElement('span')
  host.className = 'portal-host'
  button.appendChild(host)

  await renderInto(host, React.createElement(PeriodDot, {
    phase: peakPhase, placement: 'full',
  }))

  // 前提校验：产品那一行确实是 button，且标题排在图标槽之后
  must(button.tagName === 'BUTTON', '产品行应当是 button（ui-sidebar 的 PanelRow）')
  must(title !== null, '宽栏应当有标题节点')
  const order = [...button.children].map((child) => classOf(child))
  must(
    order.indexOf('panelGlyph') < order.indexOf('panelTitle'),
    `图标槽应排在标题之前（真实产品结构如此），实际 ${order.join(',')}`,
  )

  // 核心断言：倒计时是 row 的**后代**（不是留在图标槽里）
  const caption = host.querySelector('.px-period-inline')
  must(caption !== null, '宽栏下应渲染 .px-period-inline')
  must(button.contains(caption), '倒计时必须是产品 row 的后代——否则它离不开图标槽')
  must(!glyph.contains(caption), '倒计时不该留在图标槽里（那正是它叠在柱状图标上的原因）')

  // 排在**图标槽之后**（因此视觉上也在图标右边）
  must(order.indexOf('portal-host') > order.indexOf('panelGlyph'),
    `portal 落点应排在图标槽之后，实际 ${order.join(',')}`)
  must(button.contains(title), '标题仍应在 row 内')
  results.push('倒计时挂在产品 row 内、且在图标槽之后')
}

// ── 2) 只有文字：不再有环形进度 ─────────────────────────────────
{
  const { button } = buildProductRow({ wide: true })
  const host = window.document.createElement('span')
  button.appendChild(host)
  await renderInto(host, React.createElement(PeriodDot, {
    phase: peakPhase, placement: 'full',
  }))

  const caption = host.querySelector('.px-period-inline')
  must(caption !== null, '应渲染倒计时容器')
  must(caption.querySelector('svg') === null,
    '不应再有环形进度（svg）——环已按需求移除')
  must(!classOf(caption).includes('px-period-dot'),
    `不该再带环的样式类，实际 ${classOf(caption)}`)
  // 单行文字：元素里只有文本，没有嵌套的两行结构
  const kids = [...caption.children]
  must(kids.length === 0,
    `应是单行纯文字，不该再有子元素（如两行文字块），实际 ${kids.length} 个`)
  must(caption.textContent === '45分后空闲期',
    `高峰应写「N后空闲期」，实际「${caption.textContent}」`)
  results.push('只有一行文字，没有环形进度')
}

// ── 3) 两个时期各说各的话 + 颜色区分 ─────────────────────────────
{
  /** 渲染一种相位并返回那一行文字。 */
  const textOf = async (phase) => {
    const { button } = buildProductRow({ wide: true })
    const host = window.document.createElement('span')
    button.appendChild(host)
    await renderInto(host, React.createElement(PeriodDot, { phase, placement: 'full' }))
    const caption = host.querySelector('.px-period-inline')
    return { text: caption.textContent, cls: classOf(caption) }
  }

  const peak = await textOf(peakPhase)
  must(peak.text === '45分后空闲期',
    `高峰应说「N后空闲期」（重点是什么时候变便宜），实际「${peak.text}」`)
  must(peak.cls.includes('px-period-tone-red'), `高峰应用红色，实际 ${peak.cls}`)
  must(!peak.cls.includes('px-period-tone-green'), '高峰不应带绿色')

  const idle = await textOf(idlePhase)
  must(idle.text === '空闲期剩45分',
    `空闲应说「空闲期剩N」（重点是还能便宜多久），实际「${idle.text}」`)
  must(idle.cls.includes('px-period-tone-green'), `空闲应用绿色，实际 ${idle.cls}`)
  must(!idle.cls.includes('px-period-tone-red'), '空闲不应带红色')

  // 两句话都在说「空闲」，但主次正好相反——必须真的不同
  must(peak.text !== idle.text, '高峰与空闲的文案必须不同')
  results.push('高峰「45分后空闲期」红 / 空闲「空闲期剩45分」绿')
}

// ── 4) 窄栏降级：只显示时长 ─────────────────────────────────────
{
  const { button } = buildProductRow({ wide: true })
  const host = window.document.createElement('span')
  button.appendChild(host)
  await renderInto(host, React.createElement(PeriodDot, {
    phase: peakPhase, placement: 'short',
  }))
  const caption = host.querySelector('.px-period-inline')
  must(caption !== null, '窄栏仍应显示时长')
  must(caption.textContent === '45分',
    `窄栏应只显示时长，实际「${caption.textContent}」`)
  must(!caption.textContent.includes('空闲期'),
    '窄栏应省掉时期字样（颜色已经在说时期）')
  must(classOf(caption).includes('px-period-tone-red'), '窄栏也要保留颜色区分')
  results.push('窄栏：只显示时长，颜色仍区分时期')
}

// ── 5) 侧栏收起成图标条：什么都不渲染 ────────────────────────────
{
  const { button } = buildProductRow({ wide: false })
  const host = window.document.createElement('span')
  button.appendChild(host)
  await renderInto(host, React.createElement(PeriodDot, {
    phase: peakPhase, placement: 'none',
  }))
  must(host.children.length === 0, '侧栏收起时不应渲染任何节点')
  must(host.textContent === '', '侧栏收起时不应有任何文字')
  results.push('侧栏收起：不渲染')
}

// ── 6) 没有相位时什么都不渲染 ───────────────────────────────────
{
  for (const placement of ['full', 'short', 'none']) {
    const { button } = buildProductRow({ wide: true })
    const host = window.document.createElement('span')
    button.appendChild(host)
    await renderInto(host, React.createElement(PeriodDot, {
      phase: undefined, placement,
    }))
    must(host.children.length === 0, `没有相位时不应渲染任何节点（placement=${placement}）`)
  }
  results.push('无相位：不渲染')
}

// ── 7) 活跃日历悬停：大数格式化 + 消费估计必须真的画出来 ─────────────
// 静态渲染（render-check）拿不到 hover——`useState` 初值是 null，提示行永远是
// 那句「每格 = 一天…」。所以「悬停到底显示了什么」只能在真实 DOM 里用鼠标事件
// 触发一次才算测到。这里挂真组件、派发 mouseover、再读提示行。
{
  const { ActivityCalendar } = await import(
    pathToFileURL(join(root, 'lib', 'client', 'graph.js')).href)
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const DAYS = 14
  // 第 5 天：token = 123_456_789 × 5 = 617,283,945 → `617.28M`；金额 ≈ ¥6.17。
  // 两个断言都落在非零值上，避免在 0 上假通过。
  const PICK = 5
  await renderInto(host, React.createElement(ActivityCalendar, {
    firstDay: '2026-09-01',
    days: DAYS,
    requests: Array.from({ length: DAYS }, (_, i) => i),
    sessions: Array.from({ length: DAYS }, () => 2),
    tokens: Array.from({ length: DAYS }, (_, i) => i * 123_456_789),
    costs: Array.from({ length: DAYS }, (_, i) => i * 1.2345),
    maxRequests: DAYS,
  }))
  const tip = host.querySelector('.px-heat-tip')
  must(tip !== null, '日历应渲染提示行')
  must(tip.textContent.includes('悬停看当天用量与消费估计'), '未悬停时应提示可以悬停')

  // 取**第 PICK 个日格**：图例里也有 .px-heat 的 rect，所以不能拿「第一个匹配」
  // 当日期格——那是第 0 天（全 0），断言会在 0 上假通过。
  const dayCells = host.querySelectorAll('svg > rect.px-heat')
  must(dayCells.length === DAYS, `日历日格数应为 ${DAYS}，实际 ${dayCells.length}`)
  const target = dayCells[PICK]
  await React.act(async () => {
    target.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
  })
  await settle()

  const shown = host.querySelector('.px-heat-tip').textContent
  // 大数必须按**大模型通用单位**缩略：617,283,945 → `617.28M`。
  // 这里刻意同时钉住「用了 M」与「没用中文万/亿」两侧——换回万/亿会让这条失败。
  must(shown.includes('617.28M'),
    `悬停应把 token 缩略成大模型通用单位 617.28M，实际：${shown}`)
  must(!shown.includes('亿') && !shown.includes('万'),
    `token 缩略不得再用中文「万 / 亿」，实际：${shown}`)
  must(!shown.includes(String(PICK * 123_456_789)),
    `悬停不该显示未缩略的原始 token 数：${shown}`)
  // 消费估计必须出现，且是金额形态
  must(shown.includes('消费估计'), `悬停应显示消费估计，实际：${shown}`)
  must(shown.includes('¥6.17'), `悬停应显示 ¥6.17 这个金额，实际：${shown}`)
  must(shown.includes('次请求') && shown.includes('个会话'), '悬停仍应保留请求数与会话数')
  results.push('活跃日历悬停：token 缩略成 617.28M（K/M/B 单位）+ 消费估计 ¥6.17')
}

// ── 7b) 日历缺金额时显示「—」而不是 ¥0 ─────────────────────────────
// 「不知道」与「真的是 0」是两件事。旧宿主没有 heatmap.costs，
// 若渲染成 ¥0 就等于替一个没查到的数字下了结论。
{
  const { ActivityCalendar } = await import(
    pathToFileURL(join(root, 'lib', 'client', 'graph.js')).href)
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  await renderInto(host, React.createElement(ActivityCalendar, {
    firstDay: '2026-09-01',
    days: 7,
    requests: [0, 1, 2, 3, 4, 5, 6],
    sessions: [1, 1, 1, 1, 1, 1, 1],
    tokens: [0, 1, 2, 3, 4, 5, 6],
    // costs 整个缺失 = 旧宿主
    maxRequests: 7,
  }))
  const cells = host.querySelectorAll('svg > rect.px-heat')
  await React.act(async () => {
    cells[3].dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
  })
  await settle()
  const shown = host.querySelector('.px-heat-tip').textContent
  must(shown.includes('消费估计 —'), `没有金额数据时应显示「—」，实际：${shown}`)
  must(!shown.includes('消费估计 ¥0'), '缺金额不得显示成 ¥0（那是替未知下结论）')
  results.push('活跃日历悬停：缺金额显示「—」而不是 ¥0')
}

// ── 8) 样式闸门：文字靠右、两色不同、没有残留的环样式 ─────────────
{
  const { STYLES } = await import(pathToFileURL(join(root, 'lib', 'client', 'theme.js')).href)
  const css = STYLES.map(([, text]) => text).join('\n')
  const inlineBlock = /\.px-period-inline\s*\{([^}]*)\}/.exec(css)
  must(inlineBlock !== null, '缺少 .px-period-inline 规则')
  must(/margin-left\s*:\s*auto/.test(inlineBlock[1]),
    '应 margin-left: auto 把文字推到行尾，标题才不会被挤到中间')
  must(/white-space\s*:\s*nowrap/.test(inlineBlock[1]),
    '必须 nowrap，否则窄栏里会折成两行把侧栏行高撑开')
  must(/tabular-nums/.test(inlineBlock[1]),
    '必须 tabular-nums，否则倒计时每秒变化时数字宽度跳动')
  must(!/position\s*:\s*absolute/.test(inlineBlock[1]),
    '不得绝对定位——一旦绝对定位，right 只相对图标槽解析，文字离不开图标')
  // 两色必须不同，否则颜色就不区分时期了
  const red = /\.px-period-tone-red\s*\{[^}]*color\s*:\s*([^;]+);/.exec(css)
  const green = /\.px-period-tone-green\s*\{[^}]*color\s*:\s*([^;]+);/.exec(css)
  must(red !== null && green !== null, '高峰/空闲两色都要真的设置 color')
  must(red[1].trim() !== green[1].trim(),
    `高峰与空闲必须是不同颜色，实际都是 ${red[1].trim()}`)
  // 环的样式必须已经清干净（留着会让人以为还有一条渲染路径）
  for (const dead of ['.px-period-dot', '.px-period-dot-track', '.px-period-dot-arc',
    '.px-period-dot-core', '.px-period-dot-svg', '.px-period-text']) {
    const asSelector = new RegExp(`${dead.replace(/\./g, '\\.')}\\s*[,{]`)
    must(!asSelector.test(css), `样式里残留了已删除的 ${dead} 规则（环已移除）`)
  }
  results.push('样式：靠右 + 不折行 + 等宽数字 + 两色不同 + 无残留环样式')
}

console.log('真实 DOM 闸门（jsdom）通过：')
for (const line of results) console.log(`  ✓ ${line}`)
