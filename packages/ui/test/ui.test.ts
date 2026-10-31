import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DARK_TOKENS, ICONS, ICON_GROUPS, LIGHT_TOKENS, ROOT_TOKENS, THEME_BOOT, UI_CSS, UI_CSS_VERSION, hash, head, htmlDocument, icon, jsonForScript, themeSwitch } from '../src/index.ts';

const design = (file: string): string => readFileSync(new URL(`../../../docs/design/ui-v1/${file}`, import.meta.url), 'utf8');

/** `--name: value;` pairs of a declaration block, values with their spacing normalised. */
function vars(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim().replace(/\s+/g, ' '));
  return out;
}

/** The body of the first rule whose selector is exactly `selector`. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `no "${selector}" rule in the design's tokens`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('tokens', () => {
  const sheet = design('delve-tokens.css');
  const cases: [string, string, string][] = [
    [':root', ':root', ROOT_TOKENS],
    ['dark', ':root, [data-theme="dark"]', DARK_TOKENS],
    ['light', '[data-theme="light"]', LIGHT_TOKENS],
  ];
  for (const [name, selector, ours] of cases) {
    it(`has every ${name} token of delve-tokens.css with the same value`, () => {
      const want = vars(block(sheet, selector));
      expect(want.size).toBeGreaterThan(20);
      expect(Object.fromEntries(vars(ours))).toEqual(Object.fromEntries(want));
    });
  }

  it('sets color-scheme per theme', () => {
    expect(DARK_TOKENS).toContain('color-scheme: dark;');
    expect(LIGHT_TOKENS).toContain('color-scheme: light;');
  });

  it('loads nothing from another site: fonts are our own files', () => {
    expect(UI_CSS).not.toMatch(/googleapis|gstatic|@import|https?:\/\//);
    for (const f of ['im-fell-english.ttf', 'im-fell-english-italic.ttf', 'marcellus-sc.ttf']) expect(UI_CSS).toContain(`url("/fonts/${f}")`);
  });

  it('is well formed: braces balance and no template leftovers', () => {
    const css = UI_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    expect(UI_CSS).not.toMatch(/\$\{|undefined|NaN/);
  });

  it('keeps the classes the design names', () => {
    for (const cls of ['.btn-primary', '.btn-secondary', '.btn-danger', '.btn-icon', '.seg-opt', '.tabs', '.tool', '.tool-key', '.tooltip', '.ctxbar', '.field', '.input', '.check', '.switch', '.range', '.menu-item', '.map-card', '.new-tile', '.table', '.tag-accent', '.toast', '.dialog', '.marker-discover', '.note-pop', '.roll-total', '.sheet', '.empty', '.skeleton', '.status-live', '.topbar']) {
      expect(UI_CSS, cls).toMatch(new RegExp(`${cls.replace('.', '\\.')}[\\s:{,.[]`));
    }
  });

  it('versions the stylesheet by its content', () => {
    expect(UI_CSS_VERSION).toMatch(/^[0-9a-f]{8}$/);
    expect(UI_CSS_VERSION).toBe(hash(UI_CSS));
    expect(hash('a')).not.toBe(hash('b'));
  });
});

describe('icons', () => {
  it('has every icon of delve-icons.js, path for path', () => {
    const src = design('delve-icons.js');
    const table = src.slice(src.indexOf('const I = {'), src.indexOf('\n  };'));
    const entries = [...table.matchAll(/(?:^|[\s,])'?([a-z0-9-]+)'?: '([^']*)'/g)].map((m) => [m[1]!, m[2]!] as const);
    expect(entries.length).toBeGreaterThan(67);
    expect(Object.keys(ICONS).length).toBe(entries.length);
    for (const [name, paths] of entries) expect(ICONS[name as keyof typeof ICONS], name).toBe(paths);
  });

  it('groups only icons that exist', () => {
    for (const g of ICON_GROUPS) for (const n of g.icons) expect(ICONS[n], n).toBeTypeOf('string');
    expect(ICON_GROUPS.map((g) => g.icons.length)).toEqual([30, 9, 31]);
  });

  it('draws decorative icons hidden from screen readers, named ones as images', () => {
    expect(icon('room')).toMatch(/^<svg class="icon" viewBox="0 0 24 24" width="18" height="18" [^>]*stroke-width="1.7"[^>]*aria-hidden="true">/);
    const named = icon('trash', { size: 16, stroke: 2, label: 'Delete "x"', className: 'warn' });
    expect(named).toContain('class="icon warn"');
    expect(named).toContain('width="16"');
    expect(named).toContain('stroke-width="2"');
    expect(named).toContain('role="img" aria-label="Delete &quot;x&quot;"');
    expect(named).not.toContain('aria-hidden');
  });
});

describe('head and theme', () => {
  it('puts the theme script before the stylesheet', () => {
    const h = head({ title: 'Log in' });
    expect(h).toContain('<title>Log in · Delve</title>');
    expect(h.indexOf('<script>')).toBeLessThan(h.indexOf('rel="stylesheet"'));
    expect(h).toContain(`href="/assets/delve-ui.css?v=${UI_CSS_VERSION}"`);
    expect(head({ title: 'Join · Delve Table' })).toContain('<title>Join · Delve Table</title>');
    expect(head({ title: '<b>' })).toContain('<title>&lt;b&gt; · Delve</title>');
  });

  it('builds a whole document', () => {
    const doc = htmlDocument({ title: 'X', body: '<main>hi</main>', bodyClass: 'app' });
    expect(doc).toMatch(/^<!doctype html><html lang="en"><head>.*<\/head><body class="app"><main>hi<\/main><\/body><\/html>$/s);
  });

  it('has a boot script that parses, and a switch it drives', () => {
    expect(() => new Function(THEME_BOOT)).not.toThrow();
    expect(THEME_BOOT).toContain("'delve-theme'");
    const sw = themeSwitch('t1');
    expect(sw.match(/data-theme-set/g)).toHaveLength(3);
    expect(sw).toContain('name="t1" value="system" data-theme-set checked');
  });
});

describe('JSON for a <script> element', () => {
  it('keeps "</script>", "<!--" and line separators from ending or breaking the script, and reads back the same', () => {
    const lineEnds = String.fromCharCode(0x2028, 0x2029);
    const value = { name: '</script><img src=x onerror=alert(1)>', note: '<!-- a & b -->', lineEnds };
    const out = jsonForScript(value);
    expect(out).not.toMatch(/[<>&]/);
    expect(out).not.toContain(lineEnds[0]);
    expect(out).not.toContain(lineEnds[1]);
    const slash = String.fromCharCode(92);
    expect(out).toContain(`${slash}u003c/script${slash}u003e`);
    expect(out).toContain(`${slash}u2028${slash}u2029`);
    expect(JSON.parse(out)).toEqual(value);
    // nothing else changes
    expect(jsonForScript({ id: 'map_1', n: 3, ok: true })).toBe(JSON.stringify({ id: 'map_1', n: 3, ok: true }));
  });
});
