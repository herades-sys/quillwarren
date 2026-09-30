// The handout page (/maps/:id/handout): the players' map on an old parchment
// sheet (core handout.ts), with a preview, the options, downloads and printing.
// The pictures come from /api/v1/maps/:id/handout.{png,svg}; printing puts the
// 200 dpi PNG on a page of the chosen paper size, so "Save as PDF" works too.
import type { FastifyInstance } from 'fastify';
import { NotFoundError, type MapStore } from './store.ts';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(id: string, name: string, fogOn: boolean): string {
  const initial = JSON.stringify({ id, name, fogOn }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} · Handout · Delve</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style id="page-size">@page { size: A4 portrait; margin: 0; }</style>
<style>
  @font-face { font-family: "IM FELL English"; src: url("/fonts/im-fell-english.ttf") format("truetype"); font-display: swap; }
  :root {
    --bg: #F2F4F6; --surface: #FFFFFF; --ink: #1B1F24; --muted: #5B6470; --line: #D9DEE4;
    --accent: #2C6AA0; --accent-ink: #FFFFFF; --table: #4A3A2A; --bad: #B03A2E;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #101317; --surface: #191E24; --ink: #E5E9ED; --muted: #97A1AC; --line: #29303A;
            --accent: #6FA6D8; --accent-ink: #0C1520; --table: #2A2119; --bad: #F08A7E; color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, "Segoe UI", sans-serif; display: grid; grid-template-rows: auto 1fr; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--surface); }
  header a { color: var(--accent); text-decoration: none; }
  h1 { font: 400 1.6rem/1.1 "IM FELL English", Georgia, serif; margin: 0; }
  .note { color: var(--muted); font-size: .86rem; margin: 0; }
  main { display: grid; grid-template-columns: 1fr 320px; min-height: 0; }
  .table { display: grid; place-items: center; padding: 24px; overflow: auto; min-height: 0;
    background: radial-gradient(ellipse at 50% 40%, color-mix(in srgb, var(--table) 80%, #fff) 0%, var(--table) 70%); }
  #sheet { max-width: 100%; max-height: calc(100vh - 120px); filter: drop-shadow(0 10px 22px rgba(0, 0, 0, .45)); transition: opacity .2s; }
  #sheet.loading { opacity: .55; }
  aside { border-left: 1px solid var(--line); background: var(--surface); overflow-y: auto; padding: 16px 18px 28px; display: grid; gap: 18px; align-content: start; }
  aside section { display: grid; gap: 8px; }
  h2 { font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0; }
  label { display: flex; align-items: center; gap: 8px; font-size: .9rem; }
  label.stack { display: grid; gap: 4px; }
  input[type="text"], select { font: inherit; font-size: .9rem; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; width: 100%; }
  input:disabled + span { color: var(--muted); }
  .button { display: inline-flex; justify-content: center; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 7px; border: 1px solid var(--line); color: var(--ink); background: var(--surface); font: inherit; font-weight: 500; font-size: .9rem; cursor: pointer; text-decoration: none; }
  .button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .buttons { display: grid; gap: 8px; }
  #status { min-height: 1.3em; }
  #print-sheet { display: none; }
  @media (max-width: 820px) {
    main { grid-template-columns: 1fr; }
    aside { border-left: 0; border-top: 1px solid var(--line); }
    #sheet { max-height: 70vh; }
  }
  @media print {
    header, main { display: none !important; }
    body { display: block; background: none; }
    #print-sheet { display: block; width: 100vw; height: 100vh; object-fit: contain; }
  }
</style>
</head>
<body>
<header>
  <a href="/maps/${encodeURIComponent(id)}">← ${esc(name)}</a>
  <h1>Parchment handout</h1>
  <span class="note">The players' map, drawn by hand on old parchment. No room numbers, secret doors stay wall, and no GM notes.</span>
</header>
<main>
  <div class="table"><img id="sheet" alt="The handout"></div>
  <aside>
    <section>
      <h2>Sheet</h2>
      <label class="stack">Paper <select id="paper"><option value="a4">A4</option><option value="a3">A3</option><option value="letter">US Letter</option><option value="fit">Fit to the map (image)</option></select></label>
      <label class="stack">Orientation <select id="orientation"><option value="auto">Automatic (map as big as possible)</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
      <label class="stack">Title <input id="title" type="text" maxlength="120" value="${esc(name)}" placeholder="No title"></label>
    </section>
    <section>
      <h2>On the sheet</h2>
      <label><input id="compass" type="checkbox" checked> <span>Compass rose</span></label>
      <label><input id="scale" type="checkbox" checked> <span>Scale bar</span></label>
      <label><input id="frame" type="checkbox" checked> <span>Ink frame</span></label>
      <label><input id="stains" type="checkbox" checked> <span>Stains and wear</span></label>
      <label><input id="names" type="checkbox"> <span>Room names</span></label>
      <label title="${fogOn ? 'Fog of war is on for this map' : 'Turn fog of war on in the editor to use this'}"><input id="revealed" type="checkbox"${fogOn ? '' : ' disabled'}> <span>Only what the players have seen</span></label>
    </section>
    <section>
      <h2>Get it</h2>
      <div class="buttons">
        <button class="button primary" type="button" id="print">Print or save as PDF…</button>
        <a class="button" id="png" href="#">Download PNG (200 dpi, for printing)</a>
        <a class="button" id="png-hi" href="#">Download PNG (300 dpi)</a>
        <a class="button" id="svg" href="#">Download SVG</a>
      </div>
      <p class="note">Printing: choose the same paper size, no margins, and scale 100% (or "fit to page"). The PNG has see-through corners, so a VTT shows the torn edge.</p>
      <p id="status" class="note" role="status"></p>
    </section>
  </aside>
</main>
<img id="print-sheet" alt="">
<script id="delve-initial" type="application/json">${initial}</script>
<script>
(function () {
  var init = JSON.parse(document.getElementById('delve-initial').textContent);
  var $ = function (id) { return document.getElementById(id); };
  var base = '/api/v1/maps/' + encodeURIComponent(init.id) + '/handout';
  var sheet = $('sheet'), status = $('status');
  var size = null, timer = 0, current = '';
  function query(extra) {
    var q = new URLSearchParams({ paper: $('paper').value, orientation: $('orientation').value });
    var t = $('title').value.trim();
    if (t !== init.name) q.set('title', t);
    ['compass', 'scale', 'frame', 'stains'].forEach(function (k) { if (!$(k).checked) q.set(k, '0'); });
    ['names', 'revealed'].forEach(function (k) { if ($(k).checked) q.set(k, '1'); });
    Object.keys(extra || {}).forEach(function (k) { q.set(k, extra[k]); });
    return q.toString();
  }
  function update() {
    var q = query();
    $('png').href = base + '.png?' + query({ dpi: '200', download: '1' });
    $('png-hi').href = base + '.png?' + query({ dpi: '300', download: '1' });
    $('svg').href = base + '.svg?' + query({ download: '1' });
    if (q === current) return;
    current = q;
    sheet.classList.add('loading');
    status.textContent = 'Drawing…';
    fetch(base + '.png?' + query({ dpi: String(Math.round(Math.min(110, 72 * (window.devicePixelRatio || 1)))) })).then(function (res) {
      if (!res.ok) return res.json().then(function (b) { throw new Error(b.error || res.status); });
      var s = (res.headers.get('x-handout-size') || '').match(/^(\\d+)x(\\d+)pt$/);
      size = s ? { w: Number(s[1]), h: Number(s[2]) } : null;
      return res.blob();
    }).then(function (blob) {
      if (q !== current) return;
      if (sheet.src) URL.revokeObjectURL(sheet.src);
      sheet.src = URL.createObjectURL(blob);
      sheet.classList.remove('loading');
      status.textContent = size ? 'Sheet ' + Math.round(size.w / 72 * 25.4) + ' × ' + Math.round(size.h / 72 * 25.4) + ' mm.' : '';
      if (size) $('page-size').textContent = '@page { size: ' + size.w + 'pt ' + size.h + 'pt; margin: 0; }';
    }).catch(function (e) {
      sheet.classList.remove('loading');
      status.textContent = 'Drawing failed: ' + e.message;
    });
  }
  document.querySelectorAll('aside select, aside input').forEach(function (el) {
    el.addEventListener(el.type === 'text' ? 'input' : 'change', function () { clearTimeout(timer); timer = setTimeout(update, el.type === 'text' ? 500 : 0); });
  });
  $('print').addEventListener('click', function () {
    var img = $('print-sheet');
    var url = base + '.png?' + query({ dpi: '200' });
    if (img.dataset.url === url && img.complete && img.naturalWidth) return window.print();
    status.textContent = 'Preparing the print (200 dpi)…';
    img.onload = function () { status.textContent = ''; window.print(); };
    img.onerror = function () { status.textContent = 'Could not prepare the print.'; };
    img.dataset.url = url;
    img.src = url;
  });
  update();
})();
</script>
</body>
</html>`;
}

export function registerHandoutPage(app: FastifyInstance, store: MapStore): void {
  app.get('/maps/:id/handout', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { map } = store.get(id);
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(page(id, map.name, Boolean(map.fog?.on)));
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      return reply.code(404).type('text/plain').send('no such map');
    }
  });
}
