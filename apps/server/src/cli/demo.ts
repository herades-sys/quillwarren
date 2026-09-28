// Build the test dungeon over HTTP, one batch at a time, then save a PNG.
// This is phase 3's "done when": a script builds a map through the API and gets a picture back.
//   DELVE_URL=http://127.0.0.1:8790 DELVE_API_TOKEN=... npm run demo -- out.png [--view players]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { DelveMap, Op } from '@delve/core';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { view: { type: 'string', default: 'gm' }, name: { type: 'string', default: 'Test dungeon (built over the API)' } },
});
const out = positionals[0] ?? 'demo.png';
const base = (process.env.DELVE_URL ?? 'http://127.0.0.1:8790').replace(/\/$/, '');
const token = process.env.DELVE_API_TOKEN;
if (!token) {
  console.error('set DELVE_API_TOKEN (the server refuses changes without it)');
  process.exit(2);
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res;
}

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../../fixtures/test-map-4p.delve.json'), 'utf8'),
) as DelveMap;
const byType = (...types: string[]) => fixture.objects.filter((o) => types.includes(o.type));

const created = (await (await call('POST', '/api/v1/maps', { name: values.name, by: 'demo' })).json()) as { id: string; rev: number };
console.log(`created ${created.id} (rev ${created.rev})`);
let rev = created.rev;

const steps: [string, Op[]][] = [
  ['rooms', byType('room').map((object) => ({ op: 'add', object }))],
  ['corridors', byType('corridor').map((object) => ({ op: 'add', object }))],
  ['pillars', byType('cutout').map((object) => ({ op: 'add', object }))],
  ['doors', byType('door').map((object) => ({ op: 'add', object }))],
  ['seed', [{ op: 'update_map', set: { seed: fixture.seed } }]],
];
for (const [what, ops] of steps) {
  const r = (await (await call('POST', `/api/v1/maps/${created.id}/ops`, { baseRev: rev, ops, by: 'demo' })).json()) as { rev: number };
  rev = r.rev;
  console.log(`added ${what}: ${ops.length} ops -> rev ${rev}`);
}

console.log(await (await call('GET', `/api/v1/maps/${created.id}/describe`)).text());
const png = Buffer.from(await (await call('GET', `/api/v1/maps/${created.id}/render.png?view=${values.view}`)).arrayBuffer());
writeFileSync(out, png);
console.log(`saved ${out} (${png.readUInt32BE(16)}×${png.readUInt32BE(20)} px) · map page: ${base}/`);
