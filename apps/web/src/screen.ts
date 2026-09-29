// The players' screen (/maps/:id/screen): the players' view with fog of war,
// full screen, following every change live, for a TV at the table or a
// Discord screen share. It frames what has been revealed and glides to new
// reveals; when the GM (or Claude) points at something, it pans there.
import { applyOps, buildScene, resolveStyle, revealedBounds, sceneToSvg, type Bounds, type DelveMap, type Op } from '@delve/core';
import { artLoader } from './art.ts';
import { easeInOut, lerpBounds, objectBounds, pad, unionBounds } from './logic.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const initial = JSON.parse($('delve-initial').textContent ?? '{}') as { id: string; rev: number; map: DelveMap };
const mapId = initial.id;
let map = initial.map;
let rev = initial.rev;
const canvas = $('canvas');
const note = $('note');

let svg: SVGSVGElement | null = null;
let vb: Bounds | null = null;
let anim = 0;

const art = artLoader(() => render());

/** What the players should be looking at: the revealed part, or the whole map without fog. */
function frame(sceneBounds: Bounds): Bounds {
  if (!map.fog?.on) return sceneBounds;
  const r = revealedBounds(map);
  return r ? pad(r, 2) : sceneBounds;
}

/** Keep the frame's aspect ratio sensible for a wide screen: never zoom in closer than 12 squares across. */
function roomy(b: Bounds): Bounds {
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const min = 12;
  const gx = Math.max(0, min - w) / 2;
  const gy = Math.max(0, (min * 0.6 - h) / 2);
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

let lastFrame = '';
function render(): void {
  art.ensure(map);
  const scene = buildScene(map, { view: 'players', fog: 'hide', assets: art.body });
  document.body.style.background = resolveStyle(map).background;
  canvas.innerHTML = sceneToSvg(scene, { ppg: 20 });
  svg = canvas.querySelector('svg');
  if (!svg) return;
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  note.hidden = !(map.fog?.on && !revealedBounds(map));
  const target = roomy(frame(scene.bounds));
  const key = JSON.stringify(target);
  if (vb) apply(vb);
  if (key !== lastFrame) {
    lastFrame = key;
    glide(target, vb ? 900 : 0);
  }
}

async function resync(): Promise<void> {
  const res = await fetch(`/api/v1/maps/${encodeURIComponent(mapId)}`);
  if (!res.ok) return;
  const body = (await res.json()) as { rev: number; map: DelveMap };
  map = body.map;
  rev = body.rev;
}

function connect(): void {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/maps/${encodeURIComponent(mapId)}/live`);
  socket.onmessage = async (ev) => {
    const msg = JSON.parse(String(ev.data)) as { type: string; rev?: number; map?: DelveMap; ops?: Op[]; ids?: string[] };
    if (msg.type === 'hello' && msg.map && msg.rev !== rev) {
      map = msg.map;
      rev = msg.rev!;
      render();
    } else if (msg.type === 'ops' && msg.rev !== undefined && msg.rev > rev) {
      try {
        if (msg.rev !== rev + 1) throw new Error('missed a change');
        map = applyOps(map, msg.ops ?? []).map;
        rev = msg.rev;
      } catch {
        await resync();
      }
      render();
    } else if (msg.type === 'focus' && msg.ids) {
      // only pan to things the players can already see
      const b = unionBounds(msg.ids.filter((id) => !map.fog?.on || map.fog.revealed?.includes(id)).map((id) => {
        const o = map.objects.find((x) => x.id === id);
        return o ? objectBounds(o, map) : null;
      }));
      if (b) glide(roomy(pad(b, 3)));
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

render();
connect();
