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
  /** A prop from this Delve's own library (see "Custom props" below), not the built-in catalog. */
  custom?: boolean;
  /** Custom props: who made it and when (ISO times). */
  by?: string;
  created?: string;
  updated?: string;
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

/** Where custom props go unless their maker picks a built-in category. Not in CATEGORIES, which lists the built-in catalog's. */
export const CUSTOM_CATEGORY: Category = { id: 'custom', name: 'Custom', layer: 'props' };

export const ASSETS: readonly AssetInfo[] = catalog as AssetInfo[];

/**
 * Props that are secrets until found: hidden from players unless a prop says
 * otherwise (gmOnly: false). Kept here rather than in catalog.json, which
 * `npm run assets` writes from the art's metadata.
 */
export const HIDDEN_ASSETS: ReadonlySet<string> = new Set(['pressure-plate', 'spike-trap', 'rune']);

/** Is this prop left out of the players' view? GM symbols always are; otherwise the prop's own gmOnly, or the asset's default. */
export function propHidden(p: { asset: string; gmOnly?: boolean }): boolean {
  if (categoryOf(p.asset)?.gmOnly) return true;
  return p.gmOnly ?? HIDDEN_ASSETS.has(p.asset);
}

const byId = new Map(ASSETS.map((a) => [a.id, a]));
const categoryById = new Map([...CATEGORIES, CUSTOM_CATEGORY].map((c) => [c.id, c]));

/** A built-in asset, or a custom prop registered with registerAssets. */
export const assetInfo = (id: string): AssetInfo | undefined => byId.get(id) ?? customById.get(id);
export const categoryOf = (id: string): Category | undefined => categoryById.get(assetInfo(id)?.category ?? '');

/** Rotation folded into 0..360. */
const turn = (deg: number | undefined): number => (((deg ?? 0) % 360) + 360) % 360;

/** The square a prop covers on the map: its footprint around `at`, turned and scaled. Unknown assets count as 1×1. */
export function propBounds(p: Pick<Prop, 'asset' | 'at' | 'rotation' | 'scale'>): Bounds {
  const info = assetInfo(p.asset);
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

// ---------- custom props ----------
// This Delve's own props (drawn by Claude in the editor's chat, shared by every
// GM on the server) live beside the built-in catalog. Their ids start with
// CUSTOM_PREFIX, so they can never clash with a built-in one. The server keeps
// the library (apps/server/src/custom-props.ts) and registers it here at start
// and after every change; browsers register what GET /api/v1/props returns.
// Registering replaces the whole custom set, so a deleted prop is gone too.

export const CUSTOM_PREFIX = 'my-';
/** A custom prop id: the prefix, then lower-case words joined by hyphens (at most 60 characters). */
export const CUSTOM_ID = /^my-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isCustomAsset = (id: string): boolean => id.startsWith(CUSTOM_PREFIX);

const customById = new Map<string, AssetInfo>();
let customVersion = 0;

/** Replace the custom props. Entries without the prefix, clashing with a built-in, or not props, are left out. */
export function registerAssets(list: readonly AssetInfo[]): void {
  customById.clear();
  for (const a of list) {
    if (!CUSTOM_ID.test(a.id) || a.id.length > 60 || byId.has(a.id) || a.kind !== 'prop') continue;
    customById.set(a.id, { ...a, custom: true, tags: [...a.tags] });
  }
  customVersion++;
}

/** The registered custom props, in registration order. */
export const customAssets = (): AssetInfo[] => [...customById.values()];
/** Built-in catalog plus custom props. */
export const allAssets = (): AssetInfo[] => [...ASSETS, ...customById.values()];
/** Goes up on every registerAssets call, so caches of custom art know when to look again. */
export const customAssetsVersion = (): number => customVersion;
/** The categories a prop can be filed under: the built-in prop categories plus Custom (terrain is for tiles). */
export const PROP_CATEGORIES: readonly Category[] = [...CATEGORIES.filter((c) => c.id !== 'terrain'), CUSTOM_CATEGORY];
