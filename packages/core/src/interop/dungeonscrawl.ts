// Dungeon Scrawl (.ds) interop. A .ds file is a ZIP holding one JSON entry,
// "map" (the zip part lives in the server). Dungeon Scrawl keeps the floor as
// one merged outline in pixels at 36 px per square, doors as "dungeon assets"
// (a filled rectangle plus two short jamb lines), and text with a top-left
// anchor at half scale. Only the file layout is used; nothing of Dungeon
// Scrawl's code or art.
import { computeFloor } from '../geometry/floor.ts';
import { shapeBounds, type Ring } from '../geometry/shapes.ts';
import { doorBetween, doorDirection, doorSegment, isTurned } from '../geometry/doors.ts';
import { hashInts, hashString } from '../render/rng.ts';
import { FORMAT, FORMAT_VERSION, type DelveMap, type Door, type MapObject, type Point, type Shape } from '../schema.ts';
import { validateMap } from '../validate.ts';
import { mapBackground } from '../background.ts';

export const DS_PX = 36;

type Json = Record<string, unknown>;
type Colour = { colour: number; alpha: number };
export interface DsGeometry {
  polygons: number[][][][];
  polylines: number[][][];
}
export interface DsDocument {
  version: 1;
  state: { document: { documentNodeId: 'document'; nodes: Record<string, Json>; undoStack: []; undoHistoryPaused: false; undoStackPointer: -1 } };
  data: { geometry: Record<string, DsGeometry>; assets: Record<string, never> };
  errors: [];
}

const colour = (hex: number, alpha = 1): Colour => ({ colour: hex, alpha });
const px = (v: number): number => Math.round(v * DS_PX * 1000) / 1000;

/** Stable UUID-shaped ids, so the same map always exports the same file. */
function idMaker(seed: string): () => string {
  const base = hashString(seed);
  let n = 0;
  return () => {
    n++;
    const h = [0, 1, 2, 3].map((k) => hashInts(base, n, k).toString(16).padStart(8, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
}

const closed = (ring: Ring): number[][] => {
  const pts = ring.map(([x, y]) => [px(x), px(y)]);
  return pts.length ? [...pts, pts[0]!] : pts;
};

function textStyle(fontSize: number): Json {
  return {
    align: 'left',
    breakWords: false,
    wordWrap: true,
    wordWrapWidth: 400,
    fill: colour(0),
    fontFamily: 'Playfair Display',
    fontSize,
    bold: true,
    italics: false,
    lineHeight: 1.2,
    shadow: { enabled: false, colour: colour(0, 0.5) },
    outline: { enabled: false, colour: colour(0xffffff) },
  };
}

export interface DsExportOptions {
  /** 'players' leaves out room numbers and secret-door marks. */
  view?: 'gm' | 'players';
}

/** A Dungeon Scrawl document for this map: floor with holes, doors, room numbers and labels. */
export function toDungeonScrawl(map: DelveMap, opts: DsExportOptions = {}): DsDocument {
  const gm = (opts.view ?? 'gm') === 'gm';
  const ownBackground = mapBackground(map);
  const id = idMaker(`${map.id}:${map.seed ?? 0}`);
  const nodes: Record<string, Json> = {};
  const geometry: Record<string, DsGeometry> = {};
  const add = (node: Json): string => {
    nodes[node.id as string] = node;
    return node.id as string;
  };
  const poly = (name: string, parentId: string, fill: Colour | null, stroke: { width: number; colour: Colour } | null, mask = false): Json => ({
    type: 'MULTIPOLYGON',
    id: id(),
    alpha: 1,
    name,
    parentId,
    mask,
    isFog: false,
    visible: true,
    blendMode: 'normal',
    stroke: { visible: Boolean(stroke), width: stroke?.width ?? 5, colour: stroke?.colour ?? colour(0), roughOptions: 'low' },
    fill: { visible: Boolean(fill), colour: fill ?? colour(0xffffff) },
  });

  const pageId = id();
  const templateId = id();
  const shapeId = id();
  const folderId = id();
  const floorGeo = id();
  const walls = poly('Walls', shapeId, null, { width: 5, colour: colour(0) });
  const mask = poly('Mask', folderId, null, { width: 5, colour: colour(0) }, true);
  const floor = poly('Floor', shapeId, colour(0xf0ece0), null);
  const grid: Json = {
    type: 'GRID',
    id: id(),
    alpha: 1,
    name: 'Grid',
    parentId: folderId,
    visible: true,
    gridType: 'square',
    variant: 'clean',
    cleanOptions: { width: 1, colour: colour(0x555555) },
    // Dungeon Scrawl reads roughOptions even for a clean grid and crashes without it.
    roughOptions: {
      width: 1,
      colour: colour(0x555555),
      roughness: {
        segmentSizeMin: 1,
        segmentSizeMax: 10,
        segmentSkipRate: 0,
        noDotRate: 0.2,
        scribbleScale: 10,
        scribbleAmplitude: 0.7,
        shiftRate: 0.3,
        shiftAmountMin: 1,
        shiftAmountMax: 2,
        majorNoiseScale: 0.1,
        majorNoiseAmplitude: 15,
        majorNoiseShift: 0.9,
      },
    },
    dotsOptions: { radius: 1, colour: colour(0x555555) },
  };
  const shadow: Json = { type: 'SHADOW', id: id(), alpha: 1, name: '', parentId: folderId, visible: true, castFromInternalLines: true, tx: 12, ty: 9, colour: colour(0x8c867d), lineWidth: 5, roughOptions: 'low' };
  const hatching: Json = {
    type: 'HATCHING',
    id: id(),
    alpha: 1,
    name: '',
    parentId: shapeId,
    visible: true,
    variant: 'random',
    squareOptions: { padding: 4, lineCount: 5 },
    sharedOptions: { wallDistance: 30, strokeWidth: 2.5, strokeColour: colour(0x222222) },
  };
  const shading: Json = {
    type: 'BUFFER_SHADING',
    id: id(),
    alpha: 1,
    name: '',
    parentId: shapeId,
    visible: true,
    wallDistance: 23,
    roughness: 10,
    fill: { visible: true, colour: colour(0xc5b9ac) },
    stroke: { visible: false, colour: colour(0x999999), width: 1 },
  };
  for (const n of [walls, mask, floor, grid, shadow, hatching, shading]) add(n);
  add({ type: 'FOLDER', id: folderId, alpha: 1, parentId: shapeId, name: 'Grid, Shadow', visible: true, children: [mask.id, shadow.id, grid.id] });
  add({
    type: 'GEOMETRY',
    id: shapeId,
    alpha: 1,
    parentId: templateId,
    name: map.name,
    visible: true,
    allowsLightToPass: false,
    children: [shading.id, hatching.id, floor.id, folderId, walls.id],
    backgroundEffect: {},
    geometryId: floorGeo,
  });
  add({
    type: 'TEMPLATE',
    id: templateId,
    alpha: 1,
    parentId: pageId,
    name: map.name,
    visible: true,
    children: [shapeId],
    template: { type: 'V1', dungeonShape: shapeId, wall: walls.id, floor: floor.id, grid: grid.id, shadow: shadow.id, hatching: hatching.id, shading: shading.id },
  });
  geometry[floorGeo] = { polygons: computeFloor(map).map((p) => [closed(p.outer), ...p.holes.map(closed)]), polylines: [] };

  const pageChildren = [templateId];

  // Doors: rectangle inset 6 px from each end, 8 px thick, plus the two jamb lines.
  const doors = map.objects.filter((o): o is Door => o.type === 'door');
  const texts: { content: string; at: Point; fontSize: number }[] = [];
  for (const d of doors) {
    const kind = d.style ?? 'normal';
    const [a, b] = doorSegment(d);
    if (kind === 'secret') {
      if (gm) texts.push({ content: 'S', at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], fontSize: 28 });
      continue;
    }
    if (kind === 'archway') continue;
    const [ax, ay, bx, by] = [px(a[0]), px(a[1]), px(b[0]), px(b[1])];
    const horizontal = d.along === 'x';
    // a turned door: the same rectangle and jambs, turned with it (the asset itself keeps the identity transform)
    const [ux, uy] = doorDirection(d);
    const tp = (x: number, y: number, s: number, t: number): number[] => [Math.round((x + ux * s - uy * t) * 1000) / 1000, Math.round((y + uy * s + ux * t) * 1000) / 1000];
    const rect = isTurned(d)
      ? [tp(ax, ay, 6, -4), tp(bx, by, -6, -4), tp(bx, by, -6, 4), tp(ax, ay, 6, 4)]
      : horizontal
        ? [[ax + 6, ay - 4], [bx - 6, ay - 4], [bx - 6, ay + 4], [ax + 6, ay + 4]]
        : [[ax + 4, ay + 6], [ax + 4, by - 6], [ax - 4, by - 6], [ax - 4, ay + 6]];
    const jambs = isTurned(d)
      ? [[tp(ax, ay, 0, 0), tp(ax, ay, 6, 0)], [tp(bx, by, -6, 0), tp(bx, by, 0, 0)]]
      : horizontal
        ? [[[ax, ay], [ax + 6, ay]], [[bx - 6, by], [bx, by]]]
        : [[[ax, ay], [ax, ay + 6]], [[bx, by - 6], [bx, by]]];
    const assetId = id();
    const geoNode = id();
    const geo = id();
    const style = poly('Door style', geoNode, colour(0xffffff), { width: 2, colour: colour(0) });
    add(style);
    add({ type: 'GEOMETRY', id: geoNode, alpha: 1, parentId: assetId, name: 'Door geometry', visible: true, allowsLightToPass: false, children: [style.id], backgroundEffect: {}, geometryId: geo });
    add({ type: 'DUNGEON_ASSET', id: assetId, alpha: 1, name: 'Door', parentId: pageId, children: [geoNode], visible: true, transform: [1, 0, 0, 1, 0, 0] });
    geometry[geo] = { polygons: [[rect]], polylines: jambs };
    pageChildren.push(assetId);
  }

  // Text: room numbers at room centres (GM only), free labels where they are.
  if (gm) {
    for (const r of map.objects) {
      if (r.type !== 'room' || !r.label) continue;
      const bb = shapeBounds(r.shape);
      texts.push({ content: r.label, at: [(bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2], fontSize: 48 });
    }
  }
  for (const l of map.objects) if (l.type === 'label') texts.push({ content: l.text, at: l.at, fontSize: Math.round((l.size ?? 0.63) * DS_PX * 2) });
  for (const t of texts) {
    // Dungeon Scrawl anchors text top-left at half scale; shift so the text centres on `at`.
    const size = t.fontSize * 0.5;
    const x = px(t.at[0]) - (t.content.length * size * 0.55) / 2;
    const y = px(t.at[1]) - (size * 1.2) / 2;
    const tid = add({
      type: 'TEXT',
      id: id(),
      alpha: 1,
      name: '',
      parentId: pageId,
      visible: true,
      transform: [0.5, 0, 0, 0.5, Math.round(x * 100) / 100, Math.round(y * 100) / 100],
      content: t.content,
      style: textStyle(t.fontSize),
    });
    pageChildren.push(tid);
  }

  add({
    type: 'PAGE',
    id: pageId,
    parentId: 'document',
    name: '',
    children: pageChildren,
    selection: [templateId],
    alpha: 1,
    objectSelection: [],
    lastSelectedDrawableNode: templateId,
    pageTransform: 'default',
    templateLocked: false,
    grid: { type: 'square', cellDiameter: DS_PX, variant: 'dots', visible: true, roughness: 'medium', dotsOptions: { radius: 1.5 }, linesOptions: { width: 1 }, sharedOptions: { colour: colour(0x666666, 0.5) } },
    // the map's own background colour (the editor's colour wheel), else Dungeon Scrawl's usual paper
    background: { colour: colour(ownBackground ? parseInt(ownBackground.slice(1), 16) : 0xefeae2) },
    lighting: { enabled: false, ambientLight: colour(0x334466), blur: 3 },
    texture: { enabled: false, scale: 1, alpha: 1 },
    backgroundTexture: { enabled: false, scale: 1 },
  });
  add({ type: 'DOCUMENT', id: 'document', name: map.name, selectedPage: pageId, children: [pageId] });

  return {
    version: 1,
    state: { document: { documentNodeId: 'document', nodes, undoStack: [], undoHistoryPaused: false, undoStackPointer: -1 } },
    data: { geometry, assets: {} },
    errors: [],
  };
}

// ---------- import ----------

export class DsImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DsImportError';
  }
}

const half = (v: number): number => Math.round((v / DS_PX) * 2) / 2 || 0;
const hundredth = (v: number): number => Math.round((v / DS_PX) * 100) / 100 || 0;

/** A ring from Dungeon Scrawl pixels to squares on the half-square grid; drops the closing point and repeats. */
function ringFrom(points: number[][], t: (p: number[]) => number[]): Point[] {
  const out: Point[] = [];
  for (const raw of points) {
    const [x, y] = t(raw);
    const p: Point = [half(x!), half(y!)];
    const last = out.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (out.length > 1 && out[0]![0] === out.at(-1)![0] && out[0]![1] === out.at(-1)![1]) out.pop();
  return out;
}

function shapeFrom(ring: Point[]): Shape {
  const xs = [...new Set(ring.map((p) => p[0]))];
  const ys = [...new Set(ring.map((p) => p[1]))];
  if (ring.length === 4 && xs.length === 2 && ys.length === 2) {
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    return { rect: [x0, y0, x1 - x0, y1 - y0] };
  }
  return { poly: ring };
}

const affine = (m: unknown): ((p: number[]) => number[]) => {
  const [a, b, c, d, e, f] = Array.isArray(m) && m.length === 6 ? (m as number[]) : [1, 0, 0, 1, 0, 0];
  return ([x, y]) => [a! * x! + c! * y! + e!, b! * x! + d! * y! + f!];
};

export interface DsImportResult {
  map: DelveMap;
  /** Plain-language notes about what came across and what didn't. */
  notes: string[];
}

/** A Quillwarren map from a Dungeon Scrawl document (the parsed "map" entry of a .ds file). */
export function fromDungeonScrawl(input: unknown, opts: { id: string; name?: string; seed?: number }): DsImportResult {
  const doc = input as { state?: { document?: { nodes?: Record<string, Json> } }; data?: { geometry?: Record<string, DsGeometry> } };
  const nodes = doc?.state?.document?.nodes;
  const geo = doc?.data?.geometry;
  if (!nodes || !geo) throw new DsImportError('this is not a Dungeon Scrawl map (no document nodes or geometry)');
  const all = Object.values(nodes);
  const objects: MapObject[] = [];
  const notes: string[] = [];
  const next = (prefix: string) => `${prefix}${objects.filter((o) => o.id.startsWith(prefix)).length + 1}`;

  // Floor: every template's dungeon shape. Each polygon is an outer ring plus holes.
  let areas = 0;
  for (const t of all.filter((n) => n.type === 'TEMPLATE')) {
    const shapeNode = nodes[(t.template as Json | undefined)?.dungeonShape as string];
    const g = geo[shapeNode?.geometryId as string];
    if (!g) continue;
    for (const polygon of g.polygons ?? []) {
      const [outer, ...holes] = polygon;
      const ring = outer ? ringFrom(outer, (p) => p) : [];
      if (ring.length < 3) continue;
      areas++;
      objects.push({ id: next('r'), type: 'room', shape: shapeFrom(ring), name: `Imported area${areas > 1 ? ` ${areas}` : ''}` });
      for (const h of holes) {
        const hr = ringFrom(h, (p) => p);
        if (hr.length >= 3) objects.push({ id: next('p'), type: 'cutout', shape: shapeFrom(hr) });
      }
    }
  }
  if (!areas) throw new DsImportError('the file has no dungeon floor to import');

  // Doors: a dungeon asset whose geometry has two jamb lines; the door runs from one jamb's outer end to the other's.
  let doors = 0;
  let skipped = 0;
  for (const asset of all.filter((n) => n.type === 'DUNGEON_ASSET')) {
    const t = affine(asset.transform);
    const geoNode = ((asset.children as string[] | undefined) ?? []).map((c) => nodes[c]).find((n) => n?.type === 'GEOMETRY');
    const lines = geo[geoNode?.geometryId as string]?.polylines ?? [];
    if (lines.length !== 2 || lines.some((l) => l.length !== 2)) {
      skipped++;
      continue;
    }
    // a door at a slant (more than a degree off both axes) comes in turned: from one jamb's outer end to the other's
    const raw = lines.map((l) => l.map((p) => t(p)).map(([x, y]) => [hundredth(x!), hundredth(y!)] as Point));
    const [a, b] = raw[0]!.flatMap((p) => raw[1]!.map((q): [Point, Point] => [p, q])).reduce((best, s) => (Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]) > Math.hypot(best[1][0] - best[0][0], best[1][1] - best[0][1]) ? s : best));
    const slant = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    if (Math.abs(slant / 90 - Math.round(slant / 90)) * 90 > 1 && Math.hypot(b[0] - a[0], b[1] - a[1]) > 0) {
      doors++;
      objects.push({ id: next('d'), type: 'door', ...doorBetween(a, b), style: 'normal' });
      continue;
    }
    const pts = lines.flat().map((p) => t(p)).map(([x, y]) => [half(x!), half(y!)] as Point);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const horizontal = Math.max(...ys) - Math.min(...ys) < Math.max(...xs) - Math.min(...xs);
    const at: Point = [Math.min(...xs), Math.min(...ys)];
    const width = horizontal ? Math.max(...xs) - at[0] : Math.max(...ys) - at[1];
    if (width <= 0) {
      skipped++;
      continue;
    }
    doors++;
    objects.push({ id: next('d'), type: 'door', at, along: horizontal ? 'x' : 'y', width, style: 'normal' });
  }

  // Text: centre it the way the exporter anchors it.
  for (const t of all.filter((n) => n.type === 'TEXT')) {
    const content = String(t.content ?? '').trim();
    if (!content) continue;
    const [sx, , , , tx, ty] = Array.isArray(t.transform) ? (t.transform as number[]) : [1, 0, 0, 1, 0, 0];
    const fontSize = Number((t.style as Json | undefined)?.fontSize ?? 26) * (sx ?? 1);
    const at: Point = [hundredth(tx! + (content.length * fontSize * 0.55) / 2), hundredth(ty! + (fontSize * 1.2) / 2)];
    objects.push({ id: next('l'), type: 'label', text: content.slice(0, 200), at, size: Math.round((fontSize / DS_PX) * 100) / 100 });
  }

  const others = all.filter((n) => !['DOCUMENT', 'PAGE', 'TEMPLATE', 'GEOMETRY', 'MULTIPOLYGON', 'FOLDER', 'GRID', 'SHADOW', 'HATCHING', 'BUFFER_SHADING', 'DUNGEON_ASSET', 'TEXT'].includes(String(n.type)));
  notes.push(
    `Dungeon Scrawl keeps the floor as one merged outline, so it came in as ${areas} area${areas === 1 ? '' : 's'} (reshape or split them in the editor), not as separate rooms.`,
  );
  if (doors) notes.push(`${doors} door${doors === 1 ? '' : 's'} came across as normal doors.`);
  if (skipped + others.length) notes.push(`${skipped + others.length} other object${skipped + others.length === 1 ? '' : 's'} (images, stamps, unknown assets) were left out.`);

  const docNode = nodes.document as Json | undefined;
  const map: DelveMap = {
    format: FORMAT,
    version: FORMAT_VERSION,
    id: opts.id,
    name: (opts.name ?? String(docNode?.name ?? '')).trim().slice(0, 200) || 'Imported map',
    grid: { type: 'square', unit: '5 ft' },
    style: { preset: 'classic-hatching' },
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    objects,
  };
  return { map: validateMap(map), notes };
}
