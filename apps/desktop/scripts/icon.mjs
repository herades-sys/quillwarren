// The app icon from Quillwarren's own brand mark (delve-props-design-system/assets/brand/mark.svg):
// build/icon.ico (16–256 px, PNG-compressed entries, as Windows Vista and
// later read them) and build/resources/icon.png (the window icon, 256 px).
// Rendered with resvg, the renderer the server uses anyway.
//   node scripts/icon.mjs   (from apps/desktop; needs the root npm install)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const require = createRequire(join(root, 'package.json'));
const { Resvg } = require('@resvg/resvg-js');

const svg = readFileSync(join(root, 'delve-props-design-system/assets/brand/mark.svg'), 'utf8');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const png = (size) => Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng());

/** An .ico holding PNG images: ICONDIR, one ICONDIRENTRY each, then the PNGs. */
export function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // icon
  head.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // no palette
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([head, ...entries, ...images.map((i) => i.data)]);
}

const images = SIZES.map((size) => ({ size, data: png(size) }));
mkdirSync(join(here, '..', 'build', 'resources'), { recursive: true });
writeFileSync(join(here, '..', 'build', 'icon.ico'), ico(images));
writeFileSync(join(here, '..', 'build', 'resources', 'icon.png'), images.at(-1).data);
writeFileSync(join(here, '..', 'build', 'icon.png'), images.at(-1).data);
console.log(`icon: ${SIZES.join(', ')} px from mark.svg`);
