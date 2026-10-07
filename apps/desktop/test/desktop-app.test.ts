// The desktop app's parts that don't need Electron: its folders, the window's
// remembered place, the log files and "Copy logs", and the server child process
// (started here with this Node and the real desktop server entry, as the app
// starts it with the bundled node.exe).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectLogs, LogFile, redact, tail } from '../src/logs.ts';
import { desktopPaths, resourcePaths } from '../src/paths.ts';
import { ServerProcess, serverEnv } from '../src/server-process.ts';
import { DEFAULT_SIZE, parseWindowState, placeWindow } from '../src/window-state.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'delve-desktop-app-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('folders', () => {
  it('keeps maps and logs in %APPDATA%\\Delve and models in %LOCALAPPDATA%\\Delve', () => {
    const p = desktopPaths({ appData: '/u/AppData/Roaming', localAppData: '/u/AppData/Local' });
    expect(p).toEqual({
      userData: join('/u/AppData/Roaming', 'Delve'),
      data: join('/u/AppData/Roaming', 'Delve', 'data'),
      logs: join('/u/AppData/Roaming', 'Delve', 'logs'),
      models: join('/u/AppData/Local', 'Delve', 'models'),
      windowState: join('/u/AppData/Roaming', 'Delve', 'window-state.json'),
      desktopFile: join('/u/AppData/Roaming', 'Delve', 'desktop.json'),
    });
    expect(desktopPaths({ appData: '/a' }).models).toBe(join('/a', 'Delve', 'models'));
  });

  it('finds the bundled programs in resources', () => {
    expect(resourcePaths('/app/resources', 'win32')).toEqual({
      node: join('/app/resources', 'node', 'node.exe'),
      server: join('/app/resources', 'server', 'desktop-main.mjs'),
      llama: join('/app/resources', 'llama', 'llama-server.exe'),
      notices: join('/app/resources', 'THIRD-PARTY-NOTICES.txt'),
      icon: join('/app/resources', 'icon.png'),
    });
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
    const text = collectLogs(join(dir, 'logs'), { Delve: '0.1.0', Electron: '44.6.0' }, [secret], 100);
    expect(text).toContain('Delve: 0.1.0');
    expect(text).toContain('===== main.log (last 100 lines)');
    expect(text).toContain('main 499');
    expect(text).not.toContain('main 300\n');
    expect(text).toContain('===== llama-server.log: (none)');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(redact('x-delve-desktop: AAAAAAAAAAAAAAAAAAAAAAAA', [])).toBe('x-delve-desktop: [secret]');
  });
});

describe('the server process', () => {
  it('gets the user’s environment without Electron’s, Node’s or old Delve settings, plus its own', () => {
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

  it('says what is missing instead of starting', async () => {
    const paths = desktopPaths({ appData: dir });
    const s = new ServerProcess({ node: join(dir, 'node.exe'), entry: 'x', secret: 'x', paths, port: 0, version: 'x' }, { output: () => {}, crashed: () => {} });
    await expect(s.start()).rejects.toThrow(/bundled Node.js is missing/);
  });
});
