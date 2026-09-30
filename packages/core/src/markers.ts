// GM markers: coloured badges pinned to a spot, each with a note for the GM.
// "?" something to discover, "!" something to interact with, a skull for a
// trap. They only exist in the GM view, and can be struck through when done.
import type { Marker, MarkerKind } from './schema.ts';

export interface MarkerInfo {
  /** Short word for text descriptions. */
  symbol: string;
  name: string;
  color: string;
}

export const MARKERS: Record<MarkerKind, MarkerInfo> = {
  discover: { symbol: '?', name: 'Something to discover', color: '#D9961A' },
  interact: { symbol: '!', name: 'Something to interact with', color: '#2F7FD1' },
  trap: { symbol: 'trap', name: 'A trap', color: '#C43A2F' },
};

/** Badge radius in squares. */
export const MARKER_RADIUS = 0.34;

/**
 * A marker badge as SVG, centred on 0,0 with radius 1 (scale it to size).
 * Own artwork, drawn as paths so it looks the same in every export.
 */
export function markerGlyph(kind: MarkerKind, done = false): string {
  const c = MARKERS[kind].color;
  const glyph =
    kind === 'discover'
      ? `<path d="M-0.34 -0.26C-0.34 -0.74 0.36 -0.74 0.36 -0.28C0.36 -0.02 0 0 0 0.24" fill="none" stroke="#FFFFFF" stroke-width="0.24" stroke-linecap="round" stroke-linejoin="round"/><circle cy="0.55" r="0.14" fill="#FFFFFF"/>`
      : kind === 'interact'
        ? `<path d="M0 -0.6V0.16" stroke="#FFFFFF" stroke-width="0.27" stroke-linecap="round"/><circle cy="0.52" r="0.15" fill="#FFFFFF"/>`
        : `<path d="M0 -0.66C-0.4 -0.66 -0.6 -0.38 -0.6 -0.1C-0.6 0.13 -0.48 0.27 -0.33 0.34V0.6H0.33V0.34C0.48 0.27 0.6 0.13 0.6 -0.1C0.6 -0.38 0.4 -0.66 0 -0.66Z" fill="#FFFFFF"/>` +
          `<circle cx="-0.23" cy="-0.1" r="0.15" fill="${c}"/><circle cx="0.23" cy="-0.1" r="0.15" fill="${c}"/><path d="M0 0.08L-0.08 0.24H0.08Z" fill="${c}"/>` +
          `<path d="M-0.12 0.43V0.6M0.12 0.43V0.6" stroke="${c}" stroke-width="0.07"/>`;
  const badge = `<circle r="1.08" fill="none" stroke="#000000" stroke-opacity="0.35" stroke-width="0.08"/><circle r="1" fill="${c}" stroke="#FFFFFF" stroke-width="0.14"/>${glyph}`;
  if (!done) return badge;
  // done: the badge fades and a line strikes through it
  return `<g opacity="0.5">${badge}</g><path d="M-1.3 0.42L1.3 -0.42" stroke="#FFFFFF" stroke-width="0.4" stroke-linecap="round"/><path d="M-1.3 0.42L1.3 -0.42" stroke="#1B1F24" stroke-width="0.2" stroke-linecap="round"/>`;
}

/** The topmost marker under p (within its badge, plus `tol` squares), if any. */
export function markerAt(objects: readonly { type: string }[], p: readonly [number, number], tol = 0): Marker | null {
  let best: Marker | null = null;
  let bd = Infinity;
  for (const o of objects) {
    if (o.type !== 'marker') continue;
    const m = o as Marker;
    const d = Math.hypot(m.at[0] - p[0], m.at[1] - p[1]);
    if (d <= MARKER_RADIUS + tol && d <= bd) {
      bd = d;
      best = m;
    }
  }
  return best;
}
