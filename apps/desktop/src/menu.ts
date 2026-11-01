// The app's menu bar as data: main.ts builds it with Electron's Menu and says
// what each item does. Pure (no Electron at run time), so it is tested on its
// own (apps/desktop/test/desktop-app.test.ts). The app is one person's editor:
// it has no Quillwarren Table and no players' screen, so neither has a menu item
// (docs/DESKTOP.md, "What the Windows app leaves out"). The Help menu has the
// assistants: the chat's models and Claude Desktop (docs/DESKTOP.md, "Claude
// Desktop").
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  /** Load one of Quillwarren's own pages in the window ("/", "/import/image", "/models"). */
  go(path: string): void;
  openDataFolder(): void;
  quit(): void;
  back(): void;
  forward(): void;
  reload(): void;
  /** The interface size: +0.5 or -0.5 zoom levels, 0 back to normal. */
  zoom(step: number): void;
  toggleFullScreen(): void;
  copyLogs(): void;
  openLogsFolder(): void;
  toggleDevTools(): void;
  openNotices(): void;
  showAbout(): void;
  /** "Connect to Claude Desktop…": explains, turns access on, opens the extension (main.ts). */
  connectClaudeDesktop(): void;
  /** "Disconnect Claude Desktop": revokes the key. */
  disconnectClaudeDesktop(): void;
}

export interface MenuState {
  /** Claude Desktop is connected (claude-desktop.ts). */
  claudeDesktop: boolean;
}

export function menuTemplate(a: MenuActions, state: MenuState = { claudeDesktop: false }): MenuItemConstructorOptions[] {
  // No Edit menu: the editor handles Ctrl Z, Ctrl D, Ctrl 0 itself, and text fields get copy and paste from Windows.
  return [
    {
      label: '&File',
      submenu: [
        { label: 'Library', accelerator: 'Alt+Home', click: () => a.go('/') },
        { label: 'Trace a map picture…', click: () => a.go('/import/image') },
        { type: 'separator' },
        { label: 'Open the data folder', click: () => a.openDataFolder() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Ctrl+Q', click: () => a.quit() },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Back', accelerator: 'Alt+Left', click: () => a.back() },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => a.forward() },
        { label: 'Reload', accelerator: 'F5', click: () => a.reload() },
        { type: 'separator' },
        { label: 'Larger interface', click: () => a.zoom(0.5) },
        { label: 'Smaller interface', click: () => a.zoom(-0.5) },
        { label: 'Normal interface size', click: () => a.zoom(0) },
        { type: 'separator' },
        { label: 'Full screen', accelerator: 'F11', click: () => a.toggleFullScreen() },
      ],
    },
    {
      label: '&Help',
      submenu: [
        // the assistants: a local model for the chat, or Claude in Claude Desktop working on Quillwarren's maps
        { label: 'Models for the chat…', click: () => a.go('/models') },
        { label: state.claudeDesktop ? 'Connect to Claude Desktop again…' : 'Connect to Claude Desktop…', click: () => a.connectClaudeDesktop() },
        { label: 'Disconnect Claude Desktop', enabled: state.claudeDesktop, click: () => a.disconnectClaudeDesktop() },
        { type: 'separator' },
        { label: 'Copy logs', click: () => a.copyLogs() },
        { label: 'Open the logs folder', click: () => a.openLogsFolder() },
        { label: 'Developer tools', click: () => a.toggleDevTools() },
        { type: 'separator' },
        { label: 'Third-party notices', click: () => a.openNotices() },
        { label: 'About Quillwarren', click: () => a.showAbout() },
      ],
    },
  ];
}
