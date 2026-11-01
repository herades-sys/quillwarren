// Dynamic vision for Quillwarren Table (docs/TABLE.md, "Vision and light"): which
// walls and doors block sight on a page, which tokens and map props give light,
// which tokens see, what the party sees together, how the explored fog grows,
// and which tokens a player may be sent. Pure, like the rest of @delve/table;
// the server (apps/server/src/table/vision.ts) runs it and keeps the explored
// fog. Party vision is shared: every player gets the union of what all
// player-controlled tokens on the page see. Per-player vision is a later option.
import type { Ambient, Member, Page, PageDoor, Token, VisionMode } from './protocol.ts';
import {
  anyPointIn,
  area,
  circle,
  intersect,
  rectSamples,
  ringPoly,
  segmentStrips,
  simplify,
  union,
  visibilityPolygon,
  withWalls,
  type Box,
  type Poly,
  type Ring,
  type Seg,
} from './vision.ts';

/**
 * Lights of the Quillwarren props, in cells (5 ft each): bright, then dim for that
 * many cells more. A torch sheds 20 ft bright and 20 ft dim, a lantern 30 and 30.
 * The GM's light marker (a GM symbol, never drawn for players) is an invisible lamp.
 */
export const PROP_LIGHTS: Readonly<Record<string, { bright: number; dim: number }>> = {
  sconce: { bright: 4, dim: 4 },
  brazier: { bright: 4, dim: 4 },
  campfire: { bright: 4, dim: 4 },
  candles: { bright: 1, dim: 1 },
  lantern: { bright: 6, dim: 6 },
  chandelier: { bright: 6, dim: 6 },
  fireplace: { bright: 3, dim: 3 },
  'cooking-fire': { bright: 3, dim: 3 },
  forge: { bright: 3, dim: 3 },
  oven: { bright: 1, dim: 1 },
  light: { bright: 6, dim: 6 },
};

/** How far the drawn wall reaches past the wall line (half a wall stroke or a door leaf, with some slack). */
export const WALL_HALF = 0.15;
const WALL_REACH = 0.2;
/** Explored grows only by more than this (cells²): tiny slivers from moving inside seen ground don't count. */
const MIN_GROWTH = 0.05;
/** Above this many corners the explored fog is simplified harder. */
const MAX_EXPLORED_POINTS = 30000;

export interface PageVisionSettings {
  mode: VisionMode;
  ambient: Ambient;
}

export function visionOf(page: Pick<Page, 'vision'> | null | undefined): PageVisionSettings {
  return { mode: page?.vision?.mode === 'dynamic' ? 'dynamic' : 'off', ambient: page?.vision?.ambient ?? 'dark' };
}

export const isDynamic = (page: Pick<Page, 'vision'> | null | undefined): boolean => page?.vision?.mode === 'dynamic';

// ---------- what blocks ----------

/** Open, by the table's own state first, then the map's. Archways have no door to shut. */
export function doorIsOpen(page: Pick<Page, 'doorState'>, d: PageDoor): boolean {
  if (d.style === 'archway') return true;
  return page.doorState?.[d.id] ?? d.open ?? false;
}

/** Shut doors block sight; a portcullis is bars you see through, an archway an opening. */
export function doorBlocks(page: Pick<Page, 'doorState'>, d: PageDoor): boolean {
  if (d.style === 'archway' || d.style === 'portcullis') return false;
  return !doorIsOpen(page, d);
}

const near = (a: readonly [number, number], b: readonly [number, number]) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const sameSeg = (s: Seg, a: [number, number], b: [number, number]) => (near(s[0], a) && near(s[1], b)) || (near(s[0], b) && near(s[1], a));

/**
 * The segments that block sight: the page's walls (secret doors are in them,
 * shut, unless the GM opened one) plus every other door that is shut.
 */
export function blockersOf(page: Pick<Page, 'walls' | 'doors' | 'doorState'>): Seg[] {
  const doors = page.doors ?? [];
  const openSecret = doors.filter((d) => d.style === 'secret' && doorIsOpen(page, d));
  const walls = (page.walls ?? []) as Seg[];
  const out: Seg[] = openSecret.length ? walls.filter((w) => !openSecret.some((d) => sameSeg(w, d.a, d.b))) : [...walls];
  for (const d of doors) if (d.style !== 'secret' && doorBlocks(page, d)) out.push([d.a, d.b]);
  return out;
}

// ---------- lights and eyes ----------

export interface LightSource {
  x: number;
  y: number;
  bright: number;
  dim: number;
}

export interface Eye {
  id: string;
  x: number;
  y: number;
  /** Unset: unlimited. */
  range?: number;
  darkvision: number;
}

const centre = (t: Token): [number, number] => [t.x + t.w / 2, t.y + t.h / 2];

/** The map's lights and the tokens' (any layer: a gm-layer token is how the GM hangs an invisible lamp). */
export function lightsOf(page: Pick<Page, 'id' | 'lights'>, tokens: readonly Token[]): LightSource[] {
  const out: LightSource[] = (page.lights ?? []).filter((l) => l.bright + l.dim > 0).map((l) => ({ x: l.x, y: l.y, bright: l.bright, dim: l.dim }));
  for (const t of tokens) {
    if (t.pageId !== page.id || !t.light || !(t.light.bright + t.light.dim > 0)) continue;
    const [x, y] = centre(t);
    out.push({ x, y, bright: t.light.bright, dim: t.light.dim });
  }
  return out;
}

/** Controlled by a player (any member but the GM, or "all"). */
export const playerControlled = (t: Pick<Token, 'controlledBy'>): boolean => t.controlledBy.some((id) => id !== 'gm');

/** Does this token see for the party? Never on the gm layer; else its own switch, or by default when a player controls it. */
export function givesSight(t: Token): boolean {
  if (t.layer === 'gm') return false;
  return t.sight?.enabled ?? playerControlled(t);
}

export function eyesOf(page: Pick<Page, 'id'>, tokens: readonly Token[]): Eye[] {
  return tokens
    .filter((t) => t.pageId === page.id && givesSight(t))
    .map((t) => {
      const [x, y] = centre(t);
      const eye: Eye = { id: t.id, x, y, darkvision: Math.max(0, t.sight?.darkvision ?? 0) };
      if (t.sight?.range !== undefined) eye.range = t.sight.range;
      return eye;
    });
}

/** Does this token's change move what the party sees (an eye or a light, before or after)? */
export const affectsSight = (t: Token | undefined): boolean => Boolean(t && (givesSight(t) || (t.light && t.light.bright + t.light.dim > 0)));

// ---------- what the party sees ----------

const pageBox = (p: Pick<Page, 'origin' | 'width' | 'height'>, pad = 2): Box => ({
  x0: p.origin[0] - pad,
  y0: p.origin[1] - pad,
  x1: p.origin[0] + p.width + pad,
  y1: p.origin[1] + p.height + pad,
});

/**
 * Visibility polygons per position and radius for one page, so a token that
 * moves costs one new polygon and the map's lights none. It forgets everything
 * when the page's walls, doors or door state change (compared by reference:
 * the game state is immutable, so a change is a new array).
 */
export class SightCache {
  private walls: unknown = null;
  private doors: unknown = null;
  private doorState: unknown = null;
  private blockerList: Seg[] = [];
  private stripList: { box: Box; ring: Ring }[] | null = null;
  private readonly views = new Map<string, Poly[]>();
  private box: Box = { x0: 0, y0: 0, x1: 1, y1: 1 };
  /** Kept polygons at most; the oldest go first. */
  readonly limit: number;

  constructor(limit = 400) {
    this.limit = limit;
  }

  prepare(page: Page): void {
    const box = pageBox(page);
    const boxChanged = box.x0 !== this.box.x0 || box.y0 !== this.box.y0 || box.x1 !== this.box.x1 || box.y1 !== this.box.y1;
    if (page.walls === this.walls && page.doors === this.doors && page.doorState === this.doorState && !boxChanged) return;
    this.walls = page.walls;
    this.doors = page.doors;
    this.doorState = page.doorState;
    this.box = box;
    this.blockerList = blockersOf(page);
    this.stripList = null;
    this.views.clear();
  }

  blockers(): Seg[] {
    return this.blockerList;
  }

  strips(): { box: Box; ring: Ring }[] {
    return (this.stripList ??= segmentStrips(this.blockerList, WALL_HALF));
  }

  /** What is in line of sight from (x, y), out to `r` cells (unset: the whole page). */
  view(x: number, y: number, r?: number): Poly[] {
    const key = `${x.toFixed(4)},${y.toFixed(4)},${r === undefined ? '-' : r.toFixed(4)}`;
    const hit = this.views.get(key);
    if (hit) {
      // most recently used goes last
      this.views.delete(key);
      this.views.set(key, hit);
      return hit;
    }
    const b = this.box;
    const box: Box =
      r === undefined
        ? { x0: Math.min(b.x0, x - 1), y0: Math.min(b.y0, y - 1), x1: Math.max(b.x1, x + 1), y1: Math.max(b.y1, y + 1) }
        : { x0: x - r - 0.5, y0: y - r - 0.5, x1: x + r + 0.5, y1: y + r + 0.5 };
    const ring = visibilityPolygon([x, y], this.blockerList, box);
    let polys = ringPoly(ring);
    if (r !== undefined) polys = r > 0 ? intersect(polys, ringPoly(circle([x, y], r))) : [];
    this.views.set(key, polys);
    while (this.views.size > this.limit) this.views.delete(this.views.keys().next().value!);
    return polys;
  }
}

export interface PartySight {
  /** Exactly what the party sees: decides which tokens players get. Server only. */
  raw: Poly[];
  /** `raw` plus the walls and doors at its edge as drawn: what clients draw and the page picture is cut to. */
  visible: Poly[];
  /** The part of `visible` in bright light. */
  bright: Poly[];
  /** The tokens that saw. */
  eyes: string[];
}

export const NO_SIGHT: PartySight = Object.freeze({ raw: [], visible: [], bright: [], eyes: [] }) as PartySight;

/**
 * What the party sees on a dynamic page: for each token that sees, its line of
 * sight (walls and shut doors block) out to its range, and of that only what is
 * lit or within its darkvision; then all of them together. Under a bright
 * ambient, everything in sight is lit; under dim, too, but only bright lights
 * (and darkvision, which sees dim as bright) count as bright.
 */
export function partySight(page: Page, tokens: readonly Token[], cache: SightCache = new SightCache()): PartySight {
  const { ambient } = visionOf(page);
  cache.prepare(page);
  const onPage = tokens.filter((t) => t.pageId === page.id);
  const eyes = eyesOf(page, onPage);
  if (!eyes.length) return NO_SIGHT;
  const lights = ambient === 'bright' ? [] : lightsOf(page, onPage);
  const litAll = ambient === 'dark' ? union(...lights.map((l) => cache.view(l.x, l.y, l.bright + l.dim))) : [];
  const litBright = ambient === 'bright' ? [] : union(...lights.filter((l) => l.bright > 0).map((l) => cache.view(l.x, l.y, l.bright)));
  const parts: Poly[][] = [];
  const sharp: Poly[][] = []; // darkvision circles: under a dim ambient they count as bright
  for (const e of eyes) {
    const inSight = cache.view(e.x, e.y, e.range);
    const dv = e.darkvision > 0 ? ringPoly(circle([e.x, e.y], e.darkvision)) : [];
    if (ambient === 'dark') parts.push(intersect(inSight, dv.length ? union(litAll, dv) : litAll));
    else parts.push(inSight);
    if (ambient === 'dim' && dv.length) sharp.push(dv);
  }
  const raw = union(...parts);
  const brightRaw = ambient === 'bright' ? raw : intersect(raw, sharp.length ? union(litBright, ...sharp) : litBright);
  const strips = cache.strips();
  const visible = simplify(withWalls(raw, strips, WALL_REACH), 0.005);
  const bright = ambient === 'bright' ? visible : simplify(withWalls(brightRaw, strips, WALL_REACH), 0.005);
  return { raw, visible, bright, eyes: eyes.map((e) => e.id) };
}

// ---------- explored fog ----------

/** Everything the party has seen on a page. `all`: the GM revealed the whole page. */
export interface Explored {
  version: number;
  all?: boolean;
  polys: Poly[];
  /** Cells², kept so growth is cheap to measure. */
  area?: number;
}

export const nothingExplored = (version = 0): Explored => ({ version, polys: [], area: 0 });

const points = (polys: readonly Poly[]): number => polys.reduce((n, p) => n + p.outer.length + p.holes.reduce((m, h) => m + h.length, 0), 0);

/** Explored plus what is visible now, with a new version; null when that adds (next to) nothing. */
export function exploreMore(explored: Explored, visible: readonly Poly[]): Explored | null {
  if (explored.all || !visible.length) return null;
  const before = explored.area ?? area(explored.polys);
  const merged = union(explored.polys, visible);
  const after = area(merged);
  if (after - before <= MIN_GROWTH) return null;
  let polys = simplify(merged, 0.002);
  if (points(polys) > MAX_EXPLORED_POINTS) polys = simplify(polys, 0.02);
  return { version: explored.version + 1, polys, area: area(polys) };
}

// ---------- which tokens a player gets ----------

/**
 * Does the party see this token? Tokens layer: while its footprint is in sight
 * (touching the edge, or a sliver of under 0.2 cells, doesn't count). Map layer
 * (scenery): once its spot is explored, like the page picture. GM layer: never.
 */
export function tokenSeen(t: Token, sight: Pick<PartySight, 'raw'>, explored: Explored): boolean {
  if (t.layer === 'gm') return false;
  const pts = rectSamples(t.x, t.y, t.w, t.h, t.rotation ?? 0);
  if (t.layer === 'map') return explored.all === true || anyPointIn(explored.polys, pts);
  return anyPointIn(sight.raw, pts);
}

/**
 * On a dynamic page, which of its tokens players may get (besides their own);
 * the GM gets every token anyway. `sees` is asked about a token where it is
 * now, so a token that just moved or was just made is judged by its new spot.
 */
export interface TokenFilter {
  pageId: string;
  sees(t: Token): boolean;
}

/** The filter for a page from what the party sees: the tokens that see for it, and whatever tokenSeen() says. */
export function sightFilter(pageId: string, sight: PartySight, explored: Explored): TokenFilter {
  const eyes = new Set(sight.eyes);
  const memo = new WeakMap<Token, boolean>(); // the state is immutable: a moved token is a new object
  return {
    pageId,
    sees(t) {
      let v = memo.get(t);
      if (v === undefined) {
        v = t.layer !== 'gm' && (eyes.has(t.id) || givesSight(t) || tokenSeen(t, sight, explored));
        memo.set(t, v);
      }
      return v;
    },
  };
}

/** The tokens on the page the party sees; the ones that see for it are always among them. */
export function seenTokens(page: Pick<Page, 'id'>, tokens: readonly Token[], sight: PartySight, explored: Explored): Set<string> {
  const filter = sightFilter(page.id, sight, explored);
  const out = new Set<string>();
  for (const t of tokens) if (t.pageId === page.id && filter.sees(t)) out.add(t.id);
  return out;
}

export const controlsToken = (t: Pick<Token, 'controlledBy'>, memberId: string): boolean => t.controlledBy.includes(memberId) || t.controlledBy.includes('all');

/** May `member` be sent this token? GM: always. Players: never gm-layer ones; on a filtered page only their own and the ones the party sees. */
export function mayGetToken(member: Pick<Member, 'id' | 'role'> | undefined, t: Token, filter?: TokenFilter | null): boolean {
  if (!member) return false;
  if (member.role === 'gm') return true;
  if (t.layer === 'gm') return false;
  if (!filter || t.pageId !== filter.pageId) return true;
  return controlsToken(t, member.id) || filter.sees(t);
}
