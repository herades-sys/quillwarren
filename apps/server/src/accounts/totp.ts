// One-time codes for authenticator apps: base32 secrets (RFC 4648), HOTP
// (RFC 4226) and TOTP (RFC 6238, 30 s steps, 6 digits, HMAC-SHA1 by default).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding (what otpauth:// URIs use). */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff; // only the low `bits` bits matter
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Case-insensitive; spaces, dashes and "=" padding are ignored. Throws on anything else. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base32: "${c}"`);
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export function hotp(key: Uint8Array, counter: number, digits = 6, algorithm: TotpAlgorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const TOTP_STEP_S = 30;

export const totpStep = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_STEP_S);

export function totp(key: Uint8Array, nowMs: number, digits = 6, algorithm: TotpAlgorithm = 'sha1'): string {
  return hotp(key, totpStep(nowMs), digits, algorithm);
}

/**
 * The time step a 6-digit code matches (now, or one step either side for clock
 * drift), or null. Steps at or before `lastStep` are refused, so a code works once.
 */
export function matchTotp(key: Uint8Array, code: string, nowMs: number, lastStep = -1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(nowMs);
  let hit: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    // check every step, so the time taken doesn't depend on which one matched
    const same = timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code));
    if (same && step > lastStep && hit === null) hit = step;
  }
  return hit;
}

/** A new 160-bit secret, as base32. */
export const newTotpSecret = (): string => base32Encode(randomBytes(20));

/** What the authenticator app scans: otpauth://totp/Delve:<name>?secret=…&issuer=Delve */
export function otpauthUri(accountName: string, secret: string, issuer = 'Delve'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: String(TOTP_STEP_S) });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** "ABCD EFGH …" for typing the secret in by hand. */
export const groupSecret = (secret: string): string => secret.replace(/(.{4})(?=.)/g, '$1 ');
