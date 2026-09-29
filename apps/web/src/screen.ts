// The players' screen (/maps/:id/screen): the players' view with fog of war,
// full screen, for a TV at the table or a Discord screen share. It never gets
// the map itself: the server sends a picture built only from what the players
// have seen, the live socket (?screen=1) only says that it changed and where
// to look, and the view frames what has been revealed and glides to new reveals.
import type { Bounds } from '@delve/core';
import { easeInOut, lerpBounds } from './logic.ts';

interface Payload {
  rev: number;
  name: string;
  background: string;
  frame: Bounds | null;
  hidden: boolean;
  svg: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const initial = JSON.parse($('delve-initial').textContent ?? '{}') as Omit<Payload, 'svg'> & { id: string };
const mapId = initial.id;
let rev = initial.rev;
const canvas = $('canvas');
const note = $('note');

let svg: SVGSVGElement | null = null;
let vb: Bounds | null = null;
let anim = 0;
let lastFrame = '';

/** Never zoom in closer than 12 squares across, so one small room doesn't fill a TV. */
function roomy(b: Bounds): Bounds {
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const gx = Math.max(0, 12 - w) / 2;
  const gy = Math.max(0, 7.2 - h) / 2;
  return { x0: b.x0 - gx, y0: b.y0 - gy, x1: b.x1 + gx, y1: b.y1 + gy };
}

function apply(box: Bounds): void {
  vb = box;
  svg?.setAttribute('viewBox', `${box.x0} ${box.y0} ${box.x1 - box.x0} ${box.y1 - box.y0}`);
}

function glide(to: Bounds, ms = 900): void {
  if (!vb) return apply(to);
  const from = { ...vb };
  const start = performance.now();
  cancelAnimationFrame(anim);
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    apply(lerpBounds(from, to, easeInOut(t)));
    if (t < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

/** Show a picture (the first one is already in the page) and frame it. */
function show(p: Omit<Payload, 'svg'>, markup?: string): void {
  if (markup !== undefined) canvas.innerHTML = markup;
  svg = canvas.querySelector('svg');
  if (!svg) return;
  document.body.style.background = p.background;
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  note.hidden = !p.hidden;
  if (vb) apply(vb);
  const target = p.frame ? roomy(p.frame) : null;
  const key = JSON.stringify(target);
  if (target && key !== lastFrame) {
    lastFrame = key;
    glide(target, vb ? 900 : 0);
  }
}

let fetching = false;
let again = false;
async function refresh(): Promise<void> {
  if (fetching) {
    again = true;
    return;
  }
  fetching = true;
  try {
    const res = await fetch(`/api/v1/maps/${encodeURIComponent(mapId)}/screen`, { cache: 'no-store' });
    if (res.ok) {
      const p = (await res.json()) as Payload;
      rev = p.rev;
      show(p, p.svg);
    }
  } finally {
    fetching = false;
    if (again) {
      again = false;
      void refresh();
    }
  }
}

function connect(): void {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/maps/${encodeURIComponent(mapId)}/live?screen=1`);
  socket.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { type: string; rev?: number; bounds?: Bounds };
    if ((msg.type === 'hello' || msg.type === 'changed') && msg.rev !== undefined && msg.rev !== rev) void refresh();
    else if (msg.type === 'look' && msg.bounds) {
      const b = msg.bounds;
      glide(roomy({ x0: b.x0 - 3, y0: b.y0 - 3, x1: b.x1 + 3, y1: b.y1 + 3 }));
    } else if (msg.type === 'deleted') {
      note.textContent = 'This map was deleted.';
      note.hidden = false;
    }
  };
  socket.onclose = () => setTimeout(connect, 3000);
}

const full = $<HTMLButtonElement>('full');
const toggleFull = () => (document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen().catch(() => {}));
full.addEventListener('click', toggleFull);
window.addEventListener('keydown', (e) => {
  if (e.key === 'f') toggleFull();
});

show(initial);
connect();
