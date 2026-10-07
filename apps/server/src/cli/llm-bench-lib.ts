// The local-model benchmark's tasks, their automatic checks and the report
// (llm-bench.ts runs them). Each task starts from a fresh map; its checks
// compare the map before and after (plus the answer and the tool calls).
// A check marked core shows real progress on the task; the others guard
// against damage. pass: every check holds; partial: at least one core check
// holds; fail: no core check holds.
import {
  assetInfo,
  computeFloor,
  corridorPath,
  doorCentre,
  isCanopy,
  pointInRing,
  pointInShape,
  propBounds,
  roomsById,
  shapeBounds,
  type Bounds,
  type DelveMap,
  type MapObject,
  type Point,
  type Polygon,
  type Room,
} from '@delve/core';
import { malformed, promptPerSecond, tokensPerSecond, type AgentStats, type CallRecord, type StopReason } from '../chat/local-agent.ts';
import type { ToolSet } from '../chat/local-setup.ts';

export interface CheckInput {
  before: DelveMap;
  after: DelveMap;
  beforeRev: number;
  afterRev: number;
  answer: string;
  calls: CallRecord[];
}

export interface Check {
  name: string;
  ok: boolean;
  core: boolean;
  detail?: string;
}

export interface BenchTask {
  id: string;
  n: number;
  title: string;
  template: 'test-dungeon' | 'empty';
  unit?: string;
  prompt: string;
  check(i: CheckInput): Check[];
}

export type Grade = 'pass' | 'partial' | 'fail';

export function grade(checks: readonly Check[]): Grade {
  if (checks.every((c) => c.ok)) return 'pass';
  return checks.some((c) => c.core && c.ok) ? 'partial' : 'fail';
}

// ---------- geometry helpers ----------

type Typed<T extends MapObject['type']> = Extract<MapObject, { type: T }>;
const ofType = <T extends MapObject['type']>(m: DelveMap, type: T): Typed<T>[] => m.objects.filter((o): o is Typed<T> => o.type === type);
const added = <T extends MapObject['type']>(i: CheckInput, type: T): Typed<T>[] => {
  const old = new Set(i.before.objects.map((o) => o.id));
  return ofType(i.after, type).filter((o) => !old.has(o.id));
};
const removed = (i: CheckInput): string[] => {
  const now = new Set(i.after.objects.map((o) => o.id));
  return i.before.objects.filter((o) => !now.has(o.id)).map((o) => o.id);
};
const byId = (m: DelveMap, id: string): MapObject | undefined => m.objects.find((o) => o.id === id);
const roomById = (m: DelveMap, id: string): Room | undefined => {
  const o = byId(m, id);
  return o?.type === 'room' ? o : undefined;
};

const width = (b: Bounds) => b.x1 - b.x0;
const height = (b: Bounds) => b.y1 - b.y0;
const centre = (b: Bounds): Point => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
const area = (b: Bounds) => Math.max(0, width(b)) * Math.max(0, height(b));
export function overlap(a: Bounds, b: Bounds): number {
  return area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
}
const within = (inner: Bounds, outer: Bounds, tol = 0.25) => inner.x0 >= outer.x0 - tol && inner.y0 >= outer.y0 - tol && inner.x1 <= outer.x1 + tol && inner.y1 <= outer.y1 + tol;
const inBounds = (p: Point, b: Bounds, tol = 0) => p[0] >= b.x0 - tol && p[0] <= b.x1 + tol && p[1] >= b.y0 - tol && p[1] <= b.y1 + tol;
/** Distance from a point to a rectangle's outline (inside or out). */
export function toOutline(p: Point, b: Bounds): number {
  if (inBounds(p, b)) return Math.min(p[0] - b.x0, b.x1 - p[0], p[1] - b.y0, b.y1 - p[1]);
  const dx = Math.max(b.x0 - p[0], 0, p[0] - b.x1);
  const dy = Math.max(b.y0 - p[1], 0, p[1] - b.y1);
  return Math.hypot(dx, dy);
}
/** Distance from a point to a rectangle (0 inside). */
const toBox = (p: Point, b: Bounds) => (inBounds(p, b) ? 0 : toOutline(p, b));
const fmt = (b: Bounds) => `[${b.x0}, ${b.y0}, ${width(b)}, ${height(b)}]`;

/** What an asset is, as one lower-case string to match words in: id, name, tags, category. */
export function assetWords(asset: string): string {
  const a = assetInfo(asset);
  return `${asset} ${a?.name ?? ''} ${a?.tags.join(' ') ?? ''} ${a?.category ?? ''}`.toLowerCase();
}
export const isTree = (asset: string): boolean => isCanopy(asset) || assetInfo(asset)?.category === 'trees';
const isWater = (asset: string) => assetInfo(asset)?.kind === 'terrain' && /water|pond|lake|river|sea/.test(assetWords(asset));
const isGrass = (asset: string) => assetInfo(asset)?.kind === 'terrain' && /grass|lawn|meadow/.test(assetWords(asset));

/** Two rooms joined directly by a corridor: by from/to, or a drawn path whose ends reach both. */
export function joinedByCorridor(m: DelveMap, a: Room, b: Room): boolean {
  const rooms = roomsById(m);
  const ba = shapeBounds(a.shape);
  const bb = shapeBounds(b.shape);
  return ofType(m, 'corridor').some((c) => {
    if (c.from && c.to) return (c.from === a.id && c.to === b.id) || (c.from === b.id && c.to === a.id);
    const path = corridorPath(c, rooms);
    if (!path || path.length < 2) return false;
    const s = path[0]!;
    const e = path[path.length - 1]!;
    const near = (p: Point, box: Bounds) => toBox(p, box) <= 1.5;
    return (near(s, ba) && near(e, bb)) || (near(s, bb) && near(e, ba));
  });
}

/** A point inside the room (and on the floor, not in a pillar), to find which piece of floor it is in. */
function floorPiece(floor: Polygon[], room: Room): number {
  const b = shapeBounds(room.shape);
  for (let y = b.y0 + 0.25; y < b.y1; y += 0.5) {
    for (let x = b.x0 + 0.25; x < b.x1; x += 0.5) {
      const p: Point = [x, y];
      if (!pointInShape(room.shape, p)) continue;
      const k = floor.findIndex((f) => pointInRing(p, f.outer) && !f.holes.some((h) => pointInRing(p, h)));
      if (k >= 0) return k;
    }
  }
  return -1;
}

/** Every room on one connected floor (through corridors, or rooms that touch). */
export function allConnected(m: DelveMap): boolean {
  const rooms = ofType(m, 'room');
  if (rooms.length < 2) return rooms.length === 1;
  const floor = computeFloor(m);
  const pieces = new Set(rooms.map((r) => floorPiece(floor, r)));
  return pieces.size === 1 && !pieces.has(-1);
}

/** Corridors that run through a room other than the two they join ("c3 through r1"). */
export function corridorsThroughRooms(m: DelveMap): string[] {
  const rooms = roomsById(m);
  const out: string[] = [];
  for (const c of ofType(m, 'corridor')) {
    const path = corridorPath(c, rooms);
    if (!path || path.length < 2) continue;
    const ends = [path[0]!, path[path.length - 1]!];
    for (const r of rooms.values()) {
      const b = shapeBounds(r.shape);
      if (r.id === c.from || r.id === c.to) continue;
      if (!c.from && ends.some((p) => toBox(p, b) <= 1.5)) continue; // a drawn corridor's own rooms
      const inner = { x0: b.x0 + 0.5, y0: b.y0 + 0.5, x1: b.x1 - 0.5, y1: b.y1 - 0.5 };
      const hit = path.slice(1).some((q, k) => {
        const p = path[k]!;
        const steps = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 0.25));
        for (let s = 0; s <= steps; s++) {
          const pt: Point = [p[0] + ((q[0] - p[0]) * s) / steps, p[1] + ((q[1] - p[1]) * s) / steps];
          if (inBounds(pt, inner) && pointInShape(r.shape, pt)) return true;
        }
        return false;
      });
      if (hit) out.push(`${c.id} through ${r.id}`);
    }
  }
  return out;
}

/** Pairs of props whose footprints overlap by more than a quarter square. */
function propsOnEachOther(props: readonly Typed<'prop'>[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < props.length; i++) {
    for (let j = i + 1; j < props.length; j++) {
      if (overlap(propBounds(props[i]!), propBounds(props[j]!)) > 0.25) out.push(`${props[i]!.id}/${props[j]!.id}`);
    }
  }
  return out;
}

/** A door whose middle lies on a room's outline (within 0.3 squares). */
const onRoomWall = (m: DelveMap, d: Typed<'door'>) => ofType(m, 'room').some((r) => toOutline(doorCentre(d), shapeBounds(r.shape)) <= 0.3);

/** Pairs of rooms whose boxes overlap. */
function overlappingRooms(m: DelveMap): string[] {
  const rooms = ofType(m, 'room');
  const out: string[] = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      if (overlap(shapeBounds(rooms[i]!.shape), shapeBounds(rooms[j]!.shape)) > 0.01) out.push(`${rooms[i]!.id}/${rooms[j]!.id}`);
    }
  }
  return out;
}

const check = (name: string, ok: boolean, detail?: string, core = true): Check => ({ name, ok, core, ...(detail ? { detail } : {}) });
const guard = (name: string, ok: boolean, detail?: string): Check => check(name, ok, detail, false);
const nothingRemoved = (i: CheckInput) => {
  const gone = removed(i);
  return guard('nothing else removed', gone.length === 0, gone.length ? `removed ${gone.join(', ')}` : undefined);
};

// ---------- the tasks ----------

export const TASKS: BenchTask[] = [
  {
    id: 't1-room-east',
    n: 1,
    title: 'New 6×4 room east of room 1, corridor with a door',
    template: 'test-dungeon',
    prompt: 'Add a 6×4 room east of room 1, joined to room 1 by a corridor with a door.',
    check(i) {
      const r1 = roomById(i.after, 'r1');
      const rooms = added(i, 'room');
      const nr = rooms[0];
      const b1 = r1 ? shapeBounds(r1.shape) : null;
      const nb = nr ? shapeBounds(nr.shape) : null;
      const size = nb ? `${width(nb)}×${height(nb)}` : '';
      const [cx, cy] = nb ? centre(nb) : [0, 0];
      const [c1x, c1y] = b1 ? centre(b1) : [0, 0];
      const doors = added(i, 'door');
      const doorOk = Boolean(nb && b1 && doors.some((d) => toOutline(doorCentre(d), nb) <= 1.25 || toOutline(doorCentre(d), b1) <= 1.25));
      const clash = nb ? ofType(i.after, 'room').filter((r) => r.id !== nr!.id && overlap(shapeBounds(r.shape), nb) > 0.01).map((r) => r.id) : [];
      const through = corridorsThroughRooms(i.after);
      return [
        check('exactly one new room', rooms.length === 1, `${rooms.length} new`),
        check('the new room is 6×4', size === '6×4' || size === '4×6', nb ? `${nr!.id} ${fmt(nb)}` : undefined),
        check('it lies east of room 1', Boolean(nb && b1 && nb.x0 >= b1.x1 - 0.01 && Math.abs(cy - c1y) <= cx - c1x), nb ? `x from ${nb.x0}, room 1 ends at ${b1?.x1}` : undefined),
        check('a corridor joins it to room 1', Boolean(nr && r1 && joinedByCorridor(i.after, r1, nr))),
        check('a new door on that connection', doorOk, `${doors.length} new door(s)`),
        guard('no overlap with other rooms', clash.length === 0, clash.length ? `overlaps ${clash.join(', ')}` : undefined),
        guard('corridors stay out of other rooms', through.length === 0, through.join(', ') || undefined),
        nothingRemoved(i),
      ];
    },
  },
  {
    id: 't2-rename-lock',
    n: 2,
    title: 'Rename room 3 "Armoury", lock its door',
    template: 'test-dungeon',
    prompt: 'Rename room 3 to "Armoury" and make its door locked.',
    check(i) {
      const r3 = roomById(i.after, 'r3');
      const b3 = r3 ? shapeBounds(r3.shape) : null;
      const doors = ofType(i.after, 'door').filter((d) => b3 && toOutline(doorCentre(d), b3) <= 0.6);
      const oldIds = new Set(i.before.objects.map((o) => o.id));
      const locked = doors.filter((d) => d.style === 'locked');
      return [
        check('room 3 is named Armoury', Boolean(r3?.name && /^\s*armou?ry\s*$/i.test(r3.name)), r3 ? `name ${JSON.stringify(r3.name ?? null)}` : 'r3 gone'),
        check('its door is locked', locked.some((d) => oldIds.has(d.id)), doors.map((d) => `${d.id} ${d.style ?? 'normal'}`).join(', ')),
        guard('no new door added', added(i, 'door').length === 0),
        guard('room number kept', r3?.label === '3', `label ${JSON.stringify(r3?.label ?? null)}`),
        nothingRemoved(i),
      ];
    },
  },
  {
    id: 't3-tavern',
    n: 3,
    title: 'Furnish room 2 as a tavern',
    template: 'test-dungeon',
    prompt: 'Furnish room 2 as a tavern: at least one table, four chairs and a bar counter, all inside room 2.',
    check(i) {
      const r2 = roomById(i.after, 'r2');
      const b2 = r2 ? shapeBounds(r2.shape) : null;
      const props = added(i, 'prop');
      const tables = props.filter((p) => /table/.test(`${p.asset} ${assetInfo(p.asset)?.name ?? ''}`.toLowerCase()));
      const chairs = props.filter((p) => /chair|stool/.test(p.asset) && !/table|bar-counter/.test(p.asset));
      const bars = props.filter((p) => {
        const name = (assetInfo(p.asset)?.name ?? '').toLowerCase();
        return /bar-counter|bar-corner/.test(p.asset) || (/\bbar\b/.test(name) && /counter/.test(name));
      });
      const outside = b2 ? props.filter((p) => !within(propBounds(p), b2)) : props;
      const stacked = propsOnEachOther(props);
      return [
        check('at least one table', tables.length >= 1, `${tables.length}: ${[...new Set(tables.map((p) => p.asset))].join(', ')}`),
        check('at least four chairs', chairs.length >= 4, `${chairs.length}`),
        check('a bar counter', bars.length >= 1, `${bars.length}`),
        check('all new props inside room 2', props.length > 0 && outside.length === 0, outside.length ? `outside: ${outside.map((p) => `${p.id} ${p.asset} at [${p.at.join(', ')}]`).join('; ')}` : `${props.length} props`),
        guard('no props on top of each other', stacked.length === 0, stacked.join(', ') || undefined),
        nothingRemoved(i),
      ];
    },
  },
  {
    id: 't4-water-bridge',
    n: 4,
    title: 'Water in room 5 with a bridge across',
    template: 'test-dungeon',
    prompt: 'Paint water in room 5 and put a bridge across it.',
    check(i) {
      const r5 = roomById(i.after, 'r5');
      const b5 = r5 ? shapeBounds(r5.shape) : null;
      const water = added(i, 'terrain').filter((t) => isWater(t.asset));
      const wet = b5 ? water.filter((t) => overlap(shapeBounds(t.shape), b5) >= 0.25 * area(b5) && inBounds(centre(shapeBounds(t.shape)), b5)) : [];
      const bridges = added(i, 'prop').filter((p) => /bridge/.test(assetWords(p.asset)));
      const inRoom = b5 ? bridges.filter((p) => inBounds(p.at, b5)) : [];
      const over = inRoom.filter((p) => wet.some((t) => overlap(propBounds(p), shapeBounds(t.shape)) > 0));
      const long = over.filter((p) => Math.max(width(propBounds(p)), height(propBounds(p))) >= 3);
      return [
        check('water covers room 5', wet.length > 0, water.map((t) => `${t.id} ${t.asset} ${fmt(shapeBounds(t.shape))}`).join('; ') || 'no water terrain'),
        check('a bridge in room 5', inRoom.length > 0, bridges.map((p) => `${p.id} ${p.asset} at [${p.at.join(', ')}]`).join('; ') || 'no bridge'),
        check('the bridge lies over the water', over.length > 0),
        guard('the bridge is at least 3 squares long', long.length > 0),
        nothingRemoved(i),
      ];
    },
  },
  {
    id: 't5-forest-north',
    n: 5,
    title: 'Small forest along the north edge (prop brush)',
    template: 'test-dungeon',
    prompt: 'Plant a small forest along the north edge of the map, north of the rooms, with the prop brush. Use trees from a group so they are mixed, and keep the trees out of the rooms.',
    check(i) {
      const rooms = ofType(i.after, 'room');
      const top = Math.min(...rooms.map((r) => shapeBounds(r.shape).y0));
      const trees = added(i, 'prop').filter((p) => isTree(p.asset));
      const north = trees.filter((p) => p.at[1] < top + 2);
      const inRooms = trees.filter((p) => rooms.some((r) => inBounds(p.at, shapeBounds(r.shape), -0.5) && pointInShape(r.shape, p.at)));
      const brush = i.calls.some((c) => c.name === 'add_props_along' && c.ok && typeof c.args.asset === 'string' && isTree(c.args.asset));
      const kinds = new Set(trees.map((p) => p.asset));
      return [
        check('at least 5 trees', trees.length >= 5, `${trees.length}`),
        check('placed with the prop brush', brush),
        check('mixed (2+ kinds of tree)', kinds.size >= 2, [...kinds].join(', ')),
        check('along the north edge', trees.length > 0 && north.length >= 0.8 * trees.length, `${north.length} of ${trees.length} north of y ${top + 2}`),
        check('none inside a room', trees.length > 0 && inRooms.length === 0, inRooms.length ? inRooms.map((p) => `${p.id} at [${p.at.join(', ')}]`).join('; ') : undefined),
        nothingRemoved(i),
      ];
    },
  },
  {
    id: 't6-hill-path',
    n: 6,
    title: 'Grass, a +5 m slope hill in the south-west, a dirt path up',
    template: 'empty',
    unit: '1.5 m',
    prompt: 'This is an empty outdoor map. Cover the area x 0 to 30, y 0 to 20 with grass. In the south-west of it, raise a hill 5 m high with a slope edge, and add a dirt path that starts at the east side of the area and goes up to the hill.',
    check(i) {
      const area0: Bounds = { x0: 0, y0: 0, x1: 30, y1: 20 };
      const terrain = added(i, 'terrain');
      const grass = terrain.filter((t) => isGrass(t.asset));
      const covered = grass.reduce((s, t) => s + overlap(shapeBounds(t.shape), area0), 0);
      const paths = terrain.filter((t) => !isGrass(t.asset));
      // with several tries on the map, the hill that fits best is judged
      const judged = added(i, 'height')
        .filter((h) => h.height >= 4 && h.height <= 6)
        .map((h) => {
          const hb = shapeBounds(h.shape);
          const [hx, hy] = centre(hb);
          const path = paths.find((t) => {
            const pb = shapeBounds(t.shape);
            return overlap(pb, { x0: hb.x0 - 1, y0: hb.y0 - 1, x1: hb.x1 + 1, y1: hb.y1 + 1 }) > 0 && pb.x1 >= hb.x1 + 3;
          });
          const r = {
            h,
            slope: h.edge === 'slope' || h.profile === 'hill',
            sw: hx < 15 && hy > 10,
            onGrass: grass.reduce((s, t) => s + overlap(shapeBounds(t.shape), hb), 0) >= 0.8 * area(hb),
            path,
          };
          return { ...r, score: Number(r.slope) + Number(r.sw) + Number(r.onGrass) + Number(Boolean(path)) };
        })
        .sort((a, b) => b.score - a.score);
      const best = judged[0];
      const hb = best ? shapeBounds(best.h.shape) : null;
      return [
        check('grass covers the area', covered >= 0.6 * area(area0), `${Math.round((100 * covered) / area(area0))} %`),
        check('a hill 5 high', Boolean(best), added(i, 'height').map((h) => `${h.id} ${h.height} ${h.edge ?? ''} ${fmt(shapeBounds(h.shape))}`).join('; ') || 'no height area'),
        check('with a slope edge', Boolean(best?.slope)),
        check('in the south-west', Boolean(best?.sw), hb ? `${best!.h.id} centre ${centre(hb).join(', ')}` : undefined),
        check('on the grass', Boolean(best?.onGrass)),
        check('a dirt path from the east up to it', Boolean(best?.path), paths.map((t) => `${t.id} ${t.asset} ${fmt(shapeBounds(t.shape))}`).join('; ') || 'no other terrain'),
      ];
    },
  },
  {
    id: 't7-crypt',
    n: 7,
    title: 'A 4-room crypt from scratch, secret door, sarcophagus',
    template: 'empty',
    prompt: 'Build a small crypt on this empty map: 4 rooms connected by corridors, one secret door, and a sarcophagus in one of the rooms.',
    check(i) {
      const rooms = ofType(i.after, 'room');
      const doors = ofType(i.after, 'door');
      const corridors = ofType(i.after, 'corridor');
      const sarc = ofType(i.after, 'prop').filter((p) => /sarcophag/.test(assetWords(p.asset)));
      const inRoom = sarc.filter((p) => rooms.some((r) => pointInShape(r.shape, p.at)));
      const clash = overlappingRooms(i.after);
      const secret = doors.filter((d) => d.style === 'secret');
      const through = corridorsThroughRooms(i.after);
      return [
        check('at least 4 rooms', rooms.length >= 4, `${rooms.length}`),
        check('all rooms connected', rooms.length >= 2 && allConnected(i.after)),
        check('a secret door', secret.length > 0, doors.map((d) => d.style ?? 'normal').join(', ') || 'no doors'),
        check('a sarcophagus', sarc.length > 0),
        guard('the secret door sits on a room\'s wall', secret.some((d) => onRoomWall(i.after, d)), secret.map((d) => `${d.id} at [${d.at.join(', ')}] along ${d.along}`).join('; ') || undefined),
        guard('the sarcophagus stands in a room', inRoom.length > 0),
        guard('joined by corridors (3 or more)', corridors.length >= 3, `${corridors.length}`),
        guard('corridors stay out of other rooms', through.length === 0, through.join(', ') || undefined),
        guard('rooms kept apart', clash.length === 0, clash.length ? `overlapping: ${clash.join(', ')}` : undefined),
      ];
    },
  },
  {
    id: 't8-question',
    n: 8,
    title: 'Question only: doors of room 1',
    template: 'test-dungeon',
    prompt: 'How many doors does room 1 have, and which one leads outside?',
    check(i) {
      const a = i.answer;
      const two = /\b(two|2)\b(\s+[\w-]+){0,3}\s+doors?\b/i.test(a) || /\bdoors?\b[^.\n]{0,30}\b(two|2)\b/i.test(a);
      return [
        check('says 2 doors', two, a.slice(0, 160)),
        check('names d5 as the way out', /\bd5\b/i.test(a)),
        check('the map is unchanged', i.afterRev === i.beforeRev, `rev ${i.beforeRev} → ${i.afterRev}`),
      ];
    },
  },
];

/** Tasks by "1,3", "t2-rename-lock" or a word of the id; all without a filter. */
export function pickTasks(filter: string | undefined): BenchTask[] {
  if (!filter) return TASKS;
  const want = filter.split(',').map((s) => s.trim()).filter(Boolean);
  return TASKS.filter((t) => want.some((w) => w === String(t.n) || w === t.id || t.id.includes(w)));
}

// ---------- results and the report ----------

export interface TaskResult {
  task: string;
  n: number;
  title: string;
  prompt: string;
  grade: Grade;
  checks: Check[];
  stop: StopReason;
  error?: string;
  answer: string;
  lastText: string;
  stats: AgentStats;
  mapId: string;
  png?: string;
  transcript?: string;
  /** Tool names in order, with ✗ for failed calls. */
  callLog: string;
}

export interface RunResult {
  model: string;
  tools: ToolSet;
  /** --name: tells repeated runs of one model and tool set apart. */
  name?: string;
  /** The helping steps the harness ran with ("ids, final", "none"); runs from before them have none. */
  steps?: string;
  api: string;
  baseUrl: string;
  numCtx?: number;
  think?: string;
  serverVersion?: string;
  delveVersion: string;
  started: string;
  finished: string;
  /** Characters of system prompt, tool definitions and the first user message (task 1's). */
  size: { system: number; tools: number; user: number };
  toolCount: number;
  warmupMs?: number;
  tasks: TaskResult[];
}

/** Tool names in order: ✗ a failed call, ⊘ one held back after a failed call in the same reply. */
export function callLog(calls: readonly CallRecord[]): string {
  return calls.map((c) => `${c.name}${c.notRun ? '⊘' : c.ok ? '' : '✗'}`).join(' ');
}

const secs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const oneLine = (s: string, max = 160) => {
  const t = cell(s).trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const rate = (v: number | undefined) => (v === undefined ? '–' : String(Math.round(v)));
const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function sumStats(list: readonly AgentStats[]): AgentStats {
  const out = { ...list[0]! };
  for (const k of Object.keys(out) as (keyof AgentStats)[]) out[k] = list.reduce((s, x) => (k === 'maxPrompt' ? Math.max(s, x[k]) : s + x[k]), 0);
  return out;
}

export const runName = (r: Pick<RunResult, 'model' | 'tools' | 'name'>): string => `${r.model} · ${r.tools}${r.name ? ` · ${r.name}` : ''}`;

const GRADE_TEXT: Record<Grade, string> = { pass: '**pass**', partial: 'partial', fail: 'FAIL' };

/** The Markdown report for one or more runs (paths relative to the report). */
export function renderReport(runs: readonly RunResult[], now = new Date()): string {
  const lines: string[] = [];
  lines.push('# Local models on the Delve map chat', '');
  lines.push(`Generated ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC by \`npm run llm-bench\`. Each task starts from a fresh map (the test dungeon or an empty map) and is checked automatically afterwards.`, '');
  lines.push('- **pass**: every check holds. **partial**: at least one core check holds. **FAIL**: no core check holds.');
  lines.push('- **calls**: tool calls the model made; **err**: calls that came back as errors (Delve refused them, unknown tool, unreadable arguments); **malf.**: malformed calls (arguments that needed repair or were not JSON, calls written as text, unknown tool names).');
  lines.push('- **tok/s**: generated tokens per second (server-side generation time when the server reports it). Thinking counts as generated text; **think** is its share of all generated characters.');
  lines.push('- **prompt tok/s**: prompt tokens per second of prompt time, an effective rate: Ollama reuses the cached start of the conversation, so it is high when most of a prompt was cached. **prompt**: the largest prompt of the run, in tokens (compare with num_ctx).');
  lines.push('');
  lines.push('## Summary', '');
  lines.push('| Model | Tools | Pass | Partial | Fail | Calls | Err | Malf. | Time | tok/s | Prompt tok/s | Prompt | Think |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of runs) {
    const s = sumStats(r.tasks.map((t) => t.stats));
    const count = (g: Grade) => r.tasks.filter((t) => t.grade === g).length;
    const think = s.thinkChars + s.outputChars ? Math.round((100 * s.thinkChars) / (s.thinkChars + s.outputChars)) : 0;
    lines.push(`| ${r.model} | ${r.tools}${r.name ? ` (${r.name})` : ''} | ${count('pass')} | ${count('partial')} | ${count('fail')} | ${s.toolCalls} | ${s.toolErrors} | ${malformed(s)} | ${secs(s.wallMs)} | ${rate(tokensPerSecond(s))} | ${rate(promptPerSecond(s))} | ${kTok(s.maxPrompt)} | ${think} % |`);
  }
  lines.push('');
  // one table across runs: task × run
  if (runs.length > 1) {
    const tasks = [...new Map(runs.flatMap((r) => r.tasks.map((t) => [t.task, t] as const))).values()].sort((a, b) => a.n - b.n);
    lines.push('## Tasks by model', '');
    lines.push(`| # | Task | ${runs.map(runName).join(' | ')} |`);
    lines.push(`|---|---|${runs.map(() => '---').join('|')}|`);
    for (const t of tasks) {
      const cells = runs.map((r) => {
        const x = r.tasks.find((y) => y.task === t.task);
        return x ? `${GRADE_TEXT[x.grade]} ${x.checks.filter((c) => c.ok).length}/${x.checks.length}` : '–';
      });
      lines.push(`| ${t.n} | ${cell(t.title)} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  for (const r of runs) {
    lines.push(`## ${runName(r)}`, '');
    const sz = r.size;
    lines.push(
      `${r.api === 'ollama' ? `Ollama ${r.serverVersion ?? ''} native API` : 'OpenAI-compatible API'} at ${r.baseUrl}${r.numCtx ? `, num_ctx ${r.numCtx}` : ''}${r.think ? `, think ${r.think}` : ''}. ` +
        `${r.toolCount} tools; system prompt ${kTok(sz.system)} characters, tool definitions ${kTok(sz.tools)}, first message ${kTok(sz.user)}. ` +
        (r.steps ? `Helping steps: ${r.steps}. ` : '') +
        `Delve ${r.delveVersion}; ${r.started.slice(0, 16).replace('T', ' ')} to ${r.finished.slice(11, 16)} UTC${r.warmupMs ? `; loading the model took ${secs(r.warmupMs)} (not counted)` : ''}.`,
      '',
    );
    lines.push('| # | Task | Result | Checks | Calls | Err | Malf. | Time | tok/s | Stop | Answer |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const t of r.tasks) {
      const ok = t.checks.filter((c) => c.ok).length;
      lines.push(
        `| ${t.n} | ${cell(t.title)} | ${GRADE_TEXT[t.grade]} | ${ok}/${t.checks.length} | ${t.stats.toolCalls} | ${t.stats.toolErrors} | ${malformed(t.stats)} | ${secs(t.stats.wallMs)} | ${rate(tokensPerSecond(t.stats))} | ${t.stop}${t.error ? ` (${oneLine(t.error, 60)})` : ''} | ${oneLine(t.answer || (t.lastText ? `(no final answer; last said: ${t.lastText})` : '(none)'))} |`,
      );
    }
    lines.push('');
    for (const t of r.tasks) {
      const failed = t.checks.filter((c) => !c.ok);
      const pics = [t.png ? `[picture](${t.png})` : '', t.transcript ? `[transcript](${t.transcript})` : ''].filter(Boolean).join(' · ');
      lines.push(`- **${t.n}. ${cell(t.title)}** (${t.grade}) ${pics}`);
      if (failed.length) lines.push(`  - not met: ${failed.map((c) => `${c.name}${c.detail ? ` (${oneLine(c.detail, 120)})` : ''}`).join('; ')}`);
      const held = t.stats.notRun ? `; ${t.stats.notRun} held back after a failed call (⊘)` : '';
      const back = t.stats.finalChecks ? '; the final check handed problems back once' : '';
      lines.push(`  - calls: ${t.callLog ? oneLine(t.callLog, 400) : 'none'}${held}${back}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
