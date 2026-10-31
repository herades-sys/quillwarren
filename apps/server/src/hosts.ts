// Which host names the web server answers to. A web page on another site can
// point a name of its own at the home network's address ("DNS rebinding") and
// then read the open map API as if it were that site, so a request whose Host
// is a DNS name that isn't ours gets 403. IP addresses always work (rebinding
// needs a name), and so do the names a home network uses for its own machines.
// The desktop app has its own, stricter check (desktop/gate.ts).
import { isIPv4, isIPv6 } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fromLoopback } from './public.ts';

/** Name endings that only a home network resolves (mDNS, routers, RFC 8375 and ICANN's private-use name, the FRITZ!Box). */
const HOME_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.fritz.box', '.localhost'];

/** DELVE_ALLOWED_HOSTS: names separated by commas ("delve.example.org, *.example.net"), lower case; "*." also allows the names under it. */
export function parseAllowedHosts(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
}

/** The host name of a Host header, lower case without the port or a final dot; IPv6 addresses keep their brackets. Null for nonsense. */
export function hostName(header: string): string | null {
  const h = header.trim().toLowerCase();
  const v6 = /^(\[[0-9a-f:.]+\])(?::\d{1,5})?$/.exec(h);
  if (v6) return v6[1]!;
  const m = /^([a-z0-9._-]+?)\.?(?::\d{1,5})?$/.exec(h);
  return m ? m[1]! : null;
}

export interface HostRule {
  /** The host of DELVE_PUBLIC_URL (the tunnel's name) and DELVE_ALLOWED_HOSTS, as parseAllowedHosts gives them. */
  allowed: readonly string[];
}

/** May a request with this Host header be answered? */
export function hostAllowed(header: string | undefined, rule: HostRule): boolean {
  // no Host at all (HTTP/1.0, a hand-made request): no browser sends that, so nothing to rebind
  if (header === undefined || header === '') return true;
  const name = hostName(header);
  if (!name) return false;
  if (name.startsWith('[')) return isIPv6(name.slice(1, -1));
  if (isIPv4(name) || name === 'localhost' || !name.includes('.')) return true;
  if (HOME_SUFFIXES.some((s) => name.endsWith(s))) return true;
  return rule.allowed.some((a) => (a.startsWith('*.') ? name.endsWith(a.slice(1)) || name === a.slice(2) : name === a));
}

/** Through the Cloudflare tunnel: cloudflared on loopback with Cloudflare's header. Only names the owner routed to the tunnel get there. */
const viaCloudflared = (req: FastifyRequest): boolean => fromLoopback(req) && typeof req.headers['cf-connecting-ip'] === 'string';

/** The check, before anything else on every request (pages, the API, WebSockets, 404s). */
export function registerHostCheck(app: FastifyInstance, rule: HostRule): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (hostAllowed(req.headers.host, rule) || viaCloudflared(req)) return;
    return reply
      .code(403)
      .type('text/plain; charset=utf-8')
      .header('x-content-type-options', 'nosniff')
      .send('This Delve server does not answer to that host name. Open it by its IP address or its own name, or add the name to DELVE_ALLOWED_HOSTS.\n');
  });
}
