// Delve for Windows: the Electron main process. It starts the Delve server
// (the same server as the web app, in desktop mode: apps/server/src/desktop/)
// as a child process on the bundled Node.js, gives only this app's window the
// per-launch secret the server asks for, and shows the editor in one window.
// One instance at a time; the window remembers its size and place; quitting
// stops the server (and with it the model runtime) cleanly. The Help menu has
// "Copy logs" for sending problems back. See docs/DESKTOP.md.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, Menu, nativeTheme, screen, session, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { collectLogs, LogFile } from './logs.ts';
import { desktopPaths, resourcePaths } from './paths.ts';
import { ServerProcess } from './server-process.ts';
import { setUpUpdates } from './updater.ts';
import { parseWindowState, placeWindow, MIN_SIZE, type WindowState } from './window-state.ts';

// ---------- one instance, fixed folders ----------

app.setName('Delve');
const paths = desktopPaths({ appData: app.getPath('appData'), localAppData: process.env.LOCALAPPDATA });
app.setPath('userData', paths.userData);
// Windows groups the taskbar button and the shortcuts by this id (keep it once released).
app.setAppUserModelId('app.delve.desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

for (const d of [paths.userData, paths.data, paths.logs]) mkdirSync(d, { recursive: true });
const log = new LogFile(join(paths.logs, 'main.log'));
const serverLog = new LogFile(join(paths.logs, 'server.log'));
const res = resourcePaths(app.isPackaged ? process.resourcesPath : join(__dirname, '..', 'build', 'resources'));
const secret = randomBytes(32).toString('base64url');
log.line(`Delve ${app.getVersion()} starting (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`);

let win: BrowserWindow | null = null;
let server: ServerProcess | null = null;
let quitting = false;
const crashes: number[] = [];

const origin = () => `http://127.0.0.1:${server?.port ?? 0}`;
const isOwn = (url: string) => {
  try {
    return new URL(url).origin === origin();
  } catch {
    return false;
  }
};

// ---------- remembered between launches ----------

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  } catch (e) {
    log.line(`couldn't write ${file}: ${(e as Error).message}`);
  }
}

/** The last port: the same port keeps the window's origin, so the editor's own settings (theme, chat history) stay. */
const lastPort = (): number => {
  const p = (readJson(paths.desktopFile) as { port?: unknown } | undefined)?.port;
  return typeof p === 'number' && Number.isInteger(p) && p > 1024 && p < 65536 ? p : 0;
};

let windowState: WindowState = parseWindowState(readJson(paths.windowState));
let saveTimer: NodeJS.Timeout | null = null;
function rememberWindow(now = false): void {
  if (!win || win.isDestroyed()) return;
  const save = () => {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const fullScreen = win.isFullScreen();
    windowState = { ...(maximized || fullScreen ? (windowState.bounds ? { bounds: windowState.bounds } : {}) : { bounds: win.getBounds() }), maximized, fullScreen };
    writeJson(paths.windowState, windowState);
  };
  if (saveTimer) clearTimeout(saveTimer);
  if (now) save();
  else saveTimer = setTimeout(save, 600);
}

// ---------- the server ----------

async function startServer(): Promise<number> {
  server = new ServerProcess(
    { node: res.node, entry: res.server, secret, paths, port: lastPort(), version: app.getVersion(), ...(existsSync(res.llama) ? { llama: res.llama } : {}) },
    {
      output: (text) => serverLog.write(text),
      crashed: (code, signal) => void onServerCrash(code, signal),
    },
  );
  const port = await server.start();
  writeJson(paths.desktopFile, { port });
  await giveWindowTheSecret(port);
  log.line(`server ready on 127.0.0.1:${port}`);
  return port;
}

/**
 * Only this app's window may talk to the server: its session adds the secret
 * to every request for the server's exact origin (HTTP and WebSocket), and
 * keeps it as an HttpOnly cookie too. Page scripts can read neither.
 */
async function giveWindowTheSecret(port: number): Promise<void> {
  const ses = session.defaultSession;
  const addHeader = (details: Electron.OnBeforeSendHeadersListenerDetails, done: (r: Electron.BeforeSendResponse) => void) =>
    done({ requestHeaders: { ...details.requestHeaders, 'X-Delve-Desktop': secret } });
  // either way is enough on its own: if one of them fails here, the other still lets the window in
  try {
    ses.webRequest.onBeforeSendHeaders({ urls: [`http://127.0.0.1:${port}/*`, `ws://127.0.0.1:${port}/*`] }, addHeader);
  } catch (e) {
    log.line(`header filter with WebSockets refused (${(e as Error).message}); HTTP only, the cookie covers WebSockets`);
    try {
      ses.webRequest.onBeforeSendHeaders({ urls: [`http://127.0.0.1:${port}/*`] }, addHeader);
    } catch (e2) {
      log.line(`header filter refused: ${(e2 as Error).message}`);
    }
  }
  try {
    await ses.cookies.set({ url: `http://127.0.0.1:${port}`, name: 'delve_desktop', value: secret, httpOnly: true, sameSite: 'strict', secure: false });
  } catch (e) {
    log.line(`couldn't set the session cookie: ${(e as Error).message}`);
  }
}

async function onServerCrash(code: number | null, signal: string | null): Promise<void> {
  if (quitting) return;
  log.line(`server stopped unexpectedly (${code ?? signal})`);
  const now = Date.now();
  crashes.push(now);
  while (crashes.length && now - crashes[0]! > 120_000) crashes.shift();
  if (crashes.length <= 2) {
    try {
      const port = await startServer();
      win?.loadURL(`http://127.0.0.1:${port}/`);
      return;
    } catch (e) {
      log.line(`restart failed: ${(e as Error).message}`);
    }
  }
  const choice = await dialog.showMessageBox({
    type: 'error',
    title: 'Delve',
    message: 'Delve’s map server stopped and couldn’t be restarted.',
    detail: 'Your maps are saved. “Copy logs” puts what Delve wrote down on the clipboard, so you can send it.',
    buttons: ['Try again', 'Copy logs', 'Quit'],
    defaultId: 0,
    cancelId: 2,
  });
  if (choice.response === 0) {
    crashes.length = 0;
    void onServerCrash(null, 'retry');
  } else if (choice.response === 1) {
    copyLogs(true);
    app.quit();
  } else app.quit();
}

// ---------- the window ----------

function secureWebContents(contents: WebContents): void {
  // links to other sites open in the user's browser; nothing navigates this window away from Delve
  contents.on('will-navigate', (e, url) => {
    if (isOwn(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isOwn(url)) {
      // the players' screen, the 3D view in a new window: Delve's own pages, same rules
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: webPreferences() } };
    }
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
}

const webPreferences = () => ({ contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: true });

function createWindow(port: number): void {
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  const bounds = placeWindow(windowState, displays, screen.getPrimaryDisplay().workArea);
  win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: 'Delve',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17181c' : '#efeae2',
    icon: res.icon,
    webPreferences: webPreferences(),
  });
  if (windowState.maximized) win.maximize();
  if (windowState.fullScreen) win.setFullScreen(true);
  win.once('ready-to-show', () => win?.show());
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) win.on(ev as 'resize', () => rememberWindow());
  win.on('close', () => rememberWindow(true));
  win.on('closed', () => (win = null));
  win.webContents.on('render-process-gone', (_e, d) => log.line(`window renderer gone: ${d.reason} (${d.exitCode})`));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log.line(`load failed ${code} ${desc} ${url}`));
  void win.loadURL(`http://127.0.0.1:${port}/`);
}

function go(path: string): void {
  if (win && server) void win.loadURL(`${origin()}${path}`);
}

// ---------- menu ----------

function about(): Record<string, string> {
  return {
    Delve: app.getVersion(),
    Electron: process.versions.electron ?? '',
    Chromium: process.versions.chrome ?? '',
    'Node (Electron)': process.versions.node ?? '',
    System: `${process.platform} ${process.arch} ${process.getSystemVersion()}`,
    Server: server?.running ? `running on 127.0.0.1:${server.port}` : 'not running',
    Data: paths.data,
    Logs: paths.logs,
  };
}

function copyLogs(quiet = false): void {
  const text = collectLogs(paths.logs, about(), [secret]);
  clipboard.writeText(text);
  if (quiet) return;
  void dialog.showMessageBox({ type: 'info', title: 'Delve', message: 'The logs are on the clipboard.', detail: `${Math.round(text.length / 1024)} KB. Paste them into a message. The full files are in ${paths.logs}.`, buttons: ['OK', 'Open the logs folder'] }).then((r) => {
    if (r.response === 1) void shell.openPath(paths.logs);
  });
}

function buildMenu(): void {
  const zoom = (d: number) => {
    const wc = BrowserWindow.getFocusedWindow()?.webContents;
    if (wc) wc.setZoomLevel(d === 0 ? 0 : wc.getZoomLevel() + d);
  };
  // No Edit menu: the editor handles Ctrl Z, Ctrl D, Ctrl 0 itself, and text fields get copy and paste from Windows.
  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { label: 'Library', accelerator: 'Alt+Home', click: () => go('/') },
        { label: 'Trace a map picture…', click: () => go('/import/image') },
        { label: 'Delve Table', click: () => go('/play') },
        { type: 'separator' },
        { label: 'Open the data folder', click: () => void shell.openPath(paths.data) },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Ctrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Back', accelerator: 'Alt+Left', click: () => win?.webContents.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => win?.webContents.navigationHistory.goForward() },
        { label: 'Reload', accelerator: 'F5', click: () => win?.webContents.reload() },
        { type: 'separator' },
        { label: 'Larger interface', click: () => zoom(0.5) },
        { label: 'Smaller interface', click: () => zoom(-0.5) },
        { label: 'Normal interface size', click: () => zoom(0) },
        { type: 'separator' },
        { label: 'Full screen', accelerator: 'F11', click: () => win?.setFullScreen(!win.isFullScreen()) },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Models for the chat…', click: () => go('/models') },
        { type: 'separator' },
        { label: 'Copy logs', click: () => copyLogs() },
        { label: 'Open the logs folder', click: () => void shell.openPath(paths.logs) },
        { label: 'Developer tools', click: () => win?.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'Third-party notices', click: () => void shell.openPath(res.notices) },
        {
          label: 'About Delve',
          click: () =>
            void dialog.showMessageBox({
              type: 'info',
              title: 'About Delve',
              message: `Delve ${app.getVersion()}`,
              detail: `A dungeon map editor.\n\n${Object.entries(about())
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- life cycle ----------

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('web-contents-created', (_e, contents) => secureWebContents(contents));

app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  rememberWindow(true);
  if (server?.running) {
    e.preventDefault();
    log.line('quitting: stopping the server');
    void server.stop().finally(() => {
      log.line('server stopped; bye');
      app.quit();
    });
  }
});

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  // no camera, microphone, location or notifications; full screen (the players' screen) and writing to the clipboard only
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'fullscreen' || permission === 'clipboard-sanitized-write'));
  buildMenu();
  try {
    const port = await startServer();
    createWindow(port);
    void setUpUpdates({ packaged: app.isPackaged, log });
  } catch (e) {
    log.line(`couldn't start: ${(e as Error).message}`);
    const r = await dialog.showMessageBox({ type: 'error', title: 'Delve', message: 'Delve couldn’t start its map server.', detail: (e as Error).message, buttons: ['Copy logs and quit', 'Quit'] });
    if (r.response === 0) copyLogs(true);
    quitting = true;
    app.quit();
  }
});
