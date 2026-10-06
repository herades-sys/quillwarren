// Filling a region with the prop brush (MCP add_props_along with a region):
// rows across the area (along its longer side, about a copy's size apart), the
// copies along each row packed by their own size (a big oak takes more room
// than a young one), odd rows starting half a copy later, each copy nudged, turned and
// sized a little like the brush's irregular strokes, and a colour prop with a group
// mixes its variants. Copies keep their middle inside the region; in a room
// (region in) their whole footprint stays on its floor and out of the doorways;
// elsewhere they keep off rooms and corridors (outdoor dressing stays
// outdoors). Spots on trees, boulders and walls are skipped as with every
// stroke (keepClear), unless overlap.
import { assetInfo, groupVariants, modularAt, propBounds } from '../assets/catalog.ts';
import { floorPaths } from '../geometry/floor.ts';
import { keepClear } from '../placement.ts';
import { hashInts, rng } from '../render/rng.ts';
import type { DelveMap, Point } from '../schema.ts';
import { ValidationError } from '../validate.ts';
import { boxArea, boxH, boxOverlap, boxPath, boxW, inPolygons, intersectArea, r2, standsUp } from './common.ts';
import { doorwayZones } from './props.ts';
import type { Region } from './regions.ts';

export interface FillOptions {
  asset: string;
  /** Squares between copies and between rows (default: the size of the prop, or of its group's variants on average). */
  spacing?: number;
  /** irregular (default): nudged, turned and sized a little each; regular: an exact lattice, all turned by rotation. */
  placement?: 'regular' | 'irregular';
  /** Irregular: how far a copy may be nudged from its lattice point (default 0.15 × spacing). */
  spread?: number;
  rotation?: number;
  seed: number;
  /** Mix the group's variants (default true when it has some). */
  mix?: boolean;
  /** Allow copies on trees, boulders and each other (keepClear skipped). */
  overlap?: boolean;
}

export interface FillCopy {
  asset: string;
  at: Point;
  rotation: number;
  scale: number;
}

export interface FillResult {
  copies: FillCopy[];
  spacing: number;
  /** Spots left out: on rooms or corridors (outdoor fills), outside the room or in a doorway (fills in a room), on obstacles. */
  skipped: { floor: number; outside: number; blocked: number };
}

/** The rows across a box: their middle lines, `gap` apart and centred, along its longer side. */
export function rowLines(b: { x0: number; y0: number; x1: number; y1: number }, size: number): { across: boolean; at: number[]; from: number; to: number } {
  const across = boxW(b) >= boxH(b);
  const depth = across ? boxH(b) : boxW(b);
  const gap = size * 0.87;
  const rows = Math.max(1, Math.floor((depth - size) / gap + 1e-9) + 1);
  const off = (depth - (rows - 1) * gap) / 2;
  const base = across ? b.y0 : b.x0;
  return { across, at: Array.from({ length: rows }, (_, k) => base + off + k * gap), from: across ? b.x0 : b.y0, to: across ? b.x1 : b.y1 };
}

export function fillRegion(map: DelveMap, region: Region, o: FillOptions): FillResult {
  const info = assetInfo(o.asset);
  if (!info || info.kind !== 'prop') throw new ValidationError([`asset: "${o.asset}" is not a prop`]);
  const variants = o.mix === false ? [o.asset] : groupVariants(o.asset);
  const sizes = variants.map((v) => Math.max(assetInfo(v)?.w ?? 1, assetInfo(v)?.h ?? 1));
  const spacing = Math.max(0.5, o.spacing ?? Math.max(1, sizes.reduce((s, v) => s + v, 0) / sizes.length));
  const irregular = (o.placement ?? 'irregular') === 'irregular';
  const spread = irregular ? Math.max(0, o.spread ?? spacing * 0.15) : 0;
  const rand = rng(hashInts(o.seed, 0x5eed));
  const pick = rng(hashInts(o.seed, 0x7a51));
  let last = -1;
  const variant = () => {
    if (variants.length < 2) return variants[0]!;
    let k = Math.floor(pick() * variants.length);
    if (k === last) k = (k + 1 + Math.floor(pick() * (variants.length - 1))) % variants.length;
    last = k;
    return variants[k]!;
  };
  // copies of the same prop (or its group) already standing keep their spot
  const kin = new Set(variants);
  const taken = map.objects.flatMap((x) => (x.type === 'prop' && kin.has(x.asset) ? [x.at] : []));
  const floor = region.offFloor ? floorPaths(map) : [];
  const zones = region.within && region.within.object.type === 'room' && standsUp(o.asset) ? doorwayZones(map, region.within) : [];
  const skipped = { floor: 0, outside: 0, blocked: 0 };
  // rows across the region; along each, copies packed by their own size (a big oak takes more room than a young one),
  // touching or a little apart, odd rows starting half a copy later; given a spacing, every spacing squares instead
  const spots: { asset: string; at: Point; rotation: number; scale: number }[] = [];
  const rows = rowLines(region.bounds, spacing);
  rows.at.forEach((line, k) => {
    let cursor = rows.from + (k % 2 ? spacing / 2 : 0);
    for (let guard = 0; guard < 2000; guard++) {
      const asset = variant();
      const rotation = irregular ? Math.round(rand() * 360) % 360 : (o.rotation ?? 0);
      const scale = irregular ? Math.round((0.85 + rand() * 0.25) * 20) / 20 : 1;
      const a = assetInfo(asset);
      const size = Math.max(a?.w ?? 1, a?.h ?? 1) * scale;
      const along = o.spacing !== undefined ? cursor + spacing / 2 : cursor + size / 2;
      if (along > rows.to + 1e-9) break;
      cursor = o.spacing !== undefined ? cursor + spacing : cursor + size - 0.2 + (irregular ? rand() * 0.5 : 0);
      const across = line + (irregular ? (rand() - 0.5) * 2 * spread : 0);
      spots.push({ asset, at: rows.across ? [along, across] : [across, along], rotation, scale });
    }
  });
  const inside: FillCopy[] = [];
  for (const { asset, at: p, rotation, scale } of spots) {
    const at = modularAt({ asset, at: [r2(p[0]), r2(p[1])], rotation, scale });
    if (!inPolygons(region.polygons, at)) {
      skipped.outside++;
      continue;
    }
    if (taken.some((t) => Math.hypot(t[0] - at[0], t[1] - at[1]) < spacing * 0.6)) {
      skipped.blocked++;
      continue;
    }
    const fp = propBounds({ asset, at, rotation, scale });
    if (region.within) {
      const on = intersectArea(boxPath(fp), region.within.paths);
      if (on < boxArea(fp) * 0.97 || zones.some((z) => boxOverlap(z.b, fp) > 0.05)) {
        skipped.outside++;
        continue;
      }
    } else if (floor.length && intersectArea(boxPath(fp), floor) > 0.05) {
      skipped.floor++;
      continue;
    }
    inside.push({ asset, at, rotation, scale });
  }
  const { kept, skipped: blocked } = o.overlap ? { kept: inside, skipped: 0 } : keepClear(map.objects, inside);
  skipped.blocked += blocked;
  return { copies: kept, spacing: r2(spacing), skipped };
}
