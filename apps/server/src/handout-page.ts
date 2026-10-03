// The handout page (/maps/:id/handout): the players' map on an old parchment
// sheet (core handout.ts), with a preview, the options, downloads and printing.
// The pictures come from /api/v1/maps/:id/handout.{png,svg}; printing puts the
// 200 dpi PNG on a page of the chosen paper size, so "Save as PDF" works too.
// GMs with the editor login also get the Notes tool for handwritten notes on
// the sheet (/assets/handout.js, apps/web/src/handout.ts).
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { htmlDocument, icon, themeSwitch, topBar } from '@delve/ui';
import { NotFoundError, type MapStore } from './store.ts';
import { isLoggedIn, type EditorAuth } from './login.ts';
import { findScript } from './viewer.ts';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);


const PAGE_CSS = `
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; }
  main { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 320px; }
  .table { display: grid; place-items: center; padding: 24px; overflow: auto; min-height: 0;
    background: radial-gradient(ellipse at 50% 40%, color-mix(in srgb, #4A3A2A 80%, #fff) 0%, #4A3A2A 70%); }
  [data-theme="dark"] .table { background: radial-gradient(ellipse at 50% 40%, #3a2e22 0%, #2A2119 70%); }
  #sheet { max-width: 100%; max-height: calc(100vh - 110px); filter: drop-shadow(0 10px 22px rgba(0, 0, 0, .45)); transition: opacity .2s; }
  #sheet.loading { opacity: .55; }
  aside { background: var(--color-surface); box-shadow: inset 1px 0 0 var(--color-border); overflow-y: auto; padding: 16px 18px 28px; display: flex; flex-direction: column; gap: 20px; }
  aside section { display: flex; flex-direction: column; gap: 10px; }
  .hand-intro { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); line-height: 1.5; }
  .buttons { display: flex; flex-direction: column; gap: 8px; }
  .buttons .btn { justify-content: flex-start; }
  .note { color: var(--color-text-muted); font-size: var(--text-sm); margin: 0; line-height: 1.5; }
  .check:has(input:disabled) span:last-child { color: var(--color-text-muted); }
  #status { min-height: 1.3em; }
  #print-sheet { display: none; }
  /* handwritten notes (GM only, apps/web/src/handout.ts): the layer over the preview and the text box */
  .table { position: relative; }
  #notes-layer { position: absolute; overflow: visible; pointer-events: none; }
  #notes-layer.is-on { pointer-events: auto; cursor: crosshair; touch-action: none; }
  #notes-layer:not(.is-on) .hn-hit { pointer-events: none; }
  #notes-layer .hn-hit { fill: transparent; stroke: none; pointer-events: all; cursor: move; }
  #notes-layer .hn:hover .hn-hit { fill: rgba(255, 248, 225, .18); }
  #notes-layer .hn-off { opacity: .4; }
  #notes-layer .hn-sel { fill: none; stroke: var(--color-accent); stroke-opacity: 1; stroke-width: 1.5px; stroke-dasharray: 5 4; vector-effect: non-scaling-stroke; pointer-events: none; }
  .hn-editor { position: absolute; z-index: 2; margin: 0; padding: 2px 6px; resize: none; overflow: hidden; white-space: pre; text-align: center; line-height: 1.2;
    font-family: "IM Fell English", Georgia, serif; font-style: italic; background: rgba(243, 230, 196, .82); border: 1.5px dashed var(--color-accent); border-radius: var(--radius-sm); outline: none; box-shadow: var(--shadow-md); transform-origin: 50% 50%; }
  #notes-panel { display: flex; flex-direction: column; gap: 10px; }
  #notes-panel .btn { justify-content: flex-start; }
  .hn-inks { display: flex; width: 100%; }
  .hn-inks .seg-opt { flex: 1; justify-content: center; padding: 7px 4px; }
  .hn-ink { display: inline-flex; align-items: center; gap: 5px; }
  #notes-toggle[aria-pressed="true"] { color: var(--color-accent); box-shadow: inset 0 0 0 1px var(--color-accent); }
  .hn-ink-dot { width: 10px; height: 10px; border-radius: 50%; box-shadow: 0 0 0 1px var(--color-border); }
  .hn-acts { display: flex; gap: 8px; flex-wrap: wrap; }
  @media (max-width: 820px) {
    main { grid-template-columns: 1fr; }
    aside { box-shadow: inset 0 1px 0 var(--color-border); }
    #sheet { max-height: 70vh; }
  }
  @media print {
    .topbar, main { display: none !important; }
    body { display: block; background: none; }
    #print-sheet { display: block; width: 100vw; height: 100vh; object-fit: contain; }
  }
`;

/** What the page needs to know about the viewer: GMs with the editor login get the Notes tool and its script. */
export interface HandoutPageViewer {
  editor: boolean;
  version: string;
}

function page(id: string, name: string, fogOn: boolean, viewer: HandoutPageViewer = { editor: false, version: '' }): string {
  const initial = JSON.stringify({ id, name, fogOn }).replace(/</g, '\\u003c');
  // handwritten notes: the panel is filled by /assets/handout.js (apps/web/src/handout.ts)
  const notesTool = viewer.editor
    ? `<section id="notes-tool">
      <span class="section-label">Handwritten notes</span>
      <div id="notes-panel"><p class="note">Loading the notes tool…</p></div>
    </section>`
    : '';
  const notesScript = viewer.editor ? `<script type="module" src="/assets/handout.js?v=${encodeURIComponent(viewer.version)}"></script>` : '';
  const chev = icon('chevron-down', { size: 14 });
  const tick = `<span class="box">${icon('check', { size: 12, stroke: 2.8 })}</span>`;
  const check = (idAttr: string, label: string, on: boolean, extra = '') => `<label class="check"${extra}><input id="${idAttr}" type="checkbox"${on ? ' checked' : ''}${fogOn || idAttr !== 'revealed' ? '' : ' disabled'}>${tick}<span>${label}</span></label>`;
  const end = `<a class="btn btn-secondary" href="/maps/${encodeURIComponent(id)}">${icon('layers', { size: 16 })}Back to the map</a>${themeSwitch()}`;
  const body = `${topBar({ crumbs: [{ href: '/', text: 'Library' }, { href: `/maps/${encodeURIComponent(id)}`, text: name }], title: 'Parchment handout', end })}
<main>
  <div class="table"><img id="sheet" alt="The handout"></div>
  <aside>
    <p class="hand-intro">The players’ map, drawn by hand on old parchment. No room numbers, secret doors stay wall, and no GM notes.</p>
    <section>
      <span class="section-label">Sheet</span>
      <div class="field"><label for="paper">Paper</label><div class="select"><select class="input" id="paper"><option value="a4">A4</option><option value="a3">A3</option><option value="letter">US Letter</option><option value="fit">Fit to the map (image)</option></select>${chev}</div></div>
      <div class="field"><label for="orientation">Orientation</label><div class="select"><select class="input" id="orientation"><option value="auto">Automatic (map as big as possible)</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select>${chev}</div></div>
      <div class="field"><label for="title">Title</label><input class="input" id="title" type="text" maxlength="120" value="${esc(name)}" placeholder="No title"></div>
    </section>
    <section>
      <span class="section-label">On the sheet</span>
      ${check('compass', 'Compass rose', true)}
      ${check('scale', 'Scale bar', true)}
      ${check('frame', 'Ink frame', true)}
      ${check('legend', 'Legend', true, ' title="A key to what is drawn on the sheet: doors, stairs, terrain and props"')}
      ${check('stains', 'Stains and wear', true)}
      ${check('names', 'Room names', false)}
      ${check('revealed', 'Only what the players have seen', false, ` title="${fogOn ? 'Fog of war is on for this map' : 'Turn fog of war on in the editor to use this'}"`)}
    </section>
    ${notesTool}
    <section>
      <span class="section-label">Get it</span>
      <div class="buttons">
        <button class="btn btn-primary" type="button" id="print">${icon('notes', { size: 16 })}Print or save as PDF…</button>
        <a class="btn btn-secondary" id="png" href="#">${icon('download', { size: 16 })}Download PNG (200 dpi, for printing)</a>
        <a class="btn btn-secondary" id="png-hi" href="#">${icon('download', { size: 16 })}Download PNG (300 dpi)</a>
        <a class="btn btn-secondary" id="svg" href="#">${icon('download', { size: 16 })}Download SVG</a>
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
  var size = null, timer = 0, current = '', previewExtra = {};
  // a cropped handout (the editor's "Crop to selection", MCP export crop): only that part of the map
  var crop = new URLSearchParams(location.search).get('crop');
  if (crop) { var cn = document.createElement('span'); cn.className = 'note'; cn.textContent = 'Cropped to squares ' + crop.split(',').join(', ') + '. '; var wa = document.createElement('a'); wa.href = location.pathname; wa.textContent = 'Whole map'; cn.appendChild(wa); document.querySelector('header').appendChild(cn); }
  // the legend: legend=0 in the page's address starts without it, legend=1 keeps it even for a single entry (MCP export)
  var legendQ = new URLSearchParams(location.search).get('legend');
  if (legendQ === '0') $('legend').checked = false;
  function query(extra) {
    var q = new URLSearchParams({ paper: $('paper').value, orientation: $('orientation').value });
    if (crop) q.set('crop', crop);
    var t = $('title').value.trim();
    if (t !== init.name) q.set('title', t);
    ['compass', 'scale', 'frame', 'stains', 'legend'].forEach(function (k) { if (!$(k).checked) q.set(k, '0'); });
    if ($('legend').checked && legendQ === '1') q.set('legend', '1');
    ['names', 'revealed'].forEach(function (k) { if ($(k).checked) q.set(k, '1'); });
    Object.keys(extra || {}).forEach(function (k) { q.set(k, extra[k]); });
    return q.toString();
  }
  function update() {
    $('png').href = base + '.png?' + query({ dpi: '200', download: '1' });
    $('png-hi').href = base + '.png?' + query({ dpi: '300', download: '1' });
    $('svg').href = base + '.svg?' + query({ download: '1' });
    // the preview: the downloads' query plus its own dpi and, while the GM writes notes, inscriptions=0
    var q = query(Object.assign({ dpi: String(Math.round(Math.min(110, 72 * (window.devicePixelRatio || 1)))) }, previewExtra));
    var withNotes = previewExtra.inscriptions !== '0', frame = null;
    if (q === current) return;
    current = q;
    sheet.classList.add('loading');
    status.textContent = 'Drawing…';
    fetch(base + '.png?' + q).then(function (res) {
      if (!res.ok) return res.json().then(function (b) { throw new Error(b.error || res.status); });
      var s = (res.headers.get('x-handout-size') || '').match(/^(\\d+)x(\\d+)pt$/);
      size = s ? { w: Number(s[1]), h: Number(s[2]) } : null;
      frame = res.headers.get('x-handout-frame');
      return res.blob();
    }).then(function (blob) {
      if (q !== current) return;
      if (sheet.src) URL.revokeObjectURL(sheet.src);
      sheet.src = URL.createObjectURL(blob);
      sheet.classList.remove('loading');
      status.textContent = size ? 'Sheet ' + Math.round(size.w / 72 * 25.4) + ' × ' + Math.round(size.h / 72 * 25.4) + ' mm.' : '';
      if (size) $('page-size').textContent = '@page { size: ' + size.w + 'pt ' + size.h + 'pt; margin: 0; }';
      // the notes tool (GM only) lays its layer over the picture once it has its new size
      var done = function () {
        handout.last = { frame: frame, notes: withNotes };
        document.dispatchEvent(new CustomEvent('handout:drawn', { detail: handout.last }));
      };
      if (sheet.decode) sheet.decode().then(done, done); else done();
    }).catch(function (e) {
      sheet.classList.remove('loading');
      status.textContent = 'Drawing failed: ' + e.message;
    });
  }
  // for the notes tool: its own preview query, and drawing again when the map changes
  var handout = window.delveHandout = {
    last: null,
    preview: function (extra) { previewExtra = extra || {}; update(); },
    refresh: function () { current = ''; clearTimeout(timer); timer = setTimeout(update, 250); }
  };
  document.querySelectorAll('aside select, aside input').forEach(function (el) {
    if (el.closest('#notes-panel')) return;
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
${notesScript}
`;
  return htmlDocument({ title: `${name} · Handout`, body, extra: `<style id="page-size">@page { size: A4 portrait; margin: 0; }</style><style>${PAGE_CSS}</style>` });
}

export function registerHandoutPage(app: FastifyInstance, store: MapStore, auth?: EditorAuth, version = ''): void {
  app.get('/maps/:id/handout', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { map } = store.get(id);
      const viewer = { editor: auth ? isLoggedIn(auth, req) : false, version };
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(page(id, map.name, Boolean(map.fog?.on), viewer));
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      return reply.code(404).type('text/plain').send('no such map');
    }
  });

  // the Notes tool's script, built by scripts/build-web.sh like the others (viewer.ts serves those)
  let script: string | undefined;
  app.get('/assets/handout.js', async (_req, reply) => {
    if (script === undefined) {
      const file = findScript('handout.js');
      if (!file) return reply.code(404).type('text/plain').send('handout.js not built: run npm run build:web');
      script = readFileSync(file, 'utf8');
    }
    return reply.type('text/javascript; charset=utf-8').header('cache-control', version === 'dev' ? 'no-store' : 'public, max-age=300').send(script);
  });
}
