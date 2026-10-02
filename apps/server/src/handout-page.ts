// The handout page (/maps/:id/handout): the players' map on an old parchment
// sheet (core handout.ts), with a preview, the options, downloads and printing.
// The pictures come from /api/v1/maps/:id/handout.{png,svg}; printing puts the
// 200 dpi PNG on a page of the chosen paper size, so "Save as PDF" works too.
import type { FastifyInstance } from 'fastify';
import { htmlDocument, icon, themeSwitch, topBar } from '@delve/ui';
import { NotFoundError, type MapStore } from './store.ts';

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

function page(id: string, name: string, fogOn: boolean): string {
  const initial = JSON.stringify({ id, name, fogOn }).replace(/</g, '\\u003c');
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
      ${check('stains', 'Stains and wear', true)}
      ${check('names', 'Room names', false)}
      ${check('revealed', 'Only what the players have seen', false, ` title="${fogOn ? 'Fog of war is on for this map' : 'Turn fog of war on in the editor to use this'}"`)}
    </section>
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
  var size = null, timer = 0, current = '';
  // a cropped handout (the editor's "Crop to selection", MCP export crop): only that part of the map
  var crop = new URLSearchParams(location.search).get('crop');
  if (crop) { var cn = document.createElement('span'); cn.className = 'note'; cn.textContent = 'Cropped to squares ' + crop.split(',').join(', ') + '. '; var wa = document.createElement('a'); wa.href = location.pathname; wa.textContent = 'Whole map'; cn.appendChild(wa); document.querySelector('header').appendChild(cn); }
  function query(extra) {
    var q = new URLSearchParams({ paper: $('paper').value, orientation: $('orientation').value });
    if (crop) q.set('crop', crop);
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
`;
  return htmlDocument({ title: `${name} · Handout`, body, extra: `<style id="page-size">@page { size: A4 portrait; margin: 0; }</style><style>${PAGE_CSS}</style>` });
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
