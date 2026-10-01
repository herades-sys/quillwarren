// The 3D table view's server side: the page /play/:gameId/3d (HTML in page3d.ts,
// script /assets/table3d.js) and the scene a member may see,
// GET /api/v1/games/:id/pages/:pageId/scene3d.json. Both check membership like
// /play/:gameId and background.png do, so public mode (where /play and
// /api/v1/games are open) still keeps them to the game's members.
//
// What players may see is decided in one place, revealedRegion(). Everything
// the players' scene holds (wall pieces, doors, stairs) is cut to that region
// here on the server, so nothing outside it ever leaves.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  clipPolylines,
  computeFloor,
  doorSegment,
  hashString,
  insidePolygons,
  roughFloor,
  shapeBounds,
  visiblePolygons,
  wallPolylines,
  type DelveMap,
  type Door,
  type Point,
  type Polygon,
  type Polyline,
  type Stairs,
} from '@delve/core';
import { pageFor, type GameState, type Member, type Page, type Scene3D, type SceneBox, type SceneDoor, type ScenePoint, type SceneStairs } from '@delve/table';
import { NotFoundError, type MapStore } from '../store.ts';
import { GAME_ID, memberOf, type AccessDeps } from './access.ts';
import { discordLoginUrl } from './discord.ts';
import { messagePage } from './html.ts';
import { table3dPage } from './page3d.ts';
import type { Account, TableStore } from './store.ts';

export interface RegionViewer {
  member: Member;
  /** The view asked for: the GM may look as the players do; players always get 'players'. */
  view: 'gm' | 'players';
}

/**
 * What a viewer may see of a page: 'all', or the polygons (cells) they have seen.
 * - The GM's own view: everything.
 * - Players (and the GM looking as them) on a Delve page with fog of war on:
 *   the map's revealed rooms and corridors, plus `show` minus `hide` areas,
 *   the same area the players' 2D picture is drawn from.
 * - Otherwise everything: without fog the players' picture shows the whole map.
 * Step 2 (line of sight) replaces this body; the scene's walls, doors and
 * stairs follow whatever it returns. (The floor picture still comes from
 * background.png, which follows the map's fog.)
 */
export function revealedRegion(_state: GameState, page: Page, map: DelveMap | null, viewer: RegionViewer): Polygon[] | 'all' {
  if (viewer.member.role === 'gm' && viewer.view === 'gm') return 'all';
  if (page.background.kind !== 'delve' || !map) return 'all';
  if (!map.fog?.on) return 'all';
  return visiblePolygons(map);
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000 + 0;
const pt = (p: Point): ScenePoint => [r3(p[0]), r3(p[1])];

/** A polyline as its segments, tiny leftovers dropped. */
function segmentsOf(line: Polyline): [ScenePoint, ScenePoint][] {
  const out: [ScenePoint, ScenePoint][] = [];
  const n = line.points.length;
  const count = line.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = line.points[i]!;
    const b = line.points[(i + 1) % n]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-3) out.push([pt(a), pt(b)]);
  }
  return out;
}

const polyBounds = (polys: readonly Polygon[]): SceneBox | null => {
  const pts = polys.flatMap((p) => p.outer);
  if (!pts.length) return null;
  return {
    x0: r3(Math.min(...pts.map((p) => p[0]))),
    y0: r3(Math.min(...pts.map((p) => p[1]))),
    x1: r3(Math.max(...pts.map((p) => p[0]))),
    y1: r3(Math.max(...pts.map((p) => p[1]))),
  };
};

/**
 * A Delve map's walls, doors and stairs for one view, cut to `region`. Built the
 * way the 2D picture is (core buildScene): the same rough floor, door gaps, and
 * for players secret doors shut (wall across, no door), so the 3D walls stand
 * exactly on the drawn ones.
 */
export function delveGeometry(map: DelveMap, view: 'gm' | 'players', region: Polygon[] | 'all'): { walls: [ScenePoint, ScenePoint][]; doors: SceneDoor[]; stairs: SceneStairs[] } {
  const seed = map.seed ?? hashString(map.id);
  const flat = computeFloor(map);
  const floor = roughFloor(map, flat, seed) ?? flat;
  const polys = region === 'all' ? null : region;
  const seen = (p: Point) => !polys || insidePolygons(polys, p);
  const cut = (lines: Polyline[]) => (polys ? clipPolylines(lines, polys) : lines);
  const doors = map.objects.filter((o): o is Door => o.type === 'door');
  const hidden = (d: Door) => view === 'players' && d.style === 'secret';
  const lines = cut(wallPolylines(map, floor, (d) => !hidden(d)));
  const shut = cut(doors.filter(hidden).map((d): Polyline => ({ points: doorSegment(d), closed: false })));
  const walls = [...lines, ...shut].flatMap(segmentsOf);
  const sceneDoors = doors.flatMap((d): SceneDoor[] => {
    if (hidden(d)) return [];
    const [a, b] = doorSegment(d);
    if (!seen([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) return [];
    return [{ a: pt(a), b: pt(b), style: d.style ?? 'normal', ...(d.open ? { open: true } : {}) }];
  });
  const stairs = map.objects.flatMap((o): SceneStairs[] => {
    if (o.type !== 'stairs') return [];
    const b = shapeBounds((o as Stairs).shape);
    if (!seen([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2])) return [];
    return [{ box: { x0: r3(b.x0), y0: r3(b.y0), x1: r3(b.x1), y1: r3(b.y1) }, direction: (o as Stairs).direction }];
  });
  return { walls, doors: sceneDoors, stairs };
}

/** Wall segments (a non-Delve page's own `walls`) cut to the region. */
function clipWalls(walls: readonly [[number, number], [number, number]][], region: Polygon[] | 'all'): [ScenePoint, ScenePoint][] {
  const lines = walls.map(([a, b]): Polyline => ({ points: [a, b], closed: false }));
  return (region === 'all' ? lines : clipPolylines(lines, region)).flatMap(segmentsOf);
}

/** The whole scene of one page for one view. `map` is the Delve map behind a Delve page (null otherwise). */
export function scene3d(gameId: string, page: Page, map: DelveMap | null, view: 'gm' | 'players', region: Polygon[] | 'all'): Scene3D {
  const [x0, y0] = page.origin;
  const bounds: SceneBox = { x0, y0, x1: x0 + page.width, y1: y0 + page.height };
  const bg = page.background;
  const base = {
    pageId: page.id,
    view,
    bounds,
    region: region === 'all' ? ('all' as const) : region.map((p) => ({ outer: p.outer.map(pt), holes: p.holes.map((h) => h.map(pt)) })),
    focus: region === 'all' ? bounds : polyBounds(region),
  };
  if (bg.kind === 'delve' && map) {
    const url = `/api/v1/games/${encodeURIComponent(gameId)}/pages/${encodeURIComponent(page.id)}/background.png?view=${view}`;
    return { ...base, kind: 'delve', floor: { url, box: bounds }, ...delveGeometry(map, view, region) };
  }
  const walls = page.walls ? clipWalls(page.walls, region) : [];
  if (bg.kind === 'image') {
    return { ...base, kind: 'image', floor: { url: bg.url, box: { x0, y0, x1: x0 + bg.w, y1: y0 + bg.h } }, walls, doors: [], stairs: [] };
  }
  return { ...base, kind: 'none', floor: null, walls, doors: [], stairs: [] };
}

export interface Table3dDeps {
  store: TableStore;
  access: AccessDeps;
  maps: MapStore;
  version: string;
  /** Discord login is set up (the refusal page offers it). */
  discord: boolean;
  accountOf: (req: FastifyRequest) => Account | null;
}

const html = (reply: FastifyReply, code: number, body: string) =>
  reply.code(code).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(body);

export function registerTable3d(t: FastifyInstance, deps: Table3dDeps): void {
  const { store, access } = deps;

  // The same doors as /play/:id: members only, everyone else the same refusal.
  t.get('/play/:id/3d', async (req, reply) => {
    const { id } = req.params as { id: string };
    const state = GAME_ID.test(id) ? store.get(id) : undefined;
    if (!state) return html(reply, 404, messagePage('No such game', ['This game does not exist (any more).'], [{ href: '/play', text: 'Delve Table' }]));
    const me = memberOf(access, req, state);
    const account = deps.accountOf(req);
    if (!me) {
      const here = `/play/${id}/3d`;
      const links = [{ href: `/login?next=${encodeURIComponent(here)}`, text: 'GM login' }];
      if (deps.discord && !account) links.unshift({ href: discordLoginUrl(here), text: 'Log in with Discord' });
      const lines = account
        ? [`You're logged in with Discord as ${account.name}, but that login isn't in this game. Ask your GM for an invite link.`]
        : ['You are not in this game. Ask your GM for an invite link.'];
      return html(reply, 403, messagePage('Not at this table', lines, links));
    }
    return html(reply, 200, table3dPage({ gameId: state.id, gameName: state.name, version: deps.version, me: { id: me.id, name: me.name, role: me.role } }));
  });

  // The scene for the 3D view, by the same page rules as background.png: members only, players
  // only their own page and always the players' view; the GM may ask for view=gm.
  t.get('/api/v1/games/:id/pages/:pageId/scene3d.json', async (req, reply) => {
    const { id, pageId } = req.params as { id: string; pageId: string };
    const state = GAME_ID.test(id) ? store.get(id) : undefined;
    if (!state) return reply.code(404).send({ error: `no game "${id}"` });
    const member = memberOf(access, req, state);
    if (!member) return reply.code(403).send({ error: 'only members of this game can see its pages' });
    const page = state.pages.find((p) => p.id === pageId);
    const gm = member.role === 'gm';
    // a player asking for another page learns nothing about it, not even whether it exists
    if (!gm && (!page || pageFor(state, member.id) !== page.id)) return reply.code(403).send({ error: 'that page is not open to players' });
    if (!page) return reply.code(404).send({ error: 'no page with that id' });
    const view = gm && (req.query as { view?: string }).view === 'gm' ? 'gm' : 'players';
    let map: DelveMap | null = null;
    if (page.background.kind === 'delve') {
      try {
        map = deps.maps.get(page.background.mapId).map;
      } catch (e) {
        if (e instanceof NotFoundError) return reply.code(404).send({ error: 'the Delve map behind this page is gone' });
        throw e;
      }
    }
    const region = revealedRegion(state, page, map, { member, view });
    return reply.header('cache-control', 'private, no-cache').header('x-content-type-options', 'nosniff').send(scene3d(state.id, page, map, view, region));
  });
}
