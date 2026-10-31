// The map page (/maps/:id): the live viewer, and the editor for logged-in GMs,
// laid out as in the design (docs/design/ui-v1/Delve Editor.dc.html): top bar
// 48, tool rail 52, the canvas, the inspector 288 and Claude 344. Below 1280 px
// Claude floats, below 1024 the inspector becomes a drawer, below 768 the phone
// layout takes over: a bottom toolbar, and sheets for the inspector and Claude.
//
// The top bar comes in groups: where you are (Library › place › storey), editing
// (undo, redo, saved), the view (GM / Players, 3D, the players' screen) in the
// middle, then export (Snip, Export) and status and panels (live, chat, who) at
// the end. The context strip (the active tool, its options and help) is docked
// above the canvas, so it never covers the map.
//
// The first picture is rendered here, so it shows before the script loads; the
// script (apps/web/src/viewer.ts) then fills the rail, the context strip and the
// panels, and follows changes over the WebSocket.
import { floorText, sceneToSvg, type DelveMap, type Level } from '@delve/core';
import { esc, htmlDocument, icon, jsonForScript, type IconName } from '@delve/ui';
import type { AppInfo } from './app.ts';
import { sceneFor } from './render.ts';

export interface EditorPageOpts {
  view: 'gm' | 'players';
  style: string | undefined;
  loggedIn: boolean;
  passwordSet: boolean;
  /** The chat panel's default model, when the chat bridge is set up (logged-in editors only). */
  chatModel: string | null;
  /** This map's storeys, top first (empty unless it is one of several). */
  levels: { id: string; name: string; level?: Level }[];
  /** Who is logged in, for the avatar (null: the shared password, or open edit). */
  account: { name: string; role: 'admin' | 'gm' } | null;
  /** The desktop app: the chat backend in use, the ones offered (settings show for two or more) and the assistant's name. Never set on the web server. */
  chatChoice?: { backend: string; offered: readonly string[]; name: string };
  /** Snip an area to a PNG (the Snip button, Shift S): admin and GM accounts, and open-edit development servers. */
  snip: boolean;
  /** The desktop app (no players): false leaves out the players' screen links, and the editor's hints about Delve Table. Never set on the web server. */
  multiplayer?: false;
}

/** "AN" for Ana, "MV" for Mara Venn. */
const initials = (name: string): string => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0]![0]! + w[1]![0]! : (w[0] ?? '?').slice(0, 2)).toUpperCase();
};

const ic = (name: IconName, size = 18): string => icon(name, { size });

/** The Claude panel's "Show Claude's plan" toggle: a checklist, drawn like the design's icons (24 grid, 1.7 stroke). */
const PLAN_ICON = '<svg class="icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5l1.6 1.6L8.5 5.2M4 12.5l1.6 1.6 2.9-2.9M4.8 18.5h3M12 6.7h8M12 12.7h8M12 18.5h8"/></svg>';

/** Snip (export an area): crop marks, drawn like the design's icons. */
const SNIP_ICON = '<svg class="icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3v12.5a1.5 1.5 0 0 0 1.5 1.5H21M3 7h12.5A1.5 1.5 0 0 1 17 8.5V21"/></svg>';

/** The chat settings (apps/web/src/chat.ts fills them): only on pages with a choice of backends, so the web editor never carries it. */
const CHAT_SETTINGS_CSS = `
  .ed-chat-settings { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
  .ed-chat-settings[hidden] { display: none; }
  .ed-cs-title { margin: 0; font-size: 13px; font-weight: 600; }
  .ed-cs-choices { display: flex; flex-direction: column; gap: 8px; }
  .ed-cs-choice { display: flex; gap: 10px; align-items: flex-start; padding: 9px 11px; border-radius: var(--radius-md); box-shadow: inset 0 0 0 1px var(--color-border); cursor: pointer; }
  .ed-cs-choice:has(input:checked) { box-shadow: inset 0 0 0 1.5px var(--color-accent); }
  .ed-cs-choice input { margin-top: 3px; accent-color: var(--color-accent); }
  .ed-cs-sub { display: block; font-size: 12px; color: var(--color-text-muted); line-height: 1.35; }
  .ed-cs-local { display: flex; flex-direction: column; gap: 10px; }
  .ed-cs-local[hidden] { display: none; }
  .ed-cs-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .ed-cs-result { font-size: 12.5px; color: var(--color-text-muted); line-height: 1.4; }
  .ed-cs-result[data-kind="bad"] { color: var(--color-danger); }
  .ed-cs-off { color: var(--color-text-muted); font-size: 13px; line-height: 1.45; }
`;

export function editorPage(info: AppInfo, id: string, rev: number, map: DelveMap, o: EditorPageOpts): string {
  const { view, style } = o;
  const enc = encodeURIComponent(id);
  const scene = sceneFor(map, { view, style, fog: '1' });
  // the top bar's storey button shows the floor number instead
  scene.layers = scene.layers.filter((l) => l.name !== 'floor-number');
  const bg = scene.layers[0]?.kind === 'rect' ? scene.layers[0].color : 'var(--canvas-parchment)';
  const edit = o.loggedIn;
  const choice = o.chatChoice;
  // "Claude" whenever Claude answers: the web's bridge, or the desktop app's Anthropic key (chat.ts renames it on a switch)
  const ai = esc(!choice || choice.backend === 'anthropic' ? 'Claude' : choice.name);
  const chat = edit && (o.chatModel || choice) ? { enabled: true, model: o.chatModel ?? '', ...(choice ? { backend: choice.backend, backends: choice.offered, name: choice.name } : {}) } : undefined;
  const chatSettings = Boolean(choice && choice.offered.length > 1);
  const screen = o.multiplayer !== false;
  const initial = jsonForScript({
    id,
    rev,
    map,
    levels: o.levels,
    edit: { loggedIn: o.loggedIn, passwordSet: o.passwordSet },
    account: o.account,
    ...(chat ? { chat } : {}),
    ...(o.snip ? { snip: true } : {}),
    ...(screen ? {} : { multiplayer: false }),
  });
  const q = `view=${view}${style ? `&style=${encodeURIComponent(style)}` : ''}`;
  const loginHref = `/login?next=${encodeURIComponent(`/maps/${id}`)}`;
  const feedbackHref = `/feedback?from=${encodeURIComponent(`/maps/${id}`)}`;

  // Export: the same links in the Export menu and, on narrow screens, the ⋯ menu.
  const exports: [IconName, string, string, string, string, string][] = [
    ['download', 'png-link', `/api/v1/maps/${enc}/render.png?${q}`, 'PNG for Roll20', '70 px per square, grid-aligned', 'download'],
    ['download', 'svg-link', `/api/v1/maps/${enc}/render.svg?${q}`, 'SVG', 'Vector, layers kept', 'download'],
    ['download', 'ds-link', `/api/v1/maps/${enc}/export.ds`, 'Dungeon Scrawl .ds', 'Opens again in Dungeon Scrawl', 'download'],
    ['notes', 'view-handout', `/maps/${enc}/handout`, 'Parchment handout', 'Printable players’ map, no grid', ''],
  ];
  const menuItem = (icn: IconName, idAttr: string, href: string, label: string, sub: string, dl: string, extra = '') =>
    `<a class="menu-item has-icon" role="menuitem"${idAttr ? ` id="${idAttr}"` : ''} href="${esc(href)}"${dl ? ' download' : ''}${extra}>${ic(icn, 17)}<span class="spacer"><span>${esc(label)}</span>${sub ? `<span class="menu-item-sub">${esc(sub)}</span>` : ''}</span></a>`;
  // Crop to selection: shown while something is selected; the editor (apps/web/src/editor.ts) fills in the frame
  const crops: [string, IconName, string, string, string][] = [
    ['png-gm', 'download', 'PNG · GM view', 'The selection plus a square, grid-aligned', 'download'],
    ['png-players', 'download', 'PNG · players', 'What the players see of it', 'download'],
    ['svg', 'download', 'SVG', 'Vector, in the current view', 'download'],
    ['handout', 'notes', 'Parchment handout', 'Just this part on the sheet', ''],
  ];
  const cropGroup = edit
    ? `<div class="ed-crop" data-crop-group hidden><span class="section-label ed-menu-label" data-crop-label>Crop to selection</span>${crops
        .map(([key, icn, label, sub, dl]) => menuItem(icn, '', '#', label, sub, dl, ` data-crop="${key}"`))
        .join('')}</div>`
    : '';
  // Snip an area: the first item, for admin and GM accounts (apps/web/src/snip.ts runs it)
  const snipItem = o.snip
    ? `<button class="menu-item has-icon" role="menuitem" type="button" data-act="snip">${SNIP_ICON}<span class="spacer"><span>Snip an area…</span><span class="menu-item-sub">Drag a box over the map, save it as a PNG</span></span><kbd>Shift S</kbd></button>`
    : '';
  const exportItems = snipItem + exports.map((e) => menuItem(...e)).join('') + cropGroup;
  const moreItems = [
    menuItem('3d', '', `/maps/${enc}/3d`, '3D view', 'All storeys stacked', ''),
    screen ? menuItem('screen', '', `/maps/${enc}/screen`, 'Players’ screen', 'Opens in a new window', '', ' target="_blank" rel="noopener"') : '',
    snipItem,
    exports.map((e) => menuItem(e[0], '', e[2], e[3], e[4], e[5])).join(''),
    cropGroup,
    edit ? `<button class="menu-item has-icon" role="menuitem" type="button" data-act="map-settings">${ic('settings', 17)}<span class="spacer">Map settings</span></button>` : '',
    `<button class="menu-item has-icon" role="menuitem" type="button" data-act="shortcuts">${ic('keyboard', 17)}<span class="spacer">Keyboard shortcuts</span><kbd>?</kbd></button>`,
    menuItem('send', '', feedbackHref, 'Request a feature', 'Or report a problem', ''),
  ].join('');

  const viewSeg = (name: string, cls = '') =>
    `<div class="seg seg-ground ed-view${cls}" role="radiogroup" aria-label="View as" title="Shift P">
<label class="seg-opt"><input type="radio" name="${name}" value="gm"${view === 'gm' ? ' checked' : ''}>${ic('eye', 16)}<span class="lbl">GM view</span><span class="lbl-short">GM</span></label><label class="seg-opt"><input type="radio" name="${name}" value="players"${view === 'players' ? ' checked' : ''}>${ic('eye-off', 16)}Players</label></div>`;

  const who = o.account
    ? `<span class="avatar ed-avatar" title="${esc(o.account.name)} · ${o.account.role === 'admin' ? 'Admin' : 'GM'}">${esc(initials(o.account.name))}</span>`
    : '';

  // The storey button after the place's name: "1 · Belfry" (apps/web/src/shell.ts keeps it
  // current and opens its menu). A map that isn't one of several storeys shows none.
  const many = o.levels.length > 1;
  const at = o.levels.findIndex((l) => l.id === id);
  const here = o.levels[at];
  const storeyNum = here ? (here.level ? floorText(here.level.order) : String(o.levels.length - 1 - at)) : '';
  const storeyName = here ? (here.level?.name ?? here.name) : '';
  const storeyText = esc(`${storeyNum} · ${storeyName}`);
  const storey = `<div class="ed-menu-wrap ed-storey"${many ? '' : ' hidden'}>${icon('chevron-right', { size: 14, className: 'crumb-sep ed-desk' })}<button class="btn btn-plain ed-storey-btn" type="button" id="storey-btn" aria-label="Storey ${storeyText}: change storey" title="Storey: ${storeyText} — change (PgUp / PgDn)" aria-haspopup="menu" aria-expanded="false"${many ? '' : ' hidden'}><span class="ed-storey-chip" id="storey-chip"><span class="ed-storey-num">${esc(storeyNum)}</span><span class="ed-storey-name">${esc(storeyName)}</span></span>${icon('chevron-down', { size: 14, className: 'text-muted' })}</button></div>`;

  const top = `<header class="topbar ed-top">
<div class="ed-top-start">
  <a class="ed-back btn btn-icon" href="/" aria-label="Back to library">${icon('chevron-right', { size: 22, className: 'flip' })}</a>
  <a class="topbar-brand" href="/">Delve</a><span class="vsep ed-desk"></span>
  <a class="crumb ed-desk ed-crumb-lib" href="/">Library</a>${icon('chevron-right', { size: 14, className: 'crumb-sep ed-desk ed-crumb-lib' })}
  <div class="ed-title"><span class="crumb-title" id="map-name">${esc(map.name)}</span><span class="ed-subline"><span class="status status-connecting" id="conn-mini">Connecting…</span></span></div>
  ${storey}
  ${edit ? `<span class="vsep ed-desk"></span>
  <div class="ed-group ed-edit" role="group" aria-label="Editing"><div class="ed-history"><button class="btn btn-icon" type="button" id="undo" aria-label="Undo" title="Undo · Ctrl Z">${ic('undo')}</button><button class="btn btn-icon" type="button" id="redo" aria-label="Redo" title="Redo · Ctrl Shift Z">${ic('redo')}</button></div><span class="save-state ed-desk" id="save-state" role="status" title="Saved">${ic('check', 14)}<span>Saved</span></span></div>` : ''}
</div>
<div class="ed-group ed-group-view" role="group" aria-label="View">
  ${viewSeg('view', '')}
  <a class="btn btn-plain ed-wide" id="view-3d" href="/maps/${enc}/3d" title="All storeys stacked in 3D">${ic('3d', 17)}3D</a>
  ${screen ? `<a class="btn btn-primary ed-wide" id="screen-link" href="/maps/${enc}/screen" target="_blank" rel="noopener" aria-label="Players’ screen" title="Open the players' screen in a new window">${ic('screen', 17)}<span class="lbl">Players’ screen</span></a>` : ''}
</div>
<div class="ed-top-end">
  <div class="ed-group ed-wide" role="group" aria-label="Export">
    ${o.snip ? `<button class="btn btn-plain" type="button" id="snip-btn" aria-pressed="false" aria-label="Snip" title="Snip an area and save it as a PNG · Shift S">${SNIP_ICON}<span class="lbl">Snip</span></button>` : ''}
    <div class="ed-menu-wrap"><button class="btn btn-secondary" type="button" id="export-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="export-menu">${ic('download', 17)}Export${icon('chevron-down', { size: 14, className: 'text-muted' })}</button>
      <div class="menu ed-menu" role="menu" id="export-menu" hidden>${exportItems}</div></div>
  </div>
  <div class="ed-menu-wrap ed-narrow"><button class="btn btn-icon" type="button" id="more-btn" aria-label="More: export, 3D, ${screen ? 'players’ screen, ' : ''}settings" aria-haspopup="menu" aria-expanded="false" aria-controls="more-menu">${ic('more', 20)}</button>
    <div class="menu ed-menu" role="menu" id="more-menu" hidden>${moreItems}</div></div>
  <span class="vsep ed-desk"></span>
  <div class="ed-group ed-status">
    <span class="status status-connecting ed-desk" id="conn" role="status" title="Connecting to the live map">Connecting…</span>
    ${chat ? `<button class="btn btn-icon ed-chat-btn" type="button" id="chat-toggle" aria-pressed="false" aria-label="Chat with ${ai}" title="${ai} · Ctrl .">${ic('chat')}</button>` : ''}
    ${edit ? who : `<a class="btn btn-secondary" id="login-link" href="${esc(loginHref)}">${ic('lock', 15)}<span class="lbl">Log in to edit</span></a>`}
  </div>
</div>
</header>`;

  const chatPanel = chat
    ? `<aside class="ed-claude ed-sheet" id="chat" hidden aria-label="Chat with ${ai}"${choice ? ` data-assistant="${ai}"` : ''}>
  <span class="sheet-handle ed-phone-only"></span>
  <div class="ed-panel-head"><span class="ed-panel-title">${ai}</span><span class="tag tag-accent tag-sm" id="chat-live" hidden><span class="dot"></span>Editing live</span>
    <div class="select ed-model"><select id="chat-model" class="input" aria-label="Model"></select>${ic('chevron-down', 13)}</div>
    <span class="spacer"></span>
    <button class="btn btn-icon" type="button" id="chat-plan" aria-pressed="true" aria-label="Show ${ai}’s plan" title="Show ${ai}’s plan: its steps, progress and time left">${PLAN_ICON}</button>${chatSettings ? `
    <button class="btn btn-icon" type="button" id="chat-settings" aria-pressed="false" aria-label="Chat settings" title="Chat settings: who answers">${ic('settings', 17)}</button>` : ''}
    <button class="btn btn-icon" type="button" id="chat-new" aria-label="New conversation" title="Start a new conversation">${ic('plus', 17)}</button>
    <button class="btn btn-icon" type="button" id="chat-close" aria-label="Collapse ${ai}" title="Collapse · Ctrl .">${icon('chevron-right', { size: 17, className: 'ed-collapse' })}</button></div>
${chatSettings ? `  <div class="ed-chat-settings" id="chat-settings-pane" hidden></div>
<style>${CHAT_SETTINGS_CSS}</style>
` : ''}  <div class="ed-chat-log" id="chat-log" role="log" aria-live="polite"></div>
  <div class="ed-chat-status" id="chat-status" role="status" hidden></div>
  <form class="ed-chat-form" id="chat-form">
    <textarea class="input" id="chat-input" rows="3" aria-label="Message ${ai}" placeholder="Ask ${ai} to change the map"></textarea>
    <div class="ed-chat-foot"><span class="ed-chat-hint" id="chat-usage">Each change is one undo step. <kbd>/</kbd> focuses chat</span><button class="btn btn-primary" id="chat-send" type="submit" title="Send · Enter">${ic('send', 15)}<span>Send</span></button></div>
  </form>
</aside>`
    : '';

  const editorParts = edit
    ? {
        rail: `<nav class="rail ed-rail" id="rail" aria-label="Tools"></nav>`,
        // the context strip: a row above the canvas (below it on phones), one fixed height
        dock: `<div class="ed-ctx-dock" id="ctx-dock"><div class="ctxbar ed-ctx" id="ctxbar" role="toolbar" aria-label="Tool options"></div></div>`,
        overlays: `<aside class="ed-flyout" id="flyout" hidden></aside>`,
        inspector: `<aside class="ed-inspector ed-sheet" id="panel" aria-label="Properties">
    <span class="sheet-handle ed-phone-only"></span>
    <div class="tabs ed-tabs" role="tablist"><button class="tab" type="button" role="tab" id="tab-inspector" aria-selected="true" aria-controls="props">Inspector</button><button class="tab" type="button" role="tab" id="tab-map" aria-selected="false" aria-controls="props">Map settings</button><span class="spacer"></span><button class="btn btn-icon ed-drawer-close" type="button" id="panel-close" aria-label="Close the panel">${ic('x', 17)}</button></div>
    <div class="ed-scroll" id="props" role="tabpanel" aria-labelledby="tab-inspector"></div>
  </aside>`,
        phonebar: `<nav class="ed-phonebar" id="phonebar" aria-label="Tools"><div class="ed-phonetools" id="phonetools" role="toolbar"></div>${chat ? `<span class="vsep"></span><button class="ed-phonetool" type="button" id="chat-phone" aria-pressed="false">${ic('chat', 22)}${ai}</button>` : ''}</nav>`,
      }
    : { rail: '', dock: '', overlays: '', inspector: '', phonebar: '' };

  const body = `${top}
<div class="ed-body">
  ${editorParts.rail}
  <div class="ed-main">
  ${editorParts.dock}
  <main id="stage" style="background:${esc(bg)}" data-tool="">
    <div id="canvas">${sceneToSvg(scene, { ppg: 20 })}</div>
    <svg id="overlay" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" viewBox="${scene.bounds.x0} ${scene.bounds.y0} ${scene.bounds.x1 - scene.bounds.x0} ${scene.bounds.y1 - scene.bounds.y0}"></svg>
    ${editorParts.overlays}
    ${viewSeg('view-phone', ' ed-view-phone')}
    <div class="ed-zoom" role="group" aria-label="Zoom">
      <button class="ed-zbtn" type="button" id="zoom-out" aria-label="Zoom out" title="Zoom out · −">${ic('zoom-out')}</button>
      <span class="ed-zpct" id="zoom-pct" aria-live="polite">100%</span>
      <button class="ed-zbtn" type="button" id="zoom-in" aria-label="Zoom in" title="Zoom in · +">${ic('zoom-in')}</button>
      <span class="vsep"></span>
      <button class="ed-zbtn" type="button" id="fit" aria-label="Fit map" title="Fit · Ctrl 0">${ic('fit')}</button>
    </div>
    <div class="ed-float-bottom"><div class="toasts ed-toasts" id="toasts"></div>
      <div class="ed-banner" id="players-banner"${view === 'players' ? '' : ' hidden'}>${ic('eye-off', 15)}<span>Players’ view: GM markers, secret doors and fogged rooms are hidden</span><kbd>Shift P</kbd></div></div>
  </main>
  </div>
  ${editorParts.inspector}
  ${chatPanel}
</div>
${editorParts.phonebar}
<div class="dialog-backdrop" id="shortcuts" hidden><div class="dialog ed-shortcuts" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
  <div class="dialog-head"><div class="dialog-title" id="shortcuts-title">Keyboard shortcuts</div><button class="btn btn-icon" type="button" data-close aria-label="Close">${ic('x', 17)}</button></div>
  <div class="ed-keys" id="shortcuts-list"></div>
  <p class="field-hint" style="margin:0">Missing a feature, or found a problem? <a href="${esc(feedbackHref)}">Request a feature</a></p></div></div>
<script id="delve-initial" type="application/json">${initial}</script>
<script type="module" src="/assets/viewer.js?v=${encodeURIComponent(info.version)}"></script>`;

  return htmlDocument({ title: map.name, body, bodyClass: `ed${edit ? ' editing' : ''}${chat ? ' has-chat' : ''}`, extra: `<style>${EDITOR_CSS}</style>` });
}

/** The page's layout. Components (rail, tool, ctxbar, menu, field…) come from @delve/ui. */
export const EDITOR_CSS = `
  html, body { height: 100%; }
  body.ed { display: flex; flex-direction: column; overflow: hidden; background: var(--color-bg); }
  .flip { transform: scaleX(-1); }
  /* the top bar: where you are and editing on the left, the view group midway, export and status on the right;
     when room runs out the place's and storey's names give way (cut short with …), nothing else */
  .ed-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 8px 0 16px; }
  .ed-top-start { flex: 0 1 auto; display: flex; align-items: center; gap: 10px; min-width: 0; }
  .ed-top-start > * { flex: none; }
  .ed-top > .ed-group-view { flex: none; }
  .ed-top-end { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
  .ed-top-end > * { flex: none; }
  .ed-top-start > .ed-title { flex: 0 1 auto; min-width: 40px; }
  .ed-title { display: flex; flex-direction: column; min-width: 0; }
  .ed-subline { display: none; }
  .ed-group { display: flex; align-items: center; gap: 4px; flex: none; }
  .ed-edit { gap: 10px; }
  .ed-history { display: flex; gap: 2px; }
  .ed-group-view { gap: 6px; }
  .ed-status { gap: 6px; padding-left: 2px; }
  .ed-view .seg-opt { padding: 6px 12px; }
  /* the storey button, after the place's name: the floor number and the storey's name */
  .ed-top-start > .ed-storey { flex: 0 2 auto; min-width: 0; }
  .ed-storey { display: flex; align-items: center; gap: 10px; }
  .ed-storey-btn { min-width: 0; max-width: 100%; gap: 6px; padding: 0 6px 0 4px; }
  .ed-storey-chip { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ed-storey-num { min-width: 24px; height: 24px; padding: 0 5px; flex: none; display: grid; font-family: var(--font-ui); place-items: center; border-radius: 6px; box-shadow: inset 0 0 0 1px var(--color-accent); color: var(--color-accent); font-weight: 600; font-size: 13px; font-variant-numeric: tabular-nums; }
  .ed-storey-name { min-width: 0; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ed-storey-btn > .icon { flex: none; }
  .ed-storey-menu { left: 22px; right: auto; width: 280px; }
  .ed-storey-menu .menu-item { padding: 7px 10px; }
  .ed-storey-menu .menu-item[aria-checked="true"] { padding-left: 10px; }
  .ed-storey-menu .ed-storey-num { min-width: 28px; height: 22px; box-shadow: none; color: inherit; }
  .ed-storey-menu .menu-item[aria-checked="true"] .ed-storey-num { box-shadow: inset 0 0 0 1px currentColor; }
  .ed-storey-menu .ed-storey-item { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ed-storey-menu .ed-menu-sep { height: 1px; margin: 4px 2px; background: var(--color-border); }
  .ed-view .lbl-short, .ed-back, .ed-narrow, .ed-phone-only, .ed-view-phone, .ed-drawer-close { display: none; }
  .ed-menu-wrap { position: relative; }
  .ed-menu { position: absolute; right: 0; top: 40px; width: 300px; padding: 6px; border-radius: 10px; z-index: 50; }
  .ed-menu .menu-item { padding: 8px 10px; border-radius: 7px; }
  .ed-menu .menu-item > .icon { margin-top: 1px; color: var(--color-text-muted); }
  .ed-menu .menu-item kbd { align-self: center; }
  .ed-crop { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; padding-top: 6px; box-shadow: inset 0 1px 0 var(--color-border); }
  .ed-crop[hidden] { display: none; }
  .ed-menu-label { padding: 4px 10px 2px; }
  .ed-avatar { margin-left: 2px; }

  .ed-body { flex: 1; min-height: 0; display: flex; position: relative; }
  .ed-rail { box-shadow: inset -1px 0 0 var(--color-border); position: relative; z-index: 15; overflow-y: auto; scrollbar-width: none; }
  .ed-rail .spacer { flex: 1; min-height: 8px; }
  .ed-rail .tool.is-toggle[aria-pressed="true"] { background: transparent; box-shadow: none; color: var(--color-accent); }
  /* the rail's groups (select, build, furnish, GM, images and segments; the view toggles at the bottom) */
  .ed-railgroup { display: flex; flex-direction: column; align-items: center; gap: 2px; flex: none; }
  .ed-rail .rail-sep { margin: 7px 0; }
  /* the canvas column: the context strip on top, the stage below it */
  .ed-main { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
  #stage { flex: 1; min-width: 0; min-height: 0; position: relative; overflow: hidden; touch-action: none; cursor: grab; z-index: 1; user-select: none; -webkit-user-select: none; }
  #stage input, #stage textarea { user-select: text; -webkit-user-select: text; }
  #stage[data-tool="select"] { cursor: default; }
  #stage[data-tool]:not([data-tool=""]):not([data-tool="select"]):not([data-tool="pan"]) { cursor: crosshair; }
  #stage[data-tool="pan"] { cursor: grab; }
  #stage.panning { cursor: grab !important; }
  #stage.dragging { cursor: grabbing !important; }
  #stage.on-marker:not(.dragging) { cursor: pointer !important; }
  #canvas { position: absolute; inset: 0; }
  #canvas svg { width: 100%; height: 100%; display: block; }
  #overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }

  /* the context strip: the active tool (icon, name, key), its options and its help, docked above the canvas so it
     never covers the map; one fixed height, so the map doesn't move when the tool changes */
  .ed-ctx-dock { flex: none; height: 44px; display: flex; align-items: center; min-width: 0; position: relative; z-index: 2; background: var(--color-surface); box-shadow: inset 0 -1px 0 var(--color-border); }
  .ed-ctx { flex: 1; min-width: 0; height: 100%; max-width: none; border-radius: 0; background: transparent; box-shadow: none; padding: 0 12px 0 14px; overflow-x: auto; scrollbar-width: none; }
  .ed-ctx::-webkit-scrollbar { display: none; }
  .ed-ctx:empty { display: none; }
  .ed-ctx > * { flex: none; }
  .ed-ctx-tkey { margin-left: 1px; }
  .ed-ctx .range { width: 84px; }
  .ed-ctx-slider { display: flex; align-items: center; gap: 8px; padding: 0 6px; font-size: var(--text-sm); color: var(--color-text-muted); }
  .ed-ctx-slider output { min-width: 34px; color: var(--color-text); font-variant-numeric: tabular-nums; }
  /* the tool's help: one line, cut short with … when the options need the room (the whole text is its title) */
  .ed-ctx-hint { color: var(--color-text-muted); font-size: 12.5px; padding: 0 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ed-ctx > .ed-ctx-hint { flex: 0 1 auto; min-width: 7em; }
  .ed-ctx-key { display: inline-flex; align-items: center; gap: 5px; font-size: var(--text-sm); color: var(--color-text-muted); padding: 0 4px; }
  .ed-ctx .btn { height: 30px; font-size: 12.5px; }
  .ed-ctx select.input { min-height: 28px; padding: 2px 24px 2px 8px; font-size: 12.5px; width: auto; }
  .ed-ctx .select .icon { right: 6px; }
  .ed-ctx-label { font-size: var(--text-sm); color: var(--color-text-muted); padding: 0 2px 0 6px; }
  .ed-dot { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; box-shadow: 0 0 0 1px var(--marker-ink); font-family: var(--font-numeral); font-size: 12px; line-height: 1; }
  .ed-swatch { width: 14px; height: 14px; border-radius: 3px; box-shadow: inset 0 0 0 1px rgba(43,36,29,.4); background-size: cover; }

  .ed-flyout { position: absolute; left: 12px; top: 12px; width: 300px; max-height: calc(100% - 24px); display: flex; flex-direction: column; border-radius: 12px; background: var(--color-surface); box-shadow: var(--shadow-md); overflow: hidden; z-index: 6; }
  .ed-flyout[hidden] { display: none; }
  .ed-flyout-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px 14px; }
  .ed-flyout-title { font-family: var(--font-display); font-size: 19px; line-height: 1; }
  .ed-flyout-count { font-size: var(--text-sm); color: var(--color-text-muted); }
  .ed-search { position: relative; padding: 0 12px; }
  .ed-search .icon { position: absolute; left: 22px; top: 50%; transform: translateY(-50%); color: var(--color-text-muted); pointer-events: none; }
  .ed-search .input { min-height: 32px; padding-left: 32px; background: var(--color-surface-2); }
  .ed-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 10px 12px; }
  .ed-palette { padding: 10px 12px 0; }
  .ed-chip { height: 26px; padding: 0 10px; border: 0; border-radius: 999px; cursor: pointer; font: inherit; font-size: var(--text-sm); background: var(--color-surface-2); color: var(--color-text-muted); box-shadow: inset 0 0 0 1px var(--color-border); }
  .ed-chip:hover { color: var(--color-text); }
  .ed-chip[aria-selected="true"] { background: var(--tint-accent-bg); color: var(--color-accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent); }
  .ed-flyout-body { flex: 1; min-height: 0; overflow: auto; padding: 2px 12px 12px; }
  .ed-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; align-content: start; }
  .ed-asset { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 0; border: 0; background: none; cursor: pointer; font: inherit; color: var(--color-text-muted); min-width: 0; }
  .ed-asset-pic { width: 100%; aspect-ratio: 1; display: grid; place-items: center; border-radius: 8px; background: var(--canvas-floor); box-shadow: inset 0 0 0 1px var(--color-border); overflow: hidden; }
  .ed-asset-pic img { width: 78%; height: 78%; object-fit: contain; }
  .ed-asset-pic .tile { width: 100%; height: 100%; background-size: 50% 50%; }
  .ed-asset-name { font-size: var(--text-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .ed-asset[aria-pressed="true"] { color: var(--color-text); }
  .ed-asset[aria-pressed="true"] .ed-asset-pic { box-shadow: 0 0 0 2px var(--color-accent); }
  .ed-asset:focus-visible { outline: none; }
  .ed-asset:focus-visible .ed-asset-pic { outline: 2px solid var(--color-accent); outline-offset: 2px; }
  .ed-flyout-foot { display: flex; align-items: center; gap: 6px; padding: 9px 14px; box-shadow: inset 0 1px 0 var(--color-border); font-size: var(--text-sm); color: var(--color-text-muted); }
  .ed-flyout-body .hint, .ed-flyout-body .field-hint { color: var(--color-text-muted); font-size: var(--text-sm); margin: 0; }
  .ed-flyout-body > * + * { margin-top: 10px; }
  /* custom props (apps/web/src/prop-maker.ts): the badge and menu on their tiles, the "New prop…" button, the edit dialog */
  .ed-asset-wrap { position: relative; min-width: 0; display: flex; }
  .ed-asset-wrap > .ed-asset { flex: 1; }
  .ed-asset-pic { position: relative; }
  .ed-asset-badge { position: absolute; left: 3px; bottom: 3px; font-size: 10px; line-height: 14px; padding: 0 5px; pointer-events: none; }
  .ed-asset-more { position: absolute; top: 2px; right: 2px; width: 24px; height: 24px; min-height: 0; padding: 0; opacity: 0; background: var(--color-surface); box-shadow: var(--shadow-sm); }
  .ed-asset-wrap:hover .ed-asset-more, .ed-asset-more:focus-visible, .ed-asset-more[aria-expanded="true"] { opacity: 1; }
  @media (hover: none) { .ed-asset-more { opacity: 1; } }
  .ed-flyout-foot [data-act="new-prop"] { margin-right: -6px; }
  .ed-propmenu { position: fixed; z-index: 60; width: 232px; }
  .ed-propmenu .menu-item { padding: 7px 10px; }
  .ed-propdlg { z-index: 70; }
  .ed-propdlg .dialog { width: min(560px, 100%); max-height: calc(100vh - 32px); overflow: auto; }
  .ed-propdlg-preview { border-radius: 8px; overflow: hidden; box-shadow: inset 0 0 0 1px var(--color-border); background: var(--canvas-floor); }
  .ed-propdlg-preview img { display: block; width: 100%; height: auto; }

  .ed-zoom { position: absolute; right: 12px; bottom: 12px; display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 10px; background: var(--color-surface); box-shadow: var(--shadow-md); z-index: 5; }
  .ed-zbtn { width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 7px; cursor: pointer; background: transparent; color: var(--color-text-muted); }
  .ed-zbtn:hover { background: var(--color-hover); color: var(--color-text); }
  .ed-zpct { min-width: 46px; text-align: center; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .ed-zoom .vsep { height: 18px; margin: 0 2px; }
  .ed-float-bottom { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 8px; z-index: 7; pointer-events: none; max-width: calc(100% - 140px); }
  .ed-float-bottom > * { pointer-events: auto; }
  .ed-toasts { position: static; transform: none; }
  .ed-toasts .toast { max-width: 560px; }
  .ed-toasts .toast > span { white-space: normal; }
  .ed-banner { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: var(--color-surface); box-shadow: var(--shadow-md); font-size: 12.5px; white-space: nowrap; }
  .ed-banner[hidden] { display: none; }
  .ed-banner > .icon { color: var(--color-accent); }

  /* the inspector and map settings */
  .ed-inspector { width: var(--panel-w); flex: none; display: flex; flex-direction: column; background: var(--color-surface); box-shadow: inset 1px 0 0 var(--color-border); min-height: 0; position: relative; z-index: 16; }
  .ed-tabs { height: 40px; flex: none; gap: 18px; padding: 0 8px 0 16px; align-items: stretch; }
  .ed-tabs .tab { font-size: var(--text-md); padding: 0 1px; }
  .ed-tabs .btn-icon { align-self: center; }
  .ed-scroll { flex: 1; overflow: auto; min-height: 0; }
  .ed-pane { padding: 14px 16px 18px; display: flex; flex-direction: column; gap: 14px; }
  .ed-pane-map { gap: 18px; }
  .ed-obj-head { display: flex; align-items: flex-start; gap: 10px; }
  .ed-obj-badge { width: 34px; height: 34px; flex: none; display: grid; place-items: center; border-radius: 8px; background: var(--canvas-floor); color: var(--canvas-ink); font-family: var(--font-numeral); font-size: 19px; box-shadow: inset 0 0 0 1.5px var(--canvas-ink); }
  .ed-obj-badge .icon { color: var(--canvas-ink); }
  .ed-obj-kicker { font-size: var(--text-xs); color: var(--color-text-muted); letter-spacing: .06em; text-transform: uppercase; }
  .ed-obj-name { font-family: var(--font-display); font-size: 21px; line-height: 1.15; overflow-wrap: anywhere; }
  .ed-two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; }
  .ed-section { display: flex; flex-direction: column; gap: 10px; }
  .ed-acts { display: flex; gap: 8px; padding-top: 2px; }
  .ed-acts .btn { flex: 1; }
  .ed-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .ed-pane .hint { color: var(--color-text-muted); font-size: var(--text-sm); margin: 0; line-height: 1.5; }
  .ed-pane textarea.input { min-height: 68px; padding: 7px 9px; line-height: 1.45; }
  .ed-shapes { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; padding: 2px; border-radius: 8px; box-shadow: inset 0 0 0 1px var(--color-border-strong); }
  .ed-shapes button { height: 28px; display: grid; place-items: center; border: 0; border-radius: 6px; cursor: pointer; background: transparent; color: var(--color-text-muted); }
  .ed-shapes button:hover { background: var(--color-hover); color: var(--color-text); }
  .ed-shapes button[aria-checked="true"] { background: var(--tint-accent-bg); color: var(--color-accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent); }
  .ed-presets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .ed-preset { display: flex; flex-direction: column; gap: 6px; padding: 0; border: 0; background: none; cursor: pointer; font: inherit; font-size: var(--text-sm); color: var(--color-text-muted); text-align: left; }
  .ed-preset svg { width: 100%; height: 56px; display: block; border-radius: 8px; box-shadow: inset 0 0 0 1px var(--color-border-strong); }
  .ed-preset[aria-checked="true"] { color: var(--color-text); }
  .ed-preset[aria-checked="true"] svg { box-shadow: 0 0 0 2px var(--color-accent); }
  .ed-preset:focus-visible { outline: none; }
  .ed-preset:focus-visible svg { outline: 2px solid var(--color-accent); outline-offset: 2px; }
  /* the map's background colour (apps/web/src/colour-wheel.ts): wheel, brightness, hex, ready-made colours */
  .cw { display: flex; flex-direction: column; gap: 12px; }
  .cw-top { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 14px; align-items: start; }
  .cw-wheel { --cw-size: 132px; position: relative; width: var(--cw-size); height: var(--cw-size); border-radius: 50%; cursor: crosshair; touch-action: none; outline: none; box-shadow: 0 0 0 1px var(--color-border-strong); }
  .cw-wheel:focus-visible { box-shadow: 0 0 0 1px var(--color-border-strong), 0 0 0 3px var(--color-surface), 0 0 0 5px var(--color-accent); }
  .cw-canvas { display: block; width: 100%; height: 100%; border-radius: 50%; }
  .cw-knob { position: absolute; left: 50%; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; pointer-events: none; box-shadow: 0 0 0 2px #fff, 0 0 0 3.5px rgba(0, 0, 0, .55), 0 2px 6px rgba(0, 0, 0, .35); }
  .cw-wheel.is-dragging .cw-knob { box-shadow: 0 0 0 3px #fff, 0 0 0 4.5px rgba(0, 0, 0, .55), 0 3px 10px rgba(0, 0, 0, .4); }
  .cw-side { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .cw-swatch { height: 38px; border-radius: var(--radius-md); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .16), 0 0 0 1px var(--color-border-strong); }
  .cw-side .field { gap: 4px; }
  .cw-hex { font-family: var(--font-mono); font-size: var(--text-md); letter-spacing: .02em; }
  .cw-hex-error { color: var(--color-danger); }
  .cw-reset { align-self: flex-start; padding-left: 0; padding-right: 0; }
  .cw-reset[hidden] { display: none; }
  .cw-bright { height: 22px; }
  .cw-bright::-webkit-slider-runnable-track { height: 8px; border-radius: 4px; background: linear-gradient(to right, #000, var(--cw-full, #fff)); box-shadow: inset 0 0 0 1px var(--color-border-strong); }
  .cw-bright::-webkit-slider-thumb { width: 16px; height: 16px; margin-top: -4px; background: transparent; box-shadow: 0 0 0 2px #fff, 0 0 0 3.5px rgba(0, 0, 0, .55); }
  .cw-bright:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 2px #fff, 0 0 0 3.5px rgba(0, 0, 0, .55), 0 0 0 6px var(--color-accent); }
  .cw-bright::-moz-range-track { height: 8px; border-radius: 4px; background: linear-gradient(to right, #000, var(--cw-full, #fff)); box-shadow: inset 0 0 0 1px var(--color-border-strong); }
  .cw-bright::-moz-range-progress { background: transparent; }
  .cw-bright::-moz-range-thumb { width: 16px; height: 16px; background: transparent; box-shadow: 0 0 0 2px #fff, 0 0 0 3.5px rgba(0, 0, 0, .55); }
  .cw-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .cw-chip { width: 24px; height: 24px; flex: none; padding: 0; border: 0; border-radius: 50%; cursor: pointer; font: inherit; background: var(--chip); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .18), 0 0 0 1px var(--color-border-strong); transition: transform var(--dur) var(--ease); }
  .cw-chip:hover { transform: scale(1.08); }
  .cw-chip[aria-checked="true"] { box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .18), 0 0 0 2px var(--color-surface), 0 0 0 4px var(--color-accent); }
  .cw-chip:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 5px; }
  .cw-chip-style { width: auto; display: inline-flex; align-items: center; gap: 5px; padding: 0 9px 0 3px; border-radius: 999px; background: var(--color-surface-2); color: var(--color-text-muted); font-size: var(--text-sm); box-shadow: inset 0 0 0 1px var(--color-border-strong); }
  .cw-chip-style:hover { transform: none; color: var(--color-text); }
  .cw-chip-style[aria-checked="true"] { color: var(--color-text); box-shadow: inset 0 0 0 1px var(--color-border-strong), 0 0 0 2px var(--color-surface), 0 0 0 4px var(--color-accent); }
  .cw-chip-dot { width: 18px; height: 18px; flex: none; border-radius: 50%; background: var(--chip); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .2); }
  .cw-hint:empty { display: none; }
  @media (prefers-reduced-motion: reduce) { .cw-chip { transition: none; } }
  .ed-empty { padding: 40px 24px; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .ed-empty > .icon { color: var(--color-text-faint); }
  .ed-empty-title { font-family: var(--font-display); font-size: 19px; }
  .ed-empty-hint { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); line-height: 1.5; }
  .ed-empty-hint kbd { margin: 0 1px; }
  .ed-seg-full { display: flex; }
  .ed-seg-full .seg-opt { flex: 1; justify-content: center; padding: 5px 8px; }
  .ed-pane .check { font-size: var(--text-md); padding: 2px 0; }
  .ed-check-key { margin-left: auto; font-size: var(--text-xs); color: var(--color-text-faint); }
  .ed-image-card { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 10px; align-items: center; }
  .ed-image-card img { width: 64px; height: 64px; object-fit: contain; border-radius: 8px; background: var(--canvas-floor); box-shadow: inset 0 0 0 1px var(--color-border); }

  /* Claude */
  .ed-claude { width: var(--chat-w); flex: none; display: flex; flex-direction: column; background: var(--color-surface); box-shadow: inset 1px 0 0 var(--color-border); min-height: 0; z-index: 17; }
  .ed-claude[hidden] { display: none; }
  .ed-panel-head { height: 40px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 16px; box-shadow: inset 0 -1px 0 var(--color-border); }
  .ed-panel-title { font-family: var(--font-display); font-size: 19px; line-height: 1; }
  .ed-model select.input { min-height: 26px; padding: 2px 22px 2px 7px; font-size: var(--text-sm); width: auto; background: transparent; border-color: transparent; color: var(--color-text-muted); }
  .ed-model select.input:hover { border-color: var(--color-border-strong); }
  .ed-model .icon { right: 6px; }
  .ed-chat-log { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 16px; }
  .ed-msg { display: flex; gap: 10px; min-width: 0; }
  .ed-msg-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; flex: 1; }
  .ed-msg-meta { font-size: var(--text-sm); color: var(--color-text-muted); }
  .ed-msg-meta b { color: var(--color-text); font-weight: 500; }
  .ed-msg-text { line-height: 1.5; text-wrap: pretty; overflow-wrap: anywhere; }
  .ed-msg-text p { margin: 0 0 6px; } .ed-msg-text > :last-child { margin-bottom: 0; }
  .ed-msg-text ul, .ed-msg-text ol { margin: 2px 0 6px; padding-left: 20px; }
  .ed-msg-text code { font-size: 12px; background: var(--color-surface-2); padding: 1px 4px; border-radius: 4px; }
  .ed-msg-user .ed-msg-text { white-space: pre-wrap; }
  .ed-claude-mark { width: 24px; height: 24px; flex: none; border-radius: 50%; display: grid; place-items: center; box-shadow: inset 0 0 0 1.5px var(--color-accent); color: var(--color-accent); font-family: var(--font-display); font-size: 14px; }
  .ed-msg-error .ed-msg-text { color: var(--tint-danger-fg); background: var(--tint-danger-bg); padding: 8px 10px; border-radius: 8px; font-size: var(--text-md); }
  .ed-changes { display: flex; flex-direction: column; border-radius: 8px; overflow: hidden; box-shadow: inset 0 0 0 1px var(--color-border-strong); }
  .ed-change { display: flex; align-items: center; gap: 8px; padding: 7px 10px; font-size: var(--text-sm); }
  .ed-change + .ed-change { box-shadow: inset 0 1px 0 var(--color-border); }
  .ed-change > .icon { color: var(--color-text-muted); }
  .ed-change[data-state="running"] { color: var(--color-text-muted); }
  .ed-change[data-state="running"] > .icon { color: var(--color-accent); }
  .ed-change[data-state="failed"] { color: var(--color-danger); }
  .ed-change[data-state="failed"] > .icon { color: var(--color-danger); }
  .ed-typing { display: inline-flex; align-items: center; gap: 8px; color: var(--color-text-muted); font-size: 12.5px; }
  .ed-dots { width: 14px; display: flex; justify-content: center; gap: 2px; }
  .ed-dots span { width: 3px; height: 3px; border-radius: 50%; background: currentColor; }
  .ed-dots span:nth-child(2) { opacity: .6; } .ed-dots span:nth-child(3) { opacity: .3; }
  @media (prefers-reduced-motion: no-preference) { .ed-dots span { animation: ed-blink 1.2s infinite; } .ed-dots span:nth-child(2) { animation-delay: .2s; } .ed-dots span:nth-child(3) { animation-delay: .4s; } }
  @keyframes ed-blink { 50% { opacity: .15; } }
  .ed-suggest { display: flex; flex-direction: column; gap: 6px; }
  .ed-suggest p { margin: 0 0 4px; color: var(--color-text-muted); line-height: 1.5; }
  .ed-suggest button { text-align: left; font: inherit; font-size: var(--text-md); color: var(--color-text); border: 0; box-shadow: inset 0 0 0 1px var(--color-border-strong); background: transparent; border-radius: 8px; padding: 7px 10px; cursor: pointer; }
  .ed-suggest button:hover { background: var(--color-hover); }
  .ed-chat-status { padding: 0 16px 8px; font-size: 12.5px; color: var(--color-text-muted); }
  .ed-chat-status[data-kind="bad"] { color: var(--color-danger); }
  .ed-chat-status[hidden] { display: none; }
  .ed-chat-form { flex: none; padding: 12px 12px 14px; box-shadow: inset 0 1px 0 var(--color-border); display: flex; flex-direction: column; gap: 8px; margin: 0; }
  .ed-chat-form textarea.input { min-height: 58px; max-height: 40vh; resize: none; padding: 8px 10px; background: var(--color-surface-2); }
  .ed-chat-foot { display: flex; align-items: center; gap: 8px; }
  .ed-chat-hint { flex: 1; font-size: 11.5px; color: var(--color-text-muted); line-height: 1.35; }
  .ed-chat-hint[data-kind="bad"] { color: var(--color-warning); }
  .ed-chat-hint kbd { height: 16px; font-size: 10px; }
  .ed-chat-foot .btn { height: 30px; padding: 0 12px; }

  /* Claude's plan: the step list at the top of a working reply (chat.ts, plan-progress.ts), as in the design's "working" card */
  .ed-panel-head > .btn-icon { flex: none; }
  /* while a reply runs, "Editing live" takes the model picker's place, so the head keeps room for its buttons */
  #chat-live:not([hidden]) + .ed-model { display: none; }
  .ed-plan { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 8px; background: var(--color-surface-2); box-shadow: inset 0 0 0 1px var(--color-border); font-size: 12.5px; }
  /* the log follows the newest line while Claude works: in a tall enough log the card stays in sight at its top, as long as its reply is on screen */
  .ed-chat-log { container: chat-log / size; }
  @container chat-log (min-height: 400px) { .ed-plan[data-state="working"] { position: sticky; top: 0; z-index: 1; box-shadow: inset 0 0 0 1px var(--color-border), var(--shadow-sm); } }
  .ed-plan-head { display: flex; align-items: baseline; gap: 8px; }
  .ed-plan-count { flex: 1; color: var(--color-text); font-weight: 500; }
  .ed-plan-eta { color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
  .ed-plan-bar { height: 4px; border-radius: 2px; background: var(--color-surface-3); overflow: hidden; }
  .ed-plan-fill { display: block; height: 100%; width: 0; border-radius: inherit; background: var(--color-accent); }
  @media (prefers-reduced-motion: no-preference) { .ed-plan-fill { transition: width .9s var(--ease); } }
  /* activity (Claude has no plan of its own): no total, so the bar only says "working" */
  .ed-plan[data-mode="activity"] .ed-plan-fill { width: 30%; }
  @media (prefers-reduced-motion: no-preference) { .ed-plan[data-mode="activity"] .ed-plan-fill { transition: none; animation: ed-plan-busy 1.8s ease-in-out infinite; } }
  @media (prefers-reduced-motion: reduce) { .ed-plan[data-mode="activity"] .ed-plan-fill { width: 100%; opacity: .4; } }
  @keyframes ed-plan-busy { from { transform: translateX(-100%); } to { transform: translateX(335%); } }
  .ed-plan-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
  .ed-plan-steps[hidden] { display: none; }
  .ed-plan-step { display: flex; align-items: flex-start; gap: 8px; line-height: 1.4; color: var(--color-text); }
  .ed-plan-mark { width: 14px; height: 1.4em; flex: none; display: flex; align-items: center; justify-content: center; }
  .ed-plan-title { min-width: 0; overflow-wrap: anywhere; }
  .ed-plan-step[data-status="done"] .ed-plan-mark { color: var(--color-accent); }
  .ed-plan-step[data-status="active"] { color: var(--color-text-muted); }
  .ed-plan-step[data-status="active"] .ed-plan-mark { color: var(--color-accent); }
  .ed-plan-step[data-status="pending"] { color: var(--color-text-muted); }
  .ed-plan-step[data-status="skipped"] { color: var(--color-text-faint); }
  .ed-plan-step[data-status="skipped"] .ed-plan-title { text-decoration: line-through; text-decoration-color: var(--color-text-faint); }
  .ed-plan-ring { width: 9px; height: 9px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--color-text-faint); }
  .ed-plan-step[data-ended] .ed-plan-ring { background: var(--color-text-muted); box-shadow: none; }
  .ed-plan-step[data-ended] { color: var(--color-text); }
  .ed-plan-note { margin: 0; color: var(--color-text-muted); line-height: 1.4; }
  .ed-plan-note[hidden] { display: none; }
  .ed-plan:not([data-state="working"]) { padding: 0; background: transparent; box-shadow: inset 0 0 0 1px var(--color-border-strong); gap: 0; }
  .ed-plan:not([data-state="working"]) .ed-plan-steps, .ed-plan:not([data-state="working"]) .ed-plan-note { padding: 2px 10px 9px 10px; }
  .ed-plan-sum { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; border: 0; border-radius: 8px; background: transparent; font: inherit; font-size: var(--text-sm); color: var(--color-text); text-align: left; cursor: pointer; }
  .ed-plan-sum:hover { background: var(--color-hover); }
  .ed-plan-sum:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
  .ed-plan-sum > .icon { flex: none; color: var(--color-accent); }
  .ed-plan-sum > .icon:last-child { color: var(--color-text-muted); transition: transform var(--dur-fast) var(--ease); }
  .ed-plan-sum[aria-expanded="true"] > .icon:last-child { transform: rotate(180deg); }
  .ed-plan[data-state="stopped"] .ed-plan-sum > .icon:first-child { color: var(--color-text-muted); }
  .ed-plan[data-state="failed"] .ed-plan-sum > .icon:first-child { color: var(--color-danger); }

  /* the marker note */
  .note-pop.ed-note { position: fixed; z-index: 30; }
  .note-pop.ed-note[hidden] { display: none; }
  .ed-note textarea.input { min-height: 72px; }
  .ed-note .ed-note-text { margin: 0; line-height: 1.5; white-space: pre-wrap; }
  .ed-note.done .ed-note-text, .ed-note.done textarea.input { text-decoration: line-through; text-decoration-color: var(--color-text-faint); color: var(--color-text-muted); }
  .ed-note-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 10px; font-size: var(--text-sm); color: var(--color-text-muted); }

  /* the tooltip over the rail, and the shortcuts dialog */
  .ed-tip { position: fixed; z-index: 60; }
  .ed-tip[hidden] { display: none; }
  .ed-shortcuts { width: min(560px, 100%); }
  .ed-keys { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 24px; font-size: var(--text-md); }
  .ed-keys div { display: flex; align-items: center; gap: 10px; padding: 3px 0; color: var(--color-text-muted); }
  .ed-keys kbd { min-width: 22px; height: 20px; padding: 0 6px; font-size: var(--text-xs); color: var(--color-text); background: var(--color-surface-2); }

  /* editor marks on the map: the design's selection ink */
  .ed .sel { fill: none; stroke: var(--canvas-select); stroke-width: 2px; stroke-dasharray: 5 3; vector-effect: non-scaling-stroke; }
  .ed .from { fill: color-mix(in srgb, var(--canvas-select) 12%, transparent); stroke: var(--canvas-select); stroke-width: 2px; vector-effect: non-scaling-stroke; }
  .ed .ghost { fill: color-mix(in srgb, var(--canvas-select) 14%, transparent); stroke: var(--canvas-select); stroke-width: 2px; vector-effect: non-scaling-stroke; }
  .ed .ghost-door { stroke: var(--canvas-select); stroke-width: 6px; stroke-linecap: round; vector-effect: non-scaling-stroke; }
  .ed .ghost-line { fill: color-mix(in srgb, var(--canvas-select) 10%, transparent); stroke: var(--canvas-select); stroke-width: 2px; stroke-dasharray: 5 3; vector-effect: non-scaling-stroke; }
  .ed .start { fill: var(--canvas-select); }
  .ed .handle { fill: #FFFFFF; stroke: var(--canvas-select); stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
  .ed .cross { stroke: var(--canvas-select); stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
  .ed .dim-bg { fill: var(--canvas-select); }
  .ed .dim { fill: #FFFFFF; font-family: var(--font-ui); }
  .ed .brush-path { fill: none; stroke-dasharray: 2 4; }
  .ed .ghost-prop, .ed .ghost-seg { opacity: .75; }
  .ed .guide { fill: color-mix(in srgb, var(--canvas-select) 5%, transparent); stroke: var(--canvas-select); stroke-opacity: .6; stroke-width: 1.5px; stroke-dasharray: 6 4; vector-effect: non-scaling-stroke; }
  .ed .open-area { fill: color-mix(in srgb, var(--canvas-select) 7%, transparent); stroke: var(--canvas-select); stroke-opacity: .85; stroke-width: 1.5px; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
  .ed .marquee { fill: color-mix(in srgb, var(--canvas-select) 9%, transparent); stroke: var(--canvas-select); stroke-width: 1px; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; }
  .ed .sel-pre { fill: none; stroke: var(--canvas-select); stroke-opacity: .55; stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
  .hl-focus { fill: color-mix(in srgb, var(--marker-discover) 16%, transparent); stroke: var(--marker-discover); stroke-width: 3px; vector-effect: non-scaling-stroke; animation: ed-pulse 1.1s ease-in-out 3; }
  .hl-change { fill: color-mix(in srgb, var(--canvas-select) 12%, transparent); stroke: var(--canvas-select); stroke-width: 2px; vector-effect: non-scaling-stroke; animation: ed-fade 1.6s ease-out forwards; }
  @keyframes ed-pulse { 50% { stroke-opacity: .25; fill-opacity: .05; } }
  @keyframes ed-fade { to { stroke-opacity: 0; fill-opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .hl-focus, .hl-change { animation: none; } }

  /* snip an area (apps/web/src/snip.ts): the veil, the box, the hint on top and the bar under the box */
  #stage.snipping { cursor: crosshair; }
  .ed .snip-veil { fill: rgba(8, 10, 18, .55); }
  .ed .snip-box { fill: none; stroke: var(--color-accent); stroke-width: 2px; stroke-dasharray: 6 4; vector-effect: non-scaling-stroke; }
  body.snipping #ctxbar, body.snipping #flyout { display: none; }
  body.snipping #rail, body.snipping #panel { pointer-events: none; opacity: .5; }
  .snip-hint { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 6; max-width: calc(100% - 24px); padding: 6px 12px; border-radius: 999px; background: var(--color-surface); color: var(--color-text-muted); box-shadow: var(--shadow-md); font-size: var(--text-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* in the editor it takes the context strip's place (the strip keeps its height, so the map stays put) */
  .ed-ctx-dock > .snip-hint { position: static; transform: none; flex: 1; min-width: 0; max-width: none; padding: 0 14px; border-radius: 0; background: transparent; box-shadow: none; }
  .snip-bar { position: absolute; z-index: 6; display: grid; gap: 6px; max-width: calc(100% - 24px); padding: 8px 10px; border-radius: 10px; background: var(--color-surface); box-shadow: var(--shadow-lg); cursor: default; }
  .snip-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .snip-row .spacer { flex: 1; }
  .snip-size { font-variant-numeric: tabular-nums; font-weight: 500; white-space: nowrap; }
  .snip-size.is-bad, .snip-problem { color: var(--color-danger); }
  .snip-problem { font-size: var(--text-sm); }
  .snip-ppg .input { height: var(--control-sm); }
  .snip-bar .check { font-size: var(--text-sm); }
  #snip-btn[aria-pressed="true"] { background: var(--tint-accent-bg); color: var(--color-accent); }

  .ed-phonebar { display: none; }

  /* below 1440 the top bar drops the Library crumb (the brand goes there too) and shows "Saved" and Snip as their
     icons (with tooltips), so the place's and storey's names keep their room */
  @media (max-width: 1439px) {
    .ed-crumb-lib, .ed-top .save-state > span, #snip-btn .lbl { display: none; }
    #snip-btn { padding: 0 9px; }
  }
  /* 1024–1279: Claude floats over the canvas; the top bar gets more compact (the players' screen as its icon,
     GM / Players short) so its groups still fit side by side */
  @media (max-width: 1279px) {
    .ed-claude { position: absolute; top: 12px; bottom: 12px; right: calc(var(--panel-w) + 12px); border-radius: 12px; box-shadow: var(--shadow-lg); overflow: hidden; }
    body:not(.editing) .ed-claude { right: 12px; }
    #screen-link .lbl { display: none; }
    #screen-link { padding: 0 9px; }
    .ed-top > .ed-group-view .ed-view .lbl { display: none; }
    .ed-top > .ed-group-view .ed-view .lbl-short { display: inline; }
    .ed-storey-name { max-width: 150px; }
  }
  /* the floating chat starts under the context strip, so the tool's options stay in sight */
  @media (min-width: 768px) and (max-width: 1279px) {
    body.editing .ed-claude { top: 56px; }
  }
  /* 768–1023: the inspector is a drawer; Export, 3D and the players' screen move into ⋯ */
  @media (max-width: 1023px) {
    .ed-wide { display: none !important; }
    .ed-narrow { display: block; }
    .ed-view .lbl { display: none; } .ed-view .lbl-short { display: inline; }
    .ed-inspector { position: absolute; right: 0; top: 0; bottom: 0; width: 320px; transform: translateX(100%); visibility: hidden; transition: transform var(--dur) var(--ease), visibility var(--dur); box-shadow: var(--shadow-lg); }
    body.drawer-open .ed-inspector { transform: none; visibility: visible; }
    .ed-drawer-close { display: grid; }
    .ed-claude, body:not(.editing) .ed-claude { right: 12px; }
    #login-link .lbl { display: none; }
  }
  /* below 768: the phone layout */
  @media (max-width: 767px) {
    body.ed { font-size: var(--text-lg); }
    .ed-top { height: 52px; padding: 0 4px; gap: 0; }
    .ed-top > .ed-group-view, .ed-desk, .topbar-brand, .ed-avatar { display: none !important; }
    .ed-back { display: grid; width: 44px; height: 44px; color: var(--color-text); }
    .ed-top-start { gap: 0; }
    .ed-title { padding-left: 2px; }
    .ed-title .crumb-title { font-size: 19px; line-height: 1.15; }
    .ed-subline { display: flex; align-items: center; gap: 6px; }
    .ed-subline .status { font-size: var(--text-sm); }
    .ed-history .btn-icon, .ed-top-end .btn-icon { width: 44px; height: 44px; }
    /* the storey: its number only, so the place's name keeps the room (the button's label and its menu name the
       storeys); the menu drops down across the screen */
    .ed-storey { margin-left: 4px; }
    .ed-top-start > .ed-storey { flex-shrink: 0; }
    .ed-storey-btn { height: 44px; padding: 0 4px; gap: 4px; }
    .ed-storey-name { display: none; }
    .ed-storey-menu { position: fixed; left: 8px; right: 8px; top: 56px; width: auto; }
    .ed-chat-btn { display: none; }
    .ed-view-phone { display: inline-flex; position: absolute; top: 12px; right: 12px; z-index: 8; background: var(--color-surface); box-shadow: var(--shadow-md); }
    .ed-view-phone .seg-opt { min-height: 40px; padding: 0 12px; }
    .ed-view-phone .lbl { display: none; } .ed-view-phone .lbl-short { display: inline; }
    .ed-rail, .ed-zoom { display: none !important; }
    .ed-phonebar { display: flex; align-items: center; flex: none; padding: 6px 0 calc(6px + env(safe-area-inset-bottom)); background: var(--color-surface); box-shadow: inset 0 1px 0 var(--color-border); position: relative; z-index: 20; }
    .ed-phonebar .vsep { height: 32px; }
    .ed-phonetools { flex: 1; min-width: 0; display: flex; gap: 2px; overflow-x: auto; padding: 0 6px 0 8px; scrollbar-width: none; }
    .ed-phonetool { flex: none; width: 54px; height: 52px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; border: 0; border-radius: 10px; cursor: pointer; font: inherit; font-size: 10.5px; background: transparent; color: var(--color-text-muted); }
    #chat-phone { width: 58px; margin: 0 6px; }
    .ed-phonetool[aria-pressed="true"] { background: var(--tint-accent-bg); color: var(--color-accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent); }
    /* the context strip docks under the canvas, above the tools, where the thumb is */
    .ed-ctx-dock { order: 1; height: 48px; box-shadow: inset 0 1px 0 var(--color-border); }
    .ed-ctx { padding: 0 8px 0 12px; }
    .ed-float-bottom { bottom: 16px; max-width: calc(100% - 24px); }
    .ed-flyout { left: 0; right: 0; top: auto; bottom: 0; width: auto; max-height: 58%; border-radius: 18px 18px 0 0; box-shadow: var(--shadow-lg); }
    .ed-phone-only { display: block; }
    .ed-sheet { position: absolute; left: 0; right: 0; bottom: 0; width: auto; border-radius: 18px 18px 0 0; box-shadow: var(--shadow-lg); transform: translateY(105%); visibility: hidden; transition: transform var(--dur) var(--ease), visibility var(--dur); z-index: 19; }
    .ed-inspector.ed-sheet { top: auto; max-height: 72%; }
    .ed-claude.ed-sheet { top: 144px; right: 0; border-radius: 18px 18px 0 0; }
    body.sheet-inspector .ed-inspector, body.sheet-claude .ed-claude { transform: none; visibility: visible; }
    .ed-sheet .sheet-handle { margin: 8px auto 2px; width: 36px; height: 5px; border-radius: 3px; }
    .ed-drawer-close { display: grid; width: 44px; height: 44px; }
    .ed-inspector .input, .ed-claude .input { font-size: var(--text-touch); }
    .ed-pane { padding-bottom: 24px; }
    .cw-wheel { --cw-size: 156px; }
    .cw-chip { width: 38px; height: 38px; }
    .cw-chip-style { width: auto; height: 38px; padding: 0 12px 0 5px; }
    .cw-chip-dot { width: 26px; height: 26px; }
    .cw-bright { height: 44px; }
  }
`;
