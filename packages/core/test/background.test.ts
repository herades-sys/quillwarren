// A map's own background colour (style.overrides.background, the editor's
// colour wheel): the colour maths, where the override shows (scene, SVG,
// crops, Dungeon Scrawl), what follows it (background grid, hatching ink),
// resetting, validation, and that maps without it draw exactly as before.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  BACKGROUND_PRESETS,
  backgroundGridColour,
  backgroundHints,
  backgroundOps,
  buildScene,
  contrastRatio,
  handoutSvg,
  hexToHsv,
  hexToRgb,
  hsvToHex,
  hsvToRgb,
  isHexColour,
  mapBackground,
  mixColours,
  normalizeHex,
  parseBackground,
  PRESETS,
  relativeLuminance,
  renderSvg,
  resolveStyle,
  rgbToHex,
  rgbToHsv,
  sceneToSvg,
  shownBackground,
  styleBackground,
  toDungeonScrawl,
  validateMap,
  withBackground,
  withPreset,
  type DelveMap,
} from '../src/index.ts';
import { testMap } from './fixtures.ts';

const withBg = (map: DelveMap, background: string, extra: Record<string, unknown> = {}): DelveMap => ({
  ...map,
  style: { preset: map.style?.preset ?? 'classic-hatching', overrides: { ...extra, background } },
});
const styled = (preset: string): DelveMap => ({ ...testMap(), style: { preset } });
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

describe('colour maths', () => {
  it('reads typed hex colours in the usual spellings', () => {
    expect(normalizeHex('#1a2540')).toBe('#1A2540');
    expect(normalizeHex('1A2540')).toBe('#1A2540');
    expect(normalizeHex('  #abc ')).toBe('#AABBCC');
    expect(normalizeHex('fff')).toBe('#FFFFFF');
    for (const bad of ['', '#', '#12', '#1234', '#12345', '#1234567', 'blue', '#GGGGGG', 'rgb(1,2,3)', null, undefined, 12, {}]) expect(normalizeHex(bad), String(bad)).toBeNull();
    expect(isHexColour('#abc')).toBe(true);
    expect(isHexColour('#AABBCC')).toBe(true);
    expect(isHexColour('AABBCC')).toBe(false); // a stored colour keeps its #
    expect(isHexColour('#AABBCCDD')).toBe(false);
  });

  it('converts between hex, RGB and HSV', () => {
    expect(hexToRgb('#EFEAE2')).toEqual({ r: 239, g: 234, b: 226 });
    expect(rgbToHex({ r: 239, g: 234, b: 226 })).toBe('#EFEAE2');
    expect(rgbToHex({ r: 300, g: -4, b: 127.6 })).toBe('#FF0080');
    expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv({ r: 0, g: 255, b: 0 })).toEqual({ h: 120, s: 1, v: 1 });
    expect(rgbToHsv({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 1, v: 1 });
    expect(rgbToHsv({ r: 255, g: 0, b: 255 })).toEqual({ h: 300, s: 1, v: 1 });
    expect(rgbToHsv({ r: 128, g: 128, b: 128 })).toEqual({ h: 0, s: 0, v: 128 / 255 });
    expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });
    expect(hsvToHex({ h: 60, s: 1, v: 1 })).toBe('#FFFF00');
    expect(hsvToHex({ h: 180, s: 0.5, v: 1 })).toBe('#80FFFF');
    expect(hsvToHex({ h: 420, s: 1, v: 1 })).toBe('#FFFF00'); // hue wraps
    expect(hsvToHex({ h: -60, s: 2, v: 1 })).toBe('#FF00FF'); // and saturation is clamped
    const beige = hexToHsv('#EFEAE2');
    expect(beige.h).toBeCloseTo(36.9, 1);
    expect(beige.s).toBeCloseTo(0.0544, 3);
    expect(beige.v).toBeCloseTo(0.937, 3);
  });

  it('round-trips every colour through HSV exactly', () => {
    // all 4096 short colours, the presets, and 3000 more from a fixed sequence
    const all = new Set<string>();
    for (let i = 0; i < 4096; i++) all.add(normalizeHex(i.toString(16).padStart(3, '0'))!);
    for (const p of [...Object.values(PRESETS).map((s) => s.background), ...BACKGROUND_PRESETS.map((p) => p.hex)]) all.add(normalizeHex(p)!);
    let x = 12345;
    for (let i = 0; i < 3000; i++) {
      x = (x * 1103515245 + 12345) % 2 ** 31;
      all.add(rgbToHex({ r: x & 255, g: (x >> 8) & 255, b: (x >> 16) & 255 }));
    }
    for (const hex of all) {
      expect(hsvToHex(hexToHsv(hex)), hex).toBe(hex);
      expect(rgbToHex(hsvToRgb(rgbToHsv(hexToRgb(hex)))), hex).toBe(hex);
    }
  });

  it('mixes colours and measures contrast like WCAG', () => {
    expect(mixColours('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(mixColours('#3674AC', '#FFFFFF', 0)).toBe('#3674AC');
    expect(relativeLuminance('#FFFFFF')).toBe(1);
    expect(relativeLuminance('#000000')).toBe(0);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 6);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 6);
    expect(contrastRatio('#4A525C', '#4A525C')).toBe(1);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });
});

describe("a map's own background colour", () => {
  it('replaces the style’s colour in the scene, the SVG and crops', () => {
    const map = withBg(testMap(), '#1A2540');
    const scene = buildScene(map, { view: 'players' });
    expect(scene.layers[0]).toMatchObject({ name: 'background', kind: 'rect', color: '#1A2540' });
    const svg = sceneToSvg(scene, { ppg: 20 });
    expect(svg).toContain('<g data-layer="background"><rect');
    expect(svg).toContain('fill="#1A2540"');
    expect(svg).not.toContain('#EFEAE2');
    // a cropped export (frame) is drawn on it too
    const cropped = buildScene(map, { view: 'gm', frame: { x0: 2, y0: 2, x1: 8, y1: 6 } });
    expect(cropped.layers[0]).toMatchObject({ kind: 'rect', color: '#1A2540', bounds: { x0: 2, y0: 2, x1: 8, y1: 6 } });
    // and background: false (the 3D view's floors, transparent exports) still has none
    const clear = buildScene(map, { background: false });
    expect(clear.layers.some((l) => l.name === 'background' || l.name === 'background-grid')).toBe(false);
    expect(sceneToSvg(clear, { ppg: 20 })).not.toContain('#1A2540');
  });

  it('is read back, shown and given as the style’s own when unset', () => {
    const plain = testMap();
    expect(mapBackground(plain)).toBeNull();
    expect(shownBackground(plain)).toBe('#EFEAE2');
    expect(styleBackground('old-school-blue')).toBe('#3674AC');
    expect(styleBackground(undefined)).toBe('#EFEAE2');
    const own = withBg(plain, '#2f4a33');
    expect(mapBackground(own)).toBe('#2F4A33');
    expect(shownBackground(own)).toBe('#2F4A33');
    // the style's own colour as an "override" is no override at all
    expect(mapBackground(withBg(plain, '#efeae2'))).toBeNull();
  });

  it('takes the background grid along (old-school blue) unless that is set too', () => {
    const blue = resolveStyle(withBg(styled('old-school-blue'), '#1A2540'));
    expect(blue.background).toBe('#1A2540');
    expect(blue.backgroundGrid).toEqual({ color: backgroundGridColour('#1A2540'), width: 0.03 });
    expect(contrastRatio(blue.backgroundGrid!.color, '#1A2540')).toBeGreaterThan(1.2);
    // on a light colour the grid is a shade darker
    const light = resolveStyle(withBg(styled('old-school-blue'), '#E6D7B8'));
    expect(relativeLuminance(light.backgroundGrid!.color)).toBeLessThan(relativeLuminance('#E6D7B8'));
    // the preset's own pair is matched by the same rule, roughly
    expect(contrastRatio(backgroundGridColour('#3674AC'), '#4D86BA')).toBeLessThan(1.05);
    const set = resolveStyle(withBg(styled('old-school-blue'), '#1A2540', { 'backgroundGrid.color': '#FF0000' }));
    expect(set.backgroundGrid!.color).toBe('#FF0000');
    const scene = buildScene(withBg(styled('old-school-blue'), '#1A2540'));
    expect(scene.layers.find((l) => l.name === 'background-grid')).toMatchObject({ color: backgroundGridColour('#1A2540') });
  });

  it('draws hatching in a lighter ink where its own would vanish, and leaves it where it reads', () => {
    for (const dark of ['#1A2540', '#000000', '#2F4A33']) {
      const s = resolveStyle(withBg(testMap(), dark));
      expect(s.hatching!.color, dark).not.toBe(PRESETS['classic-hatching']!.hatching!.color);
      expect(contrastRatio(s.hatching!.color, dark), dark).toBeGreaterThan(3);
    }
    for (const fine of ['#4A525C', '#FFFFFF', '#E6D7B8']) expect(resolveStyle(withBg(testMap(), fine)).hatching).toBe(PRESETS['classic-hatching']!.hatching);
    // print's black hatching on black, parchment's brown on night blue
    expect(resolveStyle(withBg(styled('print'), '#000000')).hatching!.color).not.toBe('#000000');
    expect(resolveStyle(withBg(styled('parchment'), '#1A2540')).hatching!.color).not.toBe('#3B2814');
    // an explicit hatching colour, or no hatching, is left alone
    expect(resolveStyle(withBg(testMap(), '#000000', { 'hatching.color': '#222222' })).hatching!.color).toBe('#222222');
    expect(resolveStyle(withBg(testMap(), '#000000', { hatching: null })).hatching).toBeNull();
    // other hatching overrides keep the adapted ink
    const wide = resolveStyle(withBg(testMap(), '#000000', { 'hatching.width': 1.2 }));
    expect(wide.hatching!.width).toBe(1.2);
    expect(wide.hatching!.color).not.toBe('#1A1A1A');
    const svg = renderSvg(withBg(testMap(), '#000000'));
    expect(svg).toMatch(/<g data-layer="hatching"[^>]*><path [^>]*stroke="#808080"/);
  });

  it('says so in the editor’s hints', () => {
    expect(backgroundHints(testMap())).toEqual([]);
    expect(backgroundHints(testMap(), '#1A2540').join(' ')).toContain('lighter ink');
    expect(backgroundHints(testMap(), '#4A525C').join(' ')).toContain('faintly');
    expect(backgroundHints(styled('old-school-blue'), '#FFFFFF').join(' ')).toContain('only their walls');
    expect(backgroundHints(styled('clean'), '#FFFFFF')).toEqual([]);
  });

  it('draws maps without it, or with the style’s own colour, byte for byte as before', () => {
    for (const preset of Object.keys(PRESETS)) {
      const plain = styled(preset);
      expect(resolveStyle(plain)).toBe(PRESETS[preset]);
      for (const view of ['gm', 'players'] as const) {
        const before = renderSvg(plain, { view });
        expect(renderSvg(withBg(plain, PRESETS[preset]!.background), { view }), `${preset} ${view}`).toBe(before);
        expect(renderSvg(withBg(plain, PRESETS[preset]!.background.toLowerCase()), { view }), `${preset} ${view}`).toBe(before);
      }
    }
    // other overrides resolve as they always did
    const old = { preset: 'classic-hatching', overrides: { 'walls.width': 0.2, hatching: null } };
    expect(resolveStyle({ style: old })).toEqual({ ...PRESETS['classic-hatching'], walls: { ...PRESETS['classic-hatching']!.walls, width: 0.2 }, hatching: null });
  });

  it('leaves the parchment handout on its own paper', () => {
    const map = testMap();
    expect(sha(handoutSvg(withBg(map, '#1A2540')).svg)).toBe(sha(handoutSvg(map).svg));
  });

  it('goes into the Dungeon Scrawl export, which keeps its usual paper without one', () => {
    const page = (m: DelveMap) => Object.values(toDungeonScrawl(m).state.document.nodes).find((n) => n.type === 'PAGE') as { background: { colour: { colour: number; alpha: number } } };
    expect(page(testMap()).background.colour).toEqual({ colour: 0xefeae2, alpha: 1 });
    expect(page(withBg(testMap(), '#1A2540')).background.colour).toEqual({ colour: 0x1a2540, alpha: 1 });
  });
});

describe('setting and resetting it', () => {
  it('is one update_map op that keeps the other overrides, and undoes', () => {
    const map = validateMap({ ...testMap(), style: { preset: 'classic-hatching', overrides: { 'grid.style': 'dots' } } });
    const ops = backgroundOps(map, '#2f4a33');
    expect(ops).toEqual([{ op: 'update_map', set: { style: { preset: 'classic-hatching', overrides: { 'grid.style': 'dots', background: '#2F4A33' } } } }]);
    const r = applyOps(map, ops);
    expect(mapBackground(r.map)).toBe('#2F4A33');
    expect(applyOps(r.map, r.inverse).map.style).toEqual(map.style);
    // reset: the key goes, the other override stays
    expect(withBackground(r.map, null)).toEqual({ preset: 'classic-hatching', overrides: { 'grid.style': 'dots' } });
    // reset with nothing else left drops the overrides object
    expect(withBackground(withBg(testMap(), '#000000'), null)).toEqual({ preset: 'classic-hatching' });
    // picking the style's own colour is a reset too
    expect(withBackground(withBg(testMap(), '#000000'), '#EFEAE2')).toEqual({ preset: 'classic-hatching' });
    expect(withBackground({}, '#123')).toEqual({ preset: 'classic-hatching', overrides: { background: '#112233' } });
    expect(() => withBackground(testMap(), 'teal')).toThrow(/colour like/);
  });

  it('stays with the map when the style changes in the editor', () => {
    const map = withBg(testMap(), '#1A2540', { 'grid.style': 'dots' });
    expect(withPreset(map, 'parchment')).toEqual({ preset: 'parchment', overrides: { background: '#1A2540' } });
    expect(withPreset(testMap(), 'clean')).toEqual({ preset: 'clean' });
    // a colour that is the new style's own needs no override there
    expect(withPreset(withBg(testMap(), '#FFFFFF'), 'clean')).toEqual({ preset: 'clean' });
  });

  it('reads typed input: hex in any spelling, or "reset"', () => {
    expect(parseBackground('#1a2540')).toBe('#1A2540');
    expect(parseBackground('1a2540')).toBe('#1A2540');
    expect(parseBackground('#fff')).toBe('#FFFFFF');
    for (const reset of ['reset', 'RESET', ' style ', 'default', '', null, undefined]) expect(parseBackground(reset), String(reset)).toBeNull();
    for (const bad of ['blue', '#12345', '#GG0000', 7]) expect(() => parseBackground(bad), String(bad)).toThrow(/must be a colour like "#2F4A33"/);
  });

  it('is checked when a map is saved', () => {
    expect(() => validateMap(withBg(testMap(), '#abc'))).not.toThrow();
    expect(() => validateMap(withBg(testMap(), '#1A2540'))).not.toThrow();
    for (const bad of ['red', '#12', '1A2540', '#1A2540FF']) expect(() => validateMap(withBg(testMap(), bad)), bad).toThrow(/style\.overrides\.background: must be a colour/);
    const nulled = { ...testMap(), style: { preset: 'classic-hatching', overrides: { background: null } } };
    expect(() => validateMap(nulled)).toThrow(/style\.overrides\.background/);
    // an update_map that sets a bad one is refused, all or nothing
    expect(() => applyOps(testMap(), [{ op: 'update_map', set: { style: { preset: 'clean', overrides: { background: 'night' } } } }])).toThrow(/background/);
  });
});
