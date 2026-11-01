// Quillwarren for Windows: the Electron main process. It starts the Quillwarren server
// (the same server as the web app, in desktop mode: apps/server/src/desktop/)
// as a child process on the bundled Node.js, gives only this app's window the
// per-launch secret the server asks for, and shows the editor in one window.
// One instance at a time; the window remembers its size and place; quitting
// stops the server (and with it the model runtime) cleanly. The Help menu has
// "Copy logs" for sending problems back, and "Connect to Claude Desktop…",
// which lets Claude in Claude Desktop work on the maps through the Quillwarren
// extension (claude-desktop.ts). The server's key vault for the chat's API
// keys is Electron's safeStorage, answered here (vault.ts). See docs/DESKTOP.md.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, Menu, nativeTheme, safeStorage, screen, session, shell, type WebContents } from 'electron';
import { CLAUDE_DOWNLOAD_URL, ClaudeDesktopLink } from './claude-desktop.ts';
import { collectLogs, LogFile, redact } from './logs.ts';
import { folderMoveLines, moveOldFolders } from './folder-move.ts';
import { menuTemplate } from './menu.ts';
import { desktopPaths, resourcePaths } from './paths.ts';
import { ServerProcess } from './server-process.ts';
import { setUpUpdates } from './updater.ts';
import { vaultReply } from './vault.ts';
import { parseWindowState, placeWindow, MIN_SIZE, type WindowState } from './window-state.ts';

// ---------- one instance, fixed folders ----------

app.setName('Quillwarren');
const roots = { appData: app.getPath('appData'), localAppData: process.env.LOCALAPPDATA };
// the folders from when the app had its old name: before anything can open the new ones
const folderMoves = moveOldFolders(roots);
const paths = desktopPaths(roots);
app.setPath('userData', paths.userData);
// Windows groups the taskbar button and the shortcuts by this id (keep it once released).
app.setAppUserModelId('app.quillwarren.desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

for (const d of [paths.userData, paths.data, paths.logs]) mkdirSync(d, { recursive: true });
const log = new LogFile(join(paths.logs, 'main.log'));
const serverLog = new LogFile(join(paths.logs, 'server.log'));
const res = resourcePaths(app.isPackaged ? process.resourcesPath : join(__dirname, '..', 'build', 'resources'));
const secret = randomBytes(32).toString('base64url');
/** Claude Desktop's connection file and key (Help → Connect to Claude Desktop…). */
const claudeDesktop = new ClaudeDesktopLink(paths.claudeDesktopFile);
/** Claude Desktop keys of this session, revoked ones too. */
const claudeKeys = new Set<string>();
/** Every secret a log or "Copy logs" must never show: the launch secret and the Claude Desktop keys. */
const secrets = () => {
  const k = claudeDesktop.key();
  if (k) claudeKeys.add(k);
  return [secret, ...claudeKeys];
};
log.line(`Quillwarren ${app.getVersion()} starting (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`);
for (const line of folderMoveLines(folderMoves)) log.line(line);

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
  const claudeKey = claudeDesktop.key();
  server = new ServerProcess(
    { node: res.node, entry: res.server, secret, paths, port: lastPort(), version: app.getVersion(), ...(existsSync(res.llama) ? { llama: res.llama } : {}), ...(claudeKey ? { claudeKey } : {}) },
    {
      output: (text) => serverLog.write(redact(text, secrets())),
      crashed: (code, signal) => void onServerCrash(code, signal),
      // the server's key vault: API keys sealed and opened with safeStorage (DPAPI),
      // and the chat settings' "Connect to Claude Desktop…" (the same dialog as the Help menu's)
      message: (m) => {
        if ((m as { type?: unknown } | null)?.type === 'claude-desktop-connect') {
          void connectClaudeDesktop();
          return;
        }
        const reply = vaultReply(m, safeStorage);
        if (reply) server?.send(reply);
      },
    },
  );
  const port = await server.start();
  writeJson(paths.desktopFile, { port });
  // while connected, Claude Desktop's bridge finds this launch's port in its connection file
  claudeDesktop.setPort(port);
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
    title: 'Quillwarren',
    message: 'Quillwarren’s map server stopped and couldn’t be restarted.',
    detail: 'Your maps are saved. “Copy logs” puts what Quillwarren wrote down on the clipboard, so you can send it.',
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
  // links to other sites open in the user's browser; nothing navigates this window away from Quillwarren
  contents.on('will-navigate', (e, url) => {
    if (isOwn(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isOwn(url)) {
      // Quillwarren's own pages in a new window (the snip's handout): same rules
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
    title: 'Quillwarren',
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
    Quillwarren: app.getVersion(),
    Electron: process.versions.electron ?? '',
    Chromium: process.versions.chrome ?? '',
    'Node (Electron)': process.versions.node ?? '',
    System: `${process.platform} ${process.arch} ${process.getSystemVersion()}`,
    Server: server?.running ? `running on 127.0.0.1:${server.port}` : 'not running',
    'Claude Desktop': claudeDesktop.connected() ? 'connected (Help → Disconnect Claude Desktop to stop it)' : 'not connected',
    Data: paths.data,
    Logs: paths.logs,
  };
}

function copyLogs(quiet = false): void {
  const text = collectLogs(paths.logs, about(), secrets());
  clipboard.writeText(text);
  if (quiet) return;
  void dialog.showMessageBox({ type: 'info', title: 'Quillwarren', message: 'The logs are on the clipboard.', detail: `${Math.round(text.length / 1024)} KB. Paste them into a message. The full files are in ${paths.logs}.`, buttons: ['OK', 'Open the logs folder'] }).then((r) => {
    if (r.response === 1) void shell.openPath(paths.logs);
  });
}

function buildMenu(): void {
  const zoom = (d: number) => {
    const wc = BrowserWindow.getFocusedWindow()?.webContents;
    if (wc) wc.setZoomLevel(d === 0 ? 0 : wc.getZoomLevel() + d);
  };
  // the items themselves are in menu.ts (tested there): no Quillwarren Table, no players' screen
  const template = menuTemplate({
    go,
    openDataFolder: () => void shell.openPath(paths.data),
    quit: () => app.quit(),
    back: () => win?.webContents.navigationHistory.goBack(),
    forward: () => win?.webContents.navigationHistory.goForward(),
    reload: () => win?.webContents.reload(),
    zoom,
    toggleFullScreen: () => win?.setFullScreen(!win.isFullScreen()),
    copyLogs: () => copyLogs(),
    openLogsFolder: () => void shell.openPath(paths.logs),
    toggleDevTools: () => win?.webContents.toggleDevTools(),
    openNotices: () => void shell.openPath(res.notices),
    connectClaudeDesktop: () => void connectClaudeDesktop(),
    disconnectClaudeDesktop: () => void disconnectClaudeDesktop(),
    showAbout: () =>
      void dialog.showMessageBox({
        type: 'info',
        title: 'About Quillwarren',
        message: `Quillwarren ${app.getVersion()}`,
        detail: `A dungeon map editor.\n\n${Object.entries(about())
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n')}`,
      }),
  }, { claudeDesktop: claudeDesktop.connected() });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- Claude Desktop ----------

/** Tells the running server whether Claude Desktop may use /mcp, and with which key. */
async function tellServer(key: string | null): Promise<void> {
  if (!server?.running) return; // the next start reads the key from the connection file
  try {
    await server.request({ type: 'claude-desktop', key }, 'claude-desktop');
  } catch (e) {
    log.line(`couldn't tell the server about Claude Desktop: ${(e as Error).message}`);
  }
}

const parent = () => (win && !win.isDestroyed() ? win : undefined);

/**
 * Help → Connect to Claude Desktop…: says what happens, turns access on, writes
 * the connection file and opens the extension, so Claude Desktop shows its own
 * install confirmation. Without Claude Desktop, points to its download.
 */
let connecting = false;

async function connectClaudeDesktop(): Promise<void> {
  // the Help menu and the chat settings both ask: one dialog at a time
  if (connecting) return;
  connecting = true;
  try {
    await connectClaudeDesktopNow();
  } finally {
    connecting = false;
  }
}

async function connectClaudeDesktopNow(): Promise<void> {
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Connect to Claude Desktop',
    message: 'Let Claude in Claude Desktop work on your Quillwarren maps?',
    detail: [
      'Claude Desktop gets a Quillwarren extension. When you chat with Claude there, Claude builds and changes your maps with Quillwarren’s own tools, and you watch every change live in this window. Each change is one undo step here.',
      '',
      'Claude runs on your own Claude plan. Quillwarren itself sends nothing anywhere: what Claude reads through the tools is part of your conversation with Claude.',
      '',
      'It works only while Quillwarren is open, and only on this computer. Help → Disconnect Claude Desktop turns it off again.',
      '',
      'Next, Claude Desktop asks you to confirm the installation.',
    ].join('\n'),
    buttons: ['Connect and install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const w = parent();
  const choice = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
  if (choice.response !== 0) return;
  const key = claudeDesktop.connect(server?.running ? server.port : null);
  claudeKeys.add(key);
  await tellServer(key);
  log.line('Claude Desktop connected');
  buildMenu();
  const problem = existsSync(res.mcpb) ? await shell.openPath(res.mcpb) : 'the extension file is missing from this build';
  if (!problem) return; // Claude Desktop shows its own confirmation
  log.line(`opening the Claude Desktop extension failed: ${problem}`);
  const fallback: Electron.MessageBoxOptions = {
    type: 'info',
    title: 'Connect to Claude Desktop',
    message: 'Claude Desktop didn’t open the Quillwarren extension.',
    detail: [
      `If you don’t have Claude Desktop yet, get it from ${CLAUDE_DOWNLOAD_URL}, then choose Help → Connect to Claude Desktop again.`,
      '',
      'Or install the extension by hand: in Claude Desktop open Settings → Desktop app and choose Manage beside Extensions (older versions: Settings → Extensions), then Advanced settings, and under Extension Developer choose “Install Extension…” and pick this file:',
      res.mcpb,
      '',
      'Quillwarren stays connected: once the extension is installed, Claude can use it while Quillwarren is open.',
    ].join('\n'),
    buttons: ['Get Claude Desktop', 'Show the extension file', 'OK'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  };
  const r = w ? await dialog.showMessageBox(w, fallback) : await dialog.showMessageBox(fallback);
  if (r.response === 0) void shell.openExternal(CLAUDE_DOWNLOAD_URL);
  else if (r.response === 1 && existsSync(res.mcpb)) shell.showItemInFolder(res.mcpb);
}

/** Help → Disconnect Claude Desktop: the key is revoked and the connection file deleted. */
async function disconnectClaudeDesktop(): Promise<void> {
  if (!claudeDesktop.connected()) return;
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Disconnect Claude Desktop',
    message: 'Stop Claude Desktop from working on your maps?',
    detail: 'Claude in Claude Desktop can’t reach Quillwarren any more. The Quillwarren extension stays in Claude Desktop until you remove it there (Settings → Extensions); connecting again later makes a new key.',
    buttons: ['Disconnect', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const w = parent();
  const choice = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
  if (choice.response !== 0) return;
  claudeDesktop.disconnect();
  await tellServer(null);
  log.line('Claude Desktop disconnected');
  buildMenu();
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
      claudeDesktop.setPort(null); // closed: the bridge says so instead of knocking on the old port
      log.line('server stopped; bye');
      app.quit();
    });
  } else claudeDesktop.setPort(null);
});

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  // no camera, microphone, location, notifications or page-requested full screen (that was the players' screen, which
  // the app leaves out; F11 still works, from the menu): writing to the clipboard only
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'clipboard-sanitized-write'));
  buildMenu();
  try {
    const port = await startServer();
    createWindow(port);
    void setUpUpdates({ packaged: app.isPackaged, log });
  } catch (e) {
    log.line(`couldn't start: ${(e as Error).message}`);
    const r = await dialog.showMessageBox({ type: 'error', title: 'Quillwarren', message: 'Quillwarren couldn’t start its map server.', detail: (e as Error).message, buttons: ['Copy logs and quit', 'Quit'] });
    if (r.response === 0) copyLogs(true);
    quitting = true;
    app.quit();
  }
});
