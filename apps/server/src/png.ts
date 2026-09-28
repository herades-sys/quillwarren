// SVG -> PNG with resvg, using the bundled OFL label font so exports look the
// same everywhere (no reliance on whatever fonts a machine happens to have).
// resvg is a native addon: it's loaded on first use, and the release ships it
// in release/node_modules (see scripts/build-release.sh).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const FONT_NAME = 'IMFellEnglish_400Regular.ttf';

/** The label font: next to the release bundle, or from node_modules in development. */
export const LABEL_FONT_FILE = (() => {
  const bundled = fileURLToPath(new URL(`./fonts/${FONT_NAME}`, import.meta.url));
  if (existsSync(bundled)) return bundled;
  return createRequire(import.meta.url).resolve(`@expo-google-fonts/im-fell-english/400Regular/${FONT_NAME}`);
})();

type ResvgClass = typeof import('@resvg/resvg-js').Resvg;
let resvg: Promise<ResvgClass> | undefined;

export async function svgToPng(svg: string): Promise<Buffer> {
  resvg ??= import('@resvg/resvg-js').then((m) => m.Resvg);
  const Resvg = await resvg;
  const r = new Resvg(svg, {
    font: { fontFiles: [LABEL_FONT_FILE], loadSystemFonts: false, defaultFontFamily: 'IM FELL English' },
    shapeRendering: 2, // geometricPrecision: anti-aliased edges
    textRendering: 1, // optimizeLegibility
  });
  return r.render().asPng();
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
