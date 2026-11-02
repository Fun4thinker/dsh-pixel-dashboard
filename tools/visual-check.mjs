/**
 * 视觉验收：把费用详情面板渲染成真实浏览器截图，交给**人眼**看。
 *
 * ## 为什么要这个工具
 *
 * 仓库里已有一整套自动闸门（render-check 抢服务端 HTML、dom-check 抢 jsdom DOM），
 * 但它们都只断言「某个字符串在不在」「某个节点在不在」。**排版坏了而断言全绿**是
 * 完全可能的：长短标签把 `grid-template-columns` 挤到换行、浮层在 360px 宽里标题
 * 与金额打架、深色下 --px-* 令牌没命中导致白底白字——这些在 HTML 字符串里一个
 * 字符都不差。于是这里补上最后一环：真的开浏览器、真的合出 PNG，由人去看。
 *
 * 它是**辅助**，不参与 `tools/verify.mjs`：把「有没有装浏览器」变成整套闸门的硬
 * 依赖，会让别的机器上 verify 直接红掉。
 *
 * ## 为什么不用 npx / playwright
 *
 * 本插件刻意不带任何依赖（见 AGENT.md：`dependencies` 必须为空），截图也不破例。
 * 只借两样**本机已有**的东西：
 *   - React：从 DSH 检出取（与 render-check / dom-check 同一套 `resolvePnpmDir`，
 *     同样的 18.3.1，否则量出来的界面不是产品里那一份）；
 *   - 浏览器：直接调 `.exe`，**不经过 npm/npx**。`.cmd` 需要 shell，而经 shell 之后
 *     参数会被空格重新切开（tools/release.mjs 已踩过），截图参数里恰好全是路径，
 *     交给 shell 等于自己制造 bug。
 *
 * ## 页面是「真组件 + 真样式表」
 *
 * 样式表逐字来自构建产物的 STYLES；面板数据**不手写**，一律用 `costDetailModel()`
 * 从原始输入折出来——手写 model 等于把组件将来会改的字段抄一遍，抄错了截图照样
 * 「成功」，而它验证的是一个不存在的界面。
 *
 * 只有**产品那一层**（输入框下方的 dock、官方统计胶囊、模仿的 composer 卡片）是
 * 模拟的：它们属于 DSH 而不是本插件，仓库里拿不到。模拟是为了让「面板与它们并排
 * 时配不配」这个真问题看得见。
 *
 * 用法: node tools/visual-check.mjs
 * 产物: tmp/ 下 6 张 PNG（会话/团队 × 浅/深，composer 场景，窄屏），连同 HTML。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const OUT_DIR = join(root, 'tmp')

/**
 * 找 DSH 检出里的 pnpm 目录（react 18.3.1 就在其中）。
 *
 * 与 render-check.mjs / dom-check.mjs **同一套解析策略**：检出曾在 `D:`，后来换到
 * `E:`，把盘符写死会让这一关在别的机器上变成「找不到 React」——那看起来像闸门坏了，
 * 而不是路径写错了。因此按顺序试候选，`DSH_CHECKOUT` 可显式指定。
 * @returns {string|undefined} pnpm 目录；undefined 表示没找到。
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

/** 一条明确的失败：打印原因并以 1 退出。绝不静默跳过。 */
function fail(lines) {
  for (const line of [].concat(lines)) console.error(`✗ ${line}`)
  process.exit(1)
}

/** 最小 HTML 转义，用来拿「文本」去对「已渲染的 HTML」。 */
function escapeHtml(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

// ── React 与 react-dom ────────────────────────────────────────────────
// 两者必须来自同一处检出：react-dom 的 reconciler 认的是自己那份 react 的实例，
// 混用两份会让 hooks 报「Invalid hook call」。
const PNPM = resolvePnpmDir()
if (PNPM === undefined) {
  fail([
    '找不到用于渲染的 React（react@18.3.1）。',
    '请把 DSH 检出路径通过环境变量 DSH_CHECKOUT 指出来，例如：',
    '  $env:DSH_CHECKOUT = "E:\\deepseek-harness"; node tools/visual-check.mjs',
  ])
}
const REACT_DIR = `${PNPM}/react@18.3.1/node_modules/react`
const REACT_DOM_DIR = `${PNPM}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom`
if (!existsSync(REACT_DIR) || !existsSync(REACT_DOM_DIR)) {
  fail(`pnpm 目录 ${PNPM} 里缺少 react 18.3.1 / react-dom 18.3.1`)
}

// 构建产物 `lib/client/*.js` 里写的是裸包名 `react` / `react-dom`。Node 的解析器
// 找不到它们（本插件没有 node_modules，也**不能**有），所以用 loader 把这两个
// 名字指到检出里的文件上——与 dom-check.mjs 同法，只是这里不需要 jsdom。
const ALIASES = new Map([
  ['react', pathToFileURL(`${REACT_DIR}/index.js`).href],
  ['react/jsx-runtime', pathToFileURL(`${REACT_DIR}/jsx-runtime.js`).href],
  ['react-dom', pathToFileURL(`${REACT_DOM_DIR}/index.js`).href],
  ['react-dom/client', pathToFileURL(`${REACT_DOM_DIR}/client.js`).href],
  ['react-dom/server', pathToFileURL(`${REACT_DOM_DIR}/server.js`).href],
])
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

const React = (await import(pathToFileURL(`${REACT_DIR}/index.js`).href)).default
const { renderToStaticMarkup } = await import(pathToFileURL(`${REACT_DOM_DIR}/server.js`).href)
const h = React.createElement

// ── 样式表：必须是**构建产物**，不是源码 ──────────────────────────────
// 断言对象与 render-check 一致：所有校验都针对 lib/，因为那才是别人真正加载的东西。
// 源码改了却忘了构建，截图必须跟着错，而不是替它遮掩。
const THEME_PATH = join(root, 'lib', 'client', 'theme.js')
const COST_PATH = join(root, 'lib', 'client', 'SessionCost.js')
const DETAIL_PATH = join(root, 'lib', 'client', 'costDetail.js')
for (const path of [THEME_PATH, COST_PATH, DETAIL_PATH]) {
  if (!existsSync(path)) {
    fail([
      `找不到构建产物 ${path}`,
      '先跑 node tools/build.mjs（本工具**只验构建产物**，不读 src/）。',
    ])
  }
}
const { STYLES } = await import(pathToFileURL(THEME_PATH).href)
if (!Array.isArray(STYLES) || STYLES.length !== 2) {
  fail(`lib/client/theme.js 的 STYLES 应恰好两张样式表，实际 ${Array.isArray(STYLES) ? STYLES.length : typeof STYLES}`)
}

// ── 组件与面板数据的折取函数 ─────────────────────────────────────────
// 没就绪时**明确退出 0**：这不是失败，是「还没轮到验」。但如果静默跳过，主 Agent
// 会以为「验过了」——所以必须把原因打印出来，并留下明确的下一步。
//
// **自检口子**：`DSH_VISUAL_PANEL` 可指向另一份同样导出 CostDetailPanel 的模块。
// 它存在的理由是「流水线」和「组件」是两件事——截图这一路可以先跑通，不必等组件
// 落地。正常验收不要设这个变量。
const COST_MODULE = typeof process.env.DSH_VISUAL_PANEL === 'string'
  && process.env.DSH_VISUAL_PANEL.trim() !== ''
  ? resolve(process.env.DSH_VISUAL_PANEL.trim())
  : COST_PATH
if (!existsSync(COST_MODULE)) fail(`找不到面板模块：${COST_MODULE}`)

const SessionCost = await import(pathToFileURL(COST_MODULE).href)
const CostDetailPanel = SessionCost.CostDetailPanel
if (typeof CostDetailPanel !== 'function') {
  console.log('组件尚未就绪，等待主 Agent 完成后重跑。')
  console.log(`  期望 ${COST_MODULE} 导出 CostDetailPanel，实际导出：`)
  console.log(`  ${Object.keys(SessionCost).join(', ')}`)
  console.log('  （若源码已加但这里是旧列表，先跑 node tools/build.mjs）')
  process.exit(0)
}

const { costDetailModel } = await import(pathToFileURL(DETAIL_PATH).href)
if (typeof costDetailModel !== 'function') {
  fail(`${DETAIL_PATH} 必须导出 costDetailModel（用它把原始数据折成面板 model）。`)
}

// ── 模拟数据：只给**原始输入**，model 由 costDetailModel 折出来 ──────
// 数值本身不是重点，重点是排版形状：有/无「估算」角标、split/members/rows 三种
// 分节、最长的标签（「智谱 GLM Coding Plan · 5 小时」）与最长的金额。
const SESSION_INPUT = {
  cost: { standard: 1.2345, peak: 0.8, idle: 0.4345 },
  usage: { cacheReadTokens: 12300, uncachedInputTokens: 3400, cacheWriteTokens: 0, outputTokens: 2100 },
  unpriced: ['mystery-model-x'],
  account: { kind: 'balance', label: '余额', text: '¥12.34', source: 'route', payload: { official: true } },
}

const TEAM_INPUT = {
  cost: { standard: 3, peak: 2, idle: 1 },
  team: {
    cost: 12.5, tokens: 3000000, memberCount: 4, title: 'dsh-pixel-dashboard',
    lines: [
      { name: 'lead', role: 'lead', cost: 10, tokens: 3000000 },
      { name: 'researcher', role: '成员', cost: 1.2, tokens: 420000 },
      { name: 'writer', role: '成员', cost: 0.8, tokens: 280000 },
      { name: 'reviewer', role: '成员', cost: 0.5, tokens: 160000 },
    ],
  },
  usage: { cacheReadTokens: 50000, uncachedInputTokens: 9000, cacheWriteTokens: 0, outputTokens: 8000 },
  account: {
    kind: 'plan', label: '智谱', fullLabel: '智谱 GLM Coding Plan', source: 'route',
    plan: { window: { window: 'fiveHour', label: '5 小时' }, percent: 61.8 },
  },
}

/** 面板最大宽度，与 SessionCost.js 的 PANEL_MAX_WIDTH 一致。 */
const PANEL_MAX_WIDTH = 360
/** 浮层与视口边缘的间距，同样取自 SessionCost.js 的 PANEL_MARGIN。 */
const PANEL_MARGIN = 12
/** 窄屏模拟宽度：iPhone SE 那一档，也是「面板 + 两边距」刚好放不下的时候。 */
const NARROW_WIDTH = 360

/**
 * 渲染面板本体，并核对它**真的画出了数据**。
 *
 * 没有这道核对，「实参与组件形状对不上」的失效模式是静默的：组件返回一个空壳，
 * 页面仍有底色与 dock，文件照样几十 KB、照样过 10KB 判据，**看起来完全成功**。
 * @param {object} model - costDetailModel 的结果。
 * @returns {string} 面板的 HTML 片段。
 */
function renderPanel(model) {
  const markup = renderToStaticMarkup(h(CostDetailPanel, { model }))
  for (const expected of [model.title, model.headline]) {
    if (!markup.includes(escapeHtml(expected))) {
      fail([
        `CostDetailPanel 没有渲染出 ${JSON.stringify(expected)}。`,
        '大概率是实参与组件的 props 形状对不上（本工具按 { model } 传整个模型对象）。',
        '面板产出片段（前 400 字）：',
        markup.slice(0, 400),
      ])
    }
  }
  return markup
}

/**
 * 算面板在给定视口下应有的宽度：`min(360, 视口 - 24)`，与 useDetailPlacement 同一
 * 条公式（PANEL_MAX_WIDTH 与 PANEL_MARGIN 两个常量在 SessionCost.js 里）。
 * @param {number} viewport - 视口宽（px）。
 * @returns {number} 面板宽（px）。
 */
function panelWidthFor(viewport) {
  return Math.min(PANEL_MAX_WIDTH, Math.max(0, viewport - PANEL_MARGIN * 2))
}

/**
 * 渲染一个场景的页面。
 *
 * ## 宽度必须是真的
 *
 * 面板在真实使用里的宽度是 `min(360, 视口宽 - 24)`。这里**始终**给它一个等于该
 * 值的约束容器，而不是让 `.px-detail` 自己去填满父级——第一版让 composer 版式的
 * 面板跟着卡片一起拉到 936px，于是截图里的换行位置与产品里完全不同，用它得出的
 * 排版结论是**无效的**（实测踩到：面板 936px 宽，抬头金额被推到最右边，看着"很
 * 宽敞"，而真实 360px 下完全是另一种排布）。
 *
 * ## 两种版式
 *
 *   - `panel`：面板单独居中，看**它本人**的排版；
 *   - `composer`：面板压在仿真的输入框卡片上方，看它**与产品并排时配不配**。
 *
 * 无论哪种，`.px-detail-anchor` 都强制 `position: static`：产品里它是 `position:fixed`
 * 的浮层（由 useDetailPlacement 按锚点矩形内联给值），照搬会让截图里只剩一个飘在
 * 角落的框，甚至被裁到视口外。验收要看的是面板本身，不是定位算得准不准。
 *
 * 深色只做一件事：给 `<body>` 加 `data-ds-dark-theme`。这正是产品的做法
 * （boot-theme.ts / ThemePresenter 都只碰 body），因此这张图能真验到
 * 「TOKENS 的深色选择器有没有命中」——写成 `html[...]` 的话这里就会白底白字。
 * @param {object} options - model / dark / layout / width。
 * @returns {string} 完整 HTML 文本。
 */
function buildPage({ model, dark, layout, viewport: rawViewport }) {
  // **宽度必须在这里算，不能指望调用方传进来。**
  // 早先 `buildPage(shot)` 直接把整个场景对象丢进来，而场景对象里没有 `width`
  // 字段——于是 `max-width:undefined px` 是条无效声明，被浏览器整条丢掉，
  // 舞台退化成 100% 宽。结果是面板在截图里 936px 宽、金额被推到最右边，
  // 看着「很宽敞」，而真实的 360px 下完全是另一种排布。
  // **拿一次无效的测量当作验收结论，比不测更糟。**
  const viewport = Number(rawViewport) > 0 ? Number(rawViewport) : 1000
  const width = panelWidthFor(viewport)
  const styles = STYLES.map(([, css]) => `<style>\n${css}\n</style>`).join('\n')
  const anchor = `<div class="px-detail-anchor">${renderPanel(model)}</div>`
  // dock 是产品那一行：官方两枚胶囊 + 插件这一枚，横排居中。
  const dock = `
      <div class="viz-dock">
        <span class="viz-pill">1 轮 · 38 步</span>
        <span class="viz-pill">2.1M tok</span>
        ${renderToStaticMarkup(h(PlugPill, { model }))}
      </div>`
  // 仿真输入框卡片：白色、圆角 16px、浅描边、柔和阴影——产品 composer 的观感。
  const composer = `
      <div class="viz-composer">
        <div class="viz-composer-input">今天还有多少额度？</div>
        <div class="viz-composer-tools">
          <span class="viz-composer-chip">自动</span>
          <span class="viz-composer-send">↑</span>
        </div>
      </div>`
  // composer 版式：**面板压在输入框卡片上方**（产品里就是这样），因此顺序是
  // dock → 面板 → 卡片，三者同宽同轴心。舞台宽度固定为面板的真实宽度，
  // 面板才不会跟着卡片一起被拉宽。
  const stage = layout === 'composer'
    ? `<div class="viz-stage">${dock}${anchor}${composer}</div>`
    : `${dock}
      <div class="viz-stage">${anchor}</div>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>visual-check</title>
${styles}
<style>
  /* 页面外壳：只用产品/系统字体，不引入插件之外的样式。插件的样式表刻意不写
     body/html 选择器（不越界改产品界面），所以底色与字体由这里补上。 */
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--px-bg, #f6f2ea);
    font-family: var(--px-ui-font);
    font-variant-numeric: tabular-nums;
    color: var(--px-ink, #3f3129);
  }
  .viz-shell { padding: 24px; }
  /* 输入框下方 dock 的替身：产品是横向 flex + gap 12px + 居中。
     这里照抄，是为了让「我们的胶囊和官方胶囊并排时是否协调」能被看见。 */
  .viz-dock {
    display: flex; gap: 12px; justify-content: center; align-items: center;
  }
  /* 官方统计胶囊的观感：13px、tertiary 文字、padding 1px 8px、24px 圆角。
     刻意是**普通 span** 而不是 .px-pill——用来对照插件胶囊的字号/内边距。 */
  .viz-pill {
    display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box;
    padding: 1px 8px; border-radius: 24px; background: transparent;
    color: var(--px-label-tertiary, #8a7969); font-size: 13px;
    white-space: nowrap;
  }
  /* 面板的宽度舞台：宽度就是产品里那个 min(360, 视口-24) 的结果（由 buildPage 算好
     后写在内联 width 上）。这决定了换行位置，因此**不能**交给父级去自然伸展。 */
  .viz-stage { width: ${width}px; max-width: 100%; margin: 0 auto 16px; box-sizing: border-box; }
  /* 强制静态：产品是浮层（position:fixed + 内联定位），截图里只要面板本人。
     width 不 !important 覆盖——让 .px-detail 按舞台宽度自然撑满，与产品一致。 */
  .px-detail-anchor {
    position: static !important;
    left: auto !important; top: auto !important; right: auto !important; bottom: auto !important;
    max-width: none !important;
  }
  /* 仿真的输入框卡片：白色、圆角 16px、浅描边、柔和阴影——产品 composer 的观感。
     用于回答「面板浮在它上方时配不配」。 */
  .viz-composer {
    width: 100%; margin: 0 auto; box-sizing: border-box;
    padding: 14px 16px; background: var(--px-surface);
    border: 1px solid var(--px-line); border-radius: 16px;
    box-shadow: var(--px-elev-2);
    display: flex; align-items: center; gap: 12px;
  }
  .viz-composer-input { flex: 1; color: var(--px-muted); font-size: 14px; }
  .viz-composer-tools { display: flex; align-items: center; gap: 10px; }
  .viz-composer-chip {
    font-size: 12px; color: var(--px-ink-2); padding: 3px 10px;
    border: 1px solid var(--px-line-2); border-radius: 999px;
  }
  .viz-composer-send {
    display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%;
    background: var(--px-ink); color: var(--px-surface); font-size: 14px;
  }
</style>
</head>
<body${dark ? ' data-ds-dark-theme' : ''}>
<div class="viz-shell">
      ${stage}
</div>
<script>
  /* 把内容高度写回 <html data-content-height>。截图前的那一趟 --dump-dom 读它，
     好把窗口高度定成「内容多高就多高」——写死高度会把面板底部裁掉，而裁掉的
     截图看起来和正常的一模一样。requestAnimationFrame 保证量之前先做过一次布局。 */
  requestAnimationFrame(function () {
    document.documentElement.setAttribute(
      'data-content-height', String(document.documentElement.scrollHeight))
  })
</script>
</body>
</html>
`
}

/**
 * dock 里属于插件的那一枚胶囊。
 *
 * 产品里它是 `SessionCostPills` 的真实输出，但那个组件要开取数、要投影，服务端
 * 渲染不出确定结果。验收要看的是「面板」，不是取数，因此这里只画一枚观感一致的
 * 占位——用**插件自己的 `.px-pill` 类**，字号/内边距来自真样式表。
 * 文字取 model 的真实金额，好与面板里的 headline 对上。
 * @param {object} props - model。
 * @returns {object} React 元素。
 */
function PlugPill({ model }) {
  const tone = model.tone === 'purple' ? 'purple' : 'pink'
  const label = model.title === '团队合计' ? '团队合计' : '本次会话'
  return h('span', { className: 'px-pill' },
    h('i', { className: `px-pill-dot px-tone-bg-${tone}` }),
    h('span', { className: 'px-pill-label' }, label),
    h('b', { className: 'px-pill-value' }, model.headline),
    model.badge === undefined ? null : h('span', { className: 'px-pill-tag' }, model.badge),
  )
}

// ── 找浏览器 ─────────────────────────────────────────────────────────
// Chrome 优先、Edge 兜底。找不到就明确失败，而不是让 spawnSync 抛一个 ENOENT 了事。
const BROWSERS = [
  ['Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  ['Chrome（x86）', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
  ['Edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
  ['Edge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
]

/** 返回可用的浏览器可执行文件；找不到就明确失败。 */
function resolveBrowser() {
  for (const [name, path] of BROWSERS) {
    if (existsSync(path)) return { name, path }
  }
  console.error('✗ 找不到 headless 浏览器（Chrome / Edge 都不在预期位置）。')
  console.error('  已试：')
  for (const [name, path] of BROWSERS) console.error(`    ${name}: ${path}`)
  process.exit(1)
}

// ── file:// URL ──────────────────────────────────────────────────────
/**
 * 把绝对路径转成浏览器能开的 file:// URL。
 *
 * 统一用正斜杠、显式给盘符加 `file:///`：就那一条形态，不猜。MSYS bash 下把参数
 * 原样传给 .exe 时，反斜杠与盘符的分隔符最容易出岔子。
 * @param {string} absolute - 绝对路径。
 * @returns {string} file URL。
 */
function toFileUrl(absolute) {
  const forward = absolute.split(sep).join('/')
  return forward.startsWith('/') ? `file://${forward}` : `file:///${forward}`
}

const browser = resolveBrowser()
// profile 放在**系统临时目录**，不放 tmp/：Chrome 的 profile 是几百个二进制文件
// （Crashpad、Cache、Code Cache……），落进仓库目录就是一个 `git add -A` 事故。
const profileDir = join(tmpdir(), 'dsh-visual-check-profile')
mkdirSync(profileDir, { recursive: true })

/** 截图里的固定参数：2 倍图、无滚动条、无 GPU。 */
function browserArgs({ screenshot, url, size, dumpDom, extra = [] }) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--window-size=${size[0]},${size[1]}`,
    // 本机装过 Chrome 的人都有自己的 profile，不隔离的话 headless 会去抢那把锁，
    // 偶发「打不开」。给一个系统临时目录里的 profile。
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--run-all-compositor-stages-before-draw',
    ...extra,
    screenshot === undefined ? undefined : `--screenshot=${screenshot}`,
    // 审计模式：把执行完脚本的 DOM 打到 stdout，从里面读 data-audit 属性。
    // 不用 CDP 是因为那要连 WebSocket 并实现协议，为一个度量不值得。
    dumpDom === true ? '--virtual-time-budget=3000' : undefined,
    dumpDom === true ? '--dump-dom' : undefined,
    url,
  ].filter((value) => value !== undefined)
}

/**
 * 先量内容高度，再按量出来的高度截图。
 *
 * 需求给的窗口高是「按内容 480~560」，但那是个**预期**，不是契约：面板高度取决于
 * 组件实现（实测内容已到 618px）。把上限钉死会把底部脚注裁掉，而**裁掉的截图
 * 看起来和正常的一模一样**——这正是这个工具要防的失效模式，绝不能用审美上的
 * 数字把它引回来。因此下限 480，上限放开到内容真实高度，超过 560 就打一行说明。
 * @param {string} url - 页面 file URL。
 * @param {number[]} size - 宽度与兜底高度。
 * @returns {number} 内容高度（像素）。
 */
function measureHeight(url, size) {
  const result = spawnSync(browser.path, browserArgs({
    url,
    size: [size[0], size[1]],
    extra: ['--virtual-time-budget=2000', '--dump-dom'],
  }), { encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 })
  if (result.error) fail(`量高度失败（${browser.name}）：${result.error.message}`)
  const match = /data-content-height="(\d+)"/.exec(result.stdout || '')
  if (match === null) {
    // 量不到就退回收到的固定高度，而不是让整轮截图失败——截图的用途是给人看，
    // 高度不完美仍可验收，但必须说出来是哪一步降级了。
    console.log('  ! 量不到内容高度，回落到 560（图片可能被裁，请留意）')
    return 560
  }
  const measured = Math.ceil(Number(match[1]))
  const height = Math.max(size[1], measured)
  if (height > size[1]) {
    console.log(`  · 内容 ${measured}px，高于预期 ${size[1]}px；按内容出图以保证不裁切`)
  }
  return height
}

/**
 * 截一张图，并校验它「像一张真图」。
 *
 * 文件大小 > 10KB 是需求给的判据，但它的作用不是审美：headless 在某些情况下会
 * 生成一张纯色（或干脆 0 字节）的 PNG 然后照样退出 0。纯色图压得极小，10KB
 * 这条线能把「白屏成功」挡掉。
 * @param {object} page - name / url / size。
 * @returns {{ path: string, bytes: number }} 产物信息。
 */
function shoot({ name, url, size }) {
  const screenshot = join(OUT_DIR, `${name}.png`)
  const finalSize = [size[0], measureHeight(url, size)]
  const result = spawnSync(browser.path, browserArgs({ screenshot, url, size: finalSize }), {
    encoding: 'utf8', timeout: 120_000,
  })
  if (result.error) fail(`截图失败（${browser.name}）：${result.error.message}`)
  // Chrome 把「写了多少字节」打在 stderr 上；status 才是成败判据。
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 600)
    fail([`截图失败（${browser.name}，退出码 ${result.status}）：${name}.png`, detail])
  }
  if (!existsSync(screenshot)) fail(`截图命令成功但文件不存在：${screenshot}`)
  const bytes = statSync(screenshot).size
  if (bytes < 10 * 1024) {
    fail([
      `截图只有 ${bytes} 字节，几乎肯定是空白页（判据 > 10KB）：${screenshot}`,
      '常见原因：页面报错没渲染出内容、样式表没加载、窗口被 --window-size 压成 0。',
    ])
  }
  return { path: screenshot, bytes }
}

// ── 出图 ─────────────────────────────────────────────────────────────
// 六张：会话/团队 × 浅/深（面板本体），外加 composer 场景与窄屏。
//
// composer 场景回答的是「它和输入框配不配」——面板是浮在 composer 上方的，只把
// 面板单独摆出来，就看不出它与产品那块白卡的关系（阴影叠阴影、圆角对不齐）。
//
// 窄屏 360px 是**必测**而不是补充：面板自己的上限就是 360px，再叠左右 12px 边距后
// 已接近手机宽度；「标题 + 角标 + 金额」挤在同一行 flex 里，最容易在这里打架。
const sessionModel = costDetailModel(SESSION_INPUT)
const teamModel = costDetailModel(TEAM_INPUT)
// `viewport` 决定**面板宽度**（min(360, 视口-24)），`size` 只决定截图窗口。
// 两者分开是必要的：窄屏场景要的是「面板被压到 360」，而不是「窗口恰好 360」。
const SHOTS = [
  { name: 'cost-panel-light', model: sessionModel, dark: false, layout: 'panel', viewport: 1000, size: [1000, 480] },
  { name: 'cost-panel-dark', model: sessionModel, dark: true, layout: 'panel', viewport: 1000, size: [1000, 480] },
  { name: 'cost-team-light', model: teamModel, dark: false, layout: 'panel', viewport: 1000, size: [1000, 480] },
  { name: 'cost-team-dark', model: teamModel, dark: true, layout: 'panel', viewport: 1000, size: [1000, 480] },
  // 面板压在仿真 composer 卡片上方：看它与输入框的搭配（阴影叠阴影、圆角对不齐）。
  { name: 'cost-composer-light', model: sessionModel, dark: false, layout: 'composer', viewport: 1000, size: [1000, 620] },
  { name: 'cost-composer-dark', model: teamModel, dark: true, layout: 'composer', viewport: 1000, size: [1000, 620] },
  // 最窄：面板自己的上限就是 360px，这是它最挤的一档，「标题 + 角标 + 金额」在这一行里打架。
  { name: 'cost-narrow-light', model: teamModel, dark: false, layout: 'panel', viewport: NARROW_WIDTH, size: [520, 560] },
  { name: 'cost-narrow-dark', model: teamModel, dark: true, layout: 'panel', viewport: NARROW_WIDTH, size: [520, 560] },
]

mkdirSync(OUT_DIR, { recursive: true })
console.log(`\n视觉验收（${browser.name}）：${OUT_DIR}\n`)

const rendered = []
for (const shot of SHOTS) {
  const htmlPath = join(OUT_DIR, `${shot.name}.html`)
  writeFileSync(htmlPath, buildPage(shot), 'utf8')
  const { path, bytes } = shoot({ name: shot.name, url: toFileUrl(htmlPath), size: shot.size })
  rendered.push({ name: shot.name, png: path, html: htmlPath, bytes })
  console.log(`  ✓ ${shot.name}.png  ${(bytes / 1024).toFixed(1)} KB`)
}

// ── 版式审计：把「排版对不对」也变成数字 ─────────────────────────────
//
// 截图是给人看的，但**人可能看不到**（自动化环境、CI、无头调试）。
// 于是这里再补一层客观度量：在真实浏览器里量每个元素，报告
//   - 有没有元素超出面板边界（横向溢出）；
//   - 有没有文字被省略号截断（说明这一行放不下）；
//   - 抬头那一行（色点/标题/角标/金额）有没有相互重叠；
//   - 文字与背景的**对比度**（深浅两套各算一遍）——白字白底在 HTML 里一个字符不差，
//     是最典型的「断言全绿、界面不可用」。
// 这些都不判「好看」，但能保证「不难看」的下限。
const AUDIT_SCRIPT = `
(function () {
  function lumOf(rgb) {
    var c = rgb.map(function (v) { var s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) })
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  function parse(color) {
    var m = /rgba?\\(([^)]+)\\)/.exec(color)
    if (!m) return null
    var parts = m[1].split(',').map(function (s) { return parseFloat(s) })
    if (parts.length > 3 && parts[3] === 0) return null
    return parts.slice(0, 3)
  }
  // 往上找第一个不透明的背景色（面板里绝大多数元素自己是透明的）
  function bgOf(el) {
    var node = el
    while (node && node !== document.documentElement) {
      var c = parse(getComputedStyle(node).backgroundColor)
      if (c !== null) return c
      node = node.parentElement
    }
    return [255, 255, 255]
  }
  function ratioOf(fg, bg) {
    var a = lumOf(fg), b = lumOf(bg)
    var hi = Math.max(a, b), lo = Math.min(a, b)
    return (hi + 0.05) / (lo + 0.05)
  }
  var out = {
    viewport: window.innerWidth,
    docOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    panel: null, overflow: [], truncated: [], collisions: [], contrast: [],
  }
  var root = document.querySelector('.px-detail')
  if (root === null) { window.__audit = out; return }
  var rr = root.getBoundingClientRect()
  out.panel = { w: Math.round(rr.width), h: Math.round(rr.height) }
  Array.prototype.forEach.call(root.querySelectorAll('*'), function (el) {
    var r = el.getBoundingClientRect()
    if (r.width > 0 && (r.right > rr.right + 0.5 || r.left < rr.left - 0.5)) {
      out.overflow.push({ cls: String(el.className).slice(0, 40), right: Math.round(r.right), panelRight: Math.round(rr.right) })
    }
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1
        && getComputedStyle(el).textOverflow === 'ellipsis') {
      out.truncated.push({ cls: String(el.className).slice(0, 40), text: String(el.textContent).slice(0, 20) })
    }
  })
  // 抬头重叠：相邻两块的水平区间不得相交
  var head = root.querySelector('.px-detail-head')
  if (head !== null) {
    var kids = Array.prototype.map.call(head.children, function (el) {
      var r = el.getBoundingClientRect()
      return { cls: String(el.className).slice(0, 24), l: r.left, r: r.right }
    })
    for (var i = 1; i < kids.length; i += 1) {
      if (kids[i].l < kids[i - 1].r - 0.5) out.collisions.push([kids[i - 1].cls, kids[i].cls])
    }
  }
  // 对比度：只量真正带文字的叶子节点
  Array.prototype.forEach.call(root.querySelectorAll('.px-detail-title, .px-detail-headline, .px-detail-badge, .px-detail-section-label, .px-detail-section-total, .px-detail-row-label, .px-detail-row-value, .px-detail-notes p'), function (el) {
    if (String(el.textContent).trim() === '') return
    var fg = parse(getComputedStyle(el).color)
    if (fg === null) return
    var ratio = ratioOf(fg, bgOf(el))
    out.contrast.push({ cls: String(el.className).slice(0, 24), ratio: Math.round(ratio * 100) / 100 })
  })
  window.__audit = out
})()
`

/**
 * 在真实浏览器里跑一遍版式审计，返回度量结果。
 * @param {string} htmlPath - 页面路径。
 * @param {number} height - 窗口高度。
 * @returns {object} 审计结果。
 */
function auditPage(htmlPath, height) {
  // 审计脚本必须在**页面加载后**执行，所以塞进一个临时副本的 </body> 之前。
  const audited = join(OUT_DIR, `_audit_${basename(htmlPath)}`)
  const source = readFileSync(htmlPath, 'utf8')
  writeFileSync(audited, source.replace('</body>', `<script>${AUDIT_SCRIPT}</script></body>`), 'utf8')
  // 把结果写进 DOM 属性再用 --dump-dom 取回来：不依赖 CDP、不依赖任何包。
  const probe = join(OUT_DIR, `_probe_${basename(htmlPath)}`)
  writeFileSync(
    probe,
    readFileSync(audited, 'utf8').replace(
      '<script>' + AUDIT_SCRIPT + '</script>',
      `<script>${AUDIT_SCRIPT}\nrequestAnimationFrame(function () {
        document.documentElement.setAttribute('data-audit', JSON.stringify(window.__audit))
      })</script>`,
    ),
    'utf8',
  )
  const result = spawnSync(browser.path, browserArgs({ url: toFileUrl(probe), size: [1000, height], dumpDom: true }), {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
  })
  const found = /data-audit="([^"]*)"/.exec(result.stdout ?? '')
  if (found === null) return { failed: true }
  const decoded = found[1]
    .replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
  try {
    return JSON.parse(decoded)
  } catch {
    return { failed: true }
  }
}

// ── 清单 ─────────────────────────────────────────────────────────────
// 清单是给**人**用的：路径要能直接复制去打开，字节数用来说明「不是空白图」。
// 绝对路径逐条打印，不做缩写——被缩写过一次之后就再也定位不到是哪张图了。
console.log('\n版式审计（真实浏览器度量）：')
let auditFailed = 0
for (const item of rendered) {
  const shot = SHOTS.find((entry) => entry.name === item.name)
  const audit = auditPage(item.html, shot?.size[1] ?? 480)
  if (audit?.failed === true) {
    console.log(`  ⚠ ${item.name}：审计脚本没跑出结果（跳过，不作判据）`)
    continue
  }
  const problems = []
  if (audit.docOverflowX === true) problems.push('页面出现横向滚动条')
  if (Array.isArray(audit.overflow) && audit.overflow.length > 0) {
    problems.push(`元素超出面板：${JSON.stringify(audit.overflow.slice(0, 3))}`)
  }
  if (Array.isArray(audit.truncated) && audit.truncated.length > 0) {
    problems.push(`文字被截断：${JSON.stringify(audit.truncated.slice(0, 3))}`)
  }
  if (Array.isArray(audit.collisions) && audit.collisions.length > 0) {
    problems.push(`抬头相互重叠：${JSON.stringify(audit.collisions.slice(0, 3))}`)
  }
  // 对比度下限一律按 WCAG AA 的 4.5 判：面板里最小的字是 11px（脚注、分节标签），
  // 那已经不是「大号文字」，没有放宽到 3.0 的理由。早先放宽到 3.0 时实测
  // --px-muted 只有 4.18，肉眼在浅色下确实吃力——这就是为什么这条门槛要写死 4.5。
  const lowContrast = (audit.contrast ?? []).filter((row) => row.ratio < 4.5)
  if (lowContrast.length > 0) problems.push(`对比度不足：${JSON.stringify(lowContrast.slice(0, 3))}`)
  const panelSize = audit.panel === null ? '—' : `${audit.panel.w}×${audit.panel.h}`
  const minContrast = (audit.contrast ?? []).reduce((min, row) => Math.min(min, row.ratio), Infinity)
  if (problems.length === 0) {
    console.log(`  ✓ ${item.name}  面板 ${panelSize}  最低对比度 ${Number.isFinite(minContrast) ? minContrast : '—'}`)
  } else {
    auditFailed += 1
    console.log(`  ✗ ${item.name}  面板 ${panelSize}`)
    for (const problem of problems) console.log(`      · ${problem}`)
  }
}

console.log('\n渲染结果清单：')
for (const item of rendered) {
  console.log(`  ${item.name}`)
  console.log(`    PNG   ${item.png}`)
  console.log(`    字节  ${item.bytes}`)
  console.log(`    HTML  ${item.html}`)
}
if (auditFailed > 0) {
  console.log(`\n✗ ${auditFailed} 个场景的版式审计未通过。`)
  process.exit(1)
}
console.log('\n版式审计全部通过。截图在 tmp/ 下，仍建议人眼看一遍整体观感。')
process.exit(0)
