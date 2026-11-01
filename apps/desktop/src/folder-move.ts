// The app was called Delve until 2026-11-01 and kept its things in
// %APPDATA%\Delve and %LOCALAPPDATA%\Delve. The first start under the new name
// moves those folders to the new one, before anything can open it (Electron's
// userData, the single-instance lock). Pure (no Electron), so it is tested on
// its own: apps/desktop/test/folder-move.test.ts.
//
// Only a rename, never a copy: it is instant, and a model hard-linked to
// Ollama's copy stays a hard link. Each folder is decided on its own:
//
//   no old folder                the new one is used, as on any install
//   no new folder (or empty)     the old one is renamed to the new name
//   the rename fails             the old folder stays as it was (the old app is
//                                still running, a file is locked), the app starts
//                                fresh in the new one, and a note in there says so
//   both, with that note         the next start tries again; the fresh folder goes
//                                aside as <new>.fresh-<time>, never deleted
//   both, without the note       both stay, and the new one is used
import { mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_FOLDER } from './paths.ts';

export const OLD_APP_FOLDER = 'Delve';
/** In the new folder: the old one could not be moved, so this one is only a fresh start. */
export const MOVE_PENDING = 'old-folder-not-moved-yet.txt';

export type FolderMove =
  | { result: 'nothing' }
  | { result: 'moved'; from: string; to: string; setAside?: string }
  | { result: 'kept-both'; from: string; to: string }
  | { result: 'failed'; from: string; to: string; error: string };

export interface FolderMoveOptions {
  /** fs.renameSync; the tests pass one that fails, as Windows does on a locked file. */
  rename?: (from: string, to: string) => void;
  now?: () => number;
}

/** The names in a folder; null when it isn't there. */
function list(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

/** Moves <root>\Delve to <root>\Quillwarren if it should. Never throws and never deletes anything of the user's. */
export function moveOldFolder(root: string, o: FolderMoveOptions = {}): FolderMove {
  const rename = o.rename ?? renameSync;
  const from = join(root, OLD_APP_FOLDER);
  const to = join(root, APP_FOLDER);
  const pending = join(to, MOVE_PENDING);
  const inNew = list(to);
  const hasNote = inNew?.includes(MOVE_PENDING) ?? false;
  if (!list(from)?.length) {
    // nothing (left) to bring over, so an old note must not act on a folder the old app makes again later
    if (hasNote) rmSync(pending, { force: true });
    return { result: 'nothing' };
  }
  if (inNew?.length && !hasNote) return { result: 'kept-both', from, to };
  let setAside: string | undefined;
  try {
    if (inNew?.length) {
      setAside = `${to}.fresh-${(o.now ?? Date.now)()}`;
      rename(to, setAside);
    } else if (inNew) {
      rmdirSync(to); // an empty folder, in case Electron made it before this ran: a rename can't replace it on Windows
    }
  } catch (e) {
    return { result: 'failed', from, to, error: (e as Error).message };
  }
  try {
    rename(from, to);
    return { result: 'moved', from, to, ...(setAside ? { setAside } : {}) };
  } catch (e) {
    const error = (e as Error).message;
    try {
      if (setAside) rename(setAside, to);
      else {
        mkdirSync(to, { recursive: true });
        writeFileSync(pending, `${from} could not be moved here (${error}), so this folder started fresh. The next start tries again.\n`);
      }
    } catch {
      // the fresh folder stays aside, or the app starts without the note: nothing is lost either way
    }
    return { result: 'failed', from, to, error };
  }
}

/** APPDATA and LOCALAPPDATA. */
export function moveOldFolders(roots: { appData: string; localAppData?: string | undefined }, o: FolderMoveOptions = {}): FolderMove[] {
  return [roots.appData, ...(roots.localAppData && roots.localAppData !== roots.appData ? [roots.localAppData] : [])].map((root) => moveOldFolder(root, o));
}

/** What main.log says about it (nothing on an ordinary start). */
export function folderMoveLines(moves: readonly FolderMove[]): string[] {
  return moves.flatMap((m) => {
    if (m.result === 'moved') return [`moved ${m.from} to ${m.to}${m.setAside ? `; the fresh start from when the move failed is kept in ${m.setAside}` : ''}`];
    if (m.result === 'kept-both') return [`both ${m.from} and ${m.to} exist: left as they are, using the new one`];
    if (m.result === 'failed') return [`could not move ${m.from} to ${m.to} (${m.error}): it stays as it was, this start uses the new folder, the next start tries again`];
    return [];
  });
}
