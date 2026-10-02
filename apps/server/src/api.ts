// REST + WebSocket API under /api/v1. Reads are open on the LAN; anything that
// changes a map needs the API token (Authorization: Bearer <token>, or
// ?token=<token> on the WebSocket, since browsers can't set WS headers).
import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CityImportError,
  ConnectError,
  describeMap,
  DsImportError,
  FORMAT,
  FORMAT_VERSION,
  fromDungeonScrawl,
  fromWatabou,
  OpError,
  toDungeonScrawl,
  parseOps,
  PRESETS,
  squareUnit,
  ValidationError,
  type DelveMap,
} from '@delve/core';
import testMapJson from '../../../fixtures/test-map-4p.delve.json' with { type: 'json' };
import { bearer, checkToken, readCookie, sameOrigin, SESSION_COOKIE, type Sessions } from './auth.ts';
import { addLevel, levelsOf } from './levels.ts';
import { renamePlace, renameStorey, setCategory } from './library.ts';
import { LiveHub, type LiveMessage } from './live.ts';
import { render, renderHandout, RenderQueryError, type HandoutQuery, type RenderQuery } from './render.ts';
import type { MapService } from './service.ts';
import { labelStairs, labelStairsSummary } from './stair-labels.ts';
import { ConflictError, newMapId, NotFoundError, StaleError } from './store.ts';
import { unzipEntry, zipOne, ZipError } from './zip.ts';

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';

export interface ApiDeps {
  service: MapService;
  token: string | undefined;
  sessions: Sessions;
}

interface ErrorBody {
  error: string;
  problems?: string[];
  rev?: number;
}

/** Known errors -> status + JSON body; anything else is a real bug and rethrown. */
export function errorResponse(e: unknown): { status: number; body: ErrorBody } {
  if (e instanceof NotFoundError) return { status: 404, body: { error: e.message } };
  if (e instanceof StaleError) return { status: 409, body: { error: e.message, rev: e.rev } };
  if (e instanceof ConflictError) return { status: 409, body: { error: e.message } };
  if (e instanceof ValidationError) return { status: 400, body: { error: e.message, problems: e.problems } };
  if (e instanceof OpError || e instanceof RenderQueryError || e instanceof ConnectError || e instanceof DsImportError || e instanceof ZipError || e instanceof CityImportError) {
    return { status: 400, body: { error: e.message } };
  }
  throw e;
}

const byOf = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : fallback;

export function newMap(body: { name?: unknown; style?: unknown; template?: unknown; unit?: unknown }): DelveMap {
  const template = body.template ?? 'empty';
  if (template !== 'empty' && template !== 'test-dungeon') {
    throw new ValidationError([`template must be "empty" or "test-dungeon", got ${JSON.stringify(template)}`]);
  }
  const base = template === 'test-dungeon' ? (structuredClone(testMapJson) as DelveMap) : undefined;
  const preset = typeof body.style === 'string' ? body.style : (base?.style?.preset ?? 'classic-hatching');
  if (!PRESETS[preset]) throw new ValidationError([`unknown style "${preset}" (expected ${Object.keys(PRESETS).join(', ')})`]);
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    id: newMapId(),
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : (base?.name ?? 'Untitled map'),
    // what one square stands for: "5 ft" unless asked ("1.5 m")
    grid: { ...(base?.grid ?? { type: 'square' }), unit: body.unit === undefined || body.unit === '' ? (base?.grid.unit ?? '5 ft') : squareUnit(body.unit) },
    style: { preset },
    seed: base?.seed ?? randomInt(1, 2 ** 31),
    objects: base?.objects ?? [],
  };
}

/** Fastify preHandler that lets a request through only with the API token. */
export function tokenGuard(token: string | undefined) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const r = checkToken(token, bearer(req.headers.authorization));
    if (r === 'unconfigured') return reply.code(503).send({ error: 'this server has no API token configured, so changes are disabled' });
    if (r !== 'ok') return reply.code(401).send({ error: 'changes need the API token: send "Authorization: Bearer <token>"' });
  };
}

/** An editor session counts only for requests from the page's own origin (the cookie is SameSite=Strict too). */
export function editorSession(sessions: Sessions, req: FastifyRequest): boolean {
  return sessions.valid(readCookie(req.headers.cookie, SESSION_COOKIE)) && sameOrigin(req.headers.origin, req.headers.host);
}

/** preHandler for writes: the API token, or a logged-in editor. */
export function writeGuard(token: string | undefined, sessions: Sessions) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (checkToken(token, bearer(req.headers.authorization)) === 'ok' || editorSession(sessions, req)) return;
    if (!token && !sessions.open) return reply.code(503).send({ error: 'this server has no API token configured, so changes are disabled' });
    return reply.code(401).send({ error: 'changes need the API token ("Authorization: Bearer <token>") or an editor login' });
  };
}

export function registerApi(app: FastifyInstance, { service, token, sessions }: ApiDeps): void {
  const { store } = service;
  const fail = (reply: FastifyReply, e: unknown) => {
    const { status, body } = errorResponse(e);
    return reply.code(status).send(body);
  };
  const writer = writeGuard(token, sessions);

  app.get('/api/v1', async () => ({
    app: 'delve',
    format: `${FORMAT} v${FORMAT_VERSION}`,
    styles: Object.keys(PRESETS),
    docs: 'docs/API.md in the repository',
  }));

  app.get('/api/v1/maps', async () => ({ maps: store.list() }));

  app.post('/api/v1/maps', { preHandler: writer }, async (req, reply) => {
    const body = (req.body ?? {}) as { map?: unknown; name?: unknown; style?: unknown; template?: unknown; by?: unknown };
    try {
      const change = service.create(body.map ?? newMap(body), byOf(body.by, 'api'));
      return reply.code(201).send({ id: change.mapId, rev: change.rev, map: change.map });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/v1/maps/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { rev, map } = store.get(id);
      return { id, rev, map };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/api/v1/maps/:id', { preHandler: writer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      service.delete(id);
      return reply.code(204).send();
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/v1/maps/:id/ops', { preHandler: writer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { ops?: unknown; baseRev?: unknown; by?: unknown };
    try {
      if (body.baseRev !== undefined && !Number.isInteger(body.baseRev)) {
        throw new ValidationError(['baseRev must be a whole number']);
      }
      const change = service.apply(id, parseOps(body.ops), { baseRev: body.baseRev as number | undefined, by: byOf(body.by, 'api') });
      return { rev: change.rev };
    } catch (e) {
      return fail(reply, e);
    }
  });

  for (const action of ['undo', 'redo'] as const) {
    app.post(`/api/v1/maps/:id/${action}`, { preHandler: writer }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const by = byOf((req.body as { by?: unknown } | undefined)?.by, 'api');
      try {
        const change = action === 'undo' ? service.undo(id, by) : service.redo(id, by);
        return { rev: change.rev };
      } catch (e) {
        return fail(reply, e);
      }
    });
  }

  app.post('/api/v1/maps/:id/focus', { preHandler: writer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { ids?: unknown; by?: unknown };
    try {
      const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
      if (!ids.length) throw new ValidationError(['ids must be a non-empty list of object ids']);
      return { viewers: service.focus(id, ids, byOf(body.by, 'api')) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // The library shelf: files the map and every storey of its place (null or "" takes it off its shelf).
  app.put('/api/v1/maps/:id/category', { preHandler: writer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { category?: unknown; by?: unknown };
    try {
      if (!('category' in body)) throw new ValidationError(['send {"category": "Dungeons"} (or null to take the map off its shelf)']);
      return setCategory(service, id, body.category, byOf(body.by, 'library'));
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Renaming: `name` renames the place (the map and all its storeys), `storey` only this storey.
  app.put('/api/v1/maps/:id/name', { preHandler: writer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: unknown; storey?: unknown; by?: unknown };
    try {
      if (body.name === undefined && body.storey === undefined) throw new ValidationError(['send {"name": "The Ashen Tower"} to rename the place, or {"storey": "Cellar"} to rename this storey']);
      const by = byOf(body.by, 'library');
      const place = body.name === undefined ? null : renamePlace(service, id, body.name, by);
      const storey = body.storey === undefined ? null : renameStorey(service, id, body.storey, by);
      return { ...(place ? { name: place.name } : {}), ...(storey ? { storey: storey.storey } : {}), changed: [...new Set([...(place?.changed ?? []), ...(storey?.changed ?? [])])] };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Storeys: the maps in this map's group, top first; and adding one.
  app.get('/api/v1/maps/:id/levels', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { levels: levelsOf(service, id) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/v1/maps/:id/levels', { preHandler: writer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: unknown; position?: unknown; currentName?: unknown; by?: unknown };
    try {
      const change = addLevel(service, id, {
        name: body.name as string,
        position: body.position === 'below' ? 'below' : 'above',
        ...(typeof body.currentName === 'string' ? { currentName: body.currentName } : {}),
        by: byOf(body.by, 'api'),
      });
      return reply.code(201).send({ id: change.mapId, rev: change.rev, map: change.map });
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Label every stair of this map's storeys (a single map: floor 0), e.g. 0A, 1A, 2A.
  app.post('/api/v1/maps/:id/levels/label-stairs', { preHandler: writer }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = labelStairs(service, id, byOf((req.body as { by?: unknown } | undefined)?.by, 'api'));
      return { ...result, summary: labelStairsSummary(result) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/v1/maps/:id/history', async (req, reply) => {
    const { id } = req.params as { id: string };
    const limit = Math.min(500, Math.max(1, Number((req.query as { limit?: string }).limit ?? 50) || 50));
    try {
      return { history: store.history(id, limit) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/v1/maps/:id/describe', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return reply.type('text/plain; charset=utf-8').send(describeMap(store.get(id).map));
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Dungeon Scrawl: download a map as .ds, or create a map from an uploaded .ds.
  app.get('/api/v1/maps/:id/export.ds', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { map } = store.get(id);
      const view = (req.query as { view?: string }).view === 'players' ? 'players' : 'gm';
      const file = zipOne('map', Buffer.from(JSON.stringify(toDungeonScrawl(map, { view }))));
      return reply
        .type('application/octet-stream')
        .header('content-disposition', `attachment; filename="${slug(map.name)}${view === 'players' ? '_players' : ''}.ds"`)
        .send(file);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/v1/maps/import.ds', { preHandler: writer }, async (req, reply) => {
    const q = req.query as { name?: string; by?: string };
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        throw new ValidationError(['send the .ds file as the request body with content-type application/octet-stream']);
      }
      let doc: unknown;
      try {
        doc = JSON.parse(unzipEntry(req.body, 'map').toString('utf8'));
      } catch (e) {
        if (e instanceof ZipError) throw e;
        throw new DsImportError('the file\'s "map" entry is not valid JSON');
      }
      const { map, notes } = fromDungeonScrawl(doc, { id: newMapId(), name: q.name, seed: randomInt(1, 2 ** 31) });
      const change = service.create(map, byOf(q.by, 'import'));
      return reply.code(201).send({ id: change.mapId, rev: change.rev, map: change.map, notes });
    } catch (e) {
      return fail(reply, e);
    }
  });

  // A city from Watabou's Medieval Fantasy City Generator (its JSON export) as a new map.
  app.post('/api/v1/maps/import.city', { preHandler: writer, bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    const q = req.query as { name?: string; feet?: string; unit?: string; style?: string; by?: string };
    try {
      // the square size: unit ("10 ft", "3 m"), or feet as before
      const feet = q.feet === undefined ? 10 : Number(q.feet);
      if (q.unit === undefined && (!Number.isFinite(feet) || feet < 1 || feet > 100)) throw new ValidationError(['feet: feet per square, from 1 to 100 (5 is true scale, 10 the default)']);
      const unit = q.unit === undefined ? `${feet} ft` : squareUnit(q.unit);
      if (q.style !== undefined && !PRESETS[q.style]) throw new ValidationError([`style: one of ${Object.keys(PRESETS).join(', ')}`]);
      const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body;
      const { map, notes } = fromWatabou(body, { id: newMapId(), name: q.name, unit, seed: randomInt(1, 2 ** 31), ...(q.style ? { style: q.style } : {}) });
      const change = service.create(map, byOf(q.by, 'import'));
      return reply.code(201).send({ id: change.mapId, rev: change.rev, map: change.map, notes });
    } catch (e) {
      if (e instanceof SyntaxError) return reply.code(400).send({ error: 'the file is not valid JSON' });
      return fail(reply, e);
    }
  });

  // The players' map on an old parchment sheet, to print or hand out.
  for (const ext of ['png', 'svg'] as const) {
    app.get(`/api/v1/maps/:id/handout.${ext}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as HandoutQuery;
      try {
        const out = await renderHandout(store.get(id).map, q, ext);
        return reply
          .type(out.type)
          .header('content-disposition', `${q.download === '1' ? 'attachment' : 'inline'}; filename="${out.name}"`)
          .header('x-handout-size', `${Math.round(out.handout.width)}x${Math.round(out.handout.height)}pt`)
          .send(out.body);
      } catch (e) {
        return fail(reply, e);
      }
    });
  }

  for (const ext of ['png', 'svg'] as const) {
    app.get(`/api/v1/maps/:id/render.${ext}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const out = await render(store.get(id).map, req.query as RenderQuery, ext);
        return reply.type(out.type).header('content-disposition', `inline; filename="${out.name}"`).send(out.body);
      } catch (e) {
        return fail(reply, e);
      }
    });
  }

  app.get('/api/v1/maps/:id/live', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    let cur: { rev: number; map: DelveMap };
    try {
      cur = store.get(id);
    } catch (e) {
      LiveHub.send(socket, { type: 'error', error: (e as Error).message });
      socket.close(4404, 'map not found');
      return;
    }
    // ?screen=1: a players' screen. It gets no map data at all, only "changed" and "look".
    if ((req.query as { screen?: string }).screen === '1') {
      service.hub.join(id, socket, 'screen');
      LiveHub.send(socket, { type: 'hello', rev: cur.rev });
      socket.on('message', (raw) => {
        if (String(raw).includes('"ping"')) LiveHub.send(socket, { type: 'pong' });
      });
      return;
    }
    // checked again for every change: a session may end (logout, "log out everywhere") while the socket stays open
    const byToken = checkToken(token, (req.query as { token?: string }).token) === 'ok';
    const canWrite = () => byToken || editorSession(sessions, req);
    service.hub.join(id, socket);
    LiveHub.send(socket, { type: 'hello', rev: cur.rev, map: cur.map });

    socket.on('message', (raw) => {
      let msg: { type?: unknown; ops?: unknown; baseRev?: unknown; by?: unknown; ref?: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return LiveHub.send(socket, { type: 'error', error: 'messages must be JSON' });
      }
      if (msg.type === 'ping') return LiveHub.send(socket, { type: 'pong' });
      if (msg.type !== 'ops') return LiveHub.send(socket, { type: 'error', error: `unknown message type ${JSON.stringify(msg.type)}`, ref: msg.ref });
      if (!canWrite()) {
        return LiveHub.send(socket, { type: 'error', error: 'this connection is read-only: log in to edit (or connect with ?token=<token>)', ref: msg.ref });
      }
      try {
        const baseRev = Number.isInteger(msg.baseRev) ? (msg.baseRev as number) : undefined;
        service.apply(id, parseOps(msg.ops), {
          baseRev,
          by: byOf(msg.by, 'editor'),
          onCommit: (c) => LiveHub.send(socket, { type: 'ack', rev: c.rev, ref: msg.ref }),
        });
      } catch (e) {
        let body: ErrorBody;
        try {
          body = errorResponse(e).body;
        } catch {
          req.log.error(e);
          body = { error: 'internal error; see the server log' };
        }
        const reply: LiveMessage = { type: 'error', ...body, ref: msg.ref };
        LiveHub.send(socket, reply);
      }
    });
  });
}
