// Builds Quillwarren's asset catalog from delve-props-design-system/assets:
//   packages/core/src/assets/catalog.json   what the editor, renderer and Claude know about each asset
//   delve-props-design-system/assets/manifest.json   the design system's full manifest (it only listed the samples)
// Metadata comes from the batch generators' META tables (tools/*.js) plus the samples' manifest
// entries; every SVG is checked with the same whitelist the renderer uses. Run: npm run assets
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parseAssetSvg } from '../packages/core/src/assets/svg.ts';

const ROOT = resolve(import.meta.dirname, '..');
const DIR = join(ROOT, 'delve-props-design-system/assets');
const CATEGORIES = ['furniture', 'storage', 'treasure', 'temple', 'dungeon', 'workshop', 'light', 'nature', 'water', 'decals', 'symbols', 'cartography', 'terrain'];
/** The four style-sheet samples live in samples/; in the editor they sit with their kind. */
const SAMPLE_HOME: Record<string, string> = { 'table-round': 'furniture', chest: 'storage', barrel: 'storage', statue: 'temple' };
/** Props that are secrets until found: hidden from players by default (catalog.json `hidden`; core HIDDEN_ASSETS). */
const HIDDEN = new Set(['pressure-plate', 'spike-trap', 'rune']);

type Blocks = 'none' | 'movement' | 'sight';
interface Entry {
  id: string;
  name: string;
  category: string;
  kind: 'prop' | 'terrain';
  w: number;
  h: number;
  tags: string[];
  blocks: Blocks;
  tint?: string;
  difficult?: boolean;
  hidden?: boolean;
  file: string;
}

/** The META tables are plain array literals; evaluate just the literal, with nothing in scope. */
function metaTables(src: string): unknown[][][] {
  const out: unknown[][][] = [];
  for (const m of src.matchAll(/const ([A-Z]*META)\s*=\s*\[/g)) {
    const start = m.index! + m[0].length - 1;
    const end = src.indexOf(']];', start);
    if (end < 0) continue;
    out.push(runInNewContext(`(${src.slice(start, end + 2)})`, Object.create(null), { timeout: 1000 }) as unknown[][]);
  }
  return out;
}

const entries: Entry[] = [];
const seen = new Set<string>();
const missing: string[] = [];
const problems: string[] = [];

function add(e: Omit<Entry, 'file'>, file: string): void {
  if (seen.has(e.id)) return void problems.push(`${e.id}: duplicate id, second one ignored`);
  if (e.id.startsWith('c-')) return void problems.push(`${e.id}: c- is the colour props' prefix (core COLOUR_PREFIX), dropped`);
  if (!existsSync(join(DIR, file))) return void missing.push(`${file} (${e.name})`);
  const parsed = parseAssetSvg(readFileSync(join(DIR, file), 'utf8'));
  for (const p of parsed.problems) problems.push(`${file}: ${p}`);
  if (Math.abs(parsed.w - e.w) > 1e-6 || Math.abs(parsed.h - e.h) > 1e-6) {
    problems.push(`${file}: viewBox is ${parsed.w}×${parsed.h} squares, metadata says ${e.w}×${e.h}; using the viewBox`);
    e = { ...e, w: parsed.w, h: parsed.h };
  }
  seen.add(e.id);
  entries.push({ ...e, ...(HIDDEN.has(e.id) ? { hidden: true } : {}), file });
}

// Samples first (they are what the style sheet approved), then the batches.
const samples = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as Entry[];
for (const s of samples.filter((s) => s.category === 'samples')) {
  add({ id: s.id, name: s.name, category: SAMPLE_HOME[s.id] ?? 'furniture', kind: 'prop', w: s.w, h: s.h, tags: s.tags, blocks: s.blocks }, `samples/${s.id}.svg`);
}
for (const f of readdirSync(join(DIR, 'tools')).filter((f) => f.endsWith('.js')).sort()) {
  const fileCat = f.replace(/\.js$/, '');
  for (const table of metaTables(readFileSync(join(DIR, 'tools', f), 'utf8'))) {
    for (const row of table) {
      if (fileCat === 'terrain') {
        const [id, name, tint, difficult] = row as [string, string, string, boolean];
        add({ id, name, category: 'terrain', kind: 'terrain', w: 2, h: 2, tags: ['terrain', ...id.split('-')], blocks: 'none', tint, difficult }, `terrain/${id}.svg`);
        continue;
      }
      const withCat = CATEGORIES.includes(String(row[0])) && typeof row[1] === 'string' && typeof row[2] === 'string';
      const [category, id, name, w, h, tags, blocks] = (withCat ? row : [fileCat, ...row]) as [string, string, string, number, number, string[], Blocks | undefined];
      add({ id, name, category, kind: 'prop', w, h, tags, blocks: blocks ?? 'none' }, `${category}/${id}.svg`);
    }
  }
}

const order = (e: Entry) => CATEGORIES.indexOf(e.category);
const sorted = entries.map((e, i) => ({ e, i })).sort((a, b) => order(a.e) - order(b.e) || a.i - b.i).map((x) => x.e);

writeFileSync(join(ROOT, 'packages/core/src/assets/catalog.json'), `[\n${sorted.map((e) => `  ${JSON.stringify(e)}`).join(',\n')}\n]\n`);
const manifest = sorted.map((e) =>
  e.kind === 'terrain'
    ? { id: e.id, name: e.name, kind: 'terrain', tile: 2, tint: e.tint, difficult: e.difficult }
    : { id: e.id, name: e.name, category: e.file.startsWith('samples/') ? 'samples' : e.category, w: e.w, h: e.h, tags: e.tags, blocks: e.blocks },
);
writeFileSync(join(DIR, 'manifest.json'), `[\n${manifest.map((e) => `  ${JSON.stringify(e)}`).join(',\n')}\n]\n`);

const counts = CATEGORIES.map((c) => `${c} ${sorted.filter((e) => e.category === c).length}`).join(', ');
console.log(`catalog: ${sorted.length} assets (${counts})`);
if (missing.length) console.log(`listed but no file (${missing.length}):\n  ${missing.join('\n  ')}`);
if (problems.length) console.log(`fixed or dropped while checking (${problems.length}):\n  ${problems.slice(0, 60).join('\n  ')}${problems.length > 60 ? '\n  …' : ''}`);
