// The app's menu bar as data: main.ts builds it with Electron's Menu and says
// what each item does. Pure (no Electron at run time), so it is tested on its
// own (apps/desktop/test/desktop-app.test.ts). The app is one person's editor:
// it has no Delve Table and no players' screen, so neither has a menu item
// (docs/DESKTOP.md, "What the Windows app leaves out").
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  /** Load one of Delve's own pages in the window ("/", "/import/image", "/models"). */
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
}

export function menuTemplate(a: MenuActions): MenuItemConstructorOptions[] {
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
        { label: 'Models for the chat…', click: () => a.go('/models') },
        { type: 'separator' },
        { label: 'Copy logs', click: () => a.copyLogs() },
        { label: 'Open the logs folder', click: () => a.openLogsFolder() },
        { label: 'Developer tools', click: () => a.toggleDevTools() },
        { type: 'separator' },
        { label: 'Third-party notices', click: () => a.openNotices() },
        { label: 'About Delve', click: () => a.showAbout() },
      ],
    },
  ];
}
