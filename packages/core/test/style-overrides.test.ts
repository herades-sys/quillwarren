// A map's style overrides are checked when a map is written (only known
// settings, hex colours, numbers in range), and whatever a stored map holds is
// escaped when it is drawn, so an old map with a bad value can't put markup
// into the SVG that the editor, the players' screen and render.svg inline.
import { describe, expect, it } from 'vitest';
import { applyOps, recolor, recolour, renderSvg, validateMap, ValidationError, type DelveMap } from '../src/index.ts';
import { testMap } from './fixtures.ts';

const EVIL = 'red"/><script>alert(1)</script>';
const styled = (overrides: Record<string, unknown>): DelveMap => ({ ...testMap(), style: { preset: 'classic-hatching', overrides } });

/** The problems validateMap lists for a map with these overrides (none: []). */
function problems(overrides: Record<string, unknown>): string[] {
  try {
    validateMap(styled(overrides));
    return [];
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    return e.problems;
  }
}

describe('style overrides when a map is written', () => {
  it('take the settings the editor, set_map and the chat prompt use', () => {
    for (const o of [
      { 'walls.width': 0.2, 'walls.color': '#333333', 'walls.roughness': 0.5 },
      { 'floor.color': '#F0E0C0' },
      { 'grid.style': 'dots', 'grid.opacity': 0.4 },
      { hatching: null, shading: null },
      { 'labels.size': 1.2 },
      { background: '#2F4A33', 'grid.style': 'none' },
      { grid: { color: '#ff0000' } },
      { shadow: { offset: [0.2, 0.2] }, 'terrain.gray': true, 'labels.font': 'IM FELL English', 'props.ink': '#abc' },
    ]) expect(problems(o), JSON.stringify(o)).toEqual([]);
  });

  it('refuse unknown settings, colours that are not hex, and values out of range, naming the setting', () => {
    expect(problems({ walls: { color: EVIL } })).toEqual([`style.overrides.walls.color: must be a colour like "#2F4A33", not ${JSON.stringify(EVIL)}`]);
    expect(problems({ 'doors.fill': 'red' })).toEqual(['style.overrides.doors.fill: must be a colour like "#2F4A33", not "red"']);
    expect(problems({ 'walls.colour': '#000000' })).toEqual(['style.overrides.walls.colour: unknown field (walls has color, width, roughness, sketch)']);
    expect(problems({ script: '<x>' })[0]).toMatch(/^style\.overrides\.script: unknown style setting \(known: background, backgroundGrid, floor, walls/);
    expect(problems({ 'hatching.spacing': 0.0001 })).toEqual(['style.overrides.hatching.spacing: must be a number from 0.1 to 3, not 0.0001']);
    expect(problems({ 'grid.style': 'stripes' })[0]).toMatch(/grid\.style: must be "lines", "dots" or "none"/);
    expect(problems({ 'labels.font': 'x" onload="y' })[0]).toMatch(/labels\.font: must be a font name/);
    expect(problems({ 'shadow.offset': [1, 'x'] })[0]).toMatch(/shadow\.offset: must be \[x, y\]/);
    expect(problems({ walls: null })[0]).toMatch(/walls: can't be null \(only backgroundGrid, shading, hatching, shadow can be switched off\)/);
    expect(problems({ walls: '#000000' })[0]).toMatch(/walls: must be its fields/);
    // a long value is cut short in the message
    expect(problems({ 'walls.color': 'x'.repeat(500) })[0]!.length).toBeLessThan(200);
  });

  it('refuse a bad override sent as an update_map op', () => {
    const set = { style: { preset: 'classic-hatching', overrides: { walls: { color: EVIL } } } };
    expect(() => applyOps(testMap(), [{ op: 'update_map', set }])).toThrow(/style\.overrides\.walls\.color: must be a colour/);
  });

  it('keep maps saved before the check editable: settings an edit leaves alone are not checked again', () => {
    // e.g. a CSS colour name that set_map let through before
    const old = styled({ 'walls.color': 'red', 'grid.style': 'dots' });
    expect(applyOps(old, [{ op: 'update_map', set: { name: 'Renamed' } }]).map.name).toBe('Renamed');
    expect(applyOps(old, [{ op: 'move', ids: ['r1'], dx: 1, dy: 0 }]).map.style).toEqual(old.style);
    // changing another setting keeps the old one as it is
    const grid = { style: { preset: 'classic-hatching', overrides: { 'walls.color': 'red', 'grid.style': 'lines' } } };
    expect(() => applyOps(old, [{ op: 'update_map', set: grid }])).not.toThrow();
    // a new bad value is refused
    const blue = { style: { preset: 'classic-hatching', overrides: { 'walls.color': 'blue' } } };
    expect(() => applyOps(old, [{ op: 'update_map', set: blue }])).toThrow(/walls\.color/);
    // and a new map with it is refused outright
    expect(() => validateMap(old)).toThrow(/style\.overrides\.walls\.color/);
  });
});

describe('drawing a map that holds a bad value anyway', () => {
  it('escapes every style value it writes into the SVG', () => {
    const map = styled({
      background: EVIL,
      walls: { color: EVIL },
      floor: { color: EVIL },
      doors: { fill: EVIL, stroke: EVIL },
      grid: { color: EVIL },
      labels: { color: EVIL, numberFont: EVIL },
      hatching: { color: EVIL },
      shading: { color: EVIL },
      shadow: { color: EVIL },
      stairs: { color: EVIL },
    });
    for (const view of ['gm', 'players'] as const) {
      const svg = renderSvg(map, { view });
      expect(svg).not.toContain('<script');
      expect(svg).not.toContain('"/><script');
      expect(svg).toContain('red&quot;/&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  });

  it('escapes the props’ inks it swaps into their art', () => {
    const palette = { ink: EVIL, paper: '#FFFFFF', shade: '#999999' };
    expect(recolor('<path fill="#000000" stroke="#999999"/>', palette)).toBe('<path fill="red&quot;/&gt;&lt;script&gt;alert(1)&lt;/script&gt;" stroke="#999999"/>');
    expect(recolour('<path fill="#2B2620"/>', new Map([['#2B2620', EVIL]]))).not.toContain('<script');
  });
});
