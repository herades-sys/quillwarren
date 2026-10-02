// The CSS of the GM's notes on both table pages (2D /play/:id and 3D /play/:id/3d):
// the pins on rooms that have notes, the 2D board's note box, and the Notes tab
// (rooms, characters, the session notebook). The script is apps/web/src/table/notes*.ts.
// On the shared look (@delve/ui): the note box is the design's note popover.
export const NOTES_CSS = `
  /* GM notes: pins on rooms with notes, the note box, the Notes tab */
  .note-pins { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 2; }
  .note-pin { position: absolute; left: 0; top: 0; width: 24px; height: 24px; margin: -12px 0 0 -12px; display: grid; place-items: center; padding: 0; border-radius: 7px; border: 1.5px solid var(--canvas-floor); background: #8A6A35; color: var(--canvas-floor); box-shadow: 0 1px 4px rgba(0, 0, 0, .45); pointer-events: auto; cursor: pointer; will-change: transform; }
  .note-pin svg { width: 14px; height: 14px; display: block; }
  .note-pins.small .note-pin { width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 5px; border-width: 1px; }
  .note-pins.small .note-pin svg { width: 10px; height: 10px; }
  .note-pin:hover, .note-pin[aria-pressed="true"] { background: var(--canvas-select); }
  .note-pin:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
  body.notes-mode #stage canvas, body.notes-mode #board { cursor: help; }
  #page-banner .notes-mode[aria-pressed="true"] { background: var(--tint-accent-bg); color: var(--color-accent); box-shadow: var(--shadow-md), inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent); }

  .note-box { position: fixed; z-index: 20; width: min(340px, calc(100vw - 16px)); display: grid; gap: 10px; padding: 12px 14px; border-radius: 10px; background: var(--color-surface); color: var(--color-text); box-shadow: var(--shadow-lg), inset 0 3px 0 #8A6A35; font: var(--text-md)/1.5 var(--font-ui); }
  .note-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .note-head strong { flex: 1; min-width: 0; font-family: var(--font-display); font-weight: 400; font-size: 18px; line-height: 1.15; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note-kind { font-size: var(--text-xs); padding: 1px 7px; border-radius: 5px; background: var(--tint-neutral-bg); color: var(--tint-neutral-fg); white-space: nowrap; }
  .note-close { width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--color-text-muted); font-size: 18px; line-height: 1; cursor: pointer; padding: 0; }
  .note-close:hover { background: var(--color-hover); color: var(--color-text); }
  .note-also { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font-size: var(--text-sm); color: var(--color-text-muted); }
  .note-also button { font: inherit; font-size: var(--text-sm); padding: 1px 9px; border-radius: 999px; border: 0; background: var(--color-surface-2); box-shadow: inset 0 0 0 1px var(--color-border); color: var(--color-text); cursor: pointer; }
  .note-also button:hover { box-shadow: inset 0 0 0 1px var(--color-accent); }
  .note-status { font-size: var(--text-sm); color: var(--color-text-muted); min-height: 1.2em; }
  .note-status[data-state="error"] { color: var(--color-danger); }
  .note-ro { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 40vh; overflow-y: auto; }
  .notes-panel textarea, .notes-panel input[type="text"], .notes-panel input[type="search"], .note-box textarea { font: inherit; color: var(--color-text); background: var(--color-surface-2); border: 1px solid var(--color-control-border); border-radius: var(--radius-md); padding: 7px 9px; width: 100%; min-width: 0; resize: vertical; line-height: 1.45; }
  .note-box textarea:focus-visible { border-color: var(--color-accent); outline: 2px solid var(--color-accent); outline-offset: 0; }
  .note-box textarea { min-height: 8em; max-height: 50vh; }
  .notes-panel textarea { min-height: 9em; }
  .notes-panel textarea.long { min-height: 18em; }
  .notes-panel .subtabs { display: flex; border-radius: var(--radius-md); box-shadow: inset 0 0 0 1px var(--color-divider); overflow: hidden; }
  .notes-panel .subtabs button { flex: 1; border: 0; background: transparent; color: var(--color-text); padding: 6px 8px; cursor: pointer; white-space: nowrap; font-size: var(--text-md); }
  .notes-panel .subtabs button + button { box-shadow: inset 1px 0 0 var(--color-divider); }
  .notes-panel .subtabs button:hover { background: var(--color-hover); }
  .notes-panel .subtabs button[aria-selected="true"] { color: var(--color-accent); box-shadow: inset 0 0 0 1px var(--color-accent); font-weight: 400; }
  .notes-panel .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .notes-panel .row > input { flex: 1; }
  .notes-panel .who { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .notes-panel .who img { width: 30px; height: 30px; object-fit: contain; border-radius: 50%; background: var(--canvas-floor); flex: none; }
  .notes-panel .who strong { flex: 1; min-width: 0; font-family: var(--font-display); font-weight: 400; font-size: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notes-panel .nlist { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .notes-panel .nlist li { display: block; padding: 0; border: 0; background: none; box-shadow: none; }
  .notes-panel .nlist button { display: grid; gap: 1px; width: 100%; text-align: left; padding: 7px 10px; border: 0; border-radius: var(--radius-md); background: var(--color-surface-2); box-shadow: inset 0 0 0 1px var(--color-border); color: var(--color-text); cursor: pointer; min-width: 0; font: inherit; }
  .notes-panel .nlist button:hover { box-shadow: inset 0 0 0 1px var(--color-border-strong); }
  .notes-panel .nlist button[aria-current="true"] { background: var(--tint-accent-bg); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent); }
  .notes-panel .nlist .t { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notes-panel .nlist .s { color: var(--color-text-muted); font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notes-panel .nlist .m { color: var(--color-text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .notes-panel .nlist mark { background: var(--tint-warning-bg); color: var(--tint-warning-fg); border-radius: 2px; }
  .notes-panel .back { justify-self: start; }
  @media (max-width: 720px) {
    .note-box { left: 8px !important; right: 8px; top: auto !important; bottom: calc(8px + env(safe-area-inset-bottom, 0px)); width: auto; }
    .note-box textarea { max-height: 32vh; }
    .notes-panel textarea.long { min-height: 12em; }
  }
`;
