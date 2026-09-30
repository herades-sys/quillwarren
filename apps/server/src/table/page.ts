// The table page (/play/:gameId): the HTML shell and CSS around the client in
// apps/web/src/table (built to /assets/table.js). The script draws the board,
// fills the panels and keeps everything live; this only lays the page out.
export interface TablePageOptions {
  gameId: string;
  gameName: string;
  version: string;
  me: { id: string; name: string; role: 'gm' | 'player' };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSS = `
  @font-face { font-family: "IM FELL English"; src: url("/fonts/im-fell-english.ttf") format("truetype"); font-display: swap; }
  @font-face { font-family: "Marcellus SC"; src: url("/fonts/marcellus-sc.ttf") format("truetype"); font-display: swap; }
  :root { --bar: #FFFFFF; --ink: #1B1F24; --muted: #5B6470; --line: #D9DEE4; --accent: #2C6AA0; --accent-ink: #FFFFFF; --live: #2E9E5B; --warn: #C98A12; --bad: #C0392B;
    --table-bg: #BDB8AE; --page-bg: #EFEAE2; --grid-ink: #1B1F24; --soft: color-mix(in srgb, var(--ink) 5%, transparent); --crit: #2E9E5B; --fumble: #C0392B; color-scheme: light; }
  @media (prefers-color-scheme: dark) {
    :root { --bar: #191E24; --ink: #E5E9ED; --muted: #97A1AC; --line: #29303A; --accent: #6FA6D8; --accent-ink: #0C1520; --table-bg: #0E1216; --page-bg: #353C45; --grid-ink: #C9D1DA; --crit: #57C785; --fumble: #F06B5D; color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; grid-template-rows: auto minmax(0, 1fr); font: 14px/1.4 system-ui, "Segoe UI", sans-serif; color: var(--ink); background: var(--bar); overflow: hidden; }
  button, input, select, textarea { font: inherit; color: inherit; }
  .btn, select { color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 7px; padding: 5px 10px; text-decoration: none; cursor: pointer; white-space: nowrap; }
  .btn:hover:not(:disabled) { border-color: color-mix(in srgb, var(--accent) 60%, var(--line)); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary, .btn[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .btn.small { padding: 2px 8px; font-size: 13px; }
  .btn.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  button:focus-visible, select:focus-visible, .btn:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  input[type="text"], input[type="number"], input[type="search"], input[type="url"], textarea, select.field { color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 5px 7px; width: 100%; min-width: 0; }
  textarea { resize: vertical; }
  .muted { color: var(--muted); }
  .hint { margin: 0; color: var(--muted); font-size: 12.5px; }
  .spacer { flex: 1; }
  [hidden] { display: none !important; }

  header { display: flex; align-items: center; gap: 8px 12px; padding: 7px 12px; border-bottom: 1px solid var(--line); background: var(--bar); min-width: 0; }
  .brand { font: 400 1.3rem/1 "IM FELL English", Georgia, serif; color: var(--ink); text-decoration: none; display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
  .brand img { display: block; border-radius: 4px; }
  #game-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 32vw; border: 0; background: none; padding: 0; text-align: left; }
  button#game-name { cursor: pointer; }
  button#game-name:hover { text-decoration: underline dotted; }
  .conn { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); white-space: nowrap; }
  #conn-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--warn); flex: none; }
  #conn-dot[data-state="live"] { background: var(--live); box-shadow: 0 0 0 3px color-mix(in srgb, var(--live) 25%, transparent); }
  #conn-dot[data-state="offline"], #conn-dot[data-state="closed"] { background: var(--bad); }
  .me { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .me .dot, .swatch { width: 10px; height: 10px; border-radius: 50%; background: var(--c, var(--muted)); flex: none; }
  .layer { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
  .layer select { padding: 4px 6px; }
  .badge { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; margin-left: 6px; border-radius: 9px; background: var(--bad); color: #fff; font-size: 11px; font-weight: 700; }

  #main { display: grid; grid-template-columns: minmax(0, 1fr) 350px; min-height: 0; }
  body.side-closed #main { grid-template-columns: minmax(0, 1fr); }
  body.side-closed #side { display: none; }
  #stage { position: relative; overflow: hidden; touch-action: none; background: var(--table-bg); min-width: 0; min-height: 0; user-select: none; -webkit-user-select: none; }
  #board { position: absolute; inset: 0; display: block; width: 100%; height: 100%; touch-action: none; }
  #board.dragging { cursor: grabbing; }
  body.closed #board { filter: grayscale(1); opacity: .45; }
  #board.panning { cursor: grabbing; }
  #board-note { position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%); max-width: min(420px, 90%); text-align: center; padding: 14px 18px; border-radius: 10px; background: var(--bar); border: 1px solid var(--line); z-index: 2; }
  .zoom { position: absolute; right: 12px; bottom: 12px; display: flex; gap: 0; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: color-mix(in srgb, var(--bar) 92%, transparent); z-index: 2; }
  .zoom button { border: 0; background: transparent; color: var(--ink); padding: 6px 11px; min-width: 36px; cursor: pointer; font-size: 15px; line-height: 1.2; }
  .zoom button + button { border-left: 1px solid var(--line); }
  .zoom button:hover { background: var(--soft); }
  #page-banner { position: absolute; left: 12px; top: 10px; display: flex; flex-wrap: wrap; gap: 6px; max-width: calc(100% - 24px); z-index: 2; pointer-events: none; }
  #page-banner span { padding: 4px 9px; border-radius: 7px; background: color-mix(in srgb, var(--bar) 90%, transparent); border: 1px solid var(--line); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  #page-banner .players { border-color: color-mix(in srgb, var(--warn) 60%, var(--line)); }
  #page-banner .see-as { pointer-events: auto; padding: 4px 9px; border-radius: 7px; border: 1px solid var(--accent); background: color-mix(in srgb, var(--bar) 90%, transparent); color: var(--ink); font: inherit; font-size: 13px; cursor: pointer; }
  #page-banner .see-as:hover { background: var(--soft); }
  #toast { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); max-width: min(560px, 90%); padding: 8px 12px; border-radius: 8px; background: var(--bad); color: #fff; font-size: 13px; z-index: 5; }
  #toast[data-kind="info"] { background: var(--accent); color: var(--accent-ink); }

  #side { display: grid; grid-template-rows: auto minmax(0, 1fr); border-left: 1px solid var(--line); background: var(--bar); min-width: 0; min-height: 0; }
  .tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
  .tabs button { border: 0; background: transparent; color: var(--muted); padding: 7px 9px 8px; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; display: inline-flex; align-items: center; }
  .tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
  .panel { overflow-y: auto; min-height: 0; padding: 12px 14px 18px; display: grid; gap: 12px; align-content: start; }
  .panel h3 { margin: 4px 0 0; font: 400 1.02rem/1.2 "Marcellus SC", Georgia, serif; letter-spacing: .02em; }
  .panel h3:first-child { margin-top: 0; }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .row > input { flex: 1; }
  .list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .list li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
  .list li .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list li button.name { border: 0; background: none; padding: 0; cursor: pointer; text-align: left; }
  .list li button.name:hover { text-decoration: underline; }
  .tag { font-size: 11.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .tag.on { border-color: var(--accent); color: var(--accent); }
  .tag.players { border-color: color-mix(in srgb, var(--warn) 70%, var(--line)); color: var(--warn); }
  .empty { color: var(--muted); font-size: 13px; }
  .small-text { font-size: 12px; }
  .list li.page-item { display: grid; gap: 6px; }

  /* chat */
  #panel-chat { grid-template-rows: minmax(0, 1fr) auto auto; align-content: stretch; gap: 0; padding: 0; overflow: hidden; }
  #chat-log { overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; min-height: 0; }
  .cm { padding: 5px 8px; border-radius: 8px; overflow-wrap: anywhere; line-height: 1.45; }
  .cm.cont { margin-top: -4px; padding-top: 0; }
  .cm-head { display: flex; align-items: baseline; gap: 6px; font-size: 13px; }
  .cm-speaker { font-weight: 700; color: var(--c, var(--ink)); }
  .cm-label { font-size: 11.5px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 0 6px; }
  .cm-time { margin-left: auto; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .cm-body { white-space: pre-wrap; }
  .cm.emote .cm-body { font-style: italic; }
  .cm.emote .cm-body .who { font-weight: 700; font-style: normal; color: var(--c, var(--ink)); }
  .cm.ooc { color: var(--muted); }
  .cm.ooc .cm-body { font-size: 13px; }
  .cm.whisper { background: color-mix(in srgb, #8a5cf6 11%, transparent); }
  .cm.gmroll { background: color-mix(in srgb, var(--warn) 10%, transparent); }
  .cm.desc { font-family: "IM FELL English", Georgia, serif; font-size: 15.5px; font-style: italic; text-align: center; padding: 8px 10px; background: var(--soft); }
  .cm.system { color: var(--muted); font-size: 12.5px; text-align: center; }
  .roll-card { margin: 4px 0 2px; padding: 7px 10px 8px; border: 1px solid var(--line); border-left: 3px solid var(--c, var(--accent)); border-radius: 8px; background: var(--soft); display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; align-items: center; }
  .rc-expr { font: 12.5px ui-monospace, Consolas, monospace; color: var(--muted); overflow-wrap: anywhere; }
  .rc-total { grid-row: span 2; font: 400 2rem/1 "Marcellus SC", Georgia, serif; font-variant-numeric: tabular-nums; }
  .rc-total.crit { color: var(--crit); }
  .rc-total.fumble { color: var(--fumble); }
  .rc-dice { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; font-size: 13px; }
  .rc-term { display: inline-flex; flex-wrap: wrap; gap: 3px; align-items: center; }
  .rc-term-name { font-size: 11px; color: var(--muted); margin-right: 1px; }
  .die { display: inline-grid; place-items: center; min-width: 22px; height: 22px; padding: 0 4px; border-radius: 5px; border: 1px solid var(--line); background: var(--bar); font-variant-numeric: tabular-nums; font-size: 12.5px; }
  .die.max { border-color: var(--crit); color: var(--crit); font-weight: 700; }
  .die.min { border-color: var(--fumble); color: var(--fumble); font-weight: 700; }
  .die.dropped { text-decoration: line-through; opacity: .5; font-weight: 400; }
  .die.exploded { box-shadow: 0 0 0 1px var(--warn) inset; }
  .die.succ { background: color-mix(in srgb, var(--crit) 18%, var(--bar)); }
  .die.fail { background: color-mix(in srgb, var(--fumble) 18%, var(--bar)); }
  .rc-op { color: var(--muted); padding: 0 1px; }
  .roll-secret { font-style: italic; color: var(--muted); }
  .iroll { display: inline-block; min-width: 22px; padding: 0 5px; margin: 0 1px; border: 1px solid var(--line); border-radius: 5px; background: var(--soft); font-weight: 700; text-align: center; font-style: normal; cursor: help; position: relative; font-variant-numeric: tabular-nums; }
  .iroll.crit { border-color: var(--crit); }
  .iroll.fumble { border-color: var(--fumble); }
  .iroll:hover::after, .iroll:focus::after { content: attr(data-breakdown); position: absolute; left: 50%; bottom: calc(100% + 5px); transform: translateX(-50%); white-space: pre; padding: 4px 8px; border-radius: 6px; background: var(--ink); color: var(--bar); font: 400 12px ui-monospace, Consolas, monospace; z-index: 3; pointer-events: none; }
  #chat-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; padding: 8px 12px 4px; border-top: 1px solid var(--line); align-items: end; }
  #chat-input { min-height: 40px; max-height: 30vh; font: inherit; }
  #chat-hint { padding: 0 12px 10px; font-size: 11.5px; }
  #chat-hint code { font: 11px ui-monospace, Consolas, monospace; }

  /* turn order */
  .turns li.current { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .turns li.current .grow { font-weight: 700; }
  .turns input.init { width: 58px; flex: none; text-align: right; padding: 3px 5px; }
  .turns .init-v { font-variant-numeric: tabular-nums; min-width: 26px; text-align: right; font-weight: 600; }
  .round { font: 400 1.05rem "Marcellus SC", Georgia, serif; }

  /* tokens tab */
  .props-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 6px; }
  .props-grid button { display: grid; justify-items: center; align-content: start; gap: 3px; padding: 5px 4px 6px; border: 1px solid var(--line); border-radius: 8px; background: #F0ECE0; color: #1B1F24; font: 11px/1.2 system-ui, sans-serif; text-align: center; cursor: pointer; min-width: 0; overflow-wrap: anywhere; }
  .props-grid button:hover { outline: 2px solid var(--accent); outline-offset: 1px; }
  .props-grid img { width: 54px; height: 54px; object-fit: contain; }
  .file-btn { position: relative; overflow: hidden; display: inline-block; }
  .file-btn input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }

  /* players tab */
  .invite { display: grid; gap: 6px; padding: 8px; border: 1px dashed var(--line); border-radius: 8px; }

  /* the token settings dialog */
  dialog.tok { width: min(420px, calc(100vw - 20px)); max-height: calc(100vh - 20px); padding: 0; border: 1px solid var(--line); border-radius: 12px; background: var(--bar); color: var(--ink); box-shadow: 0 10px 40px rgba(0, 0, 0, .35); }
  dialog.tok::backdrop { background: rgba(0, 0, 0, .35); }
  dialog.tok form { display: grid; gap: 10px; padding: 14px 16px 14px; }
  dialog.tok h2 { margin: 0; font: 400 1.2rem "Marcellus SC", Georgia, serif; display: flex; align-items: center; gap: 10px; }
  dialog.tok h2 img { width: 34px; height: 34px; object-fit: contain; border-radius: 6px; background: #F0ECE0; }
  .field { display: grid; gap: 3px; font-size: 13px; color: var(--muted); min-width: 0; }
  .field > span { font-size: 12px; }
  .check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .grid2 > .check { align-self: end; padding-bottom: 7px; }
  .grid3 { display: grid; grid-template-columns: auto 1fr 1fr; gap: 6px 8px; align-items: center; }
  .checks { display: flex; flex-wrap: wrap; gap: 6px 14px; }
  .dlg-foot { display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
  .dlg-foot .danger { margin-right: auto; }

  /* phones: the panel becomes a bottom sheet */
  @media (max-width: 720px) {
    #main, body.side-closed #main { grid-template-columns: minmax(0, 1fr); }
    #side { position: fixed; left: 0; right: 0; bottom: 0; height: min(62vh, 560px); border-left: 0; border-top: 1px solid var(--line); border-radius: 14px 14px 0 0; box-shadow: 0 -8px 30px rgba(0, 0, 0, .3); z-index: 10; }
    body:not(.sheet-open) #side { display: none; }
    body.sheet-open .zoom { bottom: calc(min(62vh, 560px) + 10px); }
    #game-name { max-width: 40vw; }
    .layer span, #conn-text, .me .role, .brand .word { display: none; }
    header { gap: 8px; padding: 6px 10px; }
  }
  @media (max-width: 420px) {
    .me { display: none; }
    .brand img { width: 20px; height: 20px; }
  }
`;

export function tablePage(o: TablePageOptions): string {
  const gm = o.me.role === 'gm';
  const initial = JSON.stringify({ gameId: o.gameId, gameName: o.gameName, me: o.me, version: o.version }).replace(/</g, '\\u003c');
  const tab = (id: string, label: string, selected = false) =>
    `<button type="button" role="tab" id="tab-${id}" data-tab="${id}" aria-controls="panel-${id}" aria-selected="${selected}">${label}</button>`;
  const brand = `<img src="/assets/brand/mark.svg" alt="" width="22" height="22"><span class="word">Delve Table</span>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(o.gameName)} · Delve Table</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${CSS}</style>
</head>
<body class="${gm ? 'role-gm' : 'role-player'}">
<header>
  ${gm ? `<a class="brand" href="/play" title="All games">${brand}</a>` : `<span class="brand">${brand}</span>`}
  ${gm ? `<button type="button" id="game-name" title="Rename the game">${esc(o.gameName)}</button>` : `<span id="game-name">${esc(o.gameName)}</span>`}
  <span class="conn" title="Connection"><span id="conn-dot" data-state="connecting"></span><span id="conn-text">Connecting…</span></span>
  <span class="spacer"></span>
  ${gm ? `<label class="layer" title="The layer you select and move tokens on"><span>Layer</span><select id="layer-select"><option value="map">Map</option><option value="tokens" selected>Tokens</option><option value="gm">GM only</option></select></label>` : ''}
  <span class="me" id="me"><span class="dot" id="me-dot"></span><span id="me-name">${esc(o.me.name)}</span><span class="role muted">· ${gm ? 'GM' : 'Player'}</span></span>
  <button type="button" class="btn" id="side-toggle" aria-pressed="true" aria-controls="side" title="Show or hide the panel">Panel<span class="badge" id="side-badge" hidden></span></button>
</header>
<div id="main">
  <div id="stage">
    <div id="page-banner" aria-live="polite"></div>
    <div id="board-note" hidden></div>
    <div class="zoom" role="group" aria-label="Zoom">
      <button type="button" id="zoom-out" title="Zoom out (-)" aria-label="Zoom out">−</button><button type="button" id="zoom-in" title="Zoom in (+)" aria-label="Zoom in">+</button><button type="button" id="fit" title="Fit the page (F)">Fit</button>
    </div>
    <div id="toast" role="status" hidden></div>
  </div>
  <aside id="side" aria-label="Table panels">
    <nav class="tabs" role="tablist">
      ${tab('chat', 'Chat<span class="badge" id="chat-badge" hidden></span>', true)}
      ${tab('turn', 'Turn order')}
      ${gm ? tab('pages', 'Pages') + tab('tokens', 'Tokens') : ''}
      ${tab('players', 'Players')}
    </nav>
    <section class="panel" id="panel-chat" data-panel="chat" role="tabpanel" aria-labelledby="tab-chat">
      <div id="chat-log" role="log" aria-live="polite"></div>
      <form id="chat-form" autocomplete="off">
        <textarea id="chat-input" rows="2" placeholder="Say something, or /r 1d20+5" aria-label="Chat message"></textarea>
        <button class="btn primary" type="submit">Send</button>
      </form>
      <p class="hint" id="chat-hint"></p>
    </section>
    <section class="panel" id="panel-turn" data-panel="turn" role="tabpanel" aria-labelledby="tab-turn" hidden></section>
    ${gm ? `<section class="panel" id="panel-pages" data-panel="pages" role="tabpanel" aria-labelledby="tab-pages" hidden></section>
    <section class="panel" id="panel-tokens" data-panel="tokens" role="tabpanel" aria-labelledby="tab-tokens" hidden></section>` : ''}
    <section class="panel" id="panel-players" data-panel="players" role="tabpanel" aria-labelledby="tab-players" hidden></section>
  </aside>
</div>
<script id="table-initial" type="application/json">${initial}</script>
<script type="module" src="/assets/table.js?v=${encodeURIComponent(o.version)}"></script>
</body>
</html>`;
}
