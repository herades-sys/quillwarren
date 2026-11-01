// The table pages' CSS (2D /play/:id and 3D /play/:id/3d) on the shared look
// (@delve/ui): the design's sidebar tabs, chat lines and roll cards, lists,
// dialogs, floating board controls and the phone sheet. The client in
// apps/web/src/table makes its own short class names (.cm, .roll-card, .list,
// .btn.primary…); this draws them as the design's components.
//
// The board reads a few colours with getComputedStyle (board.ts, view3d.ts),
// so those stay plain colour values per theme: --table-bg, --page-bg,
// --grid-ink, --muted and --slab. The older names the client uses inline
// (--bar, --ink, --line, --accent…) are kept as aliases of the tokens.

export const TABLE_BASE_CSS = `
  :root, [data-theme="dark"] {
    --table-bg: #0F1116; --page-bg: #EADCBB; --grid-ink: #4A3F33; --slab: #3A3128; --muted: #A6A9B6;
  }
  [data-theme="light"] {
    --table-bg: #CFCBC1; --page-bg: #EADCBB; --grid-ink: #4A3F33; --slab: #6E5C49; --muted: #565965;
  }
  :root {
    --bar: var(--color-surface); --ink: var(--color-text); --line: var(--color-border-strong); --accent: var(--color-accent); --accent-ink: var(--color-bg);
    --live: var(--color-accent); --warn: var(--color-warning); --bad: var(--color-danger); --soft: var(--color-hover); --crit: var(--color-accent); --fumble: var(--color-danger);
  }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; overflow: hidden; }
  button, input, select, textarea { font: inherit; color: inherit; }

  /* the client's buttons, as the design's */
  .btn.primary { color: var(--color-accent); border-color: var(--color-accent); }
  .btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--color-accent) 12%, transparent); }
  .btn:not(.primary):not(.danger):not(.btn-primary):not(.btn-plain):not(.btn-icon):not(.btn-ghost) { border-color: var(--color-divider); }
  .btn:not(.primary):not(.danger):not(.btn-primary):hover:not(:disabled) { background: var(--color-hover); }
  .btn[aria-pressed="true"] { background: var(--tint-accent-bg); color: var(--color-accent); border-color: color-mix(in srgb, var(--color-accent) 55%, transparent); }
  .btn.small { height: var(--control-sm); padding: 0 8px; font-size: var(--text-sm); }
  .btn.danger { color: var(--color-danger); border-color: color-mix(in srgb, var(--color-danger) 70%, transparent); }
  .btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--color-danger) 12%, transparent); }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
  .muted { color: var(--color-text-muted); }
  .hint { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); line-height: 1.5; }
  .small-text { font-size: var(--text-sm); }

  /* fields the client builds from plain inputs */
  #side input[type="text"], #side input[type="number"], #side input[type="search"], #side input[type="url"], #side textarea, #side select, dialog input[type="text"], dialog input[type="number"], dialog input[type="url"], dialog textarea, dialog select, #page-banner select, .tbl-top select {
    color: var(--color-text); background: var(--color-surface-2); border: 1px solid var(--color-control-border); border-radius: var(--radius-md); padding: 4px 9px; min-height: 30px; width: 100%; min-width: 0; font-size: var(--text-md);
  }
  #side select, dialog select, #page-banner select, .tbl-top select { width: auto; cursor: pointer; }
  #side input:hover, #side textarea:hover, #side select:hover, dialog input:hover, dialog textarea:hover, dialog select:hover { border-color: var(--color-text-muted); }
  #side input:focus-visible, #side textarea:focus-visible, #side select:focus-visible, dialog input:focus-visible, dialog textarea:focus-visible, dialog select:focus-visible { border-color: var(--color-accent); outline: 2px solid var(--color-accent); outline-offset: 0; }
  textarea { resize: vertical; }
  .field { display: flex; flex-direction: column; gap: 5px; font-size: var(--text-sm); color: color-mix(in srgb, var(--color-text) 70%, transparent); min-width: 0; }
  .field > span { font-size: var(--text-sm); }
  /* a native checkbox inside the client's labels (the shared .check expects a drawn box) */
  .check { display: inline-flex; align-items: center; gap: 8px; font-size: var(--text-md); color: var(--color-text); cursor: pointer; }
  .check input[type="checkbox"], #side input[type="checkbox"], dialog input[type="checkbox"] { position: static; opacity: 1; width: 16px; height: 16px; margin: 0; pointer-events: auto; accent-color: var(--color-accent); flex: none; }
  .slider { display: flex; flex-direction: column; gap: 5px; font-size: var(--text-sm); color: var(--color-text-muted); }
  .slider input, #side input[type="range"] { width: 100%; accent-color: var(--color-accent); }

  /* the top bar */
  .tbl-top { gap: 10px; }
  .tbl-top .topbar-brand { display: inline-flex; align-items: center; }
  #game-name { font-family: var(--font-display); font-size: 18px; line-height: 1; padding-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 32vw; border: 0; background: none; color: var(--color-text); text-align: left; }
  button#game-name { cursor: pointer; border-radius: 6px; padding: 4px 6px 2px; margin: 0 -6px; }
  button#game-name:hover { background: var(--color-hover); }
  .conn { display: inline-flex; align-items: center; gap: 7px; color: var(--color-text-muted); white-space: nowrap; font-size: 12.5px; }
  #conn-dot { width: 7px; height: 7px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--color-warning); flex: none; }
  #conn-dot[data-state="live"] { background: var(--color-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 25%, transparent); }
  #conn-dot[data-state="offline"], #conn-dot[data-state="closed"] { background: var(--color-danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-danger) 25%, transparent); }
  .conn:has(#conn-dot[data-state="offline"]), .conn:has(#conn-dot[data-state="closed"]) { color: var(--color-danger); }
  .me { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font-size: var(--text-md); }
  .me .dot, .swatch { width: 10px; height: 10px; border-radius: 50%; background: var(--c, var(--color-text-muted)); flex: none; }
  .account { display: inline-flex; align-items: center; gap: 5px; color: var(--color-text-muted); white-space: nowrap; font-size: var(--text-sm); }
  .account form { display: inline; margin: 0; }
  .account button { border: 0; background: none; padding: 0; color: var(--color-accent-text); text-decoration: underline; cursor: pointer; font-size: var(--text-sm); }
  .layer { display: inline-flex; align-items: center; gap: 6px; color: var(--color-text-muted); font-size: var(--text-sm); }
  .badge { display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px; margin-left: 4px; border-radius: 8px; background: var(--color-danger); color: #fff; font-size: 10px; font-weight: 700; }
  #side-toggle { position: relative; }
  #side-toggle .badge { position: absolute; top: -2px; right: -4px; margin: 0; }

  /* the board and its floating controls, 12 px in from the edges */
  #main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) var(--tbl-side, 344px); }
  body.side-closed #main { grid-template-columns: minmax(0, 1fr); }
  body.side-closed #side { display: none; }
  #stage { position: relative; overflow: hidden; touch-action: none; background: var(--table-bg); min-width: 0; min-height: 0; user-select: none; -webkit-user-select: none; }
  body.closed #board, body.closed #stage canvas { filter: grayscale(1); opacity: .45; }
  #board-note { position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%); max-width: min(420px, 90%); text-align: center; padding: 16px 20px; border-radius: 12px; background: var(--color-surface); box-shadow: var(--shadow-md); z-index: 4; line-height: 1.5; }
  .zoom, .cam { position: absolute; right: 12px; bottom: 12px; display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 10px; background: var(--color-surface); box-shadow: var(--shadow-md); z-index: 3; }
  .zoom button, .cam button { min-width: 32px; height: 32px; padding: 0 8px; display: grid; place-items: center; border: 0; border-radius: 7px; cursor: pointer; background: transparent; color: var(--color-text-muted); font-size: var(--text-md); }
  .zoom button:hover, .cam button:hover { background: var(--color-hover); color: var(--color-text); }
  .cam button[aria-pressed="true"] { background: var(--tint-accent-bg); color: var(--color-accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent); }
  #page-banner { position: absolute; left: 12px; top: 12px; right: 12px; display: flex; flex-wrap: wrap; gap: 6px; z-index: 3; pointer-events: none; }
  #page-banner > * { pointer-events: auto; padding: 5px 10px; border-radius: 999px; background: var(--color-surface); box-shadow: var(--shadow-md); border: 0; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; color: var(--color-text); }
  #page-banner > span { pointer-events: none; }
  #page-banner button { cursor: pointer; font: inherit; font-size: 12.5px; }
  #page-banner button:hover { background: var(--color-surface-2); }
  #page-banner .see-as, #page-banner .follow { box-shadow: var(--shadow-md), inset 0 0 0 1px var(--color-accent); }
  #page-banner .players { box-shadow: var(--shadow-md), inset 0 0 0 1px color-mix(in srgb, var(--color-warning) 70%, transparent); }
  #page-banner select { min-height: 26px; padding: 2px 8px; border-radius: 999px; }
  #toast { position: absolute; bottom: 64px; top: auto; left: 50%; transform: translateX(-50%); max-width: min(560px, 90%); padding: 9px 14px; border-radius: 10px; background: var(--color-surface-2); color: var(--color-text); box-shadow: var(--shadow-lg), inset 0 0 0 1px color-mix(in srgb, var(--color-danger) 45%, transparent); font-size: var(--text-md); z-index: 6; }
  #toast[data-kind="info"] { box-shadow: var(--shadow-lg); }

  /* the sidebar: the design's tabs, then a panel per tab */
  #side { display: grid; grid-template-rows: auto minmax(0, 1fr); background: var(--color-surface); box-shadow: inset 1px 0 0 var(--color-border); min-width: 0; min-height: 0; }
  #side > .tabs { display: flex; gap: 14px; height: 40px; padding: 0 12px; -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent); box-shadow: inset 0 -1px 0 var(--color-border); overflow-x: auto; scrollbar-width: none; }
  #side > .tabs > button { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; padding: 0 1px; color: var(--color-text-muted); cursor: pointer; white-space: nowrap; font-size: var(--text-md); }
  #side > .tabs > button:hover { color: var(--color-text); box-shadow: inset 0 -2px 0 var(--color-border-strong); }
  #side > .tabs > button[aria-selected="true"] { color: var(--color-text); box-shadow: inset 0 -2px 0 var(--color-accent); font-weight: 400; }
  #side > .tabs > button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -4px; border-radius: 6px; }
  #side > .tabs .icon { flex: none; }
  .panel { overflow-y: auto; min-height: 0; padding: 14px 16px 18px; display: grid; gap: 12px; align-content: start; background: none; border-radius: 0; box-shadow: none; }
  .panel h3 { margin: 6px 0 0; font-size: var(--text-xs); letter-spacing: .08em; text-transform: uppercase; font-weight: 400; color: var(--color-text-muted); font-family: var(--font-ui); }
  .panel h3:first-child { margin-top: 0; }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .row > input { flex: 1; }
  .list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .list li { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: var(--radius-md); background: var(--color-surface-2); box-shadow: inset 0 0 0 1px var(--color-border); min-width: 0; }
  .list li.selected, .list li.current { background: var(--tint-accent-bg); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent); }
  .list li .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list li button.name, .list li button.grow { border: 0; background: none; padding: 0; cursor: pointer; text-align: left; color: inherit; }
  .list li button.name:hover, .list li button.grow:hover { color: var(--color-accent-text); }
  .list li img { width: 26px; height: 26px; object-fit: contain; border-radius: 5px; background: var(--canvas-floor); flex: none; }
  .list li.page-item { display: grid; gap: 6px; }
  .tag { font-size: var(--text-xs); padding: 1px 8px; border-radius: calc(var(--radius-md) * 0.75); background: var(--tint-neutral-bg); color: var(--tint-neutral-fg); white-space: nowrap; }
  .tag.on { background: var(--tint-accent-bg); color: var(--tint-accent-fg); }
  .tag.players { background: var(--tint-warning-bg); color: var(--tint-warning-fg); }
  .empty { color: var(--color-text-muted); font-size: var(--text-md); background: none; box-shadow: none; padding: 0; border-radius: 0; display: block; }
  .avatar { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex: none; background: var(--c, var(--color-text-muted)); font-size: 0; }

  /* phones: the panel is a sheet that rises from the bottom */
  @media (max-width: 720px) {
    #main, body.side-closed #main { grid-template-columns: minmax(0, 1fr); }
    #side { position: fixed; left: 0; right: 0; bottom: 0; height: min(62vh, 560px); box-shadow: var(--shadow-lg); border-radius: 16px 16px 0 0; z-index: 10; padding-top: 14px; }
    #side::before { content: ""; position: absolute; top: 6px; left: 50%; width: 32px; height: 4px; margin-left: -16px; border-radius: 2px; background: var(--color-border-strong); }
    body:not(.sheet-open) #side { display: none; }
    body.sheet-open .zoom, body.sheet-open .cam { bottom: calc(min(62vh, 560px) + 12px); }
    #game-name { max-width: 28vw; font-size: 16px; }
    .tbl-top #to-3d, .tbl-top #to-2d { width: 36px; padding: 0; font-size: 0; gap: 0; }
    .tbl-top .layer select { max-width: 92px; min-height: 30px; padding: 2px 6px; font-size: 13px; }
    .tbl-top .topbar-end { gap: 2px; }
    .layer span, #conn-text, .me .role, .account .who, .tbl-desk { display: none !important; }
    .tbl-top { gap: 6px; padding: 0 6px 0 12px; }
    .zoom button, .cam button { min-width: 44px; height: 40px; }
    #side input, #side textarea, #side select { font-size: var(--text-touch); }
  }
  @media (max-width: 420px) { .me { display: none; } }
`;

/** The 2D table: the board, chat lines and roll cards, turn order, tokens and players. */
export const TABLE_2D_CSS = `
  #board { position: absolute; inset: 0; display: block; width: 100%; height: 100%; touch-action: none; }
  #board.dragging, #board.panning { cursor: grabbing; }

  /* chat, as in the design's "Chat lines and roll cards" */
  #panel-chat { grid-template-rows: minmax(0, 1fr) auto auto auto; align-content: stretch; gap: 0; padding: 0; overflow: hidden; }
  #chat-log { overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .cm { padding: 0 2px; border-radius: 8px; overflow-wrap: anywhere; line-height: 1.5; }
  .cm.chat, .cm.roll { display: block; min-width: 0; flex: none; padding: 0 2px; background: none; box-shadow: none; border-radius: 8px; }
  .cm.cont { margin-top: -6px; }
  .cm-head { display: flex; align-items: center; gap: 7px; font-size: var(--text-sm); color: var(--color-text-muted); }
  .cm-speaker { font-weight: 500; color: var(--color-text); }
  .cm-speaker::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--c, var(--color-text-muted)); vertical-align: 1px; }
  .cm-head .avatar + .cm-speaker::before { display: none; }
  .cm-label { font-size: var(--text-xs); padding: 0 6px; border-radius: 5px; background: var(--tint-neutral-bg); color: var(--tint-neutral-fg); }
  .cm-time { margin-left: auto; font-size: var(--text-xs); color: var(--color-text-faint); font-variant-numeric: tabular-nums; }
  .cm-body { white-space: pre-wrap; }
  .cm.emote .cm-body { font-style: italic; }
  .cm.emote .cm-body .who { font-weight: 500; font-style: normal; color: var(--color-text); }
  .cm.ooc { color: var(--color-text-muted); }
  .cm.ooc .cm-body { font-size: var(--text-md); }
  .cm.whisper { padding: 8px 10px; margin: 0 -4px; background: var(--tint-info-bg); color: var(--tint-info-fg); }
  .cm.whisper .cm-head, .cm.whisper .cm-speaker, .cm.whisper .cm-time { color: inherit; }
  .cm.whisper .cm-body { color: var(--color-text); }
  .cm.gmroll { padding: 8px 10px; margin: 0 -4px; background: var(--tint-warning-bg); }
  .cm.gmroll .cm-head { color: var(--tint-warning-fg); }
  .cm.desc { font-family: var(--font-display); font-size: 16px; font-style: italic; text-align: center; padding: 10px 12px; border-radius: 10px; background: var(--color-surface-2); }
  .cm.system { align-self: center; color: var(--color-text-faint); font-size: 11.5px; text-align: center; }
  .roll-card { margin: 6px 0 2px; padding: 10px 12px; border-radius: 10px; background: var(--color-surface-2); box-shadow: inset 0 0 0 1px var(--color-border-strong); display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; align-items: center; }
  .rc-expr { font: 12.5px var(--font-mono); color: var(--color-text-muted); overflow-wrap: anywhere; }
  .rc-total { grid-row: span 2; min-width: 48px; height: 44px; padding: 0 8px; display: grid; place-items: center; border-radius: var(--radius-md); font: 400 26px/1 var(--font-numeral); font-variant-numeric: tabular-nums; box-shadow: inset 0 0 0 1.5px var(--color-accent); color: var(--color-text); }
  .rc-total.crit { box-shadow: inset 0 0 0 1.5px var(--color-accent), 0 0 0 3px color-mix(in srgb, var(--color-accent) 25%, transparent); color: var(--color-accent-text); }
  .rc-total.fumble { box-shadow: inset 0 0 0 1.5px var(--color-danger); color: var(--color-danger); }
  .rc-dice { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: var(--text-sm); color: var(--color-text-muted); }
  .rc-term { display: inline-flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .rc-term-name { font-size: var(--text-xs); color: var(--color-text-faint); margin-right: 1px; }
  .roll-card .die, #chat-log .die { display: inline-grid; place-items: center; min-width: 22px; height: 20px; padding: 0 4px; border-radius: var(--radius-sm); background: var(--tint-accent-bg); color: var(--tint-accent-fg); font-family: var(--font-numeral); font-size: 13px; box-shadow: none; }
  #chat-log .die.max { box-shadow: inset 0 0 0 1px var(--color-accent); font-weight: 400; color: var(--color-accent-text); }
  #chat-log .die.min { background: var(--tint-danger-bg); color: var(--tint-danger-fg); font-weight: 400; }
  #chat-log .die.dropped { background: transparent; color: inherit; box-shadow: inset 0 0 0 1px var(--color-border-strong); text-decoration: line-through; opacity: 1; }
  #chat-log .die.exploded { box-shadow: inset 0 0 0 1px var(--color-warning); }
  #chat-log .die.succ { background: var(--tint-accent-bg); }
  #chat-log .die.fail { background: var(--tint-danger-bg); color: var(--tint-danger-fg); }
  .rc-op { color: var(--color-text-faint); padding: 0 1px; }
  .roll-secret { font-style: italic; color: var(--color-text-muted); }
  .iroll { display: inline-block; min-width: 22px; padding: 0 5px; margin: 0 1px; border-radius: 5px; background: var(--color-surface-2); box-shadow: inset 0 0 0 1px var(--color-accent); font-family: var(--font-numeral); text-align: center; font-style: normal; cursor: help; position: relative; font-variant-numeric: tabular-nums; }
  .iroll.fumble { box-shadow: inset 0 0 0 1px var(--color-danger); color: var(--color-danger); }
  .iroll:hover::after, .iroll:focus::after { content: attr(data-breakdown); position: absolute; left: 50%; bottom: calc(100% + 6px); transform: translateX(-50%); white-space: pre; padding: 8px 10px; border-radius: 9px; background: var(--color-surface-3); color: var(--color-text); box-shadow: var(--shadow-lg); font: 400 12px var(--font-mono); z-index: 3; pointer-events: none; }
  #chat-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; padding: 10px 12px 6px; box-shadow: inset 0 1px 0 var(--color-border); align-items: end; }
  #chat-input { min-height: 40px; max-height: 30vh; }
  #chat-form .btn { height: 40px; }
  #chat-hint { padding: 0 12px 4px; font-size: 11.5px; }
  #chat-hint code { font: 11px var(--font-mono); background: var(--color-surface-2); padding: 0 4px; border-radius: 4px; }
  .chat-opts { display: flex; gap: 12px; padding: 0 12px 10px; }
  .chat-opts .check { font-size: var(--text-sm); color: var(--color-text-muted); }

  /* turn order */
  .turns li.current .grow { font-weight: 500; }
  .turns input.init { width: 58px; flex: none; text-align: right; padding: 3px 6px; }
  .turns .init-v { font-family: var(--font-numeral); font-variant-numeric: tabular-nums; min-width: 26px; text-align: right; font-size: 15px; }
  .round { font: 400 17px var(--font-numeral); }

  /* tokens */
  .props-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 8px; }
  .props-grid button { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: var(--color-text-muted); font-size: var(--text-xs); text-align: center; cursor: pointer; min-width: 0; overflow-wrap: anywhere; }
  .props-grid img { width: 100%; aspect-ratio: 1; object-fit: contain; padding: 8px; border-radius: 8px; background: var(--canvas-floor); box-shadow: inset 0 0 0 1px var(--color-border); }
  .props-grid button:hover img { box-shadow: 0 0 0 2px var(--color-accent); }
  .props-grid button:hover { color: var(--color-text); }
  .file-btn { position: relative; overflow: hidden; display: inline-flex; }
  .file-btn input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }

  /* players */
  .invite { display: grid; gap: 8px; padding: 10px 12px; border-radius: 10px; box-shadow: inset 0 0 0 1.5px var(--color-border-strong); }

  /* the token settings dialog (the design's "Token settings") */
  dialog.tok { width: min(440px, calc(100vw - 20px)); max-height: calc(100vh - 20px); padding: 0; border: 0; border-radius: var(--radius-lg); background: var(--color-surface); color: var(--color-text); box-shadow: var(--shadow-lg); }
  dialog.tok::backdrop { background: var(--color-overlay); }
  dialog.tok form { display: grid; gap: 14px; padding: 18px 20px; }
  dialog.tok h2 { margin: 0; font-family: var(--font-display); font-weight: 400; font-size: 22px; display: flex; align-items: center; gap: 12px; }
  dialog.tok h2 img { width: 44px; height: 44px; object-fit: contain; border-radius: 50%; background: var(--canvas-floor); box-shadow: 0 0 0 2px var(--canvas-floor), 0 0 0 3px var(--color-border-strong); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; }
  .grid2 > .check { align-self: end; padding-bottom: 7px; }
  .grid3 { display: grid; grid-template-columns: auto 1fr 1fr; gap: 6px 8px; align-items: center; }
  .checks { display: flex; flex-wrap: wrap; gap: 6px 14px; }
  .dlg-foot { display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
  .dlg-foot .danger { margin-right: auto; }

  /* the GM's markers on Quillwarren pages (apps/web/src/table/gm-markers.ts), like the editor's note */
  #stage.on-marker:not(.dragging) { cursor: pointer !important; }
  .marker-box { position: fixed; z-index: 20; width: min(300px, calc(100vw - 16px)); display: grid; gap: 10px; padding: 12px 14px; border-radius: 10px; background: var(--color-surface); color: var(--color-text); box-shadow: var(--shadow-lg), inset 0 3px 0 var(--kind, var(--color-accent)); font: var(--text-md)/1.5 var(--font-ui); }
  .marker-box[data-kind="discover"] { --kind: var(--marker-discover); }
  .marker-box[data-kind="interact"] { --kind: var(--marker-interact); }
  .marker-box[data-kind="trap"] { --kind: var(--marker-trap); }
  .marker-head { display: flex; align-items: center; gap: 8px; }
  .marker-head strong { flex: 1; font-size: var(--text-xs); letter-spacing: .08em; text-transform: uppercase; font-weight: 400; color: var(--color-text-muted); }
  .marker-icon { width: 22px; height: 22px; flex: none; }
  .marker-close { width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--color-text-muted); font-size: 18px; line-height: 1; cursor: pointer; }
  .marker-close:hover { background: var(--color-hover); color: var(--color-text); }
  .marker-text { margin: 0; width: 100%; min-height: 3.2em; font: inherit; color: var(--color-text); background: var(--color-surface-2); border: 1px solid var(--color-control-border); border-radius: var(--radius-md); padding: 6px 9px; resize: vertical; white-space: pre-wrap; }
  p.marker-text { border-color: transparent; background: none; padding: 0; }
  .marker-box.done .marker-text { text-decoration: line-through; color: var(--color-text-muted); }
  .marker-foot { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 10px; font-size: var(--text-sm); color: var(--color-text-muted); }
  .marker-foot label { display: inline-flex; align-items: center; gap: 6px; color: var(--color-text); cursor: pointer; }
  .marker-foot input { accent-color: var(--color-accent); }
`;

/** The 3D table: the canvas, name plates over the minis, the camera controls. */
export const TABLE_3D_CSS = `
  #main { --tbl-side: 300px; }
  #stage canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; touch-action: none; outline: none; }
  #stage.dragging canvas { cursor: grabbing; }
  #stage.on-mini canvas { cursor: grab; }
  .badge3d { font-size: var(--text-xs); padding: 1px 7px; border-radius: 5px; background: var(--tint-accent-bg); color: var(--tint-accent-fg); }
  #status3d { position: absolute; left: 12px; bottom: 12px; padding: 7px 12px; border-radius: 10px; background: var(--color-surface); box-shadow: var(--shadow-md); font-size: var(--text-md); pointer-events: none; z-index: 2; }
  #tags3d { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 1; }
  .tag3d { position: absolute; left: 0; top: 0; display: grid; justify-items: center; gap: 2px; will-change: transform; }
  .tag3d .bars { display: grid; gap: 2px; padding: 1px; border-radius: 3px; background: rgba(0, 0, 0, .55); }
  .tag3d .bar { height: 4px; border-radius: 2px; background: rgba(255, 255, 255, .12); overflow: hidden; }
  .tag3d .bar i { display: block; height: 100%; border-radius: 2px; }
  .tag3d .plate { padding: 0 6px 1px; border-radius: 5px; background: rgba(16, 20, 24, .8); color: #fff; font-size: 12px; line-height: 16px; white-space: nowrap; }
  @media (max-width: 720px) { body.sheet-open #status3d { display: none; } }
`;
