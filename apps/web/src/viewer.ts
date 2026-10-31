// Live map viewer, and host for the editor. Renders with @delve/core in the
// browser, follows every change over the WebSocket, and pans to whatever
// Claude focuses on. Viewing never needs a login; editing does. The chrome
// around the map (menus, zoom, storeys, toasts) is shell.ts.
import { applyOps, buildScene, PRESETS, resolveStyle, sceneToSvg, withBackground, type Bounds, type DelveMap, type Op, type Point, type View } from '@delve/core';
import { artLoader } from './art.ts';
import { initChat } from './chat.ts';
import { onControl, SVG_NS } from './ctx.ts';
import { initEditor } from './editor.ts';
import { initMarkers } from './markers.ts';
import { ago, changedIds, countOps, easeInOut, lerpBounds, objectBounds, pad, unionBounds, zoomAt } from './logic.ts';
import { initShell, type Storey } from './shell.ts';
import { initSnip } from './snip.ts';

interface Initial {
  id: string;
  rev: number;
  map: DelveMap;
  /** This map's storeys, top first. */
  levels: Storey[];
  edit: { loggedIn: boolean; passwordSet: boolean };
  account: { name: string; role: 'admin' | 'gm' } | null;
  /** Only for logged-in editors on a server with the chat bridge set up (or, in the desktop app, a choice of backends). */
  chat?: { enabled: boolean; model: string; backend?: string; backends?: string[]; name?: string };
  /** Snip an area to a PNG (snip.ts): admin and GM accounts only. */
  snip?: boolean;
  /** false in the desktop app: no Delve Table or players' screen (editor-page.ts). */
  multiplayer?: false;
}
type Incoming =
  | { type: 'hello'; rev: number; map: DelveMap }
  | { type: 'ops'; rev: number; by: string; kind: string; ops: Op[] }
  | { type: 'focus'; ids: string[]; by: string }
  | { type: 'deleted' }
  | { type: 'levels' }
  | { type: 'ack'; rev: number; ref?: number }
  | { type: 'error'; error: string; ref?: number }
  | { type: 'pong' };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const initial = JSON.parse($('delve-initial').textContent ?? '{}') as Initial;
const mapId = initial.id;
let map = initial.map;
let rev = initial.rev;
const params = new URLSearchParams(location.search);
let view: View = params.get('view') === 'players' ? 'players' : 'gm';
const styleOverride = params.get('style') && PRESETS[params.get('style')!] ? params.get('style') : null;
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private window: the choice just isn't kept */
    }
  },
};
let grid = store.get('delve-grid') !== 'off';

const stage = $<HTMLDivElement>('stage'); // takes the pointer input
const canvas = $<HTMLDivElement>('canvas'); // holds the map SVG, replaced on every render
const overlay = document.getElementById('overlay') as unknown as SVGSVGElement; // highlights and editor marks
const nameEl = $('map-name');

let svg: SVGSVGElement | null = null;
let bounds: Bounds | null = null;
let vb: Bounds | null = null;
let userMoved = false;
let lastChange: { at: number; text: string } | null = null;
const highlights: { b: Bounds; until: number; kind: 'focus' | 'change' }[] = [];
const renderHooks: (() => void)[] = [];
const viewHooks: (() => void)[] = [];
const handled = new WeakSet<Event>();

const shell = initShell({
  mapId,
  edit: initial.edit.loggedIn,
  snip: Boolean(initial.snip),
  view,
  hooks: {
    setView: (v) => setView(v),
    zoomIn: () => zoomBy(0.8),
    zoomOut: () => zoomBy(1.25),
    fit: () => fit(),
  },
});

// ---------- prop and terrain art, loaded as the map needs it ----------

const art = artLoader(() => renderSoon());
let renderQueued = false;
function renderSoon(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// ---------- drawing ----------

function render(): void {
  art.ensure(map);
  const m = styleOverride ? { ...map, style: { ...map.style, preset: styleOverride } } : map;
  // fog of war: the GM sees unrevealed parts shaded, the players' view doesn't draw them;
  // the floor number is the storeys control here, not part of the picture
  const scene = buildScene(m, { view, assets: art.body, fog: view === 'players' ? 'hide' : 'dim', floorNumber: false });
  if (!grid) scene.layers = scene.layers.filter((l) => l.name !== 'grid');
  stage.style.background = scene.layers[0]?.kind === 'rect' ? scene.layers[0].color : '';
  canvas.innerHTML = sceneToSvg(scene, { ppg: 20 });
  svg = canvas.querySelector('svg');
  if (!svg) return;
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  bounds = scene.bounds;
  if (previewBg) paintBackground(previewBg);
  if (!vb || !userMoved) vb = { ...bounds };
  applyViewBox();
  updateChrome();
  renderHooks.forEach((f) => f());
}

// ---------- the background colour's live preview (the editor's colour wheel) ----------

/** While the colour wheel is dragged: the colour shown instead of the map's, painted into the picture without drawing it again. */
let previewBg: string | null = null;

/** Paint a background colour into the current picture: the stage, the background rect, and what follows it (background grid, hatching ink). */
function paintBackground(hex: string): void {
  const m = styleOverride ? { ...map, style: { ...map.style, preset: styleOverride } } : map;
  const s = resolveStyle({ style: withBackground(m, hex) });
  stage.style.background = s.background;
  if (!svg) return;
  svg.querySelector('g[data-layer="background"] > rect')?.setAttribute('fill', s.background);
  if (s.backgroundGrid) svg.querySelectorAll('g[data-layer="background-grid"] > path').forEach((p) => p.setAttribute('stroke', s.backgroundGrid!.color));
  if (s.hatching) svg.querySelectorAll('g[data-layer="hatching"] > path').forEach((p) => p.setAttribute('stroke', s.hatching!.color));
}

/**
 * Show `hex` as the background while the user picks one; null ends the
 * preview. `repaint` false leaves the picture as it is (the change was just
 * sent, and the map's own redraw follows), so the colour doesn't flash back.
 */
function previewBackground(hex: string | null, repaint = true): void {
  previewBg = hex;
  if (hex) paintBackground(hex);
  else if (repaint) render();
}

function applyViewBox(): void {
  if (!vb) return;
  const box = `${vb.x0} ${vb.y0} ${vb.x1 - vb.x0} ${vb.y1 - vb.y0}`;
  svg?.setAttribute('viewBox', box);
  overlay.setAttribute('viewBox', box);
  if (bounds) shell.setZoom((100 * Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0)) / Math.max(vb.x1 - vb.x0, vb.y1 - vb.y0));
  viewHooks.forEach((f) => f());
}

let highlightTimer: number | undefined;
function drawHighlights(): void {
  overlay.querySelector('g.hl')?.remove();
  const now = performance.now();
  for (let i = highlights.length - 1; i >= 0; i--) if (highlights[i]!.until <= now) highlights.splice(i, 1);
  if (!highlights.length) return;
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'hl');
  for (const hl of highlights) {
    const b = pad(hl.b, 0.2);
    const r = document.createElementNS(SVG_NS, 'rect');
    for (const [k, v] of Object.entries({ x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, rx: 0.25 })) r.setAttribute(k, String(v));
    r.setAttribute('class', `hl-${hl.kind}`);
    g.appendChild(r);
  }
  overlay.prepend(g);
  clearTimeout(highlightTimer);
  highlightTimer = window.setTimeout(drawHighlights, Math.max(50, Math.min(...highlights.map((x) => x.until)) - now));
}

function highlight(ids: string[], kind: 'focus' | 'change', ms: number): Bounds | null {
  const byId = new Map(map.objects.map((o) => [o.id, o]));
  const list = ids.map((id) => byId.get(id)).map((o) => (o ? objectBounds(o, map) : null));
  const until = performance.now() + ms;
  for (const b of list) if (b) highlights.push({ b, until, kind });
  drawHighlights();
  return unionBounds(list);
}

// ---------- chrome ----------

function updateChrome(): void {
  nameEl.textContent = map.name;
  document.title = `${map.name} · Delve`;
  shell.syncView(view);
  const url = new URL(location.href);
  url.searchParams.delete('view');
  if (view === 'players') url.searchParams.set('view', view);
  history.replaceState(null, '', url);
}

function setView(v: View): void {
  view = v;
  render();
}

function showActivity(): void {
  if (lastChange) shell.setActivity(`${lastChange.text} · ${ago(Date.now() - lastChange.at)}`);
}
setInterval(showActivity, 5000);

const toast = (msg: string, kind: 'error' | 'info' = 'error') => shell.toast(msg, kind);

// ---------- view animation, pan and zoom ----------

let anim: number | undefined;
function animateTo(target: Bounds, ms = 650): void {
  if (!vb) return;
  const from = { ...vb };
  const start = performance.now();
  cancelAnimationFrame(anim ?? 0);
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    vb = lerpBounds(from, target, easeInOut(t));
    applyViewBox();
    if (t < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

function fit(): void {
  if (!bounds) return;
  userMoved = false;
  animateTo({ ...bounds }, 400);
}

function zoomBy(factor: number, at?: Point): void {
  if (!vb || !bounds) return;
  cancelAnimationFrame(anim ?? 0);
  vb = zoomAt(vb, at ?? [(vb.x0 + vb.x1) / 2, (vb.y0 + vb.y1) / 2], factor, 3, (bounds.x1 - bounds.x0) * 3);
  userMoved = true;
  applyViewBox();
}

function toMap(clientX: number, clientY: number): Point | null {
  const ctm = svg?.getScreenCTM();
  if (!svg || !ctm) return null;
  const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  return [p.x, p.y];
}

const squaresPerPx = (): number => 1 / (svg?.getScreenCTM()?.a || 20);

stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const p = toMap(e.clientX, e.clientY);
    if (p) zoomBy(Math.exp(e.deltaY * 0.0015), p);
  },
  { passive: false },
);

// One pointer drags the map; two pinch it (phones and tablets).
const pointers = new Map<number, { x: number; y: number }>();
let drag: { x: number; y: number; vb: Bounds; scale: number } | null = null;
let pinch: { d: number; vb: Bounds; mid: Point } | null = null;
const spread = () => {
  const [a, b] = [...pointers.values()];
  return a && b ? { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 } : null;
};
stage.addEventListener('pointerdown', (e) => {
  if (onControl(e)) return; // a button over the map keeps its click
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2 && vb) {
    const s = spread()!;
    const mid = toMap(s.cx, s.cy);
    if (mid) pinch = { d: s.d, vb: { ...vb }, mid };
    drag = null;
    return;
  }
  // the middle or right button always pans (the editor's Select tool draws a box with the left one)
  const panButton = e.button === 1 || e.button === 2;
  if (!panButton && (handled.has(e) || e.button !== 0)) return;
  if (e.button === 1) e.preventDefault(); // no autoscroll
  const ctm = svg?.getScreenCTM();
  if (!vb || !ctm) return;
  cancelAnimationFrame(anim ?? 0);
  drag = { x: e.clientX, y: e.clientY, vb: { ...vb }, scale: ctm.a };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
});
stage.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && bounds) {
    const s = spread();
    if (!s || !s.d) return;
    const k = pinch.d / s.d;
    const w = Math.min(Math.max((pinch.vb.x1 - pinch.vb.x0) * k, 3), (bounds.x1 - bounds.x0) * 3);
    const f = w / (pinch.vb.x1 - pinch.vb.x0);
    const [mx, my] = pinch.mid;
    vb = { x0: mx - (mx - pinch.vb.x0) * f, y0: my - (my - pinch.vb.y0) * f, x1: mx + (pinch.vb.x1 - mx) * f, y1: my + (pinch.vb.y1 - my) * f };
    userMoved = true;
    applyViewBox();
    return;
  }
  if (!drag) return;
  const dx = (e.clientX - drag.x) / drag.scale;
  const dy = (e.clientY - drag.y) / drag.scale;
  vb = { x0: drag.vb.x0 - dx, y0: drag.vb.y0 - dy, x1: drag.vb.x1 - dx, y1: drag.vb.y1 - dy };
  userMoved = true;
  applyViewBox();
});
const endDrag = (e: PointerEvent) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  drag = null;
  stage.classList.remove('dragging');
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
// right-drag pans, so the map has no browser context menu (saving the picture is in Export)
stage.addEventListener('contextmenu', (e) => e.preventDefault());
stage.addEventListener('dblclick', (e) => {
  if (!handled.has(e)) fit();
});
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('input, select, textarea') || e.altKey) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === '0') {
    e.preventDefault();
    fit();
  } else if (mod) return;
  else if (e.key === '+' || e.key === '=') zoomBy(0.8);
  else if (e.key === '-') zoomBy(1.25);
  else if (e.shiftKey && e.key.toLowerCase() === 'p') setView(view === 'gm' ? 'players' : 'gm');
  else if (e.shiftKey && e.key.toLowerCase() === 'g') toggleGrid();
});

function toggleGrid(): void {
  grid = !grid;
  store.set('delve-grid', grid ? 'on' : 'off');
  render();
}

// ---------- storeys ----------

let storeys: Storey[] = initial.levels ?? [];
async function refreshStoreys(): Promise<void> {
  const res = await fetch(`/api/v1/maps/${encodeURIComponent(mapId)}/levels`);
  if (!res.ok) return;
  storeys = ((await res.json()) as { levels: Storey[] }).levels;
  shell.setStoreys(storeys);
}

// ---------- live connection ----------

async function resync(): Promise<void> {
  const res = await fetch(`/api/v1/maps/${encodeURIComponent(mapId)}`);
  if (!res.ok) return;
  const body = (await res.json()) as { rev: number; map: DelveMap };
  map = body.map;
  rev = body.rev;
}

let ws: WebSocket | null = null;
let nextRef = 1;
const pending = new Map<number, { ok: (rev: number) => void; fail: (e: Error) => void }>();

let retry = 1000;
function connect(): void {
  shell.setConnection('connecting');
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/maps/${encodeURIComponent(mapId)}/live`);
  ws = socket;
  let gone = false;
  socket.onmessage = async (ev) => {
    const msg = JSON.parse(String(ev.data)) as Incoming;
    switch (msg.type) {
      case 'hello':
        retry = 1000;
        shell.setConnection('live');
        if (msg.rev !== rev) {
          map = msg.map;
          rev = msg.rev;
        }
        render();
        break;
      case 'ops': {
        if (msg.rev <= rev) break;
        if (msg.rev === rev + 1) {
          try {
            map = applyOps(map, msg.ops).map;
            rev = msg.rev;
          } catch {
            await resync();
          }
        } else {
          await resync();
        }
        render();
        if (JSON.stringify(msg.ops).includes('"update_map"')) void refreshStoreys(); // a storey may have been renamed
        highlight(changedIds(msg.ops), 'change', 1600);
        const n = countOps(msg.ops);
        const what = msg.kind === 'ops' ? `${n} change${n === 1 ? '' : 's'}` : msg.kind;
        lastChange = { at: Date.now(), text: `rev ${msg.rev}: ${what} by ${msg.by}` };
        showActivity();
        break;
      }
      case 'focus': {
        const b = highlight(msg.ids, 'focus', 3500);
        if (b && stage.clientWidth) {
          userMoved = true;
          animateTo(pad(b, 2.5));
        }
        lastChange = { at: Date.now(), text: `${msg.by} is pointing at ${msg.ids.join(', ')}` };
        showActivity();
        break;
      }
      case 'ack':
        if (msg.ref !== undefined) pending.get(msg.ref)?.ok(msg.rev);
        if (msg.ref !== undefined) pending.delete(msg.ref);
        break;
      case 'error':
        if (msg.ref !== undefined && pending.has(msg.ref)) {
          pending.get(msg.ref)!.fail(new Error(msg.error));
          pending.delete(msg.ref);
        } else toast(msg.error);
        break;
      case 'levels':
        void refreshStoreys();
        break;
      case 'deleted':
        gone = true;
        shell.setConnection('deleted');
        socket.close();
        break;
      default:
        break;
    }
  };
  socket.onclose = () => {
    for (const p of pending.values()) p.fail(new Error('connection lost; the change may not have been saved'));
    pending.clear();
    if (gone) return;
    shell.setConnection('offline');
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 15000);
  };
}

function send(ops: Op[]): Promise<number> {
  return new Promise((ok, fail) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return fail(new Error('not connected; wait a moment and try again'));
    const ref = nextRef++;
    shell.setSave('saving');
    pending.set(ref, {
      ok: (r) => (shell.setSave('saved'), ok(r)),
      fail: (e) => (shell.setSave('failed'), fail(e)),
    });
    ws.send(JSON.stringify({ type: 'ops', ops, ref, by: 'editor' }));
  });
}

async function historyAction(action: 'undo' | 'redo'): Promise<void> {
  const res = await fetch(`/api/v1/maps/${encodeURIComponent(mapId)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ by: 'editor' }),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `${action} failed`);
}

// ---------- start ----------

render();
drawHighlights();
connect();
shell.setStoreys(storeys);

let editor: { selection(): string[]; tool(): string | null; suspend(on: boolean): void } | null = null;

function toScreen([x, y]: Point): { x: number; y: number } | null {
  const ctm = svg?.getScreenCTM();
  if (!ctm) return null;
  const p = new DOMPoint(x, y).matrixTransform(ctm);
  return { x: p.x, y: p.y };
}

// before the markers and the editor: while snipping, its capture listeners take the clicks first
if (initial.snip) {
  initSnip({
    mapId,
    stage,
    overlay,
    shell,
    handled,
    map: () => map,
    view: () => view,
    setView: (v) => setView(v),
    style: () => styleOverride,
    toMap,
    toScreen,
    squaresPerPx,
    viewBox: () => (vb ? { ...vb } : null),
    mapBounds: () => (bounds ? { ...bounds } : null),
    selection: () => editor?.selection() ?? [],
    suspendEditor: (on) => editor?.suspend(on),
    onRender: (cb) => renderHooks.push(cb),
    onView: (cb) => viewHooks.push(cb),
  });
}

// before the editor: its capture listeners must see marker clicks first
const markers = initMarkers({
  stage,
  handled,
  map: () => map,
  view: () => view,
  toMap,
  toScreen,
  squaresPerPx,
  canEdit: initial.edit.loggedIn,
  send,
  toast,
  onRender: (cb) => renderHooks.push(cb),
  onView: (cb) => viewHooks.push(cb),
  editorTool: () => editor?.tool() ?? null,
});
if (initial.edit.loggedIn) {
  editor = initEditor({
    openMarker: (id) => markers.open(id, true),
    mapId,
    stage,
    overlay,
    shell,
    handled,
    map: () => map,
    rev: () => rev,
    storeys: () => storeys,
    toMap,
    squaresPerPx,
    send,
    history: historyAction,
    onRender: (cb) => renderHooks.push(cb),
    onView: (cb) => viewHooks.push(cb),
    toast,
    view: () => view,
    grid: () => grid,
    toggleGrid,
    previewBackground,
    ...(initial.multiplayer === false ? { multiplayer: false as const } : {}),
  });
}

if (initial.chat?.enabled) {
  initChat(
    {
      mapId,
      shell,
      account: initial.account,
      selection: () => editor?.selection() ?? [],
      view: () => (vb ? { ...vb } : null),
      layout: () => requestAnimationFrame(() => applyViewBox()),
      hasObjects: () => map.objects.length > 0,
    },
    { model: initial.chat.model, ...(initial.chat.backends ? { backend: initial.chat.backend ?? 'none', backends: initial.chat.backends, name: initial.chat.name ?? 'Assistant' } : {}) },
  );
}

// the canvas keeps its picture centred when panels open and close
new ResizeObserver(() => applyViewBox()).observe(stage);
