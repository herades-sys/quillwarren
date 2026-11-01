// The product is called Quillwarren: no page, MCP text or chat prompt says the
// old name (internal names such as DELVE_* or delve.map are not the word itself).
// Saved data keeps working under the names that stay: a map in the old file
// format, the table's page kind and the connection file are checked where they live.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { CHAT_SYSTEM_PROMPT } from '../src/chat/prompt.ts';
import { delveTools, extensionManifest } from '../src/desktop/claude-extension.ts';
import { FEEDBACK_ISSUES_URL } from '../src/desktop/gate.ts';
import { MapStore } from '../src/store.ts';

const OLD = /\bDelve\b/;
const TOKEN = 'name-test-token-0123456789abcdef';

describe('the name', () => {
  let dir: string;
  let app: ReturnType<typeof buildApp>;
  const saved = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/test-map-4p.delve.json'), 'utf8')) as Record<string, unknown>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'quillwarren-name-'));
    const store = new MapStore(join(dir, 'delve.db'));
    store.create(saved, 'test');
    app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN, openEdit: true, dataDir: dir, store });
    app.addHook('onClose', async () => store.close());
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is the only one on the pages', async () => {
    for (const url of ['/', '/feedback', '/ui', '/play', '/maps/map_test4p', '/maps/map_test4p?view=players', '/maps/map_test4p/3d', '/maps/map_test4p/handout', '/maps/map_test4p/screen', '/import/image']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toMatch(OLD);
    }
    expect((await app.inject({ method: 'GET', url: '/' })).body).toContain('Quillwarren');
  });

  it('is the only one in the MCP text and the chat prompts', async () => {
    const { tools, instructions } = await delveTools('test');
    expect(instructions).not.toMatch(OLD);
    expect(instructions).toMatch(/^Quillwarren is a dungeon map editor/);
    for (const t of tools) expect(JSON.stringify(t), t.name).not.toMatch(OLD);
    expect(JSON.stringify(extensionManifest({ version: '0.1.0', tools }))).not.toMatch(OLD);
    expect(CHAT_SYSTEM_PROMPT).not.toMatch(OLD);
    expect(readFileSync(resolve(import.meta.dirname, '../src/chat/lean-prompt.md'), 'utf8')).not.toMatch(OLD);
    expect(FEEDBACK_ISSUES_URL).toBe('https://github.com/herades-sys/quillwarren/issues');
  });

  it('loads a map saved in the old file format, under the format string that stays', async () => {
    expect(saved.format).toBe('delve.map');
    const id = 'map_saved_earlier';
    const res = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: { authorization: `Bearer ${TOKEN}` }, payload: { map: { ...saved, id } } });
    expect(res.statusCode).toBe(201);
    const back = await app.inject({ method: 'GET', url: `/api/v1/maps/${id}` });
    expect((back.json() as { map: { format: string } }).map.format).toBe('delve.map');
    expect((await app.inject({ method: 'GET', url: `/api/v1/maps/${id}/render.png` })).statusCode).toBe(200);
  });
});
