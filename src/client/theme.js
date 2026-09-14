/**
 * 视觉系统：保留博客的像素基因（奶油底、马卡龙色、墨色文字），
 * 但把做工升级到现代水准——细腻圆角、柔和分层、克制的描边、
 * 150-320ms 缓动与微交互，取代 3px 硬描边加硬投影的粗糙做法。
 *
 * 颜色分两层下发：全局主题令牌（--dsw-alias-*）管产品区域配色，
 * 本文件的 --px-* 变量与样式管质感（层次、圆角、动效）与看板局部。
 * @module dsh-pixel-dashboard/client/theme
 */

/** 明暗两套主题，直接映射到 DSH 的语义令牌。 */
export const PIXEL_THEMES = {
  day: {
    id: 'pixel-day',
    label: '奶油·昼',
    colorScheme: 'light',
    tokens: {
      '--dsw-alias-bg-base': '#fbf4e8',
      '--dsw-alias-bg-layer-1': '#fffdf9',
      '--dsw-alias-bg-layer-2': '#f7efe2',
      '--dsw-alias-bg-overlay': '#fffdf9',
      '--dsw-alias-border-l1': 'rgba(87, 68, 58, 0.10)',
      '--dsw-alias-border-l2': 'rgba(87, 68, 58, 0.18)',
      '--dsw-alias-brand-primary': '#e8749f',
      '--dsw-alias-label-primary': '#3f3129',
      '--dsw-alias-label-secondary': '#8a7969',
      '--dsw-alias-state-error-primary': '#d9584c',
      '--dsw-alias-state-success-primary': '#5f9e46',
      '--dsw-alias-state-warn-primary': '#c98a1c',
      '--dsw-specific-sidebar-fill': '#f6ecdd',
    },
  },
  night: {
    id: 'pixel-night',
    label: '暮色·夜',
    colorScheme: 'dark',
    tokens: {
      '--dsw-alias-bg-base': '#1c2030',
      '--dsw-alias-bg-layer-1': '#252a3d',
      '--dsw-alias-bg-layer-2': '#2e3448',
      '--dsw-alias-bg-overlay': '#2a3044',
      '--dsw-alias-border-l1': 'rgba(232, 234, 245, 0.10)',
      '--dsw-alias-border-l2': 'rgba(232, 234, 245, 0.18)',
      '--dsw-alias-brand-primary': '#c98aa4',
      '--dsw-alias-label-primary': '#e9ebf5',
      '--dsw-alias-label-secondary': '#9aa3bd',
      '--dsw-alias-state-error-primary': '#ff9a91',
      '--dsw-alias-state-success-primary': '#9ed986',
      '--dsw-alias-state-warn-primary': '#f2c96b',
      '--dsw-specific-sidebar-fill': '#181c2a',
    },
  },
}

/**
 * 令牌覆盖层：`overrideTokens` 要求每个令牌都给出 `{ light, dark }` 一对，
 * 它按当前生效方案挑其中一值。深浅两套本就在 PIXEL_THEMES 里齐备，
 * 这里合并成一层——于是「明暗切换」由主题服务自己完成，插件无需监听
 * theme/change 重下（那样会在同一次同步 emit 里递归，见 entry.js）。
 */
export const PALETTE_OVERRIDES = (() => {
  const names = new Set([
    ...Object.keys(PIXEL_THEMES.day.tokens),
    ...Object.keys(PIXEL_THEMES.night.tokens),
  ])
  const layer = {}
  for (const name of names) {
    const light = PIXEL_THEMES.day.tokens[name] ?? PIXEL_THEMES.night.tokens[name]
    const dark = PIXEL_THEMES.night.tokens[name] ?? PIXEL_THEMES.day.tokens[name]
    if (light === undefined || dark === undefined) continue
    layer[name] = { light, dark }
  }
  return layer
})()

/**
 * 调色板与质感变量：深浅两套并存，靠 `body[data-ds-dark-theme]` 切换。
 *
 * **选择器必须写 `body[...]`，不能写 `html[...]`。** 产品把深色标记打在 `body` 上：
 *   - 启动期 boot-theme.ts：`document.body.toggleAttribute('data-ds-dark-theme', dark)`
 *   - 运行期 ThemePresenter.apply()：`body.setAttribute(DARK_ATTRIBUTE, '')`
 * 两处都只碰 `body`（`documentElement` 只用来设 `color-scheme`）。早先这里写成
 * `html[data-ds-dark-theme]`，那个选择器**永远不会命中**，于是深色模式下整套
 * `--px-*` 令牌仍取浅色值——白底白字、浅色卡片浮在暗色面板上。
 * 产品自己的暗色令牌也一律用 `body[data-ds-dark-theme]`（design-platform.css）。
 */
const TOKENS = `
:root {
  --px-ink: #3f3129;
  --px-ink-2: #6b5a4c;
  --px-muted: #8a7969;
  --px-bg: #fbf4e8;
  --px-surface: #fffdf9;
  --px-surface-2: #f7efe2;
  --px-line: rgba(87, 68, 58, 0.10);
  --px-line-2: rgba(87, 68, 58, 0.18);

  --px-pink: #f2a8c4;
  --px-pink-deep: #d9739b;
  --px-pink-soft: #fdeef4;
  --px-blue: #9ed3f5;
  --px-blue-deep: #5a9fd4;
  --px-green: #b3e59c;
  --px-green-deep: #6aa851;
  --px-yellow: #f7d98a;
  --px-yellow-deep: #c99a2e;
  --px-purple: #c9b3f0;
  --px-purple-deep: #8b6cc4;
  --px-red: #f5988e;

  --px-tone-blue: #5a9fd4;
  --px-tone-pink: #d9739b;
  --px-tone-green: #6aa851;
  --px-tone-yellow: #c99a2e;
  --px-tone-purple: #8b6cc4;
  --px-tone-red: #cf5a4c;
  /* 胶囊文字色：走自己的令牌，深浅两套各取合适值。
     刻意不直接读产品的 --dsw-* 令牌当文字色：产品把 --dsw-* 以**内联样式**写在
     body 上，而内联样式的优先级高于 <style> 里的规则，因此插件既覆盖不了、
     也无法按主题控制它；照抄一个固定浅色值会让深色模式下的胶囊文字发灰难读。 */
  --px-label-tertiary: #8a7969;

  --px-elev-1: 0 1px 2px rgba(87, 68, 58, 0.05), 0 2px 8px rgba(87, 68, 58, 0.05);
  --px-elev-2: 0 1px 2px rgba(87, 68, 58, 0.06), 0 6px 18px rgba(87, 68, 58, 0.08);
  --px-elev-3: 0 2px 4px rgba(87, 68, 58, 0.06), 0 12px 32px rgba(87, 68, 58, 0.12);
  --px-ring: 0 0 0 3px rgba(217, 115, 155, 0.18);

  --px-r-sm: 8px;
  --px-r-md: 12px;
  --px-r-lg: 16px;
  --px-r-pill: 999px;

  --px-ease: cubic-bezier(0.22, 0.61, 0.36, 1);
  --px-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --px-dur-fast: 140ms;
  --px-dur: 200ms;
  --px-dur-slow: 320ms;

  --px-ui-font: 'Noto Sans SC', 'PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei', system-ui, sans-serif;
  /* 数字沿用同一套正常字体，只靠 tabular-nums 让并排数字等宽不跳动。
     刻意不用点阵/像素字体：中文像素字体并非人人装了，读起来也累。 */
  --px-num-font: var(--px-ui-font);
}
body[data-ds-dark-theme] {
  --px-ink: #e9ebf5;
  --px-ink-2: #c3c9db;
  --px-muted: #9aa3bd;
  --px-bg: #1c2030;
  --px-surface: #252a3d;
  --px-surface-2: #2e3448;
  --px-line: rgba(232, 234, 245, 0.10);
  --px-line-2: rgba(232, 234, 245, 0.18);
  --px-label-tertiary: #9aa3bd;

  --px-pink-soft: #3a2b34;
  /* 深色下这几个「深色强调色」要反向变亮：它们用在文字与描边上
     （如 .px-links a:hover），沿用浅色深号会在暗底上糊成一团。 */
  --px-pink-deep: #f0a8c4;
  --px-blue-deep: #9ecdf0;
  --px-green-deep: #a6dd8d;
  --px-yellow-deep: #e8c46a;
  --px-purple-deep: #c3aef0;
  --px-tone-blue: #7cbfe8;
  --px-tone-pink: #e79ab8;
  --px-tone-green: #8fd072;
  --px-tone-yellow: #e8c46a;
  --px-tone-purple: #b49ae8;
  --px-tone-red: #f28b80;

  --px-elev-1: 0 1px 2px rgba(0, 0, 0, 0.24), 0 2px 8px rgba(0, 0, 0, 0.20);
  --px-elev-2: 0 1px 2px rgba(0, 0, 0, 0.28), 0 6px 18px rgba(0, 0, 0, 0.28);
  --px-elev-3: 0 2px 4px rgba(0, 0, 0, 0.30), 0 12px 32px rgba(0, 0, 0, 0.36);
  --px-ring: 0 0 0 3px rgba(231, 154, 184, 0.22);
}
`

/**
 * 产品界面换肤：只贴近材质与节奏，不动任何布局尺寸，
 * 因此不会打乱产品排版，升级后也不会错版。
 */
const SKIN = `
body {
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
  background-image:
    linear-gradient(var(--px-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--px-line) 1px, transparent 1px) !important;
  background-size: 28px 28px !important;
  background-attachment: fixed !important;
}
/* 字体：一律使用产品自带字体，不替换、不引入像素字体。
   只给数字加 tabular-nums，保证并排数字等宽不跳动。 */
[class*='badge'], [class*='Badge'], [class*='chip'], [class*='Chip'],
[class*='status'], [class*='Status'],
td[class*='number'], [class*='count'], [class*='Count'], [class*='metric'], [class*='Metric'] {
  font-variant-numeric: tabular-nums;
}
button, [role='button'], [role='tab'], [role='menuitem'], a, input, select, textarea {
  transition:
    background-color var(--px-dur) var(--px-ease),
    border-color var(--px-dur) var(--px-ease),
    color var(--px-dur-fast) var(--px-ease),
    box-shadow var(--px-dur) var(--px-ease),
    transform var(--px-dur-fast) var(--px-ease);
}
button, [role='button'], [role='tab'], input, select, textarea {
  border-radius: var(--px-r-md) !important;
}
button:not([disabled]):hover, [role='button']:hover {
  box-shadow: var(--px-elev-2);
}
button:not([disabled]):active {
  transform: translateY(1px) scale(0.985);
}
input:focus-visible, textarea:focus-visible, select:focus-visible,
button:focus-visible, [role='button']:focus-visible {
  outline: none !important;
  box-shadow: var(--px-ring) !important;
}
[role='dialog'], [role='menu'], [role='listbox'], [role='tooltip'] {
  border-radius: var(--px-r-lg) !important;
  border: 1px solid var(--px-line-2) !important;
  box-shadow: var(--px-elev-3) !important;
}
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--px-ink) 18%, transparent);
  border: 3px solid transparent;
  background-clip: content-box;
  border-radius: var(--px-r-pill);
}
::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--px-ink) 34%, transparent);
  background-clip: content-box;
}
::selection { background: color-mix(in srgb, var(--px-pink) 45%, transparent); color: var(--px-ink); }
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 1ms !important; animation-duration: 1ms !important; }
}
`

/**
 * 看板局部样式：全部使用 px- 前缀类名，不依赖产品内部类名，
 * 因此产品升级不会让看板错版。
 */
const DASHBOARD = `
.px-root {
  box-sizing: border-box;
  min-height: 100%;
  padding: 16px 20px 36px;
  color: var(--px-ink);
  font-family: var(--px-ui-font);
  font-variant-numeric: tabular-nums;
  overflow-y: auto;
}
.px-root *, .px-root *::before, .px-root *::after { box-sizing: border-box; }
.px-center { display: grid; place-items: center; }

@keyframes px-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes px-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes px-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.8); } }
@keyframes px-sweep { from { background-position: -180% 0; } to { background-position: 180% 0; } }
@keyframes px-rot { to { transform: rotate(360deg); } }
.px-rise { animation: px-rise var(--px-dur-slow) var(--px-ease-out) both; }

.px-loading {
  display: grid; gap: 14px; place-items: center;
  padding: 44px 28px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
  color: var(--px-muted); font-size: 13px;
}
.px-skeleton {
  width: 190px; height: 8px; border-radius: var(--px-r-pill);
  background: linear-gradient(90deg, var(--px-surface-2) 25%, color-mix(in srgb, var(--px-pink) 35%, var(--px-surface-2)) 50%, var(--px-surface-2) 75%);
  background-size: 220% 100%;
  animation: px-sweep 1.4s var(--px-ease) infinite;
}
.px-muted { color: var(--px-muted); font-size: 12.5px; line-height: 1.75; margin: 8px 0 0; }
.px-note { margin-top: 12px; }
.px-mono { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; opacity: 0.72; }
.px-ok { color: var(--px-tone-green); font-weight: 650; }

.px-topbar {
  position: sticky; top: -20px; z-index: 5;
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; flex-wrap: wrap;
  margin: -20px -24px 20px; padding: 16px 24px 14px;
  background: color-mix(in srgb, var(--px-bg) 84%, transparent);
  backdrop-filter: saturate(1.4) blur(14px);
  border-bottom: 1px solid var(--px-line);
}
.px-topbar-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
.px-mark {
  display: grid; place-items: center; width: 34px; height: 34px; flex: none;
  border-radius: 10px;
  background: linear-gradient(145deg, var(--px-pink), var(--px-pink-deep));
  box-shadow: var(--px-elev-2);
  color: #fff;
}
.px-title-text { display: grid; gap: 1px; min-width: 0; }
.px-title-main { font-family: var(--px-num-font); font-size: 16px; letter-spacing: 0.5px; line-height: 1.25; }
.px-title-sub { font-size: 11.5px; color: var(--px-muted); line-height: 1.3; }
.px-topbar-actions { display: flex; align-items: center; gap: 10px; }

.px-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 14px;
  font-family: inherit; font-size: 12.5px; font-weight: 550;
  color: var(--px-ink);
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-sm);
  box-shadow: var(--px-elev-1);
  cursor: pointer;
}
.px-btn:hover:not(:disabled) { background: var(--px-surface-2); box-shadow: var(--px-elev-2); transform: translateY(-1px); }
.px-btn:active:not(:disabled) { transform: translateY(0) scale(0.98); box-shadow: var(--px-elev-1); }
.px-btn:disabled { opacity: 0.55; cursor: default; }
.px-btn.primary {
  color: #fff; border-color: transparent;
  background: linear-gradient(145deg, var(--px-pink), var(--px-pink-deep));
  box-shadow: 0 2px 10px color-mix(in srgb, var(--px-pink-deep) 35%, transparent);
}
.px-btn.small { padding: 5px 11px; font-size: 12px; }
.px-spin { display: inline-block; animation: px-rot 0.9s linear infinite; }

.px-seg {
  position: relative; display: inline-flex; padding: 3px;
  background: var(--px-surface-2);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-sm);
}
.px-seg-thumb {
  position: absolute; top: 3px; bottom: 3px; left: 3px;
  border-radius: 6px;
  background: var(--px-surface);
  box-shadow: var(--px-elev-1);
  transition: transform var(--px-dur) var(--px-ease), width var(--px-dur) var(--px-ease);
}
.px-seg-btn {
  position: relative; z-index: 1;
  padding: 5px 13px;
  font: inherit; font-size: 12px; font-weight: 550;
  color: var(--px-muted);
  background: none; border: none; cursor: pointer;
  transition: color var(--px-dur-fast) var(--px-ease);
}
.px-seg-btn:hover { color: var(--px-ink-2); }
.px-seg-btn[aria-selected='true'] { color: var(--px-ink); }

.px-panel {
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
  margin-bottom: 12px;
  overflow: hidden;
  transition: box-shadow var(--px-dur) var(--px-ease);
}
.px-panel:hover { box-shadow: var(--px-elev-2); }
.px-panel-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 14px; border-bottom: 1px solid var(--px-line);
}
.px-panel-title { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 620; letter-spacing: 0.2px; }
.px-panel-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.px-tone-bg-blue { background: var(--px-tone-blue); }
.px-tone-bg-pink { background: var(--px-tone-pink); }
.px-tone-bg-green { background: var(--px-tone-green); }
.px-tone-bg-yellow { background: var(--px-tone-yellow); }
.px-tone-bg-purple { background: var(--px-tone-purple); }
.px-tone-bg-red { background: var(--px-tone-red); }
.px-panel-extra { font-size: 11.5px; color: var(--px-muted); }
.px-panel-body { padding: 12px 14px 13px; }

.px-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(178px, 1fr)); gap: 10px; margin-bottom: 12px; }
.px-stat {
  position: relative; overflow: hidden;
  padding: 11px 13px 10px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
  transition: transform var(--px-dur) var(--px-ease), box-shadow var(--px-dur) var(--px-ease);
}
.px-stat::before {
  content: ''; position: absolute; inset: 0 0 auto 0; height: 3px;
  background: linear-gradient(90deg, var(--px-accent), color-mix(in srgb, var(--px-accent) 30%, transparent));
}
.px-stat::after {
  content: ''; position: absolute; right: -32px; top: -32px;
  width: 100px; height: 100px; border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--px-accent) 20%, transparent), transparent 70%);
  pointer-events: none;
}
.px-stat:hover { transform: translateY(-2px); box-shadow: var(--px-elev-2); }
.px-stat-blue { --px-accent: var(--px-tone-blue); }
.px-stat-purple { --px-accent: var(--px-tone-purple); }
.px-stat-pink { --px-accent: var(--px-tone-pink); }
.px-stat-green { --px-accent: var(--px-tone-green); }
.px-stat-label { font-size: 11.5px; font-weight: 550; color: var(--px-muted); letter-spacing: 0.3px; }
.px-stat-value {
  margin: 6px 0 5px;
  font-family: var(--px-num-font);
  font-size: 26px; line-height: 1.15; letter-spacing: 0.5px;
  font-variant-numeric: tabular-nums;
}
.px-stat-foot { font-size: 11.5px; color: var(--px-muted); line-height: 1.65; }

.px-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px;
  font-size: 11.5px; font-weight: 570;
  border-radius: var(--px-r-pill);
  background: var(--px-surface-2);
  color: var(--px-ink-2);
  border: 1px solid var(--px-line);
}
.px-badge.ok {
  background: color-mix(in srgb, var(--px-green) 34%, transparent);
  color: var(--px-tone-green);
  border-color: color-mix(in srgb, var(--px-tone-green) 28%, transparent);
}
.px-pulse { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: px-pulse 1.8s var(--px-ease) infinite; }

/* 时段与计费（v2.1 起倒计时降级为一行次要信息，见下方 .px-period）。
   旧的 .px-offpeak / .px-clock 大卡片规则已随布局改版删除——
   留着只会让人以为还有一条渲染路径，实际没有任何元素用它们。 */
.px-rows { display: grid; gap: 2px; align-content: center; }
.px-row {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding: 9px 2px; border-bottom: 1px solid var(--px-line); font-size: 12.5px;
}
.px-row:last-child { border-bottom: none; }
.px-row > span { color: var(--px-muted); }
.px-row > b { font-family: var(--px-num-font); font-weight: 600; letter-spacing: 0.3px; }

.px-chart-wrap { width: 100%; }
.px-chart { display: block; width: 100%; overflow: visible; }
.px-grid-line { fill: var(--px-line); }
.px-axis-text { fill: var(--px-muted); font-size: 10.5px; font-family: var(--px-ui-font); }
.px-line {
  stroke-width: 2.25; stroke-linecap: round; stroke-linejoin: round; fill: none;
}
.px-line.px-tone-blue { stroke: var(--px-tone-blue); }
.px-line.px-tone-purple { stroke: var(--px-tone-purple); }
.px-line.px-tone-pink { stroke: var(--px-tone-pink); }
.px-area { stroke: none; }
.px-hover-line { fill: var(--px-ink); opacity: 0.16; }
.px-dot { stroke: var(--px-surface); stroke-width: 2; }
.px-dot.px-tone-blue { fill: var(--px-tone-blue); }
.px-dot.px-tone-purple { fill: var(--px-tone-purple); }
.px-dot.px-tone-pink { fill: var(--px-tone-pink); }

/* 跟随光标的读数浮层 */
.px-tip {
  position: absolute; top: 6px;
  transform: translateX(-50%);
  pointer-events: none;
  min-width: 150px;
  padding: 9px 11px;
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-md);
  box-shadow: var(--px-elev-3);
  font-size: 11.5px; line-height: 1.75;
  animation: px-fade 140ms var(--px-ease) both;
}
.px-tip-head { font-weight: 620; margin-bottom: 3px; font-variant-numeric: tabular-nums; }
.px-tip-row { display: flex; align-items: center; gap: 7px; color: var(--px-muted); }
.px-tip-row > b {
  margin-left: auto; color: var(--px-ink);
  font-family: var(--px-num-font); font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.px-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin-top: 10px; font-size: 12px; }
.px-legend-item { display: inline-flex; align-items: center; gap: 7px; color: var(--px-muted); }
.px-legend-swatch { width: 9px; height: 9px; border-radius: 3px; flex: none; }
.px-legend-swatch.px-tone-blue { background: var(--px-tone-blue); }
.px-legend-swatch.px-tone-purple { background: var(--px-tone-purple); }
.px-legend-swatch.px-tone-pink { background: var(--px-tone-pink); }
.px-legend-value {
  font-family: var(--px-num-font); color: var(--px-ink); min-width: 58px;
  opacity: 0; transform: translateY(2px);
  transition: opacity var(--px-dur) var(--px-ease), transform var(--px-dur) var(--px-ease);
}
.px-legend-value.on { opacity: 1; transform: none; }
.px-legend-tip { margin-left: auto; font-size: 11.5px; color: var(--px-muted); }

.px-donut { display: grid; place-items: center; }
.px-donut-svg { display: block; }
.px-donut-back { fill: var(--px-surface-2); }
.px-donut-value { fill: var(--px-ink); font-family: var(--px-num-font); font-size: 22px; }
.px-donut-title { fill: var(--px-muted); font-size: 10.5px; }
.px-slice { stroke: var(--px-surface); stroke-width: 2; animation: px-fade var(--px-dur-slow) var(--px-ease-out) both; }
/* SVG 填充必须用 fill 类。粉/蓝那几个 px-tone-bg-* 是 background，
   套在 <path> 上不生效（环图会整圈空白），所以这两组类名刻意分开。 */
.px-tone-fill-blue { fill: var(--px-tone-blue); }
.px-tone-fill-pink { fill: var(--px-tone-pink); }
.px-tone-fill-green { fill: var(--px-tone-green); }
.px-tone-fill-yellow { fill: var(--px-tone-yellow); }
.px-tone-fill-purple { fill: var(--px-tone-purple); }
.px-tone-fill-red { fill: var(--px-tone-red); }

.px-heat-wrap { width: 100%; }
.px-heat-svg { display: block; }
.px-heat { rx: 1.5; }
.px-heat-0 { fill: var(--px-line); }
.px-heat-1 { fill: var(--px-tone-green); opacity: 0.26; }
.px-heat-2 { fill: var(--px-tone-green); opacity: 0.46; }
.px-heat-3 { fill: var(--px-tone-green); opacity: 0.72; }
.px-heat-4 { fill: var(--px-tone-green); opacity: 1; }
.px-heat-tip { margin-top: 8px; font-size: 11.5px; color: var(--px-muted); font-variant-numeric: tabular-nums; }

.px-barlist { display: grid; gap: 10px; }
.px-barrow { display: grid; grid-template-columns: minmax(88px, 0.85fr) 2fr minmax(104px, auto); align-items: center; gap: 12px; font-size: 12px; }
.px-barrow-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.px-barrow-track { height: 8px; border-radius: var(--px-r-pill); background: var(--px-surface-2); overflow: hidden; }
.px-barrow-fill { display: block; height: 100%; border-radius: var(--px-r-pill); transition: width var(--px-dur-slow) var(--px-ease-out); }
.px-barrow-fill.px-tone-blue { background: var(--px-tone-blue); }
.px-barrow-fill.px-tone-pink { background: var(--px-tone-pink); }
.px-barrow-fill.px-tone-green { background: var(--px-tone-green); }
.px-barrow-fill.px-tone-yellow { background: var(--px-tone-yellow); }
.px-barrow-fill.px-tone-purple { background: var(--px-tone-purple); }
.px-barrow-fill.px-tone-red { background: var(--px-tone-red); }
.px-barrow-value { font-family: var(--px-num-font); font-size: 11.5px; color: var(--px-muted); text-align: right; font-variant-numeric: tabular-nums; }
.px-model-grid { display: grid; grid-template-columns: 210px 1fr; gap: 22px; align-items: center; }
.px-model-side { display: grid; gap: 14px; min-width: 0; }

.px-table-wrap { overflow-x: auto; }
.px-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12.5px; }
.px-table th, .px-table td { padding: 9px 12px; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--px-line); }
.px-table th { font-size: 11.5px; font-weight: 570; color: var(--px-muted); background: var(--px-surface-2); }
.px-table th:first-child { border-top-left-radius: var(--px-r-sm); }
.px-table th:last-child { border-top-right-radius: var(--px-r-sm); }
.px-table tbody tr { transition: background-color var(--px-dur-fast) var(--px-ease); }
.px-table tbody tr:hover { background: color-mix(in srgb, var(--px-pink) 8%, transparent); }
.px-table tbody tr:last-child td { border-bottom: none; }
.px-row-total td { font-family: var(--px-num-font); font-weight: 600; background: color-mix(in srgb, var(--px-yellow) 18%, transparent); }

.px-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 12px; }
.px-grid-2 .px-panel { margin-bottom: 12px; }

/* 时段与计费 + 活跃日历 并排一行。
   日历是 53 列宽的图形，格子边长**直接随这栏宽度线性变化**（见 graph.js 里
   cell 的算法），所以比例不能随便给：左栏只留一份够放倒计时与三行键值对的最小
   宽度（"周一至周五 09:00–12:00、14:00–18:00" 这行本身就要 300px 左右），
   余下全部让给日历，格子才不至于缩到看不清。
   用 minmax(fr) 而不是固定 px：窄屏时两栏等比收缩，且左栏有 280px 下限兜底。 */
.px-pair {
  display: grid;
  grid-template-columns: minmax(280px, 0.6fr) minmax(0, 1.4fr);
  gap: 12px;
  align-items: start;
}
/* 左栏窄，时段卡片内部跟着竖排：横排会让那三行键值对在 300px 里反复折行 */
.px-pair .px-period { grid-template-columns: 1fr; }
.px-pair .px-panel { margin-bottom: 12px; }

/* 单价说明：竖排，避免挤在表格单元格里换行 */
.px-rate-list { display: grid; gap: 6px; margin-top: 12px; }
.px-rate {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 7px 10px;
  border-radius: var(--px-r-sm);
  background: var(--px-surface-2);
  font-size: 11.5px; color: var(--px-muted);
}
.px-rate > b { color: var(--px-ink); font-size: 12px; }
.px-rate > span { font-variant-numeric: tabular-nums; }
.px-rate-swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }

/* 数据来源脚注 */
.px-source {
  margin: 4px 0 0;
  font-size: 11.5px; line-height: 1.7;
  color: var(--px-muted);
}
.px-source a { color: var(--px-tone-pink); text-decoration: underline; text-underline-offset: 2px; }
.px-source a:hover { color: var(--px-pink-deep); }

/* 输入框下方的会话费用徽标（费用 + 余额 + 套餐额度）。
   默认这些徽标会 **portal 进产品统计行**（[data-composer-stats]），与「缓存命中」
   并排同一行；锚点不在时才退回自渲染 .px-cost-row。
   容器是纵向 flex + align-items: center 且**没有 gap**，所以兜底行必须自己撑满宽度
   并自带上边距，否则会收缩居中并贴住输入框。 */
.px-cost-row {
  display: flex;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  width: 100%;
  max-width: var(--dsh-chat-content-width, 100%);
  margin: 0 auto;
  box-sizing: border-box;
  padding: 4px calc(var(--dsh-composer-side-clearance, 16px) + 16px) 0;
  font-size: var(--dsh-content-font-size-secondary, 13px);
}
/* 并入产品统计行时，这一层只是 inline-flex，间距交给产品那行 */
.px-pill-group { display: inline-flex; align-items: center; gap: 12px; flex-wrap: wrap; }

/* 一枚徽标：刻意对齐产品统计胶囊的观感（13px、tertiary 文字、24px 圆角、
   悬停微微加深），并排时不显得是外来的。 */
.px-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  max-width: 100%;
  padding: 1px 8px;
  border: none;
  border-radius: 24px;
  background: transparent;
  color: var(--px-label-tertiary);
  font: inherit;
  font-variant-numeric: tabular-nums;
  line-height: inherit;
  white-space: nowrap;
  transition: background-color var(--px-dur-fast) var(--px-ease);
}
.px-pill:hover { background: color-mix(in srgb, var(--px-ink) 7%, transparent); }
.px-pill-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--px-tone-pink); }
.px-pill-label { color: inherit; }
.px-pill-value { color: var(--px-ink); font-weight: 620; }
/* 拿不到费用时的告警态：不要在界面上装作一切正常 */
.px-pill-warn { background: color-mix(in srgb, var(--px-red) 14%, transparent); }
.px-pill-warn .px-pill-dot { background: var(--px-tone-red); }
.px-pill-warn .px-pill-value { color: var(--px-tone-red); }

/* 时段与计费：倒计时降级为一行次要信息，与计费口径同处一张紧凑卡片，
   不再单独占一张大面板（用户反馈「内容不多却占大量空间」）。 */
.px-period {
  display: grid;
  grid-template-columns: minmax(190px, max-content) 1fr;
  gap: 12px;
  align-items: center;
}
.px-period-clock {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-radius: var(--px-r-md);
  background: var(--px-surface-2);
}
.px-period-clock-label { font-size: 11.5px; color: var(--px-muted); }
.px-period-clock-value {
  font-family: var(--px-num-font);
  font-size: 15px; font-weight: 640;
  color: var(--px-ink);
  font-variant-numeric: tabular-nums;
}
.px-period-clock-foot { font-size: 11px; color: var(--px-muted); }
.px-period-rows { display: grid; gap: 4px; min-width: 0; }

/* 账户与套餐：并排两栏，各自内部紧凑排列（原来两张独立大面板太占地方） */
.px-account-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 12px;
  align-items: start;
}
.px-account-col { min-width: 0; }
.px-account-grid .px-balance-privacy { margin-top: 8px; padding-top: 8px; }
.px-account-grid .px-plan-list { gap: 10px; }

/* 跳去官方平台充值 / 管理的入口 */
.px-links { margin: 8px 0 0; font-size: 11.5px; }
.px-links a { color: var(--px-tone-pink); text-decoration: underline; text-underline-offset: 2px; }
.px-links a:hover { color: var(--px-pink-deep); }
.px-links-sep { margin: 0 6px; color: var(--px-muted); }

/* 折叠区：把「数据来源与隐私」这类长说明收起来——信息仍可查，但不占版面。
   用原生 <details>，不需要任何 JS 或组件状态。 */
.px-details {
  margin-top: 8px;
  border-top: 1px dashed var(--px-line-2);
  padding-top: 6px;
}
.px-details > summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--px-muted);
  list-style: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  user-select: none;
}
.px-details > summary::-webkit-details-marker { display: none; }
/* 自绘小三角：不依赖浏览器默认标记（各家观感差别很大） */
.px-details > summary::before {
  content: '';
  width: 0; height: 0;
  border-left: 5px solid currentColor;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transition: transform var(--px-dur-fast) var(--px-ease);
}
.px-details[open] > summary::before { transform: rotate(90deg); }
.px-details > summary:hover { color: var(--px-ink-2); }
.px-details .px-balance-privacy { margin-top: 6px; padding-top: 0; border-top: none; }

/* 账户余额卡片：看板里的明细区 */
.px-balance-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
  margin-bottom: 12px;
}
.px-balance-total { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.px-balance-amount {
  font-family: var(--px-num-font);
  font-size: 26px; font-weight: 660; letter-spacing: -0.4px;
  color: var(--px-ink);
}
.px-balance-amount.px-negative { color: var(--px-tone-red); }
.px-balance-currency { font-size: 12px; font-weight: 560; color: var(--px-muted); }
.px-balance-rows { display: grid; gap: 6px; margin-top: 4px; }
.px-balance-toggle {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 12px; color: var(--px-muted);
}
.px-balance-state {
  margin: 0 0 10px;
  padding: 7px 11px;
  border-radius: var(--px-r-sm);
  background: var(--px-surface-2);
  font-size: 11.5px; line-height: 1.6; color: var(--px-muted);
}
.px-balance-state.px-warn { background: color-mix(in srgb, var(--px-yellow) 22%, var(--px-surface-2)); color: var(--px-ink-2); }
.px-balance-state.px-error { background: color-mix(in srgb, var(--px-red) 18%, var(--px-surface-2)); color: var(--px-ink-2); }
.px-balance-privacy {
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px dashed var(--px-line-2);
  font-size: 11px; line-height: 1.7; color: var(--px-muted);
}
.px-balance-state.px-off { background: var(--px-surface-2); color: var(--px-muted); }

/* 订阅套餐额度：一家一块，每块里按窗口（5 小时 / 每周 / 每月）逐条画进度 */
.px-plan-list { display: grid; gap: 16px; }
.px-plan {
  padding: 9px 11px 10px;
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-md);
  background: var(--px-surface-2);
}
.px-plan-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.px-plan-name { font-size: 13px; font-weight: 620; color: var(--px-ink); }
/* 凭据尾段：只为让用户确认「用的是哪一把 Key」，不是密钥本身 */
.px-plan-key {
  margin-left: auto;
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-muted);
  padding: 2px 8px;
  border-radius: var(--px-r-pill);
  background: var(--px-surface);
  border: 1px solid var(--px-line);
}
.px-quota-list { display: grid; gap: 10px; margin-top: 12px; }
.px-quota-head { display: flex; align-items: baseline; gap: 10px; }
.px-quota-name { font-size: 12px; font-weight: 560; color: var(--px-ink-2); min-width: 58px; }
.px-quota-percent { font-size: 12.5px; font-weight: 620; }
.px-quota-percent.px-tone-green { color: var(--px-tone-green); }
.px-quota-percent.px-tone-yellow { color: var(--px-tone-yellow); }
.px-quota-percent.px-tone-red { color: var(--px-tone-red); }
.px-quota-track {
  margin-top: 6px;
  height: 7px;
  border-radius: var(--px-r-pill);
  background: color-mix(in srgb, var(--px-ink) 10%, transparent);
  overflow: hidden;
}
.px-quota-fill {
  display: block; height: 100%;
  border-radius: var(--px-r-pill);
  transition: width var(--px-dur-slow) var(--px-ease-out);
}
.px-quota-foot { margin-top: 6px; font-size: 11px; color: var(--px-muted); font-variant-numeric: tabular-nums; }

/* 费用条上「最紧额度」那一枚用紫色点，与余额（绿）和费用（粉）区分开 */

@media (max-width: 960px) {
  .px-period { grid-template-columns: 1fr; }
  /* 窄屏：并排的两块塌回单列，日历才不至于被压成一条 */
  .px-pair { grid-template-columns: 1fr; }
  .px-model-grid { grid-template-columns: 1fr; justify-items: center; }
  .px-root { padding: 14px 14px 40px; }
  .px-topbar { margin: -14px -14px 16px; padding: 12px 14px; top: -14px; }
}
`

/** 样式表清单：装配与卸载共用同一份来源。 */
export const STYLES = [
  ['tokens', TOKENS],
  ['skin', SKIN],
  ['dashboard', DASHBOARD],
]
