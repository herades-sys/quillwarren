// Automatic updates, prepared and switched off. electron-updater checks a
// release host for a newer installer, downloads it in the background and
// installs it when the app quits. There is no public release host yet (the
// GitHub repository is private, so its releases can't serve updates without a
// token, which must never ship in the app), so UPDATE_URL is empty and nothing
// is ever contacted. To switch it on: publish the installer, latest.yml and the
// .blockmap to an HTTPS host (a public GitHub release or any static host), set
// UPDATE_URL (and electron-builder's `publish` to the same place), and sign the
// installer: electron-updater checks the signature of what it downloads
// against the running app's publisher. See docs/DESKTOP.md, "Updates".
import type { LogFile } from './logs.ts';

/** The update feed (electron-builder's "generic" provider: a folder with latest.yml). Empty: updates are off. */
export const UPDATE_URL = '';

export async function setUpUpdates(o: { packaged: boolean; log: LogFile }): Promise<void> {
  if (!UPDATE_URL || !o.packaged) {
    o.log.line('updates: off (no release host yet)');
    return;
  }
  const { autoUpdater } = await import('electron-updater');
  autoUpdater.logger = { info: (m: unknown) => o.log.line(`updates: ${String(m)}`), warn: (m: unknown) => o.log.line(`updates: ${String(m)}`), error: (m: unknown) => o.log.line(`updates: ${String(m)}`), debug: () => {} };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_URL });
  try {
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (e) {
    o.log.line(`updates: check failed: ${(e as Error).message}`);
  }
}
