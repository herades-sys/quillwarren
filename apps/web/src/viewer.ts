// Live map viewer, and host for the editor. Renders with @delve/core in the
// browser, follows every change over the WebSocket, and pans to whatever
// Claude focuses on. Viewing never needs a login; editing does.
import { applyOps, buildScene, floorText, PRESETS, sceneToSvg, storeyTitle, type Bounds, type DelveMap, type Op, type Point, type View } from '@delve/core';
import { artLoader } from './art.ts';
import { initChat } from './chat.ts';
import { SVG_NS } from './ctx.ts';
import { initEditor } from './editor.ts';
import { initMarkers } from './markers.ts';
import { ago, changedIds, countOps, easeInOut, lerpBounds, objectBounds, pad, unionBounds, zoomAt } from './logic.ts';

interface Initial {
  id: string;
  rev: number;
  map: DelveMap;
  /** This map's storeys, top first. */
  levels: Storey[];
  edit: { loggedIn: boolean; passwordSet: boolean };
  /** Only for logged-in editors on a server with the chat bridge set up. */
  chat?: { enabled: boolean; model: string };
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

interface Storey {
  id: string;
  name: string;
  level?: { group: string; name: string; order: number };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const initial = JSON.parse($('delve-initial').textContent ?? '{}') as Initial;
const mapId = initial.id;
let map = initial.map;
let rev = initial.rev;
const params = new URLSearchParams(location.search);
let view: View = params.get('view') === 'players' ? 'players' : 'gm';
let styleOverride = params.get('style') && PRESETS[params.get('style')!] ? params.get('style') : null;

const stage = $<HTMLDivElement>('stage'); // takes the pointer input
const canvas = $<HTMLDivElement>('canvas'); // holds the map SVG, replaced on every render
const overlay = document.getElementById('overlay') as unknown as SVGSVGElement; // highlights and editor marks
const ui = {
  name: $('map-name'),
  rev: $('map-rev'),
  dot: $('conn-dot'),
  conn: $('conn-text'),
  activity: $('activity'),
  toast: $('toast'),
  style: $<HTMLSelectElement>('style-select'),
  png: $<HTMLAnchorElement>('png-link'),
  fit: $<HTMLButtonElement>('fit'),
};
const viewButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-view]')];

let svg: SVGSVGElement | null = null;
let bounds: Bounds | null = null;
let vb: Bounds | null = null;
let userMoved = false;
let lastChange: { at: number; text: string } | null = null;
const highlights: { b: Bounds; until: number; kind: 'focus' | 'change' }[] = [];
const renderHooks: (() => void)[] = [];
const viewHooks: (() => void)[] = [];
const handled = new WeakSet<Event>();

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
  // fog of war: the GM sees unrevealed parts shaded, the players' view doesn't draw them
  // the floor number is a badge in the corner of the stage here, not part of the picture
  const scene = buildScene(m, { view, assets: art.body, fog: view === 'players' ? 'hide' : 'dim', floorNumber: false });
  showFloor();
  stage.style.background = scene.layers[0]?.kind === 'rect' ? scene.layers[0].color : '';
  canvas.innerHTML = sceneToSvg(scene, { ppg: 20 });
  svg = canvas.querySelector('svg');
  if (!svg) return;
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  bounds = scene.bounds;
  if (!vb || !userMoved) vb = { ...bounds };
  applyViewBox();
  updateChrome();
  renderHooks.forEach((f) => f());
}

function applyViewBox(): void {
  if (!vb) return;
  const box = `${vb.x0} ${vb.y0} ${vb.x1 - vb.x0} ${vb.y1 - vb.y0}`;
  svg?.setAttribute('viewBox', box);
  overlay.setAttribute('viewBox', box);
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
  for (const h of highlights) {
    const b = pad(h.b, 0.2);
    const r = document.createElementNS(SVG_NS, 'rect');
    for (const [k, v] of Object.entries({ x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, rx: 0.25 })) r.setAttribute(k, String(v));
    r.setAttribute('class', `hl-${h.kind}`);
    g.appendChild(r);
  }
  overlay.prepend(g);
  clearTimeout(highlightTimer);
  highlightTimer = window.setTimeout(drawHighlights, Math.max(50, Math.min(...highlights.map((h) => h.until)) - now));
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
  ui.name.textContent = map.name;
  document.title = `${map.name} · Delve`;
  ui.rev.textContent = `rev ${rev}`;
  for (const b of viewButtons) b.setAttribute('aria-pressed', String(b.dataset.view === view));
  ui.style.value = styleOverride ?? '';
  const q = new URLSearchParams({ view, ...(styleOverride ? { style: styleOverride } : {}) });
  ui.png.href = `/api/v1/maps/${encodeURIComponent(mapId)}/render.png?${q}`;
  const url = new URL(location.href);
  for (const k of ['view', 'style']) url.searchParams.delete(k);
  if (view === 'players') url.searchParams.set('view', view);
  if (styleOverride) url.searchParams.set('style', styleOverride);
  history.replaceState(null, '', url);
}

/** A storey's floor number, big in the stage's top-left corner (0 ground level, −1 below it); nothing for a single map. */
function showFloor(): void {
  const badge = document.getElementById('floor-badge');
  if (!badge) return;
  badge.hidden = !map.level;
  badge.textContent = map.level ? floorText(map.level.order) : '';
  badge.title = map.level ? `Floor ${floorText(map.level.order)}: ${map.level.name}` : '';
}

function setConnection(state: 'live' | 'connecting' | 'offline' | 'deleted'): void {
  ui.dot.dataset.state = state;
  ui.conn.textContent = { live: 'Live', connecting: 'Connecting…', offline: 'Offline, retrying', deleted: 'Map deleted' }[state];
}

function showActivity(): void {
  ui.activity.textContent = lastChange ? `${lastChange.text} · ${ago(Date.now() - lastChange.at)}` : 'Waiting for changes';
}
setInterval(showActivity, 5000);

let toastTimer: number | undefined;
function toast(msg: string, kind: 'error' | 'info' = 'error'): void {
  ui.toast.textContent = msg;
  ui.toast.dataset.kind = kind;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (ui.toast.hidden = true), kind === 'error' ? 6000 : 2500);
}

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
    if (!vb || !bounds) return;
    e.preventDefault();
    const p = toMap(e.clientX, e.clientY);
    if (!p) return;
    cancelAnimationFrame(anim ?? 0);
    vb = zoomAt(vb, p, Math.exp(e.deltaY * 0.0015), 3, (bounds.x1 - bounds.x0) * 3);
    userMoved = true;
    applyViewBox();
  },
  { passive: false },
);

let drag: { x: number; y: number; vb: Bounds; scale: number } | null = null;
stage.addEventListener('pointerdown', (e) => {
  if (handled.has(e) || e.button !== 0) return;
  const ctm = svg?.getScreenCTM();
  if (!vb || !ctm) return;
  cancelAnimationFrame(anim ?? 0);
  drag = { x: e.clientX, y: e.clientY, vb: { ...vb }, scale: ctm.a };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
});
stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = (e.clientX - drag.x) / drag.scale;
  const dy = (e.clientY - drag.y) / drag.scale;
  vb = { x0: drag.vb.x0 - dx, y0: drag.vb.y0 - dy, x1: drag.vb.x1 - dx, y1: drag.vb.y1 - dy };
  userMoved = true;
  applyViewBox();
});
const endDrag = () => {
  drag = null;
  stage.classList.remove('dragging');
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
stage.addEventListener('dblclick', (e) => {
  if (!handled.has(e)) fit();
});
ui.fit.addEventListener('click', fit);
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('input, select, textarea') || e.ctrlKey || e.metaKey || !vb || !bounds) return;
  const centre: Point = [(vb.x0 + vb.x1) / 2, (vb.y0 + vb.y1) / 2];
  const maxW = (bounds.x1 - bounds.x0) * 3;
  if (e.key === 'f' || e.key === '0') fit();
  else if (e.key === '+' || e.key === '=') {
    vb = zoomAt(vb, centre, 0.8, 3, maxW);
    userMoved = true;
    applyViewBox();
  } else if (e.key === '-') {
    vb = zoomAt(vb, centre, 1.25, 3, maxW);
    userMoved = true;
    applyViewBox();
  }
});

for (const b of viewButtons) {
  b.addEventListener('click', () => {
    view = b.dataset.view === 'players' ? 'players' : 'gm';
    render();
  });
}
ui.style.addEventListener('change', () => {
  styleOverride = ui.style.value || null;
  render();
});

// ---------- storeys ----------

let storeys: Storey[] = initial.levels ?? [];
const storeySelect = document.getElementById('storey-select') as HTMLSelectElement | null;
function showStoreys(): void {
  if (!storeySelect) return;
  storeySelect.replaceChildren(
    ...storeys.map((s) => Object.assign(document.createElement('option'), { value: s.id, textContent: storeyTitle(s), selected: s.id === mapId })),
  );
  storeySelect.hidden = storeys.length < 2;
}
async function refreshStoreys(): Promise<void> {
  const res = await fetch(`/api/v1/maps/${encodeURIComponent(mapId)}/levels`);
  if (!res.ok) return;
  storeys = ((await res.json()) as { levels: Storey[] }).levels;
  showStoreys();
}
storeySelect?.addEventListener('change', () => {
  // same view, style and edit mode on the other storey
  const url = new URL(location.href);
  url.pathname = `/maps/${encodeURIComponent(storeySelect.value)}`;
  location.href = url.toString();
});

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
  setConnection('connecting');
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/maps/${encodeURIComponent(mapId)}/live`);
  ws = socket;
  let gone = false;
  socket.onmessage = async (ev) => {
    const msg = JSON.parse(String(ev.data)) as Incoming;
    switch (msg.type) {
      case 'hello':
        retry = 1000;
        setConnection('live');
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
        setConnection('deleted');
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
    setConnection('offline');
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 15000);
  };
}

function send(ops: Op[]): Promise<number> {
  return new Promise((ok, fail) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return fail(new Error('not connected; wait a moment and try again'));
    const ref = nextRef++;
    pending.set(ref, { ok, fail });
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
showActivity();
connect();

let editor: { selection(): string[]; tool(): string | null } | null = null;
// before the editor: its capture listeners must see marker clicks first
const markers = initMarkers({
  stage,
  handled,
  map: () => map,
  view: () => view,
  toMap,
  toScreen: ([x, y]) => {
    const ctm = svg?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(x, y).matrixTransform(ctm);
    return { x: p.x, y: p.y };
  },
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
    setEditing: (on) => {
      document.body.classList.toggle('editing', on);
      requestAnimationFrame(() => applyViewBox());
    },
  });
}

if (initial.chat?.enabled) {
  initChat(
    {
      mapId,
      selection: () => editor?.selection() ?? [],
      view: () => (vb ? { ...vb } : null),
      layout: () => requestAnimationFrame(() => applyViewBox()),
      hasObjects: () => map.objects.length > 0,
    },
    { model: initial.chat.model },
  );
}
