/**
 * 会话标签页（`conversation.view` 里的「费用」）的样式（.px-sv-*）。
 *
 * 它与看板共用 --px-* 令牌，但**不是看板的一部分**：这一页挂在会话视图里，
 * 上下是产品的会话区，因此只能用自己的 .px-sv-* 选择器，不得外溢。
 *
 * ## 这一页的视觉规则（改之前先读完）
 *
 * 1) **一页只有一个主角：顶部那个金额。** 它 34px/700、用 --px-ink（不是强调色），
 *    其余所有数字都比它小一档以上。层级靠字号 + 字重 + 空间拉开，不靠再加一个色块。
 * 2) **强调色（--px-pink-deep）只出现在「当前状态 / 选中」两处**：进行中徽标、
 *    以及账户被手动指定时的徽标。占比条一律中性（墨色淡涂），不做彩虹。
 *    状态色（绿/黄/红）只表达状态：额度告急、账户不可用。
 * 3) **卡片不嵌套卡片。** 卡片里只有「行 + 细条」与表格；细分隔用 1px 描边，
 *    不铺 --px-surface-2（次级底色只留给真正内凹的轨道，渲染闸门有白名单）。
 * 4) 数字一律 tabular-nums：逐行金额位数一跳，整张表就在抖。
 * 5) 间距全是 4 的倍数；同族元素（计量行、表格行、成员行）行距一致。
 *
 * 由 theme.js 汇总进 STYLES；条目名必须是 `session`。
 */
export const SESSION_CSS = `
/* ── 外壳 ─────────────────────────────────────────────────────── */
/* 版式是**显式的四行**，不是 auto-fit 网格。
 *
 * 早先用 repeat(auto-fit, minmax(320px, 1fr))：卡片的列数由容器宽度决定，于是
 * 「逐日花费 | 账户」那一行在某个宽度下只剩两块、右边空出一大片——用户的原话是
 * 「搞这么多空隙出来为什么」。行数、每行几块现在都由这里写死，宽度变化只改列数，
 * 不会再出现「这一行少一块」的空白。 */
.px-sv {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 20px 28px;
  font-family: var(--px-ui-font);
  color: var(--px-ink);
  font-size: 12.5px;
  line-height: 1.55;
  font-variant-numeric: tabular-nums;
}
.px-sv * { box-sizing: border-box; }
.px-sv-num { font-variant-numeric: tabular-nums; }

/* 通栏的几类：抬头、含表格的那张卡、脚注、空态与降级态。
   容器已改成纵向 flex，通栏是默认行为；这两条保留是为了兼容 .px-sv-card-wide
   这个显式标记（卡片自身仍不该被挤成半栏）。 */
.px-sv-head,
.px-sv-notes,
.px-sv-empty,
.px-sv-state,
.px-sv-card-wide,
.px-sv-card:has(.px-sv-table-wrap) { grid-column: 1 / -1; }

/* ── 第一行：hero 指标（照「图二」：彩色左边条 + 大号数字 + 脚注）── */
/* 固定四列而不是 auto-fit：这一行**恰好**四块，auto-fit 会按最小宽度算出 5 列，
   于是右边空一格——正是这一轮要消灭的那种空白。窄屏依次塌成 2 列 / 2 列。 */
.px-sv-heroes {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.px-sv-heroes > .px-hero { min-width: 0; }

/* ── 第二行 / 第四行：并排的分区行 ───────────────────────────────── */
/* 类名是 .px-sv-band（一条「分区带」），**不叫 .px-sv-row**：
   .px-sv-row 已经被「计量行」（标签 + 数值 + 细条）占用了，两者同名会让
   计量行拿到 display:grid / 分区带拿到 flex-direction:column ——
   实测结果就是「三块并排」实际竖着叠起来。 */
.px-sv-band {
  display: grid;
  gap: 12px;
  align-items: stretch;
  min-width: 0;
}
/* 第二行：左「耗时构成」+ 右两张（计价时段 / 用量构成）。
   左块稍宽（堆叠条要长度才读得出比例），右边两张等分。 */
.px-sv-band-split {
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) minmax(0, 1fr);
}
/* 第四行：三块等分。补上「请求分布」之后这一行不再有空白。 */
.px-sv-band-three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
/* 耗时块本身已经是「白块 + 描边」（.px-timing 自带），这里只负责让它占满格高，
   并去掉它作为独立块时的那点下外边距。 */
.px-sv-timing-cell { display: flex; min-width: 0; }
.px-sv-timing-cell > .px-timing {
  flex: 1 1 auto;
  margin: 0;
  min-width: 0;
}

/* ── 抬头：只说明「这是哪条会话」，金额交给第一行的 hero 卡 ───────── */
/* 抬头刻意**不做卡片**：它是一条页眉，用一条细线与下面的卡片分开。
   卡片里再套卡片会让「谁是一页的开头」读不出来。
   早先抬头右侧放的是 34px 大金额，现在金额挪进 hero 卡（带色条）——
   同一个数字在一页里出现两次，读者会开始怀疑哪个才是总数。 */
.px-sv-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--px-line);
}
.px-sv-head-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}
.px-sv-eyebrow {
  color: var(--px-detail-label);
  font-size: 11px;
  letter-spacing: 0.08em;
}
.px-sv-head-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.px-sv-title {
  margin: 0;
  max-width: 42ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: 0.01em;
}
/* 小字走 --px-detail-label 而不是 --px-muted：#8a7969 在白底上只有 4.18:1，
   低于 AA 的 4.5（项目就是为这件事单独加了这个令牌）。#75655a 是 5.58:1。 */
.px-sv-hint { color: var(--px-detail-label); font-size: 11px; }
.px-sv-muted { color: var(--px-detail-label); }

/* 后台刷新失败：一行轻提示，不换掉已经显示的数字。 */
.px-sv-stale {
  margin: 0;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--px-tone-yellow) 55%, transparent);
  border-radius: var(--px-r-md);
  background: color-mix(in srgb, var(--px-tone-yellow) 12%, transparent);
  color: var(--px-ink);
  font-size: 11.5px;
}

/* 徽标：描边胶囊。强调色只买「当前」这一层意思（进行中 / 手动指定），
   用淡色底 + 墨色字，而不是把 11px 的粉字直接压在白底上（那样对比度不够）。 */
.px-sv-tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-pill);
  color: var(--px-ink-2);
  font-size: 11px;
  white-space: nowrap;
}
.px-sv-tag-live,
.px-sv-tag-accent {
  border-color: color-mix(in srgb, var(--px-pink-deep) 40%, transparent);
  background: color-mix(in srgb, var(--px-pink-deep) 11%, transparent);
  color: var(--px-ink);
}

/* ── 卡片：白色是唯一的「块」 ─────────────────────────────────── */
.px-sv-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* min-width: 0 是必需的：卡片是 grid/flex 的子项，默认 min-width:auto 时
     表格的固有宽度会把整张卡撑宽，进而把页面顶出横向滚动条（420px 下实测过）。 */
  min-width: 0;
  padding: 16px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
}
.px-sv-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
/* 卡片标题只做「这一格是什么」，12px/600/字距 0.06em：比正文重、比数字轻。 */
.px-sv-card-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--px-ink-2);
}
.px-sv-card-note {
  color: var(--px-detail-label);
  font-size: 11px;
  white-space: nowrap;
}
.px-sv-card-foot {
  /* 卡片被拉齐到同一行最高那张时，脚注压到底：留白落在脚注上方，
     而不是让脚注浮在卡片中间。 */
  margin: auto 0 0;
  color: var(--px-detail-label);
  font-size: 11px;
  line-height: 1.6;
}

/* ── 计量行：标签 + 数值在上，细条在下 ───────────────────────── */
/* 这一页原来是一排大号数字格（6 个描边小方块），读起来像仪表盘墙。
   改成「一行一个指标」：左标签右数值，下面一根 5px 细条表示它在总量里的份额。
   同样的信息占更少面积，也省掉了 6 个描边框。 */
.px-sv-rows {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.px-sv-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.px-sv-row-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.px-sv-row-label {
  color: var(--px-ink-2);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.px-sv-row-meta {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  flex: 0 0 auto;
}
.px-sv-row-value {
  font-size: 13px;
  font-weight: 600;
}
/* 占比是附注，不是第二个数字：更小、更淡、定宽右对齐，位数变化不会推挤金额。 */
.px-sv-row-pct {
  min-width: 3.6em;
  text-align: right;
  color: var(--px-detail-label);
  font-size: 11px;
  font-weight: 400;
}

/* ── 占比条：轨道用描边色，填充按语义上色（用户要的「彩色条形」）── */
.px-sv-meter {
  display: block;
  height: 4px;
  border-radius: var(--px-r-pill);
  background: var(--px-line);
  overflow: hidden;
}
.px-sv-meter-thin { height: 4px; }
.px-sv-meter-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: color-mix(in srgb, var(--px-ink) 30%, transparent);
  transition: width var(--px-dur) var(--px-ease);
}
/* 语义色：峰=粉、闲=绿（用户确认的口径）；四桶沿用看板「构成」那一套
   （命中=蓝、未命中=紫、写入=黄、输出=粉），于是从看板堆叠柱看到这一页的
   占比条，颜色一一对应。全部走 --px-* 令牌，不写死十六进制。 */
.px-sv-meter-fill-pink { background: var(--px-tone-pink); }
.px-sv-meter-fill-green { background: var(--px-tone-green); }
.px-sv-meter-fill-blue { background: var(--px-tone-blue); }
.px-sv-meter-fill-purple { background: var(--px-tone-purple); }
.px-sv-meter-fill-yellow { background: var(--px-tone-yellow); }
.px-sv-meter-fill-accent { background: var(--px-detail-accent); }
/* 红色只留给「额度快用完了」这一类真状态。 */
.px-sv-meter-fill-warn { background: var(--px-tone-red); }

/* 计量行标签前的色点：与条同色，于是「哪一格是峰、哪一格是闲」不用读字。 */
.px-sv-tick {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 50%;
  flex: none;
  vertical-align: middle;
}
.px-sv-tick-pink { background: var(--px-tone-pink); }
.px-sv-tick-green { background: var(--px-tone-green); }
.px-sv-tick-blue { background: var(--px-tone-blue); }
.px-sv-tick-purple { background: var(--px-tone-purple); }
.px-sv-tick-yellow { background: var(--px-tone-yellow); }
.px-sv-tick-accent { background: var(--px-detail-accent); }

/* ── 请求分布（峰/闲水平条）───────────────────────────────────── */
/* 条本身沿用看板的 .px-peak-bar / .px-peak-fill / .px-peak-rest（同一种语言），
   这里只按用户确认的口径换掉颜色：峰=粉、闲=绿。
   覆盖**限定在 .px-sv 之下**：看板那边的同一组类是黄/蓝，不能一起改掉。 */
.px-sv .px-peak-fill {
  background: var(--px-tone-pink);
  transition: width var(--px-dur) var(--px-ease);
}
.px-sv .px-peak-rest {
  background: var(--px-tone-green);
  opacity: 0.32;
}
.px-sv-peak { display: flex; flex-direction: column; gap: 8px; }
.px-sv-peak-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.px-sv-peak-peak { color: var(--px-tone-pink); font-size: 12px; font-weight: 600; }
.px-sv-peak-idle { color: var(--px-tone-green); font-size: 12px; font-weight: 600; }

/* ── 派生指标（缓存命中率）：一条细线隔开的收尾读数 ───────────── */
.px-sv-figure {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  gap: 4px 12px;
  padding-top: 12px;
  border-top: 1px solid var(--px-line);
}
.px-sv-figure-label { color: var(--px-ink-2); font-size: 12px; }
.px-sv-figure-value {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.px-sv-figure-note {
  grid-column: 1 / -1;
  color: var(--px-detail-label);
  font-size: 11px;
}

/* ── 逐模型明细表 ─────────────────────────────────────────────── */
/* min-width: 0 同卡片那条：不让表格的固有宽度把 flex 父项撑开。 */
.px-sv-table-wrap {
  overflow-x: auto;
  min-width: 0;
}
.px-sv-table {
  width: 100%;
  border-collapse: collapse;
}
.px-sv-table th,
.px-sv-table td {
  padding: 8px;
  text-align: left;
  white-space: nowrap;
}
/* 表头走新的中性层次：不加底色，靠 10.5px + 0.08em 字距 + 一条 line-2 下边线。 */
.px-sv-table thead th {
  padding-bottom: 8px;
  color: var(--px-ink-2);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  border-bottom: 1px solid var(--px-line-2);
}
.px-sv-table tbody td {
  font-size: 12px;
  border-bottom: 1px solid var(--px-line);
}
.px-sv-table tbody tr:last-child td { border-bottom: none; }
/* 行悬停极淡着色，不换底、不变脸（与看板 .px-btn 的 hover 同一口径）。 */
.px-sv-table tbody tr:hover td { background: color-mix(in srgb, var(--px-ink) 4%, transparent); }
/* 合计行：一条 line-2 上边线 + 更多的上方留白，让它明显是「另一段」。 */
.px-sv-table tfoot th,
.px-sv-table tfoot td {
  padding-top: 8px;
  font-size: 12px;
  font-weight: 700;
  color: var(--px-ink);
  border-top: 1px solid var(--px-line-2);
  border-bottom: none;
}
/* 右对齐要压过 .px-sv-table th/td 的 left（选择器权重：都带 .px-sv-table）。 */
.px-sv-table th.px-sv-col-num,
.px-sv-table td.px-sv-col-num { text-align: right; }
.px-sv-model {
  display: inline-block;
  max-width: 26ch;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  font-weight: 500;
}
.px-sv-badge {
  display: inline-flex;
  align-items: center;
  height: 16px;
  margin-left: 8px;
  padding: 0 8px;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-pill);
  color: var(--px-ink-2);
  font-size: 10px;
}
/* 「估算」是状态：淡黄底 + 墨色字。直接把 10px 的黄字压在白底上会看不清。 */
.px-sv-badge-warn {
  border-color: color-mix(in srgb, var(--px-tone-yellow) 55%, transparent);
  background: color-mix(in srgb, var(--px-tone-yellow) 14%, transparent);
  color: var(--px-ink);
}
.px-sv-unit { color: var(--px-ink-2); }
.px-sv-amount-cell { font-weight: 700; }

/* ── 逐日花费：迷你柱状（日期 + 条 + 金额）───────────────────── */
/* 原来是一排「日期 / 大号金额 / token 数」，三列都重。改成一根按最大值归一化的
   细条之后，哪天最贵一眼就看出来，金额仍然在，token 数收掉了（它与金额重复表达
   同一件事，而这一格只有半栏宽）。 */
.px-sv-days,
.px-sv-members {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.px-sv-day {
  display: grid;
  grid-template-columns: 3em minmax(40px, 1fr) auto;
  align-items: center;
  gap: 12px;
}
.px-sv-day-label {
  color: var(--px-ink-2);
  font-size: 11.5px;
}
.px-sv-day-value {
  font-size: 12px;
  font-weight: 600;
  text-align: right;
}

/* ── 账户 ─────────────────────────────────────────────────────── */
.px-sv-account {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.px-sv-account-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.px-sv-account-label {
  color: var(--px-ink-2);
  font-size: 12px;
}
/* 余额/额度是这一页第二重要的数字：22px，比正文大一档，比抬头金额小一档。 */
.px-sv-account-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.01em;
}
/* 不可用是状态：一个红点 + 墨色文字。
   不把「不可用」整串染红——浅色的 --px-tone-red 在白底上只有 4.02:1，
   14px 的文字达不到 AA；红点是非文字元素（要求 3:1），4.02 足够。 */
.px-sv-account-unavailable .px-sv-account-value {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--px-ink);
  font-size: 15px;
  font-weight: 600;
}
.px-sv-account-unavailable .px-sv-account-value::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--px-tone-red);
}
.px-sv-account .px-sv-meter { width: 100%; }

/* ── 团队成员 ─────────────────────────────────────────────────── */
.px-sv-member {
  display: grid;
  grid-template-columns: minmax(6em, 1fr) minmax(48px, 1.2fr) auto;
  align-items: center;
  gap: 12px;
}
.px-sv-member-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.px-sv-member-value {
  font-size: 12px;
  font-weight: 600;
  text-align: right;
}

/* ── 脚注：只在数字需要打折扣时出现 ───────────────────────────── */
.px-sv-notes {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--px-line);
}
.px-sv-notes p {
  margin: 0;
  color: var(--px-detail-label);
  font-size: 11px;
  line-height: 1.6;
}

.px-sv-empty {
  margin: 0;
  padding: 16px;
  border: 1px dashed var(--px-line-2);
  border-radius: var(--px-r-md);
  color: var(--px-ink-2);
  font-size: 12px;
  text-align: center;
}

/* ── 降级卡片：四种状态各说各的下一步动作 ─────────────────────── */
/* 居中成一段话，而不是一条横幅：这一页在这种状态下**没有别的内容**，
   横幅式提示会让下面留出一大片空白，看起来像没渲染完。
   不再用 3px 左色条：那正是「侧边条纹」那种最典型的装饰，
   状态改由一个状态点 + 一行小标签表达。 */
.px-sv-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 44px 24px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
  text-align: center;
}
.px-sv-state-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.px-sv-state-mark {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--px-muted);
}
.px-sv-state-label {
  color: var(--px-ink-2);
  font-size: 11px;
  letter-spacing: 0.08em;
}
.px-sv-state-text {
  margin: 0;
  max-width: 46ch;
  color: var(--px-ink);
  font-size: 13px;
  line-height: 1.6;
  text-wrap: pretty;
}
.px-sv-state-detail {
  margin: 0;
  max-width: 46ch;
  color: var(--px-detail-label);
  font-size: 11.5px;
  word-break: break-word;
}
.px-sv-state-loading .px-sv-state-mark {
  background: var(--px-tone-blue);
  animation: px-sv-pulse 1.4s var(--px-ease) infinite;
}
.px-sv-state-missing .px-sv-state-mark,
.px-sv-state-missing-route .px-sv-state-mark { background: var(--px-tone-yellow); }
.px-sv-state-failed .px-sv-state-mark { background: var(--px-tone-red); }

.px-sv-btn {
  height: 28px;
  margin-top: 4px;
  padding: 0 16px;
  color: var(--px-ink);
  /* 按钮是「块」，用白色 + 描边（与看板 .px-btn 一致），不用次级底色。 */
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-pill);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background-color var(--px-dur) var(--px-ease), border-color var(--px-dur) var(--px-ease), transform var(--px-dur-fast) var(--px-ease);
}
/* hover 用强调色：这是这一页唯一的「主操作」。 */
.px-sv-btn:hover {
  border-color: color-mix(in srgb, var(--px-pink-deep) 55%, transparent);
  background: color-mix(in srgb, var(--px-pink-deep) 8%, transparent);
}
.px-sv-btn:active { transform: scale(0.97); }
.px-sv-btn:focus-visible { outline: none; box-shadow: var(--px-ring); }

@keyframes px-sv-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* ── 宽屏塌缩：先并排、再收列，任何宽度都不留空格子 ─────────────── */
/* 1100 以下：第二行把「耗时构成」放整行、下面两张卡并排；
   第四行三块改成两列、第三块（请求分布）跨满整行。
   跨行是刻意的——三块塞进两列必然有一个空格子，那正是要消灭的空白。 */
@media (max-width: 1100px) {
  .px-sv-band-split { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .px-sv-band-split > .px-sv-timing-cell { grid-column: 1 / -1; }
  .px-sv-band-three { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .px-sv-band-three > :last-child { grid-column: 1 / -1; }
}

/* 880 以下：四枚 hero 改成 2×2。150px 的最小宽度是主题里定的，
   四列在这个宽度会把「平均每轮 1m2s」这类脚注挤成省略号。 */
@media (max-width: 880px) {
  .px-sv-heroes { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* ── 窄屏：一列，表格去掉两家次要列，行距收紧 ───────────────────── */
@media (max-width: 720px) {
  .px-sv { padding: 16px 12px 24px; gap: 12px; }
  .px-sv-card { padding: 16px; }
  /* 720 以下所有分区行塌成单列：两列在 420 上会把「计价时段」压到
     读不出金额与占比的差别，而单列永远不会横向溢出。 */
  .px-sv-band-split,
  .px-sv-band-three { grid-template-columns: minmax(0, 1fr); }
  .px-sv-band-split > .px-sv-timing-cell,
  .px-sv-band-three > :last-child { grid-column: auto; }
  /* 提供商与单价在窄屏让位：模型 + 三档 token + 金额才是读数的主干，
     全留着就必然横向滚动。单价仍在单元格的 title 里。 */
  .px-sv-col-provider,
  .px-sv-col-unit { display: none; }
  .px-sv-table th,
  .px-sv-table td { padding: 8px 4px; }
  .px-sv-day { grid-template-columns: 2.6em minmax(28px, 1fr) auto; gap: 8px; }
  .px-sv-member { grid-template-columns: minmax(4em, 1fr) auto; }
  .px-sv-member .px-sv-meter { display: none; }
  .px-sv-state { padding: 32px 18px; }
  .px-sv-figure-value { font-size: 16px; }
}

/* 手机宽度：再把「写入」让位——它只在缓存写入发生过时才出现，
   而这一列撑出来就是一条横向滚动条。合计行仍然对得上（四桶之和在卡头）。 */
@media (max-width: 520px) {
  .px-sv-col-write { display: none; }
}

@media (max-width: 460px) {
  .px-sv-model { max-width: 9ch; }
  .px-sv-account-value { font-size: 20px; }
  .px-sv-card { padding: 12px; }
}

/* 深色：令牌已经在 body[data-ds-dark-theme] 下换过一支，这里只去掉阴影，
   免得白/深色卡片在暗底上像浮起来的纸片。 */
body[data-ds-dark-theme] .px-sv-card,
body[data-ds-dark-theme] .px-sv-state {
  box-shadow: none;
}

/* 减少动效偏好：占比条与呼吸点不再动画。 */
@media (prefers-reduced-motion: reduce) {
  .px-sv-meter-fill { transition: none; }
  .px-sv-state-loading .px-sv-state-mark { animation: none; }
}
`
