// SVG -> PNG with resvg, using the bundled OFL label font so exports look the
// same everywhere (no reliance on whatever fonts a machine happens to have).
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';

const require = createRequire(import.meta.url);
export const LABEL_FONT_FILE = require.resolve(
  '@expo-google-fonts/im-fell-english/400Regular/IMFellEnglish_400Regular.ttf',
);

export function svgToPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    font: { fontFiles: [LABEL_FONT_FILE], loadSystemFonts: false, defaultFontFamily: 'IM FELL English' },
    shapeRendering: 2, // geometricPrecision: anti-aliased edges
    textRendering: 1, // optimizeLegibility
  });
  return resvg.render().asPng();
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
