// buildScene: map + style -> an ordered list of drawing layers in grid squares.
// sceneToSvg (svg.ts) writes it out; a Canvas backend can draw the same layers.
import { differenceD, EndType, FillRule, inflatePathsD, intersectD, JoinType, type PathsD } from 'clipper2-ts';
import { assetInfo, categoryOf, propBounds, type AssetLayer } from '../assets/catalog.ts';
import { fogShade, visiblePaths } from '../fog.ts';
import { clipPolylines, insidePolygons } from '../geometry/objects.ts';
import type { Palette } from '../assets/svg.ts';
import { computeFloor, floorPaths, polygonsOf } from '../geometry/floor.ts';
import { roughFloor } from '../geometry/rough.ts';
import { terrainArea, terrainPolygons } from '../geometry/terrain.ts';
import { solidCutouts } from '../geometry/solid.ts';
import { floorNumberLayer, stairTagLayer } from './floor-marks.ts';
import { fromPath, PRECISION, shapeBounds, shapePath, toPath, type Bounds, type Polygon, type Ring } from '../geometry/shapes.ts';
import { doorSegment, wallPolylines, type Polyline } from '../geometry/walls.ts';
import { markerRadius } from '../markers.ts';
import { imageBounds } from '../images.ts';
import type { DelveMap, Door, ImageLayer, MapImage, MarkerKind, Point, Prop, Room, Stairs, Terrain } from '../schema.ts';
import { hatchStrokes, insidePaths, outsideBand } from './hatching.ts';
import { hashInts, hashString, rng } from './rng.ts';
import { resolveStyle, type Style } from './style.ts';

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
export type Layer =
  | (LayerBase & { kind: 'rect'; bounds: Bounds; color: string })
  | (LayerBase & { kind: 'fill'; polygons: Polygon[]; color: string; stroke?: { color: string; width: number } })
  | (LayerBase & {
      kind: 'stroke';
      lines: Polyline[];
      color: string;
      width: number;
      cap: 'butt' | 'round' | 'square';
      join: 'miter' | 'round';
      dash?: number[];
    })
  | (LayerBase & { kind: 'dots'; points: Point[]; radius: number; color: string })
  | (LayerBase & { kind: 'text'; items: { text: string; at: Point; size: number }[]; color: string; font: string })
  | (LayerBase & { kind: 'assets'; items: AssetItem[]; palette: Palette })
  /** Polygons filled with `tint`, then with a 2×2-square tile repeated from the origin. */
  | (LayerBase & { kind: 'pattern'; polygons: Polygon[]; tile: string; body?: string; tint: string; palette: Palette })
  /** GM markers: badges of radius `r` squares (smaller on props and pictures), each tagged with its id so a viewer can make it clickable. */
  | (LayerBase & { kind: 'markers'; items: { id: string; kind: MarkerKind; at: Point; done: boolean; r: number }[] })
  /** Short labels on rounded boxes `size` squares tall, centred on `at` (the GM's stair labels). */
  | (LayerBase & { kind: 'tags'; items: { text: string; at: Point }[]; size: number; fill: string; color: string; font: string })
  /** Uploaded pictures (image objects), each drawn from /api/v1/images/<src>. */
  | (LayerBase & { kind: 'images'; items: ImageItem[] });

export interface Scene {
  bounds: Bounds;
  clips: Record<string, Polygon[]>;
  layers: Layer[];
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

function layerOfProp(p: Prop): AssetLayer {
  return categoryOf(p.asset)?.layer ?? 'props';
}

function assetItems(props: Prop[], body: RenderOptions['assets']): AssetItem[] {
  return props.map((p) => {
    const info = assetInfo(p.asset);
    return { id: p.id, asset: p.asset, body: body?.(p.asset), at: p.at, rotation: p.rotation ?? 0, scale: p.scale ?? 1, w: info?.w ?? 1, h: info?.h ?? 1 };
  });
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

export function buildScene(map: DelveMap, opts: RenderOptions = {}, style: Style = resolveStyle(map)): Scene {
  const view = opts.view ?? 'gm';
  const seed = map.seed ?? hashString(map.id);
  const reach = Math.max(style.hatching?.width ?? 0, style.shading?.width ?? 0) + (style.hatching ? style.hatching.length : 0);

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

  const layers: Layer[] = [];
  const clips: Record<string, Polygon[]> = { floor };
  const fb = floorBounds(floor);
  const margin = opts.margin ?? 1;
  const props = map.objects.filter((o): o is Prop => o.type === 'prop' && (view === 'gm' || !categoryOf(o.asset)?.gmOnly) && seen(o.at));
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
    ...(whole ? map.objects.filter((o): o is Prop => o.type === 'prop' && (view === 'gm' || !categoryOf(o.asset)?.gmOnly)) : props).map(propBounds),
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
    layers.push({ name: 'shading', kind: 'fill', polygons: polygonsOf(outsideBand(flat, style.shading.width), beyond), color: style.shading.color });
  }

  if (style.hatching) {
    const rect: Ring = [
      [bounds.x0, bounds.y0],
      [bounds.x1, bounds.y0],
      [bounds.x1, bounds.y1],
      [bounds.x0, bounds.y1],
    ];
    clips['outside-floor'] = seenPaths
      ? polygonsOf([toPath(rect)], [...flat, ...beyond])
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
    const shifted = floor.map((p) => ({
      outer: p.outer.map(([x, y]) => [x + dx, y + dy] as Point),
      holes: p.holes.map((h) => h.map(([x, y]) => [x + dx, y + dy] as Point)),
    }));
    layers.push({ name: 'shadow', kind: 'fill', polygons: shifted, color: style.shadow.color, opacity: style.shadow.opacity });
  }

  layers.push({ name: 'floor', kind: 'fill', polygons: floor, color: style.floor.color, ...(style.floor.opacity !== undefined ? { opacity: style.floor.opacity } : {}) });

  // Terrain goes over the floor (and over open ground outside it), under the grid.
  for (const { t, polygons } of terrain) {
    layers.push({
      name: `terrain:${t.id}`,
      kind: 'pattern',
      polygons,
      tile: t.asset,
      body: opts.assets?.(t.asset),
      tint: terrainTint(assetInfo(t.asset)?.tint, style),
      palette: style.props,
    });
  }

  // Uploaded pictures: 'floor' ones (rugs, floor art) right here, under the grid and walls; the rest with the props.
  const imageLayer = (layer: ImageLayer): void => {
    const items: ImageItem[] = images
      .filter((o) => (o.layer ?? 'props') === layer)
      .map((o) => ({ id: o.id, src: o.src, at: o.at, w: o.w, h: o.h, rotation: o.rotation ?? 0, ...(o.opacity !== undefined ? { opacity: o.opacity } : {}) }));
    if (items.length) layers.push({ name: layer === 'floor' ? 'floor-images' : 'images', kind: 'images', items });
  };
  imageLayer('floor');

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

  // Decals (cracks, puddles, moss) lie on the floor under the walls.
  const decals = props.filter((p) => layerOfProp(p) === 'decals');
  if (decals.length) layers.push({ name: 'decals', kind: 'assets', items: assetItems(decals, opts.assets), palette: style.props });

  // Solid cutouts (pillars, wall blocks) are filled with the wall colour; the walls then outline them.
  const solid = solidCutouts(map, floor, seenPaths);
  if (solid.length) layers.push({ name: 'solid-cutouts', kind: 'fill', polygons: solid, color: style.walls.color });

  // Walls. The players' view keeps secret doors shut: no gap, and a wall line across the opening.
  // With fog, only the parts of real walls inside what the players have seen.
  const doors = map.objects.filter((o): o is Door => o.type === 'door');
  const hidden = (d: Door) => view === 'players' && d.style === 'secret';
  const cut = (lines: Polyline[]) => (seenPolys ? clipPolylines(lines, seenPolys) : lines);
  const wallLines = cut(wallPolylines(map, fullFloor, (d) => !hidden(d)));
  const shut = cut(doors.filter(hidden).map((d) => open(doorSegment(d))));
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
    if (kind === 'portcullis') {
      const n = Math.max(2, Math.round(d.width * 4));
      for (let k = 0; k <= n; k++) {
        const t = 0.1 + (0.8 * k) / n;
        const p: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const off = 0.12;
        marks.push(open(d.along === 'x' ? [[p[0], p[1] - off], [p[0], p[1] + off]] : [[p[0] - off, p[1]], [p[0] + off, p[1]]]));
      }
      marks.push(open([a, b]));
      continue;
    }
    leaves.push({ outer: doorFrame(d, 0.12, d.open ? 0.12 : 0.3), holes: [] });
    if (kind === 'double') {
      marks.push(open(d.along === 'x' ? [[mid[0], mid[1] - 0.15], [mid[0], mid[1] + 0.15]] : [[mid[0] - 0.15, mid[1]], [mid[0] + 0.15, mid[1]]]));
    }
    if (kind === 'locked') {
      const k = 0.07;
      leaves.push({ outer: [[mid[0] - k, mid[1] - k], [mid[0] + k, mid[1] - k], [mid[0] + k, mid[1] + k], [mid[0] - k, mid[1] + k]], holes: [] });
    }
  }
  if (leaves.length) layers.push({ name: 'doors', kind: 'fill', polygons: leaves, color: style.doors.fill, stroke: { color: style.doors.stroke, width: style.doors.strokeWidth } });
  if (marks.length) layers.push({ name: 'door-marks', kind: 'stroke', lines: marks, color: style.doors.stroke, width: style.doors.strokeWidth, cap: 'butt', join: 'miter' });
  if (secretLines.length) layers.push({ name: 'secret-doors', kind: 'stroke', lines: secretLines, color: style.walls.color, width: style.walls.width * 0.5, cap: 'butt', join: 'miter', dash: [0.15, 0.1] });
  if (secretMarks.length) layers.push({ name: 'secret-marks', kind: 'text', items: secretMarks, color: style.labels.color, font: style.labels.font });

  // Props stand on top of walls and doors (wall-mounted ones overlap the wall line);
  // GM symbols come last, and only in the GM view (filtered above).
  for (const layer of ['props', 'symbols'] as const) {
    const list = props.filter((p) => layerOfProp(p) === layer || (layer === 'props' && layerOfProp(p) === 'terrain'));
    if (list.length) layers.push({ name: layer, kind: 'assets', items: assetItems(list, opts.assets), palette: style.props });
    if (layer === 'props') imageLayer('props'); // over the props, under the GM symbols
  }

  // Free labels show in both views; room numbers are a GM key, drawn on top in a face with clear digits.
  const labels = map.objects.flatMap((o) => (o.type === 'label' && seen(o.at) ? [{ text: o.text, at: o.at, size: o.size ?? style.labels.size * 0.7 }] : []));
  if (labels.length) layers.push({ name: 'labels', kind: 'text', items: labels, color: style.labels.color, font: style.labels.font });
  // Fog of war in the GM view: shade what the players haven't seen (room numbers stay readable on top).
  if (opts.fog === 'dim' && map.fog?.on) {
    const shade = fogShade(map, reach);
    if (shade.length) layers.push({ name: 'fog', kind: 'fill', polygons: shade, color: style.fog.color, opacity: style.fog.dim });
  }
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
    // GM markers on top of everything: never in the players' view
    const markers = map.objects.flatMap((o) => (o.type === 'marker' ? [{ id: o.id, kind: o.kind, at: o.at, done: Boolean(o.done), r: markerRadius(map.objects, o) }] : []));
    if (markers.length) layers.push({ name: 'markers', kind: 'markers', items: markers });
  }

  return { bounds, clips, layers };
}
