// The table page (/play/:gameId): the HTML shell and CSS around the client in
// apps/web/src/table (built to /assets/table.js), on the shared look (@delve/ui, table-css.ts). The script draws the board,
// fills the panels and keeps everything live; this only lays the page out.
import { htmlDocument, icon, type IconName } from '@delve/ui';
import { NOTES_CSS } from './notes-css.ts';
import { TABLE_2D_CSS, TABLE_BASE_CSS } from './table-css.ts';

export interface TablePageOptions {
  gameId: string;
  gameName: string;
  version: string;
  me: { id: string; name: string; role: 'gm' | 'player' };
  /** Discord login is set up on this server (the GM gets the "needs Discord" switch). */
  discord?: boolean;
  /** The Discord login of this browser, if any: shown as "Logged in as … · Log out". */
  account?: { name: string };
  /** This member's seat belongs to that Discord login (so "leave on this device" means logging out). */
  linked?: boolean;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function tablePage(o: TablePageOptions): string {
  const gm = o.me.role === 'gm';
  const initial = JSON.stringify({ gameId: o.gameId, gameName: o.gameName, me: o.me, version: o.version }).replace(/</g, '\u003c');
  // a POST form, so no other site can log anyone out
  const account = o.account
    ? `<span class="account"><span class="who">Logged in as ${esc(o.account.name)} ·</span><form method="post" action="/auth/logout"><input type="hidden" name="next" value="/play"><button type="submit" title="Log out of Discord on this device">Log out</button></form></span>`
    : '';
  const tab = (id: string, ic: IconName, label: string, selected = false) =>
    `<button type="button" role="tab" id="tab-${id}" data-tab="${id}" aria-controls="panel-${id}" aria-selected="${selected}">${icon(ic, { size: 15 })}${label}</button>`;
  const crumb = gm ? `<a class="crumb tbl-desk" href="/play" title="All games">Delve Table</a>` : `<span class="crumb tbl-desk">Delve Table</span>`;
  const body = `<header class="topbar tbl-top">
  ${gm ? `<a class="topbar-brand" href="/" title="Delve">Delve</a>` : `<span class="topbar-brand">Delve</span>`}<span class="vsep tbl-desk"></span>
  ${crumb}${icon('chevron-right', { size: 14, className: 'crumb-sep tbl-desk' })}
  ${gm ? `<button type="button" id="game-name" title="Rename the game">${esc(o.gameName)}</button>` : `<span id="game-name">${esc(o.gameName)}</span>`}
  <span class="conn" title="Connection"><span id="conn-dot" data-state="connecting"></span><span id="conn-text">Connecting…</span></span>
  <div class="topbar-end">
    ${gm ? `<label class="layer" title="The layer you select and move tokens on"><span>Layer</span><select id="layer-select"><option value="map">Map</option><option value="tokens" selected>Tokens</option><option value="gm">GM only</option></select></label><span class="vsep tbl-desk" style="margin:0 4px"></span>` : ''}
    <span class="me" id="me"><span class="dot" id="me-dot"></span><span id="me-name">${esc(o.me.name)}</span><span class="role muted">· ${gm ? 'GM' : 'Player'}</span></span>
    ${account}
    <a class="btn btn-plain" id="to-3d" href="/play/${encodeURIComponent(o.gameId)}/3d" title="The table in 3D (the same game, live)">${icon('3d', { size: 17 })}3D</a>
    <button type="button" class="btn btn-icon" id="side-toggle" aria-pressed="true" aria-controls="side" aria-label="Show or hide the panel" title="Panel">${icon('chat', { size: 18 })}<span class="badge" id="side-badge" hidden></span></button>
  </div>
</header>
<div id="main">
  <div id="stage">
    <div id="page-banner" aria-live="polite"></div>
    <div id="board-note" hidden></div>
    <div class="zoom" role="group" aria-label="Zoom">
      <button type="button" id="zoom-out" title="Zoom out · −" aria-label="Zoom out">${icon('zoom-out', { size: 18 })}</button><button type="button" id="zoom-in" title="Zoom in · +" aria-label="Zoom in">${icon('zoom-in', { size: 18 })}</button><button type="button" id="fit" title="Fit the page · F" aria-label="Fit the page">${icon('fit', { size: 18 })}</button>
    </div>
    <div id="toast" role="status" hidden></div>
  </div>
  <aside id="side" aria-label="Table panels">
    <nav class="tabs" role="tablist">
      ${tab('chat', 'chat', 'Chat<span class="badge" id="chat-badge" hidden></span>', true)}
      ${tab('turn', 'dice', 'Turn order')}
      ${gm ? tab('pages', 'layers', 'Pages') + tab('tokens', 'prop', 'Tokens') + tab('notes', 'notes', 'Notes') : ''}
      ${tab('players', 'users', 'Players')}
    </nav>
    <section class="panel" id="panel-chat" data-panel="chat" role="tabpanel" aria-labelledby="tab-chat">
      <div id="chat-log" role="log" aria-live="polite"></div>
      <form id="chat-form" autocomplete="off">
        <textarea id="chat-input" rows="2" placeholder="Message, or /r 1d20+3" aria-label="Chat message"></textarea>
        <button class="btn primary" type="submit" title="Send · Enter">${icon('send', { size: 16 })}Send</button>
      </form>
      <p class="hint" id="chat-hint"></p>
      <div class="chat-opts"><label class="check" title="Throw 3D dice onto the table for every roll you can see"><input type="checkbox" id="dice-toggle"> 3D dice</label></div>
    </section>
    <section class="panel" id="panel-turn" data-panel="turn" role="tabpanel" aria-labelledby="tab-turn" hidden></section>
    ${gm ? `<section class="panel" id="panel-pages" data-panel="pages" role="tabpanel" aria-labelledby="tab-pages" hidden></section>
    <section class="panel" id="panel-tokens" data-panel="tokens" role="tabpanel" aria-labelledby="tab-tokens" hidden></section>
    <section class="panel notes-panel" id="panel-notes" data-panel="notes" role="tabpanel" aria-labelledby="tab-notes" hidden></section>` : ''}
    <section class="panel" id="panel-players" data-panel="players" role="tabpanel" aria-labelledby="tab-players"${o.discord ? ' data-discord="1"' : ''}${o.linked ? ' data-linked="1"' : ''} hidden></section>
  </aside>
</div>
<script id="table-initial" type="application/json">${initial}</script>
<script type="module" src="/assets/table.js?v=${encodeURIComponent(o.version)}"></script>`;
  return htmlDocument({
    title: `${o.gameName} · Delve Table`,
    body,
    bodyClass: gm ? 'role-gm' : 'role-player',
    extra: `<style>${TABLE_BASE_CSS}${TABLE_2D_CSS}${gm ? NOTES_CSS : ''}</style>`,
  });
}
