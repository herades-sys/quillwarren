// The 3D table page (/play/:gameId/3d): the HTML shell and CSS around the
// client in apps/web/src/table/app3d.ts (built to /assets/table3d.js, with
// three.js). The script builds the scene, fills the panel and keeps it live
// over the same WebSocket as the 2D table; this only lays the page out.
import { htmlDocument, icon } from '@delve/ui';
import { NOTES_CSS } from './notes-css.ts';
import { TABLE_3D_CSS, TABLE_BASE_CSS } from './table-css.ts';

export interface Table3dPageOptions {
  gameId: string;
  gameName: string;
  version: string;
  me: { id: string; name: string; role: 'gm' | 'player' };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function table3dPage(o: Table3dPageOptions): string {
  const gm = o.me.role === 'gm';
  const initial = JSON.stringify({ gameId: o.gameId, gameName: o.gameName, me: o.me, version: o.version }).replace(/</g, '\u003c');
  const game = encodeURIComponent(o.gameId);
  const crumb = gm ? `<a class="crumb tbl-desk" href="/play" title="All games">Delve Table</a>` : `<span class="crumb tbl-desk">Delve Table</span>`;
  const body = `<header class="topbar tbl-top">
  ${gm ? `<a class="topbar-brand" href="/" title="Delve">Delve</a>` : `<span class="topbar-brand">Delve</span>`}<span class="vsep tbl-desk"></span>
  ${crumb}${icon('chevron-right', { size: 14, className: 'crumb-sep tbl-desk' })}
  <span id="game-name">${esc(o.gameName)}</span>
  <span class="badge3d" title="The table in 3D">3D</span>
  <span class="conn" title="Connection"><span id="conn-dot" data-state="connecting"></span><span id="conn-text">Connecting…</span></span>
  <div class="topbar-end">
    <span class="me" id="me"><span class="dot" id="me-dot"></span><span id="me-name">${esc(o.me.name)}</span><span class="role muted">· ${gm ? 'GM' : 'Player'}</span></span>
    <a class="btn btn-plain" id="to-2d" href="/play/${game}" title="Back to the flat table (the same game, live)">${icon('layers', { size: 17 })}2D</a>
    <button type="button" class="btn btn-icon" id="side-toggle" aria-pressed="true" aria-controls="side" aria-label="Show or hide the panel" title="Panel">${icon('chat', { size: 18 })}</button>
  </div>
</header>
<div id="main">
  <div id="stage">
    <div id="tags3d"></div>
    <div id="page-banner" aria-live="polite"></div>
    <div id="board-note" hidden></div>
    <div id="status3d">Loading the table…</div>
    <div class="cam" role="group" aria-label="Camera">
      <button type="button" id="cam-top" title="Look straight down · T">Top</button><button type="button" id="cam-fit" title="Show the whole page · F" aria-label="Show the whole page">${icon('fit', { size: 18 })}</button><button type="button" id="cam-follow" aria-pressed="false" title="Keep the selected mini in the middle · L">Follow</button><button type="button" id="cam-flat" aria-pressed="false" title="Lay the minis flat, as discs seen from above">Flat</button>
    </div>
    <div id="toast" role="status" hidden></div>
  </div>
  <aside id="side" aria-label="3D table panels">
    <nav class="tabs" role="tablist" id="tabs3d"></nav>
  </aside>
</div>
<script id="table3d-initial" type="application/json">${initial}</script>
<script type="module" src="/assets/table3d.js?v=${encodeURIComponent(o.version)}"></script>`;
  return htmlDocument({
    title: `${o.gameName} in 3D · Delve Table`,
    body,
    bodyClass: gm ? 'role-gm' : 'role-player',
    extra: `<style>${TABLE_BASE_CSS}${TABLE_3D_CSS}${gm ? NOTES_CSS : ''}</style>`,
  });
}
