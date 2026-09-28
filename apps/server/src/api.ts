// REST + WebSocket API under /api/v1. Reads are open on the LAN; anything that
// changes a map needs the API token (Authorization: Bearer <token>, or
// ?token=<token> on the WebSocket, since browsers can't set WS headers).
import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  describeMap,
  FORMAT,
  FORMAT_VERSION,
  OpError,
  parseOps,
  PRESETS,
  ValidationError,
  type DelveMap,
} from '@delve/core';
import testMapJson from '../../../fixtures/test-map-4p.delve.json' with { type: 'json' };
import { bearer, checkToken } from './auth.ts';
import { LiveHub, type LiveMessage } from './live.ts';
import { render, RenderQueryError, type RenderQuery } from './render.ts';
import type { MapService } from './service.ts';
import { ConflictError, newMapId, NotFoundError, StaleError } from './store.ts';

export interface ApiDeps {
  service: MapService;
  token: string | undefined;
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
  if (e instanceof OpError || e instanceof RenderQueryError) return { status: 400, body: { error: e.message } };
  throw e;
}

const byOf = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : fallback;

export function newMap(body: { name?: unknown; style?: unknown; template?: unknown }): DelveMap {
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
    grid: base?.grid ?? { type: 'square', unit: '5 ft' },
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

export function registerApi(app: FastifyInstance, { service, token }: ApiDeps): void {
  const { store } = service;
  const fail = (reply: FastifyReply, e: unknown) => {
    const { status, body } = errorResponse(e);
    return reply.code(status).send(body);
  };
  const writer = tokenGuard(token);

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
    const canWrite = checkToken(token, (req.query as { token?: string }).token) === 'ok';
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
      if (!canWrite) {
        return LiveHub.send(socket, { type: 'error', error: 'this connection is read-only; connect with ?token=<token> to make changes', ref: msg.ref });
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
