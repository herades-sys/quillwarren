// buildScene: map + style -> an ordered list of drawing layers in grid squares.
// sceneToSvg (svg.ts) writes it out; a Canvas backend can draw the same layers.
import { differenceD, EndType, FillRule, inflatePathsD, intersectD, JoinType, type PathsD } from 'clipper2-ts';
import { assetInfo, propBounds, propHidden, propLayer } from '../assets/catalog.ts';
import { COLOUR_PALETTE, colourMap } from '../assets/colour.ts';
import { fogShade, visiblePaths } from '../fog.ts';
import { clipPolylines, insidePolygons } from '../geometry/objects.ts';
import type { Palette } from '../assets/svg.ts';
import { computeFloor, floorPaths, polygonsOf } from '../geometry/floor.ts';
import { roughFloor } from '../geometry/rough.ts';
import { terrainArea, terrainPolygons } from '../geometry/terrain.ts';
import { solidCutouts } from '../geometry/solid.ts';
import { cutSegments, floorTest, openWallRings } from '../geometry/openings.ts';
import { floorNumberLayer, stairTagLayer } from './floor-marks.ts';
import { HEIGHT_CLIP, heightDrawing } from './heights.ts';
import { openAreas } from './open-ends.ts';
import { fromPath, PRECISION, shapeBounds, shapePath, toPath, type Bounds, type Polygon, type Ring } from '../geometry/shapes.ts';
import { doorDirection, doorNormal, isTurned } from '../geometry/doors.ts';
import { doorSegment, shutDoorLines, wallPolylines, type Polyline } from '../geometry/walls.ts';
import { markerRadius } from '../markers.ts';
import { imageBounds } from '../images.ts';
import { inscriptionNear, inscriptionsOf } from '../inscriptions.ts';
import type { DelveMap, Door, ImageLayer, MapImage, MarkerKind, Point, Prop, Room, Stairs, Terrain } from '../schema.ts';
import type { Inscription } from '../schema.ts';
import { hatchStrokes, insidePaths, outsideBand } from './hatching.ts';
import { hashInts, hashString, rng } from './rng.ts';
import { resolveStyle, type Style } from './style.ts';
import { terrainEdges, tonePaletteName, type EdgeDetail, type Tone } from './terrain-edges.ts';

export type View = 'gm' | 'players';

export interface RenderOptions {
  /** GM view shows room numbers and secret doors; players' view hides both. */
  view?: View;
  grid?: boolean;
  /** Extra squares around the drawing when the map has no grid.bounds. */
  margin?: number;
  /** An asset's SVG body (see assets/svg.ts), or undefined while it isn't loaded: then a dashed outline stands in. */
  assets?: (asset: string) => string | undefined;
  /** false: leave the background out (transparent), e.g. for the 3D view's floor textures. */
  background?: boolean;
  /**
   * Fog of war (when the map has it on): 'hide' covers what the players haven't
   * seen (players' screen), 'dim' shades it (the GM's view). Off by default, so
   * exports stay whole.
   */
  fog?: 'hide' | 'dim';
  /** With fog 'hide': size the picture as if nothing were fogged (a VTT page keeps its frame as the players explore). */
  fullBounds?: boolean;
  /** Exactly this part of the map, in squares (a tabletop page: GM and players pictures line up with it and each other). */
  frame?: Bounds;
  /** false: no floor number in the GM view's top-left corner (the viewer shows it as a badge instead). */
  floorNumber?: boolean;
  /**
   * Draw only inside these polygons and paint the rest `revealColor` (default
   * black): a tabletop page's explored region in dynamic vision. Written as one
   * SVG clipPath around every layer, so a PNG of it holds nothing outside them.
   */
  reveal?: Polygon[];
  revealColor?: string;
}

/** One prop in an 'assets' layer: its body (in asset units, 100 per square) placed around `at`. */
export interface AssetItem {
  id: string;
  asset: string;
  body?: string;
  at: Point;
  rotation: number;
  scale: number;
  /** Footprint in squares before rotation and scale. */
  w: number;
  h: number;
  /** A colour prop: drawn in the layer's `colours`, not its three inks. */
  colour?: true;
}

/** One uploaded picture in an 'images' layer: w × h squares centred on `at`, turned clockwise by `rotation` degrees. */
export interface ImageItem {
  id: string;
  src: string;
  at: Point;
  w: number;
  h: number;
  rotation: number;
  opacity?: number;
}

interface LayerBase {
  name: string;
  clip?: string;
  opacity?: number;
}
/** alpha: the paint's own opacity (fill-opacity / stroke-opacity), unlike `opacity`, which makes resvg draw the whole layer apart first. */
export type Layer =
  | (LayerBase & { kind: 'rect'; bounds: Bounds; color: string })
  | (LayerBase & { kind: 'fill'; polygons: Polygon[]; color: string; stroke?: { color: string; width: number }; alpha?: number })
  | (LayerBase & {
      kind: 'stroke';
      lines: Polyline[];
      color: string;
      width: number;
      cap: 'butt' | 'round' | 'square';
      join: 'miter' | 'round';
      dash?: number[];
      alpha?: number;
    })
  | (LayerBase & { kind: 'dots'; points: Point[]; radius: number; color: string; alpha?: number })
  | (LayerBase & { kind: 'text'; items: { text: string; at: Point; size: number }[]; color: string; font: string })
  /** colours: what a style makes of the palette (assets/colour.ts), there only when the layer holds colour props and the style changes them. */
  | (LayerBase & { kind: 'assets'; items: AssetItem[]; palette: Palette; colours?: ReadonlyMap<string, string> })
  /**
   * Polygons filled with `tint`, then with a 2×2-square tile repeated from the origin. A colour
   * texture (`colour`) has no tint: its own w × h-square tile, in its palette as the style shows it.
   * `alpha`: both drawn see-through (the soft rims of a terrain's fade, render/terrain-edges.ts).
   */
  | (LayerBase & { kind: 'pattern'; polygons: Polygon[]; tile: string; body?: string; tint?: string; palette: Palette; colour?: { size: [number, number]; colours?: ReadonlyMap<string, string> }; alpha?: number })
  /** GM markers: badges of radius `r` squares (smaller on props and pictures), each tagged with its id so a viewer can make it clickable. */
  | (LayerBase & { kind: 'markers'; items: { id: string; kind: MarkerKind; at: Point; done: boolean; r: number }[] })
  /** Short labels on rounded boxes `size` squares tall, centred on `at` (the GM's stair labels). */
  | (LayerBase & { kind: 'tags'; items: { text: string; at: Point }[]; size: number; fill: string; color: string; font: string })
  /** Handwritten handout notes that are on the map too (onMap), drawn as inscriptions.ts draws them; `seed` is the map's. */
  | (LayerBase & { kind: 'inscriptions'; items: Inscription[]; seed: number })
  /** Uploaded pictures (image objects), each drawn from /api/v1/images/<src>. */
  | (LayerBase & { kind: 'images'; items: ImageItem[] });

export interface Scene {
  bounds: Bounds;
  clips: Record<string, Polygon[]>;
  layers: Layer[];
  /** Everything is drawn only inside these polygons; the rest of the picture is `color` (RenderOptions.reveal). */
  reveal?: { polygons: Polygon[]; color: string };
}

const open = (points: Point[]): Polyline => ({ points, closed: false });

function floorBounds(floor: Polygon[]): Bounds | null {
  const pts = floor.flatMap((p) => p.outer);
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Wobble long wall runs a little; corners stay put and the result is stable per position. */
function roughen(line: Polyline, amount: number, seed: number): Polyline {
  if (amount <= 0) return line;
  const pts = line.points;
  const out: Point[] = [];
  const count = line.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < count; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    out.push(a);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.floor(len / 0.5);
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const r = rng(hashInts(seed, Math.round(x * 1000), Math.round(y * 1000)))();
      const d = (r - 0.5) * 0.03 * amount;
      out.push([x + nx * d, y + ny * d]);
    }
  }
  if (!line.closed) out.push(pts.at(-1)!);
  return { points: out, closed: line.closed };
}

function doorFrame(d: Door, inset: number, thickness: number): Ring {
  const [a, b] = doorSegment(d);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  const nx = -uy * (thickness / 2);
  const ny = ux * (thickness / 2);
  const p0: Point = [a[0] + ux * inset, a[1] + uy * inset];
  const p1: Point = [b[0] - ux * inset, b[1] - uy * inset];
  return [
    [p0[0] + nx, p0[1] + ny],
    [p1[0] + nx, p1[1] + ny],
    [p1[0] - nx, p1[1] - ny],
    [p0[0] - nx, p0[1] - ny],
  ];
}

const hex = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  const v = m ? parseInt(m[1]!, 16) : 0xcccccc;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const toHex = (rgb: number[]): string => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** A terrain tile's tint for this style: grayed for print, mixed toward the floor colour. */
export function terrainTint(tint: string | undefined, style: Style): string {
  let rgb = hex(tint ?? '#CCCCCC');
  if (style.terrain.gray) {
    const l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    // a tone colours the gray: light tiles stay light, dark ones take on the tone
    rgb = style.terrain.tone ? hex(style.terrain.tone).map((t) => t * (0.45 + (0.75 * l) / 255)) as [number, number, number] : [l, l, l];
  }
  const floor = hex(style.floor.color);
  const k = style.terrain.mix;
  return toHex(rgb.map((v, i) => v * k + floor[i]! * (1 - k)));
}

const mixHex = (a: string, b: string, t: number): string => {
  const x = hex(a);
  const y = hex(b);
  return toHex(x.map((v, i) => v + (y[i]! - v) * t));
};

/**
 * A terrain edge detail's colour in this style (render/terrain-edges.ts): a colour
 * texture's palette tone as the style shows it, or for an ink tile its tint,
 * darker or lighter, and the style's own inks for foam, pebbles and crust.
 */
export function terrainToneColour(tone: Tone, style: Style): string {
  const name = tonePaletteName(tone);
  if (name) {
    const hexOf = COLOUR_PALETTE[name as keyof typeof COLOUR_PALETTE] ?? COLOUR_PALETTE.stone;
    return colourMap(style)?.get(hexOf) ?? hexOf;
  }
  const tint = terrainTint(assetInfo(tone.asset)?.tint, style);
  const p = style.props;
  switch (tone.tone) {
    case 'main':
      return tint;
    case 'dark':
      return mixHex(tint, p.ink, 0.4);
    case 'light':
      return mixHex(tint, p.paper, 0.5);
    case 'foam':
      return mixHex(p.paper, tint, 0.1);
    case 'stone':
      return mixHex(p.paper, p.shade, 0.5);
    case 'glow':
      return mixHex(tint, p.paper, 0.6);
    case 'stone-dark':
    case 'crust':
      return mixHex(p.ink, p.shade, 0.2);
  }
}

/** One area's edge details as layers in this style's colours, cut to what the players have seen. */
function edgeDetailLayers(name: string, details: readonly EdgeDetail[], style: Style, seenOnly: (p: Polygon[]) => Polygon[], seenPolys: Polygon[] | null): Layer[] {
  const out: Layer[] = [];
  const alpha = (a: number) => (a < 1 ? { alpha: a } : {});
  for (const d of details) {
    const color = terrainToneColour(d.tone, style);
    if (d.kind === 'fill') {
      const polygons = seenOnly(d.polygons);
      if (polygons.length) out.push({ name, kind: 'fill', polygons, color, ...(d.outline ? { stroke: { color: terrainToneColour(d.outline.tone, style), width: d.outline.width } } : {}), ...alpha(d.alpha) });
    } else if (d.kind === 'stroke') {
      const lines = seenPolys ? clipPolylines(d.lines, seenPolys, 0.1) : d.lines;
      if (lines.length) out.push({ name, kind: 'stroke', lines, color, width: d.width, cap: 'round', join: 'round', ...alpha(d.alpha) });
    } else {
      const points = seenPolys ? d.points.filter((p) => insidePolygons(seenPolys, p)) : d.points;
      if (points.length) out.push({ name, kind: 'dots', points, radius: d.radius, color, ...alpha(d.alpha) });
    }
  }
  return out;
}

function assetItems(props: Prop[], body: RenderOptions['assets']): AssetItem[] {
  return props.map((p) => {
    const info = assetInfo(p.asset);
    return { id: p.id, asset: p.asset, body: body?.(p.asset), at: p.at, rotation: p.rotation ?? 0, scale: p.scale ?? 1, w: info?.w ?? 1, h: info?.h ?? 1, ...(info?.palette === 'colour' ? { colour: true as const } : {}) };
  });
}

/** An assets layer; with colour props in it, also the style's colours for them (unless it draws them as they are). */
function assetLayer(name: string, props: Prop[], opts: RenderOptions, style: Style): Layer {
  const items = assetItems(props, opts.assets);
  const colours = items.some((i) => i.colour) ? colourMap(style) : null;
  return { name, kind: 'assets', items, palette: style.props, ...(colours ? { colours } : {}) };
}

function stairLines(s: Stairs): Polyline[] {
  const b = shapeBounds(s.shape);
  const lines: Polyline[] = [];
  const step = 0.25;
  if (s.direction === 'n' || s.direction === 's') {
    for (let y = b.y0 + step; y < b.y1 - 1e-9; y += step) lines.push(open([[b.x0, y], [b.x1, y]]));
  } else {
    for (let x = b.x0 + step; x < b.x1 - 1e-9; x += step) lines.push(open([[x, b.y0], [x, b.y1]]));
  }
  return lines;
}

/** How far a style draws outside the walls (hatching, shading), in squares. */
export const hatchReach = (style: Style): number => Math.max(style.hatching?.width ?? 0, style.shading?.width ?? 0) + (style.hatching ? style.hatching.length : 0);

export function buildScene(map: DelveMap, opts: RenderOptions = {}, style: Style = resolveStyle(map)): Scene {
  const view = opts.view ?? 'gm';
  const seed = map.seed ?? hashString(map.id);
  const reach = hatchReach(style);

  // Fog of war in the players' view: the picture is built only from what they
  // have seen. Walls are the real walls cut to that area, and nothing else of
  // the map (hidden rooms, their props, labels, doors) goes into the scene.
  const fogged = opts.fog === 'hide' && Boolean(map.fog?.on);
  const seenPaths = fogged ? visiblePaths(map) : null;
  const seenPolys = seenPaths ? polygonsOf(seenPaths) : null;
  const seen = (p: Point) => !seenPolys || insidePolygons(seenPolys, p);
  // Wall roughness (1–10) reshapes the floor itself, so walls and hatching follow the rough edge.
  const rough = roughFloor(map, computeFloor(map), seed);
  const fullFloor = rough ?? computeFloor(map);
  const fullFlat = rough ? rough.flatMap((p) => [p.outer, ...p.holes].map(toPath)) : floorPaths(map);
  const flat = seenPaths ? intersectD(fullFlat, seenPaths, FillRule.NonZero, PRECISION) : fullFlat;
  const floor = seenPaths ? polygonsOf(flat) : fullFloor;
  // Where the floor carries on unseen past the edge of what's revealed, leave
  // hatching and shading out, so openings stay open instead of being walled in.
  const round = (paths: PathsD, d: number) => inflatePathsD(paths, d, JoinType.Round, EndType.Polygon, 2, PRECISION);
  const beyond: PathsD = seenPaths
    ? intersectD(round(differenceD(fullFlat, seenPaths, FillRule.NonZero, PRECISION), 0.15), round(seenPaths, reach + 0.5), FillRule.NonZero, PRECISION)
    : [];
  // Open ends (open-ends.ts): an archway on the outer edge leads out, and an
  // opening object is open ground, so the band outside the walls (hatching,
  // shading, the drop shadow) leaves them out too.
  const opened = openAreas(map, fullFlat, reach);
  const cutAway: PathsD = opened.length ? [...beyond, ...opened] : beyond;

  const layers: Layer[] = [];
  const clips: Record<string, Polygon[]> = { floor };
  const fb = floorBounds(floor);
  const margin = opts.margin ?? 1;
  const props = map.objects.filter((o): o is Prop => o.type === 'prop' && (view === 'gm' || !propHidden(o)) && seen(o.at));
  const shownImage = (o: MapImage) => view === 'gm' || !o.gmOnly;
  const images = map.objects.filter((o): o is MapImage => o.type === 'image' && shownImage(o) && seen(o.at));
  const terrain = map.objects
    .filter((o): o is Terrain => o.type === 'terrain')
    .map((t) => ({
      t,
      // holes (e.g. the rooms inside a filled forest) are cut out of the shape
      polygons: seenPaths ? polygonsOf(intersectD(terrainArea(t), seenPaths, FillRule.NonZero, PRECISION)) : terrainPolygons(t),
    }))
    .filter((x) => x.polygons.length);
  // The picture covers grid.bounds, the floor, terrain and props (a compass rose
  // may sit outside the dungeon), plus room for hatching and a margin, snapped
  // to whole squares so a VTT grid lines up with the image.
  // With fullBounds, a fogged picture keeps the size it has without fog (blank
  // where nothing is revealed), so a VTT page drawn from it stays lined up.
  const gb = map.grid.bounds;
  const whole = opts.fullBounds && seenPaths;
  const wholeFloor = whole ? floorBounds(fullFloor) : null;
  const parts: Bounds[] = [
    ...(gb ? [{ x0: gb[0], y0: gb[1], x1: gb[0] + gb[2], y1: gb[1] + gb[3] }] : []),
    ...(whole ? (wholeFloor ? [wholeFloor] : []) : fb ? [fb] : []),
    ...(whole
      ? map.objects.flatMap((o) => (o.type === 'terrain' ? [shapeBounds(o.shape)] : []))
      : terrain.flatMap((x) => (floorBounds(x.polygons) ? [floorBounds(x.polygons)!] : []))),
    // every prop counts, hidden ones too, so the GM's and the players' pictures are the same size and line up (e.g. as Roll20 layers)
    ...map.objects.filter((o): o is Prop => o.type === 'prop' && (Boolean(whole) || seen(o.at))).map(propBounds),
    ...(whole ? map.objects.filter((o): o is MapImage => o.type === 'image' && shownImage(o)) : images).map(imageBounds),
  ];
  const content: Bounds | null = parts.length
    ? {
        x0: Math.min(...parts.map((b) => b.x0)),
        y0: Math.min(...parts.map((b) => b.y0)),
        x1: Math.max(...parts.map((b) => b.x1)),
        y1: Math.max(...parts.map((b) => b.y1)),
      }
    : null;
  const bounds: Bounds = opts.frame
    ? { ...opts.frame }
    : content
    ? {
        x0: Math.floor(content.x0 - reach - margin),
        y0: Math.floor(content.y0 - reach - margin),
        x1: Math.ceil(content.x1 + reach + margin),
        y1: Math.ceil(content.y1 + reach + margin),
      }
    : { x0: 0, y0: 0, x1: 10, y1: 10 };

  const background = opts.background !== false;
  if (background) layers.push({ name: 'background', kind: 'rect', bounds, color: style.background });

  if (background && style.backgroundGrid) {
    const lines: Polyline[] = [];
    for (let x = Math.ceil(bounds.x0); x <= bounds.x1; x++) lines.push(open([[x, bounds.y0], [x, bounds.y1]]));
    for (let y = Math.ceil(bounds.y0); y <= bounds.y1; y++) lines.push(open([[bounds.x0, y], [bounds.x1, y]]));
    layers.push({ name: 'background-grid', kind: 'stroke', lines, color: style.backgroundGrid.color, width: style.backgroundGrid.width, cap: 'butt', join: 'miter' });
  }

  if (style.shading) {
    layers.push({ name: 'shading', kind: 'fill', polygons: polygonsOf(outsideBand(flat, style.shading.width), cutAway), color: style.shading.color });
  }

  if (style.hatching) {
    const rect: Ring = [
      [bounds.x0, bounds.y0],
      [bounds.x1, bounds.y0],
      [bounds.x1, bounds.y1],
      [bounds.x0, bounds.y1],
    ];
    clips['outside-floor'] = seenPaths || opened.length
      ? polygonsOf([toPath(rect)], [...flat, ...cutAway])
      : [{ outer: rect, holes: floor.flatMap((p) => [p.outer]) }, ...floor.flatMap((p) => p.holes.map((h) => ({ outer: h, holes: [] })))];
    const strokes = hatchStrokes(outsideBand(flat, style.hatching.width), style.hatching, seed);
    layers.push({
      name: 'hatching',
      kind: 'stroke',
      lines: strokes.map(open),
      color: style.hatching.color,
      width: style.hatching.strokeWidth,
      cap: 'round',
      join: 'round',
      clip: 'outside-floor',
    });
  }

  if (style.shadow) {
    const [dx, dy] = style.shadow.offset;
    let shifted: Polygon[] = floor.map((p) => ({
      outer: p.outer.map(([x, y]) => [x + dx, y + dy] as Point),
      holes: p.holes.map((h) => h.map(([x, y]) => [x + dx, y + dy] as Point)),
    }));
    if (opened.length) shifted = polygonsOf(shifted.flatMap((p) => [p.outer, ...p.holes].map(toPath)), opened);
    layers.push({ name: 'shadow', kind: 'fill', polygons: shifted, color: style.shadow.color, opacity: style.shadow.opacity });
  }

  layers.push({ name: 'floor', kind: 'fill', polygons: floor, color: style.floor.color, ...(style.floor.opacity !== undefined ? { opacity: style.floor.opacity } : {}) });

  // Terrain goes over the floor (and over open ground outside it), under the grid, in map order.
  // Soft edges (terrain-edges.ts, worked out on the whole map, then cut to what the players
  // have seen): each area's opaque core, the see-through rims of its patches and the details along
  // its edges. An area with no soft edge, and nothing fading over it, draws exactly as before.
  const allTerrain = map.objects.filter((o): o is Terrain => o.type === 'terrain');
  const edges = allTerrain.length ? terrainEdges(allTerrain, fullFloor, seed) : null;
  const seenOnly = (polys: Polygon[]): Polygon[] => (seenPaths ? polygonsOf(intersectD(polys.flatMap((p) => [p.outer, ...p.holes].map(toPath)), seenPaths, FillRule.NonZero, PRECISION)) : polys);
  const shownTerrain = new Map(terrain.map((x) => [x.t.id, x.polygons]));
  for (const t of allTerrain) {
    const info = assetInfo(t.asset);
    // a colour texture: its own colours as the style shows them, at its own size, still lined up with the grid from the origin
    const colours = info?.palette === 'colour' ? colourMap(style) : null;
    const tile = (name: string, polygons: Polygon[], alpha?: number): Layer => ({
      name,
      kind: 'pattern',
      polygons,
      tile: t.asset,
      body: opts.assets?.(t.asset),
      ...(info?.palette === 'colour' ? {} : { tint: terrainTint(info?.tint, style) }),
      palette: style.props,
      ...(info?.palette === 'colour' ? { colour: { size: [info.w, info.h] as [number, number], ...(colours ? { colours } : {}) } } : {}),
      ...(alpha !== undefined ? { alpha } : {}),
    });
    const art = edges?.areas.get(t.id);
    const polygons = art?.core ? seenOnly(art.core) : (shownTerrain.get(t.id) ?? []);
    if (polygons.length) layers.push(tile(`terrain:${t.id}`, polygons));
    if (!art) continue;
    for (const f of art.fades) {
      const band = seenOnly(f.polygons);
      if (band.length) layers.push(tile(`terrain-fade:${t.id}`, band, f.alpha));
    }
    layers.push(...edgeDetailLayers(`terrain-edge:${t.id}`, art.details, style, seenOnly, seenPolys));
  }

  // Uploaded pictures: 'floor' ones (rugs, floor art) right here, under the grid and walls; the rest with the props.
  const imageLayer = (layer: ImageLayer): void => {
    const items: ImageItem[] = images
      .filter((o) => (o.layer ?? 'props') === layer)
      .map((o) => ({ id: o.id, src: o.src, at: o.at, w: o.w, h: o.h, rotation: o.rotation ?? 0, ...(o.opacity !== undefined ? { opacity: o.opacity } : {}) }));
    if (items.length) layers.push({ name: layer === 'floor' ? 'floor-images' : 'images', kind: 'images', items });
  };
  imageLayer('floor');

  // Height areas (render/heights.ts): ground lighter or darker by its height, here under the grid;
  // the edges go over the stairs, the GM's labels with the stair labels.
  const stairsShown = map.objects.filter((o): o is Stairs => {
    if (o.type !== 'stairs') return false;
    const b = shapeBounds(o.shape);
    return seen([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]);
  });
  const heightArt = map.objects.some((o) => o.type === 'height') ? heightDrawing({ map, style, view, seed, floor: fullFlat, seen: seenPolys, stairs: stairsShown }) : null;
  if (heightArt) {
    clips[HEIGHT_CLIP] = heightArt.clip;
    layers.push(...heightArt.tone);
  }

  if ((opts.grid ?? true) && style.grid.style !== 'none' && fb) {
    if (style.grid.style === 'lines') {
      const lines: Polyline[] = [];
      for (let x = Math.ceil(fb.x0); x <= fb.x1; x++) lines.push(open([[x, fb.y0], [x, fb.y1]]));
      for (let y = Math.ceil(fb.y0); y <= fb.y1; y++) lines.push(open([[fb.x0, y], [fb.x1, y]]));
      layers.push({ name: 'grid', kind: 'stroke', lines, color: style.grid.color, width: style.grid.width, cap: 'butt', join: 'miter', opacity: style.grid.opacity, clip: 'floor' });
    } else {
      const points: Point[] = [];
      for (let x = Math.ceil(fb.x0); x <= fb.x1; x++) {
        for (let y = Math.ceil(fb.y0); y <= fb.y1; y++) if (insidePaths(flat, x, y)) points.push([x, y]);
      }
      layers.push({ name: 'grid', kind: 'dots', points, radius: style.grid.width, color: style.grid.color, opacity: style.grid.opacity });
    }
  }

  const stairs = map.objects.filter((o): o is Stairs => {
    if (o.type !== 'stairs') return false;
    const b = shapeBounds(o.shape);
    return seen([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]);
  });
  for (const s of stairs) {
    clips[`stairs-${s.id}`] = [{ outer: fromPath(shapePath(s.shape)), holes: [] }];
    layers.push({ name: `stairs:${s.id}`, kind: 'stroke', lines: stairLines(s), color: style.stairs.color, width: style.stairs.width, cap: 'butt', join: 'miter', clip: `stairs-${s.id}` });
  }
  if (heightArt) layers.push(...heightArt.edges);

  // Decals (cracks, puddles, moss) lie on the floor under the walls.
  // Colour props that lie flat (rugs, trapdoors, leaf piles) go here too, so furniture stands on them.
  const decals = props.filter((p) => propLayer(p.asset) === 'decals');
  if (decals.length) layers.push(assetLayer('decals', decals, opts, style));

  // Solid cutouts (pillars, wall blocks) are filled with the wall colour; the walls then outline them.
  const solid = solidCutouts(map, floor, seenPaths);
  if (solid.length) layers.push({ name: 'solid-cutouts', kind: 'fill', polygons: solid, color: style.walls.color });

  // Walls. The players' view keeps secret doors shut: no gap, and a wall line across the opening.
  // With fog, only the parts of real walls inside what the players have seen.
  const doors = map.objects.filter((o): o is Door => o.type === 'door');
  const hidden = (d: Door) => view === 'players' && d.style === 'secret';
  const cut = (lines: Polyline[]) => (seenPolys ? clipPolylines(lines, seenPolys) : lines);
  const wallLines = cut(wallPolylines(map, fullFloor, (d) => !hidden(d)));
  // (openings with walls leave both out: wallPolylines does it for the walls)
  const shut = cut(cutSegments(shutDoorLines(doors.filter(hidden), fullFloor), openWallRings(map), floorTest(fullFloor)).map((s) => open(s)));
  // roughness 1 means smooth: no hand wobble either
  const wobble = map.roughness === 1 ? 0 : style.walls.roughness;
  const walls = [...wallLines.map((l) => roughen(l, wobble, seed)), ...shut];
  layers.push({ name: 'walls', kind: 'stroke', lines: walls, color: style.walls.color, width: style.walls.width, cap: 'square', join: 'miter' });
  // hand-drawn: a couple of thinner passes over each wall, each wobbling its own way
  for (let k = 1; k <= (style.walls.sketch ?? 0); k++) {
    const pass = [...wallLines, ...shut].map((l) => roughen(l, wobble * 1.8, seed + k * 7919));
    layers.push({ name: `walls-sketch-${k}`, kind: 'stroke', lines: pass, color: style.walls.color, width: style.walls.width * 0.4, cap: 'round', join: 'round', opacity: 0.6 });
  }

  // Doors
  const leaves: Polygon[] = [];
  const marks: Polyline[] = [];
  const secretMarks: { text: string; at: Point; size: number }[] = [];
  const secretLines: Polyline[] = [];
  for (const d of doors) {
    const [a, b] = doorSegment(d);
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const kind = d.style ?? 'normal';
    if (kind === 'archway' || !seen(mid)) continue;
    if (kind === 'secret') {
      if (view === 'gm') {
        secretLines.push(open([a, b]));
        secretMarks.push({ text: 'S', at: mid, size: 0.6 });
      }
      continue;
    }
    // marks across the door (bars, the meeting line of a double door) run along its normal
    const n = doorNormal(d);
    const across = (p: Point, off: number): Point[] => [[p[0] - n[0] * off, p[1] - n[1] * off], [p[0] + n[0] * off, p[1] + n[1] * off]];
    if (kind === 'portcullis') {
      const count = Math.max(2, Math.round(d.width * 4));
      for (let k = 0; k <= count; k++) {
        const t = 0.1 + (0.8 * k) / count;
        marks.push(open(across([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], 0.12)));
      }
      marks.push(open([a, b]));
      continue;
    }
    leaves.push({ outer: doorFrame(d, 0.12, d.open ? 0.12 : 0.3), holes: [] });
    if (kind === 'double') marks.push(open(across(mid, 0.15)));
    if (kind === 'locked') {
      const k = 0.07;
      // the keyhole square, turned with the door
      const [ux, uy] = doorDirection(d);
      const at = (s: number, t: number): Point => [mid[0] + (ux * s + n[0] * t) * k, mid[1] + (uy * s + n[1] * t) * k];
      const keyhole: Point[] = isTurned(d) ? [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)] : [[mid[0] - k, mid[1] - k], [mid[0] + k, mid[1] - k], [mid[0] + k, mid[1] + k], [mid[0] - k, mid[1] + k]];
      leaves.push({ outer: keyhole, holes: [] });
    }
  }
  if (leaves.length) layers.push({ name: 'doors', kind: 'fill', polygons: leaves, color: style.doors.fill, stroke: { color: style.doors.stroke, width: style.doors.strokeWidth } });
  if (marks.length) layers.push({ name: 'door-marks', kind: 'stroke', lines: marks, color: style.doors.stroke, width: style.doors.strokeWidth, cap: 'butt', join: 'miter' });
  if (secretLines.length) layers.push({ name: 'secret-doors', kind: 'stroke', lines: secretLines, color: style.walls.color, width: style.walls.width * 0.5, cap: 'butt', join: 'miter', dash: [0.15, 0.1] });
  if (secretMarks.length) layers.push({ name: 'secret-marks', kind: 'text', items: secretMarks, color: style.labels.color, font: style.labels.font });

  // Props stand on top of walls and doors (wall-mounted ones overlap the wall line);
  // tree canopies over them and the pictures, so whatever stands under a tree is hidden by its crown;
  // GM symbols come last, and only in the GM view (filtered above).
  for (const layer of ['props', 'canopy', 'symbols'] as const) {
    const list = props.filter((p) => propLayer(p.asset) === layer || (layer === 'props' && propLayer(p.asset) === 'terrain'));
    if (list.length) layers.push(assetLayer(layer, list, opts, style));
    if (layer === 'props') imageLayer('props'); // over the props, under the canopies and GM symbols
  }

  // Free labels show in both views; room numbers are a GM key, drawn on top in a face with clear digits.
  const labels = map.objects.flatMap((o) => (o.type === 'label' && seen(o.at) ? [{ text: o.text, at: o.at, size: o.size ?? style.labels.size * 0.7 }] : []));
  if (labels.length) layers.push({ name: 'labels', kind: 'text', items: labels, color: style.labels.color, font: style.labels.font });
  // Fog of war in the GM view: shade what the players haven't seen (room numbers stay readable on top).
  if (opts.fog === 'dim' && map.fog?.on) {
    const shade = fogShade(map, reach);
    if (shade.length) layers.push({ name: 'fog', kind: 'fill', polygons: shade, color: style.fog.color, opacity: style.fog.dim });
  }
  // Handwritten handout notes the GM put on the map too: in both views, over the
  // fog shade, and never hidden by fog (the GM writes them for the players).
  // (only the ones near the picture: resvg panics on content far outside a clipped group, see inscriptionNear)
  const inscriptions = inscriptionsOf(map, { onMap: true }).filter((n) => inscriptionNear(n, bounds, 0.25 * Math.min(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0)));
  if (inscriptions.length) layers.push({ name: 'inscriptions', kind: 'inscriptions', items: inscriptions, seed });
  if (view === 'gm') {
    const numbers: { text: string; at: Point; size: number }[] = [];
    for (const r of map.objects.filter((o): o is Room => o.type === 'room')) {
      if (!r.label) continue;
      const b = shapeBounds(r.shape);
      numbers.push({ text: r.label, at: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2], size: style.labels.size });
    }
    if (numbers.length) layers.push({ name: 'room-numbers', kind: 'text', items: numbers, color: style.labels.color, font: style.labels.numberFont });
    // Storeys: the floor number in the corner (not on the 3D view's transparent floor textures) and the stair labels
    const floorNo = opts.floorNumber !== false && background ? floorNumberLayer(map, bounds, style) : null;
    if (floorNo) layers.push(floorNo);
    const stairTags = stairTagLayer(map, style);
    if (stairTags) layers.push(stairTags);
    if (heightArt?.labels) layers.push(heightArt.labels);
    // GM markers on top of everything: never in the players' view
    const markers = map.objects.flatMap((o) => (o.type === 'marker' ? [{ id: o.id, kind: o.kind, at: o.at, done: Boolean(o.done), r: markerRadius(map.objects, o) }] : []));
    if (markers.length) layers.push({ name: 'markers', kind: 'markers', items: markers });
  }

  const scene: Scene = { bounds, clips, layers };
  if (opts.reveal) scene.reveal = { polygons: opts.reveal, color: opts.revealColor ?? '#000000' };
  return scene;
}
