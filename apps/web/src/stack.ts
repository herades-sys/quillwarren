// The 3D view: every storey of a place stacked like a cutaway model. Each
// floor is the storey's own map (the server's PNG, transparent around the
// drawing) on a stone slab; walls stand up from the same wall lines the 2D map
// draws; stairs that line up on neighbouring storeys get a shaft between them,
// and stairs that meet nothing are flagged. Changes stream in live.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyOps, buildScene, computeFloor, computeWalls, doorSegment, revealedBounds, stairLinks, visibleFloor, visiblePolygons, type Bounds, type Connector, type DelveMap, type Door, type Op, type StairPlan } from '@delve/core';
import { clipSegments, insidePolygons, intersect, startView, storeyHeights, texturePpg, unionOf, wallBox } from './stack-logic.ts';
import { hasHeights, heightPlan, heightScene, polygonsOf, stairsUphill, type HeightScene, type Polygon } from '@delve/core';
import { heightMeshes, type FaceKind } from './heights3d.ts';
import { wallBase } from './heights3d-logic.ts';

interface Storey {
  id: string;
  name: string;
  level?: { group: string; name: string; order: number };
}
interface Loaded {
  storey: Storey;
  map: DelveMap;
  rev: number;
  group: THREE.Group;
  bounds: Bounds;
  /** What the camera frames: the whole storey, or in the players' view with fog, what they've seen (null: nothing). */
  fit: Bounds | null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const initial = JSON.parse($('delve-initial').textContent ?? '{}') as { id: string; name: string; storeys: Storey[] };
const storeys: Storey[] = initial.storeys.length ? initial.storeys : [{ id: initial.id, name: initial.name }]; // top first
const groupKey = storeys[0]?.level?.group ?? initial.id;
const orderOf = (s: Storey) => s.level?.order ?? 0;
const storeyName = (id: string) => {
  const s = storeys.find((x) => x.id === id);
  return s ? (s.level?.name ?? s.name) : id;
};
let view: 'gm' | 'players' = new URLSearchParams(location.search).get('view') === 'players' ? 'players' : 'gm';

const saved = {
  get<T>(k: string): T | null {
    try {
      const v = localStorage.getItem(k);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  },
  set(k: string, v: unknown): void {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* the view still works, it just forgets */
    }
  },
};
let spread = saved.get<number>('delve-3d-spread') ?? 12;
let wallHeight = saved.get<number>('delve-3d-walls') ?? 0.9;
const hidden = new Set<string>(saved.get<string[]>(`delve-3d-hidden:${groupKey}`) ?? []);

// ---------- three.js ----------

const stage = $('stage');
const status = $('status');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x20242b);
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.screenSpacePanning = true;
controls.maxPolarAngle = Math.PI * 0.49;
scene.add(new THREE.HemisphereLight(0xf4efe6, 0x2a2622, 1.7));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(-40, 90, 60);
scene.add(sun);

const loader = new THREE.TextureLoader();
const maxAniso = renderer.capabilities.getMaxAnisotropy();
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const slabMat = new THREE.MeshStandardMaterial({ color: 0x8b8276, roughness: 0.95 });
const wallMat = new THREE.MeshStandardMaterial({ color: 0x4d463d, roughness: 0.85 });
const linkMat = new THREE.MeshBasicMaterial({ color: 0xf0b429, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
const linkLine = new THREE.LineBasicMaterial({ color: 0xf0b429 });
const looseMat = new THREE.MeshBasicMaterial({ color: 0xe5484d, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
const looseLine = new THREE.LineBasicMaterial({ color: 0xe5484d });
const shared = new Set<unknown>([unitBox, slabMat, wallMat, linkMat, linkLine, looseMat, looseLine]);

const loaded = new Map<string, Loaded>();
const linkGroup = new THREE.Group();
scene.add(linkGroup);

function dispose(g: THREE.Object3D): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !shared.has(m.geometry)) m.geometry.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) {
      if (shared.has(mat)) continue;
      (mat as THREE.MeshBasicMaterial).map?.dispose();
      mat.dispose();
    }
  });
  g.clear();
}

function textSprite(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = '44px "IM FELL English", Georgia, serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 40;
  c.width = w;
  c.height = 72;
  ctx.fillStyle = 'rgba(25, 30, 36, 0.85)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 72, 14);
  ctx.fill();
  ctx.font = font;
  ctx.fillStyle = '#F4EFE6';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 20, 38);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set((w / 72) * 1.5, 1.5, 1);
  sprite.center.set(1, 0.5);
  sprite.renderOrder = 10;
  return sprite;
}

const heights = () => storeyHeights(storeys.map((s) => ({ id: s.id, order: orderOf(s) })), spread);

/** One storey: slab, floor picture, walls and its name, at its height. */
function build(l: Loaded): void {
  dispose(l.group);
  const map = l.map;
  // Players' view with fog of war: only what's been revealed exists at all.
  const fogged = view === 'players' && Boolean(map.fog?.on);
  const fullFloor = computeFloor(map);
  const floor = fogged ? visibleFloor(map) : fullFloor;
  // Height areas (core heightScene): the floor picture cut into plates at their heights, faces between them
  const hs = hasHeights(map, view) ? heightScene(map, { view, frame: buildScene(map, { view, ...(view === 'players' ? { fog: 'hide' as const } : {}) }).bounds, ...(fogged ? { region: visiblePolygons(map) } : {}) }) : null;
  const slabFloor = hs ? floorOutsidePits(floor, hs) : floor;
  if (slabFloor.length) {
    const shapes = slabFloor.map((p) => {
      const s = new THREE.Shape(p.outer.map(([x, y]) => new THREE.Vector2(x, y)));
      for (const h of p.holes) s.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
      return s;
    });
    const geo = new THREE.ExtrudeGeometry(shapes, { depth: 0.4, bevelEnabled: false });
    geo.rotateX(Math.PI / 2); // shape y becomes world z; the slab hangs below the floor
    const slab = new THREE.Mesh(geo, slabMat);
    slab.userData.storey = l.storey.id;
    l.group.add(slab);
  }

  // The floor picture covers the same bounds as the server's PNG (same scene code).
  const b = buildScene(map, { view, ...(view === 'players' ? { fog: 'hide' as const } : {}) }).bounds;
  l.bounds = b;
  l.fit = fogged ? revealedBounds(map) : b;
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const url = `/api/v1/maps/${encodeURIComponent(l.storey.id)}/render.png?view=${view}&ppg=${texturePpg(b)}&background=0&fog=1&rev=${l.rev}`;
  const tex = loader.load(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  const floorMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  if (hs) {
    for (const mesh of heightMeshes(hs, { box: b, floor: floorMat, faces: faceMats, lift: 0.02 })) {
      mesh.userData.storey = l.storey.id;
      if (mesh.userData.plate) mesh.renderOrder = 1;
      l.group.add(mesh);
    }
    for (const slab of pitSlabs(hs)) {
      slab.userData.storey = l.storey.id;
      l.group.add(slab);
    }
  }
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h).rotateX(-Math.PI / 2), floorMat);
  plane.position.set(b.x0 + w / 2, 0.02, b.y0 + h / 2);
  plane.userData.storey = l.storey.id;
  plane.renderOrder = 1;
  if (!hs) l.group.add(plane);
  else plane.geometry.dispose(); // the plates stand in for it

  // Walls: the floor's edge minus door gaps; for players, secret doors stay shut.
  let segs = computeWalls(map, fullFloor);
  if (view === 'players') segs = segs.concat(map.objects.filter((o): o is Door => o.type === 'door' && o.style === 'secret').map(doorSegment));
  if (fogged) segs = clipSegments(segs, visiblePolygons(map));
  if (wallHeight > 0 && segs.length) {
    const t = 0.16;
    const walls = new THREE.InstancedMesh(unitBox, wallMat, segs.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    segs.forEach((seg, i) => {
      const wb = wallBox(seg, t);
      q.setFromAxisAngle(up, wb.angle);
      m.compose(new THREE.Vector3(wb.x, wallBase(hs, seg[0], seg[1]) + wallHeight / 2, wb.z), q, new THREE.Vector3(wb.length, wallHeight, t));
      walls.setMatrixAt(i, m);
    });
    l.group.add(walls);
  }

  // A storey the players haven't found yet gets no name tag either.
  if (!fogged || floor.length) {
    const label = textSprite(storeyName(l.storey.id));
    label.position.set(b.x0 - 0.5, 0.8, (b.y0 + b.y1) / 2);
    l.group.add(label);
  }
  l.group.position.y = heights().get(l.storey.id) ?? 0;
  l.group.visible = !hidden.has(l.storey.id);
}

// ---------- heights ----------

const faceMats: Record<FaceKind, THREE.Material> = {
  cliff: new THREE.MeshStandardMaterial({ color: 0x7a7166, roughness: 0.95, side: THREE.DoubleSide }),
  step: new THREE.MeshStandardMaterial({ color: 0x7a7166, roughness: 0.95, side: THREE.DoubleSide }),
  rock: new THREE.MeshStandardMaterial({ color: 0x5c5751, roughness: 1, side: THREE.DoubleSide }),
  slope: new THREE.MeshStandardMaterial({ color: 0x968c7d, roughness: 1, side: THREE.DoubleSide }),
};
for (const m of Object.values(faceMats)) shared.add(m);

/** The floor's slab without the sunken parts (they get their own slab, further down). */
function floorOutsidePits(floor: Polygon[], hs: HeightScene): Polygon[] {
  const pits = hs.bands.filter((b) => b.h < 0).flatMap((b) => b.polygons.flatMap((p) => [p.outer, ...p.holes]));
  if (!pits.length) return floor;
  const path = (r: readonly (readonly [number, number])[]) => r.map(([x, y]) => ({ x, y }));
  return polygonsOf(floor.flatMap((p) => [p.outer, ...p.holes]).map(path), pits.map(path));
}

/** A slab under each sunken part, hanging below its floor like the storey's. */
function pitSlabs(hs: HeightScene): THREE.Mesh[] {
  return hs.bands
    .filter((b) => b.h < 0)
    .map((b) => {
      const shapes = b.polygons.map((p) => {
        const s = new THREE.Shape(p.outer.map(([x, y]) => new THREE.Vector2(x, y)));
        for (const h of p.holes) s.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
        return s;
      });
      const geo = new THREE.ExtrudeGeometry(shapes, { depth: 0.4, bevelEnabled: false });
      geo.rotateX(Math.PI / 2);
      const slab = new THREE.Mesh(geo, slabMat);
      slab.position.y = b.h;
      return slab;
    });
}

const KIND: Record<Connector['kind'], string> = { stairs: 'Stairs', spiral: 'Spiral stair', ladder: 'Ladder', trapdoor: 'Trapdoor' };

/** Shafts between stairs that line up, red markers on stairs that meet nothing, and the list in the panel. */
function buildLinks(): void {
  dispose(linkGroup);
  const list = [...loaded.values()];
  const plan = stairLinks(list.map((l) => ({ id: l.storey.id, order: orderOf(l.storey), map: l.map })));
  // stairs between two heights of one map (height areas: up a ledge, down into a pit) lead nowhere else: not loose
  const plans = new Map(list.filter((l) => hasHeights(l.map)).map((l) => [l.storey.id, heightPlan(l.map)]));
  plan.loose = plan.loose.filter((c) => !(c.kind === 'stairs' && plans.has(c.storey) && stairsUphill(plans.get(c.storey)!, c.bounds)));
  const ys = heights();
  // Players with fog: only stairs they've seen on both storeys, and no red rings (those are for the GM).
  const seen = new Map(list.map((l) => [l.storey.id, view === 'players' && l.map.fog?.on ? visiblePolygons(l.map) : null]));
  const visible = (c: Connector) => {
    const polys = seen.get(c.storey);
    return !polys || insidePolygons(polys, [(c.bounds.x0 + c.bounds.x1) / 2, (c.bounds.y0 + c.bounds.y1) / 2]);
  };
  if (view === 'players') {
    plan.links = plan.links.filter((k) => visible(k.lower) && visible(k.upper));
    plan.loose = [];
  }
  for (const { lower, upper } of plan.links) {
    if (hidden.has(lower.storey) || hidden.has(upper.storey)) continue;
    const box = intersect(lower.bounds, upper.bounds) ?? lower.bounds;
    const y0 = ys.get(lower.storey) ?? 0;
    const tall = (ys.get(upper.storey) ?? 0) - y0;
    const w = box.x1 - box.x0;
    const d = box.y1 - box.y0;
    const geo = lower.kind === 'spiral' || upper.kind === 'spiral' ? new THREE.CylinderGeometry(Math.min(w, d) / 2, Math.min(w, d) / 2, tall, 40, 1, true) : new THREE.BoxGeometry(w, tall, d);
    const pos = new THREE.Vector3((box.x0 + box.x1) / 2, y0 + tall / 2, (box.y0 + box.y1) / 2);
    const shaft = new THREE.Mesh(geo, linkMat);
    shaft.position.copy(pos);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), linkLine);
    edges.position.copy(pos);
    linkGroup.add(shaft, edges);
  }
  for (const c of plan.loose) {
    if (hidden.has(c.storey)) continue;
    const b = c.bounds;
    const r = Math.max(b.x1 - b.x0, b.y1 - b.y0) / 2 + 0.2;
    const tall = Math.max(1.5, spread * 0.35);
    const geo = new THREE.CylinderGeometry(r, r, tall, 32, 1, true);
    const pos = new THREE.Vector3((b.x0 + b.x1) / 2, (ys.get(c.storey) ?? 0) + tall / 2, (b.y0 + b.y1) / 2);
    const marker = new THREE.Mesh(geo, looseMat);
    marker.position.copy(pos);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), looseLine);
    edges.position.copy(pos);
    linkGroup.add(marker, edges);
  }
  stairsPanel(plan);
}

// ---------- panel ----------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

function stairsPanel(plan: StairPlan): void {
  const box = $('stairs');
  const what = (c: Connector) => `${c.name ?? KIND[c.kind]} (${c.id})`;
  const items: HTMLElement[] = [];
  for (const { lower, upper } of plan.links) {
    items.push(el('li', { class: 'ok' }, `${storeyName(lower.storey)} ↔ ${storeyName(upper.storey)}: ${what(lower)} meets ${what(upper)}`));
  }
  for (const c of plan.loose) items.push(el('li', { class: 'bad' }, `${storeyName(c.storey)}: ${what(c)} lines up with nothing on the storey above or below`));
  box.replaceChildren(
    items.length
      ? el('ul', {}, ...items)
      : el('p', { class: 'hint' }, view === 'players' ? 'No stairs between storeys found yet.' : 'No stairs, ladders or spiral stairs yet. Put them at the same spot on two storeys and they connect here.'),
    ...(plan.loose.length ? [el('p', { class: 'hint' }, 'Red rings mark stairs without a partner: move them, or add the matching stairs on the next storey.')] : []),
  );
}

function storeysPanel(): void {
  $('storeys').replaceChildren(
    ...storeys.map((s) => {
      const box = el('input', { type: 'checkbox' });
      box.checked = !hidden.has(s.id);
      box.addEventListener('change', () => {
        if (box.checked) hidden.delete(s.id);
        else hidden.add(s.id);
        saved.set(`delve-3d-hidden:${groupKey}`, [...hidden]);
        const l = loaded.get(s.id);
        if (l) l.group.visible = box.checked;
        buildLinks();
      });
      return el('div', { class: 'storey' }, el('label', {}, box, storeyName(s.id)), el('a', { href: `/maps/${encodeURIComponent(s.id)}?edit=1`, title: 'Edit this storey' }, 'edit'));
    }),
  );
}

// ---------- camera, picking, snapshot ----------

function fit(): void {
  const fits = [...loaded.values()].filter((l) => !hidden.has(l.storey.id)).map((l) => l.fit).filter((x): x is Bounds => x !== null);
  const b = unionOf(fits.length ? fits : [...loaded.values()].map((l) => l.bounds));
  if (!b) return;
  const top = Math.max(0, ...heights().values());
  const v = startView(b, top);
  camera.position.set(...v.position);
  controls.target.set(...v.target);
  controls.update();
}

function resize(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

const ray = new THREE.Raycaster();
renderer.domElement.addEventListener('dblclick', (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const targets = [...loaded.values()].filter((l) => l.group.visible).flatMap((l) => l.group.children.filter((c) => c.userData.storey));
  const hit = ray.intersectObjects(targets, false)[0];
  const id = hit?.object.userData.storey as string | undefined;
  if (id) location.href = `/maps/${encodeURIComponent(id)}?edit=1`;
});

$('snapshot').addEventListener('click', () => {
  renderer.render(scene, camera);
  renderer.domElement.toBlob((blob) => {
    if (!blob) return;
    const a = el('a', { href: URL.createObjectURL(blob), download: `${initial.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map'}_3d.png` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
});
$('fit3d').addEventListener('click', fit);
window.addEventListener('keydown', (e) => {
  if (e.key === 'f' && !(e.target as HTMLElement).closest('input')) fit();
});

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
  b.addEventListener('click', () => {
    view = b.dataset.view === 'players' ? 'players' : 'gm';
    document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String((x as HTMLElement).dataset.view === view)));
    const url = new URL(location.href);
    if (view === 'players') url.searchParams.set('view', 'players');
    else url.searchParams.delete('view');
    history.replaceState(null, '', url);
    for (const l of loaded.values()) build(l);
    buildLinks();
    fit(); // the players may see much less than the GM
  });
}

const spreadInput = $<HTMLInputElement>('spread');
spreadInput.value = String(spread);
spreadInput.addEventListener('input', () => {
  spread = Number(spreadInput.value);
  saved.set('delve-3d-spread', spread);
  const ys = heights();
  for (const l of loaded.values()) l.group.position.y = ys.get(l.storey.id) ?? 0;
  buildLinks();
});
const wallInput = $<HTMLInputElement>('walls');
wallInput.value = String(wallHeight);
let wallTimer: number | undefined;
wallInput.addEventListener('input', () => {
  wallHeight = Number(wallInput.value);
  saved.set('delve-3d-walls', wallHeight);
  clearTimeout(wallTimer);
  wallTimer = window.setTimeout(() => loaded.forEach(build), 120);
});

// ---------- loading and live changes ----------

async function fetchStorey(s: Storey): Promise<{ rev: number; map: DelveMap } | null> {
  const res = await fetch(`/api/v1/maps/${encodeURIComponent(s.id)}`);
  return res.ok ? ((await res.json()) as { rev: number; map: DelveMap }) : null;
}

const rebuildTimers = new Map<string, number>();
function rebuildSoon(id: string): void {
  clearTimeout(rebuildTimers.get(id));
  rebuildTimers.set(
    id,
    window.setTimeout(() => {
      const l = loaded.get(id);
      if (!l) return;
      build(l);
      buildLinks();
    }, 500),
  );
}

function follow(s: Storey): void {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/maps/${encodeURIComponent(s.id)}/live`);
  socket.onmessage = async (ev) => {
    const msg = JSON.parse(String(ev.data)) as { type: string; rev?: number; ops?: Op[] };
    const l = loaded.get(s.id);
    if (!l) return;
    if (msg.type === 'levels' || msg.type === 'deleted') return location.reload();
    if (msg.type !== 'ops' || msg.rev === undefined || msg.rev <= l.rev) return;
    try {
      if (msg.rev !== l.rev + 1) throw new Error('missed a change');
      l.map = applyOps(l.map, msg.ops ?? []).map;
      l.rev = msg.rev;
    } catch {
      const fresh = await fetchStorey(s);
      if (!fresh) return;
      l.map = fresh.map;
      l.rev = fresh.rev;
    }
    rebuildSoon(s.id);
  };
  socket.onclose = () => setTimeout(() => follow(s), 3000);
}

async function start(): Promise<void> {
  storeysPanel();
  await document.fonts.load('44px "IM FELL English"').catch(() => []);
  const results = await Promise.all(storeys.map(async (s) => ({ s, data: await fetchStorey(s) })));
  for (const { s, data } of results) {
    if (!data) continue;
    const l: Loaded = { storey: s, map: data.map, rev: data.rev, group: new THREE.Group(), bounds: { x0: 0, y0: 0, x1: 10, y1: 10 }, fit: null };
    loaded.set(s.id, l);
    scene.add(l.group);
    build(l);
    follow(s);
  }
  buildLinks();
  resize();
  fit();
  status.hidden = true;
}

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
void start().catch((e: Error) => {
  status.textContent = `Couldn't load the storeys: ${e.message}`;
});
