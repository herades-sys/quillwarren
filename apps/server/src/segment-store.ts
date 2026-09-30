// Saved segments (a piece of a map to place again or tile over an area) in
// delve.db, next to the maps. MapStore creates one on its own database, so
// segments live in the same file and the same backups.
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { segmentCounts, type MapObject, type MapSegment, type SegmentContent } from '@delve/core';

export interface SegmentSummary {
  id: string;
  name: string;
  size: [number, number];
  /** Objects by type, e.g. {room: 5, corridor: 4, prop: 20}. */
  counts: Record<string, number>;
  created: string;
  updated: string;
  /** The map it was saved from. */
  source?: string;
}

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS segments (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  doc     TEXT NOT NULL,
  source  TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  deleted TEXT
);
`;

export const newSegmentId = (): string => `seg_${randomBytes(6).toString('hex')}`;

export class SegmentStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  private static summary(r: Row): SegmentSummary {
    const doc = JSON.parse(String(r.doc)) as SegmentContent;
    return {
      id: String(r.id),
      name: String(r.name),
      size: doc.size,
      counts: segmentCounts(doc.objects),
      created: String(r.created),
      updated: String(r.updated),
      ...(r.source ? { source: String(r.source) } : {}),
    };
  }

  /** Newest first. */
  list(): SegmentSummary[] {
    const rows = this.db.prepare('SELECT id, name, doc, source, created, updated FROM segments WHERE deleted IS NULL ORDER BY created DESC, id').all() as Row[];
    return rows.map(SegmentStore.summary);
  }

  /** The segment, or null if there's none with this id. */
  get(id: string): MapSegment | null {
    const r = this.db.prepare('SELECT id, name, doc, created FROM segments WHERE id = ? AND deleted IS NULL').get(id) as Row | undefined;
    if (!r) return null;
    const doc = JSON.parse(String(r.doc)) as SegmentContent;
    return { id: String(r.id), name: String(r.name), created: String(r.created), size: doc.size, objects: doc.objects as MapObject[] };
  }

  /** Find by id, or else by name (ignoring case) when exactly one segment has it. */
  find(idOrName: string): MapSegment | null {
    const byId = this.get(idOrName);
    if (byId) return byId;
    const rows = this.db.prepare('SELECT id FROM segments WHERE deleted IS NULL AND lower(name) = lower(?)').all(idOrName.trim()) as Row[];
    return rows.length === 1 ? this.get(String(rows[0]!.id)) : null;
  }

  create(name: string, content: SegmentContent, source?: string): MapSegment {
    const id = newSegmentId();
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO segments (id, name, doc, source, created, updated) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, JSON.stringify({ size: content.size, objects: content.objects }), source ?? null, now, now);
    return { id, name, created: now, size: content.size, objects: content.objects };
  }

  /** false if there's no such segment. */
  rename(id: string, name: string): boolean {
    const r = this.db.prepare('UPDATE segments SET name = ?, updated = ? WHERE id = ? AND deleted IS NULL').run(name, new Date().toISOString(), id);
    return Number(r.changes) > 0;
  }

  /** Soft delete, like maps: gone from the API, still in the database file. false if there's no such segment. */
  delete(id: string): boolean {
    const r = this.db.prepare('UPDATE segments SET deleted = ? WHERE id = ? AND deleted IS NULL').run(new Date().toISOString(), id);
    return Number(r.changes) > 0;
  }

  summaryOf(id: string): SegmentSummary | null {
    const r = this.db.prepare('SELECT id, name, doc, source, created, updated FROM segments WHERE id = ? AND deleted IS NULL').get(id) as Row | undefined;
    return r ? SegmentStore.summary(r) : null;
  }
}
