// Moving the old app folder on the first start under the new name, with real
// folders: a fresh install, the move, both folders there, and a move that fails.
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { folderMoveLines, MOVE_PENDING, moveOldFolder, moveOldFolders, OLD_APP_FOLDER } from '../src/folder-move.ts';
import { APP_FOLDER, desktopPaths } from '../src/paths.ts';

let root: string;
const put = (path: string, text = 'x') => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const there = (path: string) => existsSync(join(root, path));
const locked = () => {
  throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quillwarren-move-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the old folder on the first start', () => {
  it('uses the names the app and the bridge use', () => {
    expect(OLD_APP_FOLDER).toBe('Delve');
    expect(APP_FOLDER).toBe('Quillwarren');
    expect(desktopPaths({ appData: root }).userData).toBe(join(root, 'Quillwarren'));
  });

  it('does nothing on a fresh install', () => {
    expect(moveOldFolder(root)).toEqual({ result: 'nothing' });
    expect(readdirSync(root)).toEqual([]);
    expect(folderMoveLines([{ result: 'nothing' }])).toEqual([]);
  });

  it('moves the old folder, everything in it, to the new name', () => {
    put('Delve/data/delve.db', 'the maps');
    put('Delve/claude-desktop.json', '{"app":"Delve"}');
    put('Delve/Local Storage/leveldb/000003.log', 'the theme');
    const m = moveOldFolder(root);
    expect(m).toMatchObject({ result: 'moved', from: join(root, 'Delve'), to: join(root, 'Quillwarren') });
    expect(there('Delve')).toBe(false);
    expect(read('Quillwarren/data/delve.db')).toBe('the maps');
    expect(read('Quillwarren/claude-desktop.json')).toBe('{"app":"Delve"}');
    expect(read('Quillwarren/Local Storage/leveldb/000003.log')).toBe('the theme');
    expect(folderMoveLines([m])[0]).toMatch(/^moved .*Delve to .*Quillwarren$/);
    expect(moveOldFolder(root)).toEqual({ result: 'nothing' }); // the next start
  });

  it('keeps hard-linked models hard-linked', () => {
    put('ollama/blobs/sha256-abc', 'GGUF');
    mkdirSync(join(root, 'Delve/models'), { recursive: true });
    linkSync(join(root, 'ollama/blobs/sha256-abc'), join(root, 'Delve/models/qwen3-8b.gguf'));
    const before = statSync(join(root, 'ollama/blobs/sha256-abc'));
    expect(moveOldFolder(root).result).toBe('moved');
    const after = statSync(join(root, 'Quillwarren/models/qwen3-8b.gguf'));
    expect(after.ino).toBe(before.ino);
    expect(after.nlink).toBe(2);
    expect(statSync(join(root, 'ollama/blobs/sha256-abc')).nlink).toBe(2);
  });

  it('treats an empty new folder as none, in case Electron made it first', () => {
    put('Delve/data/delve.db', 'the maps');
    mkdirSync(join(root, 'Quillwarren'));
    expect(moveOldFolder(root).result).toBe('moved');
    expect(read('Quillwarren/data/delve.db')).toBe('the maps');
  });

  it('leaves both when both are there, and uses the new one', () => {
    put('Delve/data/delve.db', 'old maps');
    put('Quillwarren/data/delve.db', 'new maps');
    const m = moveOldFolder(root);
    expect(m.result).toBe('kept-both');
    expect(read('Delve/data/delve.db')).toBe('old maps');
    expect(read('Quillwarren/data/delve.db')).toBe('new maps');
    expect(folderMoveLines([m])[0]).toContain('using the new one');
  });

  it('touches nothing when the old folder is empty', () => {
    mkdirSync(join(root, 'Delve'));
    put('Quillwarren/data/delve.db', 'new maps');
    expect(moveOldFolder(root)).toEqual({ result: 'nothing' });
    expect(there('Delve')).toBe(true);
    expect(read('Quillwarren/data/delve.db')).toBe('new maps');
  });
});

describe('when the old folder cannot be moved', () => {
  it('leaves it alone, starts fresh and says so', () => {
    put('Delve/data/delve.db', 'the maps');
    const m = moveOldFolder(root, { rename: locked });
    expect(m).toMatchObject({ result: 'failed', error: expect.stringContaining('EBUSY') });
    expect(read('Delve/data/delve.db')).toBe('the maps');
    expect(readdirSync(join(root, 'Quillwarren'))).toEqual([MOVE_PENDING]);
    expect(folderMoveLines([m])[0]).toContain('the next start tries again');
  });

  it('retries on the next start, and keeps what the fresh start made', () => {
    put('Delve/data/delve.db', 'the maps');
    moveOldFolder(root, { rename: locked });
    put('Quillwarren/data/delve.db', 'made while the move was stuck');
    const m = moveOldFolder(root, { now: () => 1234 });
    expect(m).toMatchObject({ result: 'moved', setAside: join(root, 'Quillwarren.fresh-1234') });
    expect(there('Delve')).toBe(false);
    expect(read('Quillwarren/data/delve.db')).toBe('the maps');
    expect(there(`Quillwarren/${MOVE_PENDING}`)).toBe(false);
    expect(read('Quillwarren.fresh-1234/data/delve.db')).toBe('made while the move was stuck');
    expect(folderMoveLines([m])[0]).toContain('Quillwarren.fresh-1234');
    expect(moveOldFolder(root)).toEqual({ result: 'nothing' });
  });

  it('keeps retrying while the old folder stays locked, with nothing moved', () => {
    put('Delve/data/delve.db', 'the maps');
    moveOldFolder(root, { rename: locked });
    put('Quillwarren/data/delve.db', 'fresh');
    expect(moveOldFolder(root, { rename: locked }).result).toBe('failed');
    expect(read('Delve/data/delve.db')).toBe('the maps');
    expect(read('Quillwarren/data/delve.db')).toBe('fresh');
    expect(there(`Quillwarren/${MOVE_PENDING}`)).toBe(true);
    expect(moveOldFolder(root).result).toBe('moved');
    expect(read('Quillwarren/data/delve.db')).toBe('the maps');
  });

  it('puts the fresh folder back when only the old folder is locked', () => {
    put('Delve/data/delve.db', 'the maps');
    moveOldFolder(root, { rename: locked });
    put('Quillwarren/data/delve.db', 'fresh');
    const oldOnly = (from: string, to: string) => {
      if (from === join(root, 'Delve')) locked();
      renameSync(from, to);
    };
    expect(moveOldFolder(root, { rename: oldOnly, now: () => 5 }).result).toBe('failed');
    expect(read('Delve/data/delve.db')).toBe('the maps');
    expect(read('Quillwarren/data/delve.db')).toBe('fresh');
    expect(there(`Quillwarren/${MOVE_PENDING}`)).toBe(true);
    expect(there('Quillwarren.fresh-5')).toBe(false);
  });

  it('forgets the note once the old folder is gone, so a later old folder changes nothing', () => {
    put('Delve/data/delve.db', 'the maps');
    moveOldFolder(root, { rename: locked });
    put('Quillwarren/data/delve.db', 'fresh');
    rmSync(join(root, 'Delve'), { recursive: true });
    expect(moveOldFolder(root)).toEqual({ result: 'nothing' });
    expect(there(`Quillwarren/${MOVE_PENDING}`)).toBe(false);
    put('Delve/window-state.json', '{}'); // the old app started once more
    expect(moveOldFolder(root).result).toBe('kept-both');
    expect(read('Quillwarren/data/delve.db')).toBe('fresh');
  });

  it('stays calm when even the note can’t be written: a real refusal from the file system', () => {
    if (process.getuid?.() === 0) return; // root ignores the permission
    put('Delve/data/delve.db', 'the maps');
    chmodSync(root, 0o555);
    try {
      expect(moveOldFolder(root).result).toBe('failed');
      expect(read('Delve/data/delve.db')).toBe('the maps');
    } finally {
      chmodSync(root, 0o755);
    }
  });

  it('decides APPDATA and LOCALAPPDATA each on its own', () => {
    put('roaming/Delve/data/delve.db', 'the maps');
    put('local/Delve/models/a.gguf', 'GGUF');
    const roaming = join(root, 'roaming');
    const local = join(root, 'local');
    const rename = (from: string, to: string) => {
      if (from.startsWith(roaming)) locked();
      renameSync(from, to);
    };
    const moves = moveOldFolders({ appData: roaming, localAppData: local }, { rename });
    expect(moves.map((m) => m.result)).toEqual(['failed', 'moved']);
    expect(read('roaming/Delve/data/delve.db')).toBe('the maps');
    expect(read('local/Quillwarren/models/a.gguf')).toBe('GGUF');
    expect(moveOldFolders({ appData: roaming, localAppData: local }).map((m) => m.result)).toEqual(['moved', 'nothing']);
    expect(read('roaming/Quillwarren/data/delve.db')).toBe('the maps');
    expect(moveOldFolders({ appData: roaming }).map((m) => m.result)).toEqual(['nothing']);
  });
});
