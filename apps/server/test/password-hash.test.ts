// `npm run password-hash`: prints a hash the server accepts, and refuses short passwords.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyPassword } from '../src/auth.ts';

const CLI = resolve(import.meta.dirname, '../src/cli/password-hash.ts');
const run = (input: string) => spawnSync(process.execPath, [CLI], { input, encoding: 'utf8' });

describe('password-hash', () => {
  it('prints DELVE_EDIT_PASSWORD_HASH for the first line of stdin, and only the hash', async () => {
    const r = run('correct horse battery staple\nignored\n');
    expect(r.status).toBe(0);
    const m = /^DELVE_EDIT_PASSWORD_HASH=(scrypt:\S+)\n$/.exec(r.stdout);
    expect(m).not.toBeNull();
    expect(r.stdout).not.toContain('horse');
    expect(await verifyPassword('correct horse battery staple', m![1])).toBe(true);
    expect(await verifyPassword('ignored', m![1])).toBe(false);
  });

  it('refuses a password under 12 characters and prints nothing', () => {
    const r = run('short\n');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('12 characters');
  });
});
