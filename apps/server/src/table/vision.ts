// Dynamic vision on the server (docs/TABLE.md, "Vision and light"). For every
// page with vision.mode "dynamic" this keeps what the party sees right now,
// recomputed at most every 120 ms after an eye or a light moves, a door turns,
// or the walls, lights or settings change (and always once more for the last
// change); grows the explored fog and stores it in table.db; and answers the
// one question everything sent to players goes through: may this member get
// this token? The live hub (live.ts) asks it and sends the results; the page
// picture (vision-render.ts) is cut to the explored fog.
//
// The 3D view's revealedRegion(page, map, member) can call revealedRegion()
// below: 'all' for the GM, the explored polygons for a player on a dynamic
// page, null when the page has no dynamic vision (then the Quillwarren map's room
// fog applies, as before).
import {
  computeWalls,
  doorSegment,
  drawnFloor,
  shutDoorLines,
  insidePolygons,
  type DelveMap,
  type Door,
  type Polygon,
  type Prop,
} from '@delve/core';
import {
  exploreMore,
  isDynamic,
  mayGetToken,
  nothingExplored,
  NO_SIGHT,
  pageFor,
  partySight,
  PROP_LIGHTS,
  seenTokens,
  SightCache,
  sightFilter,
  visionOf,
  type Explored,
  type GameState,
  type Member,
  type Page,
  type PageDoor,
  type PageLight,
  type PartySight,
  type Poly,
  type Token,
  type TokenFilter,
  type VisionView,
} from '@delve/table';
import type { TableStore } from './store.ts';

/** At most one recompute per page this often while things move. */
export const VISION_THROTTLE_MS = 120;

/** What the party sees on one page right now. */
export interface PageSight {
  gameId: string;
  pageId: string;
  sight: PartySight;
  explored: Explored;
  /** Token ids the party sees (at the time of the computation). */
  seen: Set<string>;
  /** Changes whenever what clients draw changes (visible, bright or explored). */
  sig: string;
}

interface Entry {
  cache: SightCache;
  now: PageSight | null;
  timer: ReturnType<typeof setTimeout> | null;
  last: number;
  /** "Hide everything": nothing is seen until the party next looks (an eye or a light moves, a door turns). */
  blind: boolean;
}

/** Called after each recompute with the old and new sight, so the hub can send what changed. */
export type VisionListener = (state: GameState, now: PageSight, before: PageSight | null) => void;

const key = (gameId: string, pageId: string) => `${gameId}\n${pageId}`;

export class TableVision {
  private readonly entries = new Map<string, Entry>();
  private readonly store: TableStore;
  private readonly listener: VisionListener;
  private readonly onError: (err: unknown) => void;
  readonly throttleMs: number;

  constructor(store: TableStore, listener: VisionListener, throttleMs = VISION_THROTTLE_MS, onError: (err: unknown) => void = () => {}) {
    this.store = store;
    this.listener = listener;
    this.throttleMs = throttleMs;
    this.onError = onError;
  }

  /** Compute, failing closed: if the geometry ever throws, the party sees nothing new (and it's logged). */
  private safeCompute(state: GameState, page: Page): PageSight {
    try {
      return this.compute(state, page);
    } catch (err) {
      this.onError(err);
      const explored = this.explored(state.id, page.id);
      const now: PageSight = { gameId: state.id, pageId: page.id, sight: NO_SIGHT, explored, seen: new Set(), sig: `error|${explored.version}` };
      this.entry(state.id, page.id).now = now;
      return now;
    }
  }

  private entry(gameId: string, pageId: string): Entry {
    let e = this.entries.get(key(gameId, pageId));
    if (!e) this.entries.set(key(gameId, pageId), (e = { cache: new SightCache(), now: null, timer: null, last: 0, blind: false }));
    return e;
  }

  /** The stored explored fog of a page (nothing yet: version 0, empty). */
  explored(gameId: string, pageId: string): Explored {
    return this.store.explored(gameId, pageId) ?? nothingExplored();
  }

  /** Compute a dynamic page's sight now, grow its explored fog, and keep the result. */
  private compute(state: GameState, page: Page): PageSight {
    const e = this.entry(state.id, page.id);
    const sight = e.blind ? NO_SIGHT : partySight(page, state.tokens, e.cache);
    let explored = this.explored(state.id, page.id);
    const grown = exploreMore(explored, sight.visible);
    if (grown) {
      explored = grown;
      this.store.setExplored(state.id, page.id, explored);
    }
    const seen = seenTokens(page, state.tokens, sight, explored);
    const sig = `${explored.version}|${visionOf(page).ambient}|${JSON.stringify(sight.visible)}|${JSON.stringify(sight.bright)}`;
    const now: PageSight = { gameId: state.id, pageId: page.id, sight, explored, seen, sig };
    e.now = now;
    e.last = Date.now();
    return now;
  }

  /** The sight of a page with dynamic vision (computed now if there's none yet), or null without it. */
  current(state: GameState, pageId: string): PageSight | null {
    const page = state.pages.find((p) => p.id === pageId);
    if (!page || !isDynamic(page)) return null;
    const e = this.entry(state.id, pageId);
    return e.now ?? this.safeCompute(state, page);
  }

  /** The token filter for what `memberId` looks at, or null: the GM, or a page without dynamic vision. */
  filterFor(state: GameState, memberId: string): TokenFilter | null {
    const me = state.members.find((m) => m.id === memberId);
    if (!me || me.role === 'gm') return null;
    const now = this.current(state, pageFor(state, memberId));
    return now ? sightFilter(now.pageId, now.sight, now.explored) : null;
  }

  /**
   * Something on a page changed that may change what the party sees: recompute
   * soon. At most once per throttle window, and always once after the last
   * change, so the final position is never missed.
   */
  touch(gameId: string, pageId: string, getState: () => GameState | undefined): void {
    const e = this.entry(gameId, pageId);
    if (e.timer) return;
    const wait = Math.max(0, e.last + this.throttleMs - Date.now());
    e.timer = setTimeout(() => {
      e.timer = null;
      e.blind = false;
      try {
        this.run(gameId, pageId, getState());
      } catch (err) {
        this.onError(err); // a timer must never throw: that would end the process
      }
    }, wait);
    e.timer.unref?.();
  }

  /** Recompute now and tell the listener. */
  run(gameId: string, pageId: string, state: GameState | undefined): void {
    const page = state?.pages.find((p) => p.id === pageId);
    if (!state || !page || !isDynamic(page)) {
      this.forget(gameId, pageId, false);
      return;
    }
    const before = this.entry(gameId, pageId).now;
    const now = this.safeCompute(state, page);
    this.listener(state, now, before);
  }

  /** The GM's explored tools: reset (forget; what is seen now stays), reveal (the whole page), hide (nothing, until the party next looks). */
  setExplored(state: GameState, pageId: string, action: 'reset' | 'reveal' | 'hide'): void {
    const page = state.pages.find((p) => p.id === pageId);
    if (!page) return;
    const version = this.explored(state.id, pageId).version + 1;
    this.store.setExplored(state.id, pageId, action === 'reveal' ? { version, all: true, polys: [] } : nothingExplored(version));
    const e = this.entry(state.id, pageId);
    e.blind = action === 'hide';
    if (e.timer) {
      clearTimeout(e.timer);
      e.timer = null;
    }
    if (isDynamic(page)) this.run(state.id, pageId, state);
  }

  /** Drop what is kept about a page (deleted, or no longer dynamic); `explored` also deletes its stored fog. */
  forget(gameId: string, pageId: string, explored: boolean): void {
    const e = this.entries.get(key(gameId, pageId));
    if (e?.timer) clearTimeout(e.timer);
    this.entries.delete(key(gameId, pageId));
    if (explored) this.store.dropExplored(gameId, pageId);
  }

  /** The game was deleted. */
  forgetGame(gameId: string): void {
    for (const k of [...this.entries.keys()]) {
      if (!k.startsWith(`${gameId}\n`)) continue;
      const e = this.entries.get(k);
      if (e?.timer) clearTimeout(e.timer);
      this.entries.delete(k);
    }
  }

  close(): void {
    for (const e of this.entries.values()) if (e.timer) clearTimeout(e.timer);
    this.entries.clear();
  }

  /** The vision message for a member about the page they look at (null: it has no dynamic vision). */
  viewFor(state: GameState, member: Member, now: PageSight | null, withExplored: boolean): VisionView | null {
    if (!now) return null;
    const page = state.pages.find((p) => p.id === now.pageId);
    const v: VisionView = {
      pageId: now.pageId,
      visible: now.sight.visible,
      bright: now.sight.bright,
      exploredVersion: now.explored.version,
      ambient: visionOf(page).ambient,
    };
    if (withExplored) v.explored = now.explored.all ? 'all' : now.explored.polys;
    if (member.role === 'gm') v.seen = [...now.seen];
    return v;
  }

  /**
   * What of a page `memberId` may see drawn: 'all' (the GM, or everything
   * revealed), the explored polygons (a player on their own dynamic page; [] for
   * any other page), or null when the page has no dynamic vision.
   */
  revealedRegion(state: GameState, page: Page, memberId: string): Poly[] | 'all' | null {
    if (!isDynamic(page)) return null;
    const me = state.members.find((m) => m.id === memberId);
    if (!me) return [];
    if (me.role === 'gm') return 'all';
    if (pageFor(state, memberId) !== page.id) return [];
    const e = this.current(state, page.id)?.explored ?? this.explored(state.id, page.id);
    return e.all ? 'all' : e.polys;
  }

  /** May `memberId` be sent `token` (dynamic vision on its page included)? */
  mayGet(state: GameState, memberId: string, token: Token): boolean {
    return mayGetToken(
      state.members.find((m) => m.id === memberId),
      token,
      this.filterFor(state, memberId),
    );
  }
}

/**
 * For the 3D table view (scene3d.ts revealedRegion): what of a dynamic page is
 * drawn for someone. 'all' for the GM's own view (or once the GM revealed the
 * whole page); for a player, or the GM looking as the players, the explored
 * fog in cells (what the party has seen, walls at its edge included; [] for a
 * page that isn't the player's own). null: the page has no dynamic vision, so
 * the caller keeps its own rule (the Quillwarren map's room fog). Pass hub.vision.
 */
export function exploredRegion(
  vision: TableVision,
  state: GameState,
  page: Page,
  who: { member: Pick<Member, 'id' | 'role'> | string; view?: 'gm' | 'players' },
): Polygon[] | 'all' | null {
  if (!isDynamic(page)) return null;
  const memberId = typeof who.member === 'string' ? who.member : who.member.id;
  const me = state.members.find((m) => m.id === memberId);
  if (!me) return [];
  if (me.role === 'gm') {
    if (who.view !== 'players') return 'all';
    const e = vision.current(state, page.id)?.explored ?? vision.explored(state.id, page.id);
    return e.all ? 'all' : e.polys;
  }
  return vision.revealedRegion(state, page, memberId);
}

// ---------- page data from a Quillwarren map ----------

const isDoor = (o: DelveMap['objects'][number]): o is Door => o.type === 'door';
const isProp = (o: DelveMap['objects'][number]): o is Prop => o.type === 'prop';

/** A light's spot: the prop's centre, or the nearest spot on the floor when that's in the wall (a sconce hung on it). */
function onFloor(floor: readonly Polygon[], at: [number, number]): [number, number] {
  if (insidePolygons(floor, at)) return at;
  for (const d of [0.1, 0.25, 0.4, 0.6]) {
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const p: [number, number] = [at[0] + dx * d, at[1] + dy * d];
      if (insidePolygons(floor, p)) return p;
    }
  }
  return at;
}

/**
 * What a page needs from its Quillwarren map for vision: the walls as the players
 * see them (secret doors shut: they open no gap and close their opening, so
 * the page data never gives one away; rough edges as drawn), the doors, and
 * the lights of its light props (PROP_LIGHTS).
 */
export function pageSightData(map: DelveMap): { walls: [[number, number], [number, number]][]; doors: PageDoor[]; lights: PageLight[] } {
  const floor = drawnFloor(map);
  const secret = (o: DelveMap['objects'][number]): o is Door => isDoor(o) && o.style === 'secret';
  const shut = { ...map, objects: map.objects.filter((o) => !secret(o)) };
  const walls = [...computeWalls(shut, floor), ...shutDoorLines(map.objects.filter(secret), floor)].map(
    ([a, b]): [[number, number], [number, number]] => [
      [a[0], a[1]],
      [b[0], b[1]],
    ],
  );
  const doors = map.objects.filter(isDoor).map((d): PageDoor => {
    const [a, b] = doorSegment(d);
    return { id: d.id, a: [a[0], a[1]], b: [b[0], b[1]], style: d.style ?? 'normal', ...(d.open ? { open: true } : {}) };
  });
  const lights = map.objects.filter(isProp).flatMap((p): PageLight[] => {
    const l = PROP_LIGHTS[p.asset];
    if (!l) return [];
    const [x, y] = onFloor(floor, [p.at[0], p.at[1]]);
    return [{ id: p.id, x, y, bright: l.bright, dim: l.dim, asset: p.asset }];
  });
  return { walls, doors, lights };
}

/** The map as the table has it: doors opened and shut by the GM; an opened secret door is drawn as an open door for players. */
export function withTableDoors(map: DelveMap, page: Pick<Page, 'doorState'>, view: 'gm' | 'players'): DelveMap {
  const state = page.doorState;
  if (!state || !Object.keys(state).length) return map;
  return {
    ...map,
    objects: map.objects.map((o) => {
      if (!isDoor(o) || state[o.id] === undefined) return o;
      const open = state[o.id]!;
      if (o.style === 'secret' && view === 'players') return open ? { ...o, style: 'normal', open: true } : o;
      return { ...o, open };
    }),
  };
}
