// SVG -> PNG with resvg, using the bundled OFL fonts so exports look the same
// everywhere (no reliance on whatever fonts a machine happens to have).
// decodePng reads a PNG back into pixels, for tracing pictures on the command line.
// resvg is a native addon: it's loaded on first use, and the release ships it
// in release/node_modules (see scripts/build-release.sh).
import { existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Served name -> [npm package path, file]: labels in IM FELL English, room numbers in Marcellus SC. */
const FONTS = {
  'im-fell-english.ttf': ['@expo-google-fonts/im-fell-english/400Regular', 'IMFellEnglish_400Regular.ttf'],
  'marcellus-sc.ttf': ['@expo-google-fonts/marcellus-sc/400Regular', 'MarcellusSC_400Regular.ttf'],
} as const;

/** A font file next to the release bundle (release/fonts), or from node_modules in development. */
function fontPath(pkgDir: string, file: string): string {
  const bundled = fileURLToPath(new URL(`./fonts/${file}`, import.meta.url));
  if (existsSync(bundled)) return bundled;
  return createRequire(import.meta.url).resolve(`${pkgDir}/${file}`);
}

export const FONT_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(FONTS).map(([served, [pkg, file]]) => [served, fontPath(pkg, file)]),
);
export const LABEL_FONT_FILE = FONT_FILES['im-fell-english.ttf']!;

type ResvgClass = typeof import('@resvg/resvg-js').Resvg;
let resvg: Promise<ResvgClass> | undefined;

// Uploaded map pictures (images.ts) are drawn as <image href="/api/v1/images/<src>">.
// resvg can't fetch, and hands over only http(s) links for us to resolve (it
// would read any other href from its own file system), so those hrefs become
// links under a reserved host and their bytes come from the registered sources.
const IMAGE_HREF = /href="\/api\/v1\/images\/([0-9a-f]{64}\.(?:png|jpg|webp|gif))"/g;
const IMAGE_HOST = 'https://images.delve.invalid/';
const imageSources = new Set<(src: string) => Buffer | null>();

/** Let PNG exports read uploaded pictures (src -> bytes, or null). Returns the undo. */
export function addImageSource(read: (src: string) => Buffer | null): () => void {
  imageSources.add(read);
  return () => imageSources.delete(read);
}

export async function svgToPng(svg: string): Promise<Buffer> {
  resvg ??= import('@resvg/resvg-js').then((m) => m.Resvg);
  const Resvg = await resvg;
  const r = new Resvg(svg.replace(IMAGE_HREF, (_m, src: string) => `href="${IMAGE_HOST}${src}"`), {
    font: { fontFiles: Object.values(FONT_FILES), loadSystemFonts: false, defaultFontFamily: 'IM FELL English' },
    shapeRendering: 2, // geometricPrecision: anti-aliased edges
    textRendering: 1, // optimizeLegibility
  });
  for (const href of new Set(r.imagesToResolve())) {
    const src = href.startsWith(IMAGE_HOST) ? href.slice(IMAGE_HOST.length) : '';
    let bytes: Buffer | null = null;
    for (const read of imageSources) if (src && (bytes = read(src))) break;
    try {
      if (bytes) r.resolveImage(href, bytes);
    } catch {
      // resvg reads PNG, JPEG and GIF only: a WebP picture is left out of the PNG (browsers still show it)
    }
  }
  return r.render().asPng();
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** RGBA pixels of a PNG (any colour type, 8 or 16 bit, not interlaced), decoded with node:zlib only. */
export function decodePng(png: Buffer): { width: number; height: number; rgba: Uint8Array } {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG file');
  const { width, height } = pngSize(png);
  const depth = png[24]!;
  const type = png[25]!;
  if (png[28] !== 0) throw new Error('interlaced PNGs are not supported; save it again without interlacing');
  const idat: Buffer[] = [];
  let palette: Buffer | undefined;
  let alpha: Buffer | undefined;
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at);
    const kind = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + len);
    if (kind === 'IDAT') idat.push(body);
    else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') alpha = body;
    else if (kind === 'IEND') break;
    at += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels || (type !== 3 && type !== 0 && depth < 8)) throw new Error(`unsupported PNG (colour type ${type}, ${depth} bit)`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = Math.ceil((width * channels * depth) / 8);
  const bpp = Math.max(1, (channels * depth) / 8);
  const rows = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = rows.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter] ?? 0;
      cur[i] = (line[i]! + pred) & 255;
    }
    prev = cur;
  }
  const rgba = new Uint8Array(width * height * 4);
  const sample = (row: Buffer, n: number): number => {
    if (depth === 8) return row[n]!;
    if (depth === 16) return row[n * 2]!;
    const bits = (row[(n * depth) >> 3]! >> (8 - depth - ((n * depth) & 7))) & ((1 << depth) - 1);
    return type === 3 ? bits : Math.round((bits * 255) / ((1 << depth) - 1));
  };
  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = (k: number) => sample(row, x * channels + k);
      if (type === 3) {
        const i = s(0);
        rgba[o] = palette?.[i * 3] ?? 0;
        rgba[o + 1] = palette?.[i * 3 + 1] ?? 0;
        rgba[o + 2] = palette?.[i * 3 + 2] ?? 0;
        rgba[o + 3] = alpha?.[i] ?? 255;
      } else {
        const grey = type === 0 || type === 4;
        rgba[o] = s(0);
        rgba[o + 1] = grey ? s(0) : s(1);
        rgba[o + 2] = grey ? s(0) : s(2);
        rgba[o + 3] = type === 4 ? s(1) : type === 6 ? s(3) : 255;
      }
    }
  }
  return { width, height, rgba };
}
