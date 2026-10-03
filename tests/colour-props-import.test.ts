// The colour prop import (scripts/colour-props-lib.ts) on a temp folder: a
// finished batch goes in, an unfinished one waits, a bad prop is left out with
// the reason, and a second run rebuilds everything from what is finished then.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { COLOUR_CATALOG, COLOUR_DIR, importColourProps } from '../scripts/colour-props-lib.ts';

const root = resolve(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'delve-colour-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const svg = (w: number, h: number, inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w * 100} ${h * 100}" width="${w * 100}" height="${h * 100}"><g fill="none" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
const bush = svg(1, 1, '<circle cx="50" cy="50" r="40" fill="#4F803C" stroke="#000000" stroke-width="4"/>');
const entry = (id: string, o: Record<string, unknown> = {}) => ({ id, name: id, category: 'plants', w: 1, h: 1, tags: ['bush', 'green'], blocks: 'movement', palette: 'colour', layer: 'props', ...o });

function batch(name: string, done: boolean, props: [Record<string, unknown>, string][]): void {
  const dir = join(tmp, 'src', name);
  for (const [e, art] of props) {
    mkdirSync(join(dir, 'colour', String(e.category)), { recursive: true });
    writeFileSync(join(dir, 'colour', String(e.category), `${e.id}.svg`), art);
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(props.map(([e]) => e)));
  if (done) writeFileSync(join(dir, 'DONE'), '');
}

describe('npm run colour-props', () => {
  const repo = join(tmp, 'repo');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  mkdirSync(join(repo, 'packages/core/src/assets'), { recursive: true });
  cpSync(join(root, 'docs/ASSETS-COLOUR.md'), join(repo, 'docs/ASSETS-COLOUR.md'));
  batch('batch-00', true, [
    [entry('bush-a', { group: 'bush' }), bush],
    [entry('bush-b', { group: 'bush' }), bush],
    [entry('pit-cover', { category: 'traps', blocks: 'none', layer: 'floor', hidden: true }), svg(1, 1, '<path d="M10 10L90 10L90 90Z" fill="#7C776F" stroke="#C0524A" stroke-width="2" stroke-dasharray="7 5"/>')],
    [entry('wall-1', { category: 'ruins', group: 'ruin-wall', blocks: 'sight' }), svg(1, 1, '<path d="M0 32H100V68H0Z" fill="#ABA598"/>')],
    // seamless textures: terrain, not props; water you swim in is difficult
    [entry('planks', { category: 'floors', w: 2, h: 2, blocks: 'none', layer: 'floor', group: 'floor-planks', tile: true }), svg(2, 2, '<path d="M0 0H200V200H0Z" fill="#86603D"/>')],
    [entry('sea', { category: 'water', tags: ['water', 'swim'], blocks: 'none', layer: 'floor', tile: true }), svg(1, 1, '<path d="M0 0H100V100H0Z" fill="#4A86A6"/>')],
    // off the palette, and dashed though not hidden: both left out
    [entry('bad-colour'), svg(1, 1, '<circle cx="50" cy="50" r="40" fill="#123456"/>')],
    [entry('bad-dash'), svg(1, 1, '<path d="M0 0L9 9" stroke="#000000" stroke-dasharray="2 2"/>')],
    // the size in the manifest must match the viewBox
    [entry('bad-size', { w: 2 }), bush],
  ]);
  // a stray drawing that isn't in the manifest is ignored
  writeFileSync(join(tmp, 'src/batch-00/colour/plants/stray.svg'), bush);
  batch('batch-01', false, [[entry('fern-a'), bush]]);

  it('imports the finished batches, checks every prop and writes the art, the manifest and the catalog', () => {
    const r = importColourProps({ source: join(tmp, 'src'), repo });
    expect(r.batches).toEqual(['batch-00']);
    expect(r.unfinished).toEqual(['batch-01']);
    expect(r.props).toBe(6);
    expect(r.problems.join('\n')).toMatch(/batch-00\/plants\/bad-colour: .*fill="#123456" is not a palette colour/);
    expect(r.problems.join('\n')).toMatch(/bad-dash: .*stroke-dasharray only on hidden props/);
    expect(r.problems.join('\n')).toMatch(/bad-size: viewBox 100×100, manifest says 2×1 squares/);
    expect(existsSync(join(repo, COLOUR_DIR, 'plants/bush-a.svg'))).toBe(true);
    expect(existsSync(join(repo, COLOUR_DIR, 'plants/bad-colour.svg'))).toBe(false);
    expect(existsSync(join(repo, COLOUR_DIR, 'plants/stray.svg'))).toBe(false);
    expect(r.problems.join('\n')).not.toContain('stray');
    expect(existsSync(join(repo, COLOUR_DIR, 'plants/fern-a.svg'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(repo, COLOUR_DIR, 'manifest.json'), 'utf8')) as { id: string; batch: string }[];
    expect(manifest.map((m) => m.id)).toEqual(['bush-a', 'bush-b', 'pit-cover', 'wall-1', 'planks', 'sea']);
    expect(manifest[4]).toMatchObject({ tile: true, layer: 'floor' });
    expect(manifest[0]!.batch).toBe('batch-00');
    const catalog = JSON.parse(readFileSync(join(repo, COLOUR_CATALOG), 'utf8')) as { categories: [string, string][]; assets: unknown[][] };
    expect(catalog.categories).toEqual([['plants', 'Plants'], ['traps', 'Hidden traps'], ['ruins', 'Ruins'], ['water', 'Water'], ['floors', 'Floors']]);
    expect(catalog.assets).toEqual([
      ['c-bush-a', 'bush-a', 'plants', 1, 1, 'bush,green', 'movement', 'props', 'bush'],
      ['c-bush-b', 'bush-b', 'plants', 1, 1, 'bush,green', 'movement', 'props', 'bush'],
      ['c-pit-cover', 'pit-cover', 'traps', 1, 1, 'bush,green', 'none', 'floor', '', 'hidden'],
      ['c-wall-1', 'wall-1', 'ruins', 1, 1, 'bush,green', 'sight', 'props', 'ruin-wall', 'modular'],
      ['c-planks', 'planks', 'floors', 2, 2, 'bush,green', 'none', 'floor', 'floor-planks', 'tile'],
      ['c-sea', 'sea', 'water', 1, 1, 'water,swim', 'none', 'floor', '', 'tile difficult'],
    ]);
  });

  it('runs again as more batches finish, and drops what is no longer there', () => {
    writeFileSync(join(tmp, 'src/batch-01/DONE'), '');
    writeFileSync(join(tmp, 'src/batch-00/manifest.json'), JSON.stringify([entry('bush-a', { group: 'bush' })]));
    const r = importColourProps({ source: join(tmp, 'src'), repo });
    expect(r.batches).toEqual(['batch-00', 'batch-01']);
    expect(r.problems).toEqual([]);
    expect(r.props).toBe(2);
    expect(existsSync(join(repo, COLOUR_DIR, 'plants/fern-a.svg'))).toBe(true);
    expect(existsSync(join(repo, COLOUR_DIR, 'ruins/wall-1.svg'))).toBe(false);
    const catalog = JSON.parse(readFileSync(join(repo, COLOUR_CATALOG), 'utf8')) as { assets: unknown[][] };
    expect(catalog.assets.map((a) => a[0])).toEqual(['c-bush-a', 'c-fern-a']);
  });

  it('refuses ids used twice across batches', () => {
    batch('batch-02', true, [[entry('fern-a'), bush]]);
    const r = importColourProps({ source: join(tmp, 'src'), repo });
    expect(r.problems).toEqual(['batch-02/plants/fern-a: id also used in batch-01']);
    expect(r.props).toBe(2);
  });
});
