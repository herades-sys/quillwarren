// The 3D table page (/play/:gameId/3d): the HTML shell and CSS around the
// client in apps/web/src/table/app3d.ts (built to /assets/table3d.js, with
// three.js). The script builds the scene, fills the panel and keeps it live
// over the same WebSocket as the 2D table; this only lays the page out.
export interface Table3dPageOptions {
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
    --table-bg: #BDB8AE; --page-bg: #EFEAE2; --grid-ink: #1B1F24; --slab: #6E5C49; --soft: color-mix(in srgb, var(--ink) 5%, transparent); color-scheme: light; }
  @media (prefers-color-scheme: dark) {
    :root { --bar: #191E24; --ink: #E5E9ED; --muted: #97A1AC; --line: #29303A; --accent: #6FA6D8; --accent-ink: #0C1520; --table-bg: #0E1216; --page-bg: #353C45; --grid-ink: #C9D1DA; --slab: #3A3128; color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; grid-template-rows: auto minmax(0, 1fr); font: 14px/1.4 system-ui, "Segoe UI", sans-serif; color: var(--ink); background: var(--bar); overflow: hidden; }
  button, input, select { font: inherit; color: inherit; }
  .btn, select { color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 7px; padding: 5px 10px; text-decoration: none; cursor: pointer; white-space: nowrap; }
  .btn:hover:not(:disabled) { border-color: color-mix(in srgb, var(--accent) 60%, var(--line)); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary, .btn[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .btn.small { padding: 2px 8px; font-size: 13px; }
  button:focus-visible, select:focus-visible, .btn:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .muted { color: var(--muted); }
  .hint { margin: 0; color: var(--muted); font-size: 12.5px; }
  .spacer { flex: 1; }
  [hidden] { display: none !important; }

  header { display: flex; align-items: center; gap: 8px 12px; padding: 7px 12px; border-bottom: 1px solid var(--line); background: var(--bar); min-width: 0; }
  .brand { font: 400 1.3rem/1 "IM FELL English", Georgia, serif; color: var(--ink); text-decoration: none; display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
  .brand img { display: block; border-radius: 4px; }
  #game-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 32vw; }
  .conn { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); white-space: nowrap; }
  #conn-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--warn); flex: none; }
  #conn-dot[data-state="live"] { background: var(--live); box-shadow: 0 0 0 3px color-mix(in srgb, var(--live) 25%, transparent); }
  #conn-dot[data-state="offline"], #conn-dot[data-state="closed"] { background: var(--bad); }
  .me { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .me .dot, .swatch { width: 10px; height: 10px; border-radius: 50%; background: var(--c, var(--muted)); flex: none; }
  .badge3d { font-size: 11px; font-weight: 700; letter-spacing: .04em; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--accent); color: var(--accent); }

  #main { display: grid; grid-template-columns: minmax(0, 1fr) 300px; min-height: 0; }
  body.side-closed #main { grid-template-columns: minmax(0, 1fr); }
  body.side-closed #side { display: none; }
  #stage { position: relative; overflow: hidden; touch-action: none; background: var(--table-bg); min-width: 0; min-height: 0; user-select: none; -webkit-user-select: none; }
  #stage canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; touch-action: none; outline: none; }
  #stage.dragging canvas { cursor: grabbing; }
  #stage.on-mini canvas { cursor: grab; }
  body.closed #stage canvas { filter: grayscale(1); opacity: .45; }
  #board-note { position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%); max-width: min(420px, 90%); text-align: center; padding: 14px 18px; border-radius: 10px; background: var(--bar); border: 1px solid var(--line); z-index: 4; }
  #status3d { position: absolute; left: 12px; bottom: 12px; padding: 6px 10px; border-radius: 7px; background: color-mix(in srgb, var(--bar) 90%, transparent); border: 1px solid var(--line); font-size: 13px; pointer-events: none; z-index: 2; }
  #page-banner { position: absolute; left: 12px; top: 10px; right: 12px; display: flex; flex-wrap: wrap; gap: 6px; z-index: 3; pointer-events: none; }
  #page-banner > * { pointer-events: auto; padding: 4px 9px; border-radius: 7px; background: color-mix(in srgb, var(--bar) 90%, transparent); border: 1px solid var(--line); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; color: var(--ink); }
  #page-banner span { pointer-events: none; }
  #page-banner select { padding: 3px 6px; max-width: min(260px, 60vw); }
  #page-banner button { cursor: pointer; }
  #page-banner button.see-as { border-color: var(--accent); }
  #page-banner button:hover, #page-banner select:hover { background: color-mix(in srgb, var(--accent) 16%, var(--bar)); }
  #page-banner .players { border-color: color-mix(in srgb, var(--warn) 60%, var(--line)); }
  #page-banner .follow { border-color: var(--accent); }
  .cam { position: absolute; right: 12px; bottom: 12px; display: flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: color-mix(in srgb, var(--bar) 92%, transparent); z-index: 3; }
  .cam button { border: 0; background: transparent; color: var(--ink); padding: 6px 11px; min-width: 40px; min-height: 34px; cursor: pointer; font-size: 13.5px; line-height: 1.2; }
  .cam button + button { border-left: 1px solid var(--line); }
  .cam button:hover { background: var(--soft); }
  .cam button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
  #toast { position: absolute; top: 48px; left: 50%; transform: translateX(-50%); max-width: min(560px, 90%); padding: 8px 12px; border-radius: 8px; background: var(--bad); color: #fff; font-size: 13px; z-index: 5; }
  #toast[data-kind="info"] { background: var(--accent); color: var(--accent-ink); }

  /* name plates and bars over the minis, placed each frame in screen pixels like the 2D table's */
  #tags3d { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 1; }
  .tag3d { position: absolute; left: 0; top: 0; display: grid; justify-items: center; gap: 2px; will-change: transform; }
  .tag3d .bars { display: grid; gap: 2px; padding: 1px; border-radius: 3px; background: rgba(0, 0, 0, .55); }
  .tag3d .bar { height: 4px; border-radius: 2px; background: rgba(255, 255, 255, .12); overflow: hidden; }
  .tag3d .bar i { display: block; height: 100%; border-radius: 2px; }
  .tag3d .plate { padding: 0 5px 1px; border-radius: 5px; background: rgba(16, 20, 24, .78); color: #fff; font-size: 12px; line-height: 16px; white-space: nowrap; }

  #side { display: grid; grid-template-rows: auto minmax(0, 1fr); border-left: 1px solid var(--line); background: var(--bar); min-width: 0; min-height: 0; }
  .tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
  .tabs button { border: 0; background: transparent; color: var(--muted); padding: 7px 9px 8px; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; }
  .tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
  .panel { overflow-y: auto; min-height: 0; padding: 12px 14px 18px; display: grid; gap: 12px; align-content: start; }
  .panel h3 { margin: 4px 0 0; font: 400 1.02rem/1.2 "Marcellus SC", Georgia, serif; letter-spacing: .02em; }
  .list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .list li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
  .list li.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .list li .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; background: none; padding: 0; text-align: left; cursor: pointer; }
  .list li .grow:hover { text-decoration: underline; }
  .list li img { width: 26px; height: 26px; object-fit: contain; border-radius: 5px; background: #F0ECE0; flex: none; }
  .tag { font-size: 11.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .empty { color: var(--muted); font-size: 13px; }
  .check { display: inline-flex; align-items: center; gap: 7px; font-size: 13.5px; cursor: pointer; }
  .slider { display: grid; gap: 3px; font-size: 13px; color: var(--muted); }
  .slider input { width: 100%; }

  @media (max-width: 720px) {
    #main, body.side-closed #main { grid-template-columns: minmax(0, 1fr); }
    #side { position: fixed; left: 0; right: 0; bottom: 0; height: min(55vh, 520px); border-left: 0; border-top: 1px solid var(--line); border-radius: 14px 14px 0 0; box-shadow: 0 -8px 30px rgba(0, 0, 0, .3); z-index: 10; }
    body:not(.sheet-open) #side { display: none; }
    body.sheet-open .cam { bottom: calc(min(55vh, 520px) + 10px); }
    body.sheet-open #status3d { display: none; }
    #game-name { max-width: 34vw; }
    #conn-text, .me .role, .brand .word { display: none; }
    header { gap: 8px; padding: 6px 10px; }
    header .btn { padding: 7px 11px; }
    .cam button { min-width: 46px; min-height: 42px; }
    #page-banner > * { font-size: 13.5px; padding: 6px 10px; }
  }
  @media (max-width: 420px) {
    .me { display: none; }
    .brand img { width: 20px; height: 20px; }
  }
`;

export function table3dPage(o: Table3dPageOptions): string {
  const gm = o.me.role === 'gm';
  const initial = JSON.stringify({ gameId: o.gameId, gameName: o.gameName, me: o.me, version: o.version }).replace(/</g, '\\u003c');
  const brand = `<img src="/assets/brand/mark.svg" alt="" width="22" height="22"><span class="word">Delve Table</span>`;
  const game = encodeURIComponent(o.gameId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(o.gameName)} in 3D · Delve Table</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${CSS}</style>
</head>
<body class="${gm ? 'role-gm' : 'role-player'}">
<header>
  ${gm ? `<a class="brand" href="/play" title="All games">${brand}</a>` : `<span class="brand">${brand}</span>`}
  <span id="game-name">${esc(o.gameName)}</span>
  <span class="badge3d" title="The table in 3D">3D</span>
  <span class="conn" title="Connection"><span id="conn-dot" data-state="connecting"></span><span id="conn-text">Connecting…</span></span>
  <span class="spacer"></span>
  <span class="me" id="me"><span class="dot" id="me-dot"></span><span id="me-name">${esc(o.me.name)}</span><span class="role muted">· ${gm ? 'GM' : 'Player'}</span></span>
  <a class="btn" id="to-2d" href="/play/${game}" title="Back to the flat table (the same game, live)">2D</a>
  <button type="button" class="btn" id="side-toggle" aria-pressed="true" aria-controls="side" title="Show or hide the panel">Panel</button>
</header>
<div id="main">
  <div id="stage">
    <div id="tags3d"></div>
    <div id="page-banner" aria-live="polite"></div>
    <div id="board-note" hidden></div>
    <div id="status3d">Loading the table…</div>
    <div class="cam" role="group" aria-label="Camera">
      <button type="button" id="cam-top" title="Look straight down (T)">Top</button><button type="button" id="cam-fit" title="Show the whole page (F)">Fit</button><button type="button" id="cam-follow" aria-pressed="false" title="Keep the selected mini in the middle (L)">Follow</button><button type="button" id="cam-flat" aria-pressed="false" title="Lay the minis flat, as discs seen from above">Flat</button>
    </div>
    <div id="toast" role="status" hidden></div>
  </div>
  <aside id="side" aria-label="3D table panels">
    <nav class="tabs" role="tablist" id="tabs3d"></nav>
  </aside>
</div>
<script id="table3d-initial" type="application/json">${initial}</script>
<script type="module" src="/assets/table3d.js?v=${encodeURIComponent(o.version)}"></script>
</body>
</html>`;
}
