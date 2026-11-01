// The desktop app's parts that don't need Electron: its folders, the window's
// remembered place, the log files and "Copy logs", and the server child process
// (started here with this Node and the real desktop server entry, as the app
// starts it with the bundled node.exe).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeDesktopLink, KEY_PATTERN } from '../src/claude-desktop.ts';
import { collectLogs, LogFile, redact, tail } from '../src/logs.ts';
import { menuTemplate, type MenuActions } from '../src/menu.ts';
import { desktopPaths, resourcePaths } from '../src/paths.ts';
import { ServerProcess, serverEnv } from '../src/server-process.ts';
import { vaultReply } from '../src/vault.ts';
import { DEFAULT_SIZE, parseWindowState, placeWindow } from '../src/window-state.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delve-desktop-app-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('folders', () => {
  it('keeps maps and logs in %APPDATA%\\Quillwarren and models in %LOCALAPPDATA%\\Quillwarren', () => {
    const p = desktopPaths({ appData: '/u/AppData/Roaming', localAppData: '/u/AppData/Local' });
    expect(p).toEqual({
      userData: join('/u/AppData/Roaming', 'Quillwarren'),
      data: join('/u/AppData/Roaming', 'Quillwarren', 'data'),
      logs: join('/u/AppData/Roaming', 'Quillwarren', 'logs'),
      models: join('/u/AppData/Local', 'Quillwarren', 'models'),
      windowState: join('/u/AppData/Roaming', 'Quillwarren', 'window-state.json'),
      desktopFile: join('/u/AppData/Roaming', 'Quillwarren', 'desktop.json'),
      claudeDesktopFile: join('/u/AppData/Roaming', 'Quillwarren', 'claude-desktop.json'),
    });
    expect(desktopPaths({ appData: '/a' }).models).toBe(join('/a', 'Quillwarren', 'models'));
  });

  it('finds the bundled programs in resources', () => {
    expect(resourcePaths('/app/resources', 'win32')).toEqual({
      node: join('/app/resources', 'node', 'node.exe'),
      server: join('/app/resources', 'server', 'desktop-main.mjs'),
      llama: join('/app/resources', 'llama', 'llama-server.exe'),
      notices: join('/app/resources', 'THIRD-PARTY-NOTICES.txt'),
      icon: join('/app/resources', 'icon.png'),
      mcpb: join('/app/resources', 'Quillwarren.mcpb'),
    });
  });
});

describe('the menu', () => {
  type Item = { label?: string; click?: (...a: never[]) => void; submenu?: unknown };
  const flatten = (items: readonly Item[]): Item[] => items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu as Item[]) : [])]);

  it('is one person’s editor: no Quillwarren Table and no players’ screen, only Quillwarren’s own pages', () => {
    const went: string[] = [];
    const done: string[] = [];
    const actions = new Proxy({} as MenuActions, {
      get: (_t, name) => (name === 'go' ? (path: string) => went.push(path) : () => done.push(String(name))),
    });
    const items = flatten(menuTemplate(actions) as Item[]);
    const labels = items.map((i) => i.label).filter((l): l is string => Boolean(l));
    expect(labels).not.toContain('Quillwarren Table');
    expect(labels.join(' | ')).not.toMatch(/table|player|invite|discord/i);
    expect(labels.slice(0, 5)).toEqual(['&File', 'Library', 'Trace a map picture…', 'Open the data folder', 'Quit']);
    for (const i of items) i.click?.();
    expect(went).toEqual(['/', '/import/image', '/models']);
    expect(done).toContain('showAbout');
    expect(done).toContain('copyLogs');
  });

  it('has Connect to Claude Desktop… beside the chat’s models, and Disconnect only while connected', () => {
    const done: string[] = [];
    const actions = new Proxy({} as MenuActions, { get: (_t, name) => () => done.push(String(name)) });
    type Entry = Item & { enabled?: boolean };
    const help = (connected: boolean) => {
      const menus = menuTemplate(actions, { claudeDesktop: connected }) as Entry[];
      return (menus.find((m) => m.label === '&Help')!.submenu as Entry[]).filter((i) => i.label);
    };
    const off = help(false);
    expect(off.slice(0, 3).map((i) => i.label)).toEqual(['Models for the chat…', 'Connect to Claude Desktop…', 'Disconnect Claude Desktop']);
    expect(off[2]!.enabled).toBe(false);
    const on = help(true);
    expect(on[1]!.label).toBe('Connect to Claude Desktop again…');
    expect(on[2]!.enabled).toBe(true);
    on[1]!.click?.();
    on[2]!.click?.();
    expect(done).toEqual(['connectClaudeDesktop', 'disconnectClaudeDesktop']);
  });
});

describe('Claude Desktop’s connection file', () => {
  it('makes a key on the first connect, keeps it, writes the port, and revokes it on disconnect', () => {
    const file = join(dir, 'Quillwarren', 'claude-desktop.json');
    const link = new ClaudeDesktopLink(file);
    expect(link.connected()).toBe(false);
    expect(link.key()).toBe(null);
    link.setPort(51234); // not connected: nothing written
    expect(existsSync(file)).toBe(false);
    const key = link.connect(51234);
    expect(key).toMatch(KEY_PATTERN);
    expect(key.length).toBeGreaterThanOrEqual(43);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ app: 'Quillwarren', version: 1, port: 51234, key });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
    expect(link.connect(51235)).toBe(key); // connecting again keeps the key
    link.setPort(null); // Quillwarren closes
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ port: null, key });
    link.setPort(40000); // the next launch
    expect(JSON.parse(readFileSync(file, 'utf8')).port).toBe(40000);
    link.disconnect();
    expect(existsSync(file)).toBe(false);
    expect(link.connected()).toBe(false);
    const next = link.connect(null);
    expect(next).not.toBe(key); // a new key after a disconnect
    // a file with a bad key counts as not connected
    writeFileSync(file, JSON.stringify({ app: 'Quillwarren', version: 1, port: 1, key: 'short' }));
    expect(link.connected()).toBe(false);
  });

  it('keeps working with a file moved over from the old folder, which still says the old name', () => {
    const file = join(dir, 'moved', 'claude-desktop.json');
    const key = new ClaudeDesktopLink(file).connect(1);
    writeFileSync(file, JSON.stringify({ app: 'Delve', version: 1, port: null, key, updated: '2026-10-31T00:00:00.000Z' }));
    const link = new ClaudeDesktopLink(file);
    expect(link.connected()).toBe(true);
    expect(link.key()).toBe(key);
    link.setPort(41000);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ app: 'Quillwarren', port: 41000, key });
  });

  it('never uses the window’s launch secret, and the server gets the key only while connected', () => {
    const paths = desktopPaths({ appData: '/r', localAppData: '/l' });
    const secret = randomBytes(32).toString('base64url');
    const link = new ClaudeDesktopLink(join(dir, 'c.json'));
    const key = link.connect(1);
    expect(key).not.toBe(secret);
    const on = serverEnv({ PATH: '/bin', DELVE_CLAUDE_DESKTOP_KEY: 'old' }, { secret, paths, port: 1, version: 'x', claudeKey: key });
    expect(on.DELVE_CLAUDE_DESKTOP_KEY).toBe(key);
    const off = serverEnv({ PATH: '/bin', DELVE_CLAUDE_DESKTOP_KEY: 'old' }, { secret, paths, port: 1, version: 'x' });
    expect(off.DELVE_CLAUDE_DESKTOP_KEY).toBeUndefined();
  });
});

describe('the key vault (safeStorage for the chat’s API keys)', () => {
  const safe = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from([...s].reverse().join('')), decryptString: (b: Buffer) => [...b.toString()].reverse().join('') };
  it('seals and opens for the server, and answers nothing else', () => {
    const sealed = vaultReply({ type: 'vault', id: 'a', op: 'seal', data: 'sk-ant-xyz' }, safe)!;
    expect(sealed).toMatchObject({ type: 'vault-reply', id: 'a', ok: true });
    expect(sealed.data).not.toContain('sk-ant-xyz');
    expect(vaultReply({ type: 'vault', id: 'b', op: 'open', data: sealed.data }, safe)).toEqual({ type: 'vault-reply', id: 'b', ok: true, data: 'sk-ant-xyz' });
    expect(vaultReply({ type: 'vault', id: 'c', op: 'status' }, safe)).toEqual({ type: 'vault-reply', id: 'c', ok: true, available: true });
    expect(vaultReply({ type: 'ready', port: 1 }, safe)).toBeNull();
    expect(vaultReply({ type: 'vault', id: 'd', op: 'open', data: 'x' }, { ...safe, decryptString: () => { throw new Error('no'); } })).toMatchObject({ ok: false });
    expect(vaultReply({ type: 'vault', id: 'e', op: 'seal', data: 'k' }, { ...safe, isEncryptionAvailable: () => false })).toMatchObject({ ok: false, error: expect.stringMatching(/isn’t available/) });
  });
});

describe('the window’s place', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const second = { x: 1920, y: 0, width: 2560, height: 1400 };

  it('reads a saved state, ignoring anything odd', () => {
    expect(parseWindowState(undefined)).toEqual({ maximized: false, fullScreen: false });
    expect(parseWindowState({ bounds: { x: 'a', y: 0, width: 10, height: 10 }, maximized: 'yes' })).toEqual({ maximized: false, fullScreen: false });
    expect(parseWindowState({ bounds: { x: 10.4, y: 20, width: 1000, height: 700 }, maximized: true })).toEqual({ bounds: { x: 10, y: 20, width: 1000, height: 700 }, maximized: true, fullScreen: false });
  });

  it('opens where it was, on whichever screen that was', () => {
    expect(placeWindow({ bounds: { x: 2000, y: 100, width: 1600, height: 1000 }, maximized: false, fullScreen: false }, [primary, second], primary)).toEqual({ x: 2000, y: 100, width: 1600, height: 1000 });
  });

  it('comes back onto the primary screen when its screen is gone, and fits small screens', () => {
    const lost = placeWindow({ bounds: { x: 2000, y: 100, width: 1600, height: 1000 }, maximized: false, fullScreen: false }, [primary], primary);
    expect(lost).toEqual({ x: 240, y: 70, width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height });
    const small = { x: 0, y: 0, width: 1280, height: 680 };
    expect(placeWindow({ maximized: false, fullScreen: false }, [small], small)).toEqual({ x: 0, y: 0, width: 1280, height: 680 });
    // too big for its screen: shrunk and moved inside
    expect(placeWindow({ bounds: { x: -50, y: 0, width: 3000, height: 2000 }, maximized: false, fullScreen: false }, [primary], primary)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });
});

describe('logs', () => {
  it('moves a full log aside and keeps writing', () => {
    const f = join(dir, 'logs', 'main.log');
    const log = new LogFile(f, 100);
    for (let i = 0; i < 10; i++) log.line(`line ${i} ${'x'.repeat(20)}`);
    expect(existsSync(`${f}.1`)).toBe(true);
    expect(readFileSync(f, 'utf8').length).toBeLessThanOrEqual(100);
    expect(tail(f, 1)).toMatch(/line 9/);
  });

  it('copies the end of each log with the versions, and never a secret', () => {
    const secret = randomBytes(32).toString('base64url');
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'logs', 'main.log'), Array.from({ length: 500 }, (_, i) => `main ${i}`).join('\n'));
    writeFileSync(join(dir, 'logs', 'server.log'), `{"msg":"ready"}\nleaked ${secret} here\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\n`);
    const text = collectLogs(join(dir, 'logs'), { Quillwarren: '0.1.0', Electron: '44.6.0' }, [secret], 100);
    expect(text).toContain('Quillwarren: 0.1.0');
    expect(text).toContain('===== main.log (last 100 lines)');
    expect(text).toContain('main 499');
    expect(text).not.toContain('main 300\n');
    expect(text).toContain('===== llama-server.log: (none)');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(redact('x-delve-desktop: AAAAAAAAAAAAAAAAAAAAAAAA', [])).toBe('x-delve-desktop: [secret]');
  });

  it('blanks the Claude Desktop key and any Anthropic or OpenAI key, wherever it shows up', () => {
    const key = randomBytes(32).toString('base64url');
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'logs', 'server.log'), [`{"key":"${key}"}`, 'x-api-key: sk-ant-api03-FAKEFAKEFAKEFAKEFAKE', 'error sk-proj-FAKEFAKEFAKEFAKEFAKE00 refused', `"key": "${'Z'.repeat(43)}"`].join('\n'));
    const text = collectLogs(join(dir, 'logs'), { Quillwarren: '0.1.0' }, ['launch-secret-0000000000', key, null]);
    expect(text).not.toContain(key);
    expect(text).not.toMatch(/sk-ant-api03|sk-proj-FAKE|ZZZZZZZZZZZZZZZZ/);
    expect(text).toContain('refused');
  });
});

describe('the server process', () => {
  it('gets the user’s environment without Electron’s, Node’s or old Quillwarren settings, plus its own', () => {
    const paths = desktopPaths({ appData: '/r', localAppData: '/l' });
    const env = serverEnv(
      { PATH: '/bin', SystemRoot: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=/evil.js', DELVE_INSECURE_OPEN_EDIT: '1', DELVE_API_TOKEN: 'x', PORT: '80', HOST: '0.0.0.0' },
      { secret: 's'.repeat(43), paths, port: 51234, version: '0.1.0', llama: '/res/llama/llama-server.exe' },
    );
    expect(env).toEqual({
      PATH: '/bin',
      SystemRoot: 'C:\\Windows',
      NODE_ENV: 'production',
      DELVE_DESKTOP_SECRET: 's'.repeat(43),
      DELVE_DATA: paths.data,
      DELVE_LOG_DIR: paths.logs,
      DELVE_MODELS_DIR: paths.models,
      DELVE_VERSION: '0.1.0',
      PORT: '51234',
      DELVE_LLAMA_SERVER: '/res/llama/llama-server.exe',
    });
  });

  it('starts the desktop server, learns its port, and stops it cleanly', async () => {
    const paths = desktopPaths({ appData: join(dir, 'Roaming'), localAppData: join(dir, 'Local') });
    mkdirSync(paths.userData, { recursive: true });
    const secret = randomBytes(32).toString('base64url');
    let output = '';
    let crashed = false;
    const s = new ServerProcess(
      { node: process.execPath, entry: resolve(import.meta.dirname, '../../server/src/desktop/main.ts'), secret, paths, port: 0, version: '0.1.0-test' },
      { output: (t) => (output += t), crashed: () => (crashed = true) },
    );
    const port = await s.start();
    expect(s.running).toBe(true);
    const health = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-delve-desktop': secret } });
    expect(health.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(401);
    await s.stop();
    expect(s.running).toBe(false);
    expect(crashed).toBe(false);
    expect(output).toContain('shutting down (the app asked)');
    expect(existsSync(join(paths.data, 'delve.db'))).toBe(true);
  }, 60_000);

  it('connects Claude Desktop end to end: the key over IPC, the connection file, the bridge reaching /mcp; Disconnect closes it', async () => {
    const paths = desktopPaths({ appData: join(dir, 'Roaming'), localAppData: join(dir, 'Local') });
    mkdirSync(paths.userData, { recursive: true });
    const secret = randomBytes(32).toString('base64url');
    const link = new ClaudeDesktopLink(paths.claudeDesktopFile);
    let output = '';
    const s = new ServerProcess(
      { node: process.execPath, entry: resolve(import.meta.dirname, '../../server/src/desktop/main.ts'), secret, paths, port: 0, version: '0.1.0-test' },
      { output: (t) => (output += t), crashed: () => {} },
    );
    const port = await s.start();
    // the bridge, as Claude Desktop starts it, with %APPDATA% pointing here
    const bridge = spawn(process.execPath, [resolve(import.meta.dirname, '../claude-extension/server/index.js')], { env: { PATH: process.env.PATH ?? '', APPDATA: join(dir, 'Roaming') }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const answers = new Map<number, (m: { result?: { content?: { text?: string }[]; isError?: boolean } }) => void>();
    bridge.stdout!.setEncoding('utf8');
    bridge.stdout!.on('data', (d: string) => {
      buf += d;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const m = JSON.parse(buf.slice(0, nl)) as { id?: number; result?: { content?: { text?: string }[]; isError?: boolean } };
        buf = buf.slice(nl + 1);
        if (typeof m.id === 'number') answers.get(m.id)?.(m);
      }
    });
    let id = 0;
    const listMaps = () =>
      new Promise<{ text: string; isError: boolean }>((done) => {
        const n = ++id;
        answers.set(n, (m) => done({ text: m.result?.content?.[0]?.text ?? '', isError: m.result?.isError === true }));
        bridge.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'list_maps', arguments: {} } })}\n`);
      });
    try {
      expect((await listMaps()).text).toMatch(/isn’t connected/); // no connection file yet
      const key = link.connect(port); // Help → Connect to Claude Desktop…
      expect(await s.request({ type: 'claude-desktop', key }, 'claude-desktop')).toEqual({ type: 'claude-desktop', on: true });
      const on = await listMaps();
      expect(on.isError).toBe(false);
      expect(on.text).toMatch(/No maps yet|map_/);
      // Help → Disconnect Claude Desktop
      link.disconnect();
      expect(await s.request({ type: 'claude-desktop', key: null }, 'claude-desktop')).toEqual({ type: 'claude-desktop', on: false });
      expect((await listMaps()).text).toMatch(/isn’t connected/);
      // even with the old file back, the server no longer takes the old key
      writeFileSync(paths.claudeDesktopFile, JSON.stringify({ app: 'Quillwarren', version: 1, port, key }));
      expect((await listMaps()).text).toMatch(/isn’t connected/);
      expect(output).toContain('Claude Desktop access on');
      expect(output).not.toContain(key);
    } finally {
      bridge.stdin!.end();
      await s.stop();
    }
  }, 60_000);

  it('says what is missing instead of starting', async () => {
    const paths = desktopPaths({ appData: dir });
    const s = new ServerProcess({ node: join(dir, 'node.exe'), entry: 'x', secret: 'x', paths, port: 0, version: 'x' }, { output: () => {}, crashed: () => {} });
    await expect(s.start()).rejects.toThrow(/bundled Node.js is missing/);
  });
});
