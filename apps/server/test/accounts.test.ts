// Accounts, the parts without HTTP: base32, HOTP/TOTP against the RFC test
// vectors, the QR code, and the account store (sealed secrets, setup links,
// recovery codes, lockouts, session limits, the last admin).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { qrSvg } from '../src/accounts/qr.ts';
import { AccountError, AccountStore, IDLE_MS, LINK_MS, LOCK_MS, REMEMBER_IDLE_MS, SESSION_MAX_MS } from '../src/accounts/store.ts';
import { base32Decode, base32Encode, hotp, matchTotp, otpauthUri, totp, totpStep, type TotpAlgorithm } from '../src/accounts/totp.ts';

describe('base32 (RFC 4648)', () => {
  const vectors: [string, string][] = [
    ['', ''],
    ['f', 'MY======'],
    ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='],
    ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI======'],
  ];
  it('encodes without padding and decodes with or without it', () => {
    for (const [plain, coded] of vectors) {
      expect(base32Encode(Buffer.from(plain))).toBe(coded.replace(/=/g, ''));
      expect(base32Decode(coded).toString()).toBe(plain);
      expect(base32Decode(coded.replace(/=/g, '').toLowerCase()).toString()).toBe(plain);
    }
  });
  it('round-trips random bytes and refuses other letters', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n * 11) & 0xff));
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
    expect(base32Decode('MZXW 6YTB-OI').toString()).toBe('foobar');
    expect(() => base32Decode('MZ1W')).toThrow();
  });
});

describe('HOTP (RFC 4226) and TOTP (RFC 6238)', () => {
  const key20 = Buffer.from('12345678901234567890');
  it('matches the RFC 4226 HOTP values', () => {
    const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    want.forEach((code, counter) => expect(hotp(key20, counter)).toBe(code));
  });

  it('matches the RFC 6238 TOTP values for SHA-1, SHA-256 and SHA-512', () => {
    const keys: Record<TotpAlgorithm, Buffer> = {
      sha1: key20,
      sha256: Buffer.from('12345678901234567890123456789012'),
      sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
    };
    const table: [number, string, string, string][] = [
      [59, '94287082', '46119246', '90693936'],
      [1111111109, '07081804', '68084774', '25091201'],
      [1111111111, '14050471', '67062674', '99943326'],
      [1234567890, '89005924', '91819424', '93441116'],
      [2000000000, '69279037', '90698825', '38618901'],
      [20000000000, '65353130', '77737706', '47863826'],
    ];
    for (const [t, sha1, sha256, sha512] of table) {
      expect(totp(keys.sha1, t * 1000, 8, 'sha1')).toBe(sha1);
      expect(totp(keys.sha256, t * 1000, 8, 'sha256')).toBe(sha256);
      expect(totp(keys.sha512, t * 1000, 8, 'sha512')).toBe(sha512);
    }
  });

  it('accepts one step of clock drift, and each step only once', () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const at = (s: number) => hotp(key20, s);
    expect(matchTotp(key20, at(step), now)).toBe(step);
    expect(matchTotp(key20, at(step - 1), now)).toBe(step - 1);
    expect(matchTotp(key20, at(step + 1), now)).toBe(step + 1);
    expect(matchTotp(key20, at(step - 2), now)).toBeNull();
    expect(matchTotp(key20, at(step + 2), now)).toBeNull();
    expect(matchTotp(key20, at(step), now, step)).toBeNull(); // used already
    expect(matchTotp(key20, at(step - 1), now, step)).toBeNull(); // older than the last one used
    expect(matchTotp(key20, '12345', now)).toBeNull();
    expect(matchTotp(key20, 'abcdef', now)).toBeNull();
  });

  it('builds the otpauth URI the apps scan', () => {
    expect(otpauthUri('Ana Lee', 'JBSWY3DPEHPK3PXP')).toBe(
      'otpauth://totp/Delve:Ana%20Lee?secret=JBSWY3DPEHPK3PXP&issuer=Delve&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('draws the QR code as dark modules on white', () => {
    const svg = qrSvg(otpauthUri('gm', 'JBSWY3DPEHPK3PXP'), { title: 'QR <code>' });
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 (\d+) \1"/);
    expect(svg).toContain('<rect');
    expect(svg).toMatch(/<path d="(M\d+ \d+h1v1h-1z)+" fill="#000"\/>/);
    expect(svg).toContain('<title>QR code</title>');
  });
});

describe('account store', () => {
  const T0 = 1_800_000_000_000;
  const dirs: string[] = [];
  const stores: AccountStore[] = [];
  const open = (file = ':memory:', token: string | null = 'store-token') => {
    const s = new AccountStore(file, token ?? undefined);
    stores.push(s);
    return s;
  };
  const tempFile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'delve-accounts-'));
    dirs.push(dir);
    return join(dir, 'accounts.db');
  };
  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A confirmed account; returns its id and secret. */
  function activate(s: AccountStore, name: string, role: 'admin' | 'gm', now = T0) {
    const user = s.createUser(name, role, now);
    const token = s.createLink(user.id, 'new', now);
    s.chooseLinkPassword(token, 'a long enough password', now);
    const secret = s.link(token, now)!.secret;
    const done = s.completeLink(token, totp(base32Decode(secret), now), now)!;
    return { id: user.id, secret, codes: done.recoveryCodes! };
  }

  it('seals authenticator secrets with the API token, and keeps them plain without one', () => {
    const stored = (file: string, id: number): string => {
      const raw = new DatabaseSync(file);
      try {
        return String((raw.prepare('SELECT totp_secret FROM users WHERE id = ?').get(id) as { totp_secret: string }).totp_secret);
      } finally {
        raw.close();
      }
    };
    const sealedFile = tempFile();
    const a = activate(open(sealedFile, 'token-a'), 'Ana', 'admin');
    expect(stored(sealedFile, a.id)).toMatch(/^g1:[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(stored(sealedFile, a.id)).not.toContain(a.secret);

    const plainFile = tempFile();
    const plain = open(plainFile, null);
    const p = activate(plain, 'Bo', 'admin');
    expect(stored(plainFile, p.id)).toBe(`p1:${p.secret}`);
    expect(plain.useSecondFactor(p.id, totp(base32Decode(p.secret), T0 + 30_000), T0 + 30_000)).toBe('code');
  });

  it('cannot read a sealed secret with a different token', () => {
    const file = tempFile();
    const a = open(file, 'token-a');
    const { id, secret } = activate(a, 'Ana', 'admin');
    a.close();
    const b = open(file, 'token-b');
    expect(b.useSecondFactor(id, totp(base32Decode(secret), T0 + 30_000), T0 + 30_000)).toBeNull();
  });

  it('keeps names unique regardless of case, and checks them', () => {
    const s = open();
    s.createUser('Ana', 'gm', T0);
    expect(() => s.createUser('ANA', 'gm', T0)).toThrow(AccountError);
    expect(() => s.createUser('  ', 'gm', T0)).toThrow(AccountError);
    expect(() => s.createUser('<script>', 'gm', T0)).toThrow(AccountError);
    expect(() => s.createUser('x'.repeat(33), 'gm', T0)).toThrow(AccountError);
    expect(s.createUser("  Élise   d'Arc ", 'gm', T0).name).toBe("Élise d'Arc");
    expect(() => s.createUser("ÉLISE D'ARC", 'gm', T0)).toThrow(/taken/);
  });

  it('uses setup links once and lets them run out after 72 hours', () => {
    const s = open();
    const user = s.createUser('Gm', 'gm', T0);
    const token = s.createLink(user.id, 'new', T0);
    expect(s.link(token, T0 + LINK_MS - 1)).not.toBeNull();
    expect(s.link(token, T0 + LINK_MS)).toBeNull();

    const again = s.createLink(user.id, 'new', T0);
    expect(() => s.completeLink(again, '000000', T0)).toThrow(/password first/);
    s.chooseLinkPassword(again, 'a long enough password', T0);
    const secret = s.link(again, T0)!.secret;
    expect(s.completeLink(again, '000000', T0)).toBeNull(); // wrong code: link stays
    expect(s.completeLink(again, totp(base32Decode(secret), T0), T0)).not.toBeNull();
    expect(s.link(again, T0)).toBeNull();
    expect(() => s.completeLink(again, totp(base32Decode(secret), T0), T0)).toThrow(/not valid/);
    expect(s.user(user.id)!.active).toBe(true);
  });

  it('a new link replaces the old one', () => {
    const s = open();
    const user = s.createUser('Gm', 'gm', T0);
    const first = s.createLink(user.id, 'new', T0);
    s.createLink(user.id, 'new', T0);
    expect(s.link(first, T0)).toBeNull();
  });

  it('refuses a code already used, and takes each recovery code once', () => {
    const s = open();
    const { id, secret, codes } = activate(s, 'Ana', 'admin', T0);
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    const code = totp(base32Decode(secret), T0);
    expect(s.useSecondFactor(id, code, T0)).toBeNull(); // the setup used this step
    const later = T0 + 30_000;
    expect(s.useSecondFactor(id, totp(base32Decode(secret), later), later)).toBe('code');
    expect(s.useSecondFactor(id, totp(base32Decode(secret), later), later)).toBeNull();

    expect(s.useSecondFactor(id, codes[3]!.toLowerCase().replace(/-/g, ' '), later)).toBe('recovery');
    expect(s.useSecondFactor(id, codes[3]!, later)).toBeNull();
    expect(s.user(id)!.recoveryLeft).toBe(9);
    const fresh = s.newRecoveryCodes(id);
    expect(s.useSecondFactor(id, codes[4]!, later)).toBeNull(); // old set gone
    expect(s.useSecondFactor(id, fresh[0]!, later)).toBe('recovery');
  });

  it('checks the password even for names that do not exist', () => {
    const s = open();
    const { secret } = activate(s, 'Ana', 'admin', T0);
    const later = T0 + 60_000;
    const code = totp(base32Decode(secret), later);
    expect(s.verifyLogin('nobody', 'a long enough password', code, later)).toBeNull();
    expect(s.verifyLogin('ana', 'wrong password here', code, later)).toBeNull();
    expect(s.verifyLogin('ANA', 'a long enough password', code, later)?.factor).toBe('code');
  });

  it('locks a key after 5 failures for 15 minutes', () => {
    const s = open();
    for (let i = 0; i < 4; i++) s.fail(['ip:1', 'name:ana'], T0 + i);
    expect(s.locked(['ip:1'], T0 + 10)).toBe(false);
    s.fail(['ip:1', 'name:ana'], T0 + 10);
    expect(s.locked(['ip:1'], T0 + 11)).toBe(true);
    expect(s.locked(['ip:2', 'name:ana'], T0 + 11)).toBe(true);
    expect(s.locked(['ip:2', 'name:bo'], T0 + 11)).toBe(false);
    s.fail(['ip:1'], T0 + 20); // a failure while locked keeps the lock
    expect(s.locked(['ip:1'], T0 + 21)).toBe(true);
    expect(s.locked(['ip:1'], T0 + 10 + LOCK_MS)).toBe(false);
    // failures spread over more than 15 minutes don't add up
    for (let i = 0; i < 4; i++) s.fail(['ip:3'], T0 + i * 1000);
    s.fail(['ip:3'], T0 + LOCK_MS + 5000);
    expect(s.locked(['ip:3'], T0 + LOCK_MS + 5001)).toBe(false);
  });

  it('ends sessions after 12 idle hours (7 days when kept) and 30 days in any case', () => {
    const s = open();
    const { id } = activate(s, 'Ana', 'admin', T0);
    const short = s.createSession(id, {}, T0);
    expect(s.sessionValid(short, T0 + IDLE_MS - 1000)).toBe(true);
    expect(s.sessionValid(short, T0 + IDLE_MS - 1000 + IDLE_MS + 1)).toBe(false);

    const kept = s.createSession(id, { remember: true }, T0);
    expect(s.sessionValid(kept, T0 + 13 * 3_600_000)).toBe(true);
    expect(s.sessionValid(kept, T0 + 13 * 3_600_000 + REMEMBER_IDLE_MS + 1)).toBe(false);

    const busy = s.createSession(id, { remember: true }, T0);
    for (let t = T0; t < T0 + SESSION_MAX_MS; t += 86_400_000) expect(s.sessionValid(busy, t)).toBe(true);
    expect(s.sessionValid(busy, T0 + SESSION_MAX_MS)).toBe(false);
    expect(s.sessionValid('a1.' + 'x'.repeat(43), T0)).toBe(false);
  });

  it('never lets the last admin go', () => {
    const s = open();
    const a = activate(s, 'Ana', 'admin', T0);
    const pending = s.createUser('Pending admin', 'admin', T0); // not set up, so it doesn't count
    expect(() => s.removeUser(a.id)).toThrow(/last admin/);
    expect(() => s.setRole(a.id, 'gm')).toThrow(/last admin/);
    expect(() => s.resetLogin(a.id, T0)).toThrow(/last admin/);
    const b = activate(s, 'Bo', 'admin', T0);
    s.setRole(a.id, 'gm');
    expect(() => s.removeUser(b.id)).toThrow(/last admin/);
    s.removeUser(pending.id);
    s.setRole(a.id, 'admin');
    s.removeUser(b.id);
    expect(s.users().map((u) => u.name)).toEqual(['Ana']);
  });

  it('a reset locks the account and ends its sessions', () => {
    const s = open();
    activate(s, 'Ana', 'admin', T0);
    const gm = activate(s, 'Gm', 'gm', T0);
    const session = s.createSession(gm.id, {}, T0);
    const token = s.resetLogin(gm.id, T0);
    expect(s.sessionValid(session, T0)).toBe(false);
    expect(s.user(gm.id)!.active).toBe(false);
    expect(s.verifyLogin('Gm', 'a long enough password', totp(base32Decode(gm.secret), T0 + 60_000), T0 + 60_000)).toBeNull();
    expect(s.link(token, T0)?.purpose).toBe('reset');
  });

  it('turns the shared password off when the first admin is set up', () => {
    const s = open();
    expect(s.legacyOff()).toBe(false);
    const token = s.startBootstrap('Ana', 'a long enough password', T0);
    expect(s.legacyOff()).toBe(false);
    const secret = s.link(token, T0)!.secret;
    s.completeLink(token, totp(base32Decode(secret), T0), T0);
    expect(s.legacyOff()).toBe(true);
    expect(() => s.startBootstrap('Bo', 'a long enough password', T0)).toThrow(/exists already/);
  });

  describe('password-only GM accounts', () => {
    const PW = 'hive password, long enough';

    it('are GMs only, set up by the password alone, and log in without a code', () => {
      const s = open();
      expect(() => s.createUser('Boss', 'admin', T0, { passwordOnly: true })).toThrow(/always use an authenticator/);
      const hive = s.createUser('Hive', 'gm', T0, { passwordOnly: true });
      expect(hive.passwordOnly).toBe(true);
      expect(hive.active).toBe(false);
      const token = s.createLink(hive.id, 'new', T0);
      expect(s.link(token, T0)!.passwordOnly).toBe(true);
      // the authenticator step can't be taken instead
      s.chooseLinkPassword(token, PW, T0);
      const secret = s.link(token, T0)!.secret;
      expect(() => s.completeLink(token, totp(base32Decode(secret), T0), T0)).toThrow(/password only/);
      const user = s.completePasswordLink(token, PW, T0);
      expect(user.active).toBe(true);
      expect(user.recoveryLeft).toBe(0);
      expect(s.link(token, T0)).toBeNull();

      expect(s.verifyLogin('hive', PW, '', T0)?.factor).toBe('password');
      expect(s.verifyLogin('hive', PW, undefined, T0)?.factor).toBe('password');
      expect(s.verifyLogin('hive', PW, '123456', T0)?.factor).toBe('password'); // a code is ignored
      expect(s.verifyLogin('hive', 'not the password', '', T0)).toBeNull();
      expect(s.useSecondFactor(hive.id, totp(base32Decode(secret), T0), T0)).toBeNull();
    });

    it('never become admins, and other accounts still need their code', () => {
      const s = open();
      activate(s, 'Ana', 'admin', T0);
      const hive = s.createUser('Hive', 'gm', T0, { passwordOnly: true });
      s.completePasswordLink(s.createLink(hive.id, 'new', T0), PW, T0);
      expect(() => s.setRole(hive.id, 'admin')).toThrow(/can't be an admin/);
      expect(s.user(hive.id)!.role).toBe('gm');
      expect(s.verifyLogin('Ana', 'a long enough password', '', T0)).toBeNull();
      // a two-factor account's link can't be finished by the password alone
      const gm = s.createUser('Gm', 'gm', T0);
      expect(() => s.completePasswordLink(s.createLink(gm.id, 'new', T0), PW, T0)).toThrow(/needs an authenticator/);
      expect(s.user(gm.id)!.active).toBe(false);
    });

    it('keep their mode on a reset, and turning the authenticator on brings recovery codes', () => {
      const s = open();
      const hive = s.createUser('Hive', 'gm', T0, { passwordOnly: true });
      s.completePasswordLink(s.createLink(hive.id, 'new', T0), PW, T0);
      const session = s.createSession(hive.id, {}, T0);

      const reset = s.resetLogin(hive.id, T0);
      expect(s.sessionUser(session, T0)).toBeNull();
      expect(s.verifyLogin('Hive', PW, '', T0)).toBeNull();
      expect(s.link(reset, T0)!.passwordOnly).toBe(true);
      s.completePasswordLink(reset, 'a new hive password here', T0);
      expect(s.verifyLogin('Hive', 'a new hive password here', '', T0)).not.toBeNull();

      const on = s.createLink(hive.id, 'authenticator', T0);
      const secret = s.link(on, T0)!.secret;
      const done = s.completeLink(on, totp(base32Decode(secret), T0), T0)!;
      expect(done.recoveryCodes).toHaveLength(10);
      expect(done.user.passwordOnly).toBe(false);
      const later = T0 + 30_000;
      expect(s.verifyLogin('Hive', 'a new hive password here', '', later)).toBeNull();
      expect(s.verifyLogin('Hive', 'a new hive password here', totp(base32Decode(secret), later), later)?.factor).toBe('code');
    });

    it('can be switched from the authenticator to password only, keeping the password and sessions', () => {
      const s = open();
      const gm = activate(s, 'Gm', 'gm', T0);
      const session = s.createSession(gm.id, {}, T0);
      const turnOn = s.createLink(gm.id, 'authenticator', T0);
      const u = s.makePasswordOnly(gm.id);
      expect(u).toMatchObject({ passwordOnly: true, active: true, recoveryLeft: 0 });
      expect(s.sessionUser(session, T0)).not.toBeNull();
      expect(s.link(turnOn, T0)).toBeNull(); // an open "new authenticator" link goes too
      const later = T0 + 30_000;
      expect(s.verifyLogin('Gm', 'a long enough password', '', later)?.factor).toBe('password');
      expect(s.useSecondFactor(gm.id, totp(base32Decode(gm.secret), later), later)).toBeNull();
      expect(s.useSecondFactor(gm.id, gm.codes[0]!, later)).toBeNull();
      expect(() => s.makePasswordOnly(gm.id)).toThrow(/already/);
      const admin = activate(s, 'Ana', 'admin', T0);
      expect(() => s.makePasswordOnly(admin.id)).toThrow(/Admin accounts/);
      // a GM still setting up keeps the link, which now asks for the password alone
      const pending = s.createUser('Bo', 'gm', T0);
      const token = s.createLink(pending.id, 'new', T0);
      expect(s.makePasswordOnly(pending.id).active).toBe(false);
      expect(s.link(token, T0)!.passwordOnly).toBe(true);
      expect(s.completePasswordLink(token, PW, T0).active).toBe(true);
    });

    it('can be switched to need the authenticator by a reset', () => {
      const s = open();
      const hive = s.createUser('Hive', 'gm', T0, { passwordOnly: true });
      s.completePasswordLink(s.createLink(hive.id, 'new', T0), PW, T0);
      const token = s.resetLogin(hive.id, T0, { passwordOnly: false });
      expect(s.user(hive.id)!.passwordOnly).toBe(false);
      expect(() => s.completePasswordLink(token, PW, T0)).toThrow(/needs an authenticator/);
      const admin = activate(s, 'Ana', 'admin', T0);
      expect(() => s.resetLogin(admin.id, T0, { passwordOnly: true })).toThrow();
    });

    it('adds the column to an accounts.db from before', () => {
      const file = tempFile();
      const old = new DatabaseSync(file);
      old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('admin', 'gm')),
        password_hash TEXT, totp_secret TEXT, totp_confirmed INTEGER NOT NULL DEFAULT 0, totp_last_step INTEGER NOT NULL DEFAULT -1,
        recovery_hashes TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, last_login INTEGER)`);
      old.prepare(`INSERT INTO users (name, name_key, role, created, totp_confirmed) VALUES ('Ana', 'ana', 'admin', ?, 1)`).run(T0);
      old.close();
      const s = open(file);
      expect(s.users()[0]).toMatchObject({ name: 'Ana', active: true, passwordOnly: false });
      expect(s.createUser('Hive', 'gm', T0, { passwordOnly: true }).passwordOnly).toBe(true);
    });
  });
});
