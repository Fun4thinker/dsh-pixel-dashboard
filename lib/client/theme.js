/**
 * 视觉系统：只负责插件自己的两块界面——用量看板整页，以及输入框下方
 * 费用条 / 页面内提示条。全部用插件自己的 --px-* 令牌与 .px-* 类名。
 *
 * **不碰产品配色。** 早先这里带两套 `--dsw-alias-*` 主题（奶油·昼 / 暮色·夜）、
 * 一层令牌覆盖和一张全局皮肤样式表，等于替用户改掉整个产品界面的底色、文字色、
 * 按钮圆角、滚动条与选中色。皮肤已按需求移除：产品原版的深浅色与背景完全交还
 * DSH，插件只在上面那两块自己的界面上配色。
 *
 * 深浅色仍然跟着产品走：产品把 data-ds-dark-theme 打在 body 上，TOKENS 里
 * **读**这个属性、给出深色的一套 --px-* 取值。读产品属性是允许的，**写**产品的
 * --dsw-* 令牌不是（那会连产品窗口与侧栏的背景一起改掉）。
 * @module dsh-pixel-dashboard/client/theme
 */

import { ACCOUNTS_CSS } from './styles/accounts.js'
import { PRICING_CSS } from './styles/pricing.js'
import { SESSION_CSS } from './styles/session.js'

/*
 * 这里**不该再有** PIXEL_THEMES / PALETTE_OVERRIDES 一类东西。
 *
 * 它们曾把两套 --dsw-alias-* 令牌注册成可选主题（设置 → 外观里的
 * 奶油·昼 / 暮色·夜），并默认叠一层 overrideTokens 覆盖。两者都会改动
 * **产品自己**的配色：用户打开的不止是这个看板，还有整个窗口、侧栏与会话区。
 * 皮肤功能已按需求移除，于是那两个导出连同 entry.js 里的注册与覆盖一起删掉了。
 *
 * 渲染闸门对这件事是**反向断言**：themes 与 paletteLayers 必须为 0。
 * 看板自己的配色不靠它们，靠 TOKENS 的 --px-* 变量 + DASHBOARD 里的 .px-*
 * 选择器；深色跟随产品靠读 body 上的 data-ds-dark-theme。
 */

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
  /* ── 浅色：白卡片 + 淡暖底 + 极少数内凹槽 ─────────────────────────────
     **这一页的观感规则只有一条：白色是唯一的「块」，米色只在「凹进去」的地方出现。**

     早先这里错在**面积**，不在明度：--px-surface-2 被拿去铺了 18 处
     （表头、余额说明条、单价行、价格表单、套餐块、时钟块、通知块……），
     于是白色卡片里嵌着一块块米色，看起来「东一块西一块」。
     第一版修复还把它调暗去「拉开层次」，等于把那些碎块**做得更显眼**，
     在真实界面上更丑——数值全绿，观感更差。

     现在的分工：
       --px-surface   #ffffff   所有卡片、面板、按钮（页面里唯一的「块」）
       --px-bg        #f6f2ea   页面底（卡片浮在它上面）
       --px-surface-2 #ece6da   只用于**内凹**：进度条轨道、分段控件底、
                                表头、输入框。四个地方，不再扩散。

     改这三个值时请保持「白 = 块、米 = 凹」，而不是靠对比度数字自我安慰。
     tools/render-check.mjs 里有一道闸门盯着「谁在铺 surface-2」的白名单。 */
  --px-bg: #f6f2ea;
  --px-surface: #ffffff;
  --px-surface-2: #ece6da;
  --px-line: rgba(87, 68, 58, 0.10);
  --px-line-2: rgba(87, 68, 58, 0.18);

  /* ── 中性层次的第二层与第三层 ──────────────────────────────────────
     页面需要「块 → 分区 → 内容」三层，早先是靠**七种彩色**去区分模块
     （每张概览卡一条不同颜色的顶栏、每个面板一个彩色圆点），于是整页像
     打翻了调色盘——用户的原话是「配色割裂」。

     现在只留一层中性面：面板头、工具条、表头共用 --px-layer-2，
     需要再凹一档（进度条轨道、表头压边）用 --px-layer-3。
     用 color-mix 而非写死的米色：深浅两套自动成立，不用各配一份。
     **强调色只留给「当前状态 / 主操作」**，不再当装饰。 */
  --px-layer-2: color-mix(in srgb, var(--px-ink) 3.5%, transparent);
  --px-layer-3: color-mix(in srgb, var(--px-ink) 6%, transparent);

  /* ── 品牌鲸鱼（头像插画用，不是界面色）───────────────────────────
     这是**插画**用色，不参与界面语义；用 DeepSeek 的蓝，深浅两套各给一档，
     保证在浅底上是「深蓝鲸鱼」、在深底上是「亮蓝鲸鱼」。 */
  --px-whale: #4d6bfe;
  --px-whale-belly: #9fb0ff;
  --px-whale-spout: #cddcff;
  --px-whale-eye: #ffffff;
  --px-whale-soft: color-mix(in srgb, #4d6bfe 12%, transparent);

  --px-pink: #f2a8c4;
  --px-pink-deep: #d9739b;
  --px-pink-soft: #fdeef4;
  /* 会话详情的强调色：浅色下用粉（与看板主色一致）。
     深色下换成紫——粉色在暗底上偏灰、像脏掉的高光，紫色同族但更清透。 */
  --px-detail-accent: #d9739b;
  --px-detail-accent-soft: #fdeef4;
  --px-detail-accent-line: #f2a8c4;
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
  /* 浮层里的次要文字（分节标签、行标签、脚注）。
     为什么不直接用 --px-muted：那个色在白底上的对比度实测 4.18，**低于 AA 的 4.5**，
     而浮层里这些字只有 11~12px，读起来吃力（版式审计把这一条判红过）。
     往墨色偏一档即可达标，且深浅两套自动成立——深色下墨色是亮的，方向自然正确。 */
  --px-detail-label: #75655a;

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
  /* 深色浮层里的次要文字：比 --px-muted 更亮一档，同样是为了过 AA（暗底上要更亮）。 */
  --px-detail-label: #acb5cd;

  --px-pink-soft: #3a2b34;
  /* 详情强调色在深色下走紫：见浅色处说明。 */
  --px-detail-accent: #c3aef0;
  --px-detail-accent-soft: #2f2b45;
  --px-detail-accent-line: #8b6cc4;
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
 * 看板局部样式：全部使用 px- 前缀类名，不依赖产品内部类名，
 * 因此产品升级不会让看板错版。
 *
 * 早先这里前面还有一张 SKIN 样式表（`body` 网格底纹、全局 button/input 的圆角与
 * transition、`::-webkit-scrollbar`、`::selection`）。它已按需求删除——那张表写的
 * 全是**全局元素选择器**，等于替用户重绘整个产品界面；产品的原版背景与控件观感
 * 应当原样交还 DSH。
 *
 * 删掉它之后有两个连带后果，都在本文件里就地补上了，改这块时别丢：
 *   1) 全局的 `button, input { border-radius; transition }` 没了，于是看板自己的
 *      控件必须自己写圆角与过渡。`--px-*` 令牌的取值不受影响（它读的是产品打在
 *      body 上的 data-ds-dark-theme），因此深浅色仍然对。
 *   2) 全局 `:focus-visible` 的焦点环也没了，`.px-*` 控件要自己给一条，
 *      否则键盘操作时看不出焦点在哪。
 * 底纹没了之后 `.px-topbar` 的毛玻璃底色更要紧：它原本盖在 body 网格上，
 * 现在下面就是产品自己的背景，因此这一层仍保留 color-mix + backdrop-filter。
 */
const DASHBOARD = `
/* 看板整页自己铺底色。早先这一层是透明的，背景靠 SKIN 打在 body 上的网格底纹；
   皮肤删掉之后不铺就只剩产品自己的背景，浅色下奶油色卡片会直接浮在产品底色上、
   整页也没有「这是插件的一页」的边界。铺 --px-bg 只给**这一页**上色，
   不碰产品任何元素——这正是「插件只在自己的界面上用自己的配色」的意思。 */
.px-root {
  box-sizing: border-box;
  min-height: 100%;
  padding: 16px 20px 36px;
  background: var(--px-bg);
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

/* 看板里的按钮。圆角与过渡**必须自己写**：早先这两条由 SKIN 那条全局
   button/input 规则提供，皮肤删掉之后不自己写就会变成直角、且 hover 是硬切。
   令牌取值（--px-r-sm 等）不受影响，因此深浅色仍然对。 */
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
  transition:
    background-color var(--px-dur) var(--px-ease),
    border-color var(--px-dur) var(--px-ease),
    color var(--px-dur-fast) var(--px-ease),
    box-shadow var(--px-dur) var(--px-ease),
    transform var(--px-dur-fast) var(--px-ease);
}
.px-btn:hover:not(:disabled) {
  /* 按钮 hover：极淡着色，而不是换成米色块——否则一悬停就「变脸」。 */
  background: color-mix(in srgb, var(--px-ink) 6%, transparent);
  box-shadow: var(--px-elev-2);
  transform: translateY(-1px);
}
.px-btn:active:not(:disabled) { transform: translateY(0) scale(0.98); box-shadow: var(--px-elev-1); }
.px-btn:disabled { opacity: 0.55; cursor: default; }
/* 焦点环：全局 :focus-visible 规则随 SKIN 一起删了，看板自己的控件要自己给一条，
   否则键盘操作时看不出焦点落在哪个按钮上。 */
.px-btn:focus-visible { outline: none; box-shadow: var(--px-ring); }
.px-btn.primary {
  color: #fff; border-color: transparent;
  background: linear-gradient(145deg, var(--px-pink), var(--px-pink-deep));
  box-shadow: 0 2px 10px color-mix(in srgb, var(--px-pink-deep) 35%, transparent);
}
.px-btn.small { padding: 5px 11px; font-size: 12px; }
/* 破坏性动作（移除凭据）。红底只给这一个按钮：插件里其余动作都不是不可撤销的，
   把危险色摊开用会让真正的警告失去分量。 */
.px-btn.danger {
  color: #fff; border-color: transparent;
  background: var(--px-tone-red);
  box-shadow: 0 2px 10px color-mix(in srgb, var(--px-tone-red) 32%, transparent);
}
.px-btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--px-tone-red) 86%, #000);
}
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
/* 分段控件里的每一枚选项。圆角跟着 thumb 走（6px）——早先这颗按钮自己没有圆角，
   靠的是 SKIN 那条全局 button 规则；全局规则删掉后不补就变成直角，
   而 thumb 仍是圆角，一枚圆角滑块在直角按钮上滑动看起来像错位。 */
.px-seg-btn {
  position: relative; z-index: 1;
  padding: 5px 13px;
  font: inherit; font-size: 12px; font-weight: 550;
  color: var(--px-muted);
  background: none; border: none; cursor: pointer;
  border-radius: 6px;
  transition:
    color var(--px-dur-fast) var(--px-ease),
    background-color var(--px-dur) var(--px-ease);
}
.px-seg-btn:hover { color: var(--px-ink-2); }
.px-seg-btn[aria-selected='true'] { color: var(--px-ink); }
.px-seg-btn:focus-visible { outline: none; box-shadow: var(--px-ring); }

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
  padding: 8px 14px;
  /* 第二层中性面：让「面板头」与「面板内容」分开，而不是靠给每个面板配一种颜色。
     分隔线仍在，但它现在是**强化**而不是唯一的层级信号。 */
  background: var(--px-layer-2);
  border-bottom: 1px solid var(--px-line);
}
.px-panel-title { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 620; letter-spacing: 0.01em; color: var(--px-ink); }
.px-panel-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; opacity: 0.85; }
.px-tone-bg-blue { background: var(--px-tone-blue); }
.px-tone-bg-pink { background: var(--px-tone-pink); }
.px-tone-bg-green { background: var(--px-tone-green); }
.px-tone-bg-yellow { background: var(--px-tone-yellow); }
.px-tone-bg-purple { background: var(--px-tone-purple); }
.px-tone-bg-red { background: var(--px-tone-red); }
.px-panel-extra { font-size: 11.5px; color: var(--px-muted); }
/* 标题右侧的同排数字（消费趋势的合计）：比标题弱、比普通正文强，
   并与标题之间留一道竖线，说明「这是这句话的注脚」。 */
.px-panel-total {
  margin-left: 10px; padding-left: 10px;
  border-left: 1px solid var(--px-line-2);
  font-size: 11.5px; font-weight: 560; color: var(--px-ink-2);
  font-variant-numeric: tabular-nums;
}
/* 卡片头部的小开关（「我的单价」）：原生 checkbox + 文案，不做自绘开关——
   这类二级选项用系统控件最稳（键盘、读屏、深浅色都不用再管）。 */
.px-inline-toggle {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px; color: var(--px-muted);
  cursor: pointer; user-select: none;
}
.px-inline-toggle input { margin: 0; accent-color: var(--px-pink-deep); }
.px-inline-toggle:hover { color: var(--px-ink-2); }
/* ── 顶行的「用户卡」：官方账号头像 + 余额 + 官网入口 ────────────────
   它是概览行里的第五格，所以尺寸/圆角/阴影与 .px-stat 同族（不是又一种卡片）：
   同一行里出现两种卡片语言，读起来就像两块不同的东西。
   横向三段：头像 / 名称+金额 / 入口。金额与 .px-stat-value 同字号，形成一条基线。 */
.px-user {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px 11px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
  transition: box-shadow var(--px-dur) var(--px-ease), border-color var(--px-dur) var(--px-ease);
}
.px-user:hover { box-shadow: var(--px-elev-2); border-color: var(--px-line-2); }
.px-user-avatar {
  flex: none;
  position: relative;
  width: 34px; height: 34px;
  display: grid; place-items: center;
  border-radius: 10px;
  overflow: hidden;
  background: var(--px-whale-soft);
}
/* 真实头像：铺满底板，裁成同一圆角；失败时（img 被 display:none）下面的鲸鱼露出来。 */
.px-user-avatar > img {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
}
/* 未登录：底板退成中性层让「这是占位」可读，但**鲸鱼保持彩色**（用户要求不置灰）。 */
.px-user.off .px-user-avatar { background: var(--px-layer-2); }
.px-whale { display: block; }
.px-user-main { display: grid; gap: 2px; min-width: 0; flex: 1 1 auto; }
.px-user-name {
  font-size: 11px; font-weight: 560; color: var(--px-muted); letter-spacing: 0.06em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.px-user-contact { font-size: 10.5px; color: var(--px-muted); letter-spacing: 0.02em; }
/* 总余额：一个数字，与概览卡数值同字号同字重（同一条视觉基线）。 */
.px-user-amount { display: inline-flex; align-items: baseline; gap: 3px; font-variant-numeric: tabular-nums; min-width: 0; }
.px-user-amount > b {
  font-size: 24px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.1;
  color: var(--px-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 右侧一列：链接在上，角落小字（赠送金 · 累计消费）在下，右对齐。 */
.px-user-side {
  flex: none; display: grid; gap: 4px; justify-items: end; align-content: space-between;
  min-width: 0;
}
.px-user-corner {
  font-size: 10px; color: var(--px-muted); line-height: 1.3;
  text-align: right; font-variant-numeric: tabular-nums;
  max-width: 130px;
}
.px-user-state { font-size: 11.5px; color: var(--px-muted); line-height: 1.45; min-width: 0; }
.px-user-state.warn { color: var(--px-tone-red); }
.px-user-link {
  flex: none; align-self: flex-start;
  font-size: 11.5px; color: var(--px-ink-2);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: color var(--px-dur-fast) var(--px-ease), border-color var(--px-dur-fast) var(--px-ease);
}
.px-user-link:hover { color: var(--px-ink); border-bottom-color: var(--px-line-2); }
.px-user-link:focus-visible { outline: none; box-shadow: var(--px-ring); border-radius: var(--px-r-sm); }

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
  /* 小提示：透明 + 描边。铺米色会在标题行末尾多出一枚色块。 */
  background: transparent;
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
/* 概览卡：**中性**。
   早先每张卡顶部有一条不同颜色的渐变线 + 右上角一团彩色光晕（::before / ::after），
   四张卡就是四种颜色。用户的原话是「配色割裂」——强调色被当成了装饰。
   现在卡片只说数字：标签、数值、脚注三层字号拉开，颜色一律走墨色系；
   强调色只留给「当前状态 / 主操作」（分段选中、徽标、链接）。
   悬停只改描边与阴影，不做位移，避免一屏四个卡在鼠标扫过时此起彼伏。 */
.px-stat {
  position: relative;
  padding: 12px 14px 11px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
  transition: box-shadow var(--px-dur) var(--px-ease), border-color var(--px-dur) var(--px-ease);
}
.px-stat:hover { box-shadow: var(--px-elev-2); border-color: var(--px-line-2); }
.px-stat-label { font-size: 11px; font-weight: 560; color: var(--px-muted); letter-spacing: 0.06em; }
.px-stat-value {
  margin: 7px 0 6px;
  font-family: var(--px-num-font);
  font-size: 27px; line-height: 1.12; letter-spacing: -0.01em;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--px-ink);
}
.px-stat-foot { font-size: 11.5px; color: var(--px-muted); line-height: 1.65; }

/* 徽标：**透明底 + 描边**，不用实色底。
   它会被放进各种深浅不同的容器里（卡片、表头、奶油色的辅助块），实色底一旦
   与父级同色就等于消失——实测 .px-badge 落在 .px-notify-permission
   （同样是 surface-2）上时对比度是 **1.000**，整个徽标只剩文字浮着。
   透明底 + 描边在任何父级上都成立，且不参与「三层表面」的层次语义。
   注意本段在模板字符串里：注释中不能出现反引号（这个坑踩过两次）。 */
.px-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px;
  font-size: 11.5px; font-weight: 570;
  border-radius: var(--px-r-pill);
  background: transparent;
  color: var(--px-ink-2);
  border: 1px solid var(--px-line-2);
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
/* 团队标记：会话清单里标出「它属于/它就是一个智能体团队」。
   用紫色而不是粉/绿——后两者在这份界面里已经有含义（粉 = 高峰/选中，
   绿 = 空闲/正常），团队是另一种维度，混用会让人读成时段状态。 */
.px-badge.team {
  background: color-mix(in srgb, var(--px-purple) 34%, transparent);
  color: var(--px-tone-purple);
  border-color: color-mix(in srgb, var(--px-tone-purple) 28%, transparent);
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

/* 图例：**强制一行**。
   早先是 flex-wrap + 16px 间距，供应商一多就折成两行、而且条目之间空得很开
   （用户反馈「间隙有点大、最好一行显示完」）。现在不换行、间距收到 10px、
   字号小一档；放不下时横向滚动而不是折行（滚动条隐藏，但可滚）。 */
.px-legend {
  display: flex; flex-wrap: nowrap; align-items: center; gap: 10px;
  margin-top: 8px; font-size: 11.5px;
  overflow-x: auto; scrollbar-width: none;
}
.px-legend::-webkit-scrollbar { display: none; }
.px-legend-item { display: inline-flex; align-items: center; gap: 5px; color: var(--px-muted); white-space: nowrap; flex: none; }
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
.px-table th { font-size: 10.5px; font-weight: 600; color: var(--px-ink-2); background: var(--px-layer-2); letter-spacing: 0.08em; }
/* 表头下沿压一档：数据行与表头的分界靠这条线，不靠底色——单靠底色时
   用户的原话是「表头和背景色一样」，层次根本没立起来。 */
.px-table thead th { border-bottom: 1px solid var(--px-line-2); }
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
/* **不要**把 display:flex 加在 td 上：td 一旦脱离表格布局，
   该列的剩余宽度就不再被它占据，于是展开行的粉色底只铺到文字处，
   右侧露出一块刺眼的白（用户报的「条目里缺一块」就是它）。
   正确做法是 td 保持表格单元格，flex 放进内层 div。 */
.px-session-cell-inner {
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
  background: transparent;
  border: 1px solid var(--px-line);
  white-space: nowrap;
}
.px-session-id {
  /* 会话 id 仍然可查（悬停 title 可复制），但排在标题之后、视觉上退到最末 */
  color: var(--px-muted);
  white-space: nowrap;
}

/* 可点的标题：点它跳到那条会话。用下划线提示「这里是一个动作」，
   靠 hover 变色确认，而不是整行变色——整行点的是「展开」。 */
.px-session-link { cursor: pointer; }
.px-session-link:hover { text-decoration: underline; text-underline-offset: 2px; }
.px-session-link:focus-visible {
  outline: 2px solid var(--px-accent);
  outline-offset: 2px;
  border-radius: 3px;
}
.px-session-row { cursor: pointer; }
/* 展开状态：**不铺底色**——详情区本身已经是一块内容区，整行再加底色会叠成
   两层色块（正是用户说的「东一块西一块」）。改用左侧色条 + 标题加粗。 */
.px-session-row-open > td:first-child {
  box-shadow: inset 3px 0 0 var(--px-accent);
}
.px-session-when { color: var(--px-muted); white-space: nowrap; }

/* ============================================================
   会话详情的视觉设计（第二轮重做）

   用户对上一版的评价是「底色还是很丑、没有视觉重点、看不出收起展开」。
   因此这一版按三条重来：

   1) **白 + 粉**：详情区底色用白色（与页面唯一的「块」一致），
      只在顶部叠一层极淡的粉色晕染作为「这是同一行的延续」的信号；
      强调色统一用马卡龙粉（--px-pink-deep），不再铺奶油色底。
   2) **层级靠字号与留白**：四个主打指标（金额/Token/时长/工具）用大号数字，
      其余明细是安静的标签-值行——上一版把所有数字做成同样大小，所以没有落点。
   3) **状态可发现**：行首折叠箭头（▸/▾）表达「能点」，hover 换底色；
      团队用标签页切换成员，不再拆成多行。
   ============================================================ */

/* 行首折叠箭头：可发现性的唯一落点，给了明确的 12px 槽位与转动动画。 */
.px-session-chev { width: 18px; padding-right: 0 !important; }
.px-chev {
  display: inline-block;
  color: var(--px-muted);
  font-size: 10px; line-height: 1;
  transition: transform var(--px-dur) var(--px-ease), color var(--px-dur) var(--px-ease);
}
.px-chev-open { transform: rotate(90deg); color: var(--px-detail-accent); }
.px-session-row:hover .px-chev { color: var(--px-detail-accent); }

/* 行 hover：告诉用户整行可点。展开行用左侧粉色条标出位置，
   不铺底色（铺了会与详情区叠成两层色块）。 */
.px-session-row { cursor: pointer; transition: background var(--px-dur) var(--px-ease); }
.px-session-row:hover > td { background: var(--px-hover, rgba(0, 0, 0, .02)); }
/* 展开行：整行铺**淡强调色**。同一时刻只展开一行，所以不会出现满屏碎色块；
   用底色而不是只画侧条，是因为用户明确要「区分其他收起态的条目」。 */
.px-session-row-open > td { background: var(--px-detail-accent-soft); }
.px-session-row-open > td:first-child { box-shadow: inset 3px 0 0 var(--px-detail-accent); }
.px-session-when { color: var(--px-muted); white-space: nowrap; }

/* ── 详情容器：白底 + 顶部粉色晕染 ─────────────────────────────── */
.px-session-detail-row > td { padding: 0; border-top: 0; }
.px-session-detail {
  padding: 16px 18px 18px;
  background:
    linear-gradient(180deg, var(--px-detail-accent-soft) 0, transparent 120px),
    var(--px-surface);
  /* **不要 border-top**（用户：条目与详情之间那条黑线去掉）：上一行的粉色底
     已经把两者分开了，再压一条实边会变成一道生硬的缝。 */
  border-left: 3px solid var(--px-detail-accent);
}

/* ── 成员标签页 ───────────────────────────────────────────────── */
.px-dtabs {
  display: flex; gap: 6px; flex-wrap: wrap;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--px-line);
}
.px-dtab {
  appearance: none;
  padding: 5px 12px;
  font: inherit; font-size: 12px; font-weight: 550;
  color: var(--px-ink-2);
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-pill);
  cursor: pointer;
  transition: all var(--px-dur) var(--px-ease);
}
.px-dtab:hover { border-color: var(--px-detail-accent-line); color: var(--px-detail-accent); }
.px-dtab-on {
  color: var(--px-detail-accent);
  background: var(--px-detail-accent-soft);
  border-color: var(--px-detail-accent-line);
  font-weight: 650;
}

/* ── 四个主打指标：第一眼的落点 ───────────────────────────────── */
.px-heroes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.px-hero {
  display: flex; flex-direction: column; gap: 3px;
  padding: 11px 13px 10px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-left: 3px solid var(--px-accent);
  border-radius: var(--px-r-md);
  box-shadow: var(--px-elev-1);
  min-width: 0;
  --px-accent: var(--px-detail-accent);
}
.px-hero-accent { --px-accent: var(--px-detail-accent); }
.px-hero-blue { --px-accent: var(--px-tone-blue); }
.px-hero-green { --px-accent: var(--px-tone-green); }
.px-hero-purple { --px-accent: var(--px-tone-purple); }
.px-hero-label {
  font-size: 11px; font-weight: 550; color: var(--px-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.px-hero-value {
  font-family: var(--px-num-font);
  font-size: 23px; line-height: 1.15; letter-spacing: .3px;
  font-variant-numeric: tabular-nums;
  color: var(--px-ink);
}
.px-hero-foot {
  font-size: 10.5px; color: var(--px-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}


/* ── 两栏明细：安静的标签-值行，靠虚线分隔而不是每项一张卡 ───────── */
.px-dcols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(270px, 1fr));
  gap: 6px 28px;
  margin-bottom: 14px;
}
.px-dcol { min-width: 0; }
.px-dcol-title {
  display: block; margin-bottom: 6px;
  font-size: 11px; font-weight: 650; letter-spacing: .05em;
  color: var(--px-muted);
}
.px-drow {
  display: flex; align-items: baseline; justify-content: space-between; gap: 14px;
  padding: 5px 0;
  border-bottom: 1px dashed var(--px-line);
  font-size: 12px;
}
.px-drow:last-child { border-bottom: 0; }
.px-drow-label {
  display: flex; align-items: center; gap: 7px;
  color: var(--px-muted);
  min-width: 0;
}
.px-drow-value {
  font-family: var(--px-num-font);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--px-ink);
  text-align: right;
  word-break: break-word;
}
/* 语义色点：与 hero 的色条同一套颜色，于是「这数属于哪类」不用读文字 */
.px-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.px-dot-pink { background: var(--px-pink); }
.px-dot-blue { background: var(--px-tone-blue); }
.px-dot-green { background: var(--px-tone-green); }
.px-dot-purple { background: var(--px-tone-purple); }
.px-dot-yellow { background: var(--px-tone-yellow); }
.px-dot-accent { background: var(--px-detail-accent); }

/* ── 峰时/闲时：两段都画出来，两端百分比上色 ──────────────────── */
.px-dpeak { max-width: 520px; }
.px-dpeak-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  margin-bottom: 7px;
}
.px-dpeak-split { display: flex; gap: 12px; font-size: 11.5px; }
.px-peak-bar {
  display: flex;
  height: 10px; border-radius: var(--px-r-pill);
  background: var(--px-surface-2);
  border: 1px solid var(--px-line);
  overflow: hidden;
}
.px-peak-fill {
  display: block; height: 100%;
  background: linear-gradient(90deg, var(--px-yellow-deep), var(--px-yellow));
  transition: width .25s var(--px-ease);
}
.px-peak-rest { display: block; flex: 1; height: 100%; background: var(--px-tone-blue); opacity: .22; }
.px-peak-peak { color: var(--px-yellow-deep); font-weight: 600; }
.px-peak-idle { color: var(--px-tone-blue); font-weight: 600; }



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
  /* 两张趋势卡**等高**（用户要求）。两张图都是固定 240px 高，等高靠 stretch
     把卡片拉到同一底边；图本身高度一致，所以看起来是齐的。 */
  align-items: stretch;
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
   宽度（"周一至周五（不含法定节假日）09:00–12:00、14:00–18:00" 这行本身就要 340px 左右），
   余下全部让给日历，格子才不至于缩到看不清。
   用 minmax(fr) 而不是固定 px：窄屏时两栏等比收缩，且左栏有 280px 下限兜底。 */
.px-pair {
  display: grid;
  grid-template-columns: minmax(280px, 0.6fr) minmax(0, 1.4fr);
  gap: 12px;
  /* 两张卡**等高**（用户要求）：左栏内容少，按内容高度会把底边留在半空，
     与右边那张日历卡参差不齐。stretch 让两张卡一起到底部线对齐。 */
  align-items: stretch;
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
  /* 单价行是**卡片里的列表行**，不是独立的块：不铺底色，只靠行间距分隔。
     早先铺 surface-2，一张卡片里会因此出现一排米色横条——正是「东一块西一块」。 */
  background: transparent;
  font-size: 11.5px; color: var(--px-muted);
}
/* 隔行轻微着色用来跟读；它必须极淡，否则又变成「色块」 */
.px-rate:nth-child(even) { background: color-mix(in srgb, var(--px-ink) 3%, transparent); }
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
/* 单价编辑器的样式已搬到 styles/pricing.js（v3：编辑器从看板正文移进设置弹层）。
   这里**不要**再写 .px-price-editor / .px-price-form / .px-price-actions 一类规则——
   那几块 UI 现在只由 pricing 那一张表负责，两边各写一份迟早会漂移。 */
.px-balance-state.px-ok {
  background: color-mix(in srgb, var(--px-tone-green) 20%, var(--px-surface-2));
  color: var(--px-ink-2);
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
  transition:
    border-color var(--px-dur) var(--px-ease),
    box-shadow var(--px-dur) var(--px-ease),
    background-color var(--px-dur) var(--px-ease);
}
.px-input:disabled { opacity: 0.55; }
/* 输入框的焦点环同样要自己给（全局那条随 SKIN 删了）：原来那圈 outline 是
   产品默认样式，在暗色底下几乎看不见。 */
.px-input:focus-visible { outline: none; border-color: var(--px-pink-deep); box-shadow: var(--px-ring); }
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
   conversation.composer.dock 是**横向 flex 行**（.dock：display:flex +
   justify-content:center + gap:12px），我们是这行里的**一项**，因此这一层只做
   inline-flex、按内容取宽，绝不占满整行。
   占满整行会与官方胶囊抢宽度，把「1 轮 · 38 步」「2.1M tok」挤成省略号——那正是
   用户截图反馈的现象。旧版这里写作 width:100%（还带左右内边距），前提是「容器为
   纵向 flex 且没有 gap」——那是 .root 的样式，不是 .dock 的，属于认错了容器。
   两种落位共用这一层：
     · 旧契约（DSH ≤ 0.2.0-rc.2）portal 进官方统计容器，追加为末子节点 → 官方右边；
     · 新契约（DSH ≥ 0.2.1-alpha.1）作为槽位项，靠 order 排在官方胶囊之后 → 官方右边。 */
.px-pill-group {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
  max-width: 100%;
  min-width: 0;
  /* 字号必须自己定：.px-pill 用 font: inherit，而 dock 那一行没有自己的字号。
     旧版这一点由 .px-cost-row 提供，它被本层取代后要照旧带上，否则徽标会跟着
     产品外壳的字号走，和官方胶囊并排时大小不一致。 */
  font-size: var(--dsh-content-font-size-secondary, 13px);
}

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
  /* 与详情面板里的角标同一处修正：淡黄底上的 10px 文字必须用 --px-ink。
     原来写 --px-tone-yellow，实测对比度只有约 2.6:1——「估算」两个字在浅色下
     基本读不出来，而它是「这个数字不是精确值」的唯一提示。 */
  background: color-mix(in srgb, var(--px-yellow) 45%, transparent);
  color: var(--px-ink);
  font-size: 10px; font-weight: 600;
  line-height: 1.6;
}
/* 拿不到费用时的告警态：不要在界面上装作一切正常 */
.px-pill-warn { background: color-mix(in srgb, var(--px-red) 14%, transparent); }
.px-pill-warn .px-pill-dot { background: var(--px-tone-red); }
.px-pill-warn .px-pill-value { color: var(--px-tone-red); }

/* 可点击的那一枚：详情面板的入口。
   它必须是 <button> 而不是带 onClick 的 <span>——键盘用户要能 Tab 上来按回车，
   读屏软件要能播报「可展开」。因此这里要把浏览器按钮的默认外观全部清掉，
   否则 dock 里会冒出一个灰底描边的方盒，与旁边两枚胶囊完全不是一套东西。
   小三角是唯一的可见提示：不带它，用户不知道这一枚与旁边那两枚**行为不同**。 */
.px-pill-button {
  appearance: none;
  font: inherit;
  cursor: pointer;
  /* tailwind/normalize 之类会把 button 的字色重置掉，这里显式接回来 */
  color: var(--px-label-tertiary);
}
.px-pill-button:focus-visible {
  outline: none;
  box-shadow: var(--px-ring);
}
.px-pill-button[aria-expanded='true'] {
  background: color-mix(in srgb, var(--px-ink) 9%, transparent);
}
.px-pill-caret {
  width: 0; height: 0; flex: none;
  margin-left: 1px;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  /* 收起时朝上（面板在**上方**弹出），展开后翻过来朝下 */
  border-bottom: 5px solid currentColor;
  opacity: 0.62;
  transition: transform var(--px-dur-fast) var(--px-ease);
}
.px-pill-button[aria-expanded='true'] .px-pill-caret { transform: rotate(180deg); }

/* ── 费用详情面板（点开费用徽标后弹在它上方）──────────────────────
   之前这块信息全塞在 title 属性里，落地成一个**裸的系统浮窗**：字号跟操作系统走、
   换行由浏览器决定、配色不听产品的深浅色、鼠标一移开就消失，而且没法点击。
   用户的原话是「现在直接是一个裸文本浮窗，不好看」。

   这不是看板的一部分，所以它**不能**套 .px-panel：那个是「页面里的卡片」，
   有 12px 外边距与 hover 抬升；这里是一个浮层，位置由 JS 算、宽度按内容取。

   ## 底色为什么走 --px-surface 而不是 --px-bg
   面板浮在**产品自己的输入框区域**上方，背景是产品的底色（深浅都有可能），
   而 .px-toast 已经在用 --px-surface 做同一件事：浮层要自己是一块干净的表面，
   不能指望底下的颜色与看板页面一致。 */
.px-detail-anchor {
  /* 定位与宽度由 panelStyle() 以内联样式给出（它要量锚点矩形）；
     这里只兜住「JS 没给样式时也不塌成 0 宽」。 */
  z-index: 2147483000;
  max-width: calc(100vw - 24px);
}
.px-detail {
  --px-accent: var(--px-tone-pink);
  box-sizing: border-box;
  padding: 13px 14px 12px;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-lg);
  background: var(--px-surface);
  box-shadow: var(--px-elev-3);
  color: var(--px-ink-2);
  font-family: var(--px-ui-font);
  font-size: 12px;
  line-height: 1.55;
  font-variant-numeric: tabular-nums;
  animation: px-detail-in var(--px-dur) var(--px-ease-out);
  /* 浮层里的文字可以被选中复制（金额常要贴到别处），但拖选不该把后面的产品
     界面一起带上——user-select: text 明确允许本层内部选中。 */
  user-select: text;
}
.px-detail * { box-sizing: border-box; }
.px-detail-tone-purple { --px-accent: var(--px-tone-purple); }
.px-detail-tone-red { --px-accent: var(--px-tone-red); }

/* 抬头：色点 + 标题 + 「估算」角标 + 右侧大号金额。
   大号金额与标题同一行：面板不宽，另起一行会让第一屏只剩一个数字。 */
.px-detail-head {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding-bottom: 9px;
  border-bottom: 1px solid var(--px-line);
}
.px-detail-mark {
  align-self: center;
  width: 7px; height: 7px; flex: none;
  border-radius: 50%;
  background: var(--px-accent);
}
.px-detail-title { color: var(--px-ink); font-size: 12.5px; font-weight: 620; }
.px-detail-badge {
  align-self: center;
  padding: 0 5px;
  border-radius: var(--px-r-pill);
  /* 角标底色是淡黄强调，文字必须**足够深**。
     实测过：原来写 color: var(--px-tone-yellow)（#c99a2e）落在淡黄底上，
     对比度只有 2.58:1——版式审计直接把这一条判红，而肉眼在浅色下确实读不清
     那个 10px 的「估算」。改成 --px-ink（墨色），它是深浅两套各自定义过的，
     在淡黄底上成立，在深色模式下也成立。 */
  background: color-mix(in srgb, var(--px-yellow) 45%, transparent);
  color: var(--px-ink);
  font-size: 10px; font-weight: 600; line-height: 1.6;
}
.px-detail-headline {
  margin-left: auto;
  color: var(--px-ink);
  font-size: 15px; font-weight: 650;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

/* 分节：每节一个抬头，节与节之间用极淡的分隔线，不加底色。
   「白块里再嵌色块」正是用户报过的「东一块西一块」，浮层里尤其明显。 */
.px-detail-section { padding-top: 9px; }
.px-detail-section + .px-detail-section { margin-top: 9px; border-top: 1px dashed var(--px-line); }
.px-detail-section-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 5px;
}
.px-detail-section-label {
  color: var(--px-detail-label);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.px-detail-section-total {
  margin-left: auto;
  color: var(--px-ink-2);
  font-size: 11.5px; font-weight: 600;
}

/* 一行：标签 | 占比条 | 数值。
   占比条那一列**固定宽度并允许为空**：各行的数值因此左边缘对齐，
   而「用量构成」那几行没有比例可画，留白比让数值左右跳整齐得多。 */
.px-detail-rows { display: grid; gap: 4px; }
.px-detail-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 54px minmax(52px, auto);
  align-items: center;
  gap: 8px;
}
.px-detail-row-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--px-detail-label);
}
.px-detail-row-meter { display: flex; align-items: center; }
.px-detail-row-value {
  color: var(--px-ink);
  font-weight: 570;
  text-align: right;
  white-space: nowrap;
}
/* 占比条轨道用**描边色**而不是 --px-surface-2：面板本身已经是白「块」，
   再铺一块米色轨道就是「白块里嵌色块」。这条与看板那条「谁在铺次级底色」
   的白名单闸门是同一条规则，因此刻意不进白名单。 */
.px-detail-meter {
  display: block;
  width: 100%;
  height: 4px;
  border-radius: var(--px-r-pill);
  background: var(--px-line);
  overflow: hidden;
}
.px-detail-meter-fill {
  display: block;
  height: 100%;
  border-radius: var(--px-r-pill);
  transition: width var(--px-dur-slow) var(--px-ease-out);
}
.px-detail-tone-bg-blue { background: var(--px-tone-blue); }
.px-detail-tone-bg-pink { background: var(--px-tone-pink); }
.px-detail-tone-bg-green { background: var(--px-tone-green); }
.px-detail-tone-bg-yellow { background: var(--px-tone-yellow); }
.px-detail-tone-bg-purple { background: var(--px-tone-purple); }
.px-detail-tone-bg-red { background: var(--px-tone-red); }

/* 脚注：口径说明。字号再小一号、颜色再淡一档——它是「读到了才安心」的内容，
   不该与数字抢注意力，但也不能省（省掉用户会以为金额就是账单）。 */
.px-detail-notes {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid var(--px-line);
  color: var(--px-detail-label);
  font-size: 11px;
  line-height: 1.6;
}
.px-detail-notes p { margin: 0; }
.px-detail-notes p + p { margin-top: 4px; }
@keyframes px-detail-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ── 侧栏「用量看板」行上的时段倒计时 ────────────────────────────
   一行文字，用颜色区分时期：
     高峰中（红）→ 2时15分后空闲期
     空闲中（绿）→ 空闲期剩2时15分

   刻意**没有环形进度**：那枚环要「已走 ÷ 总长」，而各段长度差几十倍
   （午休 2 小时、周末 63 小时，春节那种长连休 255 小时），环在长段里几乎不动，
   看起来像坏了。
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
  /* 卡片里的一行「倒计时」，不该是一块米色：改成极淡的着色底，
     只为把这一行与上面的标题分开，仍读作「同一张卡片里的内容」。 */
  background: color-mix(in srgb, var(--px-ink) 4%, transparent);
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
  /* 一行状态说明，不是一块卡片：描边 + 透明底，放在白卡片里不抢眼。 */
  background: transparent;
  border: 1px solid var(--px-line);
  font-size: 11.5px; line-height: 1.6; color: var(--px-muted);
}
/* 两个异常态才上色：正常态保持安静，异常才需要被看见。 */
.px-balance-state.px-warn {
  background: color-mix(in srgb, var(--px-yellow) 20%, transparent);
  border-color: color-mix(in srgb, var(--px-yellow) 40%, var(--px-line));
  color: var(--px-ink-2);
}
.px-balance-state.px-error {
  background: color-mix(in srgb, var(--px-red) 16%, transparent);
  border-color: color-mix(in srgb, var(--px-red) 38%, var(--px-line));
  color: var(--px-ink-2);
}
.px-balance-privacy {
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px dashed var(--px-line-2);
  font-size: 11px; line-height: 1.7; color: var(--px-muted);
}
.px-balance-state.px-off { background: transparent; color: var(--px-muted); }

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
  /* 一家一块：靠**描边**分块，不铺底色。卡片里再套一片米色块，
     是最典型的「东一块西一块」来源——白卡片里浮着一排米色方块。 */
  background: transparent;
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
  /* 折叠的「怎么配」说明：描边即可，不铺底色（它已在一个有描边的块里）。 */
  background: transparent;
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

/* 「移除套餐凭据」：破坏性动作，因此整块折进 details 且默认收起。
   危险色只用在「移除」按钮与确认态上——满屏红字会让真正的警告失效。 */
.px-cred-details { margin-top: 10px; }
.px-cred { margin-top: 10px; }
.px-cred-head {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  margin-bottom: 6px;
}
.px-cred-head > b { font-size: 13px; font-weight: 620; color: var(--px-ink); }
.px-cred-head .px-muted { margin: 0; }
.px-cred-intro { margin: 0 0 10px; font-size: 11.5px; line-height: 1.75; color: var(--px-muted); }
.px-cred-intro code {
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-ink-2);
}
.px-cred-note { margin: 0 0 10px; font-size: 11.5px; line-height: 1.7; }
.px-cred-vendors { display: grid; gap: 10px; }
.px-cred-vendor {
  padding: 8px 11px;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-sm);
  background: transparent;
}
.px-cred-vendor-name {
  display: block; margin-bottom: 5px;
  font-size: 12px; font-weight: 620; color: var(--px-ink);
}
.px-cred-list { margin: 0; padding: 0; list-style: none; }
/* 一行一条引用名。用 grid 让「勾选框 + 名字」对齐，说明文字跟在后面，
   窄屏时允许换行而不是把名字截断。 */
.px-cred-row {
  display: grid;
  grid-template-columns: auto auto auto auto 1fr;
  align-items: baseline;
  gap: 4px 8px;
  padding: 3px 0;
  font-size: 11.5px;
}
.px-cred-row.locked { opacity: 0.75; }
.px-cred-pick { display: inline-flex; align-items: baseline; gap: 6px; }
.px-cred-pick input { margin: 0; cursor: pointer; }
.px-cred-pick input:disabled { cursor: not-allowed; }
.px-cred-name {
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-ink);
  word-break: break-all;
}
.px-cred-hint { font-family: var(--px-num-font); font-size: 11px; color: var(--px-muted); }
.px-cred-source { font-size: 11px; color: var(--px-muted); }
.px-cred-purpose { font-size: 11px; color: var(--px-muted); }
/* 「这一条插件改不了」的原因与出路：必须与可勾选的行**看得出区别**，
   否则用户会反复去点那个禁用的勾选框。 */
.px-cred-blocked {
  grid-column: 1 / -1;
  font-size: 11px; line-height: 1.7;
  color: var(--px-tone-yellow);
}
.px-cred-cli {
  margin: 7px 0 0; padding-top: 6px;
  border-top: 1px dashed var(--px-line-2);
  font-size: 11px; line-height: 1.7; color: var(--px-muted);
}
.px-cred-cli code {
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-ink-2);
  word-break: break-all;
}
.px-cred-results {
  margin-top: 10px; padding: 8px 11px;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-sm);
  background: var(--px-surface);
  font-size: 11.5px;
}
.px-cred-results > b { display: block; margin-bottom: 5px; color: var(--px-ink); }
.px-cred-results ul { margin: 0; padding-left: 16px; list-style: none; }
.px-cred-results li { margin-bottom: 3px; line-height: 1.7; }
.px-cred-results li.ok code { color: var(--px-tone-green); }
.px-cred-results li.bad code { color: var(--px-tone-red); }
.px-cred-results code {
  font-family: var(--px-num-font);
  font-size: 11px; margin-right: 6px;
}
.px-cred-results li.bad span { color: var(--px-tone-red); }
/* 二次确认：与上面的清单**视觉上分开**（边框 + 底色），让「现在按下去就会删」
   这件事一眼可辨，而不是和普通说明混在一起。 */
.px-cred-confirm {
  margin-top: 10px; padding: 9px 11px;
  border: 1px solid var(--px-tone-red);
  border-radius: var(--px-r-sm);
  background: var(--px-surface);
}
.px-cred-confirm > p { margin: 0 0 6px; font-size: 11.5px; line-height: 1.7; color: var(--px-ink); }
.px-cred-confirm ul { margin: 0; padding-left: 16px; list-style: none; }
.px-cred-confirm li { margin-bottom: 3px; font-size: 11.5px; }
.px-cred-confirm code {
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-ink);
}
.px-cred-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 9px; }

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
.px-plan-chip:hover { background: color-mix(in srgb, var(--px-ink) 7%, transparent); }
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
  background: transparent;
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

/* 余额 / 套餐额度阈值那一组样式已删除（v3：预警能力整体取消，余额改在
   会话标签页与费用条里直接看）。不要加回来——那套 UI 背后是一条每分钟轮询、
   边沿触发、还要用户维护阈值的通知链，正是被取消的东西。 */

.px-notify-inputs { display: flex; align-items: center; gap: 10px 16px; flex-wrap: wrap; }
.px-notify-input {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 12.5px; color: var(--px-ink-2);
}
/* 阈值输入框。圆角与过渡原本由 SKIN 的全局 button/input 规则统一给，皮肤删掉后
   必须在这里自己写——否则这几个框会变成直角，跟旁边同样走 --px-r-sm 的
   .px-input 摆在一起明显不一致。选择器仍以 .px-* 开头，不外溢到产品界面。 */
.px-notify-input input {
  width: 84px;
  padding: 5px 8px;
  font-family: var(--px-num-font);
  font-size: 12.5px;
  color: var(--px-ink);
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-sm);
  transition:
    border-color var(--px-dur) var(--px-ease),
    box-shadow var(--px-dur) var(--px-ease);
}
.px-notify-input input:focus-visible {
  outline: none; border-color: var(--px-pink-deep); box-shadow: var(--px-ring);
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
/* 子智能体进展：**有意的弱一档**。它不用任何语义色（绿=完成、黄=待办、红=失败），
   只用描边色，于是它与「主会话完成」在页面上不会混成同一类事。 */
.px-toast-progress { border-left: 3px solid var(--px-line-2); }
/* 可点的提示条（带着会话 id 的那些）：点一下切到那条会话。
   容器是 pointer-events: none（让提示条不挡住它下面的产品界面），所以这里必须
   把它**单独**开回来，否则整条提示条都收不到点击——点了没反应，而没有任何报错。 */
.px-toast-clickable {
  pointer-events: auto;
  cursor: pointer;
  transition: background-color var(--px-dur-fast) var(--px-ease);
}
.px-toast-clickable:hover { background: color-mix(in srgb, var(--px-ink) 7%, transparent); }
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
  /* 阈值那一组已随预警能力删除，窄屏不再需要为它写媒体查询。 */
  .px-model-grid { grid-template-columns: 1fr; justify-items: center; }
  .px-root { padding: 14px 14px 40px; }
  .px-topbar { margin: -14px -14px 16px; padding: 12px 14px; top: -14px; }
}

/* 降级动效：**只作用在插件自己的元素上**。
   早先这条选择器写的是全局通配符（随 SKIN 一起删了）——那会连产品自己的动画一起
   关掉，而用户可能正依赖产品的某个过渡来理解状态变化。这里一律走 .px-*，
   于是系统开了「减少动态效果」时只有本插件的动效被压到 1ms。 */
@media (prefers-reduced-motion: reduce) {
  .px-root *, .px-toast, .px-pill, .px-detail, .px-period-inline {
    animation-duration: 1ms !important;
    transition-duration: 1ms !important;
  }
}

/* ── 展开/收起过渡 ───────────────────────────────────────────────────
   详情行只在展开时渲染（条件渲染），所以这里做的是**入场动画**：
   淡入 + 轻微上移。比高度动画更稳——详情内容由异步数据驱动，
   测量高度往往拿到 0，硬做 height 过渡会跳。
   220ms + 项目既有 --px-ease，与其它交互的手感一致。 */
.px-session-detail-row > td { padding: 0; border: 0; }
.px-session-detail {
  animation: px-detail-in 220ms var(--px-ease) both;
}
@keyframes px-detail-in {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: none; }
}



/* ── 耗时构成：横向堆叠条 + 图例 ─────────────────────────────────────
   上一版是环形图，用户明确说不喜欢——环形要顺着弧长目测比例，读数成本高。
   换成一条横向堆叠条：谁占得多一眼可见，且与「请求分布」那条同一种语言。
   布局是三段式：左端总时长锚点 / 中间堆叠条 / 下方图例。 */
.px-timing {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 6px 20px;
  align-items: center;
  padding: 14px 16px;
  margin-bottom: 14px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
}
@media (max-width: 560px) {
  /* 窄屏：总时长与条上下排，否则条会被压得没法读比例。 */
  .px-timing { grid-template-columns: 1fr; }
}
.px-timing-total {
  display: flex; flex-direction: column; gap: 1px;
  min-width: 108px;
}
.px-timing-total b {
  font-family: var(--px-num-font);
  font-size: 22px; line-height: 1.15; letter-spacing: .3px;
  font-variant-numeric: tabular-nums;
  color: var(--px-ink);
}
.px-timing-total span { font-size: 10.5px; color: var(--px-muted); }
.px-timing-avg { font-variant-numeric: tabular-nums; }
.px-timing-main { min-width: 0; }
.px-timing-bar {
  display: flex;
  height: 12px;
  border-radius: var(--px-r-pill);
  overflow: hidden;
  background: var(--px-surface-2);
  border: 1px solid var(--px-line);
}
.px-timing-seg { display: block; height: 100%; }
.px-timing-seg-yellow { background: var(--px-yellow); }
.px-timing-seg-blue { background: var(--px-tone-blue); }
.px-timing-seg-green { background: var(--px-tone-green); }
.px-timing-legend {
  display: flex; flex-wrap: wrap; gap: 6px 18px;
  margin-top: 8px;
}
.px-timing-item {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px;
}
.px-timing-item-name { color: var(--px-ink-2); }
.px-timing-item-pct {
  font-family: var(--px-num-font);
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  color: var(--px-ink);
}
.px-timing-item-ms {
  font-family: var(--px-num-font);
  font-variant-numeric: tabular-nums;
  color: var(--px-muted);
}
/* 三段各自的色点：与堆叠条同色，于是「哪一段对应哪一行」不用配对读。 */
.px-tdot { width: 7px; height: 7px; border-radius: 2px; flex: none; }
.px-tdot-yellow { background: var(--px-yellow); }
.px-tdot-blue { background: var(--px-tone-blue); }
.px-tdot-green { background: var(--px-tone-green); }
.px-timing-note {
  margin: 7px 0 0;
  font-size: 10.5px; line-height: 1.5;
  color: var(--px-muted);
}
/* 空态：没有 step 计时时给一句解释，而不是留一块空白。 */
.px-timing-empty {
  display: block;
  padding: 12px 16px;
}
.px-timing-empty-title {
  display: block; margin-bottom: 3px;
  font-size: 11px; font-weight: 650; color: var(--px-muted);
}

/* ════════════════════════════════════════════════════════════════════
   设置弹层（通知 / 单价 / 显示）
   ════════════════════════════════════════════════════════════════════
   遮罩与面板都挂在 body 上（不是 .px-root 里），因此这里的样式一律以
   .px-modal 开头，不与看板其它块共享选择器。

   浅色下的规则与别处一致：**白色是唯一的块**——面板铺 --px-surface，
   页签条与关闭按钮都是透明底 + 描边，不用米色填任何一块。 */
.px-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 2147482000;
  display: grid;
  place-items: center;
  padding: 24px;
  /* 遮罩只能用黑色半透明：它要压暗**产品自己的界面**，而 --px-ink 在深色下是浅色，
     拿它调透明度会得到一个「白色的遮罩」，整个界面反而更亮。 */
  background: rgba(12, 10, 18, 0.38);
  animation: px-fade var(--px-dur) var(--px-ease) both;
}
/* 深色下页面本身就暗，遮罩要压得更实才看得出「弹层浮在上面」。
   这里读的是产品打在 body 上的属性（只看不写），不是改产品配色。 */
body[data-ds-dark-theme] .px-modal-mask { background: rgba(0, 0, 0, 0.58); }
.px-modal {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  max-height: min(78vh, 760px);
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-3);
  animation: px-rise var(--px-dur-slow) var(--px-ease-out) both;
  outline: none;
}
.px-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--px-line);
}
.px-modal-title { font-size: 14px; font-weight: 650; color: var(--px-ink); }
.px-modal-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 12px 0;
  border-bottom: 1px solid var(--px-line);
}
.px-modal-tab {
  padding: 7px 13px;
  font-size: 12.5px;
  color: var(--px-muted);
  background: transparent;
  /* 只留描边不留底色：选中与未选中的差别是「描边 + 文字色」，不是色块。 */
  border: 1px solid transparent;
  border-bottom: 2px solid transparent;
  border-radius: var(--px-r-sm) var(--px-r-sm) 0 0;
  cursor: pointer;
  transition: color var(--px-dur-fast) var(--px-ease), border-color var(--px-dur-fast) var(--px-ease);
}
.px-modal-tab:hover { color: var(--px-ink); }
.px-modal-tab-on {
  color: var(--px-ink);
  font-weight: 620;
  border-bottom-color: var(--px-detail-accent);
}
.px-modal-tab:focus-visible { outline: none; box-shadow: var(--px-ring); }
.px-modal-body {
  padding: 14px 16px 18px;
  overflow-y: auto;
}

/* 显示偏好的每一行：标签 + 控件一行，说明另起一行铺满 */
.px-prefs { display: grid; gap: 16px; }
.px-pref {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px 12px;
}
.px-pref-label { font-size: 12.5px; font-weight: 560; color: var(--px-ink); }
.px-pref-control { display: inline-flex; align-items: center; gap: 7px; }
.px-pref-input { width: 104px; }
.px-pref-select { min-width: 120px; }
.px-pref-hint {
  grid-column: 1 / -1;
  font-size: 11px;
  line-height: 1.55;
  color: var(--px-muted);
}

/* ════════════════════════════════════════════════════════════════════
   模型分布 ＋ 费用明细：卡片组与共用工具条
   ════════════════════════════════════════════════════════════════════ */
.px-model-group { margin-bottom: 12px; }
.px-model-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-bottom: 10px;
  font-size: 11.5px;
  color: var(--px-muted);
}
.px-model-bar-hint { color: var(--px-label-tertiary); }
/* 合计与窗口的关系：一行小字，安静地贴在表下 */
.px-model-sum {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--px-muted);
  font-variant-numeric: tabular-nums;
}
/* 顶栏的「设置」：与刷新同一档按钮，只是不需要额外配色 */
.px-settings-btn { margin-left: 2px; }

/* ════════════════════════════════════════════════════════════════════
   消费 Top 会话：精简表（会话名 / 花费 / token / 最后活跃）
   ════════════════════════════════════════════════════════════════════ */
.px-top-session-table { table-layout: auto; }
.px-top-session-row { cursor: pointer; }
/* 展开态：整行提亮一档（层次层而不是彩色），并给左侧一道 2px 强调边——
   这是「当前展开的是哪一条」的唯一信号；不用彩色块（那会与表头抢层级）。 */
.px-top-session-row.open { background: var(--px-layer-2); }
.px-top-session-row.open > td:first-child { box-shadow: inset 2px 0 0 var(--px-pink-deep); }
.px-top-session-detail-row > td {
  padding: 10px 14px 12px;
  background: var(--px-layer-2);
  border-bottom: 1px solid var(--px-line-2);
  white-space: normal;
}
.px-top-detail { display: grid; gap: 8px; }
.px-top-detail-sum { display: flex; flex-wrap: wrap; gap: 16px; font-size: 11.5px; color: var(--px-muted); }
.px-top-detail-sum b { color: var(--px-ink); font-weight: 620; font-variant-numeric: tabular-nums; }
.px-top-detail-models { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
.px-top-detail-models > li {
  display: grid; grid-template-columns: minmax(0, 1fr) 84px 88px auto;
  gap: 10px; align-items: baseline;
  font-size: 11.5px; font-variant-numeric: tabular-nums;
}
.px-top-detail-model { color: var(--px-ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.px-top-detail-cost { color: var(--px-ink); font-weight: 620; text-align: right; }
.px-top-detail-state { margin: 0; font-size: 11px; color: var(--px-muted); }
/* 团队区：与上面的「峰谷」用虚线分隔而不是再加一层卡片——它属于同一条明细。 */
.px-top-detail-team { display: grid; gap: 4px; padding-top: 7px; border-top: 1px dashed var(--px-line); }
.px-top-detail-team-title { font-size: 11.5px; color: var(--px-muted); }
.px-top-detail-team-title b { color: var(--px-ink); font-weight: 620; font-variant-numeric: tabular-nums; }
.px-top-detail-members { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.px-top-detail-members > li {
  display: grid; grid-template-columns: minmax(0, 1fr) 84px 88px;
  gap: 10px; align-items: baseline; font-size: 11.5px; font-variant-numeric: tabular-nums;
}
/* 逐日：一行小 chips，日期在前、金额在后；不换行到底也允许折行。 */
.px-top-detail-days {
  display: flex; flex-wrap: wrap; gap: 4px 14px;
  padding-top: 7px; border-top: 1px dashed var(--px-line);
  font-size: 11.5px;
}
.px-top-detail-day { display: inline-flex; align-items: baseline; gap: 5px; color: var(--px-muted); }
.px-top-detail-day i { font-style: normal; font-size: 10.5px; }
.px-top-detail-day b { color: var(--px-ink-2); font-weight: 600; font-variant-numeric: tabular-nums; }
/* 会话名 + 展开三角：两者同排，三角旋转说明当前状态 */
.px-session-open { display: inline-flex; align-items: center; gap: 6px; }
.px-session-open:focus-visible { outline: none; box-shadow: var(--px-ring); border-radius: var(--px-r-sm); }
/* 会话名本身是按钮：整行可点只是鼠标方便，键盘可达要靠它 */
.px-session-open {
  padding: 0;
  font: inherit;
  font-weight: 620;
  color: var(--px-ink);
  text-align: left;
  background: transparent;
  border: 0;
  cursor: pointer;
}
.px-session-open:hover { text-decoration: underline; text-underline-offset: 2px; }
.px-session-open:focus-visible {
  outline: none;
  border-radius: var(--px-r-sm);
  box-shadow: var(--px-ring);
}

/* ════════════════════════════════════════════════════════════════════
   柱状图（逐日消费 / token 构成）
   ════════════════════════════════════════════════════════════════════
   柱子的填充走 px-tone-fill-*（SVG 的 fill），与环图、折线同一套色；
   悬停时只压暗整列背景，**不改柱高**——改高度会让读数与静止时不一致。 */
.px-bar { shape-rendering: crispEdges; }
.px-hover-band { fill: color-mix(in srgb, var(--px-ink) 7%, transparent); }
.px-tip-total {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px dashed var(--px-line-2);
  color: var(--px-ink);
}

/* 「我的价」那一列与单价行里的第二行：用描边徽标区分，不用实色底 */
.px-my-rate { color: var(--px-ink); }
.px-my-rate-badge { border-color: var(--px-detail-accent-line); color: var(--px-detail-accent); }
.px-rate-mine {
  grid-column: 3 / -1;
  grid-row: 2;
  padding-top: 2px;
}
.px-rate-mine code { color: var(--px-detail-accent); }
`

/**
 * 样式表清单：装配与卸载共用同一份来源。
 *
 * **只有两张。** 早先还有第三张 `['skin', SKIN]`（全局皮肤），已随皮肤功能移除。
 * 两张就够了，因为配色分工是清楚的：
 *   - `tokens`：--px-* 变量（:root 浅色 + body[data-ds-dark-theme] 深色），只管变量；
 *   - `dashboard`：全部 .px-* 选择器，看板整页 + 费用条 + 提示条的实样式。
 * 两者都不写全局元素选择器，因此不会外溢到产品界面。渲染闸门断言这里恰好两张。
 */
export const STYLES = [
  ['tokens', TOKENS],
  ['dashboard', DASHBOARD],
  ['pricing', PRICING_CSS],
  ['accounts', ACCOUNTS_CSS],
  ['session', SESSION_CSS],
]
