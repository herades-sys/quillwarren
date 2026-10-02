// "Respect heights" (docs/TABLE.md, "Heights and movement"): on a page with it on,
// a player's move may not cross a cliff edge of the Delve map's height areas
// where no stairs or ladder cross it, nor a wall or a shut door. The GM is never
// held back. A move is checked as the straight line from the token's centre to
// where its centre lands (like dragging it there), so a player walks round a
// corner in two moves. Pure: can() in rules.ts asks moveRefusal.
import type { Page, PageCliff, Token } from './protocol.ts';
import { doorIsOpen } from './sight.ts';

type Pt = readonly [number, number];

export interface MoveBlocker {
  a: Pt;
  b: Pt;
  why: 'cliff' | 'wall' | 'door';
  /** A cliff's drop, in the page's units. */
  drop?: number;
}

const near = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const sameSeg = (s: readonly [Pt, Pt], a: Pt, b: Pt) => (near(s[0], a) && near(s[1], b)) || (near(s[0], b) && near(s[1], a));

/** Is "Respect heights" on for this page? Off unless the GM turned it on. */
export const respectsHeights = (page: Pick<Page, 'respectHeights'> | null | undefined): boolean => page?.respectHeights === true;

/**
 * What stops a player's move on a page: its cliffs, its walls (secret doors
 * are in them, shut, until the GM opens one) and every door the table has shut
 * (a portcullis too: you see through it, you don't walk through it). Archways
 * are always open.
 */
export function moveBlockersOf(page: Pick<Page, 'walls' | 'doors' | 'doorState' | 'cliffs'>): MoveBlocker[] {
  const doors = page.doors ?? [];
  const openSecret = doors.filter((d) => d.style === 'secret' && doorIsOpen(page, d));
  const out: MoveBlocker[] = [];
  for (const w of page.walls ?? []) if (!openSecret.some((d) => sameSeg(w, d.a, d.b))) out.push({ a: w[0], b: w[1], why: 'wall' });
  for (const d of doors) if (d.style !== 'secret' && d.style !== 'archway' && !doorIsOpen(page, d)) out.push({ a: d.a, b: d.b, why: 'door' });
  for (const c of page.cliffs ?? []) out.push({ a: c.a, b: c.b, why: 'cliff', drop: c.drop });
  return out;
}

/** Where along p0 → p1 (0..1) it crosses a → b, or null. Touching the line where the move starts doesn't count; landing on it does. */
export function crossingAt(p0: Pt, p1: Pt, a: Pt, b: Pt): number | null {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-12) return null; // along the line, or parallel to it
  const t = ((a[0] - p0[0]) * ey - (a[1] - p0[1]) * ex) / den;
  const u = ((a[0] - p0[0]) * dy - (a[1] - p0[1]) * dx) / den;
  return t > 1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? t : null;
}

/** The first thing a move from one centre to another runs into, or null. */
export function firstBlocker(blockers: readonly MoveBlocker[], from: Pt, to: Pt): MoveBlocker | null {
  let best: { b: MoveBlocker; t: number } | null = null;
  for (const b of blockers) {
    const t = crossingAt(from, to, b.a, b.b);
    if (t !== null && (!best || t < best.t)) best = { b, t };
  }
  return best?.b ?? null;
}

const unitOf = (page: Pick<Page, 'cellUnit'>): string => /[A-Za-z]+/.exec(page.cellUnit ?? '')?.[0] ?? 'ft';
const fmt = (v: number) => String(Math.round(v * 100) / 100);

/** Why moving the token's top-left corner to (x, y) isn't allowed on this page, or null when it is (or the page doesn't respect heights). */
export function moveRefusal(page: Page | undefined, token: Pick<Token, 'x' | 'y' | 'w' | 'h'>, x: number, y: number): string | null {
  if (!page || !respectsHeights(page)) return null;
  if (x === token.x && y === token.y) return null;
  const from: Pt = [token.x + token.w / 2, token.y + token.h / 2];
  const to: Pt = [x + token.w / 2, y + token.h / 2];
  const hit = firstBlocker(moveBlockersOf(page), from, to);
  if (!hit) return null;
  if (hit.why === 'cliff') {
    const drop = hit.drop ? `a ${fmt(hit.drop)} ${unitOf(page)} drop` : 'a drop';
    return `That move goes over a cliff edge (${drop}): take the stairs or a ladder, or ask the GM`;
  }
  return hit.why === 'door' ? 'That move goes through a shut door' : 'That move goes through a wall';
}

/** A cliff of a page, checked (rules.ts pagePatch). */
export function isCliff(v: unknown): v is PageCliff {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  const pt = (p: unknown) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100000);
  return pt(c.a) && pt(c.b) && typeof c.drop === 'number' && Number.isFinite(c.drop) && Object.keys(c).every((k) => k === 'a' || k === 'b' || k === 'drop');
}
