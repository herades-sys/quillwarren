// The 3D table view's scene (three.js): the page as a board on the table with
// its floor picture, walls and doors standing on the drawn ones, steps for
// stairs, the tokens as minis, pings, soft light with shadows, and the camera
// (orbit, pan, zoom; top-down, fit, follow). Dragging a mini moves it over the
// floor, snapped like the 2D board; the app sends the same move intents. On a
// map with heights the floor picture is draped over hills, ramps and plateaus
// (heights3d.ts), and minis, picking, pings, grid lines and overlays follow it.
//
// For the later steps: `lights` takes point lights per token or map light
// (setSources), `overlays` is the layer for darkness or explored areas, and the
// scene data (Scene3D.region) says what the viewer may see.
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Path,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Raycaster,
  RingGeometry,
  Scene,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
  type Texture,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Member, Page, Scene3D, ScenePolygon, Token } from '@delve/table';
import { canMove, dragTargets, type DragStart } from './logic.ts';
import { createMinis } from './minis3d.ts';
import {
  doorPieces,
  fitView,
  followStep,
  gridSegments,
  groundHit,
  lerpView,
  pickLights,
  shadowSpan,
  stairSteps,
  tokenCentre,
  topView,
  type LightSource,
  type Piece,
  wallPiece,
  type Vec3,
  type View3,
} from './scene3d-logic.ts';
import { makeTexture, TextureCache } from './textures3d.ts';
import { drapedGeometry, heightMeshes, pieceBoxes } from '../heights3d.ts';
import { drapeLine, stairRise, stairsUp, surfaceAt, surfaceHit, surfaceRange, wallBase } from '../heights3d-logic.ts';

export interface View3dHost {
  me(): Member;
  members(): Member[];
  /** The tokens to show, optimistic moves included. */
  tokens(): Token[];
  selection(): ReadonlySet<string>;
  setSelection(ids: string[]): void;
  /** A drag ended: send these moves. */
  move(moves: { id: string; x: number; y: number }[]): void;
  /** The pointer was held still on the floor: ping there (cells). */
  ping(x: number, y: number): void;
  /** Follow stopped by itself (its mini went away). */
  followEnded?(): void;
}

export interface LightRig {
  /** Point lights per token or map light source (step 2). At most MAX_LIGHTS, nearest to the view first. */
  setSources(sources: readonly LightSource[]): void;
  /** Scale the ambient and sun light, 0 (dark) to 1 (the default), e.g. for a dark dungeon lit only by torches. */
  setAmbient(level: number): void;
}

export interface Overlays {
  /** Put an object into the overlay layer (just over the floor, under the minis) by name, replacing the old one; null removes it. */
  set(name: string, obj: Object3D | null): void;
  /** A flat mesh on the floor from polygons in cells: darkness, explored areas, a spell's area. */
  polygons(polys: readonly ScenePolygon[], color: string, opacity: number): Mesh;
}

export interface View3d {
  /** Show a page's scene; `bust` reloads the floor picture (the map changed). Null: nothing to show. */
  setScene(scene: Scene3D | null, page: Page | null, bust: number): void;
  /** Redraw after tokens, selection or members changed. */
  update(): void;
  showPing(x: number, y: number, color: string): void;
  fit(): void;
  top(): void;
  /** Keep a mini in the middle of the view (null stops). */
  follow(id: string | null): void;
  following(): string | null;
  /** Point the camera at a mini. */
  focusToken(id: string): void;
  /** Point the camera at a spot on the floor (cells). */
  focusPoint(x: number, y: number): void;
  /** A click (no drag, no mini under it) on the floor at x, y (cells). */
  onFloorClick(cb: (x: number, y: number) => void): void;
  /** Where a spot on the floor (at the ground there, unless a height is given) is in the stage's pixels now, or null (behind the camera). */
  project(x: number, y: number, height?: number): [number, number] | null;
  /** After every frame drawn (the camera may have moved): place your own HTML over the view. */
  onFrame(cb: () => void): void;
  setFlat(flat: boolean): void;
  setWallHeight(h: number): void;
  setShadows(on: boolean): void;
  retheme(): void;
  lights: LightRig;
  overlays: Overlays;
}

const FOV = 40;
const SLAB = 0.35;
const WALL_T = 0.18;
const PING_MS = 1600;
const HOLD_MS = 600;

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function createView3d(stage: HTMLElement, tagLayer: HTMLElement, host: View3dHost): View3d {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  const canvas = renderer.domElement;
  stage.prepend(canvas);
  const maxTex = Math.min(16384, renderer.capabilities.maxTextureSize || 4096);
  const aniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 0.05, 4000);
  camera.position.set(10, 14, 22);

  // ---------- input that must run before the orbit controls see the pointer ----------
  // (registered first, so a press on a mini can switch the controls off before they start turning)
  const ray = new Raycaster();
  const ndc = new Vector2();
  const rayAt = (clientX: number, clientY: number): Raycaster => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / Math.max(r.width, 1)) * 2 - 1, -((clientY - r.top) / Math.max(r.height, 1)) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray;
  };
  // the ground's height under a point (raised and sunken areas of the map: hills, ramps, plateaus), in cells
  const groundY = (x: number, y: number): number => surfaceAt(current?.heights, x, y);
  let groundRange: [number, number] = [0, 0];
  const floorAt = (clientX: number, clientY: number): [number, number] | null => {
    const r = rayAt(clientX, clientY).ray;
    const o: Vec3 = [r.origin.x, r.origin.y, r.origin.z];
    const d: Vec3 = [r.direction.x, r.direction.y, r.direction.z];
    return current?.heights ? (surfaceHit(o, d, groundY, groundRange) ?? groundHit(o, d)) : groundHit(o, d);
  };

  type Press = { pointer: number; sx: number; sy: number; hit: string | null; toggled: boolean; touch: boolean; armed: boolean; floor: [number, number] | null };
  type Drag = { pointer: number; floor: [number, number]; lead: string; starts: DragStart[] };
  let press: Press | null = null;
  let drag: Drag | null = null;
  let hovered: string | null = null;
  let holdTimer: number | undefined;
  let lastClick: { id: string; at: number } | null = null;
  const pointers = new Set<number>();
  const dragPos = new Map<string, { x: number; y: number }>();
  const dragIds = new Set<string>();

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = false; // pans over the table, not up into the air
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 1.5;
  controls.zoomToCursor = true;
  controls.zoomSpeed = 1.5;

  // ---------- lights ----------

  const HEMI = 1.25;
  const SUN = 2.5;
  const hemi = new HemisphereLight(0xfff4e2, 0x3b342c, HEMI);
  const sun = new DirectionalLight(0xfff0d8, SUN);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 4;
  scene.add(hemi, sun, sun.target);
  const lightGroup = new Group();
  scene.add(lightGroup);
  let sources: LightSource[] = [];

  function frameSun(b: { x0: number; y0: number; x1: number; y1: number }): void {
    const cx = (b.x0 + b.x1) / 2;
    const cz = (b.y0 + b.y1) / 2;
    const span = shadowSpan(b);
    // from the north-west, like the light on a printed map, low enough that walls and minis throw a shadow
    sun.position.set(cx - span * 0.75, span * 0.95, cz - span * 0.55);
    sun.target.position.set(cx, 0, cz);
    const c = sun.shadow.camera;
    c.left = -span;
    c.right = span;
    c.top = span;
    c.bottom = -span;
    c.near = 0.5;
    c.far = span * 5;
    c.updateProjectionMatrix();
  }

  function placeLights(): void {
    lightGroup.clear();
    const t = controls.target;
    for (const s of pickLights(sources, t.x, t.z)) {
      const l = new PointLight(s.color ?? '#ffb36b', s.intensity ?? 6, s.range ?? 8, 2);
      l.position.set(s.x, s.height ?? 1.2, s.y);
      l.castShadow = Boolean(s.castShadow);
      lightGroup.add(l);
    }
  }

  const lights: LightRig = {
    setSources(list) {
      sources = [...list];
      placeLights();
      requestRender();
    },
    setAmbient(level) {
      const k = Math.min(1, Math.max(0, level));
      hemi.intensity = HEMI * k;
      sun.intensity = SUN * k;
      requestRender();
    },
  };

  // ---------- materials ----------

  let colors = { bg: '#20252c', slab: '#6E5C49', page: '#EFEAE2', grid: '#1B1F24', empty: '#8A8F96' };
  const readColors = () => {
    colors = { bg: cssVar('--table-bg', '#20252c'), slab: cssVar('--slab', '#6E5C49'), page: cssVar('--page-bg', '#EFEAE2'), grid: cssVar('--grid-ink', '#1B1F24'), empty: cssVar('--muted', '#8A8F96') };
    scene.background = new Color(colors.bg);
  };
  readColors();

  const unitBox = new BoxGeometry(1, 1, 1);
  const slabMat = new MeshStandardMaterial({ color: colors.slab, roughness: 0.9 });
  const floorMat = new MeshStandardMaterial({ color: colors.empty, roughness: 0.95 });
  const wallMat = new MeshStandardMaterial({ color: 0x5b5247, roughness: 0.88 });
  const pieceMats: Record<Piece['kind'], MeshStandardMaterial> = {
    frame: new MeshStandardMaterial({ color: 0x4a4038, roughness: 0.85 }),
    leaf: new MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.7 }),
    locked: new MeshStandardMaterial({ color: 0x5c3a1d, roughness: 0.6, metalness: 0.2 }),
    secret: new MeshStandardMaterial({ color: 0x9b6bd6, roughness: 0.6, transparent: true, opacity: 0.55 }),
    iron: new MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.4, metalness: 0.7 }),
    step: new MeshStandardMaterial({ color: 0xa79d8f, roughness: 0.9 }),
  };
  const gridMat = new LineBasicMaterial({ color: 0x1b1f24, transparent: true, opacity: 0.2, depthWrite: false });

  // ---------- the board ----------

  const board = new Group();
  const structure = new Group();
  const overlayGroup = new Group();
  overlayGroup.position.y = 0.008;
  overlayGroup.renderOrder = 2;
  const minisGroup = new Group();
  const pingGroup = new Group();
  scene.add(board, structure, overlayGroup, minisGroup, pingGroup);

  let current: Scene3D | null = null;
  let page: Page | null = null;
  let wallH = 0.9;
  let flat = false;
  // standees seen from straight above are just their top edge, so they lie down while the camera looks down
  let overhead = false;
  const OVERHEAD = 0.42; // polar angle in radians, about 24° from straight down
  let floorSerial = 0;
  let floorTex: Texture | null = null;

  function disposeKids(g: Group): void {
    g.traverse((o) => {
      if (o instanceof InstancedMesh) o.dispose();
      const m = o as Mesh;
      if (m.geometry && m.geometry !== unitBox) m.geometry.dispose();
    });
    g.clear();
  }

  /** `floor`: load the floor picture ('load'), the same one again over the old copy ('reload'), or keep what's there. */
  function buildBoard(floor: 'load' | 'reload' | 'keep', bust: number): void {
    disposeKids(board);
    const s = current;
    if (!s) {
      loadFloor(bust, false);
      return;
    }
    const b = s.bounds;
    const w = b.x1 - b.x0;
    const d = b.y1 - b.y0;
    const slab = new Mesh(new BoxGeometry(w + 0.6, SLAB, d + 0.6), slabMat);
    slab.position.set(b.x0 + w / 2, -SLAB / 2 - 0.003, b.y0 + d / 2);
    slab.receiveShadow = true;
    board.add(slab);
    const fb = s.floor?.box ?? b;
    const fw = fb.x1 - fb.x0;
    const fd = fb.y1 - fb.y0;
    // raised and sunken ground (the map's height areas): the floor picture draped over hills, ramps and plateaus, rock where it drops sheer
    groundRange = surfaceRange(s.heights);
    if (s.heights) for (const mesh of heightMeshes(s.heights, { box: fb, floor: floorMat, anisotropy: aniso })) board.add(mesh);
    const plane = new Mesh(new PlaneGeometry(fw, fd).rotateX(-Math.PI / 2), floorMat);
    plane.position.set(fb.x0 + fw / 2, 0, fb.y0 + fd / 2);
    plane.receiveShadow = true;
    if (!s.heights) board.add(plane);
    else plane.geometry.dispose();
    if (page?.showGrid) {
      const segs = gridSegments(b);
      // over heights the lines follow the ground (in quarter cells, broken at cliffs)
      const pts = s.heights ? segs.flatMap(([x0, z0, x1, z1]) => drapeLine([x0, z0], [x1, z1], groundY, 0.25, 0.02)) : null;
      const pos = new Float32Array(pts ? pts.length * 3 : segs.length * 6);
      if (pts) pts.forEach((p, i) => pos.set(p, i * 3));
      else segs.forEach(([x0, z0, x1, z1], i) => pos.set([x0, 0.004, z0, x1, 0.004, z1], i * 6));
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
      // blending happens in linear light, so lines need more opacity than on the 2D board to read as much
      gridMat.color.set(s.kind === 'none' ? colors.grid : '#1B1F24');
      gridMat.opacity = s.kind === 'none' ? 0.3 : 0.38;
      board.add(new LineSegments(geo, gridMat));
    }
    if (floor !== 'keep') loadFloor(bust, floor === 'reload');
  }

  let floorUrl: string | null = null;
  function loadFloor(bust: number, again: boolean): void {
    const serial = ++floorSerial;
    const s = current;
    // the same picture again (the map changed): keep the old copy up until the new one is in
    const keep = again && Boolean(floorMat.map) && floorUrl === (s?.floor?.url ?? null);
    floorUrl = s?.floor?.url ?? null;
    if (!keep) {
      floorMat.map = null;
      floorMat.color.set(s?.kind === 'none' ? colors.page : colors.empty);
      floorMat.needsUpdate = true;
    }
    if (!s?.floor) {
      floorTex?.dispose();
      floorTex = null;
      setStatus(null);
      requestRender();
      return;
    }
    const url = bust ? `${s.floor.url}${s.floor.url.includes('?') ? '&' : '?'}v=${bust}` : s.floor.url;
    setStatus('Loading the floor…');
    makeTexture(url, maxTex, aniso)
      .then(({ tex }) => {
        if (serial !== floorSerial) return tex.dispose();
        floorTex?.dispose();
        floorTex = tex;
        floorMat.map = tex;
        floorMat.color.set(0xffffff);
        floorMat.needsUpdate = true;
        setStatus(null);
        requestRender();
      })
      .catch(() => {
        if (serial === floorSerial) setStatus("The floor picture didn't load.");
      });
  }

  function buildStructure(): void {
    disposeKids(structure);
    const s = current;
    if (!s || !(wallH > 0)) return requestRender();
    if (s.walls.length) {
      const walls = new InstancedMesh(unitBox, wallMat, s.walls.length);
      const m = new Matrix4();
      const q = new Quaternion();
      const up = new Vector3(0, 1, 0);
      s.walls.forEach((seg, i) => {
        const wb = wallPiece(seg, WALL_T);
        q.setFromAxisAngle(up, wb.angle);
        m.compose(new Vector3(wb.x, wallBase(s.heights, seg[0], seg[1]) + wallH / 2, wb.z), q, new Vector3(wb.length, wallH, WALL_T));
        walls.setMatrixAt(i, m);
      });
      walls.castShadow = true;
      walls.receiveShadow = true;
      structure.add(walls);
    }
    // on raised or sunken ground doors stand on it, and stairs between two heights climb from the low one to the high one
    const hts = s.heights;
    const lifted = (list: Piece[], by: number): Piece[] => (by ? list.map((p) => ({ ...p, y: p.y + by })) : list);
    const pieces = [
      ...s.doors.flatMap((d) => lifted(doorPieces(d, wallH, WALL_T), wallBase(hts, d.a, d.b))),
      ...s.stairs.flatMap((st) => {
        // from the ground at its foot to the ground at its head
        const r = stairRise(hts, st.box, stairsUp(hts, st.box, st.direction));
        return r && r.rise > 0 ? lifted(stairSteps({ ...st, direction: stairsUp(hts, st.box, st.direction) }, r.rise), r.base) : lifted(stairSteps(st, Math.min(0.32, wallH * 0.4)), r?.base ?? 0);
      }),
    ];
    for (const p of pieces) {
      const mesh = new Mesh(unitBox, pieceMats[p.kind]);
      mesh.position.set(p.x, p.y, p.z);
      mesh.rotation.y = p.angle;
      mesh.scale.set(p.length, p.height, p.depth);
      mesh.castShadow = p.kind !== 'secret';
      mesh.receiveShadow = true;
      structure.add(mesh);
    }
    requestRender();
  }

  // ---------- overlays (step 2: darkness, explored areas) ----------

  const named = new Map<string, Object3D>();
  const overlays: Overlays = {
    set(name, obj) {
      const old = named.get(name);
      if (old) overlayGroup.remove(old);
      named.delete(name);
      if (obj) {
        named.set(name, obj);
        overlayGroup.add(obj);
      }
      requestRender();
    },
    polygons(polys, color, opacity) {
      const mat = new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: DoubleSide });
      const hts = current?.heights;
      if (hts) {
        // laid over the ground (the layer itself sits a hair up), cut along the lattice where it isn't flat so it follows hills
        const geo = drapedGeometry(polys, (x, y) => groundY(x, y) + 0.02, current!.bounds, hts.step ?? 0.25, pieceBoxes(hts));
        if (geo) return new Mesh(geo, mat);
      }
      const shapes = polys.map((p) => {
        const s = new Shape(p.outer.map(([x, y]) => new Vector2(x, y)));
        for (const h of p.holes) s.holes.push(new Path(h.map(([x, y]) => new Vector2(x, y))));
        return s;
      });
      const geo = new ShapeGeometry(shapes).rotateX(Math.PI / 2); // shape y becomes world z
      return new Mesh(geo, mat);
    },
  };

  // ---------- minis ----------

  const textures = new TextureCache(maxTex, aniso);
  const displayTokens = (): Token[] => host.tokens();
  const minis = createMinis(minisGroup, tagLayer, {
    members: host.members,
    me: host.me,
    flat: () => flat || overhead,
    selection: host.selection,
    hovered: () => hovered,
    dragging: () => dragIds,
    textures,
    groundY,
    requestRender: () => requestRender(),
  });

  // ---------- pings ----------

  const pingGeo = new RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);
  const pings: { mesh: Mesh; start: number }[] = [];
  function showPing(x: number, y: number, color: string): void {
    const mesh = new Mesh(pingGeo, new MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, side: DoubleSide }));
    mesh.position.set(x, groundY(x, y) + 0.03, y);
    mesh.renderOrder = 4;
    pingGroup.add(mesh);
    pings.push({ mesh, start: performance.now() });
    requestRender();
  }
  function stepPings(now: number): boolean {
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i]!;
      const t = (now - p.start) / PING_MS;
      const mat = p.mesh.material as MeshBasicMaterial;
      if (t >= 1) {
        pingGroup.remove(p.mesh);
        mat.dispose();
        pings.splice(i, 1);
        continue;
      }
      const r = 0.25 + t * 2.2;
      p.mesh.scale.set(r, 1, r);
      mat.opacity = 1 - t;
    }
    return pings.length > 0;
  }

  // ---------- camera ----------

  const cams = new Map<string, View3>();
  const camKey = (p: Page, s: Scene3D): string => JSON.stringify([p.id, s.view, p.width, p.height, p.origin, p.background]);
  let anim: { from: View3; to: View3; start: number; ms: number } | null = null;
  let followId: string | null = null;

  const viewNow = (): View3 => ({ position: [camera.position.x, camera.position.y, camera.position.z], target: [controls.target.x, controls.target.y, controls.target.z] });
  const setView = (v: View3): void => {
    camera.position.set(...v.position);
    controls.target.set(...v.target);
  };
  const aspect = () => canvas.clientWidth / Math.max(1, canvas.clientHeight);
  const fitBox = () => current?.focus ?? current?.bounds ?? null;

  function animateTo(to: View3, ms = 450): void {
    anim = { from: viewNow(), to, start: performance.now(), ms };
    requestRender();
  }
  function limits(): void {
    const b = current?.bounds;
    if (!b) return;
    controls.maxDistance = Math.max(30, Math.hypot(b.x1 - b.x0, b.y1 - b.y0) * 3);
  }

  // ---------- frames (on demand: while the camera moves, something animates, or after a change) ----------

  let queued = false;
  function requestRender(): void {
    if (queued) return;
    queued = true;
    requestAnimationFrame(frame);
  }
  controls.addEventListener('change', requestRender);

  let statusEl: HTMLElement | null = document.getElementById('status3d');
  function setStatus(text: string | null): void {
    statusEl ??= document.getElementById('status3d');
    if (!statusEl) return;
    statusEl.hidden = text === null;
    if (text !== null) statusEl.textContent = text;
  }

  function frame(now: number): void {
    queued = false;
    let more = false;
    if (anim) {
      const t = Math.min(1, (now - anim.start) / anim.ms);
      setView(lerpView(anim.from, anim.to, t));
      if (t >= 1) anim = null;
      more = true;
    } else if (followId) {
      const t = displayTokens().find((x) => x.id === followId);
      if (!t) {
        followId = null;
        host.followEnded?.();
      } else {
        const goal = tokenCentre(t, groundY(t.x + t.w / 2, t.y + t.h / 2));
        const v = viewNow();
        const dist = Math.hypot(goal[0] - v.target[0], goal[1] - v.target[1], goal[2] - v.target[2]);
        if (dist > 0.01) {
          setView(followStep(v, goal, 0.15));
          more = true;
        }
      }
    }
    if (controls.update()) more = true;
    overhead = controls.getPolarAngle() < OVERHEAD;
    minis.sync(displayTokens(), dragPos);
    if (stepPings(now)) more = true;
    minis.face(camera, canvas.clientWidth, canvas.clientHeight);
    renderer.render(scene, camera);
    for (const f of frameHooks) f();
    if (more) requestRender();
  }
  const frameHooks: (() => void)[] = [];
  const floorClicks: ((x: number, y: number) => void)[] = [];

  function resize(): void {
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  // ---------- input ----------

  const pickAt = (clientX: number, clientY: number): Token | null => {
    const id = minis.pick(rayAt(clientX, clientY));
    return id ? (displayTokens().find((t) => t.id === id) ?? null) : null;
  };

  function cancelDrag(): void {
    drag = null;
    dragPos.clear();
    dragIds.clear();
    stage.classList.remove('dragging');
    controls.enabled = true;
    requestRender();
  }

  canvas.addEventListener('pointerdown', (e) => {
    pointers.add(e.pointerId);
    clearTimeout(holdTimer);
    if (pointers.size > 1) {
      // a second finger: that's a pinch or two-finger pan for the controls, not a drag
      if (drag) cancelDrag();
      press = null;
      controls.enabled = true;
      return;
    }
    anim = null;
    if (e.button !== 0) return;
    const hit = pickAt(e.clientX, e.clientY);
    const me = host.me();
    const sel = host.selection();
    let toggled = false;
    if (hit) {
      if (e.shiftKey) {
        const next = new Set(sel);
        if (next.has(hit.id)) next.delete(hit.id);
        else next.add(hit.id);
        host.setSelection([...next]);
        toggled = true;
      } else if (!sel.has(hit.id)) host.setSelection([hit.id]);
    }
    const armed = Boolean(hit && canMove(me, hit) && host.selection().has(hit.id));
    if (armed) {
      // the press belongs to the mini: the orbit controls sit this one out
      controls.enabled = false;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* the browser lost track of the pointer: no capture then */
      }
    }
    const floor = floorAt(e.clientX, e.clientY);
    press = { pointer: e.pointerId, sx: e.clientX, sy: e.clientY, hit: hit?.id ?? null, toggled, touch: e.pointerType === 'touch', armed, floor };
    holdTimer = window.setTimeout(() => {
      if (!press || drag || !press.floor) return;
      host.ping(press.floor[0], press.floor[1]);
      press = null;
      controls.enabled = true;
    }, HOLD_MS);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!press && !drag) {
      if (e.pointerType !== 'mouse' || e.buttons) return;
      const over = pickAt(e.clientX, e.clientY);
      const id = over?.id ?? null;
      stage.classList.toggle('on-mini', Boolean(over && canMove(host.me(), over)));
      if (id !== hovered) {
        hovered = id;
        requestRender();
      }
      return;
    }
    if (press && e.pointerId === press.pointer && !drag) {
      if (Math.hypot(e.clientX - press.sx, e.clientY - press.sy) < (press.touch ? 8 : 4)) return;
      clearTimeout(holdTimer);
      if (!press.armed || !press.floor) {
        press = null; // the controls are turning or panning the view
        return;
      }
      const me = host.me();
      const sel = host.selection();
      const list = displayTokens();
      const starts = list.filter((t) => sel.has(t.id) && canMove(me, t) && t.layer !== 'map').map((t) => ({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h }));
      drag = { pointer: press.pointer, floor: press.floor, lead: press.hit!, starts };
      for (const s of starts) dragIds.add(s.id);
      stage.classList.add('dragging');
    }
    if (drag && e.pointerId === drag.pointer) {
      const at = floorAt(e.clientX, e.clientY);
      if (!at) return;
      for (const m of dragTargets(drag.starts, drag.lead, at[0] - drag.floor[0], at[1] - drag.floor[1], e.altKey)) dragPos.set(m.id, { x: m.x, y: m.y });
      requestRender();
    }
  });

  function endPointer(e: PointerEvent, cancelled: boolean): void {
    pointers.delete(e.pointerId);
    clearTimeout(holdTimer);
    if (drag && e.pointerId === drag.pointer) {
      const starts = new Map(drag.starts.map((s) => [s.id, s]));
      const moves = [...dragPos].map(([id, p]) => ({ id, ...p })).filter((m) => {
        const s = starts.get(m.id);
        return s && (s.x !== m.x || s.y !== m.y);
      });
      cancelDrag();
      if (!cancelled && moves.length) host.move(moves);
      press = null;
      return;
    }
    const p = press;
    press = null;
    controls.enabled = true;
    if (!p || p.pointer !== e.pointerId || cancelled) return;
    if (!p.hit) {
      if (!e.shiftKey) host.setSelection([]);
      lastClick = null;
      const at = p.floor;
      if (at) for (const f of floorClicks) f(at[0], at[1]);
      return;
    }
    if (!p.toggled) host.setSelection([p.hit]);
    const now = performance.now();
    if (lastClick && lastClick.id === p.hit && now - lastClick.at < 400) {
      lastClick = null;
      view.focusToken(p.hit);
    } else lastClick = { id: p.hit, at: now };
  }
  canvas.addEventListener('pointerup', (e) => endPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !press && !drag && hovered) {
      hovered = null;
      stage.classList.remove('on-mini');
      requestRender();
    }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------- the view's API ----------

  const view: View3d = {
    setScene(s, p, bust) {
      const samePage = Boolean(current && s && current.pageId === s.pageId && current.view === s.view);
      const sameScene = s !== null && s === current;
      if (!samePage && page && current) cams.set(camKey(page, current), viewNow());
      current = s;
      page = p;
      // the same scene again (a grid switch): only the board is rebuilt; a fresh scene loads its floor
      buildBoard(sameScene && !bust ? 'keep' : samePage && bust ? 'reload' : 'load', bust);
      buildStructure();
      if (!s || !p) {
        setStatus(s ? null : 'Nothing to show on this page.');
        return requestRender();
      }
      frameSun(s.bounds);
      limits();
      placeLights();
      if (!samePage) {
        anim = null;
        const saved = cams.get(camKey(p, s));
        const b = fitBox();
        setView(saved ?? (b ? fitView(b, FOV, aspect()) : fitView(s.bounds, FOV, aspect())));
        controls.update();
      }
      requestRender();
    },
    update: requestRender,
    showPing,
    fit() {
      const b = fitBox();
      if (b) animateTo(fitView(b, FOV, aspect()));
    },
    top() {
      const b = fitBox();
      if (!b) return;
      const v = topView(b, FOV, aspect());
      animateTo(v);
    },
    follow(id) {
      followId = id;
      requestRender();
    },
    following: () => followId,
    focusToken(id) {
      const t = displayTokens().find((x) => x.id === id);
      if (!t) return;
      const goal: Vec3 = tokenCentre(t, groundY(t.x + t.w / 2, t.y + t.h / 2));
      const v = viewNow();
      const d: Vec3 = [goal[0] - v.target[0], goal[1] - v.target[1], goal[2] - v.target[2]];
      animateTo({ position: [v.position[0] + d[0], v.position[1] + d[1], v.position[2] + d[2]], target: goal }, 350);
    },
    focusPoint(x, y) {
      const v = viewNow();
      const gy = groundY(x, y);
      const d: Vec3 = [x - v.target[0], gy - v.target[1], y - v.target[2]];
      animateTo({ position: [v.position[0] + d[0], v.position[1] + d[1], v.position[2] + d[2]], target: [x, gy, y] }, 350);
    },
    onFloorClick(cb) {
      floorClicks.push(cb);
    },
    project(x, y, height = groundY(x, y)) {
      const v = new Vector3(x, height, y).project(camera);
      if (v.z > 1 || v.z < -1) return null;
      return [((v.x + 1) / 2) * canvas.clientWidth, ((1 - v.y) / 2) * canvas.clientHeight];
    },
    onFrame(cb) {
      frameHooks.push(cb);
    },
    setFlat(on) {
      flat = on;
      requestRender();
    },
    setWallHeight(h) {
      wallH = h;
      buildStructure();
    },
    setShadows(on) {
      sun.castShadow = on;
      requestRender();
    },
    retheme() {
      readColors();
      slabMat.color.set(colors.slab);
      if (!floorMat.map) floorMat.color.set(current?.kind === 'none' ? colors.page : colors.empty);
      if (current?.kind === 'none') gridMat.color.set(colors.grid);
      minis.refresh();
      requestRender();
    },
    lights,
    overlays,
  };

  return view;
}
