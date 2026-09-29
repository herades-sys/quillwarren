// SVG -> PNG with resvg, using the bundled OFL fonts so exports look the same
// everywhere (no reliance on whatever fonts a machine happens to have).
// resvg is a native addon: it's loaded on first use, and the release ships it
// in release/node_modules (see scripts/build-release.sh).
import { existsSync } from 'node:fs';
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

export async function svgToPng(svg: string): Promise<Buffer> {
  resvg ??= import('@resvg/resvg-js').then((m) => m.Resvg);
  const Resvg = await resvg;
  const r = new Resvg(svg, {
    font: { fontFiles: Object.values(FONT_FILES), loadSystemFonts: false, defaultFontFamily: 'IM FELL English' },
    shapeRendering: 2, // geometricPrecision: anti-aliased edges
    textRendering: 1, // optimizeLegibility
  });
  return r.render().asPng();
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
