// Requests from the internet. They come through the Cloudflare tunnel, whose
// cloudflared runs on this container: it connects from loopback, with the public
// host name and Cloudflare's headers. Such requests get less than the home
// network: no API token and no MCP (those stay home-only), and nothing of
// Delve's maps without a login. Claiming to come through the tunnel only ever
// takes rights away, so these checks can trust the headers.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bearer } from './auth.ts';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const fromLoopback = (req: FastifyRequest): boolean => LOOPBACK.has(req.socket.remoteAddress ?? '');

/** The host name of DELVE_PUBLIC_URL, lower case, if there is one. */
export function publicHostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** Did this request come through the tunnel (or claim to)? */
export function viaTunnel(req: FastifyRequest, publicHost: string | undefined): boolean {
  if (req.headers['cf-connecting-ip'] !== undefined || req.headers['cf-ray'] !== undefined) return true;
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  return Boolean(publicHost) && host === publicHost;
}

/** The client's address: Cloudflare's header only when cloudflared (on loopback) passed it on, so nobody at home can pick one. */
export function clientIp(req: FastifyRequest): string {
  const cf = req.headers['cf-connecting-ip'];
  return fromLoopback(req) && typeof cf === 'string' && /^[0-9A-Fa-f:.]{2,45}$/.test(cf) ? cf : req.ip;
}

/** Open to anyone through the tunnel: the tabletop, logging in, and static files. Everything else needs a login. */
const OPEN = [
  /^\/health$/,
  /^\/play(\/|$|\?)/,
  /^\/auth\//,
  /^\/(login|logout)(\?|$)/,
  /^\/account\/setup(\?|$)/,
  /^\/api\/v1\/games(\/|$|\?)/,
  /^\/api\/v1\/session(\?|$)/,
  /^\/assets\//,
  /^\/fonts\//,
  /^\/favicon\.svg$/,
];

/**
 * The gate for tunnel requests: MCP and the API token are refused outright, and
 * without an editor login only the open paths answer (pages send you to the
 * login, the API says 401).
 */
export function registerPublicGate(app: FastifyInstance, o: { publicHost: string | undefined; loggedIn: (req: FastifyRequest) => boolean }): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!viaTunnel(req, o.publicHost)) return;
    const path = req.url;
    if (/^\/mcp(\/|$|\?)/.test(path)) return reply.code(404).send({ error: 'not found' });
    // ?token= is the API token everywhere except a GM's one-time setup link
    const query = req.query as { token?: unknown } | undefined;
    const setupLink = /^\/account\/setup(\?|$)/.test(path);
    if (bearer(req.headers.authorization) !== undefined || (query?.token !== undefined && !setupLink)) {
      return reply.code(403).send({ error: 'the API token only works on the home network' });
    }
    if (OPEN.some((re) => re.test(path)) || o.loggedIn(req)) return;
    if (req.method === 'GET' && !path.startsWith('/api/') && (req.headers.accept ?? '').includes('text/html')) {
      return reply.redirect(`/login?next=${encodeURIComponent(path)}`, 303);
    }
    return reply.code(401).send({ error: 'log in first' });
  });
}
