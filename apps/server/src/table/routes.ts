// Delve Table's HTTP side: the REST API under /api/v1/games, the pages under
// /play (the GM's lobby, invite links, the table itself), uploaded images and
// the live channel. See docs/TABLE.md for the routes and who may call them.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { computeFloor, computeWalls, doorSegment, type DelveMap, type Door } from '@delve/core';
import { addInvite, addMember, newGame, removeInvite, TableError, type GameState, type Invite, type Page } from '@delve/table';
import { sameOrigin } from '../auth.ts';
import type { EditorAuth } from '../login.ts';
import { RenderQueryError, ROLL20_PPG, sceneFor } from '../render.ts';
import { NotFoundError, type MapStore } from '../store.ts';
import {
  clearPlayerCookie,
  GAME_ID,
  isGm,
  memberOf,
  playerCookie,
  playerCookieGames,
  TableKeys,
  type AccessDeps,
} from './access.ts';
import { ASSET_FILE, MAX_ASSET_BYTES, sniffImage, TableAssets } from './assets.ts';
import { joinPage, lobbyPage, messagePage, notGmPage } from './html.ts';
import { registerLive, TableHub } from './live.ts';
import { tablePage } from './page.ts';
import { newGameId, TableStore } from './store.ts';

export interface TableDeps {
  /** Delve's maps, for pages made from a map. */
  maps: MapStore;
  auth: EditorAuth;
  /** DELVE_API_TOKEN: it also keys the invite and player-cookie signatures. */
  token: string | undefined;
  version: string;
  /** The data dir (DELVE_DATA, via buildApp). Without it games live in memory and uploads in a temp dir (tests). */
  dataDir?: string;
  /** Subscribe to changes of Delve maps (MapService.onChange), so pages drawn from a map follow it. */
  onMapChange?: (cb: (mapId: string) => void) => void;
}

/** A map edit comes in many small changes (a drag, a reveal): wait this long for them to settle. */
const MAP_FOLLOW_MS = 800;

const DEFAULT_INVITE_HOURS = 72;
const MAX_INVITE_HOURS = 24 * 90;
const MAX_INVITES = 50;
const MAX_PLAYERS = 50;

const html = (reply: FastifyReply, code: number, body: string) =>
  reply.code(code).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(body);

/** A display name: trimmed, single spaces, 1–40 characters, no control characters. */
function cleanName(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s || s.length > max || /[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

/**
 * A Delve map as a page: its players'-view render bounds, grid unit and walls.
 * Walls are the players' view of them: secret doors open no gap and close
 * their opening, so the page data never gives a secret door away.
 */
export function pageFromMap(map: DelveMap, name?: string): Omit<Page, 'id'> {
  const { bounds } = sceneFor(map, { view: 'players' });
  const secret = (o: DelveMap['objects'][number]): o is Door => o.type === 'door' && o.style === 'secret';
  const shut = { ...map, objects: map.objects.filter((o) => !secret(o)) };
  const walls = [...computeWalls(shut, computeFloor(map)), ...map.objects.filter(secret).map(doorSegment)];
  return {
    name: name ?? map.name.slice(0, 80),
    width: bounds.x1 - bounds.x0,
    height: bounds.y1 - bounds.y0,
    origin: [bounds.x0, bounds.y0],
    cellPx: ROLL20_PPG,
    cellUnit: map.grid.unit ?? '5 ft',
    showGrid: true,
    background: { kind: 'delve', mapId: map.id },
    walls: walls.map(([a, b]) => [
      [a[0], a[1]],
      [b[0], b[1]],
    ]),
  };
}

export function registerTable(app: FastifyInstance, deps: TableDeps): void {
  const store = new TableStore(deps.dataDir ? join(deps.dataDir, 'table.db') : ':memory:');
  const assets = new TableAssets(deps.dataDir ? join(deps.dataDir, 'table-assets') : undefined);
  const keys = new TableKeys(deps.token);
  const access: AccessDeps = { auth: deps.auth, token: deps.token, keys, seatNonce: (g, m) => store.seatNonce(g, m) };
  const hub = new TableHub(store, app.log);

  // Pages drawn from a Delve map follow it: when the map changes (the GM
  // reveals a room, moves a door), everyone sees the page again, and the client
  // reloads its picture. Nothing about the page itself changes, so no rev bump.
  const following = new Map<string, ReturnType<typeof setTimeout>>();
  deps.onMapChange?.((mapId) => {
    if (following.has(mapId)) return;
    following.set(
      mapId,
      setTimeout(() => {
        following.delete(mapId);
        for (const g of store.list()) {
          const state = store.get(g.id);
          const pages = state?.pages.filter((p) => p.background.kind === 'delve' && p.background.mapId === mapId) ?? [];
          if (state && pages.length) hub.publish(state, pages.map((page) => ({ type: 'page.upsert', page })));
        }
      }, MAP_FOLLOW_MS),
    );
  });

  app.addHook('onClose', async () => {
    for (const t of following.values()) clearTimeout(t);
    store.close();
    assets.close();
  });

  const gmId = (s: GameState): string => s.members.find((m) => m.role === 'gm')?.id ?? 'gm';
  const isGmMember = (s: GameState) => (memberId: string) => s.members.some((m) => m.id === memberId && m.role === 'gm');
  const inviteUrl = (req: FastifyRequest, gameId: string, inv: Invite): string =>
    `${req.protocol}://${req.headers.host ?? 'localhost'}/play/join/${keys.inviteToken({ g: gameId, i: inv.id, e: inv.expires })}`;

  /** preHandler: the GM only. Writes need the page's own origin when they come with the cookie. */
  const gmOnly = (write: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (isGm(access, req, { write })) return;
    if (!deps.token && !deps.auth.sessions.open) return reply.code(503).send({ error: 'this server has no API token configured, so there is no GM login' });
    return reply.code(401).send({ error: 'only the GM can do that: log in to Delve (or send the API token)' });
  };

  /** The game named in the URL, or a 404 already sent. */
  const gameOf = (req: FastifyRequest, reply: FastifyReply): GameState | null => {
    const { id } = req.params as { id: string };
    const state = GAME_ID.test(id) ? store.get(id) : undefined;
    if (!state) {
      void reply.code(404).send({ error: `no game "${id}"` });
      return null;
    }
    return state;
  };

  void app.register(async (t) => {
    // Image uploads may say what they are; application/octet-stream is parsed app-wide already.
    t.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: MAX_ASSET_BYTES }, (_req, body, done) => done(null, body));

    registerLive(t, hub, store, access);

    // ---------- games ----------

    t.get('/api/v1/games', { preHandler: gmOnly(false) }, async () => ({ games: store.list() }));

    t.post('/api/v1/games', { preHandler: gmOnly(true) }, async (req, reply) => {
      const name = cleanName((req.body as { name?: unknown } | undefined)?.name, 80);
      if (!name) return reply.code(400).send({ error: 'name: 1 to 80 characters' });
      const id = newGameId();
      store.create(newGame(id, name, Date.now()));
      return reply.code(201).send({ id });
    });

    t.delete('/api/v1/games/:id', { preHandler: gmOnly(true) }, async (req, reply) => {
      const state = gameOf(req, reply);
      if (!state) return reply;
      hub.end(state.id);
      store.delete(state.id);
      return reply.code(204).send();
    });

    // ---------- invites ----------

    t.get('/api/v1/games/:id/invites', { preHandler: gmOnly(false) }, async (req, reply) => {
      const state = gameOf(req, reply);
      if (!state) return reply;
      const now = Date.now();
      return { invites: state.invites.map((i) => ({ ...i, url: inviteUrl(req, state.id, i), expired: i.expires <= now })) };
    });

    t.post('/api/v1/games/:id/invites', { preHandler: gmOnly(true) }, async (req, reply) => {
      const state = gameOf(req, reply);
      if (!state) return reply;
      const body = (req.body ?? {}) as { name?: unknown; hours?: unknown };
      const hours = body.hours === undefined ? DEFAULT_INVITE_HOURS : body.hours;
      if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > MAX_INVITE_HOURS) {
        return reply.code(400).send({ error: `hours: more than 0, at most ${MAX_INVITE_HOURS}` });
      }
      const name = body.name === undefined || body.name === '' ? undefined : cleanName(body.name, 40);
      if (name === null) return reply.code(400).send({ error: 'name: at most 40 characters' });
      const now = Date.now();
      // expired invites are dropped whenever a new one is made, so the list stays short
      const open = state.invites.filter((i) => i.expires > now);
      if (open.length >= MAX_INVITES) return reply.code(409).send({ error: `at most ${MAX_INVITES} open invites; revoke some first` });
      const invite: Invite = { id: `inv_${randomBytes(4).toString('hex')}`, expires: Math.round(now + hours * 3_600_000), ...(name ? { name } : {}) };
      let updated: GameState;
      try {
        updated = addInvite(
          state.invites.reduce((s, i) => (i.expires > now ? s : removeInvite(s, i.id)), state),
          invite,
        );
      } catch (e) {
        if (e instanceof TableError) return reply.code(400).send({ error: e.message });
        throw e;
      }
      const next = hub.replace(state, updated);
      hub.refresh(next.id, isGmMember(next));
      return reply.code(201).send({ id: invite.id, url: inviteUrl(req, next.id, invite), expires: invite.expires });
    });

    t.delete('/api/v1/games/:id/invites/:inviteId', { preHandler: gmOnly(true) }, async (req, reply) => {
      const state = gameOf(req, reply);
      if (!state) return reply;
      const { inviteId } = req.params as { inviteId: string };
      if (!state.invites.some((i) => i.id === inviteId)) return reply.code(404).send({ error: `no invite "${inviteId}"` });
      const next = hub.replace(state, removeInvite(state, inviteId));
      hub.refresh(next.id, isGmMember(next));
      return reply.code(204).send();
    });

    // ---------- pages from Delve maps ----------

    t.post('/api/v1/games/:id/pages/from-map', { preHandler: gmOnly(true) }, async (req, reply) => {
      const state = gameOf(req, reply);
      if (!state) return reply;
      const body = (req.body ?? {}) as { mapId?: unknown; name?: unknown };
      if (typeof body.mapId !== 'string' || !body.mapId) return reply.code(400).send({ error: 'mapId: the Delve map to use' });
      const name = body.name === undefined ? undefined : cleanName(body.name, 80);
      if (name === null) return reply.code(400).send({ error: 'name: 1 to 80 characters' });
      try {
        const page = { id: `pg_${randomBytes(4).toString('hex')}`, ...pageFromMap(deps.maps.get(body.mapId).map, name) };
        const { state: next } = hub.change(state.id, gmId(state), { type: 'page.create', page });
        const created = next.pages.find((p) => p.id === page.id) ?? next.pages.find((p) => !state.pages.some((q) => q.id === p.id));
        return reply.code(201).send({ page: created, rev: next.rev });
      } catch (e) {
        if (e instanceof NotFoundError) return reply.code(404).send({ error: e.message });
        if (e instanceof TableError || e instanceof RenderQueryError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    // ---------- images ----------

    t.post('/api/v1/games/:id/assets', { preHandler: gmOnly(true), bodyLimit: MAX_ASSET_BYTES }, async (req, reply) => {
      const state = gameOf(req, reply);
      if (!state) return reply;
      if (!Buffer.isBuffer(req.body)) {
        return reply.code(415).send({ error: 'send the image as the raw request body (content-type image/* or application/octet-stream)' });
      }
      if (!req.body.length) return reply.code(400).send({ error: 'the body is empty' });
      const ext = sniffImage(req.body);
      if (!ext) return reply.code(415).send({ error: 'only PNG, JPEG, WebP or GIF images' });
      const file = assets.put(req.body, ext);
      return reply.code(201).send({ url: `/api/v1/games/${state.id}/assets/${file}` });
    });

    t.get('/api/v1/games/:id/assets/:file', async (req, reply) => {
      const state = gameOf(req, reply);
      if (!state) return reply;
      if (!memberOf(access, req, state)) return reply.code(403).send({ error: 'only members of this game can see its images' });
      const { file } = req.params as { file: string };
      const found = ASSET_FILE.test(file) ? assets.get(file) : null;
      if (!found) return reply.code(404).send({ error: 'no such image' });
      return reply
        .type(found.type)
        .header('cache-control', 'private, max-age=31536000, immutable')
        .header('x-content-type-options', 'nosniff')
        .send(found.bytes);
    });

    // ---------- pages ----------

    t.get('/play', async (req, reply) => {
      if (isGm(access, req)) return html(reply, 200, lobbyPage(store.list()));
      const yours = playerCookieGames(req.headers.cookie).flatMap((id) => {
        const s = store.get(id);
        const m = s ? memberOf(access, req, s) : null;
        return s && m ? [{ id: s.id, name: s.name }] : [];
      });
      return html(reply, 200, notGmPage(yours, Boolean(deps.auth.passwordHash)));
    });

    t.post('/play/new', async (req, reply) => {
      if (!isGm(access, req, { write: true })) return html(reply, 401, messagePage('Not allowed', ['Only the GM can start a game.'], [{ href: '/login?next=/play', text: 'Log in' }]));
      const name = cleanName((req.body as { name?: unknown } | undefined)?.name, 80);
      if (!name) return html(reply, 400, messagePage('No name', ['A game needs a name (at most 80 characters).'], [{ href: '/play', text: 'Back' }]));
      const id = newGameId();
      store.create(newGame(id, name, Date.now()));
      return reply.redirect(`/play/${id}`, 303);
    });

    t.get('/play/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const state = GAME_ID.test(id) ? store.get(id) : undefined;
      if (!state) return html(reply, 404, messagePage('No such game', ['This game does not exist (any more).'], [{ href: '/play', text: 'Delve Table' }]));
      const me = memberOf(access, req, state);
      if (!me) {
        return html(reply, 403, messagePage('Not at this table', ['You are not in this game. Ask your GM for an invite link.'], [{ href: `/login?next=${encodeURIComponent(`/play/${id}`)}`, text: 'GM login' }]));
      }
      return html(reply, 200, tablePage({ gameId: state.id, gameName: state.name, version: deps.version, me: { id: me.id, name: me.name, role: me.role } }));
    });

    // Drop the player cookie (the GM testing as a player goes back to being the GM).
    t.get('/play/:id/leave', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!GAME_ID.test(id)) return html(reply, 404, messagePage('No such game', ['This game does not exist.']));
      return reply.header('set-cookie', clearPlayerCookie(id)).redirect(`/play/${id}`, 303);
    });

    /** The game and invite behind a link, or the reason it's no good. */
    const invitation = (token: string): { state: GameState; invite: Invite } | { status: number; title: string; text: string } => {
      const claim = keys.readInvite(token);
      const state = claim && GAME_ID.test(claim.g) ? store.get(claim.g) : undefined;
      if (!claim || !state) return { status: 404, title: 'Invite not valid', text: 'This invite link is not valid. Ask your GM for a new one.' };
      const invite = state.invites.find((i) => i.id === claim.i);
      const expired = { status: 410, title: 'Invite expired', text: 'This invite link has expired. Ask your GM for a new one.' };
      if (claim.e <= Date.now()) return expired;
      if (!invite) return { status: 410, title: 'Invite withdrawn', text: 'The GM has withdrawn this invite link. Ask them for a new one.' };
      if (invite.expires <= Date.now()) return expired;
      return { state, invite };
    };
    // memberOf only returns a player for a valid cookie of this game
    const alreadyIn = (req: FastifyRequest, state: GameState): boolean => memberOf(access, req, state)?.role === 'player';

    // A wildcard, not :token: signed tokens are longer than Fastify lets a route parameter be.
    t.get('/play/join/*', async (req, reply) => {
      const token = (req.params as { '*': string })['*'];
      const inv = invitation(token);
      if ('status' in inv) return html(reply, inv.status, messagePage(inv.title, [inv.text]));
      if (alreadyIn(req, inv.state)) return reply.redirect(`/play/${inv.state.id}`, 303);
      return html(reply, 200, joinPage({ token, gameName: inv.state.name, ...(inv.invite.name ? { inviteName: inv.invite.name } : {}) }));
    });

    t.post('/play/join/*', async (req, reply) => {
      const token = (req.params as { '*': string })['*'];
      if (!sameOrigin(req.headers.origin, req.headers.host)) return html(reply, 403, messagePage('Not allowed', ['Join from the invite page itself.']));
      const inv = invitation(token);
      if ('status' in inv) return html(reply, inv.status, messagePage(inv.title, [inv.text]));
      const { state } = inv;
      if (alreadyIn(req, state)) return reply.redirect(`/play/${state.id}`, 303);
      const raw = (req.body as { name?: unknown } | undefined)?.name;
      const name = cleanName(raw, 40);
      const again = (error: string) =>
        html(reply, 400, joinPage({ token, gameName: state.name, ...(inv.invite.name ? { inviteName: inv.invite.name } : {}), error, name: typeof raw === 'string' ? raw.slice(0, 40) : '' }));
      if (!name) return again('Pick a name of 1 to 40 characters.');
      if (state.members.filter((m) => m.role === 'player').length >= MAX_PLAYERS) return again(`This game is full (${MAX_PLAYERS} players).`);
      let added: ReturnType<typeof addMember>;
      try {
        added = addMember(state, name);
      } catch (e) {
        if (e instanceof TableError) return again(e.message);
        throw e;
      }
      const nonce = store.seat(state.id, added.member.id);
      const next = hub.replace(state, added.state, [{ type: 'members', members: added.state.members }]);
      return reply
        .header('set-cookie', playerCookie(next.id, keys.playerValue(next.id, added.member.id, nonce), req.protocol === 'https'))
        .redirect(`/play/${next.id}`, 303);
    });
  });
}
