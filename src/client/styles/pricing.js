/**
 * 定价与「单价设置」界面的样式（.px-price-*）。
 *
 * 单独成文件是为了让样式能**按功能并行改动**：提供商分栏、模型单价行、编辑浮层、
 * 导入导出区都在这里，与看板其余部分（dashboard）、账户与套餐（accounts）、
 * 会话标签页（session）各占一张表。单价以外的选择器必须以 `.px-price-*` 开头——
 * 交付约束如此，也免得与产品自己的界面撞名。
 *
 * ## 为什么不写深色分支
 *
 * 这里只用 `--px-*` 令牌（颜色、圆角、时长），深浅两支由 `tokens` 那张表在
 * `body[data-ds-dark-theme]` 下换掉同一个变量名，因此本表不需要第二套规则。
 * 写死颜色的选择器必须自己补深色分支，那是本项目最容易漏的一处。
 *
 * ## 两条排版约束（都会真的溢出）
 *
 *   1) 两栏用 `minmax(0, ...)` 而不是 auto：输入框的固有宽度（浏览器默认约 20 字符
 *      ≈ 179px）会把栅格撑破，实测溢出 66px；
 *   2) 型号名与归一键都要 `overflow: hidden` + 省略号，否则一个长路由名会把
 *      「未命中 / 输出」两列挤出面板。
 *
 * 由 theme.js 汇总进 STYLES；条目名必须是 `pricing`。
 */
export const PRICING_CSS = `
/* ── 共享控件基础样式（原在 theme.js 的 DASHBOARD 里，随样式分文件迁到这里）──
   .px-input / .px-rate-field 不只是单价编辑器在用：看板的通知面板
   （.px-input px-notify-sound-select 等）也用它，因此写成裸选择器（不带
   .px-price-* 前缀）。

   两条声明是硬约束，缺一个就会横向溢出到面板外面（实测溢出 66px）：
   1) 容器 min-width: 0 —— flex 项默认 auto，会被输入框的固有宽度（浏览器默认
      约 20 字符 ≈ 179px）撑住不收缩；
   2) 输入框 flex: 1 1 0 —— 写成 auto 同样用固有宽度。 */
.px-input {
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
/* 焦点环要自己给（全局那条随皮肤一起删了）：产品默认的 outline 在暗色下几乎看不见。 */
.px-input:focus-visible { outline: none; border-color: var(--px-pink-deep); box-shadow: var(--px-ring); }
.px-rate-field { display: flex; align-items: center; gap: 8px; min-width: 0; }
.px-rate-field-label { flex: none; width: 62px; font-size: 11.5px; color: var(--px-muted); }
/* 三档并排；窄屏由文件末尾的媒体查询塌成单列，避免六个框挤成一团。 */
.px-rate-pairs { display: grid; gap: 8px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.px-rate-pair { display: grid; gap: 4px; min-width: 0; }
.px-rate-pair > b { font-size: 11.5px; font-weight: 600; color: var(--px-ink); }
.px-rate-pair .px-rate-field-label { width: 32px; }
.px-rate-pair .px-input { min-width: 0; }

/* ── 单价设置：整页 ───────────────────────────────────────────── */
.px-price-settings { display: grid; gap: 12px; font-size: 12px; min-width: 0; }
.px-price-head { margin: 0; line-height: 1.6; color: var(--px-ink); }
.px-price-head > b { font-weight: 620; }
.px-price-settings .px-note { margin: 0; font-size: 11.5px; line-height: 1.55; }

/* 汇率那一行：输入框跟一段说明并排，窄屏自然换行（不折行会把说明挤出面板）。 */
.px-price-fx { display: grid; gap: 6px; }
.px-price-fx .px-rate-field > .px-input { max-width: 96px; }

/* ── 提供商分栏：左栏是「我有的那些家」，右栏只画选中那一家 ───────── */
.px-price-console {
  display: grid;
  grid-template-columns: minmax(132px, 176px) minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  min-width: 0;
}
.px-price-nav { display: grid; gap: 3px; align-content: start; min-width: 0; }
.px-price-nav-title { padding: 0 2px 2px; font-size: 11px; color: var(--px-muted); }
/* 每一家一行：标签 + 「几个模型 / 几条已改」。默认无底色无边，只在悬停时给一层
   极薄的墨色底；选中态用描边 + 文字色，不填实色块（与设置弹层的页签同一口径）。 */
.px-price-provider {
  display: grid;
  gap: 1px;
  min-width: 0;
  padding: 6px 8px;
  font: inherit;
  font-size: 12px;
  text-align: left;
  color: var(--px-ink);
  background: none;
  border: 1px solid transparent;
  border-radius: var(--px-r-sm);
  cursor: pointer;
  transition: background var(--px-dur-fast) var(--px-ease), border-color var(--px-dur-fast) var(--px-ease);
}
.px-price-provider:hover { background: color-mix(in srgb, var(--px-ink) 4%, transparent); }
.px-price-provider.on {
  border-color: var(--px-pink-deep);
  background: color-mix(in srgb, var(--px-pink-deep) 8%, transparent);
}
.px-price-provider:focus-visible { outline: none; box-shadow: var(--px-ring); }
.px-price-provider-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.px-price-provider-meta {
  font-size: 11px;
  color: var(--px-muted);
  font-variant-numeric: tabular-nums;
}

/* 右栏 */
.px-price-pane { display: grid; gap: 8px; min-width: 0; }
.px-price-pane-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 3px 10px;
  min-width: 0;
}
.px-price-pane-title { grid-column: 1; grid-row: 1; font-size: 12.5px; font-weight: 620; color: var(--px-ink); }
.px-price-pane-head > .px-note { grid-column: 1; grid-row: 2; }
/* 搜索只在当前提供商里生效，因此紧贴着这一家的标题，而不是摆在页面顶端
   （摆在顶端会让人以为能跨厂商跳转）。 */
.px-price-filters { grid-column: 2; grid-row: 1 / span 2; min-width: 0; }
.px-price-filters .px-rate-field { gap: 5px; }
.px-price-filters .px-rate-field-label { width: auto; }
.px-price-search { width: 148px; }

/* ── 模型清单 ───────────────────────────────────────────────── */
.px-price-list { display: grid; gap: 2px; min-width: 0; }
/* 表头与每一行共用同一条轨道，四列：模型 / 未命中 / 输出 / 操作。
   整列定义轨道（而不是行内各算各的）才能让「未命中」这一列跨行对齐。 */
.px-price-list-head,
.px-price-item-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 64px 64px minmax(88px, auto);
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.px-price-list-head {
  padding: 0 8px 3px;
  font-size: 11px;
  color: var(--px-muted);
  border-bottom: 1px solid var(--px-line);
}
.px-price-list-head > span:nth-child(2),
.px-price-list-head > span:nth-child(3) { text-align: right; }
.px-price-item {
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: var(--px-r-sm);
}
.px-price-item:hover { background: color-mix(in srgb, var(--px-ink) 3%, transparent); }
/* 我改过的那一条要有可辨识的标记：描边用强调色，但不填底色——
   填底色会让它与「估算价」那种警示色混在一起。 */
.px-price-item.mine { border-color: var(--px-pink-deep); }
.px-price-item-name { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.px-price-item-name > b {
  font-weight: 600;
  color: var(--px-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.px-price-item-name > code {
  font-family: var(--px-num-font);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 「自定义 / 估算」这类说明是**文字**而不是徽标：用户看懂了才有用，
   所以用点线下划线暗示可悬停，而不是画一个色块。 */
.px-price-item-tag {
  flex: none;
  font-size: 10.5px;
  color: var(--px-muted);
  border-bottom: 1px dotted var(--px-line-2);
  cursor: help;
}
/* 两档价靠右、等宽、不换行：小数位对齐才扫得出哪一行贵。 */
.px-price-cell {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 4px;
  min-width: 0;
  font-family: var(--px-num-font);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--px-ink);
  white-space: nowrap;
}
/* 桌面端两列的标签由表头给，行内不重复；窄屏表头隐藏，才在行内补上。 */
.px-price-cell-label { display: none; font-style: normal; font-size: 10.5px; color: var(--px-muted); }
.px-price-item-actions { display: flex; align-items: center; justify-content: flex-end; gap: 2px; min-width: 0; }
.px-price-item-actions .px-fix-link { margin-left: 0; white-space: nowrap; }
.px-price-reset { white-space: nowrap; }

/* ── 新增一条（就地展开的一行表单）───────────────────────────── */
.px-price-add { display: grid; gap: 6px; min-width: 0; }
.px-price-add-open {
  padding: 10px;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-sm);
  background: color-mix(in srgb, var(--px-ink) 4%, transparent);
}
.px-price-add-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.px-price-add-head > b { font-size: 12px; font-weight: 600; color: var(--px-ink); }
.px-price-add-fields {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 6px;
  min-width: 0;
}
.px-price-add-fields .px-rate-field { min-width: 0; }
.px-price-add-fields .px-rate-field-label { width: auto; }
.px-price-add-fields .px-input { min-width: 0; }

/* ── 表单（编辑浮层里的六格）─────────────────────────────────── */
.px-price-form {
  display: grid; gap: 8px;
  margin-top: 6px; padding: 10px;
  border-radius: var(--px-r-sm);
  background: color-mix(in srgb, var(--px-ink) 4%, transparent);
  border: 1px solid var(--px-line);
}
.px-price-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.px-price-errors { margin: 0; padding-left: 18px; font-size: 11.5px; line-height: 1.55; color: var(--px-red); }
/* 校验失败必须能一眼看到：它不是普通说明文字，因此在左边加一道提示色竖线。 */
.px-price-inline-error {
  margin: 0; padding: 4px 8px;
  font-size: 11.5px; line-height: 1.55;
  color: var(--px-red);
  background: color-mix(in srgb, var(--px-tone-red) 12%, transparent);
  border-left: 2px solid var(--px-red);
  border-radius: var(--px-r-sm);
}
.px-price-notice { color: var(--px-ink); }

/* ── 导入 / 导出 ─────────────────────────────────────────────── */
.px-price-io { display: grid; gap: 6px; }
.px-price-io-body { display: grid; gap: 6px; }
/* JSON 文本框要能竖着长：一行行挤在 input 里没法核对。 */
.px-price-json {
  width: 100%;
  min-height: 96px;
  resize: vertical;
  font-family: var(--px-num-font);
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre;
  overflow: auto;
}

.px-price-save { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }

/* ── 「改单价」入口（浮层）────────────────────────────────────── */
.px-price-fix { position: relative; display: inline-flex; }
/* 每行一枚「改单价」，所以它不能有边框、底色和阴影（那会让整列看起来全是按钮）。
   默认只比次要文字深一档，悬停才出现下划线；焦点环单独给，键盘用户看得见。 */
.px-fix-link {
  appearance: none;
  padding: 0;
  margin-left: 6px;
  border: none;
  background: none;
  font: inherit;
  font-size: 11.5px;
  color: var(--px-muted);
  cursor: pointer;
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: color var(--px-dur-fast) var(--px-ease), border-color var(--px-dur-fast) var(--px-ease);
}
.px-fix-link:hover { color: var(--px-ink); border-bottom-color: var(--px-line-2); }
.px-fix-link:focus-visible { outline: none; box-shadow: var(--px-ring); border-radius: var(--px-r-sm); }
.px-fix-link[aria-expanded="true"] { color: var(--px-ink); border-bottom-color: var(--px-pink-deep); }
/* 表格里那一枚「补价」的浮层：**portal 到 body + fixed 定位**。
   表格外层有横向滚动容器，留在文档流里会被裁剪、向右越界还会盖住模型名。
   这里用两个类名（.px-price-pop.px-price-pop-fixed）把原有 top/right 覆盖掉，
   特异性高于窄屏媒体查询里的 position: static，因此窄屏也不会退回行内。 */
.px-price-pop.px-price-pop-fixed {
  position: fixed;
  top: auto;
  right: auto;
  bottom: auto;
  z-index: 60;
}
/* 浮层必须脱离文档流：它出现在表格行里，撑开行高会把整张表的行距打乱。
   宽度用 min() 兜住窄栏，max-height + 滚动保证在矮屏上也够用。 */
.px-price-pop {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  right: 0;
  width: min(340px, 92vw);
  max-height: 60vh;
  overflow: auto;
  display: grid; gap: 8px;
  padding: 10px;
  border-radius: var(--px-r-md);
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  box-shadow: 0 12px 32px color-mix(in srgb, var(--px-ink) 18%, transparent);
}
.px-price-pop-title { display: flex; align-items: baseline; gap: 6px; margin: 0; font-size: 12px; }
.px-price-pop-title > code { font-family: var(--px-num-font); font-size: 11px; }

/* ── 窄屏：两栏塌成上下，清单压成两行 ───────────────────────── */
@media (max-width: 720px) {
  .px-price-settings .px-rate-pairs,
  .px-price-pop .px-rate-pairs { grid-template-columns: minmax(0, 1fr); }
  .px-price-pop { position: static; width: auto; max-height: none; }
  /* 提供商从「左栏」变成上方的一排芯片：一两个一行，标签仍可读。 */
  .px-price-console { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .px-price-nav { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
  .px-price-nav-title { grid-column: 1 / -1; }
  .px-price-pane-head { grid-template-columns: minmax(0, 1fr); }
  .px-price-pane-title { grid-column: 1; grid-row: 1; }
  .px-price-pane-head > .px-note { grid-column: 1; grid-row: 2; }
  .px-price-filters { grid-column: 1; grid-row: 3; }
  .px-price-filters .px-rate-field { width: 100%; }
  .px-price-search { width: 100%; }
  /* 清单：第一行「模型名 + 改单价」，第二行「未命中 · 输出」。
     表头隐藏，因此两列各自带一个小标签。 */
  .px-price-list-head { display: none; }
  .px-price-item-head {
    grid-template-columns: minmax(0, 1fr) auto auto;
    grid-template-areas:
      "name name act"
      "miss out act";
    row-gap: 2px;
  }
  .px-price-item-name { grid-area: name; }
  .px-price-cell-miss { grid-area: miss; justify-content: flex-start; }
  .px-price-cell-out { grid-area: out; justify-content: flex-start; }
  .px-price-cell-label { display: inline; }
  .px-price-item-actions { grid-area: act; align-self: center; }
  .px-price-add-fields { grid-template-columns: minmax(0, 1fr); }
}
`
