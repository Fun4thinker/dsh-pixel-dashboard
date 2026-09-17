/**
 * 客户端渲染闸门：抓打包脚本抓不到的问题——组件用了没引入的 API、
 * 数据形状取错字段、真实数据下某个分支抛错，以及主题覆盖层违反
 * 真实 theme 服务契约（裸字符串、明暗不成对、在 theme/change 里重入）。
 *
 * 做两件事：
 *   1) 把部署根的 client.js 当浏览器产物加载，验证 factory 能跑、注册动作正确；
 *   2) 直接 import 源码 lib/client/dashboard.js 的纯展示层 View，
 *      用一份真实形状的数据把整页渲染成静态 HTML 并断言关键内容。
 *
 * 用法: node tools/render-check.mjs [部署根，默认 lib-v6]
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/**
 * 本插件刻意不带依赖，校验用的 React 从 DSH 检出取，版本要与产品下发的
 * 平台表一致（react 18.3.1），否则这一关会失真。
 *
 * 检出位置**不写死盘符**：DSH 检出曾在 `D:`，后来换到 `E:`，写死一个常量会让
 * 这一关在另一台机器上直接报「找不到 React」——而它看起来像是闸门坏了，不是
 * 路径写错了。因此按顺序试若干候选，`DSH_CHECKOUT` 可显式指定，最后再回落到
 * 本机的 pnpm 全局 store（`pnpm store path` 那种位置不在这里猜，只试常见布局）。
 */
function resolvePnpmDir() {
  const candidates = []
  const explicit = process.env.DSH_CHECKOUT
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    candidates.push(join(explicit.trim(), 'node_modules', '.pnpm'))
  }
  // 与插件同盘的常见布局优先，再试其余盘符
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
  console.error('请把 DSH 检出路径通过环境变量 DSH_CHECKOUT 指出来，例如：')
  console.error('  $env:DSH_CHECKOUT = "E:\\deepseek-harness"; node tools/render-check.mjs')
  process.exit(1)
}
const REACT_DIR = `${PNPM}/react@18.3.1/node_modules/react`
const REACT_DOM_DIR = `${PNPM}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom`
if (!existsSync(REACT_DIR) || !existsSync(REACT_DOM_DIR)) {
  console.error(`pnpm 目录 ${PNPM} 里缺少 react 18.3.1 / react-dom 18.3.1`)
  process.exit(1)
}
const React = (await import(pathToFileURL(`${REACT_DIR}/index.js`).href)).default
// react-dom 也要照实提供：插件用 createPortal 把徽标并进产品统计行，
// 而平台共享表（packages/client/web/src/platform.ts）确实下发了这个模块。
const ReactDom = await import(pathToFileURL(`${REACT_DOM_DIR}/index.js`).href)
const { renderToStaticMarkup } = await import(pathToFileURL(`${REACT_DOM_DIR}/server.js`).href)

/**
 * 源码里的 `import React from 'react'` 是给浏览器的平台表用的，
 * 在 Node 里要让它解析到上面那份 React。这里用一个只在进程内生效的
 * loader hook 做映射，不往磁盘写任何文件。
 */
const REACT_ALIAS = new Map([
  ['react', pathToFileURL(`${REACT_DIR}/index.js`).href],
  ['react/jsx-runtime', pathToFileURL(`${REACT_DIR}/jsx-runtime.js`).href],
  // 组件源码里的 `import { createPortal } from 'react-dom'` 在浏览器里走平台表，
  // 在 Node 里要让同样的裸包名解析到上面那份 react-dom，否则这一关直接 ERR_MODULE_NOT_FOUND。
  ['react-dom', pathToFileURL(`${REACT_DOM_DIR}/index.js`).href],
])
const { register } = await import('node:module')
register(
  `data:text/javascript,${encodeURIComponent(`
    const aliases = new Map(${JSON.stringify([...REACT_ALIAS])})
    export async function resolve(specifier, context, nextResolve) {
      const mapped = aliases.get(specifier)
      if (mapped !== undefined) return { url: mapped, shortCircuit: true }
      return nextResolve(specifier, context)
    }
  `)}`,
  import.meta.url,
)

/** 断言工具。 */
function must(condition, message) {
  if (!condition) throw new Error(message)
}

// ── 第 1 关：浏览器产物能加载并正确注册 ──────────────────────────
/** 校验哪个构建产物：默认根 lib，可用 `node tools/render-check.mjs <目录>` 覆盖。 */
const deployRoot = process.argv[2] ?? 'lib'
const bundle = readFileSync(join(root, deployRoot, 'client.js'), 'utf8')
let factory
const mountedStyles = []
/** 已被 append 的通知提示条（供下面断言回落通道真的画了东西）。 */
const toastBoxes = []
/**
 * 假 DOM 节点：只需支持通知提示条用到的那几个操作。
 *
 * `classList` 与 `addEventListener` **必须照实提供**：可点的提示条靠它们挂点击
 * 回调，缺了任何一个，`#renderToast` 里那一段就会被自身的 try/catch 吞掉
 * ——闸门全绿，但「点提示条切会话」这条路一行都没跑到。这正是本文件反复强调的
 * 「替身缺一个全局能力，就等于那条路径没测」。
 */
function fakeElement(tag) {
  const classes = new Set()
  const node = {
    tagName: String(tag).toUpperCase(),
    id: '',
    textContent: '',
    dataset: {},
    children: [],
    /** 记录挂上的监听器，供测试手动触发点击。 */
    listeners: {},
    classList: {
      add: (name) => { if (name !== '') classes.add(name); return undefined },
      remove: (name) => { classes.delete(name); return undefined },
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : force === true
        if (on) classes.add(name)
        else classes.delete(name)
        return on
      },
    },
    appendChild(child) { this.children.push(child); return child },
    addEventListener(type, handler) {
      (this.listeners[type] ??= []).push(handler)
      return undefined
    },
    removeEventListener(type, handler) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== handler)
    },
    /** 触发一次已挂上的事件（测试用）。 */
    dispatch(type) {
      for (const handler of this.listeners[type] ?? []) handler({ type })
    },
    remove() {},
  }
  // className 与 classList 必须**双向同步**（真实 DOM 就是这样）。早先这里是两个
  // 互不相干的字段：`el.className = 'x'` 之后 `el.classList.contains('x')` 是 false，
  // 于是「代码用 classList.add 加上的类」在 className 里查不到——替身与浏览器行为
  // 不一致会让闸门断在一个假象上（或更糟：放过一个真 bug）。
  Object.defineProperty(node, 'className', {
    get: () => [...classes].join(' '),
    set: (value) => {
      classes.clear()
      for (const name of String(value ?? '').split(/\s+/)) if (name !== '') classes.add(name)
    },
    enumerable: true,
    configurable: true,
  })
  return node
}
/**
 * 通知运行时用的全局能力**必须照实提供**。
 *
 * 早先这里只给到 `setTimeout`，于是 `setInterval` 缺失、运行时抛
 * `ReferenceError` 被自身的 fail-soft 吞掉——闸门全绿，但通知这条路其实一行
 * 都没被测到。凡是「被 try/catch 包住的降级路径」，替身缺东西就等于没测，
 * 所以这里把定时器、Notification、fetch、DOM 查询一并补齐。
 */
const sandbox = {
  window: { __ModuleLoader__: { load: (registration) => { factory = registration.factory } } },
  // 产物运行在独立 vm realm 里，document 必须放进 sandbox。
  // querySelector 返回 null（模拟统计行锚点尚未出现），于是走兜底的自渲染分支。
  document: {
    head: { appendChild: (tag) => { mountedStyles.push(tag.dataset.pluginCss) } },
    createElement: (tag) => fakeElement(tag),
    body: {
      children: [],
      appendChild(child) {
        this.children.push(child)
        if (child.id === 'px-toast-host') toastBoxes.push(child)
        return child
      },
    },
    querySelector: () => null,
    getElementById: () => null,
  },
  MutationObserver: class { observe() {} disconnect() {} },
  console,
  performance: { now: () => Date.now() },
  requestAnimationFrame: (fn) => setTimeout(() => { fn(Date.now()) }, 0),
  cancelAnimationFrame: (handle) => { clearTimeout(handle) },
  setTimeout,
  clearTimeout,
  // AbortController 是**每一条取数路径**的第一行（余额、套餐、通知都是
  // `new AbortController()` 起手）。早先这里没有它，于是所有 fetch 在构造
  // 控制器时抛 ReferenceError、被各模块的 fail-soft 吞掉——闸门全绿，
  // 而「取数 → 展示」这条链路一行都没跑到。必须照实提供。
  AbortController,
  // 定时器：通知运行时靠它们轮询。不提供会让它静默降级（见上方说明）。
  // 回调被记下来，测试可以手动驱动「第二轮轮询」。
  setInterval: (fn) => { intervals.push(fn); return intervals.length },
  clearInterval: () => {},
  // Notification 替身：记录发出的系统通知，并固定为「已授权」，
  // 因为「申请授权 → 能弹」才是这条功能的主路径。
  Notification: Object.assign(
    function FakeNotification(title, options) {
      notifications.push({ title, body: options?.body, tag: options?.tag })
    },
    { permission: 'granted', requestPermission: async () => 'granted' },
  ),
  // fetch 替身：通知路由第一次返回游标 1（**没有**新事件），第二次返回一条
  // 新的完成事件——这正是生产的时序：首轮只学游标、不重播历史，
  // 之后每轮取增量。其余路由返回空白负载，避免余额 / 套餐真的去算。
  fetch: async (url) => {
    const text = String(url)
    let body = {}
    if (text.includes('/dsh-pixel/notify')) {
      notifyFetches += 1
      body = notifyFetches === 1
        ? { config: NOTIFY_CONFIG_STUB, cursor: 1, events: [], dropped: false }
        : {
          config: NOTIFY_CONFIG_STUB,
          cursor: 2,
          events: [{ id: 2, at: Date.now(), sessionId: 'session-other', workspace: 'demo', turn: 1, category: 'done', level: 'ok', label: '已完成' }],
          dropped: false,
        }
    }
    // 时段路由：侧栏那枚指示灯靠它取相位。**必须照实返回一个真形状**，否则
    // usePeriodPhase 的降级分支会安静地吃掉取数、指示灯永远不渲染，而闸门全绿。
    if (text.includes('/dsh-pixel/period')) {
      periodFetches += 1
      body = periodStubBody()
    }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  },
}
const notifications = []
const intervals = []
let notifyFetches = 0
let periodFetches = 0
/**
 * `/dsh-pixel/period` 的响应体：高峰时段、距切换 45 分钟、本段共 180 分钟。
 * 于是比例恰为 0.75，可用来断言弧长与倒计时。
 */
function periodStubBody() {
  const periodMs = 180 * 60_000
  const nextChangeMs = 45 * 60_000
  return {
    generatedAt: Date.now(),
    timezone: 'Asia/Shanghai',
    version: 'test',
    period: {
      peak: true,
      minuteOfDay: 675,
      weekday: 4,
      nextChangeMs,
      prevChangeMs: periodMs - nextChangeMs,
      periodMs,
      nextPeak: false,
      label: '高峰时段',
    },
  }
}
const NOTIFY_CONFIG_STUB = {
  notifyEnabled: true, notifyDone: true, notifyError: true, notifyBalance: true, notifyQuota: true,
  notifyQuietFocused: true, warnBalance: {}, warnQuotaPercent: 90,
}
sandbox.globalThis = sandbox
runInNewContext(bundle, sandbox, { filename: 'client.js' })
must(typeof factory === 'function', '产物没有注册 factory')

// react-dom 是平台共享表里的模块（packages/client/web/src/platform.ts 列了它）。
// 这里必须照实提供：插件用 createPortal 把徽标并进产品统计行，缺了它整批注册会失败。
const platform = { react: React, 'react-dom': ReactDom }
const clientExports = factory((spec) => {
  const value = platform[spec]
  must(value !== undefined, `平台表缺少模块 ${spec}`)
  return value
})
must(typeof clientExports.apply === 'function', '浏览器半边没有导出 apply')

const registrations = []
const themes = []
const paletteLayers = []
/**
 * 主题服务替身：必须复刻真实契约，否则这一关会放过正是踩过的两类坑——
 *   1) overrideTokens 只收 `{ light, dark }` 成对取值，裸字符串会被服务抛错；
 *   2) overrideTokens 会同步 emit theme/change，监听器里再调用它就无限递归。
 * 之前的替身两者都不管，于是“改了改又失效”能一路走到浏览器。
 */
const themeListeners = []
let themeEmits = 0
const themeStub = {
  getTheme: () => ({ preference: 'system', active: { colorScheme: 'light', tokens: {} } }),
  register: (definition) => { themes.push(definition.id); return () => {} },
  overrideTokens: (source, tokens) => {
    for (const [name, value] of Object.entries(tokens)) {
      must(
        typeof value === 'object' && value !== null
        && typeof value.light === 'string' && typeof value.dark === 'string',
        `overrideTokens("${source}") 的令牌 ${name} 必须是 { light, dark } 成对取值，`
        + `实际是 ${JSON.stringify(value)}`,
      )
    }
    paletteLayers.push({ source, count: Object.keys(tokens).length, tokens })
    // 与 cordis 一致：emit 是同步的，监听器会在本次调用里立刻重入
    themeEmits += 1
    must(themeEmits <= 50, `theme/change 递归失控（已 emit ${themeEmits} 次）——overrideTokens 会同步 emit，不能在监听器里再调用它`)
    for (const listener of themeListeners) listener(themeStub.getTheme())
    return () => {}
  },
}
/**
 * 待办交互的可观察量替身（`ctx.uiSession.pendingInteractions`）。
 *
 * 插件的「等待授权 / 回答」提醒直接订阅它。这里必须给一个**真的**可观察量：
 * 给 undefined 会让那条分支静默跳过，闸门全绿却什么都没测到。
 */
const pendingListeners = new Set()
const pendingSnapshot = new Map()
const uiSessionStub = {
  pendingInteractions: {
    getSnapshot: () => pendingSnapshot,
    subscribe: (listener) => { pendingListeners.add(listener); return () => { pendingListeners.delete(listener) } },
  },
}
/** 当前选中的会话（供「当前会话不打扰」判定）。 */
const sessionsStub = {
  list: { getSnapshot: () => ({ current: undefined }) },
  // 点通知切会话走它；记录调用供闸门断言。
  open: (id) => { sessionOpens.push(id) },
}

const ctx = {
  on: (event, callback) => {
    if (event === 'theme/change') themeListeners.push(callback)
    return () => {}
  },
  get(name) {
    if (name === 'theme') return themeStub
    if (name === 'uiSession') return uiSessionStub
    if (name === 'sessions') return sessionsStub
    if (name === 'slots') {
      return {
        inject: (key, callback) => { callback(); void key },
        register: (options, component) => {
          registrations.push({ slot: options.name, key: options.key ?? options.id, order: options.order, component })
          return () => {}
        },
      }
    }
    if (name === 'layout') {
      // selectPanel 要记录调用：通知点击的「切会话」必须同时**退出主区面板**，
      // 否则用户正停在看板上时点了通知，主区仍然显示看板，看起来就是没反应。
      return { selectPanel: (id) => { layoutSelects.push(id) } }
    }
    return undefined
  },
  effect: (factory2) => { factory2(); return () => {} },
}
/** 记录 layout.selectPanel 收到的参数。 */
const layoutSelects = []
/** 记录 sessions.open 收到的会话 id。 */
const sessionOpens = []
clientExports.apply(ctx)

must(registrations.length === 3, `apply 应注册 3 个槽位（主区 + 侧栏 + 费用条），实际 ${registrations.length}`)
must(mountedStyles.length === 3, `应挂 3 张样式表，实际 ${mountedStyles.length}`)
must(themes.length === 2, `应注册 2 套可选主题，实际 ${themes.length}`)
// 关键回归点：配色必须默认生效，否则用户看到的就是没换色的黑白界面
must(paletteLayers.length >= 1, '默认必须叠一层配色覆盖，否则马卡龙配色不会生效')
must(
  paletteLayers.at(-1).count > 10,
  `配色覆盖层的令牌太少（${paletteLayers.at(-1).count} 个），改不动界面`,
)
// 明暗两套必须都在这一层里：主题服务按当前方案挑一值，切换时才不用插件插手
const paletteSample = paletteLayers.at(-1).tokens['--dsw-alias-bg-base']
must(
  paletteSample.light !== paletteSample.dark,
  '同一令牌的明暗取值相同，说明只有一套配色被下发，切到另一方案会不可读',
)
must(
  registrations.some((item) => item.slot === 'main' && item.key === 'pixel-usage'),
  '主区面板没有注册到 pixel-usage',
)
must(
  registrations.some((item) => item.slot === 'sidebar.panellist' && item.key === 'pixel-usage'),
  '侧栏面板行没有注册到 pixel-usage',
)

// ── 通知运行时：必须在没有打开看板时也真的在跑 ───────────────────
// 这一节的意义在于**它测的是被 try/catch 包住的路径**：运行时自带 fail-soft，
// 替身缺任何一个全局能力都会让它安静地降级，闸门照样全绿。因此下面既有
// 「替身能力齐不齐」的间接检查（不抛错），也有对实际派发结果的直接检查。
//
// 取数是异步的（首轮轮询走 Promise），因此给一个宏任务让它落地。
await new Promise((resolve) => { setImmediate(resolve) })
await new Promise((resolve) => { setImmediate(resolve) })

must(
  registrations.some((item) => item.slot === 'main'),
  '通知运行时不得影响槽位注册',
)

const notifyModule = await import(pathToFileURL(join(root, 'lib', 'client', 'notify.js')).href)
const {
  NOTIFY_DEFAULTS: CLIENT_DEFAULTS, PERMISSION_TEXT: PERM_TEXT, SeenTracker, AlertLatch,
  balanceAlerts, composeInteraction, composeNotice, permissionOf, quotaAlerts,
} = notifyModule

// 1) 会话结束通知的文案：标题必须带工作目录名（同时跑几个会话时「已完成」本身无信息）
const composed = composeNotice({ workspace: 'blog', label: '失败', detail: 'rate limited', code: 'RATE_LIMIT', turn: 3, sessionId: 's1', level: 'error' })
must(composed.title.includes('blog') && composed.title.includes('失败'), `标题应含目录名与结论：${composed.title}`)
must(composed.body.includes('RATE_LIMIT') && composed.body.includes('第 3 轮'), `正文应含错误码与轮次：${composed.body}`)

// 2) 待办通知：授权看 toolName、提问看 questions（两者字段不同，不能猜一个共同字段）
const approvalNotice = composeInteraction({ kind: 'approval', key: 'approval:1', toolName: 'shell' })
must(approvalNotice.title.includes('授权'), `授权通知标题应说明需要授权：${approvalNotice.title}`)
must(approvalNotice.body.includes('shell'), `授权通知应写明工具名：${approvalNotice.body}`)
const questionNotice = composeInteraction({ kind: 'question', key: 'question:1', questions: [{ question: '用哪个方案？' }, { question: 'b' }] })
must(questionNotice.body.includes('用哪个方案？'), `提问通知应带上问题原文：${questionNotice.body}`)
must(questionNotice.body.includes('共 2 个问题'), `多问题应标出总数：${questionNotice.body}`)
// plan-review 是 question 的一个特例（DSH 的 planReviewOf 判定），值得单独文案
const planNotice = composeInteraction({ kind: 'plan-review', key: 'question:2', questions: [{ question: '确认这份计划？' }] })
must(planNotice.title.includes('计划'), `计划评审应有自己的标题：${planNotice.title}`)
must(planNotice.body.includes('确认这份计划？'), `计划评审应带上问题原文：${planNotice.body}`)
// 只有 header 没有 question 时也要有可读内容
const headerOnly = composeInteraction({ kind: 'question', key: 'question:3', questions: [{ header: '选择方案' }] })
must(headerOnly.body.includes('选择方案'), `只有 header 时应回落到 header：${headerOnly.body}`)
// 未知 kind 不能渲染出 undefined
const otherNotice = composeInteraction({ kind: 'whatever', key: 'x:1' })
must(!JSON.stringify(otherNotice).includes('undefined'), `未知待办不应渲染出 undefined：${JSON.stringify(otherNotice)}`)

// 2b) 共享存储必须是**同一个**对象：运行时写入、面板读取，靠的就是这个单例。
//     若两边各拿一个新实例，面板会永远显示初始状态（「最近通知」永远是空的），
//     而运行时那边一切正常——这正是最难查的那类「看起来没生效」。
const { notifyStore: storeFactory, NotifyStore } = await import(pathToFileURL(join(root, 'lib', 'client', 'Notifier.js')).href)
must(storeFactory() === storeFactory(), 'notifyStore() 必须返回同一个单例（运行时与面板共享快照）')
{
  const store = storeFactory()
  let notified = 0
  const unsubscribe = store.subscribe(() => { notified += 1 })
  const before = store.getSnapshot()
  store.patch({ error: 'boom' })
  must(notified === 1, `发布变化应通知订阅者，实际 ${notified}`)
  must(store.getSnapshot() !== before, '发布后快照引用应更新，否则 React 不会重渲染')
  // 内容没变时**不得**发布：日志轮询每 4 秒一次，每次都通知会让面板持续重渲染
  const stable = store.getSnapshot()
  store.patch({ error: 'boom' })
  must(store.getSnapshot() === stable, '内容未变时不应发布新快照（避免每 4 秒空重渲染）')
  must(notified === 1, `内容未变时不应通知订阅者，实际 ${notified}`)
  unsubscribe()
  store.patch({ error: 'after-unsubscribe' })
  must(notified === 1, '退订后不应再收到通知')
}

// 2c) 面板调用的每个 store 方法都必须真的存在，且**状态只有一个家**。
//     这条闸门来自真实故障：面板只拿得到 store，却调用了只存在于**运行时**上的
//     `setConfig` / `setPermission`，于是用户一点开关就报
//     `store.setConfig is not a function`；而权限也因为有两份副本，点「允许」后
//     界面仍显示「未授权」。两件事同一个根因：状态有两个家。
{
  const { NotifierRuntime } = await import(pathToFileURL(join(root, 'lib', 'client', 'Notifier.js')).href)
  // 用新实例：单例会被别的用例写过状态，跨块泄漏会让断言失真
  const store = new NotifyStore()
  for (const method of ['getSnapshot', 'subscribe', 'patch', 'setConfig', 'setPermission', 'pushRecent']) {
    must(typeof store[method] === 'function', `store 必须提供 ${method}()：面板直接调用它`)
  }
  const runtime = new NotifierRuntime({
    store,
    uiSession: () => undefined,
    sessions: () => undefined,
    scope: { Notification: Object.assign(function () {}, { permission: 'default' }) },
  })
  // 写进 store 的配置必须被运行时**立刻**看到（不能各持一份）
  store.setConfig({ notifyEnabled: true, warnQuotaPercent: 42 })
  must(runtime.config?.warnQuotaPercent === 42, 'store 写入的配置必须立刻对运行时可见（状态只有一个家）')
  // 反过来，运行时取值也必须落回 store —— 面板读到的和判定用的是同一份
  const beforeConfig = store.getSnapshot()
  store.setConfig({ notifyEnabled: true, warnQuotaPercent: 77 })
  must(store.getSnapshot() !== beforeConfig, '配置变化应产生新快照供面板重渲染')
  must(store.getSnapshot().config.warnQuotaPercent === 77, '面板读到的配置应与运行时判定用的一致')
  runtime.dispose()
}

// 2d) 权限必须**实时**读浏览器，不能用构造时的快照。
//     用户可以点地址栏站点设置里的「允许」，完全不经过我们的按钮；只认自己
//     写进去的那份，界面就会永远停在「未授权」——这正是用户实际遇到的现象。
{
  const { NotifierRuntime } = await import(pathToFileURL(join(root, 'lib', 'client', 'Notifier.js')).href)
  const store = new NotifyStore()
  const notificationStub = Object.assign(function () {}, { permission: 'default' })
  const runtime = new NotifierRuntime({
    store,
    uiSession: () => undefined,
    sessions: () => undefined,
    scope: { Notification: notificationStub },
  })
  must(runtime.permission === 'default', `初值应为 default，实际 ${runtime.permission}`)
  // 模拟用户在浏览器里点了「允许」（不经过插件）
  notificationStub.permission = 'granted'
  runtime.syncPermission()
  must(runtime.permission === 'granted', `浏览器授权后应立刻读到 granted，实际 ${runtime.permission}`)
  must(store.getSnapshot().permission === 'granted', '权限变化必须写回 store，否则面板仍显示未授权')
  runtime.dispose()
}

// 2e) 「发一条测试通知」必须走**与真实提醒相同**的派发路径。
//     这是用户自证「功能通没通」的唯一手段；若测试通知走一条独立的旁路，
//     就会出现「测试能弹、真实不弹」这种最误导人的不一致。
{
  const { NotifierRuntime } = await import(pathToFileURL(join(root, 'lib', 'client', 'Notifier.js')).href)
  const store = new NotifyStore()
  const shown = []
  const runtime = new NotifierRuntime({
    store,
    uiSession: () => undefined,
    sessions: () => undefined,
    scope: { Notification: Object.assign(function (t) { shown.push(t) }, { permission: 'granted' }) },
  })
  store.setConfig({ notifyEnabled: true })
  store.publishTest()
  must(shown.includes('测试通知'), `测试通知应真的弹出，实际 ${JSON.stringify(shown)}`)
  must(
    store.getSnapshot().recent.some((item) => item.title === '测试通知'),
    '测试通知也应落进「最近通知」——系统通知被勿扰拦住时，面板里那一份是唯一线索',
  )
  runtime.dispose()
}

// 2f) 总开关关掉时，测试通知也不该弹（否则「关了还在响」比不弹更让人困惑）。
{
  const { NotifierRuntime } = await import(pathToFileURL(join(root, 'lib', 'client', 'Notifier.js')).href)
  const store = new NotifyStore()
  const shown = []
  const runtime = new NotifierRuntime({
    store,
    uiSession: () => undefined,
    sessions: () => undefined,
    scope: { Notification: Object.assign(function (t) { shown.push(t) }, { permission: 'granted' }) },
  })
  store.setConfig({ notifyEnabled: false })
  store.publishTest()
  must(shown.length === 0, `总开关关闭时不应弹出任何通知，实际 ${JSON.stringify(shown)}`)
  runtime.dispose()
}

// 3) 余额阈值：没有阈值的币种跳过；金额缺失绝不能被当成 0
const balancePayload = { enabled: true, balances: [
  { currency: 'CNY', total: 5 }, { currency: 'USD', total: 100 }, { currency: 'SGD' },
] }
must(balanceAlerts(balancePayload, { CNY: 10 }).length === 1, '只应对设了阈值且低于阈值的币种告警')
must(balanceAlerts(balancePayload, { USD: 10 }).length === 0, '高于阈值不应告警')
const missingAmount = balanceAlerts({ enabled: true, balances: [{ currency: 'CNY' }] }, { CNY: 10 })
must(missingAmount.length === 0, '金额缺失时不得当成 0 而误报——「不知道」与「余额为 0」是两件事')
must(balanceAlerts({ enabled: false, balances: [{ currency: 'CNY', total: 1 }] }, { CNY: 10 }).length === 0, '余额查询关闭时不应告警')

// 4) 套餐阈值：只看 ok 的厂商，且拿不到百分比就跳过
const quotaPayload = { enabled: true, providers: [
  { id: 'a', name: '甲', ok: true, windows: [{ window: 'weekly', label: '每周', usedPercent: 95 }, { window: 'fiveHour', label: '5 小时' }] },
  { id: 'b', name: '乙', ok: false, windows: [{ window: 'weekly', label: '每周', usedPercent: 99 }] },
] }
const quotaHit = quotaAlerts(quotaPayload, 90)
must(quotaHit.length === 1 && quotaHit[0].provider === '甲', '只应对取数成功且达到阈值的窗口告警')
must(quotaAlerts(quotaPayload, 0).length === 0, '阈值为 0 表示关闭套餐预警')
must(quotaAlerts(quotaPayload, 96).length === 0, '未达阈值的窗口不应告警')

// 5) 预警锁存器：持续告警期间只报一次，恢复后才重新武装
const latch = new AlertLatch()
must(latch.update(['balance:CNY']).length === 1, '首次进入告警应触发')
must(latch.update(['balance:CNY']).length === 0, '告警持续期间不应重复触发——否则一分钟一条通知')
must(latch.update([]).length === 0, '恢复不是告警')
must(latch.update(['balance:CNY']).length === 1, '恢复后再次跌破应重新触发')

// 6) 去重游标：首轮绝不能重播历史；相同 id 不重复提醒
const tracker = new SeenTracker()
const firstRead = tracker.takeNotices({ cursor: 5, events: [{ id: 1 }, { id: 2 }] })
must(firstRead.first === true && firstRead.fresh.length === 0, '首轮应只记游标，绝不重播历史')
const secondRead = tracker.takeNotices({ cursor: 7, events: [{ id: 6 }, { id: 7 }] })
must(secondRead.fresh.length === 2, '游标之后的新记录应全部取出')
must(tracker.takeNotices({ cursor: 7, events: [{ id: 6 }, { id: 7 }] }).fresh.length === 0, '同一批不应重复提醒')
// 待办：只提醒首次出现的 key
const firstInteractions = tracker.takeInteractions([{ key: 'approval:1' }, { key: 'approval:2' }])
must(firstInteractions.length === 2, '首次待办应全部提醒')
must(tracker.takeInteractions([{ key: 'approval:1' }, { key: 'approval:2' }]).length === 0, '重复轮询不应重复提醒同一条待办')

// 7) 权限判定：没有 Notification API 时必须归到 unsupported，而不是 default
must(permissionOf({}) === 'unsupported', '没有 Notification API 应归为 unsupported')
must(permissionOf({ Notification: Object.assign(() => {}, { permission: 'granted' }) }) === 'granted', '已授权应被识别')
must(permissionOf({ Notification: Object.assign(() => {}, { permission: 'weird' }) }) === 'default', '未知权限值应归为 default')
must(typeof PERM_TEXT.unsupported === 'string' && PERM_TEXT.unsupported !== '', 'unsupported 必须有可读文案')
must(CLIENT_DEFAULTS.warnQuotaPercent === 90, '客户端默认阈值应与宿主一致（90 与看板红色档相同）')

// 8) 端到端：首轮只学游标（不重播历史），第二轮才派发新事件。
//    这一条同时钉住两件事：运行时确实在跑，且**刷新页面不会重播旧提醒**。
must(notifications.length === 0, `首轮轮询不得重播历史提醒，实际发出 ${JSON.stringify(notifications)}`)
// 手动驱动一轮日志轮询（生产里由 setInterval 触发）
const noticePoll = intervals.find((fn) => fn !== undefined)
must(typeof noticePoll === 'function', '运行时必须注册日志轮询定时器')
noticePoll()
await new Promise((resolve) => { setImmediate(resolve) })
await new Promise((resolve) => { setImmediate(resolve) })
must(
  notifications.some((item) => String(item.title).includes('demo')),
  `运行时应按宿主增量发出系统通知，实际发出 ${JSON.stringify(notifications)}`,
)
must(
  notifications.every((item) => typeof item.tag === 'string' && item.tag.startsWith('dsh-pixel-')),
  `通知应带上用于替换同一条提醒的 tag，实际 ${JSON.stringify(notifications)}`,
)

// 9) 回落通道：系统通知**不可用**时（没授权 / 非安全上下文），页面内提示条是
//    唯一的可见通道，必须真的画出来。上面那次运行是 granted，永远碰不到这条
//    路径——所以这里单独起一个运行时来验。忘了这条，最常见的失败形态就是
//    「用户拒绝了通知权限，然后什么提示也收不到，以为功能坏了」。
{
  const { NotifierRuntime } = await import(pathToFileURL(join(root, 'lib', 'client', 'Notifier.js')).href)
  const appended = []
  const doc = {
    createElement: (tag) => fakeElement(tag),
    getElementById: () => null,
    body: { appendChild(child) { appended.push(child); return child } },
  }
  // 不提供 Notification → permissionOf 返回 unsupported → 必须走页面内提示条
  // 用**新实例**而不是单例：单例会被前面的用例写过配置，跨块泄漏会让这条断言失真
  const fallbackStore = new NotifyStore()
  const fallback = new NotifierRuntime({
    store: fallbackStore,
    uiSession: () => undefined,
    sessions: () => undefined,
    scope: { document: doc },
  })
  must(fallback.permission === 'unsupported', `没有 Notification API 时应判为 unsupported，实际 ${fallback.permission}`)
  // 必须先有配置：运行时的 #enabled 在拿到配置之前一律返回 false
  // （「还没读到用户设置」不等于「用户全开着」），因此这里照生产的顺序先喂配置。
  fallbackStore.setConfig({ ...NOTIFY_CONFIG_STUB })
  // 这一段是通过 Node 直接 import 的**源码**，因此它用的是 Node 的全局 fetch，
  // 不是上面 vm sandbox 里那份替身——必须在这里临时换掉，否则它会真的去连网络。
  const realFetch = globalThis.fetch
  globalThis.fetch = sandbox.fetch
  try {
    // 首轮只学游标、不重播（与生产时序一致），因此先给一个已知游标
    fallback.seen.cursor = 1
    notifyFetches += 10
    await fallback.pollNotices()
  } finally {
    globalThis.fetch = realFetch
  }
  must(fallbackStore.recent.length >= 1, '系统通知不可用时也必须记下这条提醒（供面板展示）')
  const host = appended.find((node) => node.id === 'px-toast-host')
  must(host !== undefined, '系统通知不可用时必须回落到页面内提示条——否则用户什么都看不到')
  must(host.children.length >= 1, '提示条容器里必须真的挂上内容')
  must(host.children[0].className.includes('px-toast-'), '提示条必须带等级样式类')
  must(
    JSON.stringify(host.children[0]).includes('demo'),
    '提示条内容必须是这条通知本身，而不是空壳',
  )
  // 提示条也**可点**：系统通知不可用时它是唯一通道，「点一下跳过去」不该只在
  // 系统通知那条路上有。缺 classList / addEventListener 会让这一段被静默吞掉，
  // 所以上面那份假 DOM 已经照实提供了这两个能力。
  must(host.children[0].className.includes('px-toast-clickable'),
    '带会话 id 的提示条应标成可点（.px-toast-clickable），否则用户不知道能点')
  must(
    host.children[0].style === undefined || true,
    '（占位：可点样式由 CSS 类下发）',
  )
  must((host.children[0].listeners.click ?? []).length === 1,
    '可点的提示条必须真的挂上点击回调——少了它点了没反应，且没有任何报错')
  fallback.dispose()
}

// 9c) 点通知 → 切到那条会话。
//
// 这是用户报的问题：「系统通知点击后打开，没有切换到对应会话界面」。
// 要成立必须**两个动作都做**：
//   1) sessions.open(id) —— 选中那条会话；
//   2) layout.selectPanel(null) —— 退出主区面板。
// 第 2 步最容易漏：用户往往正停在「用量看板」上，只调 open() 的话主区仍然
// 显示看板，看起来就是「点了没反应」。因此这条闸门对两个动作都断言。
{
  const { NotifierRuntime } = await import(pathToFileURL(join(root, 'lib', 'client', 'Notifier.js')).href)
  const shown = []
  const opened = []
  const selected = []
  const focused = []
  /** 造一个能记录点击回调的 Notification 替身。 */
  function ClickableNotification(title, options) {
    this.title = title
    this.options = options
    this.onclick = undefined
    this.closed = false
    this.close = () => { this.closed = true }
    // 推**实例本身**而不是一份拷贝：下面的断言要看 onclick / closed 这些
    // 由生产代码写到实例上的字段，拷贝会让它们永远是初始值。
    shown.push(this)
  }
  ClickableNotification.permission = 'granted'

  const runtimeStore = new NotifyStore()
  const runtime = new NotifierRuntime({
    store: runtimeStore,
    uiSession: () => undefined,
    sessions: () => ({ open: (id) => { opened.push(id) } }),
    layout: () => ({ selectPanel: (id) => { selected.push(id) } }),
    scope: {
      Notification: ClickableNotification,
      // 用户从系统通知中心点回来时窗口可能还在别的应用后面，切完要聚焦
      focus: () => { focused.push(true) },
    },
  })
  runtimeStore.setConfig({ ...NOTIFY_CONFIG_STUB })

  // 直接派发一条带会话 id 的提醒（走的是与真实提醒相同的 #fire 路径）
  runtimeStore.publish({
    title: 'demo · 已完成',
    body: '第 2 轮',
    tag: 'dsh-pixel-session-other-2',
    level: 'ok',
    sessionId: 'session-other',
  })

  must(shown.length === 1, `应弹出系统通知，实际 ${shown.length}`)
  const fired = shown[0]
  must(typeof fired.onclick === 'function',
    '带会话 id 的系统通知必须挂上 onclick——这正是用户报的「点了没切过去」')
  must(fired.onclick !== undefined, 'onclick 应可调用')

  // 触发点击：两个动作都必须发生
  fired.onclick()
  must(opened.includes('session-other'),
    `点通知应切到通知说的那条会话，实际切到 ${JSON.stringify(opened)}`)
  must(selected.includes(null),
    '点通知还必须**退出主区面板**（selectPanel(null)）——'
    + '否则用户正停在看板上时主区仍显示看板，看起来就是点了没反应')
  must(focused.length === 1, '从通知中心点回来时应顺带聚焦窗口，否则切了还在别的应用后面')
  must(runtimeStore.recent.length >= 1, '点通知不该影响「最近通知」的记录')

  // 没有会话 id 的通知（余额 / 套餐阈值预警）**不得**挂点击：切会话是无意义的动作
  shown.length = 0
  runtimeStore.publish({ title: '账户余额低于预警阈值', body: 'CNY ¥1.00', tag: 'dsh-pixel-balance-CNY', level: 'error' })
  must(shown.length === 1, '预警也应弹出通知')
  must(shown[0].onclick === undefined,
    '不带会话 id 的通知不应挂 onclick——余额/套餐预警不属于任何会话，点它切会话无意义')

  // 会话已不存在（被删 / 属于别的机器）时必须安静，不能把轮询打断
  shown.length = 0
  const throwing = new NotifierRuntime({
    store: new NotifyStore(),
    uiSession: () => undefined,
    sessions: () => ({ open: () => { throw new Error('session not found') } }),
    layout: () => ({ selectPanel: () => {} }),
    scope: { Notification: ClickableNotification },
  })
  throwing.store.setConfig({ ...NOTIFY_CONFIG_STUB })
  throwing.store.publish({ title: 'x · 已完成', body: '', tag: 't', level: 'ok', sessionId: 'gone' })
  let threw = false
  try {
    shown.at(-1).onclick()
  } catch {
    threw = true
  }
  must(!threw, '会话已不存在时点通知不得抛错——通知是附加功能，不能把运行时打断')

  runtime.dispose()
  throwing.dispose()
}

// 9b) 授权行的**三种状态必须措辞不同**，且各自的下一步动作不同。
//     这条来自用户的实感：「我点了申请授权，还是说我没授权」——混成一句「未授权」
//     会让人反复点一个不会有任何反应的按钮（unsupported 下申请授权是无效动作，
//     denied 下浏览器也不会再弹框）。
{
  const panelModule = await import(pathToFileURL(join(root, 'lib', 'client', 'dashboard.js')).href)
  const { View: ViewForPerm } = panelModule
  const store = storeFactory()
  const cases = [
    ['unsupported', '本环境不支持系统通知'],
    ['denied', '系统通知被拒绝'],
    ['default', '系统通知未授权'],
    ['granted', '系统通知已授权'],
  ]
  const seenLabels = new Set()
  for (const [permission, expected] of cases) {
    store.setPermission(permission)
    const html = renderToStaticMarkup(React.createElement(ViewForPerm, {
      data: buildPayload(),
      now: Date.now(),
      refreshing: false,
      onRefresh: () => {},
      balance: { enabled: true, available: true, balances: [{ currency: 'CNY', total: 1 }] },
      onToggleBalance: () => {},
      plans: { enabled: true, providers: [] },
      onTogglePlans: () => {},
    }))
    must(html.includes(expected), `权限 ${permission} 应显示「${expected}」`)
    seenLabels.add(expected)
    // 「申请授权」只在 default 下出现：其余状态点了没有意义
    const hasAsk = html.includes('申请授权')
    must(
      hasAsk === (permission === 'default'),
      `「申请授权」按钮只应在 default 下出现（当前 ${permission}，出现=${hasAsk}）`,
    )
    // 「发一条测试通知」只在已授权时有意义
    const hasTest = html.includes('发一条测试通知')
    must(
      hasTest === (permission === 'granted'),
      `「发一条测试通知」只应在已授权时出现（当前 ${permission}，出现=${hasTest}）`,
    )
  }
  must(seenLabels.size === 4, '四种权限状态应有四条不同的措辞，不能合并')
  store.setPermission('granted')
}

// 10) 配置后到时的待办补发：这是**页面加载时就已经存在的授权请求**这一真实场景。
//     首轮 readPending 跑在 pollNotices 拿到配置之前，那时一律按「未启用」跳过；
//     若配置到手后不补发，这条待办就会永远不提醒，直到用户去回答别的东西。
{
  const { NotifierRuntime } = await import(pathToFileURL(join(root, 'lib', 'client', 'Notifier.js')).href)
  const fired = []
  // 一个「加载时就已存在」的授权请求
  const pendingMap = new Map([['s1', { kind: 'approval', key: 'approval:9001', sessionId: 's1', toolName: 'shell' }]])
  const runtimeStore = new NotifyStore()
  const runtime = new NotifierRuntime({
    store: runtimeStore,
    uiSession: () => ({ pendingInteractions: { getSnapshot: () => pendingMap, subscribe: () => () => {} } }),
    sessions: () => undefined,
    scope: {
      document: undefined,
      Notification: Object.assign(
        function N(title, options) { fired.push({ title, body: options?.body }) },
        { permission: 'granted' },
      ),
    },
  })
  // 还没配置：不得派发（「没读到设置」不等于「全开着」），但待办要出现在快照里
  runtime.readPending()
  must(runtimeStore.pending.length === 1, '待办应出现在快照里（供面板展示）')
  must(fired.length === 0, '配置未到之前不得派发通知')
  // 配置到手：必须补发那条**此前已存在**的待办
  runtimeStore.setConfig({ ...NOTIFY_CONFIG_STUB })
  must(fired.length === 1, `配置到手后应补发已存在的待办，实际派发 ${JSON.stringify(fired)}`)
  must(fired[0].title.includes('授权'), `补发的应是那条授权提醒：${JSON.stringify(fired[0])}`)
  // 再设一次（内容相同）不得重复提醒
  runtimeStore.setConfig({ ...NOTIFY_CONFIG_STUB })
  must(fired.length === 1, `同一条待办不得重复提醒，实际 ${fired.length} 次`)
  runtime.dispose()
}

// ── 输入框正下方的本次会话费用条 ────────────────────────────────
const dock = registrations.find((item) => item.slot === 'conversation.composer.dock')
must(dock !== undefined, '费用条没有注册到 conversation.composer.dock')
must(dock.key === 'pixel-cost', `费用条的 id 应为 pixel-cost，实际 ${dock.key}`)
// 排序闸门：该槽位**升序**渲染，产品自带的统计条（StatsPills）在 order 0。
// 用正值会被排到产品统计条下面，离输入框更远；并且产品统计条在无 token 活动时
// 整体不渲染，正值还会让本插件那一行上下跳动。必须是负值。
must(
  Number(dock.order) < 0,
  `费用条的 order 应为负数才能紧贴输入框正下方（产品统计条占 order 0），实际 ${dock.order}`,
)

/**
 * 渲染费用条并断言输出。
 * @param {object} props - 组件属性。
 * @returns {string} 静态 HTML。
 */
function renderDock(props) {
  return renderToStaticMarkup(React.createElement(dock.component, props))
}

// 有会话 + 投影有用量：先渲染出 token 数（金额还没到）
const dockHtml = renderDock({
  sessionId: 'session-8155bc37-087f-4541-b7d6-dcb8b1a986a0',
  useProjection: () => ({
    val: { totals: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 0 } },
  }),
})
must(dockHtml.includes('px-pill'), '费用条应带 px-cost 结构类')
must(dockHtml.includes('本次会话'), '费用条应说明这是本次会话')
// token 数按大模型通用单位缩略：2000 → `2.0K`（不是 `2,000` 或 `2000`）
must(dockHtml.includes('2.0K'), `费用条应显示缩略后的 token 数（2.0K），实际：${dockHtml.slice(0, 400)}`)

// 纯展示层：直接喂金额，断言格式与分档说明（金额来自网络，静态渲染里拿不到）
const viewModule = await import(pathToFileURL(join(root, 'lib', 'client', 'SessionCost.js')).href)
const { SessionCostView } = viewModule
must(typeof SessionCostView === 'function', 'SessionCost.js 应导出 SessionCostView')

const withCost = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: { standard: 0.1234, peak: 0.08, idle: 0.0434 },
  tokens: 2_000,
}))
must(withCost.includes('¥0.123'), `费用条应显示金额，实际：${withCost}`)
must(withCost.includes('tokens'), '费用条应显示 token 数')
must(withCost.includes('高峰') && withCost.includes('空闲'), '悬停说明应含高峰/空闲分档')

// 金额为 0 也要显示（新会话刚开就应看到 ¥0，而不是空白）
const zeroCost = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: { standard: 0, peak: 0, idle: 0 },
  tokens: 0,
}))
must(zeroCost.includes('¥0'), `金额为 0 也应显示，实际：${zeroCost}`)

// 取数失败必须明说，而不是永远停在「折算中」——这正是线上出现过的现象
const failedView = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: undefined,
  failed: true,
  tokens: 12_000,
}))
must(!failedView.includes('折算中'), `失败态不应还显示「折算中」：${failedView}`)
must(failedView.includes('px-pill-warn'), '失败态应带告警样式类')
must(failedView.includes('费用不可用'), `失败态应说明费用不可用：${failedView}`)
must(failedView.includes('tokens'), '失败态仍应显示 token 数兜底')

// 两者都缺：不渲染空壳
must(
  renderToStaticMarkup(React.createElement(SessionCostView, { cost: undefined, tokens: undefined })) === '',
  '金额与 token 都缺时费用条应不渲染',
)

// 没有会话时必须不渲染
must(renderDock({ sessionId: undefined, useProjection: () => undefined }) === '', '没有会话时费用条应不渲染')

// 金额未就绪但 token 有：不得出现 undefined
const partial = renderDock({ sessionId: 'session-x', useProjection: () => ({ val: { totals: { outputTokens: 5 } } }) })
must(!partial.includes('undefined'), `费用条不应渲染出 undefined：${partial}`)

// ── 账户余额：费用条旁那一枚 + 看板卡片 ──────────────────────────
// SessionCostView 已在上面的费用条一节里取过，这里只补拿余额相关的模块。
const { balanceStatus, formatMoney, balanceSummary } = await import(pathToFileURL(join(root, 'lib', 'client', 'balance.js')).href)
// 币种与符号：官方两种币都认识，未知币种显示代码而不是瞎猜符号
must(formatMoney(12.34, 'CNY') === '¥12.34', `CNY 应显示 ¥，实际 ${formatMoney(12.34, 'CNY')}`)
must(formatMoney(3, 'USD') === '$3.00', `USD 应显示 $，实际 ${formatMoney(3, 'USD')}`)
must(formatMoney(5, 'SGD') === 'SGD 5.00', `未知币种应显示代码，实际 ${formatMoney(5, 'SGD')}`)
// 负数：符号在前（-¥0.79），而不是 ¥-0.79
must(formatMoney(-0.79, 'CNY') === '-¥0.79', `负余额符号应在最前，实际 ${formatMoney(-0.79, 'CNY')}`)
// 读不懂的金额绝不能显示成 0——那会让人以为余额真的空了
must(formatMoney(undefined, 'CNY') === '—', `缺失金额应显示 —，实际 ${formatMoney(undefined, 'CNY')}`)

// 多币种摘要
must(
  balanceSummary({ balances: [{ currency: 'CNY', total: 12.34 }, { currency: 'USD', total: 3 }] }) === '¥12.34 / $3.00',
  '多币种摘要应逐个列出',
)
must(balanceSummary({ balances: [] }) === undefined, '没有余额时摘要应为 undefined，调用方据此不渲染')

// 状态归一：每种降级都要有能读懂的原因，不能留白
must(balanceStatus({ enabled: false }).level === 'off', '关闭态应可识别')
must(balanceStatus({ enabled: false, lockedByEnv: true }).text.includes('DSH_PIXEL_BALANCE'), '环境变量关闭要说明来源')
must(balanceStatus({ enabled: true, reason: 'no-key' }).text.includes('DEEPSEEK_API_KEY'), '没配 Key 要指明引用名')
must(balanceStatus({ enabled: true, error: 'HTTP 401' }).text.includes('HTTP 401'), '失败要带上具体原因')
must(balanceStatus({ enabled: true, balances: [{ currency: 'CNY', total: 1 }] }).level === 'ok', '有金额应为 ok')
must(balanceStatus(undefined).level === 'error', '宿主没给数据时应是错误态，不能装作正常')

// ── 按模型来源绑定账户事实：解析器（纯函数）──────────────────────
// 这一组钉住的是**这一行到底显示谁的钱**。它曾经把官方余额与「最紧的套餐窗口」
// 并排显示，而两者来自完全不同的账户，摆在一起会让人以为是同一笔钱的两个数字。
{
  const { resolveAccount } = await import(pathToFileURL(join(root, 'lib', 'client', 'account.js')).href)
  const { ACCOUNT_KINDS } = await import(pathToFileURL(join(root, 'lib', 'client', 'account.js')).href)
  const { sourceOfProvider, planIdOfProvider, currentRoute } = await import(
    pathToFileURL(join(root, 'lib', 'client', 'provider.js')).href
  )
  const balancePayload = { enabled: true, balances: [{ currency: 'CNY', total: 12.34 }] }
  const plansPayload = {
    enabled: true,
    providers: [
      { id: 'zhipu', name: '智谱 GLM Coding Plan', ok: true, windows: [{ window: 'fiveHour', label: '5 小时', usedPercent: 61.8 }] },
      { id: 'commandcode', name: 'Command Code', ok: true, windows: [{ window: 'weekly', label: '每周', usedPercent: 20 }] },
    ],
  }

  // 路由名映射：必须与宿主 lib/plans.js 的候选表同源，否则「套餐卡片里有这一家、
  // 费用条旁边却永远不显示它」——没有任何报错，只是那一枚永不出现。
  must(sourceOfProvider('deepseek-official').kind === 'balance', '官方 provider 应绑到余额')
  must(planIdOfProvider('zhipu-coding') === 'zhipu', '智谱的常见路由名应能认出来')
  must(planIdOfProvider('commandcode') === 'commandcode', 'commandcode（无下划线）应能认出来')
  must(planIdOfProvider('command-code') === 'commandcode', '连字符写法也应能认出来')
  must(planIdOfProvider('ARK') === 'volcengine', '火山路由名大小写不敏感')
  must(planIdOfProvider('my-private-proxy') === undefined, '未知路由不应被硬塞给某一家')

  // 来源是官方 → 余额
  const official = resolveAccount({ selection: { next: { provider: 'deepseek-official', model: 'x' } }, balance: balancePayload, plans: plansPayload })
  must(official.kind === 'balance' && official.text === '¥12.34', `官方来源应显示余额，实际 ${JSON.stringify(official)}`)
  must(official.source === 'route', '按来源绑定的应标 route')

  // 来源是某家套餐 → 那一家（**不并排**显示余额）
  const zhipu = resolveAccount({ selection: { next: { provider: 'zhipu-coding', model: 'glm-5.3' } }, balance: balancePayload, plans: plansPayload })
  must(zhipu.kind === 'plan' && zhipu.planId === 'zhipu', `智谱来源应绑到智谱，实际 ${JSON.stringify(zhipu)}`)
  must(zhipu.plan.percent === 61.8, '应显示那一家最紧窗口的百分比')
  must(resolveAccount({ selection: { next: { provider: 'command-code', model: 'x' } }, balance: balancePayload, plans: plansPayload }).planId === 'commandcode',
    'Command Code 来源应绑到 Command Code')

  // 来源认不出 + 用户手动选过 → 用用户选的（这正是「手动切换」的用处）
  const selected = resolveAccount({ selection: undefined, balance: balancePayload, plans: plansPayload, selectedPlan: 'commandcode' })
  must(selected.kind === 'plan' && selected.planId === 'commandcode', '手动指定时应监看那一家')
  must(selected.source === 'selected', '手动指定应标 selected（界面据此解释这一枚从哪来）')

  // 来源认不出 + 没选过 → 退回官方余额（DSH 默认路由就是官方）
  const fallback = resolveAccount({ selection: undefined, balance: balancePayload, plans: plansPayload })
  must(fallback.kind === 'balance', '来源未知且没选过时应退回官方余额')
  must(fallback.source === 'fallback', '退回的应标 fallback')

  // 余额也拿不到 → 退回最紧的套餐窗口（至少还有东西可看）
  const noBalance = resolveAccount({ selection: undefined, balance: { enabled: false }, plans: plansPayload })
  must(noBalance.kind === 'plan', '余额不可用时应退回套餐')
  must(noBalance.planId === 'zhipu', `应退回最紧的那一家（智谱 61.8%），实际 ${noBalance.planId}`)

  // 三档都空：不渲染空壳
  must(resolveAccount({}).kind === 'none', '什么都不给时应返回 none，调用方据此不渲染')
  // 解析器只允许返回声明过的那几种 kind：费用条按 kind 分支渲染，多出一种而
  // 界面没处理，会静默渲染成空白（switch 没有 default 时最容易漏）。
  for (const result of [official, zhipu, selected, fallback, noBalance, { ...resolveAccount({}) }]) {
    must(ACCOUNT_KINDS.includes(result.kind), `resolveAccount 返回了未声明的 kind「${result.kind}」`)
  }

  // 「拿不到」必须可见，而不是静默不渲染——用户会以为是插件坏了
  const broken = resolveAccount({ selection: { next: { provider: 'zhipu-coding', model: 'x' } }, plans: { enabled: true, providers: [
    { id: 'zhipu', name: '智谱', ok: false, reason: 'no-key', keyRef: 'ZHIPU_CODING_API_KEY', windows: [] },
  ] } })
  must(broken.kind === 'unavailable', '绑定到的那一家取不到时应给 unavailable 而不是消失')
  must(broken.reason.includes('ZHIPU_CODING_API_KEY'), `应给出可读原因，实际 ${broken.reason}`)
  // 宿主根本没返回这一家（版本不一致 / 选择跨版本残留）
  const missing = resolveAccount({ selection: undefined, plans: plansPayload, selectedPlan: 'nope' })
  must(missing.kind === 'unavailable', '选了一个宿主没有的厂商时应给 unavailable')
  must(missing.reason.includes('nope') || missing.reason.includes('版本'), `应说明原因，实际 ${missing.reason}`)

  // currentRoute：投影还没到时必须返回 undefined，**不能猜一个**
  must(currentRoute(undefined) === undefined, '没有投影时应返回 undefined，而不是猜一个来源')
  must(currentRoute({ lastUsed: null, next: null }) === undefined, '两个字段都空时应返回 undefined')
  must(currentRoute({ lastUsed: { provider: 'p', model: 'm' }, next: null })?.provider === 'p', 'next 为空时应用 lastUsed')
  must(currentRoute({ lastUsed: { provider: 'old', model: 'm' }, next: { provider: 'new', model: 'm' } })?.provider === 'new',
    'next 非空时应优先用它（用户切了模型要立刻反映出来）')

  // 与宿主候选表**同源**的闸门：逐条比对**全部**路由名，而不是抽查几个。
  // 写岔了不会报错，只会让某一家的徽标永远不出现——只能靠这一条抓。
  // 做法是从宿主源码里把三个 ROUTES 数组抠出来解析，再与客户端表逐一比对；
  // 两边任何一方新增/删改而另一方没跟，这里就会红。
  const hostPlansSource = readFileSync(join(root, 'lib', 'plans.js'), 'utf8')
  const { PLAN_ROUTES: clientRoutes } = await import(pathToFileURL(join(root, 'lib', 'client', 'provider.js')).href)
  /**
   * 从宿主源码里抠出一个 `export const X_ROUTES = [...]` 数组的字面量。
   * @param {string} name - 常量名。
   * @returns {string[]} 解析出的字符串数组。
   */
  const hostRoutesOf = (name) => {
    const found = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(hostPlansSource)
    must(found !== null, `宿主 lib/plans.js 里找不到 ${name}，客户端的同名表就没法校验了`)
    return [...found[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  }
  const HOST_ROUTE_TABLES = {
    zhipu: hostRoutesOf('ZHIPU_ROUTES'),
    commandcode: hostRoutesOf('COMMAND_CODE_ROUTES'),
    volcengine: hostRoutesOf('VOLC_ROUTES'),
  }
  for (const [planId, hostRoutes] of Object.entries(HOST_ROUTE_TABLES)) {
    must(Array.isArray(clientRoutes[planId]) && clientRoutes[planId].length > 0,
      `客户端 PLAN_ROUTES 缺少 ${planId} 的路由名清单`)
    for (const route of hostRoutes) {
      must(clientRoutes[planId].includes(route),
        `路由名 '${route}' 在宿主 ${planId} 的候选表里，却没被客户端 provider.js 认出来——`
        + `用户用这个名字添加 provider 时，那一家的徽标永远不会出现`)
    }
    // 反向也要查：客户端多认一个宿主机不认的，会让「该家凭据读不到」与
    // 「徽标说该显示它」对不上，同样要挡住。
    for (const route of clientRoutes[planId]) {
      must(hostRoutes.includes(route),
        `客户端 provider.js 把 '${route}' 认成 ${planId}，但宿主的候选表里没有它——两边漂移了`)
    }
  }
}

// 费用条：绑定到官方余额时应渲染余额那一枚
const dockWithBalance = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: { standard: 0.5, peak: 0.2, idle: 0.3 },
  tokens: 1000,
  account: { kind: 'balance', label: '余额', source: 'route', text: '¥12.34', payload: { official: true } },
}))
must(dockWithBalance.includes('px-pill'), '有余额时应渲染余额那一枚')
must(dockWithBalance.includes('余额'), '费用条应标出这是余额')
must(dockWithBalance.includes('¥12.34'), `费用条应显示余额金额：${dockWithBalance}`)

// 绑定到套餐时应渲染**那一家**，且不再出现「余额」那一枚（两笔账不并排）
const dockWithPlan = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: { standard: 0.5, peak: 0.2, idle: 0.3 },
  tokens: 1000,
  account: {
    kind: 'plan',
    planId: 'zhipu',
    label: '智谱',
    fullLabel: '智谱 GLM Coding Plan',
    source: 'route',
    plan: { provider: '智谱 GLM Coding Plan', planId: 'zhipu', window: { window: 'fiveHour', label: '5 小时' }, percent: 61.8 },
  },
}))
must(dockWithPlan.includes('智谱'), `绑定套餐时应显示那一家，实际：${dockWithPlan}`)
must(dockWithPlan.includes('62%'), '应显示那一家最紧窗口的百分比')
must(!dockWithPlan.includes('余额'), '绑定套餐时不得同时显示余额——两笔账来自不同账户，并排会误导')
must(dockWithPlan.includes('本次会话'), '绑定套餐时费用仍要显示')

// 拿不到时必须显式告警，而不是静默不渲染
const dockUnavailable = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: { standard: 0.5, peak: 0.2, idle: 0.3 },
  tokens: 1000,
  account: { kind: 'unavailable', label: '智谱', source: 'route', reason: '没有找到 ZHIPU_CODING_API_KEY' },
}))
must(dockUnavailable.includes('不可用'), '绑定到的那一家取不到时必须显示「不可用」')
must(dockUnavailable.includes('px-pill-warn'), '不可用那一枚应带告警样式')
must(dockUnavailable.includes('ZHIPU_CODING_API_KEY'), '悬停里要给出具体原因，否则用户无从下手')
must(dockUnavailable.includes('本次会话'), '账户那一枚不可用时费用仍要显示')

// 余额取不到时：不渲染余额那一枚，但费用照常显示（余额坏掉不该拖垮费用）
const dockNoBalance = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: { standard: 0.5, peak: 0.2, idle: 0.3 },
  tokens: 1000,
  account: { kind: 'none' },
}))
must(!dockNoBalance.includes('余额'), '没有余额时不应渲染余额那一枚')
must(dockNoBalance.includes('本次会话'), '没有余额时费用仍要显示')

// 只有账户那一枚、没有费用：也要渲染（否则「余额」这个功能在旧宿主上永远看不见）
const dockOnlyBalance = renderToStaticMarkup(React.createElement(SessionCostView, {
  account: { kind: 'balance', label: '余额', source: 'fallback', text: '¥7.00' },
}))
must(dockOnlyBalance.includes('¥7.00'), `只有余额时也应渲染：${dockOnlyBalance}`)

// ── 不在价目表里的模型：费用那一枚要标「估算」──────────────────
// 金额永远是宿主按定价表算的，价目表里没有的模型会走 Flash 兜底单价。看板费用明细
// 会把它们标成「估算价」；费用条那边只给一个数字的话，同一笔钱在同一页上有两种
// 说法。这里锁住「两边口径一致」。
{
  const { unpricedModelsOf } = viewModule
  must(typeof unpricedModelsOf === 'function', 'SessionCost.js 应导出 unpricedModelsOf')

  const models = [
    { model: 'deepseek-flash', priced: true },
    { model: 'mystery-model-x', priced: false },
  ]
  must(
    JSON.stringify(unpricedModelsOf({ models: ['deepseek-flash'] }, models)) === '[]',
    '全是已知价时不该标估算',
  )
  must(
    JSON.stringify(unpricedModelsOf({ models: ['deepseek-flash', 'mystery-model-x'] }, models)) === '["mystery-model-x"]',
    '价目表里没有的模型应被挑出来',
  )
  // 宿主没给这个模型的条目 = 「不知道」，不是「知道它没价」——不得标估算
  must(
    unpricedModelsOf({ models: ['never-seen-model'] }, models).length === 0,
    '宿主没有该模型的条目时不得标估算（不知道 ≠ 知道它没价）',
  )
  must(unpricedModelsOf({ models: [] }, models).length === 0, '没有用量时不该标估算')
  must(unpricedModelsOf(undefined, undefined).length === 0, '什么都不给时不得抛错')

  const estimated = renderToStaticMarkup(React.createElement(SessionCostView, {
    cost: { standard: 0.5, peak: 0.2, idle: 0.3 },
    tokens: 1000,
    unpriced: ['mystery-model-x'],
    account: { kind: 'none' },
  }))
  must(estimated.includes('px-pill-tag'), '有不在价目表里的模型时费用那一枚应带角标')
  must(estimated.includes('估算'), `角标应写明「估算」：${estimated}`)
  must(estimated.includes('mystery-model-x'), '悬停里要点明是哪个模型没有价')
  // 没有未定价模型时不该出现角标（否则等于每一条都标估算）
  const notEstimated = renderToStaticMarkup(React.createElement(SessionCostView, {
    cost: { standard: 0.5, peak: 0.2, idle: 0.3 },
    tokens: 1000,
    unpriced: [],
    account: { kind: 'none' },
  }))
  must(!notEstimated.includes('px-pill-tag'), '不在价目表里的模型时才该标估算')
}

// 容器组件在服务端渲染下停在骨架，这里只要求它能渲染且不抛错
const main = registrations.find((item) => item.slot === 'main')
const shellHtml = renderToStaticMarkup(React.createElement(main.component, {}))
must(shellHtml.includes('px-loading'), 'Dashboard 容器首屏应渲染加载骨架')

const entryRegistration = registrations.find((item) => item.slot === 'sidebar.panellist')
const iconHtml = renderToStaticMarkup(React.createElement(entryRegistration.component, { size: 18, active: true }))
must(iconHtml.includes('<svg'), '侧栏图标没有渲染出 svg')

// ── 侧栏按钮上的时段指示灯 ──────────────────────────────────────
const {
  periodPhase, periodTitle, PeriodDot, fetchPeriod,
} = await import(pathToFileURL(join(root, 'lib', 'client', 'period.js')).href)

must(typeof fetchPeriod === 'function', 'period.js 应导出 fetchPeriod')
must(typeof periodPhase === 'function', 'period.js 应导出 periodPhase')

/** 造一份宿主 `/period` 形状的快照。 */
function periodSnapshot(options = {}) {
  const periodMs = options.periodMs ?? 180 * 60_000
  const nextChangeMs = options.nextChangeMs ?? 60 * 60_000
  return {
    generatedAt: options.generatedAt ?? 1_000_000,
    timezone: 'Asia/Shanghai',
    period: {
      peak: options.peak ?? true,
      minuteOfDay: 660,
      weekday: 4,
      nextChangeMs,
      prevChangeMs: periodMs - nextChangeMs,
      periodMs,
      nextPeak: !(options.peak ?? true),
      label: (options.peak ?? true) ? '高峰时段' : '空闲时段',
    },
  }
}

// 1) 高低峰 → 红绿灯。这是用户唯一要求的语义，写反了整个功能就是错的。
const at = 1_000_000
const peakPhase = periodPhase(periodSnapshot({ peak: true }), at)
must(peakPhase.tone === 'red', `高峰必须红，实际 ${peakPhase.tone}`)
must(peakPhase.label.includes('高峰'), `高峰文案应说明是高峰：${peakPhase.label}`)
const idlePhase = periodPhase(periodSnapshot({ peak: false }), at)
must(idlePhase.tone === 'green', `低峰必须绿，实际 ${idlePhase.tone}`)
must(idlePhase.label.includes('空闲'), `低峰文案应说明是空闲：${idlePhase.label}`)

// 2) 倒计时方向必须跟着状态走：高峰在倒数「距转空闲」，空闲在倒数「距转高峰」。
must(peakPhase.nextLabel === '距转空闲', `高峰应倒数到空闲，实际 ${peakPhase.nextLabel}`)
must(idlePhase.nextLabel === '距转高峰', `空闲应倒数到高峰，实际 ${idlePhase.nextLabel}`)

// 3) 两个时期各说各的话，且**主次不能反**。
//
//    这两句都在说「空闲」，但方向相反：高峰中要告诉用户「什么时候变便宜」，
//    空闲中要告诉用户「还能便宜多久」。写反了完全读不出错——两句话本身都通顺，
//    只是把「还剩多久」与「还有多久开始」对调了。
const quarter = periodPhase(periodSnapshot({ periodMs: 180 * 60_000, nextChangeMs: 45 * 60_000 }), at)
must(quarter.caption === '45分后空闲期',
  `高峰中应说「N后空闲期」，实际「${quarter.caption}」`)
must(quarter.shortCaption === '45分', `短版本应只有时长，实际「${quarter.shortCaption}」`)
const idleQuarter = periodPhase(
  periodSnapshot({ periodMs: 180 * 60_000, nextChangeMs: 45 * 60_000, peak: false }), at,
)
must(idleQuarter.caption === '空闲期剩45分',
  `空闲中应说「空闲期剩N」，实际「${idleQuarter.caption}」`)
must(quarter.caption !== idleQuarter.caption, '高峰与空闲的文案必须不同')

// 4) 本地递减：宿主快照放了一会儿之后，剩余时间要跟着减少（否则页面停一会儿就不准了）。
const aged = periodPhase(periodSnapshot({ nextChangeMs: 60 * 60_000, generatedAt: at - 1000 }), at)
must(aged.remainMs === 60 * 60_000 - 1000, `快照旧 1 秒后剩余应少 1 秒，实际 ${aged.remainMs}`)
// 归零后夹在 0，绝不给负数
const expired = periodPhase(periodSnapshot({ nextChangeMs: 1000, generatedAt: at - 60_000 }), at)
must(expired.remainMs === 0, `已过期时剩余应夹到 0，实际 ${expired.remainMs}`)
must(expired.countdown.includes('秒'), `剩余为 0 也应有可读倒计时，实际 ${expired.countdown}`)

// 5) 脏数据：绝不能让 NaN 流进那行文字。
//    倒计时每秒重画，`NaN时NaN分后空闲期` 会一直闪在那里。
for (const broken of [
  { period: { peak: true } },
  { period: { peak: false, nextChangeMs: 'x', periodMs: null } },
  { period: { peak: true, nextChangeMs: NaN, periodMs: NaN, prevChangeMs: undefined } },
  { period: { peak: true, nextChangeMs: -5, periodMs: 0 } },
]) {
  const phase = periodPhase({ generatedAt: at, period: broken.period }, at)
  must(phase !== undefined, `脏数据仍应给出一份可渲染的相位：${JSON.stringify(broken)}`)
  const html = renderToStaticMarkup(React.createElement(PeriodDot, { phase }))
  must(!html.includes('NaN'), `脏数据不得渲染出 NaN：${JSON.stringify(broken)} → ${html}`)
  must(!html.includes('Infinity'), `脏数据不得渲染出 Infinity：${JSON.stringify(broken)} → ${html}`)
  must(!html.includes('undefined'), `脏数据不得渲染出 undefined：${JSON.stringify(broken)} → ${html}`)
  must(Number.isFinite(phase.remainMs), '时间字段必须是有限数')
  must(typeof phase.caption === 'string' && phase.caption !== '', '文案必须始终是可读字符串')
}

// 6) 拿不到快照时什么都不显示——旧宿主上它就是不存在，
//    而不是写一句永远停在「空闲」的话（那是在陈述一个我们并不知道的事实）。
for (const empty of [undefined, null, {}, { period: null }, { period: 'x' }]) {
  must(periodPhase(empty, at) === undefined, `没有可用快照时不应给出相位：${JSON.stringify(empty)}`)
  must(
    renderToStaticMarkup(React.createElement(PeriodDot, { phase: periodPhase(empty, at) })) === '',
    `没有相位信息时不应渲染倒计时：${JSON.stringify(empty)}`,
  )
}

// 7) 渲染结果：**只有文字，没有环形进度**。
//    环已按需求移除——它要「已走 ÷ 总长」，而各段长度差几十倍（午休 2 小时、
//    周末 63 小时），环在周末几乎不动，看起来像坏了。这一段把「不再画环」钉住，
//    防止有人把它加回来。
const peakHtml = renderToStaticMarkup(React.createElement(PeriodDot, { phase: quarter }))
must(!peakHtml.includes('<svg'), `不应再画环形进度：${peakHtml}`)
must(!peakHtml.includes('px-period-dot'), `不应再有环的样式类：${peakHtml}`)
must(!peakHtml.includes('stroke-dasharray'), '不应再有进度弧')
must(peakHtml.includes('45分后空闲期'), `高峰那一行应写出文案：${peakHtml}`)
must(peakHtml.includes('px-period-tone-red'), '高峰应用红色')
must(!peakHtml.includes('px-period-tone-green'), '高峰不应带绿色')
const idleHtml = renderToStaticMarkup(React.createElement(PeriodDot, { phase: idleQuarter }))
must(idleHtml.includes('px-period-tone-green'), '空闲应用绿色')
must(!idleHtml.includes('px-period-tone-red'), '空闲不应带红色')
must(idleHtml.includes('空闲期剩45分'), `空闲那一行应写出文案：${idleHtml}`)
must(!peakHtml.includes('px-period-text'), '不再有两行文字块（已改为单行）')

// 8) 悬停说明：状态 + 倒计时 + 时区；没有相位时退回原来的按钮文案。
must(periodTitle(quarter).includes('高峰时段'), `title 应含状态：${periodTitle(quarter)}`)
must(periodTitle(quarter).includes('距转空闲'), `title 应含倒计时方向：${periodTitle(quarter)}`)
must(periodTitle(quarter).includes('Asia/Shanghai'), `title 应含时区：${periodTitle(quarter)}`)
must(periodTitle(undefined) === '用量看板', '拿不到相位时应退回原来的按钮文案')

// 9) 接线闸门：指示灯必须真的挂在**侧栏按钮**里，且必须按行宽选对排版。
//
//    静态渲染跑不到 useEffect（服务端渲染不执行副作用），所以上面的 entry 渲染
//    永远拿不到相位、也就永远看不到这颗点——「忘了把 PeriodDot 放进按钮」这种
//    回归能一路溜过去。因此这里**直接渲染已导出的展示层** `PanelEntryView`
//    （取数与量宽度都在它的调用方，故它本身是纯的），逐条断言排版结果。
{
  const { PanelEntryView } = await import(
    pathToFileURL(join(root, 'lib', 'client', 'entry.js')).href
  )
  // panelEntryLayout 住在 period.js（与 PeriodDot 同处，几何参数只有一份来源）
  const { panelEntryLayout: layoutOf } = await import(
    pathToFileURL(join(root, 'lib', 'client', 'period.js')).href
  )
  const panelEntryLayout = layoutOf
  // entry.js 现在只做取数与接线，展示层拆在 PanelEntryView 里；两者都必须在。
  must(typeof PanelEntryView === 'function', 'entry.js 应导出 PanelEntryView（展示层，供闸门直接渲染）')
  const source = String(entryRegistration.component)
  // portal / 量宽度这些结构住在模块级函数（usePanelRow）里，不在组件体内，
  // 因此查**整个 entry.js 源码**；组件体内的接线单独查 `source`。
  const entrySource = readFileSync(join(root, 'lib', 'client', 'entry.js'), 'utf8')
  must(/\bPanelEntryView\b/.test(source),
    '侧栏按钮必须渲染 PanelEntryView，否则指示灯永远不会出现')
  must(/\busePeriodPhase\b/.test(source),
    '侧栏按钮必须通过 usePeriodPhase 取相位，否则指示灯永远没有数据')
  must(/\bpanelEntryLayout\b/.test(source),
    '侧栏按钮必须用 panelEntryLayout 决定环显示成什么样子')

  // ── 这是用户报的那条：环必须离开柱状图标 ─────────────────────────
  //
  // 根因是**结构**的：产品只把**图标槽**给插件，而图标槽是内容宽度（十几像素）。
  // 早先在插槽内部用绝对定位 + `right: 8px`，那个 right 是相对**图标槽**解析的，
  // 环因此怎么都离不开柱状图标；量行宽也同样只量到图标宽度，判定永远落在窄行档。
  // 正确做法是 portal 进产品的 **row 元素**，让环成为标题的 flex 兄弟节点。
  //
  // 这几条只能查源码：portal 目标要运行时才拿得到，静态渲染里 host 是 null。
  must(/\busePanelRow\b/.test(entrySource),
    '侧栏按钮必须用 usePanelRow 找到产品的 row 元素——找不到就只能叠在图标上')
  must(/\bcreatePortal\b/.test(entrySource),
    '倒计时必须 portal 进产品 row；留在插槽里的话绝对定位只相对图标槽解析，'
    + '文字永远离不开柱状图标')
  must(/createPortal\s*\(\s*caption\s*,\s*host\s*\)/.test(entrySource),
    'createPortal 的目标必须是 usePanelRow 找到的 row 元素')
  must(!/paddingRight\s*:\s*reserve/.test(entrySource),
    '不该再用「给标题预留宽度」那套：环现在是 flex 兄弟节点，不占标题的位置')
  // 认 row 的判据：**跳过我们自己那个按钮**，取产品那一行。
  //
  // 这里曾经写反过：早先断言的是 `closest('button')`，理由是「产品的面板行本身
  // 就是一个 <button>」。看起来是结构事实，实际是错的——**我们自己**也渲染了
  // 一个 <button>，而且套在产品的 row 按钮里面。于是 closest('button') 命中的是
  // 我们自己那颗按钮：宽度只有十几像素 → 档位判定成 none → 倒计时什么都不显示，
  // 且完全不报错。现在的主判据是「第一个不是我们自己的 button 祖先」。
  //
  // 断言前必须**去掉注释**：这段代码的文档注释里就写着这些标识符，直接搜整个
  // 文件的话，把真正的代码删掉、只留注释也能通过（实测如此）——那是假闸门。
  const entryCode = entrySource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1')
  must(!/closest\(\s*'button'\s*\)/.test(entryCode),
    "usePanelRow 不得用 closest('button') 认 row——我们自己就渲染了一个 <button> "
    + '并套在产品的 row 按钮里，closest 会命中我们自己那个，量到的宽度只有图标宽')
  must(/tagName/.test(entryCode) && /BUTTON/.test(entryCode),
    "usePanelRow 必须按 tagName === 'BUTTON' 逐层找，才能把「我们自己那个」跳过去")
  must(/ownRef/.test(entryCode),
    'usePanelRow 必须用 ownRef 排除我们自己渲染的那个按钮')
  // 光「提到 ownRef」不够：真正防住 bug 的是那一句**比较**。
  // 实测过——只把 `candidate !== own` 里的排除去掉、变量声明照旧留着，
  // 这条闸门就会放行，而界面上的倒计时确实又没了。
  must(/candidate\s*!==\s*own\b/.test(entryCode),
    'usePanelRow 认 row 时必须真的把「我们自己那个按钮」比较掉'
    + '（candidate !== own）；只留着 ownRef 声明是不起作用的')
  must(/parentElement/.test(entryCode),
    'usePanelRow 应沿 parentElement 往上找 row')
  must(!/width\s*>=\s*100/.test(entryCode),
    '不该再用「宽度 ≥ 100px」当主判据认 row：首帧与收起动画里宽度可以是 0，会认错')

  // 档位：宽 → 完整文案；中 → 只有时长；窄（侧栏收起）→ 什么都不显示。
  must(panelEntryLayout({ rowWidth: 240 }).placement === 'full',
    '宽侧栏应显示完整文案（如「空闲期剩2时15分」）')
  must(panelEntryLayout({ rowWidth: 160 }).placement === 'short',
    '中等宽度应只显示时长（时期由颜色表达，省下的字留给标题）')
  must(panelEntryLayout({ rowWidth: 36 }).placement === 'none',
    '侧栏收起成图标条时什么都不该显示')
  must(panelEntryLayout({}).placement === 'none',
    '量不到行宽时应什么都不显示，而不是猜一个宽度把标题挤坏')
  // 档位必须随行宽收窄而**单调变保守**：出现「窄行反而更完整」就是门槛写反了
  const order = { full: 2, short: 1, none: 0 }
  let previous = Number.POSITIVE_INFINITY
  for (const rowWidth of [400, 240, 210, 209, 160, 150, 149, 100, 56, 36]) {
    const rank = order[panelEntryLayout({ rowWidth }).placement]
    must(rank <= previous, `行宽 ${rowWidth} 的档位不应比更宽的行更激进`)
    previous = rank
  }

  // 完整形态：一行文字 + 时间颜色区分时期
  const fullHtml = renderToStaticMarkup(React.createElement(PeriodDot, {
    phase: quarter, placement: 'full',
  }))
  must(fullHtml.includes('px-period-inline'), '应带容器类')
  must(fullHtml.includes('45分后空闲期'), `高峰应写出完整文案：${fullHtml}`)
  must(fullHtml.includes('px-period-tone-red'), '高峰应用红色')
  must(!fullHtml.includes('<svg'), '不应再画环形进度')

  // 短形态：只有时长，不带时期字样（颜色已经在说时期了）
  const shortHtml = renderToStaticMarkup(React.createElement(PeriodDot, {
    phase: quarter, placement: 'short',
  }))
  must(shortHtml.includes('45分'), `短形态应显示时长：${shortHtml}`)
  must(!shortHtml.includes('后空闲期'), '短形态不该带时期字样（那是被省掉的部分）')
  must(shortHtml.includes('px-period-tone-red'), '短形态也要用颜色区分时期')

  // 无形态：什么都不渲染
  const noneHtml = renderToStaticMarkup(React.createElement(PeriodDot, {
    phase: quarter, placement: 'none',
  }))
  must(noneHtml === '', `侧栏收起时不应渲染任何东西，实际「${noneHtml}」`)

  // 紧凑倒计时自己的边界：每个量级都要有可读且短的输出，且不得出现 NaN
  const { compactCountdown: compactOf, formatCountdown } = await import(
    pathToFileURL(join(root, 'lib', 'client', 'format.js')).href
  )
  must(compactOf(45_000) === '45秒', `45 秒应显示 45秒，实际 ${compactOf(45_000)}`)
  must(compactOf(45 * 60_000) === '45分', `45 分应显示 45分，实际 ${compactOf(45 * 60_000)}`)
  must(compactOf(3 * 3600_000 + 12 * 60_000) === '3时12分', `3 小时 12 分应显示 3时12分，实际 ${compactOf(3 * 3600_000 + 12 * 60_000)}`)
  must(compactOf(63 * 3600_000) === '2天15时', `跨周末应显示天数，实际 ${compactOf(63 * 3600_000)}`)
  must(compactOf(0) === '0秒', '归零也要有可读文本')
  must(compactOf(-5000) === '0秒', '负数应夹到 0，不得显示负倒计时')
  for (const dirty of [undefined, null, NaN, 'x', Infinity, -Infinity]) {
    const text = compactOf(dirty)
    must(!/NaN|Infinity/.test(text), `脏输入不得渲染出 NaN/Infinity：${String(dirty)} → ${text}`)
  }
  // 完整格式（悬停提示用）同样要挡住脏数据——它也在每秒重算的路径上
  for (const dirty of [undefined, null, NaN, 'x', Infinity, -Infinity]) {
    const text = formatCountdown(dirty)
    must(!/NaN|Infinity/.test(text), `完整倒计时不得渲染出 NaN/Infinity：${String(dirty)} → ${text}`)
  }

  // 没有相位时什么都不显示（旧宿主上它就是不存在），但图标照旧
  for (const placement of ['full', 'short', 'none']) {
    const bare = renderToStaticMarkup(React.createElement(PeriodDot, {
      phase: undefined, placement,
    }))
    must(bare === '', `没有相位时不应渲染倒计时（placement=${placement}）`)
  }
  const iconOnly = renderToStaticMarkup(React.createElement(PanelEntryView, { size: 18, active: false }))
  must(iconOnly.includes('<svg'), '没有相位时柱状图图标仍要在')
  must(!iconOnly.includes('px-period-dot'), 'PanelEntryView 只出图标，环由容器 portal')
}

// ── token 单位阶梯：K / M / B，不用中文「万 / 亿」────────────────────
// 这套界面里的数字几乎全是 token，而 token 的**通用单位**就是 K / M / B：
// 模型文档写「128K 上下文」「1M tokens」，写成「1.40 亿」要先在脑子里换成
// 140M 才能与文档对上。闸门把台阶与两个边界钉死：
//   1. **进位后跨阈值要升档**（999_999 不能显示成 1000.0K）；
//   2. **绝不出现中文万/亿**——换回去会让这条直接失败。
{
  const { formatTokens } = await import(
    pathToFileURL(join(root, 'lib', 'client', 'format.js')).href
  )
  const expected = [
    [0, '0'], [1, '1'], [999, '999'],
    [1000, '1.0K'], [1500, '1.5K'], [12345, '12.3K'], [99999, '100.0K'],
    [1_000_000, '1.00M'], [1_234_567, '1.23M'], [617_283_945, '617.28M'],
    [1_000_000_000, '1.00B'], [1_395_646_416, '1.40B'],
    // 边界：四舍五入会把尾数推到 1000，必须升到上一档而不是显示 1000.0K / 1000.00M
    [999_999, '1.00M'],
    [999_999_999, '1.00B'],
    // 负数（脏数据）也要按同一套走，不能崩
    [-1_234_567, '-1.23M'],
  ]
  for (const [input, want] of expected) {
    must(formatTokens(input) === want,
      `formatTokens(${input}) 应为 ${want}，实际 ${formatTokens(input)}`)
  }
  // 逐个数量级检查：任何输出都不得含中文万/亿，也不得出现 NaN / undefined
  for (const [, text] of expected) {
    must(!/万|亿/.test(text), `token 单位不得用中文万/亿：${text}`)
  }
  for (const dirty of [undefined, null, NaN, Infinity, -Infinity, 'abc', {}]) {
    const text = formatTokens(dirty)
    must(!/NaN|Infinity|undefined/.test(text),
      `脏输入不得渲染出 NaN/Infinity/undefined：${String(dirty)} → ${text}`)
    must(!/万|亿/.test(text), `脏输入也不得回落到中文单位：${String(dirty)} → ${text}`)
  }
  // 整数档（< 1000）不补小数位：`999` 而不是 `999.0`
  must(formatTokens(999) === '999', '不足 1000 时不该补小数位')
}
// ── 字体回归闸门：绝不能再引入点阵/像素字体或全局强制换字体 ────────
const { STYLES } = await import(pathToFileURL(join(root, 'lib', 'client', 'theme.js')).href)
const css = STYLES.map(([, text]) => text).join('\n')
for (const banned of ['Fusion Pixel', 'Zpix', 'pixel-font']) {
  must(!css.includes(banned), `样式里出现了点阵字体「${banned}」，读起来累，必须用正常字体`)
}
must(
  !/body\s*\{[^}]*font-family\s*:[^;}]*!important/.test(css),
  '不得对 body 强制替换字体（中文点阵字体缺失时会整体回落成等宽，界面会变丑）',
)
must(css.includes('tabular-nums'), '数字应保留 tabular-nums，保证并排数字不跳动')

// ── 倒计时文字的样式闸门 ────────────────────────────────────────
// 一行文字、两种颜色、推到行尾。这几条写错了不会有任何报错，
// 只是文字挤在图标上、或者两个时期同色、或者不靠右。
must(css.includes('.px-panel-entry'),
  '缺少 .px-panel-entry 容器样式（图标槽里的内容容器）')
must(css.includes('.px-period-inline'), '缺少倒计时文字的容器样式')
{
  const inlineBlock = /\.px-period-inline\s*\{([^}]*)\}/.exec(css)
  must(inlineBlock !== null, '无法解析 .px-period-inline 规则')
  // 推到行尾：标题才不会被挤到中间
  must(/margin-left\s*:\s*auto/.test(inlineBlock[1]),
    '应 margin-left: auto 把文字推到行尾，标题才不会被挤到中间')
  // 不得绝对定位：一旦绝对定位，right 只相对图标槽解析，文字离不开柱状图标
  must(!/position\s*:\s*absolute/.test(inlineBlock[1]),
    '倒计时不得绝对定位——它必须是 row 里的普通 flex 项')
  must(!/position\s*:\s*fixed/.test(inlineBlock[1]), '倒计时不得 fixed')
  must(/pointer-events\s*:\s*none/.test(inlineBlock[1]),
    '倒计时要 pointer-events: none，否则会抢走按钮的悬停/点击')
  // 不折行：这一行本来就窄，折成两行会把侧栏那一行撑高
  must(/white-space\s*:\s*nowrap/.test(inlineBlock[1]),
    '倒计时必须 white-space: nowrap，否则窄栏里会折成两行把行高撑开')
  // 等宽数字：倒计时每秒变，不等宽会左右抖动
  must(/tabular-nums/.test(inlineBlock[1]),
    '倒计时必须 tabular-nums，否则每秒变化时数字宽度跳动')
}
// 两个时期必须各有一色，而且**是不同的两种色**：
// 只写一个的话另一档会渲染成继承色，与普通文字混在一起、看不出是哪一段。
must(css.includes('.px-period-tone-red'), '缺少高峰（红）的样式')
must(css.includes('.px-period-tone-green'), '缺少空闲（绿）的样式')
{
  const red = /\.px-period-tone-red\s*\{[^}]*color\s*:\s*([^;]+);/.exec(css)
  const green = /\.px-period-tone-green\s*\{[^}]*color\s*:\s*([^;]+);/.exec(css)
  must(red !== null && green !== null, '高峰/空闲两色都要真的设置 color')
  must(red[1].trim() !== green[1].trim(),
    `高峰与空闲必须是不同的颜色，实际都是 ${red[1].trim()}——两色相同的话颜色就不区分时期了`)
  // 走 --px-* 令牌：深浅两套各自定义，深色下会自动换成更亮的那一支
  must(/var\(--px-tone-/.test(red[1]) && /var\(--px-tone-/.test(green[1]),
    '两色都应走 --px-* 令牌（深浅两套各自定义，否则深色下会糊在暗底上）')
}
// 环已经删掉了：这些类不该再出现在样式里（留着会让人以为还有一条渲染路径，
// 而那段 CSS 已经没有任何元素会用）
for (const dead of ['.px-period-dot', '.px-period-dot-track', '.px-period-dot-arc',
  '.px-period-dot-core', '.px-period-dot-svg', '.px-period-text', '.px-period-dot-text',
  '.px-period-dot-inline']) {
  const asSelector = new RegExp(`${dead.replace(/\./g, '\\.')}\\s*[,{]`)
  must(!asSelector.test(css),
    `样式里残留了已删除的 ${dead} 规则——环形进度已按需求移除，不该再有它的样式`)
}

// ── 深色模式闸门 ────────────────────────────────────────────────
// 产品把深色标记打在 **body** 上，两处都是：
//   boot-theme.ts:  document.body.toggleAttribute('data-ds-dark-theme', dark)
//   ThemePresenter: body.setAttribute(DARK_ATTRIBUTE, '')
// 只碰 documentElement 的 `color-scheme`。早先这里写成 `html[data-ds-dark-theme]`，
// 那个选择器永远不命中，于是深色下整套 --px-* 仍是浅色值（白底白字）。
// 这条断言把「选择器写错作用元素」这种静默失效钉住。
must(
  !/html\[data-ds-dark-theme\]/.test(css),
  '深色选择器必须写 body[data-ds-dark-theme]——产品把该属性设在 body 上，'
  + '写成 html[...] 永远不命中，深色模式会整套失效',
)
must(
  /body\[data-ds-dark-theme\]\s*\{/.test(css),
  '缺少 body[data-ds-dark-theme] 规则：深色模式没有令牌定义',
)
// 深色必须真的重定义核心令牌，而不是只写个空块
const darkBlock = /body\[data-ds-dark-theme\]\s*\{([\s\S]*?)\}/.exec(css)
must(darkBlock !== null, '深色令牌块无法解析')
for (const token of ['--px-ink', '--px-surface', '--px-surface-2', '--px-muted', '--px-label-tertiary']) {
  must(darkBlock[1].includes(token), `深色块里缺少 ${token} 的重定义`)
}
// 深浅两套取值必须不同：相同就说明只下发了一套配色
const lightBlock = /:root\s*\{([\s\S]*?)\}/.exec(css)
const valueOf = (block, name) => new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block)?.[1]?.trim()
for (const token of ['--px-ink', '--px-surface', '--px-surface-2']) {
  const light = valueOf(lightBlock[1], token)
  const dark = valueOf(darkBlock[1], token)
  must(light !== undefined && dark !== undefined, `${token} 缺少明或暗取值`)
  must(light !== dark, `${token} 的明暗取值相同，切到深色不会变色`)
}
// 插件 CSS 不得直接读产品 --dsw-* 令牌当文字色：产品把它以**内联样式**写在 body 上，
// 内联优先级高于 <style>，插件既覆盖不了也控制不了它的明暗。
must(
  !/color:\s*var\(--dsw-/.test(css),
  '文字色不得直接依赖 --dsw-* 令牌（产品以内联样式写在 body 上，插件无法按主题覆盖）；'
  + '请改用插件自己的 --px-* 令牌',
)

// ── 每一档颜色都要有成套的 CSS（踩过一次）─────────────────────────
// 折线的 tone 取自 `TONES`，而 `.px-line/.px-dot/.px-legend-swatch` 各自需要一条
// 规则。早先只有 blue / purple / pink 三套，于是「按模型 / 提供商分组」能画出
// 6 条线时，后三色**既不显色、图例也是空方块**——曲线与图例对不上号，
// 而且完全没有报错。这里按 TONES 逐个类名断言，加一档颜色就会自动被要求补齐。
{
  const { TONES } = await import(pathToFileURL(join(root, 'lib', 'client', 'usage.js')).href)
  must(Array.isArray(TONES) && TONES.length >= 3, 'TONES 应至少有三种配色')
  must(new Set(TONES).size === TONES.length, 'TONES 里不得有重复配色')
  for (const tone of TONES) {
    // 三种命名体系各有一处用途，缺一个就有一处画不出来：
    //   .px-line.px-tone-X        → 折线 stroke
    //   .px-dot.px-tone-X         → 悬停圆点 fill
    //   .px-legend-swatch.px-tone-X → 图例色块 background
    //   .px-tone-fill-X           → SVG fill（单独一套类名，见 toneFill()）
    for (const sel of [`px-line.px-tone-${tone}`, `px-dot.px-tone-${tone}`,
      `px-legend-swatch.px-tone-${tone}`, `px-tone-fill-${tone}`]) {
      const rule = new RegExp(`\\.${sel.replace(/\./g, '\\.')}\\s*[,{]`)
      must(rule.test(css), `缺少 .${sel} 规则——该配色在这个位置画不出来`)
    }
  }
}
// 旧布局的规则不该作为**选择器**留在产物里（留着会让人以为还有一条渲染路径）。
// 注意只查「选择器 + {」，不查整个字符串：注释里解释「为什么删掉它」是好事，
// 不该被这条闸门误伤。
for (const dead of ['.px-clock-value', '.px-offpeak']) {
  const asSelector = new RegExp(`${dead.replace('.', '\\.')}\\s*[,{]`)
  must(
    !asSelector.test(css),
    `样式里残留了已废弃的 ${dead} 规则（布局改版后没有元素再用它）`,
  )
}

// ── 通知提示条：回落通道必须有自己的样式 ──────────────────────────
// 系统通知不可用时，页面内提示条是**唯一**的可见通道。样式全走 CSS 类名，
// 少一条规则就会渲染出一个没有定位、没有底色的裸 div——它不会报错，
// 只是安静地糊在页面角落。因此这里断言几条关键规则确实存在。
for (const rule of ['.px-toast-host', '.px-toast-title', '.px-toast-body']) {
  must(css.includes(rule), `缺少通知提示条样式 ${rule}`)
}
must(
  /\.px-toast-host\s*\{[^}]*position\s*:\s*fixed/.test(css),
  '提示条容器必须 position: fixed，否则会挤动产品布局',
)
must(
  /\.px-toast-host\s*\{[^}]*z-index\s*:/.test(css),
  '提示条容器必须带 z-index，否则会被产品面板盖住',
)
// 三种等级各有一支左边框色，否则「失败」与「完成」看起来一模一样
for (const level of ['ok', 'warn', 'error']) {
  must(css.includes(`.px-toast-${level}`), `提示条缺少 ${level} 等级样式`)
}

// ── 第 2 关：用真实形状数据把整页渲染出来 ────────────────────────
const { View } = await import(pathToFileURL(join(root, 'lib', 'client', 'dashboard.js')).href)
must(typeof View === 'function', 'dashboard.js 没有导出 View')

const payload = buildPayload()

// ── 多厂商费用：GLM 不分时只列一列，估算价要标注 ─────────────────
const glmHtml = renderToStaticMarkup(React.createElement(View, {
  data: buildPayload({ models: 'multi' }),
  now: Date.now(),
  refreshing: false,
  onRefresh: () => {},
  balance: { enabled: true, available: true, balances: [{ currency: 'CNY', total: 1 }] },
  onToggleBalance: () => {},
}))
must(glmHtml.includes('GLM-5.3'), '多模型数据下应渲染 GLM 模型')
must(glmHtml.includes('不分时'), 'GLM 是不分时定价，界面应说明')
must(glmHtml.includes('智谱'), '应标出厂商')
must(glmHtml.includes('估算价'), '价目表里没有的模型必须标成估算价，而不是假装是官方价')

// ── 费用明细：条目身份是「模型 × 提供商」，且表头与每一行的列数必须一致 ──
//
// 这条闸门是**回归**用的：早先表头按「有没有不分时的条目」二选一，而行按各自的
// `flat` 标志决定要不要多画一格。只要有一行判错（GLM 因为客户端查不到价目而
// 回落成 Flash 价，被误判成分时），整张表从那一行起就错位——金额落进了
// 「空闲 token」那一列，表头还少一个。用户看到的就是「金额列也是用量」。
// 因此这里逐行数单元格，而不是只找关键字。
// 费用明细表的 HTML 片段，供下面几条闸门共用（块外的归组闸门也要用）。
const costTable = glmHtml.slice(
  glmHtml.indexOf('px-cost-table'),
  glmHtml.indexOf('px-rate-list'),
)
{
  must(costTable !== '', '费用明细表应渲染出来')
  /** 取出 `<table>` 里的所有行。 */
  const rows = costTable.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []
  must(rows.length >= 4, `费用明细应有表头 + 若干数据行 + 合计行，实际 ${rows.length} 行`)
  const cellsOf = (row) => (row.match(/<t[hd][\s>]/g) ?? []).length
  const header = cellsOf(rows[0])
  must(header === 5, `费用明细表头应是「模型 / 提供商 / 高峰 token / 空闲 token / 金额」五列，实际 ${header} 列`)
  for (const [index, row] of rows.entries()) {
    must(
      cellsOf(row) === header,
      `费用明细第 ${index + 1} 行的列数（${cellsOf(row)}）与表头（${header}）不一致——列错位会让金额显示成用量`,
    )
  }
  // 表头必须把每一列都说清楚，不能让读者靠猜
  for (const title of ['模型', '提供商', '高峰 token', '空闲 token', '金额']) {
    must(rows[0].includes(title), `费用明细表头缺少「${title}」`)
  }
  // 提供商要显示成设置里的名字，并单列一列（而不是塞在模型名里）
  must(costTable.includes('DeepSeek 官方'), '提供商应显示 DSH 设置里的外显名')
  must(costTable.includes('智谱 GLM Coding Plan'), '套餐厂商的提供商列应显示其套餐名')
  // 旧账本记录没有提供商：必须明说，而不是空着让人以为是渲染坏了
  must(costTable.includes('来源未知'), '没有提供商信息的旧记录应标「来源未知」')
}

// ── 单价列表按**模型**归组，不逐提供商重复同一份价 ──────────────────
//
// 事实依据：**价目表本身就按模型索引**（`MODEL_RATES` 的键里没有提供商）。
// 同一个模型走 N 条路由，`rates` 就是同一份对象——实测本机 4 条 `deepseek-flash`
// 的单价逐字相同，却把「缓存命中 ¥0.02 / ¥0.04 · 未命中 ¥1 / ¥2 · 输出 ¥4 / ¥8」
// 整整重复了 4 遍。数字、单位、厂商都一样，唯一不同的是**用量**，而用量在上面的表里。
//
// 归组键必须是 `rollup`（价目表的键），**不能**是「价格数字相同」：后者会把两个
// 恰好同价的**不同模型**并成一条，把模型名抹掉。
{
  const rateRows = glmHtml.split('<div class="px-rate">').slice(1)
  // fixture 里 deepseek-flash 有 2 个提供商（official + workbuddy），
  // 加上 glm / mystery / v4-pro（无提供商那条），应当是 4 条单价而不是 5 条
  must(rateRows.length === 4,
    `单价列表应把同一模型的多个提供商并成一条，实际 ${rateRows.length} 条`)
  // 用**归一键**（每行都渲染了它）定位，而不是用模型名——否则「名字取错了」
  // 这个 bug 会让过滤器找不到行，闸门以一个误导性的理由失败，就分不清是
  // 「合并没生效」还是「名字取错了」。这两件事要分开断言。
  const flashRates = rateRows.filter((row) => row.includes('deepseek-flash'))
  must(flashRates.length === 1,
    `deepseek-flash 的单价只应出现一次（两个提供商合并成一条），实际 ${flashRates.length} 次`)
  // 模型名必须用**官方名**，不能是某个提供商给它的外显名。
  // fixture 里各条目的 `label` 是 DSH 设置里的路由名（`DeepSeek-V41-Flash` /
  // `COD-DeepSeek V4.1 Flash`），与价目表官方名 `DeepSeek Flash` 不同：
  // 取「排第一的那个」会让名字随用量排序变化，而价格是模型的属性。
  must(flashRates[0].includes('DeepSeek Flash'),
    '单价行应显示价目表里的官方模型名（DeepSeek Flash）')
  must(!/COD-|DeepSeek-V41-Flash/.test(flashRates[0]),
    '单价行不得使用某个提供商给它的外显名——各家叫法不同，且会随排序变化')
  // 表头把「这是官方价」和单位、分档顺序**说一次**，不必每行重复——
  // 每行重复一遍正是排版乱的根源（一行里塞了 6 类元素）。
  must(glmHtml.includes('各模型官方单价'), '单价表要有表头说明这是官方价')
  must(glmHtml.includes('元 / 百万 token'), '单价表要说明单位')
  must(glmHtml.includes('空闲 / 高峰'), '单价表要说明两个值的顺序，否则 ¥0.02 / ¥0.04 分不清哪个是哪个')
  // 措辞不能是「这几家通用」——第三方中转与 Coding Plan 是买断制，
  // 不按 token 收费，说它们「也收这个价」是错的（见 lib/pricing.js 的口径）。
  must(!flashRates[0].includes('通用'),
    '不得写成「这几家通用」——第三方是买断制，不按 token 收费，那样写是错的')
  // 一行里只写「有几个来源」，不把提供商名字铺开（那是排版乱的直接原因）
  must(flashRates[0].includes('4 个来源') || flashRates[0].includes('2 个来源'),
    '多来源应只标数量，不铺开名字')
  // 组内每个提供商的色块都要保留：与环图配色一一对应，少一个就对不上号
  const swatches = (flashRates[0].match(/px-rate-swatch/g) ?? []).length
  must(swatches === 2,
    `合并后仍应保留每个提供商的色块（2 个），实际 ${swatches} 个`)
  // 不同模型**不得**被并到一起（即使恰好同价）。
  // 按归一键定位，避免依赖某一处的显示名（fixture 里各条目的 label 是路由名，
  // 与价目表官方名不同——这正是上面那条要断言的事）。
  must(rateRows.filter((row) => row.includes('glm-5.3')).length === 1,
    'GLM-5.3 应有自己的一条单价')
  must(rateRows.filter((row) => row.includes('deepseek-v4-pro')).length === 1,
    'DeepSeek V4 Pro 应有自己的一条单价')
  // 费用明细**表**仍然逐提供商成行（用量与额度归属不同，不能合并）
  must(costTable.includes('WorkBuddy 中国区'),
    '费用明细表仍应逐提供商列出用量——那里合并会丢掉归属')
}

// ── 订阅套餐额度：纯逻辑 + 看板卡片 + 费用条那一枚 ───────────────
const {
  formatQuota, windowProgress, quotaTone, formatReset, providerStatus, hasAnyQuota, tightestWindow,
} = await import(pathToFileURL(join(root, 'lib', 'client', 'plans.js')).href)

// 单位：智谱是积分、Command Code 是美元信用额，数值必须带单位前缀
must(formatQuota(12000, '') === '12000', `整数应原样显示，实际 ${formatQuota(12000, '')}`)
must(formatQuota(70, '$') === '$70', '美元信用额应带 $ 前缀')
must(formatQuota(0.24, '$') === '$0.24', '带小数的信用额应保留两位')
// 缺失绝不能显示成 0
must(formatQuota(undefined, '$') === '—', `缺失额度应显示 —，实际 ${formatQuota(undefined, '$')}`)
must(formatQuota(null, '$') === '—', 'null 额度应显示 —')

// 窗口进度：有绝对值优先，只有百分比时标 estimated
const wAbsolute = windowProgress({ used: 30, total: 100, usedPercent: 30, remaining: 70 })
must(wAbsolute.usable === true, '有绝对值时应可用')
must(wAbsolute.percent === 30, `百分比应为 30，实际 ${wAbsolute.percent}`)
must(wAbsolute.estimated === false, '有绝对值时不应标 estimated')
must(wAbsolute.remainingText === '70', `剩余应为 70，实际 ${wAbsolute.remainingText}`)
const wPercentOnly = windowProgress({ usedPercent: 61.8, percentOnly: true })
must(wPercentOnly.usable === true, '只有百分比时也应能画进度')
must(wPercentOnly.estimated === true, '只有百分比时必须标 estimated')
const wEmpty = windowProgress({})
must(wEmpty.usable === false, '什么都没有时应标记不可用，界面显示 — 而不是画空条')
must(wEmpty.remainingText === '—', '缺失剩余应显示 —')

// 额度可以**用超**（官方会给出 >100 的百分比）。真值必须保留，
// 只有进度条宽度夹取：把 140% 显示成 100% 等于把「严重超限」伪装成「刚好用满」。
const wOver = windowProgress({ used: 140, total: 100, usedPercent: 140, remaining: -40 })
must(wOver.percent === 140, `超限时百分比应保留真值 140，实际 ${wOver.percent}`)
must(wOver.barPercent === 100, '进度条宽度应夹到 100，不能画出界')
must(wOver.over === true, '超限必须被标记出来')
must(wOver.percent !== wOver.barPercent || wOver.over === true, '超限信息不得被夹取吞掉')
// 负数百分比没有意义，应挡掉
must(windowProgress({ usedPercent: -5 }).percent === 0, '负百分比应归零')

// 色调阈值
must(quotaTone(10, false) === 'green', '低占用应是绿色')
must(quotaTone(80, false) === 'yellow', '80% 应是黄色')
must(quotaTone(95, false) === 'red', '95% 应是红色')
must(quotaTone(10, true) === 'red', '已超限必须红色，与实际占用无关')

// 重置倒计时
const RESET_BASE = Date.parse('2026-09-10T12:00:00Z')
must(formatReset(RESET_BASE + 3 * 3600_000 + 12 * 60_000, RESET_BASE) === '3 小时 12 分后重置', '应格式化小时+分钟')
must(formatReset(RESET_BASE + 2 * 86_400_000, RESET_BASE) === '2 天 0 小时后重置', '跨天应显示天数')
must(formatReset(RESET_BASE - 1000, RESET_BASE) === '即将重置', '已过期应显示即将重置')
must(formatReset(undefined, RESET_BASE) === undefined, '无时刻时应返回 undefined')

// 状态文案：每种降级都要可读，且要指出该配哪个凭据
must(providerStatus({ ok: false, reason: 'no-key', keyRef: 'ZHIPU_CODING_API_KEY' }).text.includes('ZHIPU_CODING_API_KEY'),
  '没配 Key 时应指明凭据名')
must(providerStatus({ ok: false, reason: 'rejected', error: 'Authentication Failed' }).text.includes('Authentication Failed'),
  '鉴权被拒时应带上原因')
must(providerStatus({ ok: false, reason: 'request-failed', error: 'HTTP 500' }).level === 'error', '请求失败应是错误态')
must(providerStatus({ ok: true, windows: [{ window: 'fiveHour' }] }).level === 'ok', '有窗口应为 ok')
must(providerStatus({ ok: true, windows: [] }).level === 'warn', '成功但没窗口应是警告态')

// ── 厂商分组：判据是「有没有配过」，不是「成功还是失败」─────────────
// 用户报过：没配置的厂商（如当时的 GLM Coding Plan）不必一直占着面板。
// 但这件事有个**必须分清**的边界：`no-key`（从没配过）与 `rejected`
// （配过了但坏了）看起来都是 `ok:false`，混成一件就会把用户自己接上、
// 现在出问题的那一家藏起来——那等于让他以为插件不支持它。
{
  const { partitionProviders: split } = await import(
    pathToFileURL(join(root, 'lib', 'client', 'plans.js')).href)
  const list = [
    { id: 'ok1', ok: true },
    { id: 'never', ok: false, reason: 'no-key' },
    { id: 'broken', ok: false, reason: 'rejected', error: 'Authentication Failed' },
    { id: 'down', ok: false, reason: 'request-failed', error: 'HTTP 500' },
  ]
  const base = split(list, {})
  must(base.idle.map((p) => p.id).join(',') === 'never',
    `只有「从没配过凭据」的才该收起来，实际收起：${base.idle.map((p) => p.id).join(',')}`)
  for (const id of ['ok1', 'broken', 'down']) {
    must(base.active.some((p) => p.id === id), `${id} 必须留在显眼处（配过 / 可用）`)
  }
  // 用户显式选中的那一家必须留下：切换器里点了它、下面却没有它，是自相矛盾的界面
  must(split(list, { selected: 'never' }).active.some((p) => p.id === 'never'),
    '用户选中的那一家人不能被收进折叠区')
  // 当前监看的那一家同理（切换器上标着「当前监看」）
  must(split(list, { current: 'never' }).active.some((p) => p.id === 'never'),
    '当前监看的那一家不能被收进折叠区')
  must(split([], {}).active.length === 0 && split([], {}).idle.length === 0, '空清单不该抛错')
  must(split(undefined, {}).active.length === 0, '缺 providers 时不该抛错')
  // 顺序必须保持宿主给的顺序，否则面板每次刷新都在跳
  const order = split([
    { id: 'a', ok: true }, { id: 'b', ok: false, reason: 'no-key' }, { id: 'c', ok: true },
  ], {})
  must(order.active.map((p) => p.id).join(',') === 'a,c', '显眼组应保持宿主顺序')
}

// 汇总：至少一家可用 / 最紧窗口
const planPayload = {
  enabled: true,
  providers: [
    { id: 'zhipu', name: '智谱', ok: true, windows: [
      { window: 'fiveHour', label: '5 小时', usedPercent: 61.8, percentOnly: true },
      { window: 'weekly', label: '每周', usedPercent: 35.2, percentOnly: true },
    ] },
    { id: 'commandcode', name: 'Command Code', ok: true, windows: [
      { window: 'fiveHour', label: '5 小时', used: 0.24, total: 3, usedPercent: 8, remaining: 2.76 },
      { window: 'monthly', label: '每月', used: 23, total: 100, usedPercent: 23, remaining: 77 },
    ] },
    // 火山方舟：绝对值窗口（Agent Plan），且 note 里要说清要的是 AK/SK
    { id: 'volcengine', name: '火山方舟 Coding Plan', ok: true, plan: 'Agent Plan small', note: '用量接口在控制面，需火山账号的 AccessKey ID / Secret（与推理用的 ark- Key 是两套凭据）。', windows: [
      { window: 'fiveHour', label: '5 小时', used: 250, total: 1000, usedPercent: 25, remaining: 750 },
      { window: 'weekly', label: '每周', used: 12500, total: 50000, usedPercent: 25, remaining: 37500 },
    ] },
  ],
}
must(hasAnyQuota(planPayload) === true, '有额度时应为真')
must(hasAnyQuota({ providers: [{ ok: false }] }) === false, '全失败时应为假')
const tightest = tightestWindow(planPayload)
must(tightest !== undefined, '应能找出最紧窗口')
must(tightest.percent === 61.8, `最紧窗口应是智谱 5 小时（61.8%），实际 ${tightest?.percent}`)
must(tightestWindow({ providers: [] }) === undefined, '没有数据时应返回 undefined')

// 看板：带上套餐数据渲染，断言卡片与进度条都出现
const plansHtml = renderToStaticMarkup(React.createElement(View, {
  data: payload,
  now: payload.generatedAt,
  refreshing: false,
  onRefresh: () => {},
  balance: { enabled: true, available: true, balances: [{ currency: 'CNY', total: 12.34 }] },
  plans: planPayload,
  plansBusy: false,
  onTogglePlans: () => {},
}))
for (const token of ['账户与套餐', '智谱', 'Command Code', '火山方舟', '5 小时', '每周', '每月', 'px-quota-fill', 'px-plan-name']) {
  must(plansHtml.includes(token), `套餐面板缺少「${token}」`)
}
must(plansHtml.includes('61.8%'), '套餐面板应显示已用百分比')
must(plansHtml.includes('没有公开文档化的额度接口'), '套餐面板必须写明接口是未文档化的（诚实披露）')
must(plansHtml.includes('不会离开本机'), '套餐面板必须写明凭据不出本机')
must(plansHtml.includes('编程套餐专属'), '套餐面板应提示智谱需要套餐专属 Key')
// 火山的凭据是**另一套**（控制面 AK/SK，不是推理 Key）。界面必须说清楚，
// 否则用户会把自己唯一的 ark- Key 填进去、然后一直失败。
must(plansHtml.includes('AccessKey'), '套餐面板应说明火山要的是 AccessKey（不是推理 Key）')
// 充值 / 管理入口：用户看到额度不够时的下一步动作
must(plansHtml.includes('commandcode.ai/studio'), '套餐面板应给出 Command Code 管理入口')
must(plansHtml.includes('console.volcengine.com'), '套餐面板应给出火山控制台入口')
must(plansHtml.includes('platform.deepseek.com/usage'), '余额面板应给出 DeepSeek 官方用量/充值入口')

// 没配 Key 的两家：必须给出可读原因，且看板其余部分照常
const plansEmptyHtml = renderToStaticMarkup(React.createElement(View, {
  data: payload,
  now: payload.generatedAt,
  refreshing: false,
  onRefresh: () => {},
  plans: {
    enabled: true,
    providers: [
      { id: 'zhipu', name: '智谱 GLM Coding Plan', ok: false, reason: 'no-key', keyRef: 'ZHIPU_CODING_API_KEY', windows: [], supportedWindows: ['fiveHour', 'weekly'] },
      { id: 'commandcode', name: 'Command Code', ok: false, reason: 'no-key', keyRef: 'COMMAND_CODE_API_KEY', windows: [], supportedWindows: ['fiveHour', 'weekly', 'monthly'] },
      // 火山只配了 AK 没配 SK：必须指出缺的是哪一个，而不是笼统说「没配 Key」
      { id: 'volcengine', name: '火山方舟 Coding Plan', ok: false, reason: 'no-key', keyRef: 'VOLC_SECRET_ACCESS_KEY', keyRefs: ['VOLC_SECRET_ACCESS_KEY', 'VOLCENGINE_SECRET_ACCESS_KEY'], hint: '需要在火山引擎控制台创建 AccessKey（不是方舟的推理 API Key），两者都要配齐。', windows: [], supportedWindows: ['fiveHour', 'weekly', 'monthly'] },
    ],
  },
  onTogglePlans: () => {},
}))
must(plansEmptyHtml.includes('ZHIPU_CODING_API_KEY'), '未配智谱 Key 时应指明凭据名')
must(plansEmptyHtml.includes('COMMAND_CODE_API_KEY'), '未配 Command Code Key 时应指明凭据名')
must(plansEmptyHtml.includes('VOLC_SECRET_ACCESS_KEY'), '火山缺 SK 时应指明缺的是哪一个')
must(plansEmptyHtml.includes('AccessKey'), '火山未配时应说明要的是 AccessKey')
must(plansEmptyHtml.includes('费用明细'), '套餐不可用时看板其余部分仍应渲染')
// 一家都没配时，折叠区必须**默认展开**——否则上面是空的、下面又收起，
// 新用户既看不到插件支持哪些家，也无从知道该怎么配。
must(plansEmptyHtml.includes('未配置的厂商'), '全部未配时应出现「未配置的厂商」折叠区')
must(plansEmptyHtml.includes('配好凭据即可查看额度'), '全部未配时折叠区应默认展开（提示语可见）')

// ── 面板分组：在用的常显，没配过的收进折叠区（默认收起）────────────
{
  const groupedProviders = [
    { id: 'commandcode', name: 'Command Code', ok: true, windows: [{ window: 'fiveHour', usedPercent: 40 }] },
    { id: 'volcengine', name: '火山方舟 Coding Plan', ok: true, windows: [{ window: 'fiveHour', usedPercent: 20 }] },
    { id: 'zhipu', name: '智谱 GLM Coding Plan', ok: false, reason: 'no-key', windows: [] },
    { id: 'newvendor', name: '某新接入厂商', ok: false, reason: 'no-key', windows: [] },
    // 配过但坏了：**必须常显**，这是用户自己接的那一家出了问题
    { id: 'broken', name: '配过但坏了的一家', ok: false, reason: 'rejected', error: 'Authentication Failed', windows: [] },
  ]
  const { PlansPanel: PlansPanelHere } = await import(
    pathToFileURL(join(root, 'lib', 'client', 'dashboard.js')).href)
  const groupedHtml = renderToStaticMarkup(React.createElement(PlansPanelHere, {
    now: Date.now(),
    payload: { enabled: true, fetchedAt: Date.now(), providers: groupedProviders },
    selected: undefined, onSelect: () => {},
  }))
  // 折叠区标题与数量
  must(groupedHtml.includes('未配置的厂商'), '有在用的家时，未配的那些应收进折叠区')
  must(/>2 家</.test(groupedHtml) || groupedHtml.includes('2 家'), '折叠区标题应写明收起了几家')
  // 折叠时内容**不渲染**（省掉高度，也避免默认就把面板撑长）
  must(!groupedHtml.includes('px-plan-list-idle'), '折叠区默认应收起（内容不渲染）')
  // 常显区**只看第一个 .px-plan-list**（切换器在它上面，那里本来就该列出每一家，
  // 包括没配过的——用户要能切过去看怎么配）。用配对扫描取那一段，而不是按标题切。
  const activeListHtml = extractElement(groupedHtml, '<div class="px-plan-list">')
  must(activeListHtml !== undefined, '应有常显的 .px-plan-list')
  // 配过但坏了的那一家必须留在上面
  must(activeListHtml.includes('配过但坏了的一家'),
    '配过但鉴权被拒的那一家必须常显——藏起来等于说插件不支持它')
  must(activeListHtml.includes('Authentication Failed'), '常显的那一家要带上失败原因')
  must(activeListHtml.includes('Command Code'), '可用的那几家应常显')
  // 没配过的那两家不该出现在常显区
  must(!activeListHtml.includes('智谱 GLM Coding Plan'), '没配过的智谱不该出现在常显区')
  must(!activeListHtml.includes('某新接入厂商'), '没配过的新厂商不该出现在常显区')
  // 但它们**不能消失**：切换器里仍要能选到（用户可能就想切过去看怎么配）
  must(groupedHtml.includes('智谱') && groupedHtml.includes('某新接入厂商'),
    '被收起的厂商仍应出现在切换器里，不能整个消失')
}

// 套餐关闭态：必须说明已关闭
const plansOffHtml = renderToStaticMarkup(React.createElement(View, {
  data: payload,
  now: payload.generatedAt,
  refreshing: false,
  onRefresh: () => {},
  plans: { enabled: false, providers: [], fetchedAt: null },
  onTogglePlans: () => {},
}))
must(plansOffHtml.includes('已关闭'), '套餐关闭态应明说已关闭')

// 费用条那一枚：绑定到某家套餐时应出现那一家最紧的窗口
const dockWithQuota = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: { standard: 0.5, peak: 0.2, idle: 0.3 },
  tokens: 1000,
  account: {
    kind: 'plan',
    planId: 'zhipu',
    label: '智谱',
    fullLabel: '智谱 GLM Coding Plan',
    source: 'route',
    plan: { provider: '智谱 GLM Coding Plan', planId: 'zhipu', window: { window: 'fiveHour', label: '5 小时' }, percent: 61.8 },
  },
}))
must(dockWithQuota.includes('px-pill'), '有套餐数据时费用条应渲染额度那一枚')
must(dockWithQuota.includes('62%'), `费用条应显示最紧窗口的整数百分比：${dockWithQuota}`)
// 超过 75% 才转警戒色；这里最紧是 61.8%，不该是警戒态
must(!dockWithQuota.includes('px-pill-warn'), '未超阈值时不应是警戒态')
const dockTight = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: { standard: 0.5, peak: 0.2, idle: 0.3 },
  tokens: 1000,
  account: {
    kind: 'plan',
    planId: 'zhipu',
    label: '智谱',
    source: 'route',
    plan: { provider: '智谱', planId: 'zhipu', window: { window: 'fiveHour', label: '5 小时' }, percent: 96 },
  },
}))
// 96% 时那一枚用红色点（px-tone-bg-red），不是整块警告底色——
// 警告底色只留给「费用拿不到」这种真正的故障
must(dockTight.includes('px-tone-bg-red'), '超过 75% 时额度那一枚应转红色点')
// 没有任何可用账户事实时：不渲染那一枚，费用照常
const dockNoQuota = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: { standard: 0.5, peak: 0.2, idle: 0.3 },
  tokens: 1000,
  account: { kind: 'none' },
}))
must(!dockNoQuota.includes('5 小时'), '没有可用额度时不应渲染额度那一枚')
must(dockNoQuota.includes('本次会话'), '没有额度时费用仍要显示')

const html = renderToStaticMarkup(React.createElement(View, {
  data: payload,
  now: payload.generatedAt,
  refreshing: false,
  onRefresh: () => {},
  balance: { enabled: true, available: true, official: true, keySource: 'file', baseURL: 'https://api.deepseek.com', fetchedAt: payload.generatedAt, balances: [{ currency: 'CNY', total: 12.34, granted: 0, toppedUp: 12.34 }] },
  balanceBusy: false,
  onToggleBalance: () => {},
}))

const required = [
  '用量看板', '累计 Token', '时段与计费', '高峰时段',
  '周一至周五', '活跃日历', '趋势', '模型分布', '费用明细', '会话清单',
  '官方定价页', '账户与套餐',
  'px-seg-thumb', 'px-period-clock', 'px-stat-value', 'px-panel-dot',
  'px-barrow-fill', 'px-heat-4', 'px-slice', 'px-tone-fill-blue', 'px-rate-swatch',
  'px-balance-amount', 'px-balance-privacy', 'px-account-grid',
  // 通知与预警面板：开关、授权状态、阈值输入都在这里，缺一块就是功能没落地
  '通知与预警', 'px-notify-permission', 'px-notify-flags', 'px-notify-threshold',
  'px-notify-inputs', 'px-notify-recent', '余额预警阈值', '套餐额度预警',
  '任务完成', '失败 / 中断', '等待授权 / 回答', '当前会话不打扰',
  // 阈值并排：两项同处一个容器（原来各占一整行，白吃两倍高度）
  'px-notify-thresholds',
  // 两张趋势卡片同行 + 维度切换器
  'px-trend-row', 'px-trend-dim', '消费估计趋势', '每日消费估计',
]
for (const token of required) must(html.includes(token), `渲染结果缺少「${token}」`)
must(html.length > 20_000, `整页 HTML 只有 ${html.length} 字节，可能有区块没渲染`)

// ── 用户可见文案里不得残留 Markdown 星号 ──────────────────────────
// 这些字符串是 JSX 的文本子节点，**不会**被当成 Markdown 渲染，
// 所以写成 `**模型**` 就会把星号原样摆在用户面前。这是已经犯过一次的错
// （费用明细脚注里的「单价按**模型**列出」，以及这次的「按**各模型官方单价**」）。
//
// 检查方式：去掉标签后直接找 `**`。**不要**试图用「两侧是不是空白/标点」来缩小
// 范围——第一版就是那么写的，而中文里 `按**各模型**估算` 两侧都是汉字，
// 于是恰好漏掉了真实的 bug（闸门绿灯、星号照旧显示给用户）。
// 这个界面里没有需要用 `**` 表达的数学式，因此宁可宽一点。
{
  const visible = html.replace(/<[^>]+>/g, ' ')
  const marks = visible.match(/\*\*/g) ?? []
  must(marks.length === 0,
    `用户可见文案里有 ${marks.length} 处 Markdown 强调标记（**…**）会被原样显示；`
    + 'JSX 文本不渲染 Markdown，强调请用 <b> 元素或去掉星号')
}

// ── 布局归组闸门：时段与计费 + 活跃日历 必须在同一排 ──────────────
// 计费卡片只有几行键值对，独占整行会显得空荡；两者并排后各自都拿到合适的
// 宽度。这里断言的是**结构**而不只是类名存在：两张面板确实同处一个 .px-pair
// 容器里，且容器内恰好是这两张，顺序也固定。
/**
 * 取某个开始标签所对应元素的**完整**（配对闭合的）HTML 片段。
 * 用标签配对扫描而不是截到字符串结尾：后者会让「日历被移到容器外」这种
 * 回归悄悄通过——容器外的内容同样会落在截取的尾巴里。
 * @param {string} source - 整页 HTML。
 * @param {string} openTag - 开始标签的字面量（如 `<div class="px-pair">`）。
 * @returns {string|undefined} 含首尾标签的片段；找不到时 undefined。
 */
function extractElement(source, openTag) {
  const start = source.indexOf(openTag)
  if (start === -1) return undefined
  const name = /^<([a-zA-Z0-9-]+)/.exec(openTag)[1]
  const open = new RegExp(`<${name}\\b`, 'g')
  const close = new RegExp(`</${name}>`, 'g')
  let depth = 0
  let cursor = start
  while (cursor < source.length) {
    open.lastIndex = cursor
    close.lastIndex = cursor
    const nextOpen = open.exec(source)
    const nextClose = close.exec(source)
    if (nextClose === null) return undefined
    if (nextOpen !== null && nextOpen.index < nextClose.index) {
      depth += 1
      cursor = nextOpen.index + 1
    } else {
      depth -= 1
      if (depth === 0) return source.slice(start, nextClose.index + `</${name}>`.length)
      cursor = nextClose.index + 1
    }
  }
  return undefined
}

const pairHtml = extractElement(html, '<div class="px-pair">')
must(pairHtml !== undefined, '缺少 .px-pair 容器：时段与计费、活跃日历没有并排')
// 两张面板都必须落在**配对闭合的容器内**，且计费在左、日历在右
must(pairHtml.includes('时段与计费'), '.px-pair 里没有「时段与计费」')
must(pairHtml.includes('活跃日历'), '.px-pair 里没有「活跃日历」')
must(
  pairHtml.indexOf('时段与计费') < pairHtml.indexOf('活跃日历'),
  '.px-pair 里「时段与计费」应在左、「活跃日历」在右',
)

// ── 两张趋势卡片必须同行，且各带该带的切换器 / 合计 ────────────────
// 用户要求：Token 趋势与消费估计趋势**同行展示，不分两行**。
// 两条曲线共用同一段时间轴，分两行就会让人来回滚动去对齐同一个日期。
// 与 .px-pair 同一套配对扫描断言：必须真的同处一个容器，而不是「都在页面上」。
{
  const trendHtml = extractElement(html, '<div class="px-trend-row">')
  must(trendHtml !== undefined, '缺少 .px-trend-row 容器：两张趋势卡片没有同行')
  must(trendHtml.includes('Token 趋势'), '.px-trend-row 里没有 Token 趋势卡片')
  must(trendHtml.includes('消费估计趋势'), '.px-trend-row 里没有消费估计趋势卡片')
  must(
    trendHtml.indexOf('Token 趋势') < trendHtml.indexOf('消费估计趋势'),
    '.px-trend-row 里 Token 趋势应在左、消费估计趋势在右',
  )
  // 容器内恰好两张卡片：多塞一张进来会破坏「两张各占一半」的等分
  const panels = (trendHtml.match(/class="px-panel /g) ?? []).length
  must(panels === 2, `.px-trend-row 里应恰好两张面板，实际 ${panels}`)
  // 维度切换器在 Token 那张卡片里（不是全局），且三个维度都列出
  for (const dim of ['构成', '模型', '提供商']) {
    must(trendHtml.includes(`>${dim}</button>`), `趋势卡片缺少「${dim}」维度按钮`)
  }
  must(trendHtml.includes('px-trend-dim'), '维度切换器应有自己的类名（卡片内次级控件）')
}

// ── 「时段与计费」那枚徽标：高峰粉、空闲绿 ───────────────────────
// 它原先在高峰时**没有任何配色**（只有基础 .px-badge 的中性灰），
// 与空闲态的绿色徽标看起来是两种不同的控件；而且它明明在说「高峰」，
// 却比空闲态还不起眼。这里把两态各钉一个颜色。
//
// 这条只能靠渲染两种时段分别断言：同一个组件在 peak 真/假下产出不同的类名，
// 少写一个分支不会有任何报错，只是那一档回到中性灰。
{
  /** 造一份可指定 peak 的看板数据。 */
  const withPeak = (peak) => ({
    ...payload,
    period: { ...payload.period, peak, label: peak ? '高峰时段' : '空闲时段' },
  })
  /** 只取「时段与计费」那张面板的 HTML。 */
  const periodPanelOf = (peak) => {
    const page = renderToStaticMarkup(React.createElement(View, {
      data: withPeak(peak),
      now: payload.generatedAt,
      refreshing: false,
      onRefresh: () => {},
      balance: { enabled: true, available: true, balances: [{ currency: 'CNY', total: 1 }] },
      onToggleBalance: () => {},
    }))
    return extractElement(page, '<div class="px-pair">') ?? ''
  }

  const peakPanel = periodPanelOf(true)
  must(peakPanel.includes('高峰时段计费中'), `高峰态应写着「高峰时段计费中」：${peakPanel.slice(0, 200)}`)
  must(peakPanel.includes('px-badge peak'),
    '高峰那枚徽标必须带 peak 类——没有它就只有中性灰底色，与空闲态不像同一种东西')
  must(!/px-badge ok[^"]*"[^>]*>\s*<i class="px-pulse"><\/i>高峰/.test(peakPanel),
    '高峰态不该用空闲那枚绿色徽标')

  const idlePanel = periodPanelOf(false)
  must(idlePanel.includes('空闲时段计费中'),
    `空闲态应写着「空闲时段计费中」：${idlePanel.slice(0, 200)}`)
  must(idlePanel.includes('px-badge ok'),
    '空闲那枚徽标应保持绿色（.px-badge.ok）')
  must(!idlePanel.includes('px-badge peak'), '空闲态不该带高峰那枚粉色徽标')

  // 两态的类名必须不同：相同就说明其中一档没配色
  must(!peakPanel.includes('px-badge ok'),
    '高峰态不该带空闲那枚绿色徽标（两态必须区分开）')

  // 卡片标题的点也要跟着变：同一张卡片里标题点与徽标说的是同一件事，
  // 配色不一致（点红、徽标灰）会让人以为它们在说两件事。
  must(peakPanel.includes('px-tone-bg-pink'),
    '高峰时卡片标题的点应是主题粉（与徽标同色相）')
  must(!peakPanel.includes('px-tone-bg-red'),
    '高峰时标题点不该用红色——红留给真正的故障（取数失败、余额为负）')
  must(idlePanel.includes('px-tone-bg-green'), '空闲时标题点应是绿色')

  // 样式闸门：粉与绿必须真的落到 CSS 上，而且**色相不同**
  const { STYLES: StylesForBadge } = await import(
    pathToFileURL(join(root, 'lib', 'client', 'theme.js')).href
  )
  const badgeCss = StylesForBadge.map(([, text]) => text).join('\n')
  const peakRule = /\.px-badge\.peak\s*\{([^}]*)\}/.exec(badgeCss)
  const okRule = /\.px-badge\.ok\s*\{([^}]*)\}/.exec(badgeCss)
  must(peakRule !== null, '缺少 .px-badge.peak 规则——高峰徽标会退回中性灰')
  must(okRule !== null, '缺少 .px-badge.ok 规则（空闲徽标）')
  const colorOf = (block) => (/color\s*:\s*([^;]+);/.exec(block)?.[1] ?? '').trim()
  must(colorOf(peakRule[1]) !== '', '.px-badge.peak 必须真的设置文字颜色')
  must(colorOf(peakRule[1]) !== colorOf(okRule[1]),
    `高峰与空闲徽标的文字色必须不同，实际都是 ${colorOf(peakRule[1])}`)
  // 高峰走粉色令牌、空闲走绿色令牌（深浅两套各自定义，深色下自动换亮色）
  must(/--px-pink/.test(peakRule[1]), '高峰徽标应走 --px-pink 系列令牌')
  must(/--px-tone-green/.test(okRule[1]), '空闲徽标应走 --px-tone-green 令牌')
  must(!/--px-pink/.test(okRule[1]), '空闲徽标不该带粉色')
}
// 只数真正的面板根元素。Panel 的类名固定是「px-panel px-rise」，因此必须匹配到
// 那个空格；用 \b 会把 px-panel-head / px-panel-title / px-panel-extra 一起算进来
// （\b 在 `l` 与 `-` 之间成立），数量会虚高几倍。
const panelRoot = /class="px-panel /g
const pairPanelCount = (pairHtml.match(panelRoot) ?? []).length
must(
  pairPanelCount === 2,
  `.px-pair 里应恰好两张面板，实际 ${pairPanelCount} 张`,
)
must(
  (html.match(/class="px-pair"/g) ?? []).length === 1,
  '.px-pair 容器应恰好一个，出现多个说明布局改乱了',
)
// 窄屏必须塌回单列，否则日历会被压成一条
must(
  /@media\s*\(max-width:\s*960px\)\s*\{[\s\S]*?\.px-pair\s*\{[^}]*grid-template-columns:\s*1fr/.test(css),
  '窄屏媒体查询里缺少 .px-pair { grid-template-columns: 1fr }，日历会被压成一条',
)
// 左栏内的时段卡片要竖排：并排两栏时横排会让键值对反复折行
must(
  /\.px-pair\s+\.px-period\s*\{[^}]*grid-template-columns:\s*1fr/.test(css),
  '左栏内的 .px-period 应改成竖排（grid-template-columns: 1fr）',
)

// ── 精简版面的三条结构闸门 ───────────────────────────────────────
// 这三条锁的是「区域大小确实被压下来了」这个**结构事实**，而不只是类名存在：
// 类名写对了但元素没套在里面，看板上就是一点没变。
{
  // 1) 两项预警阈值必须同处一个 .px-notify-thresholds 容器
  const thresholds = extractElement(html, '<div class="px-notify-thresholds">')
  must(thresholds !== undefined, '两项预警阈值没有并排：缺少 .px-notify-thresholds 容器')
  must(thresholds.includes('余额预警阈值'), '.px-notify-thresholds 里没有余额阈值')
  must(thresholds.includes('套餐额度预警'), '.px-notify-thresholds 里没有套餐阈值')
  must((html.match(/class="px-notify-thresholds"/g) ?? []).length === 1,
    '.px-notify-thresholds 容器应恰好一个')
  // 窄屏必须塌回单列，否则余额那一项的输入框会挤成三行
  must(
    /@media\s*\(max-width:\s*960px\)\s*\{[\s\S]*?\.px-notify-thresholds\s*\{[^}]*grid-template-columns:\s*1fr/.test(css),
    '窄屏媒体查询里缺少 .px-notify-thresholds { grid-template-columns: 1fr }',
  )

  // 2) 会话清单默认**收起**：标题行在、表头不在。
  //    「默认收起」这件事只能这样断言——用 extractElement 取会话清单那张面板的
  //    配对闭合片段，断言里面有标题、没有 <table>。用标签配对扫描而不是截到
  //    字符串结尾：后者会让「表格被挪到面板外」这种回归悄悄通过。
  //
  //    会话清单是页面上**唯一**一张 .px-panel-collapsible 面板（最近通知用的是
  //    面板内部的 .px-collapse）。因此这里直接按类名取，并顺带断言「恰好一张」
  //    ——多出一张说明折叠被误加到了别的面板上。
  const collapsibleOpen = '<section class="px-panel px-rise px-panel-collapsible"'
  const collapsibleCount = (html.match(/class="px-panel px-rise px-panel-collapsible"/g) ?? []).length
  must(collapsibleCount === 1, `应恰好一张可折叠面板（会话清单），实际 ${collapsibleCount} 张`)
  const sessionBlock = extractElement(html, collapsibleOpen)
  must(sessionBlock !== undefined, '会话清单应该是可折叠面板（.px-panel-collapsible）')
  must(sessionBlock.includes('会话清单'), '可折叠面板里应有会话清单标题')
  // 收起时**内容根本不渲染**（不是 display:none），所以 <table> 不该出现
  must(!sessionBlock.includes('<table'),
    '会话清单默认应收起——收起态下表格不该被渲染出来（收起的是内容，标题行仍要在）')
  must(sessionBlock.includes('px-panel-extra'), '收起时右侧摘要仍要显示（否则连「有几个会话」都看不到了')
  // 折叠开关必须真的是一枚按钮（可点、可聚焦），而不是一段纯文本
  must(/<button[^>]*class="px-panel-toggle"[^>]*aria-expanded="false"/.test(sessionBlock),
    '会话清单标题行应是一枚 aria-expanded="false" 的展开按钮')

  // 3) 最近通知默认收起：标题行在、明细不在
  must(html.includes('px-collapse-head'), '最近通知缺少折叠标题行 .px-collapse-head')
  const recentStart = html.indexOf('最近通知')
  must(recentStart !== -1, '页面上找不到「最近通知」')
  // 折叠区的类名是 px-collapse[ open]；标题行与正文之间没有别的 px-collapse 前缀，
  // 因此取到下一次出现为止即可界定这一块的边界。
  const recentBoundary = html.indexOf('px-collapse', recentStart + '最近通知'.length)
  const recentBlock = html.slice(recentStart, recentBoundary === -1 ? recentStart + 400 : recentBoundary + 200)
  must(!recentBlock.includes('px-collapse-body'),
    '最近通知默认应收起——收起态下明细不该被渲染（见 Collapse 的说明）')
  must(html.includes('px-collapse-summary'), '收起时右侧仍要显示条数摘要（收起的是内容，不是数量）')
}

// 折线曲线必须真的生成 path（单调插值的产物）
must(/class="px-line px-tone-blue" d="M /.test(html), '趋势图没有生成折线 path')
// 环图的扇形必须带 fill 类，否则整圈空白（曾误用 background 类）
must(/class="px-slice px-tone-fill-/.test(html), '环图扇形缺少 fill 类，会渲染成空白')
// 图表不得再输出 preserveAspectRatio="none"（那会把几何非等比拉伸）
must(!html.includes('preserveAspectRatio'), '图表不得使用 preserveAspectRatio，会非等比拉伸变形')
// 分档单价必须出现在费用明细里，证明用的是高峰/空闲双档口径
must(html.includes('0.02') && html.includes('0.04'), '费用明细应展示空闲/高峰双档单价')

// 账户余额：金额、明细、以及隐私说明都必须在页面上
must(html.includes('¥12.34'), '余额面板应显示金额')
must(html.includes('充值') && html.includes('赠送'), '余额面板应给出充值/赠送明细')
must(html.includes('Key 不会离开本机'), '余额面板必须写明 Key 不出本机（隐私承诺要可见）')
must(html.includes('user/balance'), '余额面板应标出数据来源端点')

// ── 会话清单：第一列必须是**预览标题**（与侧栏同源），不是会话 id ──
// 会话清单默认收起，整页静态渲染到不了它，因此这里直接渲染那张表。
{
  const { SessionTable, PlansPanel: PlansPanelForGate } = await import(
    pathToFileURL(join(root, 'lib', 'client', 'dashboard.js')).href
  )
  must(typeof SessionTable === 'function', 'SessionTable 应被导出（否则这张表永远没被断言过）')

  const tableHtml = renderToStaticMarkup(React.createElement(SessionTable, {
    timezone: 'Asia/Shanghai',
    sessions: [
      {
        id: 'session-8155bc37-087f-4541-b7d6-dda20b7411cc',
        createdAt: Date.UTC(2026, 1, 9, 4, 0, 0),
        cwd: 'D:\\blog',
        workspace: 'blog',
        title: '重构会话清单的标题列',
        turns: 12,
        totals: { local: 161_000 },
        models: ['deepseek-flash'],
        live: true,
      },
      {
        // 还没有生成标题的新会话：宿主给的是工作目录末段（与侧栏一致）
        id: 'session-0f0271ab-540a-4ab4-a3d4-c5b8b1a986a0',
        createdAt: Date.UTC(2026, 1, 8, 4, 0, 0),
        cwd: 'D:\\my_project\\x',
        workspace: 'x',
        title: 'x',
        turns: 3,
        totals: { local: 900 },
        models: [],
        live: false,
      },
      {
        // 旧宿主：没有 title 字段，只有 workspace → 必须回落到工作目录末段
        // （与 DSH 的 displayTitleOf 同一条链），而不是一串十六进制
        id: 'session-abcdef01-2345-6789-abcd-ef0123456789',
        createdAt: Date.UTC(2026, 1, 7, 4, 0, 0),
        cwd: 'D:\\legacy',
        workspace: 'legacy',
        turns: 1,
        totals: { local: 100 },
        models: ['deepseek-flash'],
        live: false,
      },
      {
        // 最坏情况：title 与 workspace 都没有 → 才退回 id 片段，且不能是空白
        id: 'session-99887766-5544-3322-1100-aabbccddeeff',
        createdAt: Date.UTC(2026, 1, 6, 4, 0, 0),
        cwd: '',
        workspace: '',
        turns: 0,
        totals: { local: 0 },
        models: [],
        live: false,
      },
    ],
  }))
  must(tableHtml.includes('重构会话清单的标题列'),
    '会话清单第一列必须是预览标题——显示会话号的话用户没法把它和侧栏对上号')
  must(tableHtml.includes('px-session-title'), '标题应带 .px-session-title（闸门靠它确认渲染位置）')
  // 第二行标题等于工作区名，不该左右各写一遍
  must((tableHtml.match(/>x</g) ?? []).length === 1,
    '标题与工作区名相同时不应重复显示两遍')
  // 旧宿主（只有 workspace）：**标题槽**里应是目录末段，而不是十六进制。
  // 注意不能搜整个 HTML：会话 id 仍会以次要样式出现在同一行的 .px-session-id 里
  // （那是刻意的，排查问题要用），所以必须只看标题槽本身。
  const titleTexts = [...tableHtml.matchAll(/class="px-session-title"[^>]*>([^<]*)</g)].map((m) => m[1])
  must(titleTexts.length === 4, `应渲染 4 行会话标题，实际 ${titleTexts.length}`)
  must(titleTexts.includes('legacy'),
    `旧宿主没有 title 时，标题槽应回落到工作目录末段，实际 ${JSON.stringify(titleTexts)}`)
  must(!titleTexts.some((text) => /^[0-9a-f]{8}…$/.test(text) && text !== '99887766…'),
    `有 workspace 时标题槽不该退回十六进制 id，实际 ${JSON.stringify(titleTexts)}`)
  // 两者都没有：才退回 id 片段，且不能是空白
  must(titleTexts.some((text) => text.includes('99887766')),
    `title 与 workspace 都拿不到时才退回 id 片段，实际 ${JSON.stringify(titleTexts)}`)
  must(titleTexts.every((text) => text.trim() !== ''), '标题槽任何情况下都不能是空白')
  // 会话 id 仍可查（悬停 title），只是不在最显眼的位置
  must(tableHtml.includes('session-8155bc37-087f-4541-b7d6-dda20b7411cc'),
    '会话 id 仍应可查（悬停可复制），排查问题时要用')
  // 工作区列被并进第一列后，表头不该还有独立的「工作区」列
  must(!tableHtml.includes('<th>工作区</th>'),
    '工作区已并进标题列，不该再单开一列（会白占宽度）')

  // ── 套餐切换器 ────────────────────────────────────────────────
  const planHtml = renderToStaticMarkup(React.createElement(PlansPanelForGate, {
    now: Date.UTC(2026, 1, 9, 4, 0, 0),
    payload: planPayload,
    selected: 'commandcode',
    onSelect: () => {},
  }))
  must(planHtml.includes('px-plan-switch'), '套餐面板应带「当前监看」切换器')
  must(planHtml.includes('自动（最紧）'), '切换器必须给一个「自动」项，否则点过之后回不到自动')
  must((planHtml.match(/class="px-plan-chip[^"]*"/g) ?? []).length >= 4,
    `切换器应列出「自动 + 每一家」，实际 ${(planHtml.match(/class="px-plan-chip[^"]*"/g) ?? []).length} 枚`)
  // 选中的那一枚要有 active 标记（否则点了看不出点中谁）
  must(/class="px-plan-chip active"/.test(planHtml), '选中的那一项应带 active 类')
  // 那一家的区块要标出「当前监看」，与切换器形成可见的对应关系
  must(planHtml.includes('当前监看'), '被监看的那一家区块应标出「当前监看」')
  must(planHtml.includes('px-plan-current'), '被监看的那一家应带 .px-plan-current 样式钩子')
  // **失败的厂商也要列出来**：用户配错凭据时恰恰最想切过去看原因
  const planHtmlWithFailures = renderToStaticMarkup(React.createElement(PlansPanelForGate, {
    now: Date.UTC(2026, 1, 9, 4, 0, 0),
    payload: {
      enabled: true,
      providers: [
        { id: 'zhipu', name: '智谱 GLM Coding Plan', ok: false, reason: 'no-key', keyRef: 'ZHIPU_CODING_API_KEY', windows: [] },
        { id: 'commandcode', name: 'Command Code', ok: true, windows: [{ window: 'weekly', label: '每周', usedPercent: 10 }] },
      ],
    },
    selected: undefined,
    onSelect: () => {},
  }))
  must(planHtmlWithFailures.includes('智谱'),
    '取数失败的厂商也应出现在切换器里——用户配错凭据时最想切过去看原因')
  must(/class="px-plan-chip bad"/.test(planHtmlWithFailures), '失败的那一家应带 bad 标记')
  // 没选过（自动）时跟着**最紧**的那一家走，与费用条那一枚同一条判据
  must(planHtmlWithFailures.includes('px-plan-current'), '自动模式下也应有「当前监看」标记')

  // ── 「去哪拿凭据 + 拿到后放哪」必须在界面上真的出现 ────────────────
  // 用户报过：火山方舟那一栏只说「要 AccessKey」，既没说去哪拿，也没说拿到后
  // 往哪填——而 DSH 设置里**没有**能填 `VOLC_ACCESS_KEY_ID` 的输入框
  // （设置 → 模型只写它派生的 `<路由>_API_KEY`）。所以两半都必须可见：
  //   1. 可点的创建链接；
  //   2. 确切的引用名 + 本机凭据文件路径。
  const setupPayload = {
    enabled: true,
    fetchedAt: Date.now(),
    credentialFile: 'C:\\Users\\me\\.dsh\\.credentials.yaml',
    providers: [{
      id: 'volcengine',
      name: '火山方舟 Coding Plan',
      ok: false,
      reason: 'no-key',
      keyRef: 'VOLC_ACCESS_KEY_ID',
      keyRefs: ['VOLC_ACCESS_KEY_ID'],
      hint: '需要在火山引擎账号的 IAM 里创建 AccessKey ID / Secret Access Key，两把都要配齐。',
      setup: {
        keyURL: 'https://console.volcengine.com/iam/keymanage/',
        keyURLName: '火山引擎控制台 → API 访问密钥',
        acquire: ['打开「访问控制 → API 访问密钥」新建密钥。', '这个页面不在方舟控制台里。'],
        refs: [
          { name: 'VOLC_ACCESS_KEY_ID', example: 'AKLT...', note: 'AccessKey ID' },
          { name: 'VOLC_SECRET_ACCESS_KEY', example: '...', note: 'Secret Access Key' },
        ],
      },
      windows: [],
      supportedWindows: ['fiveHour', 'weekly', 'monthly'],
    }],
  }
  const setupHtml = renderToStaticMarkup(React.createElement(PlansPanelForGate, {
    now: Date.now(), payload: setupPayload, selected: undefined, onSelect: () => {},
  }))
  must(setupHtml.includes('这家凭据怎么配'), '面板应给出「这家凭据怎么配」入口')
  must(setupHtml.includes('访问控制 → API 访问密钥'), '应给出获取 AK/SK 的具体路径')
  must(setupHtml.includes('不在方舟控制台'), '必须点明 AK 不在方舟控制台——那正是用户找不到的原因')
  must(setupHtml.includes('console.volcengine.com/iam/keymanage'),
    'AK 获取入口必须是 IAM 的 API 访问密钥页（可点）')
  must(!setupHtml.includes('console.volcengine.com/ark'),
    'AK 获取入口不得是方舟推理控制台（那里只有会被拒的 ark- Key）')
  must(setupHtml.includes('VOLC_ACCESS_KEY_ID') && setupHtml.includes('VOLC_SECRET_ACCESS_KEY'),
    '两把 AK/SK 的确切引用名都要写出来')
  must(setupHtml.includes('.credentials.yaml'), '必须给出凭据文件路径——设置里没有能填这两个名字的输入框')
  must(setupHtml.includes('px-plan-setup-path'), '凭据路径应有独立样式（要能整条读出来并复制）')
  // 缺凭据时这块默认展开：那正是用户需要它的时刻
  must(/px-plan-setup[^>]*open/.test(setupHtml), '缺凭据时「怎么配」应默认展开')
  // 入口只出现一次，避免「点哪个」这种多余的问题
  must((setupHtml.split('console.volcengine.com/iam/keymanage').length - 1) === 1,
    'AK 入口在同一块里只应出现一次')
  // 已配置时折叠起来，不占版面
  const configuredSetupHtml = renderToStaticMarkup(React.createElement(PlansPanelForGate, {
    now: Date.now(),
    payload: {
      ...setupPayload,
      providers: [{ ...setupPayload.providers[0], ok: true, reason: undefined, windows: [{ window: 'fiveHour', usedPercent: 10 }] }],
    },
    selected: undefined,
    onSelect: () => {},
  }))
  must(!/px-plan-setup[^>]*open/.test(configuredSetupHtml), '已配好时「怎么配」应折叠，不占版面')
  must((configuredSetupHtml.split('console.volcengine.com/iam/keymanage').length - 1) === 1,
    '折叠后入口仍应有一处可用（页脚那个）')
  // 旧宿主没有 setup：仍要给出入口，且不能因此崩掉
  const legacySetupHtml = renderToStaticMarkup(React.createElement(PlansPanelForGate, {
    now: Date.now(),
    payload: {
      enabled: true,
      providers: [{ id: 'volcengine', name: '火山方舟', ok: false, reason: 'no-key', keyRef: 'VOLC_ACCESS_KEY_ID', windows: [] }],
    },
    selected: undefined,
    onSelect: () => {},
  }))
  must(legacySetupHtml.includes('console.volcengine.com/iam/keymanage'),
    '旧宿主（没有 setup）也必须指向 IAM 而不是方舟控制台')
  // 退化的 setup（有 URL 但 acquire / refs 都空）：说明块自己不渲染，
  // 此时页脚**必须**顶上，否则这一家一个入口都没有。
  const degenerateSetupHtml = renderToStaticMarkup(React.createElement(PlansPanelForGate, {
    now: Date.now(),
    payload: {
      enabled: true,
      credentialFile: 'C:\\Users\\me\\.dsh\\.credentials.yaml',
      providers: [{
        id: 'volcengine', name: '火山方舟', ok: false, reason: 'no-key', keyRef: 'VOLC_ACCESS_KEY_ID',
        setup: { keyURL: 'https://console.volcengine.com/iam/keymanage/', keyURLName: 'IAM', acquire: [], refs: [] },
        windows: [],
      }],
    },
    selected: undefined,
    onSelect: () => {},
  }))
  must(degenerateSetupHtml.includes('console.volcengine.com/iam/keymanage'),
    'setup 为空块时页脚必须顶上入口，否则这一家一个链接都没有')
  // 管理入口现在挂在各自那一家的区块里，而不是面板底部一排
  must(planHtml.includes('commandcode.ai/studio'), '套餐面板应给出 Command Code 管理入口')
  must(planHtml.includes('console.volcengine.com'), '套餐面板应给出火山控制台入口')
}

// ── 套餐监看选择：状态只能有一个家，且存储全程 fail-soft ────────────
// 这个选择有**两个**消费者（看板切换器 + 输入框下方那一枚），分属不同的 fiber，
// 而用户可能压根没打开看板。用一个模块级存储做广播，两边读同一份——
// 早先通知那一块就是栽在「两个家」（面板改了运行时不知道），同一个坑不该踩第二遍。
{
  const { planViewStore, readSelectedPlan, writeSelectedPlan, SELECTED_PLAN_KEY } = await import(
    pathToFileURL(join(root, 'lib', 'client', 'planView.js')).href
  )
  must(planViewStore() === planViewStore(), 'planViewStore() 必须返回同一个单例（看板与费用条共享）')

  // localStorage 替身：记录写入，并允许被设为「访问即抛错」以验证 fail-soft
  const storage = new Map()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const install = (impl) => { Object.defineProperty(globalThis, 'localStorage', { value: impl, configurable: true }) }
  install({
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: (key) => { storage.delete(key) },
  })

  const store = planViewStore()
  let notified = 0
  const unsubscribe = store.subscribe(() => { notified += 1 })

  store.select('zhipu')
  must(store.getSnapshot() === 'zhipu', '选择后快照应立刻更新')
  must(notified === 1, `发布变化应通知订阅者，实际 ${notified}`)
  must(storage.get(SELECTED_PLAN_KEY) === 'zhipu', '选择应写进 localStorage')
  // 内容没变**不得**发布：不然每次点同一个 chip 都会引起一次无谓重渲染
  must(store.select('zhipu') === false, '重复选同一项应报告未变化')
  must(notified === 1, `内容未变时不应通知订阅者，实际 ${notified}`)

  // 「自动」= 清除，而不是存一个空串（否则用户回不到自动模式）
  store.select(undefined)
  must(store.getSnapshot() === undefined, '选「自动」后快照应是 undefined')
  must(!storage.has(SELECTED_PLAN_KEY), '选「自动」应清除存储，而不是写入空串')
  must(readSelectedPlan() === undefined, '没有存储时应读成 undefined')

  // 空串是「没设过」，不能当成一个厂商 id
  storage.set(SELECTED_PLAN_KEY, '   ')
  must(readSelectedPlan() === undefined, '空白的选择应归一成 undefined，而不是一个空 id')
  must(writeSelectedPlan('volcengine') === true, '正常写入应成功')
  must(readSelectedPlan() === 'volcengine', '写进去的应能读出来')
  writeSelectedPlan(undefined)
  must(readSelectedPlan() === undefined, '清除后应读成 undefined')

  // 隐私模式 / 禁用存储：读不到当没设过、写不进去也不抛错（界面照常可用）
  install({
    getItem() { throw new Error('SecurityError: storage disabled') },
    setItem() { throw new Error('SecurityError: storage disabled') },
    removeItem() { throw new Error('SecurityError: storage disabled') },
  })
  must(readSelectedPlan() === undefined, '存储访问抛错时应安静当成「没设过」')
  must(writeSelectedPlan('zhipu') === false, '写不进去应回报 false，而不是抛错')
  // 本次运行内的选择仍要生效（写盘失败不该升级成界面故障）
  must(planViewStore().select('commandcode') === true, '存储不可用时，本次运行内的选择仍应生效')
  must(planViewStore().getSnapshot() === 'commandcode', '内存里的选择应与写入结果一致')

  unsubscribe()
  // 退订之后的任何一次变化都不该再回调——这里先记下当前次数再比。
  const beforeUnsub = notified
  store.select('volcengine')
  must(planViewStore().getSnapshot() === 'volcengine', '退订不影响存储本身继续工作')
  must(notified === beforeUnsub, '退订后不应再收到通知')
  if (original === undefined) delete globalThis.localStorage
  else Object.defineProperty(globalThis, 'localStorage', original)
}

// 余额关闭态：必须说明「已关闭」，而不是显示一个 0 或空白
const closedHtml = renderToStaticMarkup(React.createElement(View, {
  data: payload,
  now: payload.generatedAt,
  refreshing: false,
  onRefresh: () => {},
  balance: { enabled: false, balances: [], available: null, fetchedAt: null },
  onToggleBalance: () => {},
}))
must(closedHtml.includes('已关闭'), `关闭态应明说已关闭：${closedHtml.slice(0, 300)}`)

// 余额读取失败：必须明说失败原因，且看板其余部分照常渲染
const failedBalanceHtml = renderToStaticMarkup(React.createElement(View, {
  data: payload,
  now: payload.generatedAt,
  refreshing: false,
  onRefresh: () => {},
  balance: { enabled: true, reason: 'no-key', balances: [], available: null, fetchedAt: null, apiKeyEnv: 'DEEPSEEK_API_KEY' },
  onToggleBalance: () => {},
}))
must(failedBalanceHtml.includes('DEEPSEEK_API_KEY'), '没配 Key 时应指明是哪个引用')
must(failedBalanceHtml.includes('费用明细'), '余额不可用时看板其余部分仍应渲染')

// 旧宿主（没有余额路由）：余额取数明确失败，界面要说清是版本问题，而不是装作一切正常
const oldHostHtml = renderToStaticMarkup(React.createElement(View, {
  data: payload,
  now: payload.generatedAt,
  refreshing: false,
  onRefresh: () => {},
  balance: undefined,
  balanceError: '宿主没有余额路由（插件版本可能过旧，重启 dsh 试试）',
  onToggleBalance: () => {},
}))
must(oldHostHtml.includes('过旧'), `旧宿主应提示版本过旧：${oldHostHtml.slice(0, 300)}`)
must(oldHostHtml.includes('费用明细'), '旧宿主上看板其余部分仍应渲染')

// ── 热力图几何闸门：每格必须是正方形 ────────────────────────────
// 历史事故：把 24 小时塞进同一格，格高算成 0.7px、格宽 9px，画出来全是条形。
// 这里直接量渲染结果里的 px-heat 矩形，宽高差超过 0.5px 就判失败。
// 注意属性顺序不固定（className 先于 width），所以先按标签切开再逐个取属性。
const heatTagPattern = /class="px-heat px-heat-\d"[^>]*/g
const heatRects = []
for (const match of html.matchAll(heatTagPattern)) {
  const start = html.lastIndexOf('<rect', match.index)
  if (start === -1) continue
  heatRects.push(html.slice(start, html.indexOf('>', match.index) + 1))
}
must(heatRects.length > 300, `px-heat 矩形太少（${heatRects.length}），热力图可能没渲染`)
/** 从标签里取数值属性。 */
const attrOf = (tag, name) => {
  const found = new RegExp(`\\b${name}="([0-9.]+)"`).exec(tag)
  return found === null ? undefined : Number(found[1])
}
let worst = { delta: 0, tag: '' }
let minSide = Number.POSITIVE_INFINITY
for (const tag of heatRects) {
  const w = attrOf(tag, 'width')
  const hgt = attrOf(tag, 'height')
  must(w !== undefined && hgt !== undefined, `px-heat 矩形缺少宽高：${tag}`)
  const delta = Math.abs(w - hgt)
  if (delta > worst.delta) worst = { delta, tag }
  minSide = Math.min(minSide, w, hgt)
}
must(
  worst.delta <= 0.5,
  `热力图格子不是正方形：宽高最多差 ${worst.delta.toFixed(2)}px（${worst.tag}）——`
  + '这正是「显示成条形」的成因',
)
must(minSide >= 3, `热力图格子太小（最小边 ${minSide.toFixed(2)}px），应至少 3px 才看得见`)
console.log(`热力图几何：${heatRects.length} 个格子，最小边 ${minSide.toFixed(1)}px，宽高最大差 ${worst.delta.toFixed(2)}px`)

// ── 日历「下一行 = 后一天」闸门 ──────────────────────────────────
// 历史事故：列号按 `floor(day / 7)` 算，等于把首列当成完整一周。首日不是周日时
// 列内的星期几只循环了 7 天就绕回去，于是「下面一格」不是后一天。
// 实测（首日 2025-09-12，周五）：9/10 下面显示的是 9/4，9/17 下面是 9/11
// ——用户顺着往下读当天的用量，读到的是另一天，正是被报上来的那个故障。
//
// 这里直接断言**映射本身**（而不是隔着 React 量坐标）：任意一天的下一行
// 必须是后一天，且每一列最多 7 格、同一列内星期几不重复。
const { calendarCellOf } = await import(pathToFileURL(join(root, 'lib', 'client', 'graph.js')).href)
for (const firstDay of ['2025-09-05', '2025-09-12', '2026-01-01', '2024-02-29']) {
  const lead = new Date(`${firstDay}T00:00:00Z`).getUTCDay()
  const calendarDays = 371
  /** 网格位置 → 天序号。 */
  const occupancy = new Map()
  for (let day = 0; day < calendarDays; day += 1) {
    const { column, weekday } = calendarCellOf(day, lead)
    const key = `${column}:${weekday}`
    must(!occupancy.has(key), `首日 ${firstDay}：第 ${day} 天与第 ${occupancy.get(key)} 天挤在同一格（${key}）`)
    occupancy.set(key, day)
    // 补上首列空缺后，行号必须与真实星期几一致——这正是老实现搞错的地方
    const realWeekday = new Date(Date.parse(`${firstDay}T00:00:00Z`) + day * 86_400_000).getUTCDay()
    must(
      weekday === realWeekday,
      `首日 ${firstDay}：第 ${day} 天落在第 ${weekday} 行，但它实际是周 ${realWeekday}`,
    )
  }
  for (let day = 0; day + 1 < calendarDays; day += 1) {
    const { column, weekday } = calendarCellOf(day, lead)
    // 周六下面没有格子（该列结束），其余各天的下一行必须是后一天
    if (weekday === 6) continue
    const below = occupancy.get(`${column}:${weekday + 1}`)
    must(
      below === day + 1,
      `首日 ${firstDay}：第 ${day} 天下面应是第 ${day + 1} 天，实际是 ${below}——`
      + '这正是「格子下面是另一天」的成因',
    )
  }
}
console.log('日历映射：4 个首日下「下一行 = 后一天」均成立')

// ── 趋势分维度：**逐日相加必须等于总量** ────────────────────────────
// 分模型 / 分提供商画曲线，最容易犯的错是**重复计数**：同一个模型走三条路由，
// 按提供商拆时要算三次（本来就是三份用量），按模型合并时只该算一次。
// 两个维度都必须与「构成」维度落在同一个总量上，否则用户会看到
// 「三条线加起来 ≠ 卡片上那个合计」——而那种矛盾会让人不再相信任何一个数字。
{
  const { dimensionSeries, dailyCosts, sumRows } = await import(
    pathToFileURL(join(root, 'lib', 'client', 'usage.js')).href)
  /** 造一份最小用量对象（字段名与 recentDays 的产出一致）。 */
  const mkUsage = (local) => ({ local, cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0, peak: {}, idle: {} })
  // 同一个模型经两条路由（@a / @b）+ 另一个模型：按模型要合并，按提供商要拆开
  const fakePoints = [
    { key: '2026-09-01', byModel: { 'deepseek-flash@a': mkUsage(100), 'deepseek-flash@b': mkUsage(50), 'glm-4.6@a': mkUsage(30) } },
    { key: '2026-09-02', byModel: { 'deepseek-flash@a': mkUsage(10), 'glm-4.6@a': mkUsage(5) } },
  ]
  const fakeModels = [
    { key: 'deepseek-flash@a', rollup: 'deepseek-flash', label: 'DeepSeek Flash', provider: 'a', providerLabel: '家 A' },
    { key: 'deepseek-flash@b', rollup: 'deepseek-flash', label: 'DeepSeek Flash', provider: 'b', providerLabel: '家 B' },
    { key: 'glm-4.6@a', rollup: 'glm-4.6', label: 'GLM-4.6', provider: 'a', providerLabel: '家 A' },
  ]
  /** 把摊平后的点求和。 */
  const totalOf = (shaped) => shaped.reduce(
    (sum, point) => sum + Object.entries(point).filter(([k]) => k !== 'key').reduce((x, [, v]) => x + Number(v ?? 0), 0),
    0,
  )
  const expected = 100 + 50 + 30 + 10 + 5

  const byModel = dimensionSeries(fakePoints, fakeModels, 'model', { limit: 5 })
  must(totalOf(byModel.points) === expected,
    `按模型分组的逐日之和应等于总量 ${expected}，实际 ${totalOf(byModel.points)}`)
  // 同一个模型的两条路由必须**合并成一条线**，否则总量会翻倍
  must(byModel.series.filter((s) => s.label === 'DeepSeek Flash').length === 1,
    '同一个模型跨提供商必须合并成一条线（否则重复计数）')

  const byProvider = dimensionSeries(fakePoints, fakeModels, 'provider', { limit: 5 })
  must(totalOf(byProvider.points) === expected,
    `按提供商分组的逐日之和应等于总量 ${expected}，实际 ${totalOf(byProvider.points)}`)
  // 按提供商拆时必须**分开**：家 A 是 100+30，家 B 是 50
  must(byProvider.series.some((s) => s.label === '家 A') && byProvider.series.some((s) => s.label === '家 B'),
    '按提供商分组必须把同一模型的两家分开')

  // 超过 limit 的合并进「其他」，**数字不能丢**
  const many = Array.from({ length: 9 }, (_, i) => ({
    key: `m${i}`, byModel: { [`model${i}@p`]: mkUsage((9 - i) * 10) },
  }))
  const manyModels = Array.from({ length: 9 }, (_, i) => (
    { key: `model${i}@p`, rollup: `model${i}`, label: `模型${i}`, provider: 'p', providerLabel: 'P' }))
  const capped = dimensionSeries(many, manyModels, 'model', { limit: 3 })
  const cappedTotal = capped.points.reduce(
    (sum, point) => sum + Object.entries(point).filter(([k]) => k !== 'key').reduce((x, [, v]) => x + Number(v ?? 0), 0), 0)
  must(cappedTotal === 10 + 20 + 30 + 40 + 50 + 60 + 70 + 80 + 90,
    `超过 limit 的部分必须进「其他」，总量不得丢，实际 ${cappedTotal}`)
  must(capped.series.some((s) => s.label === '其他'), '被截断时应有「其他」那一条')
  must(capped.series.length === 4, `limit=3 时应是 3 条 + 「其他」，实际 ${capped.series.length}`)

  // 空数据 / 缺字段不该抛错
  must(dimensionSeries([], [], 'model', {}).series.length === 0, '空数据应返回空序列')
  must(dimensionSeries(undefined, undefined, 'provider', {}).points.length === 0, '缺入参不该抛错')
  // 旧宿主的 byModel 键没有 @提供商，也不能崩
  const legacy = dimensionSeries(
    [{ key: 'd', byModel: { 'deepseek-flash': mkUsage(7) } }],
    [{ model: 'deepseek-flash', label: 'Flash' }], 'provider', {},
  )
  must(totalOf(legacy.points) === 7, '旧宿主（没有 key 字段）也要能分组')

  // 逐日消费估计：**和必须等于同一窗口的总额**（金额线性折算，没有取整漂移）
  const costPoints = dailyCosts(fakePoints, { models: {}, rates: {} })
  must(costPoints.length === 2, '逐日消费应与天数一致')
  must(costPoints.every((point) => typeof point.cost === 'number'), '每日都应有数值金额')

  // 真实 fixture：两个维度都必须与 rangeTotals 对上
  const fixturePoints = payload.days.slice(-30)
  const fxExpected = sumRows(fixturePoints).local
  for (const dim of ['model', 'provider']) {
    const shaped = dimensionSeries(fixturePoints, payload.models, dim, { limit: 5 })
    const got = shaped.points.reduce(
      (sum, point) => sum + Object.entries(point).filter(([k]) => k !== 'key').reduce((x, [, v]) => x + Number(v ?? 0), 0), 0)
    must(Math.abs(got - fxExpected) < 1e-6,
      `真实数据下按 ${dim} 分组应合计 ${fxExpected}，实际 ${got}`)
  }
  console.log('趋势分维度：模型 / 提供商两组均与总量一致，「其他」不丢数字')
}

// 空数据也必须能渲染（不能因为除零或空数组抛错）
const empty = buildPayload({ empty: true })
const emptyHtml = renderToStaticMarkup(React.createElement(View, {
  data: empty,
  now: empty.generatedAt,
  refreshing: false,
  onRefresh: () => {},
  // 空数据 + 余额也拿不到：最坏情况也不能抛错
  balance: undefined,
  balanceError: '网络请求失败',
  onToggleBalance: () => {},
}))
must(emptyHtml.includes('暂无数据') || emptyHtml.includes('没有模型调用'), '空数据时应给出空态提示')
must(emptyHtml.includes('余额读取失败'), '余额读取失败时应有可见提示')

// ── 「今日费用」必须按宿主的 today 定位，不能读 days.at(-1) ─────────
// 历史事故：今天还没跑过请求时 `days.at(-1)` 是昨天，卡片上的「今日」显示的是
// 昨天的数字。这里造一份「最后一天没有数据、但今天有数据」的数据：正确实现显示
// 今天的金额，老实现会显示 ¥0（因为它去读那个空的最后一天）。
{
  const stale = buildPayload({})
  const lastKey = stale.days.at(-1).key
  const todayKey = stale.days.at(-2).key
  // 最后一天（昨天）清空，并把「今天」指向前一天
  const days = stale.days.map((row) => (
    row.key === lastKey ? { ...row, totals: undefined, byModel: {} } : row
  ))
  const todayPayload = { ...stale, days, overview: { ...stale.overview, today: todayKey } }
  const todayHtml = renderToStaticMarkup(React.createElement(View, {
    data: todayPayload,
    now: todayPayload.generatedAt,
    refreshing: false,
    onRefresh: () => {},
    balance: undefined,
    balanceError: '网络请求失败',
    onToggleBalance: () => {},
  }))
  must(
    todayHtml.includes('今日 ') && !todayHtml.includes('今日 ¥0'),
    '今天有数据、最后一天没有数据时，「今日」必须显示今天的金额而不是 ¥0——'
    + '这正是「错误获取了今天的用量」的形态',
  )
  // 旧宿主没有 overview.today 时仍要能渲染（退回 days.at(-1)，不崩）
  const legacy = { ...stale, overview: { ...stale.overview, today: undefined } }
  const legacyHtml = renderToStaticMarkup(React.createElement(View, {
    data: legacy,
    now: legacy.generatedAt,
    refreshing: false,
    onRefresh: () => {},
    balance: undefined,
    balanceError: '网络请求失败',
    onToggleBalance: () => {},
  }))
  must(legacyHtml.includes('今日 '), '旧宿主（没有 overview.today）也必须渲染出「今日」')
}

console.log(`渲染闸门通过：${registrations.length} 个槽位、${mountedStyles.length} 张样式表、${themes.length} 套主题`)
console.log(`整页 HTML ${html.length} 字节 · 容器骨架 ${shellHtml.length} 字节 · 侧栏图标 ${iconHtml.length} 字节`)
console.log(`数据：累计 ${payload.overview.totals.local} token、费用 ￥${payload.cost.standard}`)

/**
 * 造一份与宿主 host.js 返回结构完全一致的数据。
 *
 * 条目身份是**「模型 × 提供商」**（`模型@提供商`），因此 `models[].key` 与
 * 按日 / 按会话的 `byModel` 键都是这个复合键——旧版是单个模型名。
 * @param {{empty?:boolean}} [options] - empty 为真时返回全空数据。
 * @returns {object} 看板数据。
 */
function buildPayload(options = {}) {
  // 官方价目：{ peak, idle } 双档
  const pricing = {
    currency: 'CNY',
    unit: 'per-million-tokens',
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    rates: {
      'deepseek-flash': {
        label: 'DeepSeek Flash',
        version: 'DeepSeek-V4.1-Flash',
        cacheHit: { peak: 0.04, idle: 0.02 },
        cacheMiss: { peak: 2, idle: 1 },
        output: { peak: 8, idle: 4 },
      },
      'deepseek-v4-pro': {
        label: 'DeepSeek V4 Pro',
        version: 'DeepSeek-V4-Pro-0813',
        cacheHit: { peak: 0.3, idle: 0.15 },
        cacheMiss: { peak: 9, idle: 4.5 },
        output: { peak: 27, idle: 13.5 },
      },
      // 智谱 GLM：官方人民币定价，不分时（peak === idle）
      'glm-5.3': {
        label: 'GLM-5.3',
        version: 'GLM-5.3',
        cacheHit: { peak: 2, idle: 2 },
        cacheMiss: { peak: 8, idle: 8 },
        output: { peak: 28, idle: 28 },
      },
    },
    // 逐条目单价（宿主算好的那一份，按归一键索引）
    models: {},
  }
  pricing.models = {
    'deepseek-flash': pricing.rates['deepseek-flash'],
    'deepseek-v4-pro': pricing.rates['deepseek-v4-pro'],
    'glm-5.3': pricing.rates['glm-5.3'],
  }
  /** 按 seed 造一份分档一致的用量：high 表示落在高峰的比例。 */
  const usage = (seed, peakRatio = 0.4) => {
    const cacheHit = 120_000 * seed
    const cacheMiss = 30_000 * seed
    const output = 9_000 * seed
    const peakReq = Math.round(12 * seed * peakRatio)
    const idleReq = 12 * seed - peakReq
    const share = (total, requests) => (12 * seed === 0 ? 0 : Math.round((total * requests) / (12 * seed)))
    return {
      cacheHit,
      cacheMiss,
      cacheWrite: 2_000 * seed,
      output,
      reasoning: 1_000 * seed,
      local: 161_000 * seed,
      requests: 12 * seed,
      peak: {
        cacheHit: share(cacheHit, peakReq),
        cacheMiss: share(cacheMiss, peakReq),
        output: share(output, peakReq),
        requests: peakReq,
      },
      idle: {
        cacheHit: cacheHit - share(cacheHit, peakReq),
        cacheMiss: cacheMiss - share(cacheMiss, peakReq),
        output: output - share(output, peakReq),
        requests: idleReq,
      },
    }
  }
  const start = Date.UTC(2026, 0, 1)
  const days = Array.from({ length: 40 }, (_, index) => {
    const key = new Date(start + index * 86_400_000).toISOString().slice(0, 10)
    const seed = options.empty === true || index % 5 === 0 ? 0 : index + 1
    // 费用明细表是按**日行的 byModel** 汇总出来的，因此多模型场景要把 GLM
    // 与未知模型也放进日行，否则它们根本不会出现在表里。
    // 键是「模型 × 提供商」的条目身份：同一个 DeepSeek 模型走两家就是两行。
    const byModel = seed === 0
      ? {}
      : options.models === 'multi'
        ? {
          'deepseek-flash@deepseek-official': usage(seed),
          // 同一个模型的第二个提供商：单价列表要并成一条，费用明细表要分成两行
          'deepseek-flash@workbuddy-cn': usage(Math.max(1, Math.round(seed / 4))),
          'glm-5.3@zhipu-coding': usage(Math.max(1, Math.round(seed / 3))),
          'mystery-model-x@workbuddy-cn': usage(1),
          // 旧账本记录：条目身份里没有提供商（连 `@` 都没有）
          'deepseek-v4-pro': usage(1),
        }
        : { 'deepseek-flash@deepseek-official': usage(seed) }
    return {
      key,
      totals: usage(seed),
      byModel,
      sessions: seed === 0 ? 0 : 1,
    }
  })
  const heatmapDays = 371
  const heatmap = {
    firstDay: '2025-09-05',
    days: heatmapDays,
    cells: new Array(heatmapDays * 24).fill(0),
    max: 1,
    requests: new Array(heatmapDays).fill(0),
    sessions: new Array(heatmapDays).fill(0),
    tokens: new Array(heatmapDays).fill(0),
    maxRequests: 1,
  }
  if (options.empty !== true) {
    for (let day = 0; day < heatmapDays; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const hits = (day * 7 + hour) % 11 === 0 ? (day % 7) + 1 : 0
        heatmap.cells[day * 24 + hour] = hits
        if (hits > 0) {
          heatmap.requests[day] += hits
          heatmap.tokens[day] += hits * 1200
          heatmap.sessions[day] = 1
        }
      }
    }
    heatmap.max = Math.max(1, ...heatmap.cells)
    heatmap.maxRequests = Math.max(1, ...heatmap.requests)
  }
  return {
    generatedAt: Date.UTC(2026, 1, 9, 4, 0, 0),
    timezone: 'Asia/Shanghai',
    period: { peak: false, minuteOfDay: 720, weekday: 4, nextChangeMs: 5_400_000, nextPeak: true, label: '空闲时段' },
    peakRule: {
      windows: [{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1080 }],
      weekdays: [1, 2, 3, 4, 5],
      note: '高峰时段为北京时间周一至周五 9:00–12:00、14:00–18:00，其余（含全部周末）为空闲时段，空闲价为高峰价的一半。',
    },
    pricing,
    overview: {
      totals: options.empty === true ? usage(0) : usage(96),
      sessions: options.empty === true ? 0 : 4,
      activeDays: options.empty === true ? 0 : 32,
      firstDay: options.empty === true ? null : days[0].key,
      lastDay: options.empty === true ? null : days.at(-1).key,
      // 站点时区下的今天。正常情形与 lastDay 相同（今天就是最后有数据的那天，
      // 因为 generatedAt 落在最后一行），但**语义不同**：这两个字段分开正是为了
      // 让「今天还没跑过请求」这种情形能被表达出来（见下面「今日费用」闸门）。
      today: options.empty === true ? null : days.at(-1).key,
      streaks: options.empty === true ? { current: 0, longest: 0 } : { current: 3, longest: 9 },
      modelsUsed: options.empty === true ? 0 : 2,
    },
    windows: { today: usage(1), last7: usage(7), last30: usage(30), all: usage(40) },
    cost: options.empty === true
      ? { standard: 0, ifAllIdle: 0, saved: 0 }
      : { standard: 76.92, ifAllIdle: 23.4, saved: 53.52 },
    days,
    models: options.empty === true ? [] : [
      {
        key: 'deepseek-flash@deepseek-official',
        model: 'deepseek-flash@deepseek-official',
        rollup: 'deepseek-flash',
        provider: 'deepseek-official',
        providerLabel: 'DeepSeek 官方',
        // **刻意与官方名不同**，照实复刻本机数据：DSH 设置里这条路由的外显名是
        // `DeepSeek-V41-Flash`，而价目表里的官方名是 `DeepSeek Flash`。
        // 单价行若取 `group.first.label`，显示的就是路由名（价格是模型的属性，
        // 不该贴某一家的叫法）；取官方的 `rates.label` 才对。
        label: 'DeepSeek-V41-Flash',
        version: 'DeepSeek-V4.1-Flash',
        priced: true,
        tiered: false,
        vendor: 'DeepSeek',
        totals: usage(30),
        rates: pricing.rates['deepseek-flash'],
        cost: { standard: 60, peakOnly: 24, idlePart: 36 },
      },
      {
        key: 'deepseek-v4-pro@deepseek-official',
        model: 'deepseek-v4-pro@deepseek-official',
        rollup: 'deepseek-v4-pro',
        provider: 'deepseek-official',
        providerLabel: 'DeepSeek 官方',
        label: 'DeepSeek V4 Pro',
        version: 'DeepSeek-V4-Pro-0813',
        priced: true,
        tiered: false,
        vendor: 'DeepSeek',
        totals: usage(6),
        rates: pricing.rates['deepseek-v4-pro'],
        cost: { standard: 16, peakOnly: 7, idlePart: 9 },
      },
      ...(options.models === 'multi' ? [
        {
          key: 'glm-5.3@zhipu-coding',
          model: 'glm-5.3@zhipu-coding',
          rollup: 'glm-5.3',
          provider: 'zhipu-coding',
          providerLabel: '智谱 GLM Coding Plan',
          label: 'GLM-5.3',
          version: 'GLM-5.3',
          priced: true,
          tiered: false,
          vendor: '智谱',
          totals: usage(8),
          rates: pricing.rates['glm-5.3'],
          cost: { standard: 5, peakOnly: 5, idlePart: 0 },
        },
        {
          // 故意放一个价目表里没有的模型：界面必须标成「估算价」而不是假装官方价
          key: 'mystery-model-x@workbuddy-cn',
          model: 'mystery-model-x@workbuddy-cn',
          rollup: 'mystery-model-x',
          provider: 'workbuddy-cn',
          providerLabel: 'WorkBuddy',
          label: 'mystery-model-x',
          version: '',
          priced: false,
          tiered: false,
          vendor: '未知',
          totals: usage(2),
          rates: pricing.rates['deepseek-flash'],
          cost: { standard: 1, peakOnly: 1, idlePart: 0 },
        },
        {
          // 旧账本记录没有提供商：界面必须明说「来源未知」，而不是编一个出来
          key: 'deepseek-v4-pro',
          model: 'deepseek-v4-pro',
          rollup: 'deepseek-v4-pro',
          provider: '',
          providerLabel: '',
          label: 'DeepSeek V4 Pro',
          version: 'DeepSeek-V4-Pro-0813',
          priced: true,
          tiered: false,
          vendor: 'DeepSeek',
          totals: usage(1),
          rates: pricing.rates['deepseek-v4-pro'],
          cost: { standard: 2, peakOnly: 2, idlePart: 0 },
        },
        {
          // **同一个模型的第二个提供商**：价目表按模型索引，因此它与上面那条
          // `deepseek-flash@deepseek-official` 用的是**同一个** rates 对象。
          // 单价列表必须把它们并成一条（否则就是同一份价重复几遍），
          // 而费用明细表仍要分成两行（用量与额度归属不同）。
          key: 'deepseek-flash@workbuddy-cn',
          model: 'deepseek-flash@workbuddy-cn',
          rollup: 'deepseek-flash',
          provider: 'workbuddy-cn',
          providerLabel: 'WorkBuddy 中国区',
          // **刻意与上面那条的 label 不同**，照实复刻本机数据：同一个模型在各家
          // 路由下的外显名并不一致（本机实测有 `DeepSeek Flash` / `COD-DeepSeek
          // V4.1 Flash` / `DeepSeek-V41-Flash`）。单价行若取 `group.first.label`，
          // 显示的就会是「按用量排序碰巧排第一的那个提供商给它的名字」——
          // 而价格是模型的属性，不该贴某一家的叫法。取官方的 `rates.label` 才对。
          label: 'COD-DeepSeek V4.1 Flash',
          version: '',
          priced: true,
          tiered: false,
          vendor: 'DeepSeek',
          totals: usage(4),
          rates: pricing.rates['deepseek-flash'],
          cost: { standard: 3, peakOnly: 3, idlePart: 0 },
        },
      ] : []),
    ],
    sessions: options.empty === true ? [] : [
      {
        id: 'session-8155bc37-087f-4541-b7d6-dda20b7411cc',
        createdAt: start,
        cwd: 'D:\\blog',
        workspace: 'blog',
        // 预览标题与 DSH 侧栏同源（宿主按 displayTitleOf 的同一条回落链算好）
        title: '把侧边栏的任务标题接进看板',
        agentPreset: 'standard',
        isSeeded: false,
        turns: 12,
        totals: usage(12),
        models: ['deepseek-flash@deepseek-official'],
        days: [days[0].key],
        live: true,
      },
      {
        id: 'session-0f0271ab-540a-4ab4-a3d4-c5b8b1a986a0',
        createdAt: start - 86_400_000,
        cwd: 'D:\\blog\\x',
        workspace: 'x',
        title: 'x',
        agentPreset: 'standard',
        isSeeded: false,
        turns: 3,
        totals: usage(3),
        models: [],
        days: [],
        live: false,
      },
    ],
    heatmap,
  }
}
