// The handout page's candle-lit table (handout-table.ts): the scene around the
// preview, the Candle light switch, layers that let the Notes tool's clicks
// through, a flicker of transform and opacity only that stands still with
// reduced motion, nothing fetched from elsewhere, and printing still just the sheet.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { TABLE_CSS, TABLE_SCRIPT } from '../src/handout-table.ts';

const TOKEN = 'table-test-token';
let app: FastifyInstance;
let page: string;

beforeAll(async () => {
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  await app.ready();
  const id = (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: { authorization: `Bearer ${TOKEN}` }, payload: { template: 'test-dungeon', name: 'Crypt' } })).json().id as string;
  page = (await app.inject({ url: `/maps/${id}/handout` })).body;
});
afterAll(async () => {
  await app.close();
});

/** The rules inside one @-block (balanced braces), e.g. "@media print". */
function block(css: string, head: string): string {
  const at = css.indexOf(head);
  if (at < 0) return '';
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', at) + 1, i);
  }
  return '';
}

describe('the handout on a candle-lit table', () => {
  it('lays the sheet on the table, with the light over it and the candle beside it', () => {
    expect(page).toContain('<div class="scene" id="scene">');
    expect(page).toContain('<canvas class="wood" id="wood" aria-hidden="true"></canvas>');
    // the light sits right after the picture, inside the table the Notes tool lays its layer in
    expect(page).toContain('<div class="table"><img id="sheet" alt="The handout"><div class="sheet-light" id="sheet-light" aria-hidden="true">');
    expect(page).toMatch(/<div class="candle" aria-hidden="true"><svg class="candle-art"[\s\S]*?<div class="halo"><\/div><div class="flame"><svg/);
    // the switch, remembered in this browser
    expect(page).toContain('<button class="switch" type="button" role="switch" id="candle" aria-checked="true"></button>');
    expect(page).toContain('Candle light');
    expect(TABLE_SCRIPT).toContain("'delve-handout-candle'");
    // the page's own script is still there (preview, downloads, print), and the table's runs after it
    expect(page.indexOf('window.delveHandout')).toBeLessThan(page.indexOf("var scene = document.getElementById('scene')"));
    expect(() => new Function(TABLE_SCRIPT)).not.toThrow();
  });

  it('lets clicks through every layer of light, so the Notes tool still gets them', () => {
    expect(TABLE_CSS).toMatch(/\.scene > \.wood, \.scene > \.vignette, \.scene > \.pool \{ position: absolute; pointer-events: none; \}/);
    expect(TABLE_CSS).toMatch(/\.sheet-light \{[^}]*pointer-events: none/);
    expect(TABLE_CSS).toMatch(/\.candle \{[^}]*pointer-events: none/);
  });

  it('flickers with transform and opacity only, and not at all with reduced motion', () => {
    const names = [...TABLE_CSS.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]!);
    expect(names).toEqual(['hd-flame', 'hd-halo', 'hd-pool', 'hd-warm']);
    const frames = names.map((n) => block(TABLE_CSS, `@keyframes ${n} `));
    for (const f of frames) {
      const props = [...f.matchAll(/([a-z-]+):/g)].map((m) => m[1]);
      expect(props.length).toBeGreaterThan(0);
      for (const p of props) expect(['transform', 'opacity']).toContain(p);
    }
    // the animations are switched on only where motion is welcome
    const motion = block(TABLE_CSS, '@media (prefers-reduced-motion: no-preference)');
    expect((motion.match(/animation:/g) ?? []).length).toBe(4);
    expect((TABLE_CSS.match(/animation:/g) ?? []).length).toBe(4);
  });

  it('draws everything itself: no pictures, fonts or scripts from anywhere else', () => {
    const scene = page.slice(page.indexOf('<div class="scene"'), page.indexOf('<aside>'));
    expect(scene).not.toMatch(/https?:/);
    expect(TABLE_CSS).not.toMatch(/url\(/);
    expect(scene).not.toMatch(/url\((?!#)/); // only the SVG's own gradients
    expect(scene.match(/<img /g)).toHaveLength(1); // just the sheet
  });

  it('prints just the sheet, as before', () => {
    const print = block(page, '@media print');
    expect(print).toContain('.topbar, main { display: none !important; }');
    expect(print).toContain('#print-sheet { display: block;');
    // the table and the candle live inside main, so printing leaves them out
    const main = page.slice(page.indexOf('<main>'), page.indexOf('</main>'));
    expect(main).toContain('id="scene"');
    expect(main).toContain('class="candle"');
    expect(page.indexOf('<img id="print-sheet"')).toBeGreaterThan(page.indexOf('</main>'));
  });
});
