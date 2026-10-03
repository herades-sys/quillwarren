// The map page (/maps/:id): the live viewer, and the editor for logged-in GMs,
// laid out as in the design (docs/design/ui-v1/Delve Editor.dc.html): top bar
// 48, tool rail 52, the canvas, the inspector 288 and Claude 344. Below 1280 px
// Claude floats, below 1024 the inspector becomes a drawer, below 768 the phone
// layout takes over: a bottom toolbar, and sheets for the inspector and Claude.
//
// The first picture is rendered here, so it shows before the script loads; the
// script (apps/web/src/viewer.ts) then fills the rail, the context bar and the
// panels, and follows changes over the WebSocket.
import { sceneToSvg, type DelveMap, type Level } from '@delve/core';
import { esc, htmlDocument, icon, type IconName } from '@delve/ui';
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
}

/** "AN" for Ana, "MV" for Mara Venn. */
const initials = (name: string): string => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0]![0]! + w[1]![0]! : (w[0] ?? '?').slice(0, 2)).toUpperCase();
};

const ic = (name: IconName, size = 18): string => icon(name, { size });

/** The Claude panel's "Show Claude's plan" toggle: a checklist, drawn like the design's icons (24 grid, 1.7 stroke). */
const PLAN_ICON = '<svg class="icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5l1.6 1.6L8.5 5.2M4 12.5l1.6 1.6 2.9-2.9M4.8 18.5h3M12 6.7h8M12 12.7h8M12 18.5h8"/></svg>';

export function editorPage(info: AppInfo, id: string, rev: number, map: DelveMap, o: EditorPageOpts): string {
  const { view, style } = o;
  const enc = encodeURIComponent(id);
  const scene = sceneFor(map, { view, style, fog: '1' });
  // the storeys control shows the floor number instead
  scene.layers = scene.layers.filter((l) => l.name !== 'floor-number');
  const bg = scene.layers[0]?.kind === 'rect' ? scene.layers[0].color : 'var(--canvas-parchment)';
  const edit = o.loggedIn;
  const chat = edit && o.chatModel ? { enabled: true, model: o.chatModel } : undefined;
  const initial = JSON.stringify({
    id,
    rev,
    map,
    levels: o.levels,
    edit: { loggedIn: o.loggedIn, passwordSet: o.passwordSet },
    account: o.account,
    ...(chat ? { chat } : {}),
  }).replace(/</g, '\\u003c');
  const q = `view=${view}${style ? `&style=${encodeURIComponent(style)}` : ''}`;
  const loginHref = `/login?next=${encodeURIComponent(`/maps/${id}`)}`;

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
  const exportItems = exports.map((e) => menuItem(...e)).join('') + cropGroup;
  const moreItems = [
    menuItem('3d', '', `/maps/${enc}/3d`, '3D view', 'All storeys stacked', ''),
    menuItem('screen', '', `/maps/${enc}/screen`, 'Players’ screen', 'Opens in a new window', '', ' target="_blank" rel="noopener"'),
    exports.map((e) => menuItem(e[0], '', e[2], e[3], e[4], e[5])).join(''),
    cropGroup,
    edit ? `<button class="menu-item has-icon" role="menuitem" type="button" data-act="map-settings">${ic('settings', 17)}<span class="spacer">Map settings</span></button>` : '',
    `<button class="menu-item has-icon" role="menuitem" type="button" data-act="shortcuts">${ic('keyboard', 17)}<span class="spacer">Keyboard shortcuts</span><kbd>?</kbd></button>`,
  ].join('');

  const viewSeg = (name: string, cls = '') =>
    `<div class="seg seg-ground ed-view${cls}" role="radiogroup" aria-label="View as" title="Shift P">
<label class="seg-opt"><input type="radio" name="${name}" value="gm"${view === 'gm' ? ' checked' : ''}>${ic('eye', 16)}<span class="lbl">GM view</span><span class="lbl-short">GM</span></label><label class="seg-opt"><input type="radio" name="${name}" value="players"${view === 'players' ? ' checked' : ''}>${ic('eye-off', 16)}Players</label></div>`;

  const who = o.account
    ? `<span class="avatar ed-avatar" title="${esc(o.account.name)} · ${o.account.role === 'admin' ? 'Admin' : 'GM'}">${esc(initials(o.account.name))}</span>`
    : '';

  const top = `<header class="topbar ed-top">
<div class="ed-top-start">
  <a class="ed-back btn btn-icon" href="/" aria-label="Back to library">${icon('chevron-right', { size: 22, className: 'flip' })}</a>
  <a class="topbar-brand" href="/">Delve</a><span class="vsep ed-desk"></span>
  <a class="crumb ed-desk" href="/">Library</a>${icon('chevron-right', { size: 14, className: 'crumb-sep ed-desk' })}
  <div class="ed-title"><span class="crumb-title" id="map-name">${esc(map.name)}</span><span class="ed-subline"><span class="status status-connecting" id="conn-mini">Connecting…</span></span></div>
  ${edit ? `<span class="save-state ed-desk" id="save-state" role="status">${ic('check', 14)}<span>Saved</span></span>` : ''}
  ${edit ? `<div class="ed-history"><button class="btn btn-icon" type="button" id="undo" aria-label="Undo" title="Undo · Ctrl Z">${ic('undo')}</button><button class="btn btn-icon" type="button" id="redo" aria-label="Redo" title="Redo · Ctrl Shift Z">${ic('redo')}</button></div>` : ''}
</div>
${viewSeg('view', '')}
<div class="ed-top-end">
  <span class="status status-connecting ed-desk" id="conn" role="status" title="Connecting to the live map">Connecting…</span>
  <span class="vsep ed-wide"></span>
  <a class="btn btn-plain ed-wide" id="view-3d" href="/maps/${enc}/3d" title="All storeys stacked in 3D · Shift 3">${ic('3d', 17)}3D</a>
  <a class="btn btn-primary ed-wide" id="screen-link" href="/maps/${enc}/screen" target="_blank" rel="noopener" title="Open the players' screen in a new window">${ic('screen', 17)}Players’ screen</a>
  <div class="ed-menu-wrap ed-wide"><button class="btn btn-secondary" type="button" id="export-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="export-menu">${ic('download', 17)}Export${icon('chevron-down', { size: 14, className: 'text-muted' })}</button>
    <div class="menu ed-menu" role="menu" id="export-menu" hidden>${exportItems}</div></div>
  <button class="btn btn-icon ed-storey-btn" type="button" id="storey-btn" aria-label="Change storey" aria-haspopup="menu" aria-expanded="false"${o.levels.length > 1 ? '' : ' hidden'}><span class="ed-storey-chip" id="storey-chip"></span></button>
  <div class="ed-menu-wrap ed-narrow"><button class="btn btn-icon" type="button" id="more-btn" aria-label="More: export, 3D, players’ screen, settings" aria-haspopup="menu" aria-expanded="false" aria-controls="more-menu">${ic('more', 20)}</button>
    <div class="menu ed-menu" role="menu" id="more-menu" hidden>${moreItems}</div></div>
  <span class="vsep ed-desk"></span>
  ${chat ? `<button class="btn btn-icon ed-chat-btn" type="button" id="chat-toggle" aria-pressed="false" aria-label="Chat with Claude" title="Claude · Ctrl .">${ic('chat')}</button>` : ''}
  ${edit ? who : `<a class="btn btn-secondary" id="login-link" href="${esc(loginHref)}">${ic('lock', 15)}<span class="lbl">Log in to edit</span></a>`}
</div>
</header>`;

  const chatPanel = chat
    ? `<aside class="ed-claude ed-sheet" id="chat" hidden aria-label="Chat with Claude">
  <span class="sheet-handle ed-phone-only"></span>
  <div class="ed-panel-head"><span class="ed-panel-title">Claude</span><span class="tag tag-accent tag-sm" id="chat-live" hidden><span class="dot"></span>Editing live</span>
    <div class="select ed-model"><select id="chat-model" class="input" aria-label="Model"></select>${ic('chevron-down', 13)}</div>
    <span class="spacer"></span>
    <button class="btn btn-icon" type="button" id="chat-plan" aria-pressed="true" aria-label="Show Claude’s plan" title="Show Claude’s plan: its steps, progress and time left">${PLAN_ICON}</button>
    <button class="btn btn-icon" type="button" id="chat-new" aria-label="New conversation" title="Start a new conversation">${ic('plus', 17)}</button>
    <button class="btn btn-icon" type="button" id="chat-close" aria-label="Collapse Claude" title="Collapse · Ctrl .">${icon('chevron-right', { size: 17, className: 'ed-collapse' })}</button></div>
  <div class="ed-chat-log" id="chat-log" role="log" aria-live="polite"></div>
  <div class="ed-chat-status" id="chat-status" role="status" hidden></div>
  <form class="ed-chat-form" id="chat-form">
    <textarea class="input" id="chat-input" rows="3" aria-label="Message Claude" placeholder="Ask Claude to change the map"></textarea>
    <div class="ed-chat-foot"><span class="ed-chat-hint" id="chat-usage">Each reply is one undo step. <kbd>/</kbd> focuses chat</span><button class="btn btn-primary" id="chat-send" type="submit" title="Send · Enter">${ic('send', 15)}<span>Send</span></button></div>
  </form>
</aside>`
    : '';

  const editorParts = edit
    ? {
        rail: `<nav class="rail ed-rail" id="rail" aria-label="Tools"></nav>`,
        overlays: `<div class="ctxbar ed-ctx" id="ctxbar" role="toolbar" aria-label="Tool options"></div>
    <aside class="ed-flyout" id="flyout" hidden></aside>`,
        inspector: `<aside class="ed-inspector ed-sheet" id="panel" aria-label="Properties">
    <span class="sheet-handle ed-phone-only"></span>
    <div class="tabs ed-tabs" role="tablist"><button class="tab" type="button" role="tab" id="tab-inspector" aria-selected="true">Inspector</button><button class="tab" type="button" role="tab" id="tab-map" aria-selected="false">Map settings</button><span class="spacer"></span><button class="btn btn-icon ed-drawer-close" type="button" id="panel-close" aria-label="Close the panel">${ic('x', 17)}</button></div>
    <div class="ed-scroll" id="props"></div>
  </aside>`,
        phonebar: `<nav class="ed-phonebar" id="phonebar" aria-label="Tools"><div class="ed-phonetools" id="phonetools" role="toolbar"></div>${chat ? `<span class="vsep"></span><button class="ed-phonetool" type="button" id="chat-phone" aria-pressed="false">${ic('chat', 22)}Claude</button>` : ''}</nav>`,
      }
    : { rail: '', overlays: '', inspector: '', phonebar: '' };

  const body = `${top}
<div class="ed-body">
  ${editorParts.rail}
  <main id="stage" style="background:${esc(bg)}" data-tool="">
    <div id="canvas">${sceneToSvg(scene, { ppg: 20 })}</div>
    <svg id="overlay" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" viewBox="${scene.bounds.x0} ${scene.bounds.y0} ${scene.bounds.x1 - scene.bounds.x0} ${scene.bounds.y1 - scene.bounds.y0}"></svg>
    ${editorParts.overlays}
    ${viewSeg('view-phone', ' ed-view-phone')}
    <div class="ed-storeys" id="storeys" role="group" aria-label="Storeys"${o.levels.length > 1 || edit ? '' : ' hidden'}></div>
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
  ${editorParts.inspector}
  ${chatPanel}
</div>
${editorParts.phonebar}
<div class="dialog-backdrop" id="shortcuts" hidden><div class="dialog ed-shortcuts" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
  <div class="dialog-head"><div class="dialog-title" id="shortcuts-title">Keyboard shortcuts</div><button class="btn btn-icon" type="button" data-close aria-label="Close">${ic('x', 17)}</button></div>
  <div class="ed-keys" id="shortcuts-list"></div></div></div>
<script id="delve-initial" type="application/json">${initial}</script>
<script type="module" src="/assets/viewer.js?v=${encodeURIComponent(info.version)}"></script>`;

  return htmlDocument({ title: map.name, body, bodyClass: `ed${edit ? ' editing' : ''}${chat ? ' has-chat' : ''}`, extra: `<style>${EDITOR_CSS}</style>` });
}

/** The page's layout. Components (rail, tool, ctxbar, menu, field…) come from @delve/ui. */
export const EDITOR_CSS = `
  html, body { height: 100%; }
  body.ed { display: flex; flex-direction: column; overflow: hidden; background: var(--color-bg); }
  .flip { transform: scaleX(-1); }
  .ed-top { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 12px; padding: 0 8px 0 16px; }
  .ed-top-start { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .ed-top-end { display: flex; align-items: center; justify-content: flex-end; gap: 4px; min-width: 0; }
  .ed-top-end > * { flex: none; }
  .ed-title { display: flex; flex-direction: column; min-width: 0; }
  .ed-subline { display: none; }
  .ed-history { display: flex; gap: 2px; margin-left: 2px; }
  .ed-view .seg-opt { padding: 6px 12px; }
  .ed-view .lbl-short, .ed-back, .ed-narrow, .ed-phone-only, .ed-view-phone, .ed-drawer-close { display: none; }
  .ed-menu-wrap { position: relative; }
  .ed-menu { position: absolute; right: 0; top: 40px; width: 300px; padding: 6px; border-radius: 10px; z-index: 50; }
  .ed-menu .menu-item { padding: 8px 10px; border-radius: 7px; }
  .ed-menu .menu-item > .icon { margin-top: 1px; color: var(--color-text-muted); }
  .ed-menu .menu-item kbd { align-self: center; }
  .ed-crop { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; padding-top: 6px; box-shadow: inset 0 1px 0 var(--color-border); }
  .ed-crop[hidden] { display: none; }
  .ed-menu-label { padding: 4px 10px 2px; }
  .ed-storey-chip { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; box-shadow: inset 0 0 0 1px var(--color-accent); color: var(--color-accent); font-weight: 600; font-size: 14px; font-variant-numeric: tabular-nums; }
  .ed-avatar { margin-left: 4px; }

  .ed-body { flex: 1; min-height: 0; display: flex; position: relative; }
  .ed-rail { box-shadow: inset -1px 0 0 var(--color-border); position: relative; z-index: 15; overflow-y: auto; scrollbar-width: none; }
  .ed-rail .spacer { flex: 1; min-height: 8px; }
  .ed-rail .tool.is-toggle[aria-pressed="true"] { background: transparent; box-shadow: none; color: var(--color-accent); }
  #stage { flex: 1; min-width: 0; position: relative; overflow: hidden; touch-action: none; cursor: grab; z-index: 1; user-select: none; -webkit-user-select: none; }
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

  /* floating canvas controls, 12 px in from the edges */
  .ed-ctx { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 5; max-width: calc(100% - 24px); overflow-x: auto; scrollbar-width: none; }
  .ed-ctx:empty { display: none; }
  .ed-ctx .range { width: 84px; }
  .ed-ctx-slider { display: flex; align-items: center; gap: 8px; padding: 0 6px; font-size: var(--text-sm); color: var(--color-text-muted); }
  .ed-ctx-slider output { min-width: 34px; color: var(--color-text); font-variant-numeric: tabular-nums; }
  .ed-ctx-hint { color: var(--color-text-muted); font-size: 12.5px; padding: 0 4px; }
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

  .ed-storeys { position: absolute; left: 12px; bottom: 12px; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px; width: 46px; border-radius: 10px; background: var(--color-surface); box-shadow: var(--shadow-md); z-index: 5; }
  .ed-storeys[hidden], .ed-storeys:empty { display: none; }
  .ed-sbtn { width: 38px; height: 34px; border: 0; border-radius: 7px; cursor: pointer; font-family: var(--font-ui); font-weight: 600; font-variant-numeric: tabular-nums; font-size: 15px; line-height: 1; background: transparent; color: var(--color-text-muted); position: relative; }
  .ed-sbtn:hover { background: var(--color-hover); color: var(--color-text); }
  .ed-sbtn[aria-current="true"] { background: var(--tint-accent-bg); color: var(--color-accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent); }
  /* + and − step a storey up or down; the floor numbers use the UI font (the numeral font draws 1 and 0 like I and O) */
  .ed-sbtn-step { height: 28px; display: grid; place-items: center; font-size: 19px; font-weight: 500; }
  .ed-sbtn:disabled { opacity: .35; cursor: default; background: transparent; }
  .ed-sname { position: absolute; left: 48px; top: 50%; transform: translateY(-50%); white-space: nowrap; font-family: var(--font-ui); font-size: var(--text-sm); padding: 4px 8px; border-radius: 6px; background: var(--color-surface); color: var(--color-text); box-shadow: var(--shadow-sm); pointer-events: none; }
  .ed-skeys { font-size: 9.5px; color: var(--color-text-faint); padding: 2px 0 1px; }
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
  .ed-empty { padding: 40px 24px; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .ed-empty > .icon { color: var(--color-text-faint); }
  .ed-empty-title { font-family: var(--font-display); font-size: 19px; }
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

  .ed-phonebar { display: none; }

  /* 1024–1279: Claude floats over the canvas */
  @media (max-width: 1279px) {
    .ed-claude { position: absolute; top: 12px; bottom: 12px; right: calc(var(--panel-w) + 12px); border-radius: 12px; box-shadow: var(--shadow-lg); overflow: hidden; }
    body:not(.editing) .ed-claude { right: 12px; }
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
    .ed-top { height: 52px; grid-template-columns: minmax(0, 1fr) auto; padding: 0 4px; gap: 0; }
    .ed-top > .ed-view, .ed-desk, .topbar-brand, .ed-avatar { display: none !important; }
    .ed-back { display: grid; width: 44px; height: 44px; color: var(--color-text); }
    .ed-top-start { gap: 0; }
    .ed-title { padding-left: 2px; }
    .ed-title .crumb-title { font-size: 19px; line-height: 1.15; }
    .ed-subline { display: flex; align-items: center; gap: 6px; }
    .ed-subline .status { font-size: var(--text-sm); }
    .ed-history .btn-icon, .ed-top-end .btn-icon { width: 44px; height: 44px; }
    .ed-chat-btn { display: none; }
    .ed-view-phone { display: inline-flex; position: absolute; top: 12px; right: 12px; z-index: 8; background: var(--color-surface); box-shadow: var(--shadow-md); }
    .ed-view-phone .seg-opt { min-height: 40px; padding: 0 12px; }
    .ed-view-phone .lbl { display: none; } .ed-view-phone .lbl-short { display: inline; }
    .ed-rail, .ed-zoom, .ed-storeys { display: none !important; }
    .ed-phonebar { display: flex; align-items: center; flex: none; padding: 6px 0 calc(6px + env(safe-area-inset-bottom)); background: var(--color-surface); box-shadow: inset 0 1px 0 var(--color-border); position: relative; z-index: 20; }
    .ed-phonebar .vsep { height: 32px; }
    .ed-phonetools { flex: 1; min-width: 0; display: flex; gap: 2px; overflow-x: auto; padding: 0 6px 0 8px; scrollbar-width: none; }
    .ed-phonetool { flex: none; width: 54px; height: 52px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; border: 0; border-radius: 10px; cursor: pointer; font: inherit; font-size: 10.5px; background: transparent; color: var(--color-text-muted); }
    #chat-phone { width: 58px; margin: 0 6px; }
    .ed-phonetool[aria-pressed="true"] { background: var(--tint-accent-bg); color: var(--color-accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent); }
    .ed-ctx { top: auto; bottom: 12px; left: 8px; right: 8px; transform: none; max-width: none; }
    .ed-float-bottom { bottom: 64px; max-width: calc(100% - 24px); }
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
  }
`;
