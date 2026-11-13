/**
 * 定价与「单价设置」界面的样式（.px-price-*）。
 *
 * 单独成文件是为了让样式能**按功能并行改动**：表头、厂商分组、单价输入行、
 * 导入导出区都在这里，与看板其余部分（dashboard）、账户与套餐（accounts）、
 * 会话标签页（session）各占一张表。全部选择器必须以 `.px-` 开头——
 * 不以它开头就等于在改产品自己的界面，渲染闸门会拦。
 *
 * ## 为什么不写深色分支
 *
 * 这里只用 `--px-*` 令牌（颜色、圆角、时长），深浅两支由 `tokens` 那张表在
 * `body[data-ds-dark-theme]` 下换掉同一个变量名，因此本表不需要第二套规则。
 * 写死颜色的选择器必须自己补深色分支，那是本项目最容易漏的一处。
 *
 * 由 theme.js 汇总进 STYLES；条目名必须是 `pricing`。
 */
export const PRICING_CSS = `
/* ── 共享控件基础样式（原在 theme.js 的 DASHBOARD 里，随样式分文件迁到这里）──
   .px-input / .px-rate-field 不只是单价编辑器在用：看板的通知面板
   （.px-input px-notify-sound-select 等）也用它。v3 把「单价编辑」整体搬进
   priceSettings.js 之后，原处那份就成了死样式，删掉会把通知面板一起带坏——
   因此由这张表接手，且写成裸选择器（不带 .px-price-* 前缀）。

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
.px-price-settings { display: grid; gap: 12px; font-size: 12px; }
.px-price-head { margin: 0; line-height: 1.6; color: var(--px-ink); }
.px-price-head > b { font-weight: 620; }
.px-price-settings .px-note { margin: 0; font-size: 11.5px; line-height: 1.55; }

/* 汇率那一行：输入框跟一段说明并排，窄屏自然换行（不折行会把说明挤出面板）。 */
.px-price-fx { display: grid; gap: 6px; }
.px-price-fx .px-rate-field > .px-input { max-width: 96px; }

.px-price-filters { display: grid; gap: 6px; }
.px-price-search { min-width: 0; }

/* ── 厂商分组 ───────────────────────────────────────────────── */
.px-price-groups { display: grid; gap: 10px; }
.px-price-group {
  display: grid; gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-sm);
  background: color-mix(in srgb, var(--px-ink) 3%, transparent);
}
.px-price-group-title { display: flex; align-items: baseline; gap: 4px; font-size: 12px; }
.px-price-group-title > b { font-weight: 620; color: var(--px-ink); }

/* ── 单个模型一行 ───────────────────────────────────────────── */
.px-price-item {
  display: grid; gap: 6px;
  padding: 6px 8px;
  border-radius: var(--px-r-sm);
  background: var(--px-surface);
  border: 1px solid var(--px-line);
}
/* 我改过的那一条要有可辨识的标记：描边用强调色，但不填底色——
   填底色会让它与「估算价」那种警示色混在一起。 */
.px-price-item.mine { border-color: var(--px-pink-deep); }
.px-price-item-head {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px;
  justify-content: space-between;
}
.px-price-item-name { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.px-price-item-name > b { font-weight: 600; color: var(--px-ink); }
.px-price-item-name > code {
  font-family: var(--px-num-font);
  font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 三档价：等宽数字 + 竖直排列，与表头「空闲 / 高峰」的顺序一致。
   tabular-nums 让 ¥0.02 与 ¥12.00 的小数点对齐，扫一眼就能比大小。 */
.px-price-item-prices { display: flex; flex-wrap: wrap; gap: 4px 12px; font-variant-numeric: tabular-nums; }
.px-price-item-price { font-family: var(--px-num-font); font-size: 11.5px; color: var(--px-ink); }
.px-price-item-flags { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.px-price-item-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-left: auto; }
.px-price-reset { color: var(--px-muted); }

/* ── 表单（与看板内联编辑器共用同一套外观）───────────────────── */
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

/* ── 倍率 ───────────────────────────────────────────────────── */
.px-price-markup { display: grid; gap: 6px; }
.px-price-markup .px-rate-field > .px-input { max-width: 88px; }

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

.px-price-new { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.px-price-save { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }

/* ── 费用明细里的「补价」入口（浮层）───────────────────────────── */
.px-price-fix { position: relative; display: inline-flex; }
/* 费用明细里的「改单价」入口：**链接式次级按钮**。
   每行一枚，所以它不能有边框、底色和阴影（那会让整列看起来全是按钮）。
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

/* 窄屏：三档塌成单列（六个框并排会挤成一团，读不出哪个是哪个）。 */
@media (max-width: 720px) {
  .px-price-settings .px-rate-pairs,
  .px-price-pop .px-rate-pairs { grid-template-columns: minmax(0, 1fr); }
  .px-price-pop { position: static; width: auto; max-height: none; }
}
`
