// Fingerprints of how maps made before outline routing and slanted doors draw:
// every style in both views, the walls, describeMap and the Dungeon Scrawl
// export. attach.test.ts compares them with hashes taken from the code as it
// was before (run this file against a copy of that code to take them again).
import { createHash } from 'node:crypto';
import { computeWalls, describeMap, PRESETS, renderSvg, toDungeonScrawl, type DelveMap } from '../src/index.ts';

export function fingerprint(map: DelveMap): string {
  const h = createHash('sha256');
  for (const preset of Object.keys(PRESETS).sort()) {
    const styled: DelveMap = { ...map, style: { preset } };
    for (const view of ['gm', 'players'] as const) h.update(renderSvg(styled, { view }));
  }
  h.update(JSON.stringify(computeWalls(map)));
  h.update(describeMap(map));
  h.update(JSON.stringify(toDungeonScrawl(map)));
  return h.digest('hex').slice(0, 16);
}
