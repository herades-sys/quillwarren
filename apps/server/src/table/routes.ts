// Quillwarren Table's HTTP side: the REST API under /api/v1/games, the pages under
// /play (the GM's lobby, invite links, the table itself), uploaded images, the
// live channel and, when it's set up, Discord login (discord.ts). See
// docs/TABLE.md for the routes and who may call them.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { blockingEdges, computeFloor, computeWalls, doorSegment, type DelveMap, type Door } from '@delve/core';
import { addInvite, addMember, isDynamic, newGame, pageFor, removeInvite, TableError, type GameState, type Invite, type Member, type Page } from '@delve/table';
import { readCookie, sameOrigin } from '../auth.ts';
import { canLogIn, type EditorAuth } from '../login.ts';
import { render, RenderQueryError, ROLL20_PPG, sceneFor } from '../render.ts';
import { NotFoundError, type MapStore } from '../store.ts';
import {
  accountSeat,
  clearPlayerCookie,
  GAME_ID,
  isGm,
  isGmAccount,
  memberOf,
  playerCookie,
  playerCookieGames,
  playerCookieName,
  TableKeys,
  type AccessDeps,
} from './access.ts';
import { ASSET_FILE, MAX_ASSET_BYTES, sniffImage, TableAssets } from './assets.ts';
import { ACCOUNT_COOKIE, avatarUrl, discordLoginUrl, registerDiscord, type DiscordConfig } from './discord.ts';
import { joinPage, lobbyPage, messagePage, notGmPage, type DiscordLogin } from './html.ts';
import { registerLive, TableHub } from './live.ts';
import { registerNotebook } from './notebook.ts';
import { tablePage } from './page.ts';
import { registerTable3d } from './scene3d.ts';
import { newGameId, TableStore, type Account } from './store.ts';
import { pageSightData } from './vision.ts';

export interface TableDeps {
  /** Quillwarren's maps, for pages made from a map. */
  maps: MapStore;
  auth: EditorAuth;
  /** DELVE_API_TOKEN: it also keys the invite and player-cookie signatures. */
  token: string | undefined;
  version: string;
  /** The data dir (DELVE_DATA, via buildApp). Without it games live in memory and uploads in a temp dir (tests). */
  dataDir?: string;
  /** Subscribe to changes of Quillwarren maps (MapService.onChange), so pages drawn from a map follow it. */
  onMapChange?: (cb: (mapId: string, change?: { notesOnly: boolean }) => void) => void;
  /** Discord login for players (DELVE_DISCORD_CLIENT_ID/SECRET). Without it there's no Discord anywhere. */
  discord?: DiscordConfig;
}

/** A player's seat in a game, as a request holds it. */
export interface PlayerSeat {
  gameId: string;
  game: string;
  memberId: string;
  name: string;
  /** A player cookie from an invite link, or a seat of the request's Discord login. */
  via: 'invite' | 'discord';
  accountId?: string;
}

/** Who a request is at the tables, for pages outside them (the feature request form). */
export interface TableIdentity {
  /** Discord login is set up. */
  discord: boolean;
  /** The request's Discord login, if any. */
  account(req: FastifyRequest): { id: string; name: string } | null;
  /** The Discord login is GM of every game (DELVE_GM_DISCORD_IDS). */
  coGm(req: FastifyRequest): boolean;
  /** Player seats: valid player cookies first, then seats of the Discord login. */
  seats(req: FastifyRequest): PlayerSeat[];
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
 * A Quillwarren map as a page: its players'-view render bounds, grid unit, and for
 * vision its walls, doors and lights (vision.ts pageSightData). Walls are the
 * players' view of them: secret doors open no gap and close their opening, so
 * the page data never gives a secret door away.
 */
export function pageFromMap(map: DelveMap, name?: string): Omit<Page, 'id'> {
  const { bounds } = sceneFor(map, { view: 'players' });
  const { walls, doors, lights } = pageSightData(map);
  const cliffs = blockingEdges(map);
  return {
    name: name ?? map.name.slice(0, 80),
    width: bounds.x1 - bounds.x0,
    height: bounds.y1 - bounds.y0,
    origin: [bounds.x0, bounds.y0],
    cellPx: ROLL20_PPG,
    cellUnit: map.grid.unit ?? '5 ft',
    showGrid: true,
    background: { kind: 'delve', mapId: map.id },
    walls,
    doors,
    lights,
    // the map's cliff edges, for "Respect heights" (GM only, like the walls)
    ...(cliffs.length ? { cliffs } : {}),
  };
}

export function registerTable(app: FastifyInstance, deps: TableDeps): TableIdentity {
  const store = new TableStore(deps.dataDir ? join(deps.dataDir, 'table.db') : ':memory:');
  const assets = new TableAssets(deps.dataDir ? join(deps.dataDir, 'table-assets') : undefined);
  const keys = new TableKeys(deps.token);
  const discord = deps.discord;
  // one session lookup per request, however many games it checks
  const accounts = new WeakMap<FastifyRequest, Account | null>();
  const accountOf = (req: FastifyRequest): Account | null => {
    if (!discord) return null;
    let a = accounts.get(req);
    if (a === undefined) accounts.set(req, (a = store.accountForSession(readCookie(req.headers.cookie, ACCOUNT_COOKIE)) ?? null));
    return a;
  };
  const access: AccessDeps = {
    auth: deps.auth,
    token: deps.token,
    keys,
    seatNonce: (g, m) => store.seatNonce(g, m),
    accountOf,
    gmDiscordIds: new Set(discord?.gmIds ?? []),
  };
  const hub = new TableHub(store, app.log);
  /** Discord login bits for a page that should go back to `next` afterwards. */
  const discordLogin = (req: FastifyRequest, next: string): DiscordLogin | undefined => {
    if (!discord) return undefined;
    const account = accountOf(req);
    return { loginUrl: discordLoginUrl(next), ...(account ? { account: { name: account.name } } : {}) };
  };

  // Pages drawn from a Quillwarren map follow it: when the map changes (the GM
  // reveals a room, moves a door), everyone sees the page again, and the client
  // reloads its picture. When the map's walls, doors or lights changed, the page
  // takes the new ones (a page.update, so vision follows); otherwise nothing
  // about the page itself changes, so no rev bump.
  const followMap = (mapId: string) => {
    let map: DelveMap | null = null;
    try {
      map = deps.maps.get(mapId).map;
    } catch {
      map = null; // deleted: the picture route says so
    }
    const fresh = map ? { ...pageSightData(map), cliffs: blockingEdges(map) } : null;
    for (const g of store.list()) {
      const pageIds = store.get(g.id)?.pages.filter((p) => p.background.kind === 'delve' && p.background.mapId === mapId).map((p) => p.id) ?? [];
      const same: string[] = [];
      for (const id of pageIds) {
        const state = store.get(g.id);
        const page = state?.pages.find((p) => p.id === id);
        if (!state || !page) continue;
        const set = fresh ? Object.fromEntries((['walls', 'doors', 'lights', 'cliffs'] as const).filter((k) => JSON.stringify(page[k] ?? []) !== JSON.stringify(fresh[k])).map((k) => [k, fresh[k]])) : {};
        if (!Object.keys(set).length) {
          same.push(id);
          continue;
        }
        try {
          hub.change(state.id, gmId(state), { type: 'page.update', id, set });
        } catch (e) {
          app.log.warn({ err: e, game: state.id, page: id }, 'could not follow the map');
          same.push(id);
        }
      }
      const state = store.get(g.id);
      const pages = state?.pages.filter((p) => same.includes(p.id)) ?? [];
      if (state && pages.length) hub.publish(state, pages.map((page) => ({ type: 'page.upsert', page })));
    }
  };
  // A change of nothing but notes (GM notes are never drawn) changes no picture: the
  // pages aren't sent again, so players' pictures and 3D scenes stay as they are;
  // only the GM's connections hear "map.notes" and fetch the map for its notes.
  const notesChanged = (mapId: string) => {
    for (const g of store.list()) {
      const state = store.get(g.id);
      if (state?.pages.some((p) => p.background.kind === 'delve' && p.background.mapId === mapId)) hub.toGms(state.id, { type: 'map.notes', mapId });
    }
  };
  /** Changes of a map within one wait, and whether any of them was more than notes. */
  const following = new Map<string, { timer: ReturnType<typeof setTimeout>; full: boolean }>();
  deps.onMapChange?.((mapId, change) => {
    const full = !change?.notesOnly;
    const pending = following.get(mapId);
    if (pending) {
      pending.full ||= full;
      return;
    }
    const entry = {
      full,
      timer: setTimeout(() => {
        following.delete(mapId);
        if (entry.full) followMap(mapId);
        else notesChanged(mapId);
      }, MAP_FOLLOW_MS),
    };
    following.set(mapId, entry);
  });

  app.addHook('onClose', async () => {
    for (const f of following.values()) clearTimeout(f.timer);
    hub.close();
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
    return reply.code(401).send({ error: 'only the GM can do that: log in to Quillwarren (or send the API token)' });
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
    // the GM's session notebook (GM notes)
    registerNotebook(t, { store, hub, access });
    // the 3D table view: /play/:id/3d and the members-only scene3d.json
    registerTable3d(t, { store, access, maps: deps.maps, version: deps.version, discord: Boolean(discord), accountOf, vision: hub.vision });

    // ---------- Discord login ----------

    if (discord) {
      // a new avatar reaches every seat of the account, everywhere
      const syncAvatar = (account: Account) => {
        for (const g of store.list()) {
          const state = store.get(g.id);
          if (!state?.members.some((m) => m.accountId === account.id)) continue;
          const want = avatarUrl(state.id, account);
          let changed = false;
          const members = state.members.map((m): Member => {
            if (m.accountId !== account.id || m.avatar === want) return m;
            changed = true;
            const { avatar: _, ...rest } = m;
            return want ? { ...rest, avatar: want } : rest;
          });
          if (changed) hub.replace(state, { ...state, members }, [{ type: 'members', members }]);
        }
      };
      registerDiscord(t, { config: discord, store, keys, assets, log: app.log, onLogin: syncAvatar });
    }

    // ---------- games ----------

    t.get('/api/v1/games', { preHandler: gmOnly(false) }, async () => ({ games: store.list() }));

    t.post('/api/v1/games', { preHandler: gmOnly(true) }, async (req, reply) => {
      const name = cleanName((req.body as { name?: unknown } | undefined)?.name, 80);
      if (!name) return reply.code(400).send({ error: 'name: 1 to 80 characters' });
      const id = newGameId();
      store.create(newGame(id, name, Date.now()));
      return reply.code(201).send({ id });
    });

    // Game settings: for now only whether invites need a Discord login.
    t.patch('/api/v1/games/:id', { preHandler: gmOnly(true) }, async (req, reply) => {
      const state = gameOf(req, reply);
      if (!state) return reply;
      const body = (req.body ?? {}) as { requireDiscord?: unknown };
      if (typeof body.requireDiscord !== 'boolean') return reply.code(400).send({ error: 'requireDiscord: true or false' });
      if (body.requireDiscord && !discord) return reply.code(409).send({ error: 'Discord login is not set up on this server' });
      const { requireDiscord: _, ...rest } = state;
      const next = hub.replace(state, body.requireDiscord ? { ...rest, requireDiscord: true } : rest);
      hub.refresh(next.id, isGmMember(next));
      return { requireDiscord: next.requireDiscord === true };
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

    // ---------- pages from Quillwarren maps ----------

    t.post('/api/v1/games/:id/pages/from-map', { preHandler: gmOnly(true) }, async (req, reply) => {
      const state = gameOf(req, reply);
      if (!state) return reply;
      const body = (req.body ?? {}) as { mapId?: unknown; name?: unknown };
      if (typeof body.mapId !== 'string' || !body.mapId) return reply.code(400).send({ error: 'mapId: the Quillwarren map to use' });
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

    // the GM is checked before the body is read, so nobody else can make the server swallow 10 MB for nothing
    t.post('/api/v1/games/:id/assets', { onRequest: gmOnly(true), bodyLimit: MAX_ASSET_BYTES }, async (req, reply) => {
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

    // A Quillwarren page's picture, for members of the game only (from the internet the map API needs an
    // editor login). Players get what they have seen, on their own page; the GM may ask for the whole
    // map (view=gm: fog dimmed, room numbers, notes). Both in the page's exact frame.
    t.get('/api/v1/games/:id/pages/:pageId/background.png', async (req, reply) => {
      const state = gameOf(req, reply);
      if (!state) return reply;
      const member = memberOf(access, req, state);
      if (!member) return reply.code(403).send({ error: 'only members of this game can see its pages' });
      const { pageId } = req.params as { pageId: string };
      const page = state.pages.find((p) => p.id === pageId);
      if (!page || page.background.kind !== 'delve') return reply.code(404).send({ error: 'no Quillwarren page with that id' });
      const gm = member.role === 'gm';
      if (!gm && pageFor(state, member.id) !== page.id) return reply.code(403).send({ error: 'that page is not open to players' });
      const view = gm && (req.query as { view?: string }).view === 'gm' ? 'gm' : 'players';
      let map: DelveMap;
      let mapRev = 0;
      try {
        ({ map, rev: mapRev } = deps.maps.get(page.background.mapId));
      } catch (e) {
        if (e instanceof NotFoundError) return reply.code(404).send({ error: 'the Quillwarren map behind this page is gone' });
        throw e;
      }
      // dynamic vision: the table's doors; players get only what the party has explored, black elsewhere (vision-render.ts)
      if (isDynamic(page)) {
        const explored = hub.vision.current(state, page.id)?.explored ?? hub.vision.explored(state.id, page.id);
        const png = await hub.pictures.png({ gameId: state.id, page, map, mapRev, view, explored });
        return reply.type('image/png').header('cache-control', 'private, no-cache').header('x-content-type-options', 'nosniff').send(png);
      }
      const [x0, y0] = page.origin;
      try {
        const out = await render(map, { view, fog: '1', grid: '0', ppg: String(page.cellPx || ROLL20_PPG), frame: `${x0},${y0},${x0 + page.width},${y0 + page.height}` }, 'png');
        return reply.type('image/png').header('cache-control', 'private, no-cache').header('x-content-type-options', 'nosniff').send(out.body);
      } catch (e) {
        if (e instanceof RenderQueryError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    // ---------- pages ----------

    t.get('/play', async (req, reply) => {
      const account = accountOf(req);
      if (isGm(access, req)) return html(reply, 200, lobbyPage(store.list(), account ? { name: account.name } : undefined));
      // games of this browser's player cookies, and of the Discord login
      const ids = new Set(playerCookieGames(req.headers.cookie));
      if (account) {
        for (const g of store.list()) {
          const s = store.get(g.id);
          if (s && accountSeat(s, account.id)) ids.add(s.id);
        }
      }
      const yours = [...ids].flatMap((id) => {
        const s = store.get(id);
        const m = s ? memberOf(access, req, s) : null;
        return s && m ? [{ id: s.id, name: s.name }] : [];
      });
      return html(reply, 200, notGmPage(yours, canLogIn(deps.auth), discordLogin(req, '/play')));
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
      if (!state) return html(reply, 404, messagePage('No such game', ['This game does not exist (any more).'], [{ href: '/play', text: 'Quillwarren Table' }]));
      const me = memberOf(access, req, state);
      const account = accountOf(req);
      if (!me) {
        const here = `/play/${id}`;
        const links = [{ href: `/login?next=${encodeURIComponent(here)}`, text: 'GM login' }];
        if (discord && !account) links.unshift({ href: discordLoginUrl(here), text: 'Log in with Discord' });
        const lines = account
          ? [`You're logged in with Discord as ${account.name}, but that login isn't in this game. Ask your GM for an invite link.`]
          : ['You are not in this game. Ask your GM for an invite link.'];
        return html(reply, 403, messagePage('Not at this table', lines, links));
      }
      return html(
        reply,
        200,
        tablePage({
          gameId: state.id,
          gameName: state.name,
          version: deps.version,
          me: { id: me.id, name: me.name, role: me.role },
          discord: Boolean(discord),
          ...(account ? { account: { name: account.name }, linked: me.accountId === account.id } : {}),
        }),
      );
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
    // memberOf only returns a player for a valid cookie of this game, or a seat of the request's Discord account
    const alreadyIn = (req: FastifyRequest, state: GameState): boolean => memberOf(access, req, state)?.role === 'player';
    /** The join page's Discord part: log in and come back to this invite; `required` only counts with Discord set up. */
    const joinDiscord = (req: FastifyRequest, token: string, state: GameState) => {
      const d = discordLogin(req, `/play/join/${token}`);
      return d ? { discord: { ...d, required: state.requireDiscord === true } } : {};
    };

    // A wildcard, not :token: signed tokens are longer than Fastify lets a route parameter be.
    t.get('/play/join/*', async (req, reply) => {
      const token = (req.params as { '*': string })['*'];
      const inv = invitation(token);
      if ('status' in inv) return html(reply, inv.status, messagePage(inv.title, [inv.text]));
      if (alreadyIn(req, inv.state)) return reply.redirect(`/play/${inv.state.id}`, 303);
      return html(reply, 200, joinPage({ token, gameName: inv.state.name, ...(inv.invite.name ? { inviteName: inv.invite.name } : {}), ...joinDiscord(req, token, inv.state) }));
    });

    t.post('/play/join/*', async (req, reply) => {
      const token = (req.params as { '*': string })['*'];
      if (!sameOrigin(req.headers.origin, req.headers.host)) return html(reply, 403, messagePage('Not allowed', ['Join from the invite page itself.']));
      const inv = invitation(token);
      if ('status' in inv) return html(reply, inv.status, messagePage(inv.title, [inv.text]));
      const { state } = inv;
      if (alreadyIn(req, state)) return reply.redirect(`/play/${state.id}`, 303);
      const account = accountOf(req);
      const raw = (req.body as { name?: unknown } | undefined)?.name;
      const name = cleanName(raw, 40);
      const again = (error: string, code = 400) =>
        html(
          reply,
          code,
          joinPage({ token, gameName: state.name, ...(inv.invite.name ? { inviteName: inv.invite.name } : {}), error, name: typeof raw === 'string' ? raw.slice(0, 40) : '', ...joinDiscord(req, token, state) }),
        );
      if (discord && state.requireDiscord && !account) return again('This game needs a Discord login: log in with Discord first.', 403);
      if (!name) return again('Pick a name of 1 to 40 characters.');
      if (state.members.filter((m) => m.role === 'player').length >= MAX_PLAYERS) return again(`This game is full (${MAX_PLAYERS} players).`);
      let added: ReturnType<typeof addMember>;
      try {
        const avatar = account ? avatarUrl(state.id, account) : undefined;
        added = addMember(state, name, account ? { accountId: account.id, ...(avatar ? { avatar } : {}) } : {});
      } catch (e) {
        if (e instanceof TableError) return again(e.message);
        throw e;
      }
      // a Discord seat needs no cookie of its own: the login is the key (on every device, until logging out)
      const nonce = account ? null : store.seat(state.id, added.member.id);
      const next = hub.replace(state, added.state, [{ type: 'members', members: added.state.members }]);
      if (nonce === null) return reply.redirect(`/play/${next.id}`, 303);
      return reply
        .header('set-cookie', playerCookie(next.id, keys.playerValue(next.id, added.member.id, nonce), req.protocol === 'https'))
        .redirect(`/play/${next.id}`, 303);
    });
  });

  return {
    discord: Boolean(discord),
    account: (req) => {
      const a = accountOf(req);
      return a ? { id: a.id, name: a.name } : null;
    },
    coGm: (req) => isGmAccount(access, req),
    seats: (req) => {
      const out: PlayerSeat[] = [];
      for (const id of playerCookieGames(req.headers.cookie)) {
        const state = store.get(id);
        if (!state) continue;
        const memberId = keys.readPlayer(id, readCookie(req.headers.cookie, playerCookieName(id)), (m) => store.seatNonce(id, m));
        const m = state.members.find((x) => x.id === memberId && x.role === 'player');
        if (m) out.push({ gameId: id, game: state.name, memberId: m.id, name: m.name, via: 'invite' });
      }
      const account = accountOf(req);
      if (account) {
        for (const g of store.list()) {
          const state = store.get(g.id);
          const m = state && !out.some((s) => s.gameId === g.id) ? accountSeat(state, account.id) : undefined;
          if (state && m) out.push({ gameId: state.id, game: state.name, memberId: m.id, name: m.name, via: 'discord', accountId: account.id });
        }
      }
      return out;
    },
  };
}
