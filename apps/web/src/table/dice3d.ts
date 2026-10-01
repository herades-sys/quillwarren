// 3D dice on the table: a transparent three.js canvas over the board that takes
// no pointer events, so the Pixi board keeps working underneath. Each throw is
// simulated first (dice3d-sim.ts); then every die gets its labels laid out so
// the face that ends on top shows the server's value, and the recorded motion
// plays back. Dice rest ~2.5 s, then fade. Throws may overlap.
// Bundled on its own as /assets/table-dice.js (see ../table-dice.ts).
import {
  BufferGeometry,
  CanvasTexture,
  DirectionalLight,
  Float32BufferAttribute,
  HemisphereLight,
  Mesh,
  MeshPhongMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { cross, dieShape, dot, faceFrames, insetFace, labelsFor, labelText, normalize, shapeOf, underlined, type DieKind, type ShapeKind, type ThrowDie, type Vec3 } from './dice3d-logic.ts';
import { STEP, throwDice, type Arena, type Recording } from './dice3d-sim.ts';

export interface ThrowSpec {
  /** The same seed gives the same throw (the message id). */
  seed: string;
  dice: ThrowDie[];
  /** Dice left out of the throw: shown as "+N more dice". */
  more: number;
  /** The roller's member colour, for the dice bodies. */
  color: string;
}

/** The part of the stage the dice may use, in stage pixels (a phone's bottom sheet covers the rest). */
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiceTable {
  throw(spec: ThrowSpec): void;
  /** Take every die off the table now. */
  clear(): void;
}

/** Screen pixels per world unit on the floor: the dice keep their size, except on small views (min(w, h) / 11). */
const PX = 46;
const MIN_PX = 30;
const FOV = 30;
const HOLD = 2.5;
const FADE = 0.6;
/** Opacity of dropped dice once they have landed. */
const DIM = 0.38;
const CELL = 128;
/** Width of the rounded edges, as a share of the die's radius. */
const BEVEL = 0.075;
/** Label size as a share of a texture cell (a cell spans the die's largest face). */
const FONT: Record<DieKind, number> = { d4: 0.32, d6: 0.5, d8: 0.42, d10: 0.31, d12: 0.44, d20: 0.36, d100t: 0.26, d100u: 0.31, dF: 0.7 };
const LABEL_FONT = '"Marcellus SC", "IM FELL English", system-ui, sans-serif';

type V2 = [number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`index ${i} out of range`);
  return x;
}

// ---------- textures: one atlas per die, a cell per face plus a blank one for the edges ----------

function grid(faces: number): { cols: number; rows: number } {
  const cols = Math.ceil(Math.sqrt(faces + 1));
  return { cols, rows: Math.ceil((faces + 1) / cols) };
}

/** Where a point of face `fi` lands in the atlas, as (u, v) in 0..1 with v up. */
function atlasUv(kind: DieKind, fi: number, p: Vec3): V2 {
  const shape = dieShape(kind);
  const { frames, extent } = faceFrames(kind);
  const { cols, rows } = grid(shape.faces.length);
  const f = at(frames, fi);
  const d = sub(p, f.centroid);
  const u = 0.5 + dot(d, f.right) / (2 * extent);
  const v = 0.5 + dot(d, f.up) / (2 * extent);
  return [((fi % cols) + u) / cols, 1 - (Math.floor(fi / cols) + 1 - v) / rows];
}

function blankUv(kind: DieKind): V2 {
  const n = dieShape(kind).faces.length;
  const { cols, rows } = grid(n);
  return [((n % cols) + 0.5) / cols, 1 - (Math.floor(n / cols) + 0.5) / rows];
}

/** Black or white, whichever reads better on this colour. */
function inkFor(color: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m?.[1]) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // contrast against white vs against near-black
  return (1.05 / (lum + 0.05) >= (lum + 0.05) / 0.062 ? '#ffffff' : '#15181c');
}

function drawLabel(g: CanvasRenderingContext2D, text: string, x: number, y: number, angle: number, size: number): void {
  if (!text) return;
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.font = `${Math.round(size)}px ${LABEL_FONT}`;
  const m = g.measureText(text);
  const base = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  // a stroke in the ink colour thickens the thin serif digits, so they read at 50 px
  g.lineWidth = Math.max(1.5, size * 0.06);
  g.strokeText(text, 0, base);
  g.fillText(text, 0, base);
  if (underlined(text)) {
    const w = m.width * 0.9;
    g.fillRect(-w / 2, base + size * 0.1, w, Math.max(2, size * 0.075));
  }
  g.restore();
}

function drawAtlas(kind: DieKind, labels: readonly number[], body: string, ink: string): HTMLCanvasElement {
  const shape = dieShape(kind);
  const { frames } = faceFrames(kind);
  const { cols, rows } = grid(shape.faces.length);
  const canvas = document.createElement('canvas');
  canvas.width = cols * CELL;
  canvas.height = rows * CELL;
  const g = canvas.getContext('2d');
  if (!g) return canvas;
  g.fillStyle = body;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = ink;
  g.strokeStyle = ink;
  g.lineJoin = 'round';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const px = (fi: number, p: Vec3): V2 => {
    const [u, v] = atlasUv(kind, fi, p);
    return [u * canvas.width, (1 - v) * canvas.height];
  };
  const size = FONT[kind] * CELL;
  shape.faces.forEach((f, fi) => {
    const fr = at(frames, fi);
    if (shape.sites === 'faces') {
      const [x, y] = px(fi, fr.anchor);
      drawLabel(g, labelText(kind, at(labels, fi)), x, y, 0, size);
      return;
    }
    // d4: each corner's number sits near that corner, its top towards it
    const [cx, cy] = px(fi, fr.centroid);
    for (const vi of f) {
      const [x, y] = px(fi, at(shape.vertices, vi));
      drawLabel(g, labelText(kind, at(labels, vi)), lerp(cx, x, 0.47), lerp(cy, y, 0.47), Math.atan2(x - cx, -(y - cy)), size);
    }
  });
  return canvas;
}

// ---------- geometry: the hull with its edges and corners rounded off a little ----------

const geometries = new Map<ShapeKind, BufferGeometry>();

function geometryFor(kind: DieKind): BufferGeometry {
  const key = shapeOf(kind);
  const cached = geometries.get(key);
  if (cached) return cached;
  const shape = dieShape(kind);
  const radius = Math.max(...shape.vertices.map((v) => Math.hypot(...v)));
  const blank = blankUv(kind);
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const tri = (p: [Vec3, Vec3, Vec3], n: [Vec3, Vec3, Vec3], t: [V2, V2, V2]) => {
    const e = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    if (Math.hypot(...e) < 1e-9) return;
    const order = dot(e, addv(addv(p[0], p[1]), p[2])) < 0 ? [0, 2, 1] : [0, 1, 2];
    for (const i of order) {
      pos.push(...at(p, i));
      nor.push(...at(n, i));
      uvs.push(...at(t, i));
    }
  };
  // each face with its edges moved in; the gaps become the rounded edges and corners
  const inset = shape.faces.map((_f, fi) => insetFace(kind, fi, BEVEL * radius));
  shape.faces.forEach((_f, fi) => {
    const ps = at(inset, fi);
    const n = at(shape.normals, fi);
    const p0 = at(ps, 0);
    for (let k = 1; k < ps.length - 1; k++) {
      const p1 = at(ps, k);
      const p2 = at(ps, k + 1);
      tri([p0, p1, p2], [n, n, n], [atlasUv(kind, fi, p0), atlasUv(kind, fi, p1), atlasUv(kind, fi, p2)]);
    }
  });
  const edgeFace = new Map<string, number>();
  shape.faces.forEach((f, fi) => f.forEach((a, k) => edgeFace.set(`${a},${at(f, (k + 1) % f.length)}`, fi)));
  shape.faces.forEach((f, fi) =>
    f.forEach((a, k) => {
      const b = at(f, (k + 1) % f.length);
      const gi = edgeFace.get(`${b},${a}`);
      if (gi === undefined || gi < fi) return;
      const g = at(shape.faces, gi);
      const fa = at(at(inset, fi), k);
      const fb = at(at(inset, fi), (k + 1) % f.length);
      const ga = at(at(inset, gi), g.indexOf(a));
      const gb = at(at(inset, gi), g.indexOf(b));
      const nf = at(shape.normals, fi);
      const ng = at(shape.normals, gi);
      tri([fa, fb, gb], [nf, nf, ng], [blank, blank, blank]);
      tri([fa, gb, ga], [nf, ng, ng], [blank, blank, blank]);
    }),
  );
  shape.vertices.forEach((v, vi) => {
    const axis = normalize(v);
    const around = shape.faces.flatMap((f, fi) => {
      const k = f.indexOf(vi);
      return k < 0 ? [] : [{ p: at(at(inset, fi), k), n: at(shape.normals, fi) }];
    });
    const first = at(around, 0);
    const e1 = normalize(sub(first.p, scale(axis, dot(first.p, axis))));
    const e2 = cross(axis, e1);
    around.sort((x, y) => Math.atan2(dot(x.p, e2), dot(x.p, e1)) - Math.atan2(dot(y.p, e2), dot(y.p, e1)));
    for (let k = 1; k < around.length - 1; k++) {
      const a = at(around, 0);
      const b = at(around, k);
      const c = at(around, k + 1);
      tri([a.p, b.p, c.p], [a.n, b.n, c.n], [blank, blank, blank]);
    }
  });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.computeBoundingSphere();
  geometries.set(key, geo);
  return geo;
}

// ---------- the overlay ----------

interface Active {
  rec: Recording;
  meshes: Mesh[];
  mats: MeshPhongMaterial[];
  dropped: boolean[];
  start: number;
  /** Seconds until everything lies still. */
  duration: number;
}

let fontsReady: Promise<void> | null = null;
function waitForFonts(): Promise<void> {
  fontsReady ??= Promise.race([
    document.fonts.load(`64px ${LABEL_FONT}`).then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => setTimeout(resolve, 1500)),
  ]);
  return fontsReady;
}

/** Put the dice canvas into `stage`. Throws if WebGL isn't available. */
export function createDiceTable(stage: HTMLElement, area?: () => Area): DiceTable {
  const renderer = new WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  const canvas = renderer.domElement;
  canvas.className = 'dice-3d';
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '1' });
  stage.append(canvas);

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 0.5, 400);
  scene.add(new HemisphereLight(0xffffff, 0x6f6a60, 2.1));
  const sun = new DirectionalLight(0xffffff, 2.3);
  sun.position.set(-7, 30, -10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 5;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  const ground = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity: 0.3 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const active: Active[] = [];
  let raf = 0;
  let w = 1;
  let h = 1;
  let px = PX;
  function resize(): void {
    w = Math.max(1, stage.clientWidth);
    h = Math.max(1, stage.clientHeight);
    renderer.setSize(w, h, false);
    px = Math.max(MIN_PX, Math.min(PX, Math.min(w, h) / 11));
    const halfH = h / 2 / px;
    const dist = halfH / Math.tan(((FOV / 2) * Math.PI) / 180);
    camera.aspect = w / h;
    camera.position.set(0, dist, 0);
    camera.up.set(0, 0, -1); // the top of the screen is -z
    camera.lookAt(0, 0, 0);
    camera.near = Math.max(0.5, dist - 20);
    camera.far = dist + 20;
    camera.updateProjectionMatrix();
    const span = Math.max(w, h) / px;
    ground.scale.set(w / px + 4, h / px + 4, 1);
    const cam = sun.shadow.camera;
    cam.left = cam.bottom = -span * 0.7;
    cam.right = cam.top = span * 0.7;
    cam.near = 1;
    cam.far = 80;
    cam.updateProjectionMatrix();
    if (!raf) renderer.render(scene, camera);
  }
  new ResizeObserver(() => resize()).observe(stage);

  const q0 = new Quaternion();
  const q1 = new Quaternion();

  function place(a: Active, t: number): void {
    const { frames, steps } = a.rec;
    const f = Math.min(t / STEP, steps - 1);
    const i = Math.floor(f);
    const j = Math.min(i + 1, steps - 1);
    const k = f - i;
    const n = a.meshes.length;
    a.meshes.forEach((m, d) => {
      const o = (i * n + d) * 7;
      const p = (j * n + d) * 7;
      const F = (x: number) => frames[x] ?? 0;
      m.position.set(lerp(F(o), F(p), k), lerp(F(o + 1), F(p + 1), k), lerp(F(o + 2), F(p + 2), k));
      q0.set(F(o + 3), F(o + 4), F(o + 5), F(o + 6));
      q1.set(F(p + 3), F(p + 4), F(p + 5), F(p + 6));
      m.quaternion.slerpQuaternions(q0, q1, k);
    });
  }

  function remove(a: Active): void {
    for (const m of a.meshes) scene.remove(m);
    for (const mat of a.mats) {
      mat.map?.dispose();
      mat.dispose();
    }
    active.splice(active.indexOf(a), 1);
  }

  function tick(now: number): void {
    raf = 0;
    for (const a of [...active]) {
      const t = (now - a.start) / 1000;
      place(a, Math.min(t, a.duration));
      const rest = t - a.duration;
      const fade = rest > HOLD ? Math.min(1, (rest - HOLD) / FADE) : 0;
      a.mats.forEach((mat, d) => {
        const dim = a.dropped[d] && rest > 0 ? 1 - (1 - DIM) * Math.min(1, rest / 0.4) : 1;
        mat.opacity = dim * (1 - fade);
        const mesh = a.meshes[d];
        if (mesh) mesh.castShadow = mat.opacity > 0.3;
      });
      if (fade >= 1) remove(a);
    }
    renderer.render(scene, camera);
    if (active.length) raf = requestAnimationFrame(tick);
  }

  function arenaFor(): Arena {
    const box = area?.() ?? { x: 0, y: 0, w, h };
    const m = 0.3;
    let x0 = (box.x - w / 2) / px + m;
    let x1 = (box.x + box.w - w / 2) / px - m;
    let z0 = (box.y - h / 2) / px + m;
    let z1 = (box.y + box.h - h / 2) / px - m;
    // a tiny view still needs room for the dice to land
    const grow = (a: number, b: number, min: number): [number, number] => (b - a >= min ? [a, b] : [(a + b) / 2 - min / 2, (a + b) / 2 + min / 2]);
    [x0, x1] = grow(x0, x1, 7);
    [z0, z1] = grow(z0, z1, 6);
    return { x0, x1, z0, z1 };
  }

  function showMore(n: number): void {
    const box = area?.() ?? { x: 0, y: 0, w, h };
    const note = document.createElement('div');
    note.className = 'dice-more';
    note.textContent = `+${n} more ${n === 1 ? 'die' : 'dice'}`;
    Object.assign(note.style, {
      position: 'absolute',
      left: `${box.x + box.w / 2}px`,
      top: `${box.y + box.h * 0.82}px`,
      transform: 'translate(-50%, -50%)',
      padding: '4px 11px',
      borderRadius: '999px',
      border: '1px solid var(--line)',
      background: 'color-mix(in srgb, var(--bar) 90%, transparent)',
      color: 'var(--ink)',
      font: '600 13px system-ui, sans-serif',
      pointerEvents: 'none',
      zIndex: '1',
      transition: 'opacity .5s',
    });
    stage.append(note);
    setTimeout(() => {
      note.style.opacity = '0';
      setTimeout(() => note.remove(), 600);
    }, 2600);
  }

  async function start(spec: ThrowSpec): Promise<void> {
    if (!spec.dice.length) return;
    await waitForFonts();
    const rec = throwDice(
      spec.dice.map((d) => d.kind),
      spec.seed,
      arenaFor(),
    );
    const ink = inkFor(spec.color);
    const n = spec.dice.length;
    const last = (rec.steps - 1) * n * 7;
    const meshes: Mesh[] = [];
    const mats: MeshPhongMaterial[] = [];
    spec.dice.forEach((die, i) => {
      const q: [number, number, number, number] = [rec.frames[last + i * 7 + 3] ?? 0, rec.frames[last + i * 7 + 4] ?? 0, rec.frames[last + i * 7 + 5] ?? 0, rec.frames[last + i * 7 + 6] ?? 1];
      // the face that ends on top gets the rolled value
      const labels = labelsFor(die.kind, q, die.value);
      const tex = new CanvasTexture(drawAtlas(die.kind, labels, spec.color, ink));
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      const mat = new MeshPhongMaterial({ map: tex, shininess: 60, specular: 0x2a2a2a, transparent: true });
      const mesh = new Mesh(geometryFor(die.kind), mat);
      mesh.castShadow = true;
      mesh.scale.setScalar(rec.scale);
      scene.add(mesh);
      meshes.push(mesh);
      mats.push(mat);
    });
    const a: Active = { rec, meshes, mats, dropped: spec.dice.map((d) => d.dropped), start: performance.now(), duration: (rec.steps - 1) * STEP };
    place(a, 0);
    active.push(a);
    if (spec.more > 0) showMore(spec.more);
    if (!raf) raf = requestAnimationFrame(tick);
  }

  resize();
  return {
    throw(spec) {
      start(spec).catch((e: unknown) => console.warn('3D dice:', e));
    },
    clear() {
      for (const a of [...active]) remove(a);
      for (const note of stage.querySelectorAll('.dice-more')) note.remove();
      renderer.render(scene, camera);
    },
  };
}
