// Starting maps, made procedurally from a seed: dungeons of varied size,
// shape and room count (some rooms furnished, some with pillars, stairs,
// water or a floor texture), outdoor maps (ground, water, roads, hills,
// cliffs, forests, a few buildings), small maps of one to three rooms, and
// empty maps, in feet and in metres. They are built with Quillwarren's own tools
// (tools.ts `setup`, never shown to the model) and kept only when check_map
// finds nothing wrong, so every conversation starts from a clean map.
// The llm-bench "test-dungeon" template is never used.
import { checkMap, doorCentre as doorCentreOf, PRESETS, type DelveMap } from '@delve/core';
import type { Json } from '../../chat/local-agent.ts';
import { Quillwarren, type ToolRun } from './delve.ts';
import { boxGap, ofType, toBounds, type Rect } from './kit.ts';
import { hashSeed, Rng } from './rng.ts';
import { THEME_OF_KIND, THEMES } from './themes.ts';
import { CORNERS, hiddenArgs, SIDES, setup, warns, type Call, type DoorStyle, type Side } from './tools.ts';
import { DUNGEON_NAMES, EMPTY_NAMES, NOTES, OUTDOOR_NAMES, ROOM_KINDS } from './words.ts';

export type MapKind = 'dungeon' | 'small' | 'outdoor' | 'empty';
export const MAP_KINDS: readonly MapKind[] = ['dungeon', 'small', 'outdoor', 'empty'];

export interface StartSpec {
  kind: MapKind;
  seed: number;
  /** Rooms get furniture (some of them). */
  furnished?: boolean;
  /** Force feet or metres (default: chosen by the seed). */
  unit?: 'ft' | 'm';
  /** Room count range for dungeons. */
  rooms?: [number, number];
  /** Layout problems put in on purpose after the clean build (the fix_problems family): how many. */
  inject?: number;
}

export interface RoomInfo {
  id: string;
  /** The kind from words.ts (guard, library…), when it was named after one. */
  kind?: string;
  furnished: boolean;
}

export interface StartMap {
  mapId: string;
  spec: StartSpec;
  rooms: RoomInfo[];
  /** Outdoor maps: the ground's rectangle. */
  area?: Rect;
  /** Setup calls that went through (for the stats). */
  calls: number;
  /** The problems put in on purpose: kind and the object made for it. */
  injected?: { kind: 'outside' | 'overlap' | 'door' | 'doorway'; id: string; room: string }[];
}

/**
 * Put layout problems on a clean map on purpose (a prop half outside a room,
 * two props on each other, a door floating inside a room, a prop in a
 * doorway), as raw ops: the fix_problems family has the model find them with
 * check_map and fix them. Each one is kept only if check_map then lists it.
 */
function injectProblems(delve: Quillwarren, mapId: string, rng: Rng, count: number): NonNullable<StartMap['injected']> {
  const out: NonNullable<StartMap['injected']> = [];
  const kinds = rng.shuffle(['outside', 'overlap', 'door', 'doorway'] as const);
  for (const kind of kinds) {
    if (out.length >= count) break;
    const map = delve.get(mapId).map;
    const rooms = ofType(map, 'room').filter((r) => 'rect' in r.shape && r.shape.rect[2] >= 4 && r.shape.rect[3] >= 4);
    if (!rooms.length) break;
    const room = rng.pick(rooms);
    const [x, y, w, h] = (room.shape as { rect: Rect }).rect;
    const nextProp = (k = 0) => `i${Math.max(0, ...map.objects.filter((o) => /^i\d+$/.test(o.id)).map((o) => Number(o.id.slice(1)))) + 1 + k}`;
    const ops: { op: 'add'; object: Record<string, unknown> }[] = [];
    let id = '';
    if (kind === 'outside') {
      id = nextProp();
      const side = rng.pick(SIDES);
      const at = side === 'west' ? [x, y + rng.int(1, h - 2) + 0.5] : side === 'east' ? [x + w, y + rng.int(1, h - 2) + 0.5] : side === 'north' ? [x + rng.int(1, w - 2) + 0.5, y] : [x + rng.int(1, w - 2) + 0.5, y + h];
      ops.push({ op: 'add', object: { id, type: 'prop', asset: rng.pick(['barrel', 'chest-closed', 'crate', 'statue', 'urns']), at } });
    } else if (kind === 'overlap') {
      id = nextProp();
      const at = [x + rng.int(1, w - 2) + 0.5, y + rng.int(1, h - 2) + 0.5];
      ops.push({ op: 'add', object: { id, type: 'prop', asset: rng.pick(['barrel', 'crate', 'chest-closed', 'statue']), at } });
      ops.push({ op: 'add', object: { id: nextProp(1), type: 'prop', asset: rng.pick(['barrel', 'crate', 'brazier', 'statue']), at: [at[0]! + 0.25, at[1]!] } });
    } else if (kind === 'door') {
      id = `d${Math.max(0, ...map.objects.filter((o) => /^d\d+$/.test(o.id)).map((o) => Number(o.id.slice(1)))) + 1}`;
      ops.push({ op: 'add', object: { id, type: 'door', at: [x + rng.int(1, w - 3), y + rng.int(2, h - 2)], along: 'x', width: 1, style: rng.pick(['normal', 'locked']) } });
    } else {
      const door = ofType(map, 'door').find((d) => {
        const c = doorCentreOf(d);
        return Math.abs(c[0] - x) < 0.01 || Math.abs(c[0] - x - w) < 0.01 || Math.abs(c[1] - y) < 0.01 || Math.abs(c[1] - y - h) < 0.01 ? c[0] >= x && c[0] <= x + w && c[1] >= y && c[1] <= y + h : false;
      });
      if (!door) continue;
      const c = doorCentreOf(door);
      const at = Math.abs(c[0] - x) < 0.01 ? [x + 0.5, c[1]] : Math.abs(c[0] - x - w) < 0.01 ? [x + w - 0.5, c[1]] : Math.abs(c[1] - y) < 0.01 ? [c[0], y + 0.5] : [c[0], y + h - 0.5];
      id = nextProp();
      ops.push({ op: 'add', object: { id, type: 'prop', asset: rng.pick(['barrel', 'crate', 'chest-closed']), at } });
    }
    const before = checkMap(map).length;
    try {
      delve.service.apply(mapId, ops as never, { by: 'llm-train' });
    } catch {
      continue;
    }
    const after = checkMap(delve.get(mapId).map);
    if (after.length > before && after.some((p) => p.ids.includes(id))) out.push({ kind, id, room: room.id });
    else delve.service.undo(mapId, 'llm-train');
  }
  return out;
}

const FEET = ['5 ft', '5 ft', '5 ft', '5 ft', '5 ft', '5 ft', '10 ft'];
const METRES = ['1.5 m', '1.5 m', '1.5 m', '2 m', '1 m'];

function pickUnit(rng: Rng, spec: StartSpec): string {
  const wantMetric = spec.unit ? spec.unit === 'm' : rng.chance(spec.kind === 'outdoor' ? 0.45 : 0.3);
  return rng.pick(wantMetric ? METRES : FEET);
}

function pickStyle(rng: Rng): string {
  const styles = Object.keys(PRESETS);
  const want: [string, number][] = [
    ['classic-hatching', 60],
    ['clean', 12],
    ['old-school-blue', 10],
    ['print', 6],
    ['parchment', 12],
  ];
  return rng.weighted(want.filter(([s]) => styles.includes(s)));
}

/** A map id from the seed: map_ and 12 hex digits, like Quillwarren's own. */
export function mapIdFor(seed: number): string {
  const a = hashSeed(seed, 'id-a').toString(16).padStart(8, '0');
  const b = hashSeed(seed, 'id-b').toString(16).padStart(8, '0');
  return `map_${(a + b).slice(0, 12)}`;
}

/** Applies setup calls to the map, undoing any that fails, warns or leaves a layout problem. */
class Builder {
  readonly delve: Quillwarren;
  readonly mapId: string;
  calls = 0;
  constructor(delve: Quillwarren, mapId: string) {
    this.delve = delve;
    this.mapId = mapId;
  }

  get map(): DelveMap {
    return this.delve.get(this.mapId).map;
  }

  /** Run calls as one attempt; if any fails, warns or adds a problem, undo all of them. */
  async try(...calls: Call[]): Promise<ToolRun[] | null> {
    const problems = checkMap(this.map).length;
    const runs: ToolRun[] = [];
    let changes = 0;
    let ok = true;
    for (const c of calls) {
      const rev = this.delve.get(this.mapId).rev;
      // add_props_along picks a random seed unless given one: give one, so the map repeats
      const seed = hashSeed(this.mapId, rev, c.name, JSON.stringify(c.args)) % 2_000_000_000 + 1;
      const r = await this.delve.call(this.mapId, c.name, { ...c.args, ...hiddenArgs(c.name, this.mapId, seed) } as Json);
      runs.push(r);
      if (r.rev > rev) changes++;
      if (r.isError || warns(r.text)) {
        ok = false;
        break;
      }
    }
    if (ok && checkMap(this.map).length > problems) ok = false;
    if (!ok) {
      // back to where this attempt began (an undo is a change of its own, so count, don't compare revs)
      for (; changes > 0; changes--) await this.delve.call(this.mapId, 'undo', { map: this.mapId });
      return null;
    }
    this.calls += calls.length;
    return runs;
  }
}

const sizeOf = (rng: Rng, big = false): [number, number] => {
  const w = big ? rng.int(7, 14) : rng.weighted<number>([[3, 1], [4, 4], [5, 4], [6, 5], [7, 3], [8, 3], [9, 2], [10, 2], [12, 1]]);
  const h = big ? rng.int(6, 12) : rng.weighted<number>([[3, 1], [4, 4], [5, 4], [6, 5], [7, 3], [8, 2], [9, 1], [10, 1]]);
  return [w, h];
};

/** A rectangle on `side` of `base`, `gap` away, lined up or offset. */
function besideRect(rng: Rng, base: Rect, side: Side, w: number, h: number, gap: number): Rect {
  const [bx, by, bw, bh] = base;
  if (side === 'east' || side === 'west') {
    const x = side === 'east' ? bx + bw + gap : bx - gap - w;
    // mostly overlapping in y so a corridor can run straight; sometimes offset (an L-shaped corridor)
    const lo = rng.chance(0.75) ? by - h + 2 : by - h - 2;
    const hi = rng.chance(0.75) ? by + bh - 2 : by + bh + 2;
    return [x, rng.int(Math.min(lo, hi), Math.max(lo, hi)), w, h];
  }
  const y = side === 'south' ? by + bh + gap : by - gap - h;
  const lo = rng.chance(0.75) ? bx - w + 2 : bx - w - 2;
  const hi = rng.chance(0.75) ? bx + bw - 2 : bx + bw + 2;
  return [rng.int(Math.min(lo, hi), Math.max(lo, hi)), y, w, h];
}

const DOOR_MIX: [DoorStyle, number][] = [
  ['normal', 60],
  ['locked', 10],
  ['secret', 6],
  ['double', 7],
  ['portcullis', 4],
  ['archway', 13],
];
const ENDS: ['none' | 'from' | 'to' | 'both', number][] = [
  ['to', 45],
  ['both', 25],
  ['from', 15],
  ['none', 15],
];

const KIND_MIX: [string, number][] = Object.keys(ROOM_KINDS).map((k) => [k, k === 'plain' ? 3 : k === 'hall' || k === 'store' || k === 'guard' ? 2 : 1]);

/** Pillars in a big room: two or four, two squares in from the walls. */
function pillars(r: Rect, four: boolean): Rect[] {
  const [x, y, w, h] = r;
  const out: Rect[] = [
    [x + 2, y + 2, 1, 1],
    [x + w - 3, y + 2, 1, 1],
  ];
  if (four) out.push([x + 2, y + h - 3, 1, 1], [x + w - 3, y + h - 3, 1, 1]);
  return out;
}

async function furnishSome(b: Builder, rng: Rng, roomId: string, kind: string | undefined): Promise<boolean> {
  const theme = THEMES.find((t) => t.id === (kind ? THEME_OF_KIND[kind] : undefined)) ?? rng.pick(THEMES);
  let placed = 0;
  // the theme's first two or three steps that stand on their own (no "around"/"near": those need an id)
  for (const step of theme.steps.slice(0, rng.int(2, 3))) {
    const p = step.place;
    let place: string;
    if (p.kind === 'center') place = 'center';
    else if (p.kind === 'wall') place = `${p.side ?? rng.pick(SIDES)} wall`;
    else if (p.kind === 'corner') place = `${p.corner ?? rng.pick(CORNERS)} corner`;
    else continue;
    if (await b.try(setup.propIn(step.asset, roomId, place, step.count))) placed++;
  }
  return placed > 0;
}

async function buildDungeon(b: Builder, rng: Rng, spec: StartSpec, out: StartMap): Promise<void> {
  const [lo, hi] = spec.rooms ?? (spec.kind === 'small' ? [1, 3] : rng.chance(0.12) ? [10, 16] : [3, 10]);
  const want = rng.int(lo, hi);
  const rects: { id: string; rect: Rect }[] = [];
  const usedNames = new Set<string>();
  const nameFor = (): { name?: string; kind?: string } => {
    if (!rng.chance(0.75)) return {};
    for (let k = 0; k < 6; k++) {
      const kind = rng.weighted(KIND_MIX);
      const name = rng.pick(ROOM_KINDS[kind]!);
      if (!usedNames.has(name)) {
        usedNames.add(name);
        return { name, kind };
      }
    }
    return {};
  };
  const addRoom = async (rect: Rect, parent?: string): Promise<boolean> => {
    const named = nameFor();
    const shapeKind = rects.length && rect[2] >= 5 && rect[3] >= 5 && rect[2] === rect[3] ? rng.weighted<'rect' | 'octagon' | 'circle'>([['rect', 80], ['octagon', 12], ['circle', 8]]) : 'rect';
    const notes = rng.chance(0.15) ? rng.pick(NOTES) : undefined;
    const extra = { ...(named.name ? { name: named.name } : {}), ...(notes ? { notes } : {}) };
    const add = shapeKind === 'octagon' ? setup.roomPreset('octagon', rect, extra) : shapeKind === 'circle' ? setup.roomCircle([rect[0] + rect[2] / 2, rect[1] + rect[3] / 2, rect[2] / 2], extra) : setup.roomRect(rect, extra);
    const id = `r${rects.length + 1}`;
    const calls: Call[] = [add];
    if (parent) {
      const ends = rng.weighted(ENDS);
      calls.push(setup.connect(parent, id, ends, ends === 'none' ? undefined : rng.weighted(DOOR_MIX), rng.chance(0.15) ? 1 : undefined));
    }
    const r = await b.try(...calls);
    if (!r) return false;
    const real = r[0]!.added.find((o) => o.type === 'room');
    rects.push({ id: real?.id ?? id, rect });
    out.rooms.push({ id: real?.id ?? id, ...(named.kind ? { kind: named.kind } : {}), furnished: false });
    return true;
  };
  const [w0, h0] = sizeOf(rng, rng.chance(0.3));
  await addRoom([rng.int(0, 6), rng.int(0, 6), w0, h0]);
  let attempts = 0;
  while (rects.length < want && attempts++ < want * 25) {
    const parent = rng.chance(0.5) ? rects[rects.length - 1]! : rng.pick(rects);
    const side = rng.pick(SIDES);
    const [w, h] = sizeOf(rng, rng.chance(0.15));
    const rect = besideRect(rng, parent.rect, side, w, h, rng.int(2, 5));
    if (rect[0] < 0 || rect[1] < 0) continue;
    if (rects.some((o) => boxGap(toBounds(o.rect), toBounds(rect)) < 2)) continue;
    await addRoom(rect, parent.id);
  }
  // a loop or two: rooms close together that aren't joined yet
  for (let k = rng.int(0, 2); k > 0 && rects.length > 3; k--) {
    const a = rng.pick(rects);
    const near = rects.filter((o) => o.id !== a.id && boxGap(toBounds(o.rect), toBounds(a.rect)) <= 7 && !ofType(b.map, 'corridor').some((c) => (c.from === a.id && c.to === o.id) || (c.to === a.id && c.from === o.id)));
    if (!near.length) continue;
    const ends = rng.weighted(ENDS);
    await b.try(setup.connect(a.id, rng.pick(near).id, ends, ends === 'none' ? undefined : rng.weighted(DOOR_MIX)));
  }
  // a way in from outside
  if (rng.chance(0.5)) {
    for (const side of rng.shuffle(SIDES)) if (await b.try(setup.doorOnWall(rects[0]!.id, side, rng.weighted<DoorStyle>([['normal', 5], ['double', 2], ['portcullis', 1], ['archway', 2]])))) break;
  }
  for (const r of rects) {
    const [, , w, h] = r.rect;
    if (w >= 8 && h >= 7 && rng.chance(0.3)) await b.try(...pillars(r.rect, rng.chance(0.5)).map(setup.pillar));
    if (w >= 5 && h >= 5 && rng.chance(0.08)) {
      const c = rng.pick(CORNERS);
      const [x, y] = [c.includes('w') ? r.rect[0] + 1 : r.rect[0] + w - 3, c.includes('n') ? r.rect[1] + 1 : r.rect[1] + h - 3];
      await b.try(setup.stairs([x, y, 2, 2], rng.pick(['n', 'e', 's', 'w'] as const)));
    }
    if (rng.chance(0.08)) {
      const asset = rng.pick(['water-shallow', 'rubble-field', 'flagstones', 'carpet', 'c-floor-planks-oak', 'c-floor-dungeon', 'c-floor-flagstones', 'mud']);
      await b.try(setup.terrainRegion(asset, { in: r.id }));
    }
  }
  if (spec.furnished) {
    for (const info of out.rooms) {
      if (!rng.chance(0.55)) continue;
      info.furnished = await furnishSome(b, rng, info.id, info.kind);
    }
  }
  // now and then trees outside, or a title
  if (rng.chance(0.08)) await b.try(setup.propsRegion(rng.pick(['c-oak-a', 'c-pine-a', 'c-birch-a', 'tree']), { edge: rng.pick(SIDES), depth: rng.int(3, 5) }));
  if (rng.chance(0.08)) {
    const r0 = rects[0]!.rect;
    await b.try(setup.label(rng.pick(['Entrance', 'Way in', 'Upper level', 'To the surface']), [r0[0] + r0[2] / 2, r0[1] - 1]));
  }
}

const GROUND: [string, number][] = [
  ['grass', 35],
  ['c-ground-grass-short', 15],
  ['c-ground-meadow', 8],
  ['snow', 7],
  ['sand', 7],
  ['dirt', 6],
  ['c-ground-forest-floor', 7],
  ['swamp', 5],
  ['c-ground-grass-dry', 5],
  ['moss', 5],
];
const TREES = ['c-oak-a', 'c-pine-a', 'c-birch-a', 'c-beech-a', 'c-fir-a', 'c-spruce-a', 'tree', 'c-maple-a'];

async function buildOutdoor(b: Builder, rng: Rng, out: StartMap): Promise<void> {
  const W = rng.int(22, 44);
  const H = rng.int(16, 32);
  out.area = [0, 0, W, H];
  const ground = rng.weighted(GROUND);
  await b.try(setup.terrainRect(ground, [0, 0, W, H], rng.chance(0.3) ? 'Ground' : undefined));
  const u = b.map.grid.unit ?? '5 ft';
  const isMetric = / m$/.test(u);
  const spot = (margin: number): [number, number] => [rng.int(margin, Math.max(margin, W - margin)), rng.int(margin, Math.max(margin, H - margin))];
  if (rng.chance(0.4)) {
    const r = rng.int(2, 5);
    const [cx, cy] = spot(r + 2);
    await b.try(setup.terrainCircle(rng.pick(['water-shallow', 'water-deep', 'c-water-pond', 'c-water-calm']), [cx, cy, r], rng.pick(['Pond', 'Pool', 'Lake', undefined] as const)));
  }
  if (rng.chance(0.25)) {
    const x1 = rng.int(4, W - 4);
    const x2 = Math.min(W - 3, Math.max(3, x1 + rng.int(-6, 6)));
    await b.try(setup.terrainRegion(rng.pick(['water-deep', 'c-water-river', 'water-shallow']), { between: [[x1, 0], [x2, H]], width: rng.int(2, 4) }, 'River'));
  }
  if (rng.chance(0.35)) {
    const y1 = rng.int(3, H - 3);
    const y2 = Math.min(H - 2, Math.max(2, y1 + rng.int(-5, 5)));
    await b.try(setup.terrainRegion(rng.pick(['dirt', 'cobblestones', 'c-ground-dirt', 'c-ground-gravel']), { between: [[0, y1], [W, y2]], width: rng.int(2, 3) }, rng.pick(['Road', 'Path', 'Track', undefined] as const)));
  }
  if (rng.chance(0.4)) {
    const s = rng.int(4, 9);
    const [x, y] = [rng.int(1, Math.max(1, W - s - 1)), rng.int(1, Math.max(1, H - s - 1))];
    const hgt = isMetric ? rng.pick([2, 3, 4, 5, 6]) : rng.pick([5, 10, 15, 20]);
    await b.try(setup.height(rng.chance(0.5) ? { rect: [x, y, s, s] } : { circle: [x + s / 2, y + s / 2, s / 2] }, hgt, 'slope', rng.pick(['Hill', 'Knoll', undefined] as const)));
  }
  if (rng.chance(0.15)) {
    const [w, h] = [rng.int(4, 8), rng.int(3, 6)];
    const [x, y] = [rng.int(1, Math.max(1, W - w - 1)), rng.int(1, Math.max(1, H - h - 1))];
    await b.try(setup.height({ rect: [x, y, w, h] }, isMetric ? rng.pick([3, 4, 6]) : rng.pick([10, 15, 20]), rng.pick(['cliff', 'rock'] as const), rng.pick(['Ledge', 'Crag', 'Plateau', undefined] as const)));
  }
  // buildings: a cabin or two
  const nb = rng.weighted<number>([[0, 55], [1, 30], [2, 12], [3, 3]]);
  for (let k = 0; k < nb; k++) {
    const [w, h] = [rng.int(4, 8), rng.int(4, 7)];
    const [x, y] = [rng.int(2, Math.max(2, W - w - 2)), rng.int(2, Math.max(2, H - h - 2))];
    const name = rng.pick(['Cabin', 'Hut', 'Shed', 'Watchtower', 'Chapel', 'Farmhouse', 'Mill', 'Barn', undefined] as const);
    const id = `r${ofType(b.map, 'room').length + 1}`;
    const r = await b.try(setup.roomRect([x, y, w, h], name ? { name } : {}), setup.doorOnWall(id, rng.pick(SIDES), 'normal'));
    if (r) out.rooms.push({ id, ...(name ? { kind: 'plain' } : {}), furnished: false });
  }
  if (rng.chance(0.5)) await b.try(setup.propsRegion(rng.pick(TREES), { edge: rng.pick(SIDES), depth: rng.int(3, 6) }));
  if (rng.chance(0.2)) await b.try(setup.propsRegion(rng.pick(['c-boulder-a', 'boulder', 'c-rock-pile', 'c-bush-a']), { corner: rng.pick(CORNERS), size: rng.int(4, 8) }));
  if (rng.chance(0.15)) {
    const [x, y] = spot(4);
    await b.try(setup.propAt('tent', [x, y]));
    await b.try(setup.propAt('campfire', [x + 2.5, y + 0.5]));
  }
  for (const info of out.rooms) if (rng.chance(0.4)) info.furnished = await furnishSome(b, rng, info.id, rng.pick(['bedroom', 'store', 'kitchen', 'guard']));
}

/**
 * Build the starting map for a spec on a scratch Quillwarren (failed tries are
 * undone there), then put the finished map into `delve` as a new map whose
 * history starts at a rev between 1 and about 60, like a map that has been
 * worked on. The same spec always gives the same map (id, objects, rev), which
 * the replay check relies on. A spec whose map comes out with a layout problem
 * is built again from a derived seed.
 */
export async function buildStart(delve: Quillwarren, spec: StartSpec): Promise<StartMap> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const rng = new Rng(hashSeed(spec.seed, 'map', attempt));
    const kind = spec.kind;
    const unit = pickUnit(rng, spec);
    const style = pickStyle(rng);
    const name = kind === 'outdoor' ? rng.pick(OUTDOOR_NAMES) : kind === 'empty' ? rng.pick(EMPTY_NAMES) : rng.pick(DUNGEON_NAMES);
    const mapId = mapIdFor(hashSeed(spec.seed, attempt));
    const seed = rng.int(1, 2 ** 31 - 1);
    const scratch = await Quillwarren.open();
    try {
      scratch.createMap({ id: mapId, name, unit, style, seed });
      const b = new Builder(scratch, mapId);
      const out: StartMap = { mapId, spec, rooms: [], calls: 0 };
      if (kind === 'dungeon' || kind === 'small') await buildDungeon(b, rng, spec, out);
      else if (kind === 'outdoor') await buildOutdoor(b, rng, out);
      out.calls = b.calls;
      const map = scratch.get(mapId).map;
      const enough = kind === 'empty' || (kind === 'outdoor' ? map.objects.length > 0 : ofType(map, 'room').length >= (spec.rooms?.[0] ?? (kind === 'small' ? 1 : 3)));
      if (!enough || checkMap(map).length) continue;
      delve.createMap({ id: mapId, name, unit, style, seed, objects: map.objects });
      // a history of earlier edits: the rev the context block shows (no-op changes, nothing on the map moves)
      const bumps = kind === 'empty' ? rng.weighted<number>([[0, 70], [1, 20], [3, 10]]) : rng.weighted<number>([[0, 15], [rng.int(1, 10), 35], [rng.int(10, 40), 35], [rng.int(40, 90), 15]]);
      for (let k = 0; k < bumps; k++) delve.service.apply(mapId, [{ op: 'update_map', set: { seed } }], { by: 'llm-train' });
      if (spec.inject) out.injected = injectProblems(delve, mapId, rng.fork('inject'), spec.inject);
      if (spec.inject && !out.injected?.length) {
        delve.service.store.delete(mapId);
        continue;
      }
      return out;
    } finally {
      await scratch.close();
    }
  }
  throw new Error(`no clean starting map for ${spec.kind} seed ${spec.seed}`);
}
