/**
 * 「套餐余额」板块的样式（.px-acc-*）。
 *
 * 形态是「一家一张卡」的网格：左环形条画总余额，右边每个额度窗口一行细进度条，
 * 底部一个默认收起的「凭据与开关」。所有选择器必须以 .px- 开头。
 *
 * 四条硬约束（都来自项目里的既有铁律，渲染闸门会查）：
 *   1. **不铺 --px-surface-2**：白色是页面里唯一的「块」，次级底色只留给真正
 *      内凹的槽（白名单在 render-check 里）。这里的轨道用 --px-layer-3。
 *   2. **不读产品 --dsw-***：只用自己的 --px-*，深浅两套由 theme.js 的
 *      TOKENS 自动换支，因此本文件**不需要**深色分支。
 *   3. **数字走 tabular-nums**，否则百分比与倒计时的小时数会左右跳。
 *   4. **不做卡中卡**：本段容器是透明的（只有标题 + 网格），白色与阴影只给
 *      每一张厂商卡——那才是这一屏的分区单位。
 *
 * 注意：本文件的内容是**模板字符串**，注释里绝不能出现反引号（会提前闭合）。
 *
 * 由 theme.js 汇总进 STYLES；条目名必须是 accounts。
 */
export const ACCOUNTS_CSS = `
/* ── 整段：标题 + 卡片网格 ─────────────────────────────────────── */
/* 根节点保留了 .px-account-grid 这个旧钩子（渲染闸门按它找这一块），但外观不再由
   它给：那套规则来自早先的两栏布局（auto-fit minmax(320px, 1fr)），会把标题与
   卡片并排成两栏。这里用两个类同时命中（0,2,0）压住它，并把容器改成透明的单列：
   分区感交给每张卡自己的白底与阴影。 */
.px-acc.px-account-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
  align-items: start;
  margin-bottom: 12px;
  padding: 0;
  background: transparent;
  border: 0;
  box-shadow: none;
}
.px-acc-head {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
}
.px-acc-title {
  margin: 0; font-size: 13px; font-weight: 650; color: var(--px-ink);
  letter-spacing: 0.01em;
}
.px-acc-count {
  font-size: 11px; color: var(--px-muted);
  font-variant-numeric: tabular-nums;
}
.px-acc-busy { margin-left: auto; font-size: 11px; color: var(--px-muted); }

/* ── 卡片网格：窄屏自然塌成单列 ─────────────────────────────────── */
.px-acc-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  align-items: stretch;
}

/* 一张厂商卡：flex 纵向排列，卡底那行用 margin-top:auto 顶到底边。
   为什么不用 grid：卡片被并排的邻居拉成等高时，grid 会把多出来的高度**分给每一行**，
   于是两张高度不同的卡里，「徽标那一行」落到了不同的纵坐标上（实测差 12px）——
   三张卡并排、徽标参差不齐，一眼就觉得没对齐。flex 下多出来的高度只落在
   卡底那一条 auto 外边距里，卡头与额度区各自保持自然高度。 */
.px-acc-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  min-width: 0;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
  transition: box-shadow var(--px-dur) var(--px-ease),
              border-color var(--px-dur) var(--px-ease);
}
.px-acc-card:hover { box-shadow: var(--px-elev-2); }
/* 卡头固定两行（第一行是谁，第二行状态 + 核验）。让它们挤在一行里自己折行的话，
   长厂商名加两枚徽标会随机折成两三行，三张卡并排时卡头高度不一。 */
.px-acc-card-head {
  display: grid; gap: 6px; align-content: start;
  min-width: 0;
}
.px-acc-card-id {
  display: flex; align-items: baseline; gap: 8px;
  min-width: 0;
}
.px-acc-plan-name {
  font-size: 13px; color: var(--px-ink);
  min-width: 0;
  overflow-wrap: anywhere;
}
.px-acc-card-meta {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
/* 核验级别：11px、只有两个字。它不是主信息，但用户需要它来判断
   「这个数字能不能当准」，所以不能藏进折叠区。 */
.px-acc-verif {
  font-size: 11px; color: var(--px-muted);
  white-space: nowrap;
}
/* 监看开关：**无边框的小字按钮**。它是偏好而不是每张卡的主要动作，
   做成描边按钮会和状态徽标抢位置，300px 宽的卡头会被挤成三行。
   选中态只换文字色 —— 「当前监看」这件事在费用条那边已经有强表达，
   这里再给一个实底会让同一张卡里出现两个视觉重音。 */
.px-acc-monitor {
  appearance: none; font: inherit;
  margin-left: auto;
  flex: none;
  padding: 0 2px;
  font-size: 11px; font-weight: 570;
  color: var(--px-muted);
  background: transparent;
  border: 0;
  border-bottom: 1px dashed var(--px-line-2);
  cursor: pointer;
  white-space: nowrap;
  transition: color var(--px-dur-fast) var(--px-ease),
              border-color var(--px-dur-fast) var(--px-ease);
}
.px-acc-monitor:hover { color: var(--px-pink-deep); border-bottom-color: var(--px-pink-deep); }
.px-acc-monitor:focus-visible { outline: none; box-shadow: var(--px-ring); border-radius: var(--px-r-sm); }
.px-acc-monitor.active { color: var(--px-pink-deep); border-bottom-color: transparent; }
/* 状态徽标只改文字色与描边色：底色由 .px-badge 保持透明——
   实色底一旦与所在容器同色，整个徽标就只剩文字浮着。 */
.px-acc-badge-ok {
  color: var(--px-tone-green);
  border-color: color-mix(in srgb, var(--px-tone-green) 30%, transparent);
}
.px-acc-badge-warn {
  color: var(--px-tone-yellow);
  border-color: color-mix(in srgb, var(--px-tone-yellow) 34%, transparent);
}
.px-acc-badge-error {
  color: var(--px-tone-red);
  border-color: color-mix(in srgb, var(--px-tone-red) 34%, transparent);
}
/* 失败原因单独一行：徽标只给四档状态，真正可操作的句子（缺哪个凭据名、
   鉴权是怎么被拒的）在这里，字数不限但要小一号。 */
.px-acc-reason {
  margin: 0; font-size: 11px; line-height: 1.55;
  color: var(--px-ink-2);
  overflow-wrap: anywhere;
}
.px-acc-reason-error { color: var(--px-tone-red); }
.px-acc-reason-warn { color: var(--px-detail-label); }

/* ── 卡内主体：左环 + 右条 ─────────────────────────────────────── */
/* 左栏与右栏都**顶对齐**（不是垂直居中）：三张卡并排时窗口数各不相同，
   垂直居中会把三个环放在三个不同的高度上（实测差 36px），一眼看着就是没对齐。
   顶对齐之后，环排成一条横线，窗口多寡只影响条往下延伸的长度。 */
.px-acc-card-body {
  display: flex; align-items: flex-start; gap: 14px;
  min-width: 0;
}

/* 环形条：直径 76（再大就把右侧的窗口行挤下去），描边 8。
   填充色是**单一强调色**，只有告警（已用 ≥ 90% 或已超限）才转红。 */
.px-acc-ring {
  position: relative;
  flex: none;
  width: 76px; height: 76px;
  display: grid; place-items: center;
}
.px-acc-ring-svg { display: block; width: 76px; height: 76px; }
/* 轨道与填充都只给 stroke：fill 必须显式关掉，否则 SVG 圆默认填黑。 */
.px-acc-ring-track {
  fill: none;
  stroke: var(--px-layer-3);
  stroke-width: 8;
}
.px-acc-ring-fill {
  fill: none;
  stroke: var(--px-pink-deep);
  stroke-width: 8;
  stroke-linecap: round;
  transition: stroke-dasharray var(--px-dur-slow) var(--px-ease-out);
}
.px-acc-ring-alert { stroke: var(--px-tone-red); }
/* 中心数字画在 SVG 外面（绝对定位）：SVG 里的 text 拿不到 CSS 令牌，
   字号也不受页面缩放控制。 */
.px-acc-ring-center {
  position: absolute;
  inset: 0;
  display: grid; place-content: center; justify-items: center;
  gap: 1px;
  text-align: center;
  pointer-events: none;
}
.px-acc-ring-value {
  font-size: 15px; font-weight: 660; line-height: 1.15;
  color: var(--px-ink);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
/* 只有剩余金额的厂商（例如 65.55 这种信用额）在 76px 里放不下 15px 的字号，
   降一档而不是截断——数字截断就是撒谎。 */
.px-acc-ring-value.long { font-size: 11.5px; letter-spacing: 0; }
.px-acc-ring-label {
  font-size: 10px; line-height: 1.2;
  color: var(--px-muted);
}

/* ── 额度窗口：一行一个，竖向排列 ───────────────────────────────── */
.px-acc-wins {
  flex: 1 1 auto;
  min-width: 0;
  display: grid;
  gap: 8px;
}
.px-acc-win { display: grid; gap: 3px; min-width: 0; }
.px-acc-win-head { display: flex; align-items: baseline; gap: 6px; }
.px-acc-win-name {
  font-size: 11px; font-weight: 570;
  color: var(--px-ink-2);
}
.px-acc-win-used {
  margin-left: auto;
  font-size: 11px; font-weight: 620;
  color: var(--px-ink-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.px-acc-win-used.alert { color: var(--px-tone-red); }
.px-acc-win-over {
  font-size: 10px; font-weight: 620;
  color: var(--px-tone-red);
  padding: 0 5px;
  border-radius: var(--px-r-pill);
  border: 1px solid color-mix(in srgb, var(--px-tone-red) 40%, transparent);
}
/* 条高 6px、胶囊圆角：再粗就和环形条抢注意力了。轨道走 layer-3（内凹），
   不用 surface-2——那会把卡内切出一块米色。 */
.px-acc-win-track {
  height: 6px;
  border-radius: var(--px-r-pill);
  background: var(--px-layer-3);
  overflow: hidden;
}
.px-acc-win-fill {
  display: block; height: 100%;
  border-radius: var(--px-r-pill);
  background: var(--px-pink-deep);
  transition: width var(--px-dur-slow) var(--px-ease-out);
}
.px-acc-win-fill.alert { background: var(--px-tone-red); }
.px-acc-win-foot {
  font-size: 10.5px; line-height: 1.5;
  color: var(--px-muted);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

/* ── 空态 / 状态行 ─────────────────────────────────────────────── */
.px-acc-empty {
  margin: 0; padding: 8px 10px;
  flex: 1 1 auto;
  font-size: 11px; line-height: 1.55;
  color: var(--px-ink-2);
  border: 1px dashed var(--px-line-2);
  border-radius: var(--px-r-sm);
}
.px-acc-state { margin: 0; font-size: 11.5px; line-height: 1.55; color: var(--px-ink-2); }
.px-acc-state.px-acc-error { color: var(--px-tone-red); }
.px-acc-state.px-acc-ok { color: var(--px-tone-green); }
.px-acc-state.px-acc-off { color: var(--px-muted); }
.px-acc-note {
  margin: 0; font-size: 11px; color: var(--px-muted); line-height: 1.55;
}

/* ── 卡底：凭据与开关（默认收起）────────────────────────────────── */
/* margin-top:auto 把这一条压到卡底：卡片被拉高时多出来的空间落在这里，
   于是并排几张卡的「凭据与开关」在同一横线上。 */
.px-acc-config {
  margin-top: auto;
  border-top: 1px dashed var(--px-line-2);
  padding-top: 8px;
}
.px-acc-config > summary {
  font-size: 11px;
  color: var(--px-muted);
  cursor: pointer;
}
.px-acc-config > summary:hover { color: var(--px-ink-2); }
.px-acc-config[open] > summary { color: var(--px-ink-2); }
.px-acc-config-body { display: grid; gap: 8px; margin-top: 8px; }
.px-acc-config-foot {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-top: 6px;
  border-top: 1px dashed var(--px-line-2);
  font-size: 11px; color: var(--px-muted);
}
.px-acc-config-foot a { color: var(--px-pink-deep); text-decoration: none; }
.px-acc-config-foot a:hover { text-decoration: underline; }
.px-acc-endpoint {
  font-size: 10.5px; color: var(--px-muted);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.px-acc-toggle {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--px-muted);
  cursor: pointer;
}
.px-acc-toggle input { accent-color: var(--px-pink-deep); }

/* ── 「这家凭据怎么配」 ────────────────────────────────────────── */
.px-acc-setup { margin-top: 2px; }
.px-acc-steps {
  margin: 6px 0 0; padding-left: 18px;
  font-size: 11.5px; color: var(--px-ink-2); line-height: 1.65;
}
.px-acc-steps li { margin: 2px 0; }
.px-acc-setup-link { margin: 8px 0 0; font-size: 11.5px; }
.px-acc-setup-link a { color: var(--px-pink-deep); text-decoration: none; }
.px-acc-setup-link a:hover { text-decoration: underline; }
.px-acc-setup-where { margin-top: 8px; }
.px-acc-setup-where > p { margin: 0 0 6px; font-size: 11.5px; color: var(--px-ink-2); }
/* 路径要能整条读出来、能复制：等宽 + allow-wrap，不省略号截断。 */
.px-acc-setup-path {
  display: block;
  padding: 6px 8px;
  font-size: 11px;
  overflow-wrap: anywhere;
  color: var(--px-ink);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-sm);
}
.px-acc-setup-refs { margin: 6px 0 0; padding-left: 18px; font-size: 11px; line-height: 1.7; }
.px-acc-setup-refs code { font-size: 11px; color: var(--px-ink); }
.px-acc-setup-note { margin-left: 6px; color: var(--px-muted); }
.px-acc-setup-hint {
  margin: 8px 0 0; font-size: 10.5px; line-height: 1.6; color: var(--px-muted);
}
.px-acc-setup-hint code { font-size: 10.5px; }
.px-acc-files { margin-top: 8px; }
.px-acc-files > p { margin: 0 0 6px; font-size: 11.5px; color: var(--px-ink-2); }
.px-acc-file-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.px-acc-file-list > li { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.px-acc-file-path { font-size: 10.5px; overflow-wrap: anywhere; color: var(--px-ink-2); }
.px-acc-file-flag {
  font-size: 10.5px; color: var(--px-muted);
  padding: 1px 7px; border-radius: var(--px-r-pill);
  border: 1px solid var(--px-line);
}
.px-acc-file-flag.present {
  color: var(--px-tone-green);
  border-color: color-mix(in srgb, var(--px-tone-green) 30%, transparent);
}

/* ── 移除凭据 ─────────────────────────────────────────────────── */
.px-acc-remove { margin-top: 2px; }
.px-acc-ref-list { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.px-acc-ref-row { display: grid; gap: 3px; }
.px-acc-ref-label {
  display: inline-flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  font-size: 11.5px; color: var(--px-ink-2);
}
.px-acc-ref-label code { font-size: 11px; color: var(--px-ink); }
.px-acc-ref-purpose { font-size: 11px; color: var(--px-muted); }
.px-acc-ref-source {
  font-size: 10.5px; color: var(--px-muted);
  font-variant-numeric: tabular-nums;
}
/* 不可移除的原因要看得见：用浅黄底 + 描边，不抢红色（红留给真正的故障）。 */
.px-acc-ref-blocked {
  font-size: 10.5px; line-height: 1.55;
  color: var(--px-ink-2);
  padding: 5px 8px;
  border-radius: var(--px-r-sm);
  background: color-mix(in srgb, var(--px-yellow) 20%, transparent);
  border: 1px solid color-mix(in srgb, var(--px-yellow) 40%, var(--px-line));
  overflow-wrap: anywhere;
}
.px-acc-remove-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.px-acc-confirm {
  margin: 8px 0 0; font-size: 11px; line-height: 1.55;
  color: var(--px-ink-2);
  padding: 6px 9px;
  border-radius: var(--px-r-sm);
  background: color-mix(in srgb, var(--px-red) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--px-red) 34%, var(--px-line));
  overflow-wrap: anywhere;
}
.px-acc-remove-result { margin: 8px 0 0; padding-left: 16px; font-size: 11px; line-height: 1.6; }
.px-acc-ok { color: var(--px-tone-green); }
.px-acc-bad { color: var(--px-tone-red); }

/* ── 按钮 ─────────────────────────────────────────────────────── */
.px-acc-btn {
  appearance: none; font: inherit;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px;
  font-size: 11px; font-weight: 570;
  color: var(--px-ink-2);
  background: transparent;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-pill);
  cursor: pointer;
  transition: color var(--px-dur-fast) var(--px-ease),
              border-color var(--px-dur-fast) var(--px-ease);
}
.px-acc-btn:hover:not(:disabled) { color: var(--px-ink); border-color: var(--px-pink-deep); }
.px-acc-btn:focus-visible { outline: none; box-shadow: var(--px-ring); }
.px-acc-btn:disabled { cursor: not-allowed; opacity: 0.5; }
.px-acc-btn.ghost { border-style: dashed; }
.px-acc-btn.active { border-style: solid; color: var(--px-pink-deep); border-color: var(--px-pink-deep); }
/* 「确认移除」是危险动作，用红色描边明确区分于普通按钮。 */
.px-acc-btn.danger {
  color: var(--px-tone-red);
  border-color: color-mix(in srgb, var(--px-tone-red) 50%, transparent);
}

/* ── 「添加厂商」 ─────────────────────────────────────────────── */
.px-acc-add-list { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.px-acc-add-row {
  display: grid; gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-sm);
  font-size: 11.5px; color: var(--px-ink-2);
}
.px-acc-add-main {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
}
.px-acc-add-row b { font-weight: 600; color: var(--px-ink); }
.px-acc-add-note { font-size: 11px; color: var(--px-muted); }
.px-acc-add-ref {
  margin-right: auto;
  font-size: 10.5px;
  color: var(--px-ink-2);
  overflow-wrap: anywhere;
}
.px-acc-add-hint-text {
  font-size: 10.5px; line-height: 1.6; color: var(--px-muted);
  overflow-wrap: anywhere;
}
.px-acc-add-setup > summary {
  font-size: 11px;
  color: var(--px-pink-deep);
  cursor: pointer;
}
.px-acc-add-hint { margin-top: 2px; }

/* ── 免责（一句话）────────────────────────────────────────────── */
.px-acc-disclaimer {
  margin: 0; font-size: 10.5px; line-height: 1.6;
  color: var(--px-detail-label);
}
.px-acc-disclaimer-mark {
  color: var(--px-muted);
  cursor: help;
}

/* ── 窄屏：卡片单列、窗口行的百分比不再靠右挤 ───────────────────── */
@media (max-width: 640px) {
  .px-acc-cards { grid-template-columns: 1fr; }
}
@media (max-width: 380px) {
  .px-acc-card-body { gap: 10px; }
  .px-acc-win-used { margin-left: 0; }
}

/* ── 降低动效偏好：环与条的推进改为立即到位 ─────────────────────
   它们表达的是「现在的额度」，延迟出现只会让人以为数字在动。 */
@media (prefers-reduced-motion: reduce) {
  .px-acc-card,
  .px-acc-ring-fill,
  .px-acc-win-fill,
  .px-acc-monitor { transition: none; }
}
`
