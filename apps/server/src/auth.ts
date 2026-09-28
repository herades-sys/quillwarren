// Writes (REST and WebSocket) need the API token; reads stay open on the LAN.
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export type TokenCheck = 'ok' | 'missing' | 'wrong' | 'unconfigured';

/** Compare in constant time; hashing first makes the lengths equal. */
export function checkToken(expected: string | undefined, given: string | undefined): TokenCheck {
  if (!expected) return 'unconfigured';
  if (!given) return 'missing';
  return timingSafeEqual(digest(expected), digest(given)) ? 'ok' : 'wrong';
}

/** Token from "Authorization: Bearer <token>". */
export function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m?.[1];
}
