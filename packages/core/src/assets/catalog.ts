// What Delve knows about each asset (props and terrain tiles), from catalog.json,
// which `npm run assets` builds from delve-props-design-system/assets, and the
// colour props from catalog-colour.json, which `npm run colour-props` builds.
// The SVG bodies themselves are loaded separately (server: from disk; browser:
// on demand).
import type { Bounds } from '../geometry/shapes.ts';
import type { Point, Prop } from '../schema.ts';
import catalog from './catalog.json' with { type: 'json' };
import colourCatalog from './catalog-colour.json' with { type: 'json' };

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
  /** Hidden from players unless a prop says otherwise (gmOnly: false): traps and other secrets. */
  hidden?: boolean;
  /** 'colour': a colour prop, drawn in the Delve palette (assets/colour.ts) instead of the three inks. */
  palette?: 'colour';
  /** Colour props: 'floor' ones (rugs, trapdoors, leaf piles) lie with the decals, under the other props. */
  layer?: 'floor' | 'props';
  /** Colour props: the family of variants (all oaks are "oak"), which the prop brush mixes. */
  group?: string;
  /** Modular pieces (ruin walls): placed on whole squares, so their open ends meet. */
  modular?: boolean;
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

/** The ink catalog: props and terrain tiles in the three inks. */
export const ASSETS: readonly AssetInfo[] = catalog as AssetInfo[];

// ---------- colour props and textures ----------
// A second built-in library in the Delve palette (docs/ASSETS-COLOUR.md).
// catalog-colour.json keeps one compact row per asset, because every browser
// bundle carries it: [id, name, category, w, h, "tags,with,commas", blocks,
// layer, group or "", "hidden modular tile difficult" flags or nothing]. The
// art's file is colour/<category>/<id without the prefix>.svg in the assets
// folder. Ids are the art's ids behind COLOUR_PREFIX, so they never clash with
// the ink catalog's (ink stalagmites, colour c-stalagmites; ink water-shallow,
// colour texture c-water-shallow) or with custom props (my-…).
// Seamless textures (flag tile) are terrain: a terrain object's asset may be one,
// and it repeats at its own size (w × h squares) in its own colours, no tint.

export const COLOUR_PREFIX = 'c-';
export const isColourAsset = (id: string): boolean => id.startsWith(COLOUR_PREFIX);

type ColourRow = [id: string, name: string, category: string, w: number, h: number, tags: string, blocks: Blocks, layer: 'floor' | 'props', group?: string, flags?: string];

export const COLOUR_ASSETS: readonly AssetInfo[] = (colourCatalog.assets as unknown as ColourRow[]).map(([id, name, category, w, h, tags, blocks, layer, group, flags]) => {
  const f = (flags ?? '').split(' ');
  return {
    id,
    name,
    category,
    kind: f.includes('tile') ? ('terrain' as const) : ('prop' as const),
    w,
    h,
    tags: tags ? tags.split(',') : [],
    blocks,
    ...(f.includes('difficult') ? { difficult: true } : {}),
    file: `colour/${category}/${id.slice(COLOUR_PREFIX.length)}.svg`,
    palette: 'colour' as const,
    layer,
    ...(group ? { group } : {}),
    ...(f.includes('hidden') ? { hidden: true } : {}),
    ...(f.includes('modular') ? { modular: true } : {}),
  };
});

/** The colour props' and textures' categories in picker order (some share an id, and a picker chip, with an ink category: nature, water). */
export const COLOUR_CATEGORIES: readonly Category[] = (colourCatalog.categories as [string, string][]).map(([id, name]) => ({
  id,
  name,
  // a category of textures only (floors, ground) is terrain, like the ink tiles'
  layer: COLOUR_ASSETS.every((a) => a.category !== id || a.kind === 'terrain') ? ('terrain' as const) : ('props' as const),
}));

/**
 * The ink catalog's props that are secrets until found (catalog.json `hidden`,
 * from build-assets.ts): hidden from players unless a prop says otherwise
 * (gmOnly: false). Colour props say so in their manifest; hiddenByDefault
 * covers both.
 */
export const HIDDEN_ASSETS: ReadonlySet<string> = new Set(ASSETS.filter((a) => a.hidden).map((a) => a.id));

/** Is this asset hidden from players unless a prop says otherwise? */
export const hiddenByDefault = (id: string): boolean => assetInfo(id)?.hidden === true;

/** Is this prop left out of the players' view? GM symbols always are; otherwise the prop's own gmOnly, or the asset's default. */
export function propHidden(p: { asset: string; gmOnly?: boolean }): boolean {
  if (categoryOf(p.asset)?.gmOnly) return true;
  return p.gmOnly ?? hiddenByDefault(p.asset);
}

const byId = new Map([...ASSETS, ...COLOUR_ASSETS].map((a) => [a.id, a]));
const categoryById = new Map([...CATEGORIES, CUSTOM_CATEGORY, ...COLOUR_CATEGORIES].reverse().map((c) => [c.id, c])); // reversed: an ink category wins a shared id
const byGroup = new Map<string, string[]>();
for (const a of COLOUR_ASSETS) if (a.group && a.kind === 'prop') byGroup.set(a.group, [...(byGroup.get(a.group) ?? []), a.id]);

/** A built-in asset, or a custom prop registered with registerAssets. */
export const assetInfo = (id: string): AssetInfo | undefined => byId.get(id) ?? customById.get(id);
export const categoryOf = (id: string): Category | undefined => categoryById.get(assetInfo(id)?.category ?? '');

/** Where a prop draws: by its category, except colour props, which say it themselves (floor ones lie with the decals, under the other props). */
export function propLayer(asset: string): AssetLayer {
  const info = assetInfo(asset);
  if (info?.palette === 'colour') return info.layer === 'floor' ? 'decals' : 'props';
  return categoryOf(asset)?.layer ?? 'props';
}

/** The variants the prop brush mixes for a prop: every prop of its group in catalog order (itself included), or only itself. */
export function groupVariants(asset: string): string[] {
  const g = assetInfo(asset)?.group;
  return (g && byGroup.get(g)) || [asset];
}

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

/**
 * Where a modular piece (a ruin wall, a seamless texture) goes near `at`: its turned footprint on
 * whole squares, so a wall's centre line runs through square centres and
 * neighbouring pieces meet edge to edge. Other props keep `at`.
 */
export function modularAt(p: Pick<Prop, 'asset' | 'at' | 'rotation' | 'scale'>): Point {
  if (!assetInfo(p.asset)?.modular) return p.at;
  const b = propBounds(p);
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return [r(p.at[0] + Math.round(b.x0) - b.x0), r(p.at[1] + Math.round(b.y0) - b.y0)];
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
/** Built-in catalogs (ink, then colour) plus custom props. */
export const allAssets = (): AssetInfo[] => [...ASSETS, ...COLOUR_ASSETS, ...customById.values()];
/** Goes up on every registerAssets call, so caches of custom art know when to look again. */
export const customAssetsVersion = (): number => customVersion;
/** The categories a prop can be filed under: the built-in prop categories plus Custom (terrain is for tiles). */
export const PROP_CATEGORIES: readonly Category[] = [...CATEGORIES.filter((c) => c.id !== 'terrain'), CUSTOM_CATEGORY];
