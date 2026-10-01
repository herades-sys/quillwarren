// The CSS of the GM's notes on both table pages (2D /play/:id and 3D /play/:id/3d):
// the pins on rooms that have notes, the 2D board's note box, and the Notes tab
// (rooms, characters, the session notebook). The script is apps/web/src/table/notes*.ts.
export const NOTES_CSS = `
  /* GM notes: pins on rooms with notes, the note box, the Notes tab */
  .note-pins { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 2; }
  .note-pin { position: absolute; left: 0; top: 0; width: 24px; height: 24px; margin: -12px 0 0 -12px; display: grid; place-items: center; padding: 0; border-radius: 7px; border: 1.5px solid #FFFFFF; background: #8A6A35; color: #FFFFFF; box-shadow: 0 1px 4px rgba(0, 0, 0, .45); pointer-events: auto; cursor: pointer; will-change: transform; }
  .note-pin svg { width: 14px; height: 14px; display: block; }
  .note-pins.small .note-pin { width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 5px; border-width: 1px; }
  .note-pins.small .note-pin svg { width: 10px; height: 10px; }
  .note-pin:hover, .note-pin[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
  .note-pin:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  body.notes-mode #stage canvas, body.notes-mode #board { cursor: help; }
  #page-banner .notes-mode[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }

  .note-box { position: fixed; z-index: 20; width: min(340px, calc(100vw - 16px)); display: grid; gap: 8px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); border-top: 4px solid #8A6A35; background: var(--bar); color: var(--ink); box-shadow: 0 8px 28px rgba(0, 0, 0, .28); font: 14px/1.45 system-ui, "Segoe UI", sans-serif; }
  .note-box[hidden] { display: none; }
  .note-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .note-head strong { flex: 1; min-width: 0; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note-kind { font-size: 11px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .note-close { border: 0; background: transparent; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer; padding: 0 2px; }
  .note-also { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font-size: 12px; color: var(--muted); }
  .note-also button { font: inherit; font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--ink); cursor: pointer; }
  .note-also button:hover { border-color: var(--accent); }
  .note-status { font-size: 12px; color: var(--muted); min-height: 1.2em; }
  .note-status[data-state="error"] { color: var(--bad); }
  .note-ro { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 40vh; overflow-y: auto; }
  .notes-panel textarea, .notes-panel input[type="text"], .notes-panel input[type="search"], .note-box textarea { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 7px; padding: 6px 8px; width: 100%; min-width: 0; resize: vertical; }
  .note-box textarea { min-height: 8em; max-height: 50vh; }
  .notes-panel textarea { min-height: 9em; }
  .notes-panel textarea.long { min-height: 18em; }
  .notes-panel .subtabs { display: flex; gap: 3px; padding: 3px; border: 1px solid var(--line); border-radius: 9px; }
  .notes-panel .subtabs button { flex: 1; border: 0; background: transparent; color: var(--muted); padding: 5px 6px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
  .notes-panel .subtabs button[aria-selected="true"] { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
  .notes-panel .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .notes-panel .row > input { flex: 1; }
  .notes-panel .who { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .notes-panel .who img { width: 30px; height: 30px; object-fit: contain; border-radius: 6px; background: #F0ECE0; flex: none; }
  .notes-panel .who strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notes-panel .nlist { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .notes-panel .nlist li { display: block; padding: 0; border: 0; }
  .notes-panel .nlist button { display: grid; gap: 1px; width: 100%; text-align: left; padding: 6px 9px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--ink); cursor: pointer; min-width: 0; font: inherit; }
  .notes-panel .nlist button:hover { border-color: color-mix(in srgb, var(--accent) 60%, var(--line)); }
  .notes-panel .nlist button[aria-current="true"] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .notes-panel .nlist .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notes-panel .nlist .s { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notes-panel .nlist .m { color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .notes-panel .nlist mark { background: color-mix(in srgb, var(--warn) 35%, transparent); color: inherit; border-radius: 2px; }
  .notes-panel .btn.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  .notes-panel .back { justify-self: start; }
  @media (max-width: 720px) {
    .note-box { left: 8px !important; right: 8px; top: auto !important; bottom: calc(8px + env(safe-area-inset-bottom, 0px)); width: auto; }
    .note-box textarea { max-height: 32vh; }
    .notes-panel textarea.long { min-height: 12em; }
  }
`;
