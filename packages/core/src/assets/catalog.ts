// What Delve knows about each asset (props and terrain tiles), from catalog.json,
// which `npm run assets` builds from delve-props-design-system/assets. The SVG
// bodies themselves are loaded separately (server: from disk; browser: on demand).
import type { Bounds } from '../geometry/shapes.ts';
import type { Prop } from '../schema.ts';
import catalog from './catalog.json' with { type: 'json' };

export type AssetKind = 'prop' | 'terrain';
export type Blocks = 'none' | 'movement' | 'sight';

export interface AssetInfo {
  id: string;
  name: string;
  category: string;
  kind: AssetKind;
  /** Footprint in squares (terrain: the tile size). */
  w: number;
  h: number;
  tags: string[];
  /** none: walk over it; movement: blocks walking; sight: blocks walking and view. */
  blocks: Blocks;
  /** Terrain only: the base colour under the tile, on parchment. */
  tint?: string;
  /** Terrain only: difficult terrain. */
  difficult?: boolean;
  /** Path inside the assets folder. */
  file: string;
}

/** Where a category draws: decals on the floor under the walls, props on top, GM symbols last and GM view only. */
export type AssetLayer = 'terrain' | 'decals' | 'props' | 'symbols';

export interface Category {
  id: string;
  name: string;
  layer: AssetLayer;
  /** Only drawn in the GM view. */
  gmOnly?: boolean;
}

export const CATEGORIES: readonly Category[] = [
  { id: 'furniture', name: 'Furniture', layer: 'props' },
  { id: 'storage', name: 'Storage', layer: 'props' },
  { id: 'treasure', name: 'Treasure', layer: 'props' },
  { id: 'temple', name: 'Temple', layer: 'props' },
  { id: 'dungeon', name: 'Dungeon', layer: 'props' },
  { id: 'workshop', name: 'Workshop', layer: 'props' },
  { id: 'light', name: 'Light', layer: 'props' },
  { id: 'nature', name: 'Nature', layer: 'props' },
  { id: 'water', name: 'Water', layer: 'props' },
  { id: 'decals', name: 'Decals', layer: 'decals' },
  { id: 'symbols', name: 'GM symbols', layer: 'symbols', gmOnly: true },
  { id: 'cartography', name: 'Map parts', layer: 'props' },
  { id: 'terrain', name: 'Terrain', layer: 'terrain' },
];

export const ASSETS: readonly AssetInfo[] = catalog as AssetInfo[];

const byId = new Map(ASSETS.map((a) => [a.id, a]));
const categoryById = new Map(CATEGORIES.map((c) => [c.id, c]));

export const assetInfo = (id: string): AssetInfo | undefined => byId.get(id);
export const categoryOf = (id: string): Category | undefined => categoryById.get(byId.get(id)?.category ?? '');

/** Rotation folded into 0..360. */
const turn = (deg: number | undefined): number => (((deg ?? 0) % 360) + 360) % 360;

/** The square a prop covers on the map: its footprint around `at`, turned and scaled. Unknown assets count as 1×1. */
export function propBounds(p: Pick<Prop, 'asset' | 'at' | 'rotation' | 'scale'>): Bounds {
  const info = byId.get(p.asset);
  const s = p.scale ?? 1;
  const w = (info?.w ?? 1) * s;
  const h = (info?.h ?? 1) * s;
  const a = (turn(p.rotation) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(a));
  const sin = Math.abs(Math.sin(a));
  const bw = w * cos + h * sin;
  const bh = w * sin + h * cos;
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { x0: r(p.at[0] - bw / 2), y0: r(p.at[1] - bh / 2), x1: r(p.at[0] + bw / 2), y1: r(p.at[1] + bh / 2) };
}

/** Where to put `at` so a prop's turned footprint starts at the grid point `corner`. */
export function propCentre(asset: string, corner: [number, number], rotation = 0, scale = 1): [number, number] {
  const b = propBounds({ asset, at: [0, 0], rotation, scale });
  return [corner[0] - b.x0, corner[1] - b.y0];
}
