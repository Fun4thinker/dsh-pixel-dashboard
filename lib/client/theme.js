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

/* 卡片内的次级分段控件（趋势维度）：比顶部那个窗口切换器小一号。
   两者若长得一样重，用户会以为「模型 / 提供商」也是全局窗口设置。 */
.px-trend-dim { padding: 2px; }
.px-trend-dim .px-seg-thumb { top: 2px; bottom: 2px; left: 2px; border-radius: 5px; }
.px-trend-dim .px-seg-btn { padding: 3px 9px; font-size: 11px; }

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

/* 可折叠面板：标题行整行变成一枚按钮。
   收起时**只留标题行**（body 根本不渲染），因此省下的是实打实的高度。
   按钮占满整行并自理内边距：header 本身已有 padding，这里要减掉，
   否则鼠标可点区域会比视觉上的标题行小一圈。 */
.px-panel-toggle {
  display: flex; align-items: center; gap: 8px;
  flex: 1 1 auto; min-width: 0;
  margin: -9px -14px; padding: 9px 14px;
  font: inherit; text-align: left; color: inherit;
  background: none; border: none; cursor: pointer;
  border-radius: 0;
}
.px-panel-toggle:hover { background: color-mix(in srgb, var(--px-ink) 5%, transparent); }
.px-panel-toggle-hint {
  margin-left: auto;
  font-size: 11px; color: var(--px-muted);
  padding: 2px 8px;
  border-radius: var(--px-r-pill);
  background: var(--px-surface-2);
  border: 1px solid var(--px-line);
}
.px-panel-toggle:hover .px-panel-toggle-hint { color: var(--px-ink-2); }
/* 自绘三角（与 .px-details 同一套语言）：朝右 = 收起，朝下 = 展开。
   不依赖浏览器默认 marker，各家观感差别太大。 */
.px-caret {
  width: 0; height: 0; flex: none;
  border-left: 5px solid currentColor;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  color: var(--px-muted);
  transition: transform var(--px-dur-fast) var(--px-ease);
}
.px-caret.open { transform: rotate(90deg); }

/* 面板内部的轻量折叠区（最近通知这类明细） */
.px-collapse { margin-bottom: 12px; }
.px-collapse-head {
  display: flex; align-items: center; gap: 8px;
  width: 100%;
  padding: 6px 2px;
  font: inherit; text-align: left; color: inherit;
  background: none; border: none; cursor: pointer;
  border-bottom: 1px dashed var(--px-line-2);
  border-radius: 0;
}
.px-collapse.open .px-collapse-head { border-bottom-style: solid; }
.px-collapse-head > b { font-size: 13px; font-weight: 620; color: var(--px-ink); }
.px-collapse-head .px-muted { margin: 0; }
.px-collapse-summary {
  margin-left: auto;
  font-size: 11px; color: var(--px-muted);
  font-variant-numeric: tabular-nums;
}
.px-collapse-body { padding-top: 8px; }

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
/* 高峰那一档：主题粉。与 .px-badge.ok 是同一套做法（淡色底 + 同色文字 +
   同色描边），只是换了色相——两态看起来才是同一种东西的两个状态。
   刻意**不**用 .ok 那种绿：绿在这里的语义是「便宜/正常」，
   而高峰是「正贵着」，用粉把它与空闲区分开，同时不落进红色的告警语义
   （红留给真正的故障：取数失败、余额为负）。 */
.px-badge.peak {
  background: color-mix(in srgb, var(--px-pink) 38%, transparent);
  color: var(--px-pink-deep);
  border-color: color-mix(in srgb, var(--px-pink-deep) 32%, transparent);
}
/* 强调徽标：「当前监看」这类「这是你选中的那个」标记。
   用粉色实底而不是描边，因为在三家并排的区块里，浅色描边几乎看不出来。 */
.px-badge.primary {
  background: linear-gradient(145deg, var(--px-pink), var(--px-pink-deep));
  color: #fff;
  border-color: transparent;
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
/* 可点的「最近通知」行：点一下切到那条会话。
   button 自带居中与内边距，这里全部改回与 .px-row 一致的排版，
   只额外给出 hover 底色与手型光标——否则它会看起来不像能点。 */
.px-row-clickable {
  width: 100%;
  font: inherit;
  text-align: left;
  background: none;
  border: none;
  border-bottom: 1px solid var(--px-line);
  border-radius: var(--px-r-sm);
  color: inherit;
  cursor: pointer;
}
.px-row-clickable:hover { background: color-mix(in srgb, var(--px-pink) 10%, transparent); }
.px-row-clickable:last-child { border-bottom: none; }

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
.px-line.px-tone-green { stroke: var(--px-tone-green); }
.px-line.px-tone-yellow { stroke: var(--px-tone-yellow); }
.px-line.px-tone-red { stroke: var(--px-tone-red); }
.px-area { stroke: none; }
.px-hover-line { fill: var(--px-ink); opacity: 0.16; }
.px-dot { stroke: var(--px-surface); stroke-width: 2; }
.px-dot.px-tone-blue { fill: var(--px-tone-blue); }
.px-dot.px-tone-purple { fill: var(--px-tone-purple); }
.px-dot.px-tone-pink { fill: var(--px-tone-pink); }
.px-dot.px-tone-green { fill: var(--px-tone-green); }
.px-dot.px-tone-yellow { fill: var(--px-tone-yellow); }
.px-dot.px-tone-red { fill: var(--px-tone-red); }

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
/* 另外三色必须补齐：按模型 / 提供商分组时最多会有 6 条线（TONES 全用上），
   缺一组 swatch 就会画出一个没有底色的空方块——图例与曲线对不上号。 */
.px-legend-swatch.px-tone-green { background: var(--px-tone-green); }
.px-legend-swatch.px-tone-yellow { background: var(--px-tone-yellow); }
.px-legend-swatch.px-tone-red { background: var(--px-tone-red); }
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
/* 数字列右对齐 + 等宽数字：金额与 token 并排时不跳动，位数也一眼可比 */
.px-table .px-num { text-align: right; font-variant-numeric: tabular-nums; }
/* 费用明细：模型那一格是「外显名 + 归一模型键 + 徽标」，其中键可能很长。
   给这一格一个宽度上限并允许换行，否则它会把「提供商」那一列挤到看不见。 */
.px-cost-table { table-layout: auto; }
.px-cost-table td:first-child { max-width: 320px; white-space: normal; }
.px-table th:first-child { border-top-left-radius: var(--px-r-sm); }
.px-table th:last-child { border-top-right-radius: var(--px-r-sm); }
.px-table tbody tr { transition: background-color var(--px-dur-fast) var(--px-ease); }
.px-table tbody tr:hover { background: color-mix(in srgb, var(--px-pink) 8%, transparent); }
.px-table tbody tr:last-child td { border-bottom: none; }
.px-row-total td { font-family: var(--px-num-font); font-weight: 600; background: color-mix(in srgb, var(--px-yellow) 18%, transparent); }

/* 会话清单：第一列是**预览标题**（与侧栏任务栏同源），会话 id 退成次要信息。
   标题可能很长（模型生成的标题是一句话），因此这一列要能被压缩并省略——
   表格用 min-width: 0 + text-overflow 才生效（默认的 table 布局会撑开）。 */
.px-session-table { table-layout: auto; }
.px-session-cell {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  max-width: 420px;
}
.px-session-title {
  font-weight: 550; color: var(--px-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 100%;
}
.px-session-workspace {
  font-size: 11px; color: var(--px-muted);
  padding: 1px 7px;
  border-radius: var(--px-r-pill);
  background: var(--px-surface-2);
  border: 1px solid var(--px-line);
  white-space: nowrap;
}
.px-session-id {
  /* 会话 id 仍然可查（悬停 title 可复制），但排在标题之后、视觉上退到最末 */
  color: var(--px-muted);
  white-space: nowrap;
}

.px-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 12px; }
.px-grid-2 .px-panel { margin-bottom: 12px; }

/* 两张趋势卡片（Token / 消费）并排一行。
   两条曲线共用同一段时间轴，分两行会让人来回滚动去对齐同一个日期，
   因此**等宽两列**并排（1fr 1fr 而不是 auto-fit）：等宽才能让两张图的横轴
   刻度落在同一列上，读数时不必横向换算。
   窄屏塌回单列——两张图各只有 300px 时曲线会挤成一团。 */
.px-trend-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: start;
}
.px-trend-row .px-panel { margin-bottom: 12px; }
/* 标题行右侧的维度切换器：卡片标题与它同排，不占额外高度。
   切换器自身在小屏会换行，这里允许它换行而不是硬挤。 */
.px-trend-row .px-panel-extra .px-seg { flex-wrap: wrap; }
@media (max-width: 1080px) {
  .px-trend-row { grid-template-columns: 1fr; }
}

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

/* 各模型官方单价：一张小表，不是一行塞满的标签云。
   早先把「色块×N + 模型名 + 提供商列表 + 三组价格 + 厂商」全塞进一个
   flex-wrap 容器，元素一多就折成好几行、右侧参差不齐。
   现在按两列排：左边是谁（色块 + 模型名 + 厂商），右边是三档价。
   价格区自己再分三列，于是每行的「缓存命中 / 未命中 / 输出」竖直对齐，
   纵向扫一眼就能比价——这正是这张表的用途。
   注意：这整段 CSS 是模板字符串，注释里**不能出现反引号**（会提前闭合字符串，
   症状是打包时报「Unexpected identifier」而源文件语法检查却是通过的）。 */
.px-rate-list {
  display: grid;
  /* 四列在**整张列表上定义一次**，每一行用 subgrid 继承同一组轨道。
     这样「缓存命中 / 未命中 / 输出」三列在所有行之间竖直对齐，眼睛能顺着列往下
     比价——这正是这张表存在的理由。

     早先每行各自 repeat(3, minmax(0, auto))，列宽按**本行内容**算：DeepSeek 那行
     有 ¥0.02 / ¥0.04 这种长数字，GLM 那行只有 ¥2 / ¥8 / ¥28，于是三列在行间错开
     （实测第一列起点 818 / 911 / 793），看起来就像「有的行缩进了、有的没有」。
     列宽必须由**全表最宽的那一格**决定，而不是各行自算。 */
  /* 第一列是**色块**（一个模型可能多家来源，并排几个小方块），第二列才是模型名。
     色块必须自成一列：若让它和模型名挤在同一个 flex 里，行与行之间的色块个数不同
     就会把模型名推到不同的起始位置（实测 4 个色块 → 名称起点 66px、1 个 → 33px），
     看起来就是「有的行前面突出一块空白」。 */
  grid-template-columns: auto minmax(0, 1fr) auto auto auto;
  column-gap: 14px;
  row-gap: 6px;
  margin-top: 12px;
}
.px-rate-caption {
  grid-column: 1 / -1;
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  font-size: 11px; color: var(--px-muted);
}
.px-rate-unit { font-variant-numeric: tabular-nums; }
.px-rate {
  display: grid;
  /* 继承列表那四列：列宽因此是全表统一的，而不是每行各算一份 */
  grid-template-columns: subgrid;
  grid-column: 1 / -1;
  align-items: center;
  column-gap: 14px;
  row-gap: 6px;
  padding: 7px 10px;
  border-radius: var(--px-r-sm);
  background: var(--px-surface-2);
  font-size: 11.5px; color: var(--px-muted);
}
/* 第 2 列：模型名 + 归一后的键 + 来源数。允许收缩，不把右列挤走 */
.px-rate-who {
  grid-column: 2; grid-row: 1;
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  min-width: 0;
}
.px-rate-who > b { color: var(--px-ink); font-size: 12px; }
.px-rate-prices {
  /* 直接落在列表的第 2–4 列上，并继续用 subgrid 往下继承，
     于是三个价格列与表头、与其它行共享同一组轨道宽度。 */
  grid-column: 3 / -1; grid-row: 1;
  display: grid; grid-template-columns: subgrid;
  column-gap: 14px;
  font-variant-numeric: tabular-nums;
}
.px-rate-prices > span { display: flex; align-items: baseline; gap: 5px; white-space: nowrap; }
.px-rate-prices em { font-style: normal; color: var(--px-muted); font-size: 11px; }
.px-rate-prices code {
  font-family: var(--px-num-font); color: var(--px-ink); font-size: 11.5px;
}
.px-rate-swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }
/* 第 1 列：一个模型可能由多家提供商提供，这里并排它们的色块（与环图同一套配色）。
   收窄间距并让它们成组，读起来才像「同一个模型的几个来源」而不是几件不相干的东西。
   本列宽度由全表最宽的那一组色块决定（subgrid），因此模型名在所有行上左边界一致。 */
.px-rate-tones {
  grid-column: 1; grid-row: 1;
  display: inline-flex; align-items: center; gap: 3px; flex: none;
}
/* 窄屏：价格换到第二行，不要横向挤成参差 */
/* ── 自定义单价编辑器 ────────────────────────────────────────
   它是「补一个价目表里没有的模型」的入口，因此排版目标很直白：一行里能看到
   六个数字框而不需要横向滚动，且「空闲 / 高峰」成对相邻——填错档位是这里最
   可能的错法，成对摆放能让它一眼可见。 */
.px-price-editor { margin-top: 12px; }
.px-price-editor > summary { cursor: pointer; font-size: 12px; font-weight: 560; }
.px-price-editor > summary > .px-badge { margin-left: 6px; }
.px-price-form {
  display: grid; gap: 8px;
  margin-top: 10px; padding: 10px;
  border-radius: var(--px-r-sm); background: var(--px-surface-2);
}
/* 通用文本输入框：与上面通知阈值那几个输入框**同一套外观**。
   本来想直接复用 .px-notify-input input，但那个选择器绑在通知面板的类名上，
   借来用会让「单价编辑器」意外依赖通知面板的 DOM 结构。 */
.px-input {
  /* basis 必须写 0 而不是 auto：auto 会用输入框自身的固有宽度（浏览器默认约 20 字符），
     于是它撑在 flex 里不肯收缩，三个价格档在窄栏里就会横向溢出（实测溢出 66px）。 */
  flex: 1 1 0;
  min-width: 0;
  padding: 5px 8px;
  font-family: var(--px-num-font);
  font-size: 12px;
  color: var(--px-ink);
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-sm);
}
.px-input:disabled { opacity: 0.55; }
/* min-width: 0 是**必须**的：flex 容器默认 min-width:auto，会被内部输入框的固有宽度
   撑住不收缩，于是整行溢出到面板外面（grid/flex 层叠里的经典坑）。 */
.px-rate-field { display: flex; align-items: center; gap: 8px; min-width: 0; }
.px-rate-field-label { flex: none; width: 62px; font-size: 11.5px; color: var(--px-muted); }
.px-rate-pairs {
  display: grid; gap: 8px;
  /* 三档并排；窄屏由下面的媒体查询塌成单列，避免六个框挤成一团 */
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.px-rate-pair { display: grid; gap: 4px; min-width: 0; }
.px-rate-pair > b { font-size: 11.5px; color: var(--px-ink); }
.px-rate-pair .px-rate-field-label { width: 32px; }
.px-rate-pair .px-input { min-width: 0; }
.px-price-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.px-price-errors { margin: 6px 0 0; padding-left: 18px; font-size: 11.5px; color: var(--px-red); }
.px-price-remove { display: flex; gap: 8px; align-items: center; }
.px-balance-state.px-ok {
  background: color-mix(in srgb, var(--px-tone-green) 20%, var(--px-surface-2));
  color: var(--px-ink-2);
}

@media (max-width: 720px) {
  /* 窄屏：价格整行换到第二行。此时每一行都占满同一宽度，因此均分三列即可让
     列与列继续对齐——这里刻意**不用 subgrid**（上一层的轨道只剩 1 列了，
     继承下来会把三个价格竖着叠起来）。 */
  /* 色块仍单独一列（宽度由本表最宽的一组决定），模型名跟在它右边：
     不这样做，色块个数不同同样会让名称左边界参差——那正是宽屏下修掉的那个问题。 */
  .px-rate { grid-template-columns: auto minmax(0, 1fr); }
  .px-rate-tones { grid-column: 1; grid-row: 1; }
  .px-rate-who { grid-column: 2; grid-row: 1; }
  /* 六个数字框在窄屏塌成单列：并排会让每个框窄到看不清数字 */
  .px-rate-pairs { grid-template-columns: minmax(0, 1fr); }
  .px-rate-prices {
    grid-column: 1 / -1; grid-row: 2;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    column-gap: 14px;
  }
}

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
/* 角标：点明「这个数字是怎么来的」（如「估算」）。
   只写进 title 是不够的——不主动悬停的用户永远看不到那一层说明。 */
.px-pill-tag {
  padding: 0 5px;
  border-radius: var(--px-r-pill);
  background: color-mix(in srgb, var(--px-yellow) 45%, transparent);
  color: var(--px-tone-yellow);
  font-size: 10px; font-weight: 600;
  line-height: 1.6;
}
/* 拿不到费用时的告警态：不要在界面上装作一切正常 */
.px-pill-warn { background: color-mix(in srgb, var(--px-red) 14%, transparent); }
.px-pill-warn .px-pill-dot { background: var(--px-tone-red); }
.px-pill-warn .px-pill-value { color: var(--px-tone-red); }

/* ── 侧栏「用量看板」行上的时段倒计时 ────────────────────────────
   一行文字，用颜色区分时期：
     高峰中（红）→ 2时15分后空闲期
     空闲中（绿）→ 空闲期剩2时15分

   刻意**没有环形进度**：那枚环要「已走 ÷ 总长」，而各段长度差几十倍
   （午休 2 小时、周末 63 小时），环在周末几乎不动，看起来像坏了。
   文字直说「还剩多久」既准确又省地方。

   ## 它放在哪
   放在**「用量看板」四个字的右边**。由 entry.js portal 进产品的 row 元素，
   因此它是标题的 **flex 兄弟节点**，自然排在标题之后。

   这点很关键：产品只把**图标槽**给插件，而图标槽是内容宽度（十几像素）。
   早先在插槽内部用绝对定位 + right，那个 right 是相对**图标槽**解析的，
   文字因此怎么都离不开柱状图标。portal 到 row 之后这个问题从结构上消失。

   颜色一律走 --px-* 令牌（--px-tone-green / --px-tone-red 已在深浅两套里
   各自定义），因此深色模式下会自动换成更亮的那一支，不会糊在暗底上。 */

/* 图标槽里的内容容器：只放柱状图图标。 */
.px-panel-entry {
  display: inline-flex;
  align-items: center;
  pointer-events: none;
}

/* 倒计时文字：row 里的普通 flex 项；margin-left: auto 把它推到行尾，
   标题因此仍从左对齐、不会被挤到中间。 */
.px-period-inline {
  margin-left: auto;
  padding-left: 8px;
  white-space: nowrap;
  flex: none;
  pointer-events: none;
  font-family: var(--px-num-font);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.2px;
}
/* 两个时期各一色：红 = 高峰（正贵着）、绿 = 空闲（正便宜） */
.px-period-tone-red { color: var(--px-tone-red); }
.px-period-tone-green { color: var(--px-tone-green); }

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

/* 账户与套餐：并排两栏，各自内部紧凑排列（原来两张独立大面板太占地方）。
   两栏高度不齐是常态（一边两个数字、一边三家的进度条），align-items: start
   让短的那一栏不被拉伸——拉出来的空白看起来像「没加载完」。 */
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
/* 折叠区里那几家：间距收紧一点，并且整体压暗——
   它们此刻没有数据（就是「还没配」），不该与上面真正在用的那几家抢注意力，
   但仍然要能一眼看清「插件还支持哪些家、各自怎么配」。 */
.px-plan-list-idle { gap: 12px; margin-top: 10px; }
.px-plan-list-idle .px-plan { background: var(--px-surface); }
.px-plan-list-idle .px-plan-name { color: var(--px-ink-2); }
.px-plan {
  padding: 9px 11px 10px;
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-md);
  background: var(--px-surface-2);
}
/* 「当前监看」那一家：左侧一道粉色标记 + 略深底色。
   这道标记是切换器的**可见结果**——点完必须一眼看出点中了谁，
   否则切换器看起来就像没生效。 */
.px-plan-current {
  border-color: color-mix(in srgb, var(--px-tone-pink) 38%, var(--px-line));
  box-shadow: inset 3px 0 0 var(--px-tone-pink);
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
/* 一家的补充信息一行装完：入口链接 + 数据源端点。
   分两行会让三家堆出六行，而这两件事都属于「关于这一家」的次要信息。 */
.px-plan-foot {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  margin: 8px 0 0;
  font-size: 11px;
}
.px-plan-foot a { color: var(--px-tone-pink); text-decoration: underline; text-underline-offset: 2px; }
.px-plan-foot a:hover { color: var(--px-pink-deep); }
.px-plan-endpoint {
  margin-left: auto;
  color: var(--px-muted);
  font-family: var(--px-num-font);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 60%;
}

/* 「这家凭据怎么配」：去哪拿 + 拿到后放哪。
   缺凭据时默认展开（那正是用户需要它的时刻），所以这一块必须自己读得懂，
   不能只写「请配成 XXX」——DSH 设置里没有能填这个名字的输入框。 */
.px-plan-setup {
  margin: 10px 0 0;
  padding: 8px 11px;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-sm);
  background: var(--px-surface-2);
}
.px-plan-setup > summary { font-size: 11.5px; }
.px-plan-steps {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 11.5px; line-height: 1.75; color: var(--px-ink-2);
}
.px-plan-steps li { margin-bottom: 4px; }
.px-plan-setup-link { margin: 8px 0 0; font-size: 11.5px; }
.px-plan-setup-link a {
  color: var(--px-tone-pink);
  text-decoration: underline; text-underline-offset: 2px;
}
.px-plan-setup-link a:hover { color: var(--px-pink-deep); }
.px-plan-setup-where {
  margin-top: 9px; padding-top: 8px;
  border-top: 1px dashed var(--px-line-2);
  font-size: 11.5px; line-height: 1.7; color: var(--px-muted);
}
.px-plan-setup-where > p { margin: 0; }
/* 路径要能整条读出来并复制：换行而不是省略号截断 */
.px-plan-setup-path {
  display: block;
  margin: 5px 0 0;
  padding: 5px 8px;
  border-radius: var(--px-r-sm);
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-ink-2);
  word-break: break-all;
  user-select: all;
}
.px-plan-setup-refs {
  margin: 6px 0 0;
  padding-left: 16px;
  list-style: none;
}
.px-plan-setup-refs li { margin-bottom: 3px; }
.px-plan-setup-refs code {
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-ink);
}
.px-plan-setup-note {
  margin-left: 6px;
  font-size: 11px; color: var(--px-muted);
}
.px-plan-setup-hint { margin: 8px 0 0; font-size: 11px; line-height: 1.7; color: var(--px-muted); }
.px-plan-setup-hint code {
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-ink-2);
}

/* 「当前监看」切换器：一排小 chip。
   自动项永远存在（否则用户点过一次就再也回不到自动）。失败的厂商也列出来并
   带一个告警点——用户配错凭据时恰恰最想切过去看原因。 */
.px-plan-switch {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin-bottom: 12px;
}
.px-plan-switch-label { font-size: 11.5px; font-weight: 570; color: var(--px-muted); }
.px-plan-switch-hint {
  flex-basis: 100%;
  font-size: 11px; color: var(--px-muted); line-height: 1.5;
}
.px-plan-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px;
  font: inherit; font-size: 11.5px; font-weight: 550;
  color: var(--px-ink-2);
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-pill);
  cursor: pointer;
}
.px-plan-chip:hover { background: var(--px-surface-2); }
.px-plan-chip.active {
  color: #fff; border-color: transparent;
  background: linear-gradient(145deg, var(--px-pink), var(--px-pink-deep));
}
/* 取数失败的那一家：带一枚小红点，切过去就是它的失败原因 */
.px-plan-chip.bad::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: var(--px-tone-red); flex: none;
}
.px-plan-chip.active.bad::before { background: #fff; }
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

/* ── 通知与预警 ───────────────────────────────────────────────────
   面板里的这几块（授权行、开关、阈值输入、最近通知）与页面内提示条共用
   同一套 --px-* 令牌，因此明暗两套方案都自动成立，不必各写一遍。 */

.px-notify-permission {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 9px 11px;
  margin-bottom: 12px;
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-md);
  background: var(--px-surface-2);
}
.px-notify-permission-text { margin: 0; flex: 1 1 240px; }

.px-notify-pending {
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid color-mix(in srgb, var(--px-yellow) 45%, var(--px-line));
  border-radius: var(--px-r-md);
  background: color-mix(in srgb, var(--px-yellow) 16%, var(--px-surface));
}
.px-notify-pending-title { display: block; margin-bottom: 8px; font-size: 13px; color: var(--px-ink); }

.px-notify-flags {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 6px 14px;
  margin-bottom: 14px;
}
.px-notify-flag {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 12.5px; color: var(--px-ink-2);
  cursor: pointer;
}
.px-notify-flag input { flex: none; }

.px-notify-threshold {
  padding: 10px 12px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-md);
  background: var(--px-surface-2);
}
/* 两项阈值并排：各自正文只有「一个标签 + 一个数字框」，各占整行会白吃两倍高度。
   两栏等宽（1fr 1fr）而不是 auto-fit：它们的信息量相当，等宽读起来才整齐。
   窄屏塌回单列——余额那一项在小屏上要换行放「CNY 低于 [__]」。 */
.px-notify-thresholds {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
}
/* 并排时最后一项的下边距会与容器重叠，这里去掉（间距交给 grid 的 gap） */
.px-notify-thresholds .px-notify-threshold { margin-bottom: 0; }
.px-notify-threshold-head {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  margin-bottom: 10px;
}
.px-notify-threshold-head b { font-size: 13px; font-weight: 620; color: var(--px-ink); }
.px-notify-threshold-head .px-muted { margin: 0; }

.px-notify-inputs { display: flex; align-items: center; gap: 10px 16px; flex-wrap: wrap; }
.px-notify-input {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 12.5px; color: var(--px-ink-2);
}
.px-notify-input input {
  width: 84px;
  padding: 5px 8px;
  font-family: var(--px-num-font);
  font-size: 12.5px;
  color: var(--px-ink);
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
}
.px-notify-recent { margin-bottom: 4px; }

/* 页面内提示条：系统通知不可用时的唯一可见通道。
   固定右下角、脱离文档流，因此不会挤动任何产品元素。 */
.px-toast-host {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483000;
  display: grid;
  gap: 8px;
  max-width: min(360px, calc(100vw - 36px));
  pointer-events: none;
}
.px-toast {
  display: grid;
  gap: 3px;
  padding: 11px 13px;
  border-radius: var(--px-r-md);
  border: 1px solid var(--px-line-2);
  background: var(--px-surface);
  box-shadow: var(--px-elev-3);
  font-size: 12.5px;
  color: var(--px-ink-2);
  animation: px-toast-in var(--px-dur-slow) var(--px-ease-out);
}
.px-toast-title { font-size: 13px; font-weight: 620; color: var(--px-ink); }
.px-toast-body { line-height: 1.6; }
.px-toast-ok { border-left: 3px solid var(--px-tone-green); }
.px-toast-warn { border-left: 3px solid var(--px-tone-yellow); }
.px-toast-error { border-left: 3px solid var(--px-tone-red); }
/* 可点的提示条（带着会话 id 的那些）：点一下切到那条会话。
   容器是 pointer-events: none（让提示条不挡住它下面的产品界面），所以这里必须
   把它**单独**开回来，否则整条提示条都收不到点击——点了没反应，而没有任何报错。 */
.px-toast-clickable {
  pointer-events: auto;
  cursor: pointer;
  transition: background-color var(--px-dur-fast) var(--px-ease);
}
.px-toast-clickable:hover { background: var(--px-surface-2); }
/* 可点时补一句动作提示，让「能点」这件事自己说出来 */
.px-toast-clickable .px-toast-body::after {
  content: ' · 点击前往';
  color: var(--px-muted);
}
@keyframes px-toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (max-width: 960px) {
  .px-period { grid-template-columns: 1fr; }
  /* 窄屏：并排的两块塌回单列，日历才不至于被压成一条 */
  .px-pair { grid-template-columns: 1fr; }
  /* 阈值并排也要塌回单列：两栏各 320px 以下时，「CNY 低于 [____]」会挤成三行 */
  .px-notify-thresholds { grid-template-columns: 1fr; }
  .px-notify-thresholds .px-notify-threshold { margin-bottom: 12px; }
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
