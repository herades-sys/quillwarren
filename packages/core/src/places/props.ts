// Props by place, not coordinates: MCP add_prop {"in": "r2", "place": "north
// wall"} puts a bar counter against the inside of room 2's north wall, turned
// to face into the room; "ne corner", "center", "near i3" and "around i1"
// (four chairs round a table, with count) work the same way. The code finds a
// free spot inside the room: the whole footprint on its floor (cutouts and
// stairs left out), off the other props (floor props such as rugs only avoid
// each other) and out of the doorways (doors and corridor mouths keep 1.5
// squares in front of them clear). Pure: the tool turns the result into ops.
import { assetInfo, propBounds } from '../assets/catalog.ts';
import { corridorRoute, endMouth, roomsById, corridorPath } from '../geometry/corridors.ts';
import { doorSegment } from '../geometry/doors.ts';
import { pointInShape, shapeBounds, type Bounds, type Polygon } from '../geometry/shapes.ts';
import type { DelveMap, Point } from '../schema.ts';
import { ValidationError } from '../validate.ts';
import {
  boxCentre,
  boxGap,
  boxH,
  boxOverlap,
  boxPath,
  boxW,
  CORNER_WORDS,
  cornerOf,
  fmt,
  squares,
  inflateBox,
  inPolygons,
  minus,
  needArea,
  objectArea,
  onFloorLayer,
  r2,
  roomAt,
  sideOf,
  SIDE_VECTOR,
  standsUp,
  type Corner,
  type ObjectArea,
  type Side,
} from './common.ts';
import { polygonsOf, floorPaths } from '../geometry/floor.ts';

export type PlaceSpec = { kind: 'center' } | { kind: 'wall'; side: Side } | { kind: 'corner'; corner: Corner } | { kind: 'near'; id: string } | { kind: 'around'; id: string };

export const PLACE_WORDS = ['center', 'north wall', 'south wall', 'east wall', 'west wall', 'ne corner', 'nw corner', 'se corner', 'sw corner', 'near <id>', 'around <id>'] as const;

/** "north wall", "against the north wall", "NE corner", "middle", "near i3", "around i1"… */
export function parsePlace(text: string): PlaceSpec {
  const t = String(text).trim().toLowerCase().replace(/\s+/g, ' ');
  const bad = () =>
    new ValidationError([`place: one of ${PLACE_WORDS.join(', ')} (e.g. "north wall", "ne corner", "around i1"), got ${JSON.stringify(text)}`]);
  if (/^(the )?(center|centre|middle|mid)( of (the )?room)?$/.test(t)) return { kind: 'center' };
  let m = /^(?:next to|beside|near|by|close to) (?:the )?([a-z][a-z0-9_-]*)$/.exec(t);
  if (m) return { kind: 'near', id: String(text).trim().split(/\s+/).pop()! };
  m = /^(?:around|round|surrounding|circling) (?:the )?([a-z][a-z0-9_-]*)$/.exec(t);
  if (m) return { kind: 'around', id: String(text).trim().split(/\s+/).pop()! };
  m = /^(?:(?:in|at) )?(?:the )?(.+?) corner$/.exec(t) ?? /^corner (.+)$/.exec(t);
  if (m) {
    const c = cornerOf(m[1]!);
    if (c) return { kind: 'corner', corner: c };
    throw bad();
  }
  m = /^(?:(?:against|along|on|at|by) )?(?:the )?(.+?) wall$/.exec(t) ?? /^wall (.+)$/.exec(t);
  if (m) {
    const s = sideOf(m[1]!);
    if (s) return { kind: 'wall', side: s };
    throw bad();
  }
  const c = cornerOf(t);
  if (c) return { kind: 'corner', corner: c };
  const s = sideOf(t);
  if (s) return { kind: 'wall', side: s };
  throw bad();
}

export interface PlaceRequest {
  asset: string;
  /** The room or area to place it in (default: the room around the near / around target). */
  in?: string;
  /** Default "center". */
  place?: string;
  /** How many (default 1; around: 4). */
  count?: number;
  /** Turns every copy this way (center, corners, near, around). Against a wall it is left out: there a prop always faces into the room, and the notes say so. */
  rotation?: number;
  scale?: number;
}

export interface PlacedProp {
  asset: string;
  at: Point;
  rotation: number;
  /** "against the north wall of room 2 Crossroads (r2), facing south". */
  where: string;
}

export interface PlaceResult {
  placed: PlacedProp[];
  /** The room or area they went in (none: outdoors, around a prop that stands outside every room). */
  container?: ObjectArea;
  /** Asked for more than fit. */
  missing: number;
  notes: string[];
}

/** Which way a prop faces at a rotation (fronts face south at 0). */
const FACING: Record<number, string> = { 0: 'south', 90: 'west', 180: 'north', 270: 'east' };
/** The rotation that turns a prop's back to a wall on this side (it faces into the room). */
const BACK_TO: Record<Side, number> = { north: 0, east: 90, south: 180, west: 270 };
/** The rotation that turns a prop on this side of another to face it (a chair north of a table faces south). */
const FACE_TOWARD: Record<Side, number> = BACK_TO;
const turnOf = (deg: number) => ((Math.round(deg) % 360) + 360) % 360;

interface Block {
  b: Bounds;
  id: string;
}

/** The ground the prop must stay on: the room (or area) minus its cutouts, or around an outdoor target the land off every room and corridor. */
function groundOf(map: DelveMap, container: ObjectArea | undefined, near: Bounds | undefined): Polygon[] {
  if (container) {
    const cuts = map.objects.flatMap((o) => (o.type === 'cutout' && boxOverlap(shapeBounds(o.shape), container.bounds) > 0 ? (objectArea(map, o.id)?.paths ?? []) : []));
    return container.object.type === 'room' ? polygonsOf(minus(container.paths, cuts)) : container.polygons;
  }
  const around = inflateBox(near!, 8);
  return polygonsOf(minus(boxPath(around), floorPaths(map)));
}

/** Doorways of a room: in front of its doors and corridor mouths, `depth` squares into it. */
export function doorwayZones(map: DelveMap, room: ObjectArea, depth = 1.5): Block[] {
  if (room.object.type !== 'room') return [];
  const shape = room.object.shape;
  const out: Block[] = [];
  const zone = (a: Point, b: Point, id: string) => {
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let n: Point = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    if (!pointInShape(shape, [mid[0] + n[0] * 0.3, mid[1] + n[1] * 0.3])) n = [-n[0], -n[1]];
    if (!pointInShape(shape, [mid[0] + n[0] * 0.3, mid[1] + n[1] * 0.3])) return; // not on this room's edge
    const pts = [a, b, [a[0] + n[0] * depth, a[1] + n[1] * depth], [b[0] + n[0] * depth, b[1] + n[1] * depth]] as Point[];
    out.push({ id, b: { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) } });
  };
  const nearOutline = (p: Point) => {
    // within 0.35 of the room's outline: inside on one side, outside on the other
    for (const [dx, dy] of [[0.35, 0], [-0.35, 0], [0, 0.35], [0, -0.35]] as const) {
      if (pointInShape(shape, [p[0] + dx, p[1] + dy]) !== pointInShape(shape, [p[0] - dx, p[1] - dy])) return true;
    }
    return false;
  };
  const rooms = roomsById(map);
  for (const o of map.objects) {
    if (o.type === 'door') {
      const [a, b] = doorSegment(o);
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (nearOutline(mid)) zone(a, b, o.id);

    } else if (o.type === 'corridor') {
      const route = corridorRoute(o, rooms);
      if (route && (o.from === room.id || o.to === room.id)) {
        const mouth = o.from === room.id ? route.mouths[0] : route.mouths[1];
        zone(mouth[0], mouth[1], o.id);
      } else {
        const path = corridorPath(o, rooms);
        if (!path || path.length < 2) continue;
        for (const end of ['start', 'end'] as const) {
          const [a, b] = endMouth(path, end, o.width);
          if (nearOutline([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) zone(a, b, o.id);
        }
      }
    }
  }
  return out;
}

/** What a new prop must keep off: props at its own level, stairs, cutouts, and for standing props the doorways. */
function blockersFor(map: DelveMap, asset: string, container: ObjectArea | undefined): Block[] {
  const standing = standsUp(asset);
  const out: Block[] = [];
  for (const o of map.objects) {
    if (o.type === 'prop') {
      if (standing ? standsUp(o.asset) : onFloorLayer(o.asset)) out.push({ id: o.id, b: propBounds(o) });
    } else if (o.type === 'stairs' || o.type === 'cutout') out.push({ id: o.id, b: shapeBounds(o.shape) });
  }
  if (standing && container) out.push(...doorwayZones(map, container));
  return out;
}

/** Is the footprint box on the ground? Sampled just inside its edges and across it, so it may stand flush against a wall. */
function onGround(ground: readonly Polygon[], b: Bounds, rectRoom: Bounds | null): boolean {
  if (rectRoom) return b.x0 >= rectRoom.x0 - 1e-6 && b.y0 >= rectRoom.y0 - 1e-6 && b.x1 <= rectRoom.x1 + 1e-6 && b.y1 <= rectRoom.y1 + 1e-6;
  const e = 0.02;
  const nx = Math.max(1, Math.ceil(boxW(b) / 0.5));
  const ny = Math.max(1, Math.ceil(boxH(b) / 0.5));
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= ny; j++) {
      const x = b.x0 + e + ((boxW(b) - 2 * e) * i) / nx;
      const y = b.y0 + e + ((boxH(b) - 2 * e) * j) / ny;
      if (!inPolygons(ground, [x, y])) return false;
    }
  }
  return true;
}

const clash = (b: Bounds, blocks: readonly Block[], skip?: string) => blocks.find((k) => k.id !== skip && boxOverlap(b, k.b) > 1e-6);

/** The footprint's turned size (rotations in quarter turns swap w and h; others take the bounding box). */
function footprintSize(asset: string, rotation: number, scale = 1): { w: number; h: number } {
  const b = propBounds({ asset, at: [0, 0], rotation, scale });
  return { w: boxW(b), h: boxH(b) };
}

interface Ctx {
  ground: Polygon[];
  rect: Bounds | null;
  blocks: Block[];
  area: Bounds;
}

/** Centres on a half-square lattice (footprint edges on half squares) whose footprint fits in `area`. */
function* lattice(area: Bounds, w: number, h: number): Generator<Point> {
  const x0 = Math.ceil(area.x0 * 2) / 2;
  const y0 = Math.ceil(area.y0 * 2) / 2;
  for (let left = x0; left + w <= area.x1 + 1e-9; left += 0.5) {
    for (let top = y0; top + h <= area.y1 + 1e-9; top += 0.5) yield [left + w / 2, top + h / 2];
  }
}

const boxAt = (c: Point, w: number, h: number): Bounds => ({ x0: c[0] - w / 2, y0: c[1] - h / 2, x1: c[0] + w / 2, y1: c[1] + h / 2 });

function fits(ctx: Ctx, b: Bounds, skip?: string): boolean {
  return onGround(ctx.ground, b, ctx.rect) && !clash(b, ctx.blocks, skip);
}

/** How far a footprint could still move toward `side` and stay on the ground (0: flush against the wall). */
function gapTo(ctx: Ctx, b: Bounds, side: Side): number {
  const [vx, vy] = SIDE_VECTOR[side];
  let g = 0;
  for (; g < 40; g++) {
    const d = (g + 1) * 0.5;
    if (!onGround(ctx.ground, { x0: b.x0 + vx * d, y0: b.y0 + vy * d, x1: b.x1 + vx * d, y1: b.y1 + vy * d }, ctx.rect)) break;
  }
  return g * 0.5;
}

function best(ctx: Ctx, w: number, h: number, score: (c: Point, b: Bounds) => number, skip?: string): { at: Point; score: number } | null {
  let top: { at: Point; score: number } | null = null;
  for (const c of lattice(ctx.area, w, h)) {
    const b = boxAt(c, w, h);
    if (!fits(ctx, b, skip)) continue;
    const s = score(c, b);
    if (!top || s < top.score - 1e-9) top = { at: [r2(c[0]), r2(c[1])], score: s };
  }
  return top;
}

/** The side of box t that point p lies off (the biggest gap). */
function sideOff(t: Bounds, p: Point): Side {
  const gaps: [Side, number][] = [
    ['north', t.y0 - p[1]],
    ['south', p[1] - t.y1],
    ['west', t.x0 - p[0]],
    ['east', p[0] - t.x1],
  ];
  return gaps.sort((a, b) => b[1] - a[1])[0]![0];
}

/**
 * Where `count` copies of a prop go, by meaning. Throws a ValidationError for
 * unknown ids and places that make no sense (a corner without a room).
 */
export function placeProps(map: DelveMap, req: PlaceRequest): PlaceResult {
  const info = assetInfo(req.asset);
  if (!info || info.kind !== 'prop') throw new ValidationError([`asset: "${req.asset}" is not a prop (list_assets finds ids)`]);
  const spec = parsePlace(req.place ?? 'center');
  const notes: string[] = [];
  let target: ObjectArea | undefined;
  if (spec.kind === 'near' || spec.kind === 'around') target = needArea(map, spec.id, 'place');
  let container: ObjectArea | undefined;
  if (req.in !== undefined) {
    container = needArea(map, req.in, 'in');
    if (container.object.type === 'prop' || container.object.type === 'door' || container.object.type === 'label' || container.object.type === 'marker') {
      throw new ValidationError([`in: ${container.title} is not a room or area; use place "near ${container.id}" or "around ${container.id}"`]);
    }
  } else if (target) {
    const room = roomAt(map, boxCentre(target.bounds));
    container = room ? (objectArea(map, room.id) ?? undefined) : undefined;
  } else {
    throw new ValidationError([`in: say which room or area, e.g. {"in": "r2", "place": "${req.place ?? 'center'}"}`]);
  }
  const count = Math.max(1, Math.min(50, Math.floor(req.count ?? (spec.kind === 'around' ? 4 : 1))));
  const ground = groundOf(map, container, target?.bounds);
  const rect = container && container.object.type === 'room' && 'rect' in container.object.shape && !map.objects.some((o) => o.type === 'cutout' && boxOverlap(shapeBounds(o.shape), container!.bounds) > 0) ? container.bounds : null;
  const ctx: Ctx = { ground, rect, blocks: blockersFor(map, req.asset, container), area: container ? container.bounds : inflateBox(target!.bounds, 8) };
  if (target && !ctx.blocks.some((k) => k.id === target!.id)) ctx.blocks.push({ id: target.id, b: target.bounds });
  const inWords = container ? (container.object.type === 'room' ? container.title : `on ${container.title}`) : 'outdoors';
  const placed: PlacedProp[] = [];
  const add = (at: Point, rotation: number, where: string, w: number, h: number) => {
    placed.push({ asset: req.asset, at, rotation, where });
    ctx.blocks.push({ id: `new${placed.length}`, b: boxAt(at, w, h) });
  };
  const given = req.rotation !== undefined ? turnOf(req.rotation) : undefined;
  /** A taken wall with room on another: the call to try there. */
  let wallTry: string | undefined;

  if (spec.kind === 'around') {
    aroundTarget(ctx, req, target!, count, given, inWords, add, notes);
  } else {
    for (let k = 0; k < count; k++) {
      if (spec.kind === 'center') {
        const c = boxCentre(ctx.area);
        // a long prop lies along a long, narrow room
        let rot = given ?? 0;
        if (given === undefined && container) {
          const f0 = footprintSize(req.asset, 0, req.scale);
          const tall = boxH(container.bounds) > boxW(container.bounds) * 1.3;
          const wide = boxW(container.bounds) > boxH(container.bounds) * 1.3;
          if ((tall && f0.w > f0.h) || (wide && f0.h > f0.w)) rot = 90;
        }
        const { w, h } = footprintSize(req.asset, rot, req.scale);
        const hit = best(ctx, w, h, (p) => Math.hypot(p[0] - c[0], p[1] - c[1]));
        if (!hit) break;
        add(hit.at, rot, k === 0 && hit.score < 0.75 ? `in the middle of ${inWords}` : `near the middle of ${inWords}`, w, h);
      } else if (spec.kind === 'wall') {
        const side = spec.side;
        // against a wall a prop always faces into the room: a rotation of its own would turn a long prop across the wall
        const rot = BACK_TO[side];
        if (k === 0 && given !== undefined && given !== rot) notes.push(`Rotation ${given} was left out: against the ${side} wall a prop is turned to face into the room (rotation ${rot}).`);
        const { w, h } = footprintSize(req.asset, rot, req.scale);
        const mid = boxCentre(ctx.area);
        const along = side === 'north' || side === 'south' ? 0 : 1;
        // flush against the wall first (each half square off it outweighs any slide along it), then nearest its middle
        const hit = best(ctx, w, h, (p, b) => gapTo(ctx, b, side) * 1000 + Math.abs(p[along] - mid[along]));
        // which other walls still have room for it flush, so the next try can go there
        const freeWalls = () =>
          (['north', 'south', 'east', 'west'] as const).filter((s2) => {
            if (s2 === side) return false;
            const f = footprintSize(req.asset, BACK_TO[s2], req.scale);
            return best(ctx, f.w, f.h, (_p, b) => gapTo(ctx, b, s2))?.score === 0;
          });
        const roomFor = (free: readonly string[]) => (free.length ? `the ${free.join(', ')} wall${free.length > 1 ? 's have' : ' has'} room for it` : '');
        if (!hit) {
          const walls = freeWalls();
          const free = roomFor(walls);
          if (free) {
            notes.push(`Along the ${side} wall it does not fit (doorways, props or pillars take it); ${free}.`);
            wallTry = tryCall(req, container, `${walls[0]} wall`);
          }
          break;
        }
        const off = gapTo(ctx, boxAt(hit.at, w, h), side);
        const face = `, facing ${FACING[rot]} into the room`;
        let taken = '';
        if (off > 0) {
          const free = roomFor(freeWalls());
          taken = ` (${squares(off)} off it: doorways, props or pillars take the wall${free ? `; ${free}` : ''})`;
        }
        add(hit.at, rot, off === 0 ? `against the ${side} wall of ${inWords}${face}` : `near the ${side} wall of ${inWords}${taken}`, w, h);
      } else if (spec.kind === 'corner') {
        const corner = spec.corner;
        const rot = given ?? (corner === 'ne' || corner === 'nw' ? 0 : 180);
        const { w, h } = footprintSize(req.asset, rot, req.scale);
        const a = ctx.area;
        const tx = corner === 'ne' || corner === 'se' ? a.x1 : a.x0;
        const ty = corner === 'ne' || corner === 'nw' ? a.y0 : a.y1;
        const hit = best(ctx, w, h, (_p, b) => Math.hypot((tx === a.x1 ? b.x1 : b.x0) - tx, (ty === a.y0 ? b.y0 : b.y1) - ty));
        if (!hit) break;
        add(hit.at, rot, hit.score < 0.75 ? `in the ${CORNER_WORDS[corner]} corner of ${inWords}` : `as near the ${CORNER_WORDS[corner]} corner of ${inWords} as is free (${squares(hit.score)} from it)`, w, h);
      } else {
        // near
        const t = target!;
        const rot = given ?? 0;
        const { w, h } = footprintSize(req.asset, rot, req.scale);
        const tc = boxCentre(t.bounds);
        const hit = best(ctx, w, h, (p, b) => boxGap(b, t.bounds) * 10 + Math.hypot(p[0] - tc[0], p[1] - tc[1]) * 0.1);
        if (!hit) break;
        const gap = boxGap(boxAt(hit.at, w, h), t.bounds);
        add(hit.at, rot, `${gap < 0.01 ? 'next to' : `${squares(gap)} from`} ${t.title}, on its ${sideOff(t.bounds, hit.at)} side${container ? ` (${inWords})` : ''}`, w, h);
      }
    }
  }
  const missing = count - placed.length;
  if (missing > 0 && !(wallTry && !placed.length)) {
    // (a wall that is taken while others have room already said so, with what to try)
    const f = footprintSize(req.asset, 0, req.scale);
    const why = container ? `${inWords} has no free spot left for a ${fmt(f.w)}×${fmt(f.h)} footprint (props, stairs, pillars and doorways take the rest)` : 'there is no free spot near it';
    notes.push(`${placed.length ? `Only ${placed.length} of ${count} fit` : count === 1 ? 'It does not fit' : `None of the ${count} fit`}: ${why}.`);
  }
  if (wallTry) notes.push(`Try: ${wallTry}`);
  return { placed, ...(container ? { container } : {}), missing, notes };
}

/** The add_prop call that tries the same prop in another place: `add_prop {"asset": "bar-counter", "in": "r2", "place": "north wall"}`. */
function tryCall(req: PlaceRequest, container: ObjectArea | undefined, place: string): string {
  const args: Record<string, unknown> = { asset: req.asset, ...(container ? { in: container.id } : {}), place, ...(req.count && req.count > 1 ? { count: req.count } : {}) };
  return `add_prop {${Object.entries(args).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}`;
}

/** Copies round a target (chairs round a table): spread over its sides, long sides first, each facing it. */
function aroundTarget(
  ctx: Ctx,
  req: PlaceRequest,
  t: ObjectArea,
  count: number,
  given: number | undefined,
  inWords: string,
  add: (at: Point, rotation: number, where: string, w: number, h: number) => void,
  notes: string[],
): void {
  const tb = t.bounds;
  const sides: Side[] = (['north', 'south', 'west', 'east'] as Side[]).sort((a, b) => sideLen(tb, b) - sideLen(tb, a));
  const base = footprintSize(req.asset, 0, req.scale);
  const cap = new Map<Side, number>(sides.map((s) => [s, Math.max(sideLen(tb, s) >= base.w * 0.5 ? 1 : 0, Math.floor(sideLen(tb, s) / base.w + 1e-9))]));
  const slotsFor = (s: Side, k: number): { at: Point; rot: number; w: number; h: number }[] => {
    const rot = given ?? FACE_TOWARD[s];
    const { w, h } = footprintSize(req.asset, rot, req.scale);
    const len = sideLen(tb, s);
    const out: { at: Point; rot: number; w: number; h: number }[] = [];
    // spread evenly along the side; on half squares when that keeps them apart
    const size = s === 'north' || s === 'south' ? w : h;
    const even = Array.from({ length: k }, (_, i) => (len * (i + 0.5)) / k);
    const snapped = even.map((u) => Math.round(u * 2) / 2);
    const apart = snapped.every((u, i) => i === 0 || u - snapped[i - 1]! >= size - 1e-9);
    for (const along of apart ? snapped : even) {
      const at: Point =
        s === 'north' ? [tb.x0 + along, tb.y0 - h / 2] : s === 'south' ? [tb.x0 + along, tb.y1 + h / 2] : s === 'west' ? [tb.x0 - w / 2, tb.y0 + along] : [tb.x1 + w / 2, tb.y0 + along];
      out.push({ at: [r2(at[0]), r2(at[1])], rot, w, h });
    }
    return out;
  };
  let chosen: { s: Side; at: Point; rot: number; w: number; h: number }[] = [];
  for (let round = 0; round < 8; round++) {
    // deal the copies out to the sides in turn, long sides first, up to what each holds
    const per = new Map<Side, number>(sides.map((s) => [s, 0]));
    let left = count;
    while (left > 0 && sides.some((s) => per.get(s)! < cap.get(s)!)) {
      for (const s of sides) {
        if (left > 0 && per.get(s)! < cap.get(s)!) {
          per.set(s, per.get(s)! + 1);
          left--;
        }
      }
    }
    chosen = [];
    let changed = false;
    for (const s of sides) {
      const k = per.get(s)!;
      if (!k) continue;
      const slots = slotsFor(s, k).filter((x) => fits(ctx, boxAt(x.at, x.w, x.h)));
      if (slots.length < k) {
        cap.set(s, Math.min(cap.get(s)! - 1, slots.length));
        changed = true;
      }
      chosen.push(...slots.map((x) => ({ s, ...x })));
    }
    if (!changed || chosen.length >= count) break;
  }
  for (const c of chosen.slice(0, count)) add(c.at, c.rot, `${c.s} of ${t.title}${given === undefined ? ', facing it' : ''}${inWords === 'outdoors' ? '' : ` (${inWords})`}`, c.w, c.h);
  // not enough room on its sides: the nearest free spots around it
  for (let k = chosen.length; k < count; k++) {
    const { w, h } = footprintSize(req.asset, given ?? 0, req.scale);
    const tc = boxCentre(tb);
    const hit = best(ctx, w, h, (p, b) => boxGap(b, tb) * 10 + Math.hypot(p[0] - tc[0], p[1] - tc[1]) * 0.1);
    if (!hit || boxGap(boxAt(hit.at, w, h), tb) > 1.5) break;
    const s = sideOff(tb, hit.at);
    const rot = given ?? FACE_TOWARD[s];
    const turned = footprintSize(req.asset, rot, req.scale);
    if (!fits(ctx, boxAt(hit.at, turned.w, turned.h))) break;
    add(hit.at, rot, `${s} of ${t.title}, a little off its side${given === undefined ? ', facing it' : ''}`, turned.w, turned.h);
  }

}

function sideLen(b: Bounds, s: Side): number {
  return s === 'north' || s === 'south' ? boxW(b) : boxH(b);
}


