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
 */
const PNPM = 'D:/deepseek-harness/node_modules/.pnpm'
const REACT_DIR = `${PNPM}/react@18.3.1/node_modules/react`
const REACT_DOM_DIR = `${PNPM}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom`
if (!existsSync(REACT_DIR)) {
  console.error(`找不到用于校验的 React：${REACT_DIR}`)
  console.error('如果 DSH 检出在别处，改本脚本顶部的 PNPM 常量。')
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
const sandbox = {
  window: { __ModuleLoader__: { load: (registration) => { factory = registration.factory } } },
  // 产物运行在独立 vm realm 里，document 必须放进 sandbox。
  // querySelector / MutationObserver / body 是「并入产品统计行」用到的能力：
  // 这里让 querySelector 返回 null（模拟锚点尚未出现），于是走兜底的自渲染分支；
  // MutationObserver 提供一个空的观察器，避免组件在无 DOM 环境下抛错。
  document: {
    head: { appendChild: (tag) => { mountedStyles.push(tag.dataset.pluginCss) } },
    createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
    body: null,
    querySelector: () => null,
  },
  MutationObserver: class { observe() {} disconnect() {} },
  console,
  performance: { now: () => Date.now() },
  requestAnimationFrame: (fn) => setTimeout(() => { fn(Date.now()) }, 0),
  cancelAnimationFrame: (handle) => { clearTimeout(handle) },
  setTimeout,
  clearTimeout,
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
const ctx = {
  on: (event, callback) => {
    if (event === 'theme/change') themeListeners.push(callback)
    return () => {}
  },
  get(name) {
    if (name === 'theme') return themeStub
    if (name === 'slots') {
      return {
        inject: (key, callback) => { callback(); void key },
        register: (options, component) => {
          registrations.push({ slot: options.name, key: options.key ?? options.id, order: options.order, component })
          return () => {}
        },
      }
    }
    if (name === 'layout') return { selectPanel: () => {} }
    return undefined
  },
  effect: (factory2) => { factory2(); return () => {} },
}
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
must(dockHtml.includes('2,000') || dockHtml.includes('2000'), '费用条应显示 token 数')

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

// 费用条上的余额：带余额渲染时应出现「余额」与金额
const dockWithBalance = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: { standard: 0.5, peak: 0.2, idle: 0.3 },
  tokens: 1000,
  balance: { enabled: true, balances: [{ currency: 'CNY', total: 12.34 }] },
}))
must(dockWithBalance.includes('px-pill'), '有余额时应渲染余额那一枚')
must(dockWithBalance.includes('余额'), '费用条应标出这是余额')
must(dockWithBalance.includes('¥12.34'), `费用条应显示余额金额：${dockWithBalance}`)

// 余额取不到时：不渲染余额那一枚，但费用照常显示（余额坏掉不该拖垮费用）
const dockNoBalance = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: { standard: 0.5, peak: 0.2, idle: 0.3 },
  tokens: 1000,
  balance: { enabled: true, reason: 'no-key', balances: [] },
}))
must(!dockNoBalance.includes('余额'), '没有余额时不应渲染余额那一枚')
must(dockNoBalance.includes('本次会话'), '没有余额时费用仍要显示')

// 只有余额、没有费用：也要渲染（否则「余额」这个功能在旧宿主上永远看不见）
const dockOnlyBalance = renderToStaticMarkup(React.createElement(SessionCostView, {
  balance: { enabled: true, balances: [{ currency: 'CNY', total: 7 }] },
}))
must(dockOnlyBalance.includes('¥7.00'), `只有余额时也应渲染：${dockOnlyBalance}`)

// 容器组件在服务端渲染下停在骨架，这里只要求它能渲染且不抛错
const main = registrations.find((item) => item.slot === 'main')
const shellHtml = renderToStaticMarkup(React.createElement(main.component, {}))
must(shellHtml.includes('px-loading'), 'Dashboard 容器首屏应渲染加载骨架')

const entryRegistration = registrations.find((item) => item.slot === 'sidebar.panellist')
const iconHtml = renderToStaticMarkup(React.createElement(entryRegistration.component, { size: 18, active: true }))
must(iconHtml.includes('<svg'), '侧栏图标没有渲染出 svg')

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

// 费用条那一枚：有套餐数据时应出现，且是最紧窗口
const dockWithQuota = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: { standard: 0.5, peak: 0.2, idle: 0.3 },
  tokens: 1000,
  plans: planPayload,
}))
must(dockWithQuota.includes('px-pill'), '有套餐数据时费用条应渲染额度那一枚')
must(dockWithQuota.includes('62%'), `费用条应显示最紧窗口的整数百分比：${dockWithQuota}`)
// 超过 75% 才转警戒色；这里最紧是 61.8%，不该是警戒态
must(!dockWithQuota.includes('px-pill-warn'), '未超阈值时不应是警戒态')
const dockTight = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: { standard: 0.5, peak: 0.2, idle: 0.3 },
  tokens: 1000,
  plans: { enabled: true, providers: [{ id: 'z', name: 'Z', ok: true, windows: [{ window: 'fiveHour', label: '5 小时', usedPercent: 96 }] }] },
}))
// 96% 时那一枚用红色点（px-tone-bg-red），不是整块警告底色——
// 警告底色只留给「费用拿不到」这种真正的故障
must(dockTight.includes('px-tone-bg-red'), '超过 75% 时额度那一枚应转红色点')
// 套餐取不到时：不渲染那一枚，费用照常
const dockNoQuota = renderToStaticMarkup(React.createElement(SessionCostView, {
  cost: { standard: 0.5, peak: 0.2, idle: 0.3 },
  tokens: 1000,
  plans: { enabled: true, providers: [{ id: 'z', name: 'Z', ok: false, reason: 'no-key', windows: [] }] },
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
]
for (const token of required) must(html.includes(token), `渲染结果缺少「${token}」`)
must(html.length > 20_000, `整页 HTML 只有 ${html.length} 字节，可能有区块没渲染`)

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

console.log(`渲染闸门通过：${registrations.length} 个槽位、${mountedStyles.length} 张样式表、${themes.length} 套主题`)
console.log(`整页 HTML ${html.length} 字节 · 容器骨架 ${shellHtml.length} 字节 · 侧栏图标 ${iconHtml.length} 字节`)
console.log(`数据：累计 ${payload.overview.totals.local} token、费用 ￥${payload.cost.standard}`)

/**
 * 造一份与宿主 host.js 返回结构完全一致的数据。
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
    const byModel = seed === 0
      ? {}
      : options.models === 'multi'
        ? { 'deepseek-flash': usage(seed), 'glm-5.3': usage(Math.max(1, Math.round(seed / 3))), 'mystery-model-x': usage(1) }
        : { 'deepseek-flash': usage(seed) }
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
        model: 'deepseek-flash',
        label: 'DeepSeek Flash',
        version: 'DeepSeek-V4.1-Flash',
        priced: true,
        tiered: false,
        vendor: 'DeepSeek',
        totals: usage(30),
        rates: pricing.rates['deepseek-flash'],
        cost: { standard: 60, peakOnly: 24, idlePart: 36 },
      },
      {
        model: 'deepseek-v4-pro',
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
          model: 'glm-5.3',
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
          model: 'mystery-model-x',
          label: 'mystery-model-x',
          version: '',
          priced: false,
          tiered: false,
          vendor: '未知',
          totals: usage(2),
          rates: pricing.rates['deepseek-flash'],
          cost: { standard: 1, peakOnly: 1, idlePart: 0 },
        },
      ] : []),
    ],
    sessions: options.empty === true ? [] : [
      {
        id: 'session-8155bc37-087f-4541-b7d6-dda20b7411cc',
        createdAt: start,
        cwd: 'D:\\blog',
        workspace: 'blog',
        agentPreset: 'standard',
        isSeeded: false,
        turns: 12,
        totals: usage(12),
        models: ['deepseek-flash'],
        days: [days[0].key],
        live: true,
      },
      {
        id: 'session-0f0271ab-540a-4ab4-a3d4-c5b8b1a986a0',
        createdAt: start - 86_400_000,
        cwd: 'D:\\blog\\x',
        workspace: 'x',
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
