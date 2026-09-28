import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DelveMap } from '../src/index.ts';

const root = resolve(import.meta.dirname, '../../..');

export function testMap(): DelveMap {
  return JSON.parse(readFileSync(resolve(root, 'fixtures/test-map-4p.delve.json'), 'utf8')) as DelveMap;
}

/**
 * The Dungeon Scrawl original of the same dungeon. A .ds file is a ZIP with no
 * compression and a single entry "map"; read that entry straight from the local
 * file header instead of pulling in a zip library.
 */
export function dungeonScrawlMap(): { polygons: number[][][][] } {
  const buf = readFileSync(resolve(root, 'fixtures/dungeonscrawl/test-map-4p.ds'));
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip file');
  const method = buf.readUInt16LE(8);
  if (method !== 0) throw new Error(`expected a stored (uncompressed) entry, got method ${method}`);
  const size = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const name = buf.subarray(30, 30 + nameLen).toString('utf8');
  if (name !== 'map') throw new Error(`expected entry "map", got "${name}"`);
  const start = 30 + nameLen + extraLen;
  const doc = JSON.parse(buf.subarray(start, start + size).toString('utf8'));
  return Object.values(doc.data.geometry)[0] as { polygons: number[][][][] };
}
