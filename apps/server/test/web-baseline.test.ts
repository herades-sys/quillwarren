// The web app is unchanged by the desktop work: with desktop mode off (every
// configuration the CT server and its tests use), the routes, every page, the
// chat answers (the Claude bridge, no backend choice), the login, public mode
// and the API answer exactly as at 3a8997d (fixtures/web-baseline.json). When the
// web app changes on purpose, rewrite the fixture: node apps/server/test/web-baseline.ts --write
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASELINE_FILE, webFingerprint } from './web-baseline.ts';

describe('the web app without desktop mode', () => {
  it('answers exactly as before the desktop app (routes, pages, chat, auth, public mode)', async () => {
    const want = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Record<string, unknown>;
    const got = await webFingerprint();
    for (const name of Object.keys(want)) expect(got[name], name).toEqual(want[name]);
    expect(Object.keys(got)).toEqual(Object.keys(want));
  }, 60_000);
});
