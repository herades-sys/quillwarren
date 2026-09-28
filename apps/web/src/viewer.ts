// Live map viewer. Renders with @delve/core in the browser, follows every
// change over the WebSocket, and pans to whatever Claude focuses on.
// Read-only: it never needs the API token.
import { applyOps, buildScene, PRESETS, sceneToSvg, type Bounds, type DelveMap, type Op, type View } from '@delve/core';
import { ago, changedIds, countOps, easeInOut, lerpBounds, objectBounds, pad, unionBounds, zoomAt } from './logic.ts';

interface Initial {
  id: string;
  rev: number;
  map: DelveMap;
}
type Incoming =
  | { type: 'hello'; rev: number; map: DelveMap }
  | { type: 'ops'; rev: number; by: string; kind: string; ops: Op[] }
  | { type: 'focus'; ids: string[]; by: string }
  | { type: 'deleted' }
  | { type: 'error'; error: string }
  | { type: 'pong' };

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const initial = JSON.parse($('delve-initial').textContent ?? '{}') as Initial;
const mapId = initial.id;
let map = initial.map;
let rev = initial.rev;
const params = new URLSearchParams(location.search);
let view: View = params.get('view') === 'players' ? 'players' : 'gm';
let styleOverride = params.get('style') && PRESETS[params.get('style')!] ? params.get('style') : null;

const stage = $<HTMLDivElement>('stage'); // takes the pointer input
const canvas = $<HTMLDivElement>('canvas'); // holds the SVG, replaced on every render
const ui = {
  name: $('map-name'),
  rev: $('map-rev'),
  dot: $('conn-dot'),
  conn: $('conn-text'),
  activity: $('activity'),
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

// ---------- drawing ----------

function render(): void {
  const m = styleOverride ? { ...map, style: { ...map.style, preset: styleOverride } } : map;
  const scene = buildScene(m, { view });
  const bg = scene.layers[0]?.kind === 'rect' ? scene.layers[0].color : '';
  stage.style.background = bg;
  canvas.innerHTML = sceneToSvg(scene, { ppg: 20 });
  svg = canvas.querySelector('svg');
  if (!svg) return;
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  bounds = scene.bounds;
  if (!vb || !userMoved) vb = { ...bounds };
  applyViewBox();
  drawHighlights();
  updateChrome();
}

function applyViewBox(): void {
  if (!svg || !vb) return;
  svg.setAttribute('viewBox', `${vb.x0} ${vb.y0} ${vb.x1 - vb.x0} ${vb.y1 - vb.y0}`);
}

let highlightTimer: number | undefined;
function drawHighlights(): void {
  if (!svg) return;
  svg.querySelector('g.hl')?.remove();
  const now = performance.now();
  for (let i = highlights.length - 1; i >= 0; i--) if (highlights[i]!.until <= now) highlights.splice(i, 1);
  if (!highlights.length) return;
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'hl');
  for (const h of highlights) {
    const b = pad(h.b, 0.2);
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', String(b.x0));
    r.setAttribute('y', String(b.y0));
    r.setAttribute('width', String(b.x1 - b.x0));
    r.setAttribute('height', String(b.y1 - b.y0));
    r.setAttribute('rx', '0.25');
    r.setAttribute('class', `hl-${h.kind}`);
    g.appendChild(r);
  }
  svg.appendChild(g);
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
  url.search = new URLSearchParams({ ...(view === 'players' ? { view } : {}), ...(styleOverride ? { style: styleOverride } : {}) }).toString();
  history.replaceState(null, '', url);
}

function setConnection(state: 'live' | 'connecting' | 'offline' | 'deleted'): void {
  ui.dot.dataset.state = state;
  ui.conn.textContent = { live: 'Live', connecting: 'Connecting…', offline: 'Offline, retrying', deleted: 'Map deleted' }[state];
}

function showActivity(): void {
  ui.activity.textContent = lastChange ? `${lastChange.text} · ${ago(Date.now() - lastChange.at)}` : 'Waiting for changes';
}
setInterval(showActivity, 5000);

// ---------- view animation ----------

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

// ---------- pan and zoom ----------

function toMap(clientX: number, clientY: number): [number, number] | null {
  const ctm = svg?.getScreenCTM();
  if (!svg || !ctm) return null;
  const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  return [p.x, p.y];
}

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
stage.addEventListener('dblclick', fit);
ui.fit.addEventListener('click', fit);
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement || !vb || !bounds) return;
  const centre: [number, number] = [(vb.x0 + vb.x1) / 2, (vb.y0 + vb.y1) / 2];
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

// ---------- controls ----------

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

// ---------- live connection ----------

async function resync(): Promise<void> {
  const res = await fetch(`/api/v1/maps/${encodeURIComponent(mapId)}`);
  if (!res.ok) return;
  const body = (await res.json()) as { rev: number; map: DelveMap };
  map = body.map;
  rev = body.rev;
}

let retry = 1000;
function connect(): void {
  setConnection('connecting');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/maps/${encodeURIComponent(mapId)}/live`);
  let gone = false;
  ws.onmessage = async (ev) => {
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
      case 'deleted':
        gone = true;
        setConnection('deleted');
        ws.close();
        break;
      default:
        break;
    }
  };
  ws.onclose = () => {
    if (gone) return;
    setConnection('offline');
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 15000);
  };
}

render();
showActivity();
connect();
