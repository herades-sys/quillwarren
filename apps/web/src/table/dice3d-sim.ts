// 3D dice physics: a throw is simulated ahead of time with cannon-es (fixed
// 1/60 s steps, the start from a seeded RNG, so a seed always gives the same
// throw), recording every die's position and rotation per step until all lie
// still. The overlay replays the recording; the face on top at the end is where
// the rolled value's label goes. No DOM or WebGL here, so tests run it headless.
import { Body, ContactMaterial, ConvexPolyhedron, GSSolver, Material, Plane, Quaternion, Vec3, World } from 'cannon-es';
import { dieShape, randomQuat, seededRandom, topSite, type DieKind } from './dice3d-logic.ts';

export const STEP = 1 / 60;
/** A throw stops after this many steps even if something still moves. */
export const MAX_STEPS = 60 * 8;
/** The top face must point this straight up (cos of about 16°) to count as flat. */
export const FLAT = 0.96;

const GRAVITY = 70;
/** How far from the middle of the area the dice start (at most, and as a share of the way to the wall), and how fast they go from there. */
const START = 7;
const START_SHARE = 0.6;
const SPEED = 15;
const SPIN = 16;
const SPACING = 2.6;
/** Floor space a die wants, in square units; with less, the dice of a throw get smaller. */
const ROOM = 14;
const MIN_SCALE = 0.6;

/** The floor rectangle in world units (x right, z down the screen). Walls stand on its edges. */
export interface Arena {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface Recording {
  /** Recorded frames: the start, then one per step. */
  steps: number;
  /** steps × dice × [x, y, z, qx, qy, qz, qw] */
  frames: Float32Array;
  /** The site on top of each die at the end, and how flat it lies (1: flat). */
  tops: number[];
  tilt: number[];
  /** Everything came to rest before MAX_STEPS. */
  rested: boolean;
  /** Which try this is (a throw that ends with a die leaning on another is tried again with another seed). */
  attempt: number;
  /** The dice's size (1: normal): many dice in a small area are made smaller. */
  scale: number;
}

/** How big the dice of a throw are: smaller when many share a small area, so they have room to land flat. */
export function diceScale(count: number, arena: Arena): number {
  const perDie = ((arena.x1 - arena.x0) * (arena.z1 - arena.z0)) / Math.max(1, count);
  return Math.min(1, Math.max(MIN_SCALE, Math.sqrt(perDie / ROOM)));
}

function hull(kind: DieKind, scale: number): ConvexPolyhedron {
  const s = dieShape(kind);
  return new ConvexPolyhedron({ vertices: s.vertices.map((v) => new Vec3(v[0] * scale, v[1] * scale, v[2] * scale)), faces: s.faces.map((f) => f.slice()) });
}

function wall(world: World, material: Material, normal: Vec3, at: Vec3): void {
  const body = new Body({ mass: 0, material, shape: new Plane() });
  body.quaternion.setFromVectors(new Vec3(0, 0, 1), normal);
  body.position.copy(at);
  world.addBody(body);
}

/** One throw with this RNG. */
export function simulate(kinds: readonly DieKind[], rand: () => number, arena: Arena): Recording {
  const world = new World({ gravity: new Vec3(0, -GRAVITY, 0), allowSleep: true });
  (world.solver as GSSolver).iterations = 12;
  const diceMat = new Material('dice');
  const floorMat = new Material('floor');
  const wallMat = new Material('wall');
  world.addContactMaterial(new ContactMaterial(floorMat, diceMat, { friction: 0.3, restitution: 0.35 }));
  world.addContactMaterial(new ContactMaterial(wallMat, diceMat, { friction: 0.05, restitution: 0.45 }));
  world.addContactMaterial(new ContactMaterial(diceMat, diceMat, { friction: 0.15, restitution: 0.4 }));

  const { x0, x1, z0, z1 } = arena;
  wall(world, floorMat, new Vec3(0, 1, 0), new Vec3(0, 0, 0));
  wall(world, wallMat, new Vec3(1, 0, 0), new Vec3(x0, 0, 0));
  wall(world, wallMat, new Vec3(-1, 0, 0), new Vec3(x1, 0, 0));
  wall(world, wallMat, new Vec3(0, 0, 1), new Vec3(0, 0, z0));
  wall(world, wallMat, new Vec3(0, 0, -1), new Vec3(0, 0, z1));

  // Start together on one side of the area, a little apart, and fly at its middle.
  const scale = diceScale(kinds.length, arena);
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const hw = (x1 - x0) / 2;
  const hh = (z1 - z0) / 2;
  const theta = rand() * 2 * Math.PI;
  const dx = Math.cos(theta);
  const dz = Math.sin(theta);
  const margin = 1.2 * scale;
  const toWall = Math.min((hw - margin) / Math.max(Math.abs(dx), 1e-6), (hh - margin) / Math.max(Math.abs(dz), 1e-6));
  const reach = Math.max(0, Math.min(START, toWall * START_SHARE));
  const spacing = SPACING * scale;
  const cols = Math.ceil(Math.sqrt(kinds.length));
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
  const bodies = kinds.map((kind, i) => {
    const row = Math.floor(i / cols);
    const side = (i % cols) - (cols - 1) / 2;
    const back = reach + row * spacing;
    const x = clamp(cx + dx * back - dz * side * spacing + (rand() - 0.5) * 0.4, x0 + margin, x1 - margin);
    const z = clamp(cz + dz * back + dx * side * spacing + (rand() - 0.5) * 0.4, z0 + margin, z1 - margin);
    const aim = theta + (rand() - 0.5) * 0.5;
    const speed = SPEED * (0.85 + 0.3 * rand()) * Math.sqrt(Math.max(reach, 1.5) / START);
    const q = randomQuat(rand);
    const body = new Body({
      mass: scale ** 3,
      material: diceMat,
      shape: hull(kind, scale),
      linearDamping: 0.2,
      angularDamping: 0.2,
      allowSleep: true,
      sleepSpeedLimit: 0.2 * scale,
      sleepTimeLimit: 0.25,
      position: new Vec3(x, (1.6 + rand() * 1.4 + (row % 2) * 1.2) * scale, z),
      quaternion: new Quaternion(q[0], q[1], q[2], q[3]),
      velocity: new Vec3(-Math.cos(aim) * speed, rand() * 3 - 1, -Math.sin(aim) * speed),
      angularVelocity: new Vec3((rand() * 2 - 1) * SPIN, (rand() * 2 - 1) * SPIN, (rand() * 2 - 1) * SPIN),
    });
    world.addBody(body);
    return body;
  });

  const n = bodies.length;
  const frames = new Float32Array((MAX_STEPS + 1) * n * 7);
  const record = (step: number) => {
    let o = step * n * 7;
    for (const b of bodies) {
      frames[o++] = b.position.x;
      frames[o++] = b.position.y;
      frames[o++] = b.position.z;
      frames[o++] = b.quaternion.x;
      frames[o++] = b.quaternion.y;
      frames[o++] = b.quaternion.z;
      frames[o++] = b.quaternion.w;
    }
  };
  record(0);
  let steps = 1;
  let rested = false;
  // Done when every die sleeps, or when none has really moved for half a second:
  // a pile of dice can keep trembling in the solver without ever falling asleep.
  const LOOK = 15;
  const still = (step: number): boolean => {
    if (step < LOOK) return false;
    for (let i = 0; i < n; i++) {
      const a = (step * n + i) * 7;
      const b = ((step - LOOK) * n + i) * 7;
      let dp = 0;
      let dq = 0;
      for (let k = 0; k < 3; k++) dp += ((frames[a + k] ?? 0) - (frames[b + k] ?? 0)) ** 2;
      for (let k = 3; k < 7; k++) dq += ((frames[a + k] ?? 0) - (frames[b + k] ?? 0)) ** 2;
      if (dp > (0.03 * scale) ** 2 || dq > 0.0004) return false;
    }
    return true;
  };
  let calm = 0;
  while (steps <= MAX_STEPS) {
    world.step(STEP);
    record(steps);
    calm = still(steps) ? calm + 1 : 0;
    steps++;
    if (calm >= LOOK || bodies.every((b) => b.sleepState === Body.SLEEPING)) {
      rested = true;
      break;
    }
  }
  const tops: number[] = [];
  const tilt: number[] = [];
  bodies.forEach((b, i) => {
    const kind = kinds[i] ?? 'd6';
    const t = topSite(kind, [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]);
    tops.push(t.site);
    tilt.push(t.up);
  });
  return { steps, frames: frames.slice(0, steps * n * 7), tops, tilt, rested, attempt: 0, scale };
}

/** Lower is better: still moving, then dice not lying flat, then dice resting far from the middle. */
function badness(rec: Recording, arena: Arena): number {
  const n = rec.tops.length;
  const last = (rec.steps - 1) * n * 7;
  const cx = (arena.x0 + arena.x1) / 2;
  const cz = (arena.z0 + arena.z1) / 2;
  const mx = (arena.x1 - arena.x0) * 0.3 + 0.5;
  const mz = (arena.z1 - arena.z0) * 0.3 + 0.5;
  let score = rec.rested ? 0 : 1000;
  for (let i = 0; i < n; i++) {
    if ((rec.tilt[i] ?? 0) < FLAT) score += 20;
    const x = rec.frames[last + i * 7] ?? cx;
    const z = rec.frames[last + i * 7 + 2] ?? cz;
    if (Math.abs(x - cx) > mx || Math.abs(z - cz) > mz) score += 1;
  }
  return score;
}

/** Throw these dice for a seed. Few dice get a few tries so they end flat and near the middle; the same seed always picks the same one. */
export function throwDice(kinds: readonly DieKind[], seed: string, arena: Arena): Recording {
  const tries = kinds.length <= 6 ? 4 : kinds.length <= 12 ? 2 : 1;
  let best: Recording | null = null;
  let bestScore = Infinity;
  for (let attempt = 0; attempt < tries; attempt++) {
    const rec = simulate(kinds, seededRandom(attempt ? `${seed}#${attempt}` : seed), arena);
    rec.attempt = attempt;
    const score = badness(rec, arena);
    if (score < bestScore) {
      best = rec;
      bestScore = score;
    }
    if (score === 0) break;
  }
  return best ?? simulate(kinds, seededRandom(seed), arena);
}
