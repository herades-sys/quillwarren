// Handwritten notes on the players' parchment handout (the `inscription`
// object): the inks, the default size, the box a note covers, and its SVG.
// The look is hand-lettered but stays legible: IM FELL English Italic, each
// line tilted a hair and nudged sideways, each word riding a little above or
// below the line, the ink a little lighter or darker per word, with a soft
// halo where it bled into the paper. All of it comes from the seeded RNG (map
// seed + note id), so a note never shifts between renders. Plain SVG text and
// strokes only: no filters (and never feDisplacementMap, which panics resvg).
import type { Bounds } from './geometry/shapes.ts';
import { hashInts, hashString, rng } from './render/rng.ts';
import type { DelveMap, Inscription, InscriptionInk, Point } from './schema.ts';

/** Text height in squares when a note has no size. */
export const INSCRIPTION_SIZE = 0.8;
/** The face: IM FELL English Italic (OFL), shipped in release/fonts and loaded by resvg. */
export const INSCRIPTION_FONT = 'IM FELL English';
/** Each ink's name and colour: iron-gall brown, lamp black, faded sepia and red ochre. */
export const INSCRIPTION_INK: Record<InscriptionInk, { name: string; color: string }> = {
  brown: { name: 'Brown', color: '#4A2A10' },
  black: { name: 'Black', color: '#1B1612' },
  faded: { name: 'Faded', color: '#80664A' },
  red: { name: 'Red', color: '#8E2316' },
};

/** Line height, in text heights. */
const LINE = 1.2;
/** An italic letter's advance, in text heights, on average: enough for picking and outlines. */
const CHAR_W = 0.42;

const n = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return String(r === 0 ? 0 : r);
};
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The note's lines: Windows and old Mac line breaks count as one, tabs as a space. */
export function inscriptionLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').split('\n');
}

/** The random seed a note's wobble comes from: the map's seed (map.seed, or a hash of its id) and the note's id. */
export function inscriptionSeed(mapSeed: number, id: string): number {
  return hashInts(mapSeed, hashString(id));
}

/** The map's own seed, as the renderer uses it. */
export const mapSeedOf = (map: Pick<DelveMap, 'id' | 'seed'>): number => map.seed ?? hashString(map.id);

/** All the map's notes (or only those also on the normal map) as SVG in map squares. */
export function inscriptionsSvg(map: DelveMap, notes: readonly Inscription[] = inscriptionsOf(map)): string {
  const seed = mapSeedOf(map);
  return notes.map((o) => inscriptionSvg(o, inscriptionSeed(seed, o.id))).join('');
}

/** The note's box before it is tilted, in squares: centred on `at`. */
export function inscriptionBox(o: Pick<Inscription, 'text' | 'size'>): { w: number; h: number } {
  const size = o.size ?? INSCRIPTION_SIZE;
  const lines = inscriptionLines(o.text);
  const longest = Math.max(...lines.map((l) => [...l.trim()].length));
  return { w: Math.max(size, longest * size * CHAR_W), h: lines.length * size * LINE };
}

/** What a note covers on the map once tilted, roughly (the letters are estimated): for picking, zooming and segments. */
export function inscriptionBounds(o: Pick<Inscription, 'text' | 'size' | 'at' | 'rotation'>): Bounds {
  const { w, h } = inscriptionBox(o);
  const a = ((o.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(a));
  const sin = Math.abs(Math.sin(a));
  const hw = (w * cos + h * sin) / 2;
  const hh = (w * sin + h * cos) / 2;
  return { x0: o.at[0] - hw, y0: o.at[1] - hh, x1: o.at[0] + hw, y1: o.at[1] + hh };
}

/**
 * Whether a note stays near enough to `area` (map squares) to be drawn: its box,
 * sized for the widest letters, must lie inside the area grown by `slack`
 * squares. resvg panics (and takes the server down) when what a clipped or
 * see-through group holds reaches roughly three times past its picture, so
 * renders leave out notes that wander far off (they'd hardly show anyway).
 */
export function inscriptionNear(o: Pick<Inscription, 'text' | 'size' | 'at' | 'rotation'>, area: Bounds, slack: number): boolean {
  const size = o.size ?? INSCRIPTION_SIZE;
  const lines = inscriptionLines(o.text);
  const longest = Math.max(...lines.map((l) => [...l.trim()].length));
  // capitals and wide letters run up to about 0.75 of the text height; a text height more for the tilt, wobble and halo
  const w = Math.max(size, longest * size * 0.75) + size;
  const h = lines.length * size * LINE + size;
  const a = ((o.rotation ?? 0) * Math.PI) / 180;
  const hw = (w * Math.abs(Math.cos(a)) + h * Math.abs(Math.sin(a))) / 2;
  const hh = (w * Math.abs(Math.sin(a)) + h * Math.abs(Math.cos(a))) / 2;
  const [x, y] = o.at;
  return x - hw >= area.x0 - slack && y - hh >= area.y0 - slack && x + hw <= area.x1 + slack && y + hh <= area.y1 + slack;
}

/**
 * One note as SVG in map squares: a group turned about `at`, one <text> per
 * line, centred, each word a <tspan>. `seed` is inscriptionSeed(mapSeedOf(map), id).
 */
export function inscriptionSvg(o: Inscription, seed: number): string {
  const size = o.size ?? INSCRIPTION_SIZE;
  const ink = INSCRIPTION_INK[o.ink ?? 'brown']?.color ?? INSCRIPTION_INK.brown.color;
  const lines = inscriptionLines(o.text);
  const lh = size * LINE;
  const top = o.at[1] - (lines.length * lh) / 2;
  let body = '';
  lines.forEach((line, i) => {
    const words = line.trim().split(/\s+/).filter(Boolean);
    // every line has its own randomness, so editing one line leaves the others as they were
    const rand = rng(hashInts(seed, i));
    const tilt = (rand() - 0.5) * 1.6;
    const x = o.at[0] + (rand() - 0.5) * 0.12 * size;
    const y = top + lh * (i + 0.5) + size * 0.3;
    if (!words.length) return;
    let prev = 0;
    let drift = 0;
    const spans = words
      .map((word, k) => {
        // a slow drift along the line plus a little jump per word: the pen rides up and down
        drift = drift * 0.55 + (rand() - 0.5) * 0.07 * size;
        const dy = drift + (rand() - 0.5) * 0.045 * size;
        // and the letters come out a touch bigger or smaller, the ink a little darker or lighter
        const grow = 0.96 + rand() * 0.08;
        const span = `<tspan dy="${n(dy - prev)}" font-size="${n(size * grow)}" fill-opacity="${n(0.8 + rand() * 0.18)}">${esc(word)}</tspan>`;
        prev = dy;
        return k ? ` ${span}` : span;
      })
      .join('');
    body += `<text x="${n(x)}" y="${n(y)}" transform="rotate(${n(tilt)} ${n(x)} ${n(y)})">${spans}</text>`;
  });
  if (!body) return '';
  const turn = o.rotation ? ` transform="rotate(${n(o.rotation)} ${n(o.at[0])} ${n(o.at[1])})"` : '';
  // the halo under the letters is the ink that bled into the paper
  return (
    `<g data-inscription="${esc(o.id)}"${turn} font-family="${INSCRIPTION_FONT}, Georgia, serif" font-style="italic" font-size="${n(size)}" text-anchor="middle" ` +
    `fill="${ink}" stroke="${ink}" stroke-opacity="0.2" stroke-width="${n(size * 0.045)}" stroke-linejoin="round" paint-order="stroke">${body}</g>`
  );
}

/** The map's notes in their order on the map; `onMap` keeps only the ones also drawn on the normal map. */
export function inscriptionsOf(map: DelveMap, opts: { onMap?: boolean } = {}): Inscription[] {
  return map.objects.filter((o): o is Inscription => o.type === 'inscription' && (!opts.onMap || Boolean(o.onMap)));
}

/** A short line about a note for describeMap and the chat: where, the ink, the tilt, and whether it is on the map too. */
export function inscriptionText(o: Inscription, where: (p: Point) => string, fmt: (v: number) => string): string {
  const how = [
    INSCRIPTION_INK[o.ink ?? 'brown'].name.toLowerCase() + ' ink',
    o.size !== undefined ? `size ${fmt(o.size)}` : '',
    o.rotation ? `tilted ${fmt(o.rotation)}°` : '',
    o.onMap ? 'also on the map' : 'handout only',
  ].filter(Boolean);
  return `${o.id} at ${fmt(o.at[0])},${fmt(o.at[1])} ${where(o.at)} (${how.join(', ')}): ${JSON.stringify(o.text)}`;
}
