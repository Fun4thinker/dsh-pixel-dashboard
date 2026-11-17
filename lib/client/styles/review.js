/** 复盘与分页的局部样式，沿用费用标签页的主题令牌，不覆盖产品主题。 */
export const REVIEW_CSS = `
.px-review { display: grid; gap: 14px; min-width: 0; }
.px-review-panel { overflow: hidden; }
.px-review-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 20px; padding: 13px 16px; border-bottom: 1px solid var(--px-line); background: var(--px-layer-2); }
.px-review-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 12px; }
.px-review-heading h2 { margin: 0; color: var(--px-ink); font-size: 13px; font-weight: 650; }
.px-review-heading > span { color: var(--px-detail-label); font-size: 11px; }
.px-review-body { padding: 16px; min-width: 0; }
.px-review h3 { margin: 0 0 10px; font-size: 12px; font-weight: 600; color: var(--px-ink-2); }
.px-review button { font: inherit; cursor: pointer; }
.px-review button:focus-visible { outline: 2px solid var(--px-detail-accent); outline-offset: 3px; }
.px-review-choices { display: flex; gap: 2px; flex-wrap: wrap; border-radius: var(--px-r-sm); padding: 2px; background: var(--px-layer-3); }
.px-review-choices button { border: 1px solid transparent; background: transparent; color: var(--px-detail-label); font-size: 11px; padding: 5px 10px; border-radius: 6px; white-space: nowrap; }
.px-review-choices button:hover { color: var(--px-ink); }
.px-review-choices button.selected { background: var(--px-surface); border-color: var(--px-line); color: var(--px-ink); box-shadow: var(--px-elev-1); }
.px-review-habit-summary { display: flex; gap: 20px 40px; flex-wrap: wrap; margin-bottom: 20px; }
.px-review-habit-summary > span { display: flex; align-items: baseline; gap: 10px; color: var(--px-detail-label); font-size: 11px; }
.px-review-habit-summary b { color: var(--px-ink); font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
.px-review-habits { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 28px; }
.px-review-hours-wrap, .px-review-week-wrap { min-width: 0; }
.px-review-hours { height: 166px; display: grid; grid-template-columns: repeat(24, minmax(0, 1fr)); gap: 5px; }
.px-review-hour { display: flex; flex-direction: column; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--px-detail-label); min-width: 0; }
.px-review-hour-rail { width: 100%; height: 144px; display: flex; align-items: flex-end; border-bottom: 1px solid var(--px-line-2); }
.px-review-hour-rail > i { display: block; width: 100%; min-width: 1px; background: var(--px-blue-deep); border-radius: 3px 3px 0 0; transition: height 160ms ease; }
.px-review-hour:hover .px-review-hour-rail, .px-review-hour[aria-pressed="true"] .px-review-hour-rail { background: var(--px-layer-3); }
.px-review-hour[aria-pressed="true"] .px-review-hour-rail > i { background: var(--px-detail-accent); }
.px-review-hour-label { font-size: 9px; line-height: 22px; align-self: center; }
.px-review-week-scroll { overflow-x: auto; padding: 0 2px 3px; }
.px-review-week { display: grid; grid-template-columns: 28px repeat(24, minmax(11px, 1fr)); gap: 4px; min-width: 390px; }
.px-review-week-hour { color: var(--px-detail-label); font-size: 9px; text-align: center; line-height: 15px; }
.px-review-week-label { color: var(--px-detail-label); font-size: 10px; line-height: 16px; }
.px-review-cell { height: 16px; min-width: 0; border-radius: 3px; border: 0; padding: 0; display: block; background: var(--px-layer-3); }
.px-review-cell.level-1 { background: color-mix(in srgb, var(--px-green-deep) 22%, var(--px-surface)); }
.px-review-cell.level-2 { background: color-mix(in srgb, var(--px-green-deep) 44%, var(--px-surface)); }
.px-review-cell.level-3 { background: color-mix(in srgb, var(--px-green-deep) 70%, var(--px-surface)); }
.px-review-cell.level-4 { background: var(--px-green-deep); }
.px-review-cell[aria-pressed="true"] { outline: 2px solid var(--px-detail-accent); outline-offset: 1px; }
.px-review-heat-legend { display: flex; align-items: center; justify-content: flex-end; gap: 4px; color: var(--px-detail-label); font-size: 10px; margin-top: 5px; }
.px-review-heat-legend i { width: 10px; height: 10px; }
.px-review-selection { min-height: 17px; margin: 14px 0 6px; font-size: 11px; color: var(--px-ink-2); }
.px-review-note { font-size: 11px; color: var(--px-detail-label); line-height: 1.7; margin: 8px 0 0; }
.px-review-status { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 14px; color: var(--px-ink-2); font-size: 12px; border: 1px solid var(--px-line-2); background: var(--px-surface); border-radius: var(--px-r-sm); }
.px-review-ledger-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 15px; padding: 0 0 16px; border-bottom: 1px solid var(--px-line); }
.px-review-mini { display: flex; flex-direction: column; gap: 5px; color: var(--px-detail-label); font-size: 11px; }
.px-review-mini b { color: var(--px-ink); font-size: 19px; line-height: 1.3; font-weight: 650; font-variant-numeric: tabular-nums; }
.px-review-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; margin: 14px 0 5px; }
.px-review-toolbar .px-review-note { margin: 0; }
.px-review-list { min-width: 0; }
.px-review-item { border-bottom: 1px solid var(--px-line); }
.px-review-item:last-child { border-bottom: 0; }
.px-review-row { display: grid; grid-template-columns: 26px minmax(0, 1fr) 152px 16px; align-items: center; gap: 12px; width: 100%; text-align: left; color: var(--px-ink); background: transparent; border: 0; padding: 13px 4px; border-radius: 6px; }
.px-review-row:hover, .px-review-item.open > .px-review-row { background: var(--px-layer-2); }
.px-review-rank { font-size: 11px; color: var(--px-detail-label); font-variant-numeric: tabular-nums; }
.px-review-copy { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.px-review-row-title { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 8px; min-width: 0; font-size: 12px; }
.px-review-row-title > b { font-weight: 600; overflow-wrap: anywhere; }
.px-review-row-meta { font-size: 11px; color: var(--px-detail-label); line-height: 1.6; overflow-wrap: anywhere; }
.px-review-row-value { display: flex; flex-direction: column; gap: 4px; text-align: right; min-width: 0; font-variant-numeric: tabular-nums; }
.px-review-row-value > b { font-size: 15px; font-weight: 650; }
.px-review-row-value > span { font-size: 10px; color: var(--px-detail-label); }
.px-review-share { display: block; height: 3px; background: var(--px-layer-3); border-radius: 3px; overflow: hidden; }
.px-review-share > i { height: 100%; display: block; background: var(--px-detail-accent); border-radius: inherit; }
.px-review-chevron { text-align: center; color: var(--px-detail-label); }
.px-review-source { display: inline-flex; align-items: center; color: var(--px-ink-2); border: 1px solid var(--px-line-2); border-radius: 5px; padding: 1px 5px; font-size: 10px; font-weight: 400; line-height: 1.6; white-space: nowrap; }
.px-review-source.third-party { color: color-mix(in srgb, var(--px-purple-deep) 60%, var(--px-ink)); border-color: color-mix(in srgb, var(--px-purple-deep) 35%, transparent); background: color-mix(in srgb, var(--px-purple-deep) 7%, transparent); }
.px-review-source.unknown { color: var(--px-detail-label); border-style: dashed; }
.px-review-detail { padding: 10px 12px 17px 42px; }
.px-review-detail-top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
.px-review-detail-top .px-review-note { margin: 0; }
.px-review-path { color: var(--px-detail-label); font-size: 11px; overflow-wrap: anywhere; margin: 0 0 12px; }
.px-review-workspace { width: 100%; min-width: 0; container-type: inline-size; container-name: px-review-workspace; }
.px-review-workspace-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 10px 16px; flex-wrap: wrap; margin-bottom: 12px; }
.px-review-workspace-toolbar h3 { margin: 0; }
.px-review-child-list { display: grid; gap: 0; width: 100%; min-width: 0; max-height: 620px; overflow: auto; }
.px-review-child-item { min-width: 0; width: 100%; }
.px-review-child-head { position: sticky; top: 0; z-index: 1; display: grid; grid-template-columns: minmax(150px, 1.5fr) minmax(130px, 1fr) minmax(80px, .65fr) minmax(80px, .65fr) minmax(80px, .65fr) 14px; align-items: center; gap: 12px; padding: 9px 10px; color: var(--px-detail-label); background: var(--px-layer-2); border-bottom: 1px solid var(--px-line); font-size: 10.5px; }
.px-review-child-head > span:not(:first-child) { text-align: right; }
.px-review-child-detail { padding: 12px 4px 14px; border-bottom: 1px solid var(--px-line); }
.px-review-hour:disabled, .px-review-cell:disabled { cursor: default; }
.px-review-child { display: grid; grid-template-columns: minmax(150px, 1.5fr) minmax(130px, 1fr) minmax(80px, .65fr) minmax(80px, .65fr) minmax(80px, .65fr) 14px; width: 100%; box-sizing: border-box; align-items: center; gap: 12px; padding: 12px 10px; text-align: left; border: 0; border-bottom: 1px solid var(--px-line); background: transparent; color: var(--px-ink-2); font-size: 11px !important; }
.px-review-child:hover, .px-review-child[aria-expanded="true"] { background: var(--px-layer-2); }
.px-review-child-name { display: flex; flex-direction: column; gap: 5px; min-width: 0; overflow-wrap: anywhere; }
.px-review-child-name b { font-weight: 600; color: var(--px-ink); }
.px-review-child-name small { color: var(--px-detail-label); font-size: 10px; }
.px-review-child > [data-label] { text-align: right; font-variant-numeric: tabular-nums; }
.px-review-child-recent { color: var(--px-detail-label); font-size: 10.5px; }
.px-review-child-toggle { text-align: center; color: var(--px-detail-label); }
.px-review-account-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 26px; }
.px-review-account-line { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: baseline; gap: 10px; font-size: 11px; padding: 8px 0; border-bottom: 1px solid var(--px-line); }
.px-review-account-line > span:first-child { overflow-wrap: anywhere; }
.px-review-account-line .px-review-note { margin: 0; }
.px-review-day-list { max-height: 220px; overflow: auto; padding-right: 5px; }
.px-review-session-tools { margin-top: 16px; }
.px-review-tool-tags { display: flex; gap: 8px 16px; flex-wrap: wrap; }
.px-review-tool-tags > span { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.px-review-tool-origin { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 11px; }
.px-review-tool-origin code { overflow-wrap: anywhere; color: var(--px-detail-label); font-size: 10px; }
.px-review-slowest { margin: 12px 0 18px; }
.px-review-activity { max-height: 340px; overflow: auto; padding-right: 5px; }
.px-review-activity-row { display: grid; grid-template-columns: 130px minmax(0, 1fr) 110px 65px; align-items: baseline; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--px-line); font-size: 11px; }
.px-review-activity-row time, .px-review-call-status { color: var(--px-detail-label); }
.px-review-call-status.error { color: var(--px-tone-red); }
.px-review-activity-row button { text-align: left; border: 0; padding: 0; background: transparent; color: var(--px-ink-2); overflow-wrap: anywhere; }
.px-review-activity-row button:hover { color: color-mix(in srgb, var(--px-detail-accent) 60%, var(--px-ink)); text-decoration: underline; }
.px-review-activity-row > b { text-align: right; font-variant-numeric: tabular-nums; }
.px-review-more { display: block; margin: 12px auto 4px; }
.px-review-empty { padding: 24px 8px; margin: 0; color: var(--px-detail-label); font-size: 12px; text-align: center; }
/* 分页与异步状态只作用于插件自己的页面。 */
.px-dashboard-pages { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; padding: 0 0 14px; }
.px-dashboard-pages button { display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 10px 14px; border: 1px solid var(--px-line); border-radius: var(--px-r-md); background: var(--px-surface); color: var(--px-detail-label); font-family: inherit; cursor: pointer; }
.px-dashboard-pages button b { font-size: 12px; font-weight: 600; color: var(--px-ink-2); }
.px-dashboard-pages button span { font-size: 10px; }
.px-dashboard-pages button.selected { border-color: var(--px-detail-accent-line); background: var(--px-detail-accent-soft); box-shadow: inset 0 -2px var(--px-detail-accent); }
.px-dashboard-pages button.selected b { color: color-mix(in srgb, var(--px-detail-accent) 60%, var(--px-ink)); }
.px-dashboard-pages button:focus-visible { outline: 2px solid var(--px-detail-accent); outline-offset: 2px; }
.px-dashboard-page { min-block-size: 420px; }
.px-sv-duration-note { margin: -4px 0 14px; line-height: 1.7; white-space: normal; }
.px-review-page { gap: 8px; }
.px-review-page .px-review-panel { margin-bottom: 0; }
.px-review-scope-bar, .px-review-load-status { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 14px; }
.px-review-scope-bar .px-review-note { margin: 0; }
.px-review-load-status { min-height: 30px; color: var(--px-detail-label); font-size: 11px; }
.px-review-load-status.error { color: var(--px-tone-red); }
.px-review-content { min-block-size: 480px; }
.px-review.is-switching .px-review-content { opacity: .55; pointer-events: none; }
.px-review-skeleton-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
.px-review-skeleton-metrics > i { height: 88px; display: block; border-radius: var(--px-r-md); background: var(--px-layer-3); }
.px-review-skeleton-row { min-height: 66px; display: grid; grid-template-columns: 32px minmax(0, 1fr) 100px; gap: 14px; align-items: center; padding: 10px; border-bottom: 1px solid var(--px-line); }
.px-review-skeleton-row i { display: block; height: 12px; border-radius: 4px; background: var(--px-layer-3); }
.px-review-skeleton-row i:first-child { height: 30px; }
.px-review-skeleton-chart { height: 260px; border-radius: var(--px-r-md); background: var(--px-layer-3); }
.px-review .px-hero-yellow { --px-accent: var(--px-tone-yellow); }
.px-review-ledger-summary.px-heroes { padding-bottom: 0; border-bottom: 0; margin-bottom: 12px; }
.px-review-ledger-summary .px-hero { box-shadow: none; background: linear-gradient(125deg, color-mix(in srgb, var(--px-accent) 6%, transparent), transparent), var(--px-surface); }
.px-review-ledger-summary .px-hero-value { color: var(--px-ink); }
.px-review-coverage { display: flex; align-items: center; gap: 7px 16px; flex-wrap: wrap; color: var(--px-detail-label); font-size: 10.5px; padding-bottom: 5px; }
.px-review-coverage > span:first-child { color: color-mix(in srgb, var(--px-detail-accent) 60%, var(--px-ink)); font-weight: 600; }
.px-review-third-party { color: color-mix(in srgb, var(--px-purple-deep) 60%, var(--px-ink)); }
.px-review-list { --review-metric: var(--px-detail-accent); --review-text: color-mix(in srgb, var(--review-metric) 60%, var(--px-ink)); }
.px-review-list.metric-durationMs, .px-review-list.metric-maxMs { --review-metric: var(--px-green-deep); }
.px-review-list.metric-tokens { --review-metric: var(--px-blue-deep); }
.px-review-list.metric-calls { --review-metric: var(--px-purple-deep); }
.px-review-list .px-review-item { border: 1px solid var(--px-line); border-left: 3px solid color-mix(in srgb, var(--review-metric) 38%, transparent); border-radius: var(--px-r-md); margin: 8px 0; overflow: hidden; }
.px-review-list .px-review-row { padding: 12px; min-height: 68px; }
.px-review-list .px-review-rank { display: inline-grid; place-items: center; width: 26px; height: 28px; border-radius: 7px; color: var(--review-text); background: color-mix(in srgb, var(--review-metric) 10%, transparent); font-weight: 600; }
.px-review-list .px-review-row-value > b { color: var(--review-text); }
.px-review-list .px-review-share > i { background: var(--review-metric); }
.px-review-list .px-review-share { height: 4px; }
.px-review-list .px-review-item.open { border-color: color-mix(in srgb, var(--review-metric) 35%, var(--px-line)); }
.px-review-pagination { display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-height: 42px; color: var(--px-detail-label); font-size: 11px; }
.px-review-pagination > span { margin-right: auto; }
.px-review button:disabled { cursor: default; opacity: .45; }
.px-review-session-receipt { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px 24px; margin: 0 0 15px; font-size: 11px; color: var(--px-detail-label); }
.px-review-session-receipt b { font-size: 15px; font-weight: 650; margin-left: 4px; }
.px-review-money { color: color-mix(in srgb, var(--px-detail-accent) 60%, var(--px-ink)); }
.px-review-effective { color: color-mix(in srgb, var(--px-green-deep) 60%, var(--px-ink)); }
.px-review-wait { color: color-mix(in srgb, var(--px-yellow-deep) 60%, var(--px-ink)); }
.px-review-account-card { padding: 12px; border: 1px solid var(--px-line); border-radius: var(--px-r-md); border-top: 2px solid var(--px-detail-accent-line); }
.px-review-account-card.days { border-top-color: var(--px-blue-deep); }
.px-review-model-money { padding-bottom: 6px; }
.px-review-model-name { display: flex; align-items: center; gap: 6px; }
.px-review-model-dot { flex: none; height: 6px; width: 6px; border-radius: 50%; }
.px-review-model-track { grid-column: 1 / -1; height: 3px; background: var(--px-layer-3); display: block; border-radius: 3px; overflow: hidden; }
.px-review-model-track > i { display: block; height: 100%; border-radius: inherit; }
.px-review .color-0 { background: var(--px-detail-accent); }
.px-review .color-1 { background: var(--px-blue-deep); }
.px-review .color-2 { background: var(--px-purple-deep); }
.px-review .color-3 { background: var(--px-green-deep); }
.px-review-list.metric-activityAt .px-review-row-value > b { font-size: 12px; line-height: 1.5; }
.px-review-team-account { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--px-line); min-width: 0; }
.px-review-team-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; }
.px-review-team-heading h3, .px-review-team-heading .px-review-note { margin: 0; }
.px-review-team-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; padding: 14px 0 4px; }
.px-review-team-metrics > span { display: flex; flex-direction: column; gap: 6px; color: var(--px-detail-label); font-size: 10.5px; }
.px-review-team-metrics b { color: var(--px-ink); font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.px-review-team-scroll { overflow-x: auto; margin-top: 12px; }
.px-review-team-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.px-review-team-table th { color: var(--px-detail-label); font-size: 10px; font-weight: 500; text-align: right; padding: 8px 10px; background: var(--px-layer-2); }
.px-review-team-table td { padding: 10px; border-bottom: 1px solid var(--px-line); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--px-ink-2); }
.px-review-team-table th:first-child, .px-review-team-table td:first-child { text-align: left; width: 40%; white-space: normal; overflow-wrap: anywhere; }
.px-review-team-member button { text-align: left; color: var(--px-ink); background: transparent; border: 0; padding: 0; font-weight: 600; overflow-wrap: anywhere; }
.px-review-team-member button:hover { text-decoration: underline; }
.px-review-team-member > span { display: block; margin-top: 5px; color: var(--px-detail-label); font-size: 10px; }
.px-review-wait-note { border-left: 2px solid var(--px-yellow-deep); padding: 7px 10px; font-size: 11px; line-height: 1.7; color: var(--px-ink-2); background: color-mix(in srgb, var(--px-yellow-deep) 6%, transparent); }
@media (max-width: 1000px) {
  .px-review-habits { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .px-review-account-grid { grid-template-columns: minmax(0, 1fr); gap: 18px; }
  .px-review-child-head, .px-review-child { grid-template-columns: minmax(130px, 1.3fr) minmax(115px, 1fr) repeat(3, minmax(65px, .6fr)) 12px; gap: 8px; }
}
@container px-review-workspace (max-width: 720px) {
  .px-review-child-head { display: none; }
  .px-review-child { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px 16px; }
  .px-review-child-name { grid-column: 1 / -1; padding-right: 20px; }
  .px-review-child-toggle { grid-column: 2; grid-row: 1; justify-self: end; }
  .px-review-child > [data-label] { text-align: left; font-size: 11px; }
  .px-review-child > [data-label]::before { content: attr(data-label); display: block; font-weight: 400; font-size: 10px; margin-bottom: 3px; color: var(--px-detail-label); }
}
@media (max-width: 760px) {
  .px-review-child-head { display: none; }
  .px-review-child { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px 16px; }
  .px-review-child-name { grid-column: 1 / -1; padding-right: 20px; }
  .px-review-child-toggle { grid-column: 2; grid-row: 1; justify-self: end; }
  .px-review-child > [data-label] { text-align: left; font-size: 11px; }
  .px-review-child > [data-label]::before { content: attr(data-label); display: block; font-weight: 400; font-size: 10px; margin-bottom: 3px; color: var(--px-detail-label); }
}
@media (max-width: 600px) {
  .px-dashboard-pages { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .px-dashboard-pages button { padding: 9px 10px; }
  .px-review-skeleton-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .px-review-ledger-summary .px-hero-value { font-size: 20px; }
  .px-review-ledger-summary .px-hero-foot { white-space: normal; min-height: 27px; }
  .px-review-pagination { gap: 7px; }
  .px-review-pagination > span { font-size: 10px; }
  .px-review-list .px-review-row { padding: 10px 7px; }
  .px-review-head { padding: 12px; }
  .px-review-body { padding: 12px; }
  .px-review-habit-summary { gap: 10px 20px; }
  .px-review-habit-summary > span { flex-direction: column; gap: 4px; }
  .px-review-habit-summary b { font-size: 13px; }
  .px-review-hours { gap: 3px; }
  .px-review-ledger-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .px-review-mini b { font-size: 17px; }
  .px-review-row { grid-template-columns: 20px minmax(0, 1fr) 84px 10px; gap: 7px; }
  .px-review-row-value > b { font-size: 13px; }
  .px-review-row-value > span { font-size: 9px; }
  .px-review-detail { padding: 10px 0 14px 27px; }
  .px-review-child { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px 14px; }
  .px-review-activity-row { grid-template-columns: minmax(0, 1fr) 64px; gap: 6px 10px; }
  .px-review-activity-row time { grid-column: 1; grid-row: 1; }
  .px-review-activity-row button { grid-column: 1; grid-row: 2; }
  .px-review-activity-row .px-review-call-status { grid-column: 2; grid-row: 2; text-align: right; font-size: 9px; }
  .px-review-activity-row > b { grid-column: 2; grid-row: 1; }
  .px-review-account-line { gap: 6px; }
  .px-review-team-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .px-review-team-table, .px-review-team-table tbody { display: block; width: 100%; }
  .px-review-team-table thead { display: none; }
  .px-review-team-table tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 14px; padding: 10px 0; border-bottom: 1px solid var(--px-line); }
  .px-review-team-table td { padding: 3px 0; border: 0; text-align: left; }
  .px-review-team-table td:first-child { grid-column: 1 / -1; width: auto; }
  .px-review-team-table td[data-label]::before { content: attr(data-label); display: block; color: var(--px-detail-label); font-size: 10px; margin-bottom: 3px; }
}
@media (prefers-reduced-motion: reduce) { .px-review-hour-rail > i { transition: none; } }
`
