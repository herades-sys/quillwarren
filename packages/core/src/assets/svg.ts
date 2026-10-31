// Asset SVGs (props and terrain tiles from delve-props-design-system) end up
// inline in map pictures, so they are rebuilt from a whitelist: plain shapes
// only, safe attributes only, and only the three inks, which the renderer then
// swaps per map style. Colour props may use the Delve palette's exact colours
// instead (assets/colour.ts), and hidden ones a dash pattern for their GM
// outline. Metadata, text, scripts, event handlers and links are dropped. Pure
// string work: runs in the browser and on the server.
import { COLOUR_HEX, nearestPaletteColour } from './colour.ts';

/** The literal colours an asset may use. */
export const INKS = { ink: '#000000', paper: '#FFFFFF', shade: '#999999' } as const;

/** What the whitelist allows beyond the ink rules: the asset's catalog entry decides (assetInfo). */
export interface ParseOptions {
  /** 'colour': the Delve palette instead of the three inks. */
  palette?: 'colour';
  /** A hidden colour prop: stroke-dasharray is allowed (its GM outline). */
  hidden?: boolean;
}

export interface Palette {
  ink: string;
  paper: string;
  shade: string;
}

export interface ParsedAsset {
  /** Footprint in grid squares (the viewBox is 100 units per square). */
  w: number;
  h: number;
  /** Inner markup in asset units, ready to wrap in a <g>. */
  body: string;
  /** What had to be fixed or dropped. Empty for a clean file. */
  problems: string[];
}

const ELEMENTS = new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const DROP_WITH_CONTENT = ['metadata', 'title', 'desc', 'style', 'script', 'text', 'foreignObject', 'defs', 'a'];

const NUM = /^\s*-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;
const numeric = (v: string) => (NUM.test(v) ? v.trim() : null);
const oneOf = (...ok: string[]) => (v: string) => (ok.includes(v.trim()) ? v.trim() : null);

/** Snap any colour to the nearest ink, so a stray value can't leak through the per-style swap. */
function colour(v: string, problems: string[]): string | null {
  const s = v.trim();
  if (s === 'none') return 'none';
  const up = s.toUpperCase();
  if (up === INKS.ink || up === INKS.paper || up === INKS.shade) return up;
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(s);
  if (!m) {
    problems.push(`colour ${JSON.stringify(s)} replaced by ink`);
    return INKS.ink;
  }
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  const snapped = lum < 85 ? INKS.ink : lum > 204 ? INKS.paper : INKS.shade;
  problems.push(`colour ${s} snapped to ${snapped}`);
  return snapped;
}

/** A colour prop's colours: the palette's exact values, anything else snapped to the nearest palette colour. */
function paletteColour(v: string, problems: string[]): string | null {
  const s = v.trim();
  if (s === 'none') return 'none';
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(s);
  if (!m) {
    problems.push(`colour ${JSON.stringify(s)} replaced by ink`);
    return INKS.ink;
  }
  const hex = `#${m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!}`.toUpperCase();
  if (COLOUR_HEX.has(hex)) return hex;
  const snapped = nearestPaletteColour(hex);
  problems.push(`colour ${s} snapped to ${snapped}`);
  return snapped;
}

/** A dash pattern: a few plain numbers. */
const dashes = (v: string) => (/^\s*(\d+\.?\d*|\.\d+)([\s,]+(\d+\.?\d*|\.\d+)){0,7}\s*$/.test(v) ? v.trim().replace(/[\s,]+/g, ' ') : null);

const ATTRS: Record<string, (v: string, problems: string[]) => string | null> = {
  d: (v) => (/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]*$/.test(v) ? v.trim() : null),
  points: (v) => (/^[0-9eE.,\s+-]*$/.test(v) ? v.trim() : null),
  x: numeric,
  y: numeric,
  width: numeric,
  height: numeric,
  cx: numeric,
  cy: numeric,
  r: numeric,
  rx: numeric,
  ry: numeric,
  x1: numeric,
  y1: numeric,
  x2: numeric,
  y2: numeric,
  'stroke-width': numeric,
  fill: colour,
  stroke: colour,
  'stroke-linecap': oneOf('round', 'butt', 'square'),
  'stroke-linejoin': oneOf('round', 'miter', 'bevel'),
  'fill-rule': oneOf('evenodd', 'nonzero'),
  transform: (v) => (/^(\s*(translate|rotate|scale)\(\s*[-0-9.eE,\s]+\)\s*)+$/.test(v) ? v.trim() : null),
};

const attrRe = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(attrRe)) out.set(m[1]!, m[2] ?? m[3] ?? '');
  return out;
}

/** Colour props: the same checks, with palette colours, and dash patterns on hidden ones. */
const COLOUR_ATTRS: Record<string, (v: string, problems: string[]) => string | null> = { ...ATTRS, fill: paletteColour, stroke: paletteColour, 'stroke-miterlimit': numeric };
const HIDDEN_ATTRS: Record<string, (v: string, problems: string[]) => string | null> = { ...COLOUR_ATTRS, 'stroke-dasharray': dashes };

export function parseAssetSvg(text: string, opts: ParseOptions = {}): ParsedAsset {
  const allowed = opts.palette === 'colour' ? (opts.hidden ? HIDDEN_ATTRS : COLOUR_ATTRS) : ATTRS;
  const problems: string[] = [];
  let src = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<\?[\s\S]*?\?>/g, '');
  for (const tag of DROP_WITH_CONTENT) {
    const re = new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}\\s*>)`, 'gi');
    src = src.replace(re, () => {
      if (tag !== 'metadata') problems.push(`<${tag}> dropped`);
      return '';
    });
  }

  let w = 0;
  let h = 0;
  let depth = 0;
  let body = '';
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;
  for (const m of src.matchAll(tagRe)) {
    const [, closing, name, raw, selfClosing] = m;
    const tag = name!;
    if (tag === 'svg') {
      if (closing) continue;
      const a = attributes(raw!);
      const vb = (a.get('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb.every(Number.isFinite)) {
        if (vb[0] !== 0 || vb[1] !== 0) problems.push('viewBox should start at 0 0');
        w = vb[2]! / 100;
        h = vb[3]! / 100;
      } else {
        w = Number(a.get('width')) / 100 || 0;
        h = Number(a.get('height')) / 100 || 0;
        problems.push('no viewBox');
      }
      continue;
    }
    if (!ELEMENTS.has(tag)) {
      if (!closing) problems.push(`<${tag}> dropped`);
      continue;
    }
    if (tag === 'g') {
      if (closing) {
        if (depth > 0) {
          body += '</g>';
          depth--;
        }
        continue;
      }
    } else if (closing) continue; // shapes are always written self-closing
    const kept: string[] = [];
    for (const [k, v] of attributes(raw!)) {
      const check = allowed[k];
      if (!check) {
        if (!k.startsWith('xmlns')) problems.push(`${tag} ${k}= dropped`);
        continue;
      }
      const ok = check(v, problems);
      if (ok === null) problems.push(`${tag} ${k}=${JSON.stringify(v.slice(0, 40))} dropped`);
      else kept.push(`${k}="${ok}"`);
    }
    const attrs = kept.length ? ` ${kept.join(' ')}` : '';
    if (tag === 'g' && !selfClosing) {
      body += `<g${attrs}>`;
      depth++;
    } else if (tag !== 'g') body += `<${tag}${attrs}/>`;
  }
  body += '</g>'.repeat(depth);
  if (!(w > 0 && h > 0)) problems.push('no usable size');
  return { w, h, body, problems: [...new Set(problems)] };
}

/** A style colour as it goes into the art, escaped: a map saved before style overrides were checked may hold anything (a hex colour comes out unchanged). */
const inkValue = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Swap the three inks for a style's colours. */
export function recolor(body: string, p: Palette): string {
  return body.replace(/#000000|#FFFFFF|#999999/g, (c) => inkValue(c === INKS.ink ? p.ink : c === INKS.paper ? p.paper : p.shade));
}

/** A standalone SVG for a parsed asset, in its original inks (thumbnails, downloads). */
export function assetSvg(a: Pick<ParsedAsset, 'w' | 'h' | 'body'>): string {
  const W = Math.round(a.w * 100);
  const H = Math.round(a.h * 100);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${a.body}</svg>`;
}
