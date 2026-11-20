/** A compact receipt using the existing dashboard palette; no changes to host theming. */
export const SUBSCRIPTION_VALUE_CSS = `
.px-value-root {
  --px-value-accent: var(--px-tone-purple, var(--dsw-alias-brand-primary));
  --px-value-blue: var(--px-tone-blue, var(--dsw-alias-brand-primary));
  --px-value-pink: var(--px-tone-pink, var(--dsw-alias-brand-primary));
  --px-value-ink: var(--px-ink, var(--dsw-alias-label-primary));
  --px-value-muted: var(--px-detail-label, var(--dsw-alias-label-secondary));
  --px-value-surface: var(--px-surface, var(--dsw-alias-bg-layer-1));
  --px-value-line: var(--px-line, var(--dsw-alias-border-l1));
  --px-value-stroke: var(--px-line-2, var(--dsw-alias-border-l2));
  display: grid;
  min-width: 0;
  gap: 8px;
  padding: 11px 13px;
  border: 1px solid var(--px-value-line);
  border-radius: var(--px-r-md, 12px);
  box-shadow: var(--px-elev-1);
  background: var(--px-value-surface);
  color: var(--px-value-ink);
  overflow-wrap: anywhere;
  line-height: 1.4;
}
.px-value-header, .px-value-heading, .px-value-actions, .px-value-context, .px-value-detail-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 8px;
  min-width: 0;
}
.px-value-header, .px-value-context, .px-value-detail-head { justify-content: space-between; }
.px-value-heading { flex: 1 1 auto; }
.px-value-heading-icon {
  flex: none;
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 8px;
  color: color-mix(in srgb, var(--px-value-accent) 75%, var(--px-value-ink));
  background: color-mix(in srgb, var(--px-value-accent) 16%, var(--px-value-surface));
}
.px-value-title, .px-value-subtitle { margin: 0; font-size: 13px; font-weight: 650; }
.px-value-title { font-size: 14px; }
.px-value-route-label { font-size: 12px; color: var(--px-value-muted); }
.px-value-muted, .px-value-note, .px-value-error, .px-value-confirm p { margin: 0; }
.px-value-muted, .px-value-note, .px-value-context { font-size: 11.5px; color: var(--px-value-muted); }
.px-value-note[data-warn], .px-value-error { color: color-mix(in srgb, var(--px-tone-red, var(--dsw-alias-state-error-primary)) 65%, var(--px-value-ink)); }
.px-value-error { font-size: 12px; }
.px-value-button, .px-value-input {
  box-sizing: border-box;
  color: var(--px-value-ink);
  background: var(--px-value-surface);
  border: 1px solid var(--px-value-stroke);
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
  line-height: 1.25;
  min-height: 27px;
  max-width: 100%;
  min-width: 0;
  padding: 3px 8px;
}
.px-value-button { cursor: pointer; }
.px-value-header .px-value-input { max-width: min(16rem, 100%); }
.px-value-button:not(:disabled):hover { background: color-mix(in srgb, var(--px-value-accent) 8%, var(--px-value-surface)); }
.px-value-button[data-primary], .px-value-button[aria-pressed=true], .px-value-button[aria-expanded=true] {
  background: color-mix(in srgb, var(--px-value-accent) 13%, var(--px-value-surface));
  border-color: color-mix(in srgb, var(--px-value-accent) 35%, var(--px-value-stroke));
  font-weight: 620;
}
.px-value-button[data-danger] { color: color-mix(in srgb, var(--px-tone-red, var(--dsw-alias-state-error-primary)) 65%, var(--px-value-ink)); }
.px-value-button:disabled, .px-value-input:disabled { opacity: .6; cursor: default; }
.px-value-button:focus-visible, .px-value-input:focus-visible, .px-value-title:focus-visible, .px-value-rules summary:focus-visible {
  outline: 2px solid var(--px-value-accent);
  outline-offset: 2px;
}
.px-value-receipt {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
  gap: 7px;
  margin: 0;
}
.px-value-metric {
  --px-value-metric-tone: var(--px-value-accent);
  min-width: 0;
  display: grid;
  align-content: center;
  gap: 2px;
  padding: 5px 9px;
  border-inline-start: 2px solid color-mix(in srgb, var(--px-value-metric-tone) 58%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--px-value-metric-tone) 7%, var(--px-value-surface));
}
.px-value-metric[data-tone=quota] { --px-value-metric-tone: var(--px-value-blue); }
.px-value-metric[data-tone=amount] { --px-value-metric-tone: var(--px-value-pink); }
.px-value-metric[data-tone=power] { background: color-mix(in srgb, var(--px-value-accent) 15%, var(--px-value-surface)); }
.px-value-metric dt { color: var(--px-value-muted); font-size: 11.5px; }
.px-value-metric dd {
  margin: 0;
  color: color-mix(in srgb, var(--px-value-ink) 70%, var(--px-value-metric-tone));
  font-size: 20px;
  font-weight: 680;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
}
.px-value-track {
  position: relative;
  overflow: hidden;
  border-radius: var(--px-r-pill, 999px);
  height: 5px;
  background: color-mix(in srgb, var(--px-value-accent) 11%, var(--px-value-surface));
}
.px-value-track[data-quota] {
  height: 3px;
  margin-block-start: 2px;
  background: color-mix(in srgb, var(--px-value-blue) 19%, var(--px-value-surface));
}
.px-value-track[data-unknown] { border: 1px dashed var(--px-value-stroke); box-sizing: border-box; }
.px-value-fill { display: block; height: 100%; background: color-mix(in srgb, var(--px-value-blue) 65%, var(--px-value-ink)); border-radius: inherit; }
.px-value-fill[data-current] { background: color-mix(in srgb, var(--px-value-accent) 65%, var(--px-value-ink)); }
.px-value-track[data-quota] .px-value-fill { background: color-mix(in srgb, var(--px-value-blue) 65%, var(--px-value-ink)); }
.px-value-baseline-mark { position: absolute; inset-block: 0; width: 1px; background: var(--px-value-ink); opacity: .7; }
.px-value-context strong { font-weight: 620; color: var(--px-value-ink); }
.px-value-line, .px-value-empty { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 8px; }
.px-value-details, .px-value-editor { min-width: 0; display: grid; gap: 8px; border-top: 1px solid var(--px-value-line); padding-top: 8px; }
.px-value-compare-list, .px-value-quality { padding: 0; margin: 0; list-style: none; font-size: 11.5px; }
.px-value-compare-list {
  display: grid;
  grid-template-columns: min(54%, 21rem) minmax(0, 1fr) minmax(5ch, auto);
  column-gap: 10px;
}
.px-value-compare-row {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: min(54%, 21rem) minmax(0, 1fr) 7ch;
  grid-template-columns: subgrid;
  align-items: center;
  column-gap: 10px;
  padding: 4px 0;
  min-width: 0;
  border-bottom: 1px solid var(--px-value-line);
  color: var(--px-value-muted);
}
.px-value-compare-label, .px-value-compare-row .px-value-track { min-width: 0; }
.px-value-compare-reading { min-width: 5ch; color: var(--px-value-ink); text-align: end; font-variant-numeric: tabular-nums; }
.px-value-compare-row[data-current] .px-value-compare-reading { color: color-mix(in srgb, var(--px-value-accent) 70%, var(--px-value-ink)); }
.px-value-quality { display: flex; flex-wrap: wrap; gap: 3px 10px; color: var(--px-value-muted); }
.px-value-quality li { min-width: 0; }
.px-value-rules { font-size: 11.5px; color: var(--px-value-muted); }
.px-value-rules summary { cursor: pointer; width: fit-content; color: var(--px-value-ink); }
.px-value-rules ul { margin: 5px 0 0; padding-inline-start: 20px; }
.px-value-fieldset { display: grid; min-width: 0; gap: 8px; border: 0; padding: 0; margin: 0; }
.px-value-fieldset[hidden] { display: none; }
.px-value-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); gap: 8px 12px; }
.px-value-field { display: grid; align-content: start; gap: 4px; min-width: 0; font-size: 12px; }
.px-value-field-wide { grid-column: 1 / -1; }
.px-value-field .px-value-input { width: 100%; }
.px-value-confirm { display: grid; gap: 8px; border-inline-start: 2px solid var(--px-tone-red, var(--dsw-alias-state-error-primary)); padding-inline-start: 10px; font-size: 12px; }
.px-value-editor .px-value-error { margin-top: 6px; }
`
