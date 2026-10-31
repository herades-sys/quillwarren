// Where the desktop app keeps things. Pure (no Electron), so it is tested on
// its own: apps/desktop/test/paths.test.ts.
//
//   %APPDATA%\Delve\              Electron's userData: the window's browser
//                                 storage, window-state.json, desktop.json,
//                                 claude-desktop.json (while Claude Desktop is
//                                 connected: claude-desktop.ts)
//   %APPDATA%\Delve\data\         the server's DELVE_DATA: maps (delve.db),
//                                 pictures, props, chat settings
//   %APPDATA%\Delve\logs\         main.log, server.log, llama-server.log
//   %LOCALAPPDATA%\Delve\models\  GGUF model files (gigabytes: kept out of the
//                                 roaming profile)
//   <install>\resources\          node\node.exe, server\ (the bundled server),
//                                 Delve.mcpb (the Claude Desktop extension),
//                                 later llama\llama-server.exe
import { join } from 'node:path';

export const APP_FOLDER = 'Delve';

export interface DesktopPaths {
  userData: string;
  data: string;
  logs: string;
  models: string;
  windowState: string;
  /** Remembered between launches: the server's port (so the window's origin, and its saved settings, stay the same). */
  desktopFile: string;
  /** The connection file for Claude Desktop's bridge, while connected (claude-desktop.ts). */
  claudeDesktopFile: string;
}

export function desktopPaths(o: { appData: string; localAppData?: string }): DesktopPaths {
  const userData = join(o.appData, APP_FOLDER);
  return {
    userData,
    data: join(userData, 'data'),
    logs: join(userData, 'logs'),
    models: o.localAppData ? join(o.localAppData, APP_FOLDER, 'models') : join(userData, 'models'),
    windowState: join(userData, 'window-state.json'),
    desktopFile: join(userData, 'desktop.json'),
    claudeDesktopFile: join(userData, 'claude-desktop.json'),
  };
}

export interface ResourcePaths {
  node: string;
  server: string;
  /** llama-server, when this build bundles it. */
  llama: string;
  notices: string;
  icon: string;
  /** The Claude Desktop extension (opened by "Connect to Claude Desktop…"). */
  mcpb: string;
}

/** The bundled programs and files, inside the installed app (resources\) or a development folder. */
export function resourcePaths(resources: string, platform: NodeJS.Platform = process.platform): ResourcePaths {
  const exe = platform === 'win32' ? '.exe' : '';
  return {
    node: join(resources, 'node', `node${exe}`),
    server: join(resources, 'server', 'desktop-main.mjs'),
    llama: join(resources, 'llama', `llama-server${exe}`),
    notices: join(resources, 'THIRD-PARTY-NOTICES.txt'),
    icon: join(resources, 'icon.png'),
    mcpb: join(resources, 'Delve.mcpb'),
  };
}
