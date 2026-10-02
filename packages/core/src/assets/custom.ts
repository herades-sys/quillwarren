// The checks a custom prop's SVG must pass before Delve keeps it (custom props
// are drawn by Claude in the editor's chat, or sent over the API, and shared by
// every GM on the server). Stricter than parseAssetSvg, which quietly fixes the
// design system's files: here anything outside the art rules (docs/ASSETS.md)
// is refused with a list of what to change, so the drawer can fix it and try
// again. What passes is then inked (ink.ts) and cleaned once more. Pure string
// work: runs in the browser and on the server.
import { inkBody, shapeSubpaths, type Pt } from './ink.ts';
import { assetSvg, INKS, parseAssetSvg } from './svg.ts';

/** The SVG as sent. */
export const MAX_PROP_SVG_BYTES = 64 * 1024;
/** The inked result, which has many more points than clean geometry. */
export const MAX_PROP_BODY_BYTES = 192 * 1024;
export const PROP_STROKE_WIDTHS: readonly number[] = [4, 2, 1.5];
/** Footprints from half a square to 6 squares a side, in half squares. */
export const PROP_MIN_SIZE = 0.5;
export const PROP_MAX_SIZE = 6;
/** Units kept clear along each edge (one square is 100 units). */
export const PROP_MARGIN = 4;

export interface PropCheck {
  ok: boolean;
  /** Why it was refused: fix every one and send it again. */
  problems: string[];
  /** Kept anyway, but worth a look (marks in the margin) or done for you (round caps). */
  notes: string[];
  /** The inked, cleaned body in asset units (when ok). */
  body: string;
  w: number;
  h: number;
}

/** Problems with a footprint, empty if it's fine. */
export function checkPropSize(w: unknown, h: unknown): string[] {
  const out: string[] = [];
  for (const [k, v] of [['w', w], ['h', h]] as const) {
    if (typeof v !== 'number' || !Number.isFinite(v)) out.push(`${k}: a number of squares`);
    else if (v < PROP_MIN_SIZE || v > PROP_MAX_SIZE) out.push(`${k}: from ${PROP_MIN_SIZE} to ${PROP_MAX_SIZE} squares, got ${v}`);
    else if (Math.abs(v * 2 - Math.round(v * 2)) > 1e-9) out.push(`${k}: whole or half squares (0.5, 1, 1.5 …), got ${v}`);
  }
  return out;
}

function utf8Bytes(s: string): number {
  let n = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      k++;
    } else n += 3;
  }
  return n;
}

/** Things the art rules forbid outright, checked on the raw text so the message names the rule. */
const FORBIDDEN: [RegExp, string][] = [
  [/<!DOCTYPE|<!ENTITY/i, 'no DOCTYPE or ENTITY declarations'],
  [/<script\b/i, 'no scripts'],
  [/\son[a-z]+\s*=/i, 'no event handlers (onload=, onclick=…)'],
  [/<image\b/i, 'no <image>: draw everything with shapes'],
  [/\b(?:xlink:)?href\s*=/i, 'no links or external references (href)'],
  [/url\s*\(/i, 'no url(…) references'],
  [/javascript:|data:/i, 'no javascript: or data: URLs'],
  [/<use\b/i, 'no <use>: draw each copy'],
  [/<foreignObject\b/i, 'no <foreignObject>'],
  [/<filter\b|\sfilter\s*=/i, 'no filters'],
  [/<(?:linear|radial)Gradient\b|<pattern\b|<mask\b|<clipPath\b|<marker\b|<symbol\b|\smask\s*=|\sclip-path\s*=/i, 'no gradients, patterns, masks, clip paths, markers or symbols'],
  [/<style\b|\sstyle\s*=/i, 'no CSS: use fill, stroke and stroke-width attributes'],
  [/\sclass\s*=/i, 'no class attributes'],
  [/opacity\s*=/i, 'no opacity: use the shade ink #999999 for a lighter surface'],
  [/<text\b|<tspan\b/i, 'no text or letters'],
];

type M = [number, number, number, number, number, number];
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (p: M, q: M): M => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];
const apply = (m: M, [x, y]: Pt): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function transformOf(v: string | undefined): { m: M; scaled: boolean } {
  let m = I;
  let scaled = false;
  for (const [, fn, args] of (v ?? '').matchAll(/(translate|rotate|scale)\(([^)]*)\)/g)) {
    const n = args!.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (fn === 'translate') m = mul(m, [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0]);
    else if (fn === 'scale') {
      scaled = true;
      m = mul(m, [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0]);
    } else {
      const a = ((n[0] ?? 0) * Math.PI) / 180;
      const [cx, cy] = [n[1] ?? 0, n[2] ?? 0];
      m = mul(m, mul(mul([1, 0, 0, 1, cx, cy], [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]), [1, 0, 0, 1, -cx, -cy]));
    }
  }
  return { m, scaled };
}

interface Paint {
  fill?: string;
  stroke?: string;
  width?: string;
  cap?: string;
  join?: string;
  m: M;
}

const attrRe = /([\w:-]+)\s*=\s*"([^"]*)"/g;
const attrsOf = (raw: string): Map<string, string> => new Map([...raw.matchAll(attrRe)].map((x) => [x[1]!, x[2]!]));
/** What parseAssetSvg drops that does no harm: ids, data attributes, titles. Noted, not refused. */
const HARMLESS = /^(?:\S+ (?:id|data-[\w-]+|xml:[\w-]+|version)= dropped|<(?:title|desc)> dropped)$/;

/**
 * Check a custom prop's SVG for a w×h footprint and, if it passes, ink it.
 * `seed` keeps the inked line stable for one prop (its id). `ink: false` keeps
 * the lines exactly as drawn, for art that is already hand-inked.
 */
export function checkPropSvg(svg: string, o: { w: number; h: number; seed?: string; ink?: boolean }): PropCheck {
  const fail = (problems: string[], notes: string[] = []): PropCheck => ({ ok: false, problems: [...new Set(problems)], notes, body: '', w: o.w, h: o.h });
  const sizeProblems = checkPropSize(o.w, o.h);
  if (typeof svg !== 'string' || !svg.trim()) return fail([...sizeProblems, 'svg: send the SVG text']);
  const bytes = utf8Bytes(svg);
  if (bytes > MAX_PROP_SVG_BYTES) return fail([...sizeProblems, `svg: ${Math.ceil(bytes / 1024)} KB is too big; keep it under ${MAX_PROP_SVG_BYTES / 1024} KB (simpler shapes, fewer points)`]);

  const problems = [...sizeProblems];
  const notes: string[] = [];
  for (const [re, why] of FORBIDDEN) if (re.test(svg)) problems.push(why);

  const root = /<svg\b([^>]*)>/i.exec(svg);
  if (!root) return fail([...problems, 'svg: no <svg> element']);
  const W = o.w * 100;
  const H = o.h * 100;
  const rootAttrs = new Map([...root[1]!.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((x) => [x[1]!, x[2] ?? x[3] ?? '']));
  const vb = (rootAttrs.get('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const want = `viewBox="0 0 ${W} ${H}"`;
  if (vb.length !== 4 || !vb.every(Number.isFinite)) problems.push(`svg: needs ${want} (100 units per square)`);
  else if (vb[0] !== 0 || vb[1] !== 0 || Math.abs(vb[2]! - W) > 1e-6 || Math.abs(vb[3]! - H) > 1e-6) {
    problems.push(`svg: the viewBox "${vb.join(' ')}" doesn't fit a ${o.w}×${o.h} footprint: use ${want}`);
  }
  for (const [k, v] of [['width', W], ['height', H]] as const) {
    const got = rootAttrs.get(k);
    if (got !== undefined && Math.abs(Number(got.replace(/px$/, '')) - v) > 1e-6) problems.push(`svg: ${k}="${got}" should be ${v} (or leave it out)`);
  }

  const parsed = parseAssetSvg(svg);
  for (const p of parsed.problems) {
    if (p === 'no viewBox' || p === 'viewBox should start at 0 0' || p === 'no usable size') continue; // said above, with the right viewBox
    if (HARMLESS.test(p)) notes.push(p);
    else problems.push(p);
  }

  // effective paint and placement of every shape, through the <g> nesting
  const stack: Paint[] = [{ m: I }];
  let shapes = 0;
  let marginHits = 0;
  let capped = 0;
  const outside: string[] = [];
  const fixed = parsed.body.replace(/<(\/?)([a-z]+)([^>]*?)(\/?)>/g, (all, closing: string, tag: string, raw: string) => {
    if (tag === 'g' && closing) {
      if (stack.length > 1) stack.pop();
      return all;
    }
    if (closing) return all;
    const a = attrsOf(raw);
    const top = stack[stack.length - 1]!;
    const t = transformOf(a.get('transform'));
    if (t.scaled) problems.push('transform: no scale() (it changes the line weights); draw at the real size, translate() and rotate() are fine');
    const here: Paint = {
      fill: a.get('fill') ?? top.fill,
      stroke: a.get('stroke') ?? top.stroke,
      width: a.get('stroke-width') ?? top.width,
      cap: a.get('stroke-linecap') ?? top.cap,
      join: a.get('stroke-linejoin') ?? top.join,
      m: mul(top.m, t.m),
    };
    if (tag === 'g') {
      stack.push(here);
      return all;
    }
    shapes++;
    const name = `<${tag}> #${shapes}`;
    if (tag !== 'line' && here.fill === undefined) problems.push(`${name} has no fill (SVG would fill it black): give fill="${INKS.paper}", "${INKS.shade}", "${INKS.ink}" or "none"`);
    const stroked = here.stroke !== undefined && here.stroke !== 'none';
    if (stroked) {
      const w = Number(here.width);
      if (here.width === undefined) problems.push(`${name} has a stroke but no stroke-width: use 4 (outline), 2 (detail) or 1.5 (texture)`);
      else if (!PROP_STROKE_WIDTHS.includes(w)) problems.push(`${name} stroke-width="${here.width}": only 4 (outline), 2 (detail) or 1.5 (texture)`);
    } else if (tag === 'line' || here.fill === 'none') {
      problems.push(`${name} draws nothing: it has no stroke${tag === 'line' ? '' : ' and no fill'}`);
    }
    const half = stroked ? (Number(here.width) || 0) / 2 : 0;
    const pts = (shapeSubpaths(tag, a) ?? []).flatMap((s) => s.pts).map((p) => apply(here.m, p));
    let out = false;
    for (const [x, y] of pts) {
      if (x - half < -0.01 || y - half < -0.01 || x + half > W + 0.01 || y + half > H + 0.01) out = true;
      else if (x - half < PROP_MARGIN - 0.05 || y - half < PROP_MARGIN - 0.05 || x + half > W - PROP_MARGIN + 0.05 || y + half > H - PROP_MARGIN + 0.05) marginHits++;
    }
    if (out) outside.push(name);
    if (stroked && (here.cap === undefined || here.join === undefined)) {
      capped++;
      const add = `${here.cap === undefined ? ' stroke-linecap="round"' : ''}${here.join === undefined ? ' stroke-linejoin="round"' : ''}`;
      return all.replace(/\/?>$/, (end) => `${add}${end}`);
    }
    return all;
  });
  if (!shapes) problems.push('nothing to draw: use path, rect, circle, ellipse, line, polyline or polygon');
  if (outside.length) problems.push(`${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ` and ${outside.length - 5} more` : ''} reach${outside.length === 1 ? 'es' : ''} past the ${W}×${H} footprint (stroke included): keep everything ${PROP_MARGIN} units inside the edge`);
  if (problems.length) return fail(problems, notes);

  if (marginHits) notes.push(`${marginHits} point${marginHits === 1 ? '' : 's'} sit inside the ${PROP_MARGIN}-unit margin along the edge (stroke included); fine if meant, but the rule is to keep ${PROP_MARGIN} units clear`);
  if (capped) notes.push(`added round caps and joins to ${capped} stroke${capped === 1 ? '' : 's'}`);
  const inked = o.ink === false ? fixed : inkBody(fixed, o.seed ?? 'prop');
  const body = parseAssetSvg(assetSvg({ w: o.w, h: o.h, body: inked })).body;
  if (utf8Bytes(body) > MAX_PROP_BODY_BYTES) return fail([`the inked drawing is ${Math.ceil(utf8Bytes(body) / 1024)} KB, over ${MAX_PROP_BODY_BYTES / 1024} KB: use fewer shapes or points`], notes);
  return { ok: true, problems: [], notes, body, w: o.w, h: o.h };
}

const PAINT_KEYS = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule'] as const;
const fmt2 = (v: number): string => String(Math.round(v * 100) / 100);

/**
 * A cleaned body drawn at another size: every shape's points, through its
 * transforms, scaled by sx × sy and written as a plain path with the paint it
 * had or inherited. Line weights stay as they are (a scale() would change
 * them). For changing a custom prop's footprint without redrawing it.
 */
export function scaleBody(body: string, sx: number, sy: number): string {
  const stack: { paint: Map<string, string>; m: M }[] = [{ paint: new Map(), m: I }];
  let out = '';
  for (const [, closing, tag, raw] of body.matchAll(/<(\/?)([a-z]+)([^>]*?)\/?>/g)) {
    if (tag === 'g' && closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (closing) continue;
    const a = attrsOf(raw!);
    const top = stack[stack.length - 1]!;
    const paint = new Map(top.paint);
    for (const k of PAINT_KEYS) if (a.has(k)) paint.set(k, a.get(k)!);
    const m = mul(top.m, transformOf(a.get('transform')).m);
    if (tag === 'g') {
      stack.push({ paint, m });
      continue;
    }
    const subs = shapeSubpaths(tag!, a) ?? [];
    if (!subs.length) continue;
    const d = subs
      .map((s) => s.pts.map((p, k) => {
        const [x, y] = apply(m, p);
        return `${k ? 'L' : 'M'}${fmt2(x * sx)} ${fmt2(y * sy)}`;
      }).join('') + (s.closed ? 'Z' : ''))
      .join('');
    if (tag === 'line') paint.set('fill', 'none');
    out += `<path d="${d}"${[...paint].map(([k, v]) => ` ${k}="${v}"`).join('')}/>`;
  }
  return out;
}
