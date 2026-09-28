// Map storage on node:sqlite. Each map keeps its current document and a row
// per revision (the ops applied and their exact inverse), which gives a
// linear undo/redo history per map.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { applyOps, validateMap, type DelveMap, type Op } from '@delve/core';

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`no map with id "${id}"`);
    this.name = 'NotFoundError';
  }
}
export class StaleError extends Error {
  readonly rev: number;
  constructor(rev: number, baseRev: number) {
    super(`the map is at rev ${rev}, not ${baseRev}; fetch it again and retry`);
    this.name = 'StaleError';
    this.rev = rev;
  }
}
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export type ChangeKind = 'create' | 'ops' | 'undo' | 'redo';

export interface Change {
  mapId: string;
  rev: number;
  kind: ChangeKind;
  by: string;
  /** The ops that turned rev-1 into rev (for undo: the inverse that was applied). */
  ops: Op[];
  map: DelveMap;
}

export interface MapSummary {
  id: string;
  name: string;
  rev: number;
  objects: number;
  created: string;
  updated: string;
}

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS maps (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  rev     INTEGER NOT NULL,
  doc     TEXT NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  deleted TEXT
);
CREATE TABLE IF NOT EXISTS revisions (
  map_id    TEXT NOT NULL,
  rev       INTEGER NOT NULL,
  at        TEXT NOT NULL,
  by        TEXT NOT NULL,
  kind      TEXT NOT NULL,
  ops       TEXT NOT NULL,
  inverse   TEXT NOT NULL,
  -- undo bookkeeping for kind='ops': active, undone (redo possible), dead
  state     TEXT NOT NULL DEFAULT 'active',
  undone_by INTEGER,
  PRIMARY KEY (map_id, rev)
);
`;

export function newMapId(): string {
  return `map_${randomBytes(6).toString('hex')}`;
}

export class MapStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private row(id: string): { rev: number; map: DelveMap } {
    const r = this.db.prepare('SELECT rev, doc FROM maps WHERE id = ? AND deleted IS NULL').get(id) as Row | undefined;
    if (!r) throw new NotFoundError(id);
    return { rev: Number(r.rev), map: JSON.parse(String(r.doc)) as DelveMap };
  }

  list(): MapSummary[] {
    const rows = this.db
      .prepare('SELECT id, name, rev, doc, created, updated FROM maps WHERE deleted IS NULL ORDER BY updated DESC')
      .all() as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      rev: Number(r.rev),
      objects: (JSON.parse(String(r.doc)) as DelveMap).objects.length,
      created: String(r.created),
      updated: String(r.updated),
    }));
  }

  get(id: string): { rev: number; map: DelveMap } {
    return this.row(id);
  }

  create(input: unknown, by: string): Change {
    const map = validateMap(input);
    const now = new Date().toISOString();
    return this.tx(() => {
      const taken = this.db.prepare('SELECT deleted FROM maps WHERE id = ?').get(map.id) as Row | undefined;
      if (taken) {
        throw new ConflictError(
          taken.deleted ? `id "${map.id}" belonged to a deleted map; pick another id` : `a map with id "${map.id}" already exists`,
        );
      }
      this.db
        .prepare('INSERT INTO maps (id, name, rev, doc, created, updated) VALUES (?, ?, 1, ?, ?, ?)')
        .run(map.id, map.name, JSON.stringify(map), now, now);
      this.db
        .prepare("INSERT INTO revisions (map_id, rev, at, by, kind, ops, inverse, state) VALUES (?, 1, ?, ?, 'create', '[]', '[]', 'dead')")
        .run(map.id, now, by);
      return { mapId: map.id, rev: 1, kind: 'create', by, ops: [], map };
    });
  }

  private commit(id: string, from: { rev: number; map: DelveMap }, ops: Op[], by: string, kind: ChangeKind): Change & { inverse: Op[] } {
    const { map, inverse } = applyOps(from.map, ops);
    const rev = from.rev + 1;
    const now = new Date().toISOString();
    this.db.prepare('UPDATE maps SET rev = ?, name = ?, doc = ?, updated = ? WHERE id = ?').run(rev, map.name, JSON.stringify(map), now, id);
    this.db
      .prepare('INSERT INTO revisions (map_id, rev, at, by, kind, ops, inverse, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, rev, now, by, kind, JSON.stringify(ops), JSON.stringify(inverse), kind === 'ops' ? 'active' : 'dead');
    return { mapId: id, rev, kind, by, ops, map, inverse };
  }

  /** Apply a batch as one revision (one undo step). baseRev, if given, must match. */
  apply(id: string, ops: Op[], opts: { baseRev?: number; by: string }): Change {
    return this.tx(() => {
      const cur = this.row(id);
      if (opts.baseRev !== undefined && opts.baseRev !== cur.rev) throw new StaleError(cur.rev, opts.baseRev);
      const change = this.commit(id, cur, ops, opts.by, 'ops');
      // a new change ends any redo chain
      this.db.prepare("UPDATE revisions SET state = 'dead' WHERE map_id = ? AND state = 'undone'").run(id);
      return change;
    });
  }

  undo(id: string, by: string): Change {
    return this.tx(() => {
      const cur = this.row(id);
      const target = this.db
        .prepare("SELECT rev, inverse FROM revisions WHERE map_id = ? AND kind = 'ops' AND state = 'active' ORDER BY rev DESC LIMIT 1")
        .get(id) as Row | undefined;
      if (!target) throw new ConflictError('nothing to undo');
      const change = this.commit(id, cur, JSON.parse(String(target.inverse)) as Op[], by, 'undo');
      this.db.prepare("UPDATE revisions SET state = 'undone', undone_by = ? WHERE map_id = ? AND rev = ?").run(change.rev, id, Number(target.rev));
      return change;
    });
  }

  redo(id: string, by: string): Change {
    return this.tx(() => {
      const cur = this.row(id);
      const target = this.db
        .prepare("SELECT rev, ops FROM revisions WHERE map_id = ? AND state = 'undone' ORDER BY undone_by DESC LIMIT 1")
        .get(id) as Row | undefined;
      if (!target) throw new ConflictError('nothing to redo');
      const change = this.commit(id, cur, JSON.parse(String(target.ops)) as Op[], by, 'redo');
      // the original change is live again, with a fresh inverse matching the current document
      this.db
        .prepare("UPDATE revisions SET state = 'active', undone_by = NULL, inverse = ? WHERE map_id = ? AND rev = ?")
        .run(JSON.stringify(change.inverse), id, Number(target.rev));
      return change;
    });
  }

  /** Soft delete: the map disappears from the API but stays in the database file. */
  delete(id: string): void {
    this.tx(() => {
      this.row(id);
      this.db.prepare('UPDATE maps SET deleted = ? WHERE id = ?').run(new Date().toISOString(), id);
    });
  }

  history(id: string, limit = 50): { rev: number; at: string; by: string; kind: string; ops: number; state: string }[] {
    this.row(id);
    const rows = this.db
      .prepare('SELECT rev, at, by, kind, ops, state FROM revisions WHERE map_id = ? ORDER BY rev DESC LIMIT ?')
      .all(id, limit) as Row[];
    return rows.map((r) => ({
      rev: Number(r.rev),
      at: String(r.at),
      by: String(r.by),
      kind: String(r.kind),
      ops: (JSON.parse(String(r.ops)) as unknown[]).length,
      state: String(r.state),
    }));
  }
}
