// Feature requests from /feedback: one text file, ${DELVE_DATA}/feature-requests.txt,
// that the form only ever appends to. One block per request, numbered in order:
//
//   ==== #12 · 2026-10-03 21:40 · Feature idea · from Robin (GM) · about /maps/map_x
//   Title: Legend on the 3D view
//   <the description, line breaks as typed>
//   <an empty line>
//
// A block goes in with one write (O_APPEND), then fsync; a failed write is cut back
// off, so the file only ever holds whole blocks. Typed text is cleaned before it gets
// there: no control or bidi characters, one-line fields on one line, and no line of a
// description can pass for a block's header.
import { closeSync, fstatSync, fsyncSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const KINDS = { idea: 'Feature idea', bug: 'Problem / bug', other: 'Other' } as const;
export type Kind = keyof typeof KINDS;
export const isKind = (v: unknown): v is Kind => typeof v === 'string' && Object.hasOwn(KINDS, v);

/** Longest texts, in characters (as the browser's maxlength counts them). */
export const MAX = { title: 120, description: 4000, about: 200, name: 60 } as const;

export const FILE_NAME = 'feature-requests.txt';

const HEADER = /^==== #(\d+) · (.*)$/;
const LINE_BREAKS = /\r\n?|[\u0085\p{Zl}\p{Zp}]/gu;
/** Controls (C0 but tab and line feed, DEL, C1) and the bidi marks and overrides that make text read other than it is. */
const CONTROLS = /(?![\t\n])[\p{Cc}\p{Bidi_Control}]/gu;

/** A one-line field: controls gone, any run of white space (line breaks too) one space, trimmed. */
export function cleanLine(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(LINE_BREAKS, '\n').replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
}

/** A description as typed: line breaks kept (as \n), tabs as two spaces, controls gone, no trailing spaces, at most one empty line in a row, none at either end. */
export function cleanText(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v
    .replace(LINE_BREAKS, '\n')
    .replace(/\t/g, '  ')
    .replace(CONTROLS, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/** "2026-10-03 21:40" in the server's time zone. */
export function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface NewRequest {
  kind: Kind;
  title: string;
  description: string;
  /** The map or page it is about (may be empty). */
  about: string;
  /** Who sent it, as checked by the server (routes.ts senderLabel). */
  from: string;
  at: number;
}

/** One request as its block of text. A description line starting with "====" gets a space in front. */
export function formatBlock(n: number, r: NewRequest): string {
  const head = [`==== #${n}`, stamp(r.at), KINDS[r.kind], `from ${r.from}`, ...(r.about ? [`about ${r.about}`] : [])].join(' · ');
  return `${head}\nTitle: ${r.title}\n${r.description.replace(/^(?=={4})/gm, ' ')}\n\n`;
}

export interface Entry {
  n: number;
  /** The header after "#n · ": time, kind, from, about. */
  head: string;
  /** The kind's label, if the header has a known one. */
  kind: string;
  title: string;
  description: string;
}

/** The blocks of a requests file, oldest first. Anything before the first header is skipped. */
export function parseRequests(text: string): Entry[] {
  const out: Entry[] = [];
  let cur: (Entry & { lines: string[] }) | null = null;
  const done = () => {
    if (!cur) return;
    const { lines, ...e } = cur;
    if (lines[0]?.startsWith('Title: ')) e.title = lines.shift()!.slice(7);
    out.push({ ...e, description: lines.join('\n').replace(/\n+$/, '') });
  };
  for (const line of text.split('\n')) {
    const m = HEADER.exec(line);
    if (m) {
      done();
      const kind = m[2]!.split(' · ')[1] ?? '';
      cur = { n: Number(m[1]), head: m[2]!, kind: Object.values(KINDS).includes(kind as never) ? kind : '', title: '', description: '', lines: [] };
    } else cur?.lines.push(line);
  }
  done();
  return out;
}

/** The highest request number in a file (0 when there is none). */
const lastNumber = (text: string): number => parseRequests(text).reduce((max, e) => Math.max(max, e.n), 0);

export interface Summary {
  count: number;
  /** The newest few, newest first. */
  latest: Entry[];
}

export class FeedbackLog {
  private readonly file: string | undefined;
  private temp: string | null = null;
  /** The file as we last left it: its size, its highest number, and whether it ends with a line break. */
  private known: { size: number; last: number; clean: boolean } | null = null;

  /** `file` undefined: a temporary file (tests), made on the first request and removed by close(). */
  constructor(file: string | undefined) {
    this.file = file;
  }

  get path(): string {
    if (this.file) return this.file;
    this.temp ??= mkdtempSync(join(tmpdir(), 'delve-feedback-'));
    return join(this.temp, FILE_NAME);
  }

  /** The whole file, '' before the first request. */
  read(): string {
    if (!this.file && !this.temp) return '';
    try {
      return readFileSync(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw e;
    }
  }

  summary(newest = 5): Summary {
    const all = parseRequests(this.read());
    return { count: all.length, latest: all.slice(-newest).reverse() };
  }

  /** Adds one request at the end of the file (made if missing) and returns its number. */
  append(r: NewRequest): number {
    const fd = openSync(this.path, 'a', 0o640);
    try {
      const size = fstatSync(fd).size;
      // first use, or someone edited the file by hand: look again
      if (this.known?.size !== size) {
        const text = this.read();
        this.known = { size, last: lastNumber(text), clean: text === '' || text.endsWith('\n') };
      }
      const n = this.known.last + 1;
      const bytes = Buffer.from(`${this.known.clean ? '' : '\n'}${formatBlock(n, r)}`, 'utf8');
      try {
        let done = 0;
        while (done < bytes.length) done += writeSync(fd, bytes, done);
        fsyncSync(fd);
      } catch (e) {
        // a disk that filled up halfway: leave no half block behind
        ftruncateSync(fd, size);
        this.known = null;
        throw e;
      }
      this.known = { size: size + bytes.length, last: n, clean: true };
      return n;
    } finally {
      closeSync(fd);
    }
  }

  close(): void {
    if (this.temp) rmSync(this.temp, { recursive: true, force: true });
  }
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * At most `perPerson` requests per person in any hour, and `perDay` from
 * everyone together in any 24 hours. Kept in memory: a restart starts afresh.
 */
export class SendLimits {
  private readonly people = new Map<string, number[]>();
  private all: number[] = [];
  readonly perPerson: number;
  readonly perDay: number;

  constructor(perPerson = 5, perDay = 50) {
    this.perPerson = perPerson;
    this.perDay = perDay;
  }

  /** Why a request from `key` would be refused now, or null if it may go in. */
  check(key: string, now = Date.now()): 'person' | 'day' | null {
    this.prune(now);
    if ((this.people.get(key)?.length ?? 0) >= this.perPerson) return 'person';
    if (this.all.length >= this.perDay) return 'day';
    return null;
  }

  note(key: string, now = Date.now()): void {
    this.people.set(key, [...(this.people.get(key) ?? []), now]);
    this.all.push(now);
  }

  private prune(now: number): void {
    this.all = this.all.filter((t) => t > now - DAY);
    for (const [key, times] of this.people) {
      const left = times.filter((t) => t > now - HOUR);
      if (left.length) this.people.set(key, left);
      else this.people.delete(key);
    }
  }
}
