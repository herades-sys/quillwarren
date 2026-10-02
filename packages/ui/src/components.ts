// Delve's component layer on top of Nocturne: everything the design shows in
// "Components and their states" (docs/design/ui-v1/Delve Design System.dc.html),
// as classes. Values come from the tokens; the few raw numbers are the design's
// own (a 38 × 36 tool button, a 34 × 20 switch).
//
// Hover, active and focus each have a class twin (.is-hover, .is-active,
// .is-focus) so the style guide at /ui can draw every state side by side with
// the real rules. Pages never need them.

export const COMPONENTS_CSS = `
/* ---------- page and type ---------- */
html { -webkit-text-size-adjust: 100%; }
body { font-size: var(--text-md); line-height: var(--leading-ui); }
a:hover { color: var(--color-accent-text); }
kbd { font-family: inherit; }
code, pre, .mono { font-family: var(--font-mono); }
.icon { display: block; flex: none; }
.display-xl, .display-lg, .display-md, .display-sm, .display { font-family: var(--font-display); font-weight: 400; letter-spacing: 0; margin: 0; }
.display-xl { font-size: var(--display-xl); line-height: 1; }
.display-lg { font-size: var(--display-lg); line-height: 1.1; }
.display-md { font-size: var(--display-md); line-height: var(--leading-tight); }
.display-sm { font-size: var(--display-sm); line-height: var(--leading-tight); }
.numeral { font-family: var(--font-numeral); letter-spacing: .02em; }
.kicker { font-size: var(--text-xs); letter-spacing: .08em; text-transform: uppercase; color: var(--color-text-muted); }
.kicker.faint, .state-label { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--color-text-faint); }
.text-muted, .muted { color: var(--color-text-muted); }
.text-faint { color: var(--color-text-faint); }
.text-accent { color: var(--color-accent-text); }
.text-danger { color: var(--color-danger); }
.text-warning { color: var(--color-warning); }
.lead { font-size: 16px; line-height: 1.6; color: var(--color-text-muted); max-width: 760px; text-wrap: pretty; }
.vsep { width: 1px; height: 20px; flex: none; background: var(--color-border-strong); }
.hsep { height: 1px; width: 24px; flex: none; background: var(--color-border-strong); }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.stack { display: flex; flex-direction: column; gap: var(--space-4); }
.spacer { flex: 1; }
.visually-hidden { position: absolute !important; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* Document pages (account, admin, the style guide): a little larger than the app's 13 px. */
.page { width: 100%; max-width: 1040px; margin: 0 auto; padding: var(--space-10) var(--space-8) var(--space-12); display: flex; flex-direction: column; gap: var(--space-8); font-size: 14px; line-height: 1.5; }
.page-narrow { max-width: 460px; padding-top: max(var(--space-10), 8vh); }

/* ---------- top bar ---------- */
.topbar { height: var(--bar-h); flex: none; display: flex; align-items: center; gap: var(--space-3); padding: 0 var(--space-3) 0 var(--space-5); background: var(--color-surface); box-shadow: inset 0 -1px 0 var(--color-border); position: relative; z-index: 20; font-size: var(--text-md); }
.topbar-brand { font-family: var(--font-display); font-size: 24px; line-height: 1; padding-top: 2px; color: var(--color-text); text-decoration: none; }
.topbar-brand:hover { color: var(--color-text); }
.topbar .vsep { margin: 0 2px; }
.crumb { color: var(--color-text-muted); text-decoration: none; white-space: nowrap; }
.crumb:hover { color: var(--color-text); }
.crumb-title { font-family: var(--font-display); font-size: 18px; line-height: 1; white-space: nowrap; padding-top: 2px; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.crumb-sep { color: var(--color-text-faint); }
.topbar-end { margin-left: auto; display: flex; align-items: center; gap: var(--space-1); min-width: 0; }
.topbar-end > * { flex: none; }
.avatar { width: 28px; height: 28px; flex: none; border-radius: 50%; display: grid; place-items: center; background: var(--tint-accent-bg); color: var(--tint-accent-fg); font-size: var(--text-xs); font-weight: 600; letter-spacing: .02em; }
.avatar-sm { width: 24px; height: 24px; font-size: var(--text-2xs); }
.avatar-lg { width: 44px; height: 44px; font-size: var(--text-md); box-shadow: 0 0 0 2px var(--canvas-floor), 0 0 0 3px var(--color-border-strong); }
.avatar-ink { background: #5B6E8C; color: var(--canvas-floor); }

/* ---------- buttons ---------- */
.btn { height: var(--control-md); padding: 0 10px; font-size: var(--text-md); white-space: nowrap; transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
.btn:disabled, .btn[aria-disabled="true"] { opacity: .45; cursor: not-allowed; pointer-events: none; }
.btn .key, .key-hint { font-size: var(--text-xs); color: var(--color-text-faint); font-weight: 400; }
.btn-primary.is-hover { background: color-mix(in srgb, var(--color-accent) 12%, transparent); }
.btn-primary.is-active { background: color-mix(in srgb, var(--color-accent) 22%, transparent); }
.btn-secondary:hover, .btn-secondary.is-hover, .btn-plain:hover, .btn-plain.is-hover { background: var(--color-hover); }
.btn-secondary:active, .btn-secondary.is-active, .btn-plain:active, .btn-plain.is-active { background: var(--color-press); }
.btn-plain { color: var(--color-text); }
.btn-ghost { padding-inline: var(--space-3); }
.btn-ghost.is-hover { background: color-mix(in srgb, var(--color-accent) 10%, transparent); }
.btn-danger { color: var(--color-danger); border-color: color-mix(in srgb, var(--color-danger) 70%, transparent); }
.btn-danger:hover, .btn-danger.is-hover { background: color-mix(in srgb, var(--color-danger) 12%, transparent); }
.btn-danger:active, .btn-danger.is-active { border-color: var(--color-danger); background: color-mix(in srgb, var(--color-danger) 22%, transparent); }
.btn-sm { height: var(--control-sm); padding: 0 8px; font-size: var(--text-sm); }
.btn-lg { height: var(--control-lg); padding: 0 14px; font-size: 14px; }
.btn-touch { height: auto; min-height: var(--touch); padding: 0 16px; font-size: var(--text-lg); }
.btn-block { width: 100%; }
.btn-icon { width: var(--control-md); height: var(--control-md); padding: 0; color: var(--color-text-muted); }
.btn-icon:hover, .btn-icon.is-hover { background: var(--color-hover); color: var(--color-text); }
.btn-icon[aria-pressed="true"], .btn-icon.is-active { background: var(--tint-accent-bg); color: var(--color-accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent); }
.btn-icon.btn-primary { color: var(--color-accent); }
.is-focus { outline: 2px solid var(--color-accent); outline-offset: 2px; }
button { font: inherit; }

kbd, .kbd { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px; border-radius: var(--radius-sm); font-size: 10.5px; line-height: 1; color: var(--color-text-muted); background: var(--color-bg); box-shadow: 0 0 0 1px var(--color-border-strong); white-space: nowrap; }

/* ---------- segmented control and tabs ---------- */
.seg { font-size: var(--text-md); }
.seg-opt { color: var(--color-text); }
.seg-opt.is-hover { background: var(--color-hover); }
.seg-opt.is-on { color: var(--color-accent); box-shadow: inset 0 0 0 1px var(--color-accent); }
.seg-opt.is-focus { outline: 2px solid var(--color-accent); outline-offset: -2px; }
.seg-opt:has(input:disabled), .seg-opt.is-disabled { opacity: .45; cursor: not-allowed; }
.seg-sm .seg-opt { padding: 4px 8px; gap: 4px; }
.seg-ground { background: var(--color-bg); }

.tabs { display: flex; gap: var(--space-6); height: 38px; box-shadow: inset 0 -1px 0 var(--color-border); }
.tab { display: flex; align-items: center; gap: var(--space-2); padding: 0; border: 0; background: none; color: var(--color-text-muted); font: inherit; cursor: pointer; text-decoration: none; }
.tab:hover, .tab.is-hover { color: var(--color-text); box-shadow: inset 0 -2px 0 var(--color-border-strong); }
.tab[aria-selected="true"], .tab[aria-current="page"] { color: var(--color-text); box-shadow: inset 0 -2px 0 var(--color-accent); }
.tab:focus-visible, .tab.is-focus { outline: 2px solid var(--color-accent); outline-offset: -4px; border-radius: 6px; padding: 0 6px; }
.tab[aria-disabled="true"] { opacity: .45; cursor: not-allowed; }

/* ---------- tool rail, tooltip, context bar ---------- */
.rail { width: var(--rail-w); flex: none; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: var(--space-3) 0; background: var(--color-surface); }
.rail-sep { width: 24px; height: 1px; background: var(--color-border-strong); margin: 5px 0; flex: none; }
.tool { width: 38px; height: 36px; display: grid; place-items: center; border: 0; border-radius: var(--radius-md); cursor: pointer; position: relative; background: transparent; color: var(--color-text-muted); }
.tool:hover, .tool.is-hover { background: var(--color-hover); color: var(--color-text); }
.tool[aria-pressed="true"], .tool.is-active { background: var(--tint-accent-bg); color: var(--color-accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent); }
.tool:disabled, .tool.is-disabled { opacity: .45; cursor: not-allowed; }
.tool-key { position: absolute; right: 3px; bottom: 2px; font-size: 9px; line-height: 1; font-weight: 600; color: var(--color-text-faint); }
.tooltip { display: flex; align-items: center; gap: var(--space-3); padding: 6px 8px 6px 10px; border-radius: 7px; background: var(--color-surface-3); box-shadow: var(--shadow-md); white-space: nowrap; font-size: var(--text-sm); color: var(--color-text); pointer-events: none; }
.tooltip-hint { color: var(--color-text-muted); }
.ctxbar { display: flex; align-items: center; gap: var(--space-2); height: 40px; padding: 0 var(--space-2) 0 var(--space-4); border-radius: 10px; background: var(--color-surface); box-shadow: var(--shadow-md); white-space: nowrap; max-width: 100%; overflow: hidden; }
.ctxbar-title { display: inline-flex; align-items: center; gap: 7px; font-weight: 500; padding-right: 4px; }
.ctxbar-title .icon { color: var(--color-accent); }
.ctxbar-opt { height: 30px; display: inline-flex; align-items: center; gap: 5px; padding: 0 7px; border: 0; border-radius: 6px; cursor: pointer; font: inherit; font-size: 12.5px; background: transparent; color: var(--color-text-muted); }
.ctxbar-opt:hover, .ctxbar-opt.is-hover { background: var(--color-hover); color: var(--color-text); }
.ctxbar-opt[aria-checked="true"], .ctxbar-opt[aria-pressed="true"], .ctxbar-opt.is-active { background: var(--tint-accent-bg); color: var(--color-accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent); }
.ctxbar-num { font-size: var(--text-2xs); color: var(--color-text-faint); }

/* ---------- fields ---------- */
.field { display: flex; flex-direction: column; min-width: 0; }
.field > label, .field > .label { display: block; font-size: var(--text-sm); margin-bottom: 5px; color: color-mix(in srgb, var(--color-text) 70%, transparent); }
.input { min-height: 30px; padding: 4px 9px; font-size: var(--text-md); border-color: var(--color-control-border); }
.input:hover, .input.is-hover { border-color: var(--color-text-muted); }
.input:focus-visible, .input.is-focus { border-color: var(--color-accent); outline: 2px solid var(--color-accent); outline-offset: 0; }
.input:disabled { opacity: .45; cursor: not-allowed; }
.input[aria-invalid="true"] { border-color: var(--color-danger); }
.input::placeholder { color: var(--color-text-faint); opacity: 1; }
.input-lg { min-height: var(--control-lg); padding: 6px 10px; font-size: 14px; }
.field.has-error > label, .field.has-error > .label { color: var(--color-danger); }
.field-error { display: block; font-size: 11.5px; color: var(--color-danger); margin-top: 4px; }
.field-hint { display: block; font-size: var(--text-sm); color: var(--color-text-muted); margin-top: 4px; }
.input-unit { position: relative; }
.input-unit .input { padding-right: 30px; }
.input-unit .unit { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); font-size: 11.5px; color: var(--color-text-muted); pointer-events: none; }
.select { position: relative; }
.select select.input { appearance: none; -webkit-appearance: none; padding-right: 26px; cursor: pointer; }
.select .icon { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: var(--color-text-muted); pointer-events: none; }
textarea.input { min-height: 72px; line-height: var(--leading-ui); }
.field-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: var(--space-3); }

.check { display: inline-flex; align-items: center; gap: 9px; cursor: pointer; position: relative; }
.check input { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
.check .box { width: 16px; height: 16px; flex: none; display: grid; place-items: center; border-radius: var(--radius-sm); box-shadow: inset 0 0 0 1.5px var(--color-control-border); color: var(--color-bg); }
.check .box .icon { opacity: 0; }
.check:hover .box { box-shadow: inset 0 0 0 1.5px var(--color-text-muted); }
.check input:checked + .box, .check .box.is-on { background: var(--color-accent); box-shadow: none; }
.check input:checked + .box .icon, .check .box.is-on .icon { opacity: 1; }
.check input:focus-visible + .box, .check .box.is-focus { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.check:has(input:disabled), .check.is-disabled { opacity: .45; cursor: not-allowed; }
.check-hint { font-size: var(--text-sm); color: var(--color-text-muted); }

.switch { width: 34px; height: 20px; padding: 2px; flex: none; border: 0; border-radius: 10px; display: inline-flex; justify-content: flex-start; cursor: pointer; background: var(--color-surface-3); box-shadow: inset 0 0 0 1px var(--color-control-border); }
.switch::after { content: ""; width: 16px; height: 16px; border-radius: 50%; background: var(--color-text-muted); }
.switch[aria-checked="true"] { justify-content: flex-end; background: var(--color-accent); box-shadow: none; }
.switch[aria-checked="true"]::after { background: var(--color-bg); }
.switch:disabled { opacity: .45; cursor: not-allowed; }

/* A native range: the theme script keeps --fill (0–100 %) in step with the value. */
.range-head { display: flex; align-items: center; font-size: var(--text-sm); color: color-mix(in srgb, var(--color-text) 70%, transparent); margin-bottom: 6px; }
.range-head > :first-child { flex: 1; }
.range-value { min-width: 34px; text-align: right; padding: 2px 6px; border-radius: 5px; background: var(--color-surface-2); box-shadow: inset 0 0 0 1px var(--color-border-strong); color: var(--color-text); font-variant-numeric: tabular-nums; }
.range { --fill: 50%; -webkit-appearance: none; appearance: none; display: block; width: 100%; height: 20px; margin: 0; background: transparent; cursor: pointer; }
.range::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--color-accent) var(--fill), var(--color-surface-3) var(--fill)); box-shadow: inset 0 0 0 1px var(--color-border-strong); }
.range::-moz-range-track { height: 4px; border-radius: 2px; background: var(--color-surface-3); box-shadow: inset 0 0 0 1px var(--color-border-strong); }
.range::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--color-accent); }
.range::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -5px; border-radius: 50%; background: var(--color-surface-2); box-shadow: 0 0 0 2px var(--color-accent); border: 0; }
.range::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: var(--color-surface-2); box-shadow: 0 0 0 2px var(--color-accent); border: 0; }
.range:focus-visible, .range.is-focus { outline: none; }
.range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 2px var(--color-accent), 0 0 0 4px var(--color-surface), 0 0 0 6px var(--color-accent); }
.range:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 2px var(--color-accent), 0 0 0 4px var(--color-surface), 0 0 0 6px var(--color-accent); }
.range.is-focus::-webkit-slider-thumb { box-shadow: 0 0 0 2px var(--color-accent), 0 0 0 4px var(--color-surface), 0 0 0 6px var(--color-accent); }
.range.is-focus::-moz-range-thumb { box-shadow: 0 0 0 2px var(--color-accent), 0 0 0 4px var(--color-surface), 0 0 0 6px var(--color-accent); }
.range:disabled { opacity: .45; cursor: not-allowed; }
.range:disabled::-webkit-slider-runnable-track { background: linear-gradient(to right, var(--color-text-muted) var(--fill), var(--color-surface-3) var(--fill)); }
.range:disabled::-moz-range-progress { background: var(--color-text-muted); }
.range:disabled::-webkit-slider-thumb { box-shadow: 0 0 0 2px var(--color-text-muted); }
.range:disabled::-moz-range-thumb { box-shadow: 0 0 0 2px var(--color-text-muted); }
.range-ticks { display: flex; justify-content: space-between; padding: 0 4px; font-size: var(--text-2xs); color: var(--color-text-faint); font-variant-numeric: tabular-nums; }

/* ---------- menus and lists ---------- */
.menu { padding: 4px; border-radius: var(--radius-md); background: var(--color-surface-2); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; gap: 1px; }
.menu-item { display: flex; align-items: center; gap: var(--space-3); padding: 6px 8px 6px 30px; border: 0; border-radius: 5px; background: transparent; color: var(--color-text); font: inherit; text-align: left; cursor: pointer; text-decoration: none; }
.menu-item:hover, .menu-item.is-hover { background: var(--color-hover); color: var(--color-text); }
.menu-item[aria-selected="true"], .menu-item[aria-checked="true"] { background: var(--tint-accent-bg); color: var(--tint-accent-fg); padding-left: 8px; }
.menu-item[aria-disabled="true"] { opacity: .45; cursor: not-allowed; }
.menu-item.has-icon { padding-left: 10px; align-items: flex-start; }
.menu-item-sub { display: block; font-size: var(--text-sm); color: var(--color-text-muted); }

/* ---------- cards ---------- */
.card { color: var(--color-text); }
.panel { background: var(--color-surface); border-radius: var(--radius-lg); padding: var(--space-6) 22px; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
.panel-title { font-family: var(--font-display); font-weight: 400; font-size: var(--display-sm); line-height: var(--leading-tight); margin: 0; }
.map-card { padding: 0; gap: 0; overflow: hidden; position: relative; text-decoration: none; transition: box-shadow var(--dur-fast) var(--ease); }
.map-card-thumb { position: relative; aspect-ratio: 16 / 10; background: var(--canvas-parchment); overflow: hidden; }
.map-card-thumb img { width: 100%; height: 100%; object-fit: cover; }
.map-card-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 3px; }
.map-card-title { font-family: var(--font-display); font-size: 18px; line-height: var(--leading-tight); color: var(--color-text); }
.map-card-meta { font-size: var(--text-sm); color: var(--color-text-muted); }
.map-card-actions { position: absolute; right: 8px; bottom: 8px; display: flex; gap: 4px; opacity: 0; transition: opacity var(--dur-fast) var(--ease); }
.map-card-actions .btn { background: var(--color-surface); }
.map-card:hover, .map-card:focus-within, .map-card.is-hover { box-shadow: var(--shadow-md), 0 0 0 1px var(--color-accent); }
.map-card:hover .map-card-actions, .map-card:focus-within .map-card-actions, .map-card.is-hover .map-card-actions { opacity: 1; }
.new-tile { border-radius: var(--radius-md); box-shadow: inset 0 0 0 1.5px var(--color-border-strong); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-3); color: var(--color-text-muted); min-height: 180px; background: transparent; border: 0; font: inherit; cursor: pointer; text-decoration: none; }
.new-tile:hover, .new-tile.is-hover { background: var(--color-hover); color: var(--color-text-muted); }
.new-tile-label { color: var(--color-text); }

/* ---------- tables and tags ---------- */
.table { font-size: var(--text-md); }
.table td { vertical-align: middle; }
.table .num, .table .end { text-align: right; }
.table-wrap { overflow-x: auto; }
.tag { gap: 6px; white-space: nowrap; }
.tag-accent { background: var(--tint-accent-bg); color: var(--tint-accent-fg); }
.tag-neutral { background: var(--tint-neutral-bg); color: var(--tint-neutral-fg); }
.tag-outline { border: 0; box-shadow: inset 0 0 0 1px var(--color-border-strong); color: var(--color-text); }
.tag-info { background: var(--tint-info-bg); color: var(--tint-info-fg); }
.tag-warning { background: var(--tint-warning-bg); color: var(--tint-warning-fg); }
.tag-danger { background: var(--tint-danger-bg); color: var(--tint-danger-fg); }
.tag-numeral { font-family: var(--font-numeral); font-size: var(--text-sm); }
.tag-sm { padding: 1px 7px; }
.dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--color-accent); }

/* ---------- messages: notices, toasts, dialogs ---------- */
.notice { display: flex; align-items: flex-start; gap: 10px; padding: 9px 12px; border-radius: 10px; background: var(--tint-neutral-bg); color: var(--tint-neutral-fg); margin: 0; }
.notice > .icon { margin-top: 1px; }
.notice-info { background: var(--tint-info-bg); color: var(--tint-info-fg); }
.notice-ok { background: var(--tint-accent-bg); color: var(--tint-accent-fg); }
.notice-warning { background: var(--tint-warning-bg); color: var(--tint-warning-fg); }
.notice-danger { background: var(--tint-danger-bg); color: var(--tint-danger-fg); }
.error { color: var(--color-danger); margin: 0; }
.toasts { position: fixed; left: 50%; bottom: var(--space-6); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: var(--space-3); z-index: 100; max-width: calc(100vw - 32px); }
.toast { display: flex; align-items: center; gap: 10px; padding: 7px 7px 7px 12px; border-radius: 10px; background: var(--color-surface-2); box-shadow: var(--shadow-lg); color: var(--color-text); }
.toast > .icon { color: var(--color-text-muted); }
.toast .btn { height: var(--control-sm); padding: 0 8px; }
.toast-close { width: 28px; height: 28px; display: grid; place-items: center; border: 0; padding: 0; background: none; color: var(--color-text-muted); border-radius: var(--radius-sm); cursor: pointer; }
.toast-close:hover { background: var(--color-hover); color: var(--color-text); }
.toast-error { box-shadow: var(--shadow-lg), inset 0 0 0 1px color-mix(in srgb, var(--color-danger) 45%, transparent); }
.toast-error > .icon { color: var(--color-danger); }
.dialog-backdrop { background: var(--color-overlay); }
.dialog { color: var(--color-text); }
.dialog-title { font-family: var(--font-display); font-weight: 400; font-size: 24px; line-height: var(--leading-tight); }
.dialog-body { font-size: 13.5px; opacity: 1; color: var(--color-text-muted); text-wrap: pretty; }
.dialog-head { display: flex; align-items: center; gap: var(--space-4); }
.dialog-head > :nth-child(2) { flex: 1; min-width: 0; }
.section-label { font-size: var(--text-xs); letter-spacing: .08em; text-transform: uppercase; color: var(--color-text-muted); }

/* ---------- GM markers and the marker note ---------- */
.marker { width: 28px; height: 28px; flex: none; border-radius: 50%; display: grid; place-items: center; box-shadow: 0 0 0 1.5px var(--marker-ink); font-family: var(--font-numeral); font-size: 17px; line-height: 1; }
.marker-sm { width: 20px; height: 20px; font-size: 13px; box-shadow: 0 0 0 1px var(--marker-ink); }
.marker-xs { width: 18px; height: 18px; font-size: 12px; box-shadow: 0 0 0 1px var(--marker-ink); }
.marker-discover { background: var(--marker-discover); color: var(--marker-ink); }
.marker-interact { background: var(--marker-interact); color: var(--canvas-floor); }
.marker-trap { background: var(--marker-trap); color: var(--canvas-floor); }
.note-pop { width: 300px; max-width: 100%; padding: 12px 14px; border-radius: 10px; background: var(--color-surface); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; gap: 10px; color: var(--color-text); }
.note-pop-head { display: flex; align-items: center; gap: var(--space-3); }
.note-pop-head .kicker { flex: 1; }
.note-line { display: flex; gap: 9px; align-items: flex-start; }
.note-line .box { margin-top: 2px; }
.note-line.is-done > span:last-child, .note-line:has(input:checked) > span:last-child {color: var(--color-text-muted); text-decoration: line-through; text-decoration-color: var(--color-text-faint); }

/* ---------- chat and roll cards (Delve Table) ---------- */
.chat { background: var(--color-surface); border-radius: 10px; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; min-width: 0; }
.chat-head { display: flex; align-items: center; gap: var(--space-3); height: 40px; padding: 0 12px; box-shadow: inset 0 -1px 0 var(--color-border); }
.chat-head-title { flex: 1; font-weight: 500; }
.chat-log { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.chat-sys { align-self: center; font-size: 11.5px; color: var(--color-text-faint); }
.chat-msg { display: flex; gap: 9px; }
.chat-msg-body { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.chat-meta { font-size: var(--text-sm); color: var(--color-text-muted); }
.chat-meta b, .chat-meta strong { color: var(--color-text); font-weight: 500; }
.chat-whisper { padding: 8px 10px; margin: 0 -4px; border-radius: var(--radius-md); background: var(--tint-info-bg); color: var(--tint-info-fg); }
.chat-whisper .chat-meta { color: inherit; }
.chat-whisper .chat-text { color: var(--color-text); }
.chat-input { padding: 10px 12px; box-shadow: inset 0 1px 0 var(--color-border); display: flex; gap: var(--space-2); }
.chat-input .input { min-height: var(--control-md); background: var(--color-surface-2); }
.roll { flex: 1; min-width: 0; border-radius: 10px; background: var(--color-surface-2); box-shadow: inset 0 0 0 1px var(--color-border-strong); padding: 10px 12px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; align-items: center; }
.roll-total { grid-row: span 2; min-width: 48px; height: 44px; padding: 0 8px; display: grid; place-items: center; border-radius: var(--radius-md); font-family: var(--font-numeral); font-size: 26px; line-height: 1; box-shadow: inset 0 0 0 1.5px var(--color-accent); color: var(--color-text); }
.roll-formula { font-family: var(--font-mono); font-size: 12.5px; color: var(--color-text-muted); }
.roll-dice { grid-column: 1 / -1; display: flex; align-items: center; gap: 5px; padding-top: 4px; font-size: var(--text-sm); color: var(--color-text-muted); }
.die { min-width: 22px; height: 20px; padding: 0 4px; display: grid; place-items: center; border-radius: var(--radius-sm); background: var(--tint-accent-bg); color: var(--tint-accent-fg); font-family: var(--font-numeral); }
.die-dropped { background: transparent; color: inherit; box-shadow: inset 0 0 0 1px var(--color-border-strong); text-decoration: line-through; }
.roll-fumble { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-danger) 55%, transparent); }
.roll-fumble .roll-total { box-shadow: inset 0 0 0 1.5px var(--color-danger); color: var(--color-danger); }
.tip-card { padding: 10px 12px; border-radius: 9px; background: var(--color-surface-3); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; gap: 6px; font-size: var(--text-sm); color: var(--color-text); }
.tip-grid { display: grid; grid-template-columns: auto 1fr auto; gap: 3px 10px; color: var(--color-text-muted); }
.tip-total { display: flex; justify-content: space-between; padding-top: 6px; box-shadow: inset 0 1px 0 var(--color-border-strong); }

/* ---------- the bottom sheet (phones) ---------- */
.sheet { border-radius: 16px 16px 0 0; background: var(--color-surface); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; font-size: var(--text-md); color: var(--color-text); }
.sheet-handle { align-self: center; width: 32px; height: 4px; border-radius: 2px; background: var(--color-border-strong); margin: 7px 0 6px; flex: none; }
.sheet-tabs { display: flex; gap: 2px; padding: 0 8px; }
.sheet-tab { flex: 1; min-height: var(--touch); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; border: 0; border-radius: var(--radius-md); background: transparent; color: var(--color-text-muted); font: inherit; font-size: var(--text-xs); cursor: pointer; }
.sheet-tab[aria-selected="true"] { background: var(--tint-accent-bg); color: var(--color-accent); }

/* ---------- empty, loading, live and offline ---------- */
.empty { border-radius: 10px; background: var(--color-surface); box-shadow: var(--shadow-sm); padding: 22px; display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-3); }
.empty > .icon { color: var(--color-text-faint); }
.empty-title { font-family: var(--font-display); font-size: var(--display-sm); line-height: var(--leading-tight); }
.empty-text { color: var(--color-text-muted); text-wrap: pretty; margin: 0; }
.skeleton { display: block; border-radius: 6px; background: var(--color-surface-3); }
.skeleton-line { height: 12px; border-radius: var(--radius-sm); }
@media (prefers-reduced-motion: no-preference) { .skeleton { animation: delve-pulse 1.6s var(--ease) infinite; } }
@keyframes delve-pulse { 50% { opacity: .55; } }
.unrolling { border-radius: 10px; background: var(--canvas-parchment); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--canvas-ink); padding: var(--space-6); }
.unrolling-text { font-family: var(--font-display); font-style: italic; font-size: 18px; }
.unrolling-bar { width: 180px; height: 3px; border-radius: 2px; background: rgba(43,36,29,.18); overflow: hidden; }
.unrolling-bar > span { display: block; height: 100%; background: var(--canvas-ink); }
.status { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--color-text-muted); white-space: nowrap; }
.status::before { content: ""; width: 7px; height: 7px; flex: none; border-radius: 50%; }
.status-live::before { background: var(--color-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 25%, transparent); }
.status-connecting { color: var(--color-warning); }
.status-connecting::before { box-shadow: inset 0 0 0 1.5px var(--color-warning); }
.status-offline { color: var(--color-danger); }
.status-offline::before { background: var(--color-danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-danger) 25%, transparent); }
.save-state { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--color-text-muted); white-space: nowrap; }
.save-state.is-warning { color: var(--color-warning); }

/* ---------- phones ---------- */
@media (max-width: 640px) {
  .page { padding: var(--space-6) var(--space-5) var(--space-10); font-size: var(--text-lg); gap: var(--space-6); }
  .page-narrow { padding-top: var(--space-8); }
  .input, .input-lg { min-height: var(--touch); font-size: var(--text-touch); }
  .btn { min-height: var(--touch); }
  .btn-sm, .btn-icon, .toast .btn { min-height: 0; }
  .topbar { padding-left: var(--space-4); }
}
`;
