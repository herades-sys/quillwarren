// Props hidden from players: traps such as pressure plates are secret until
// found, any prop can be hidden, and GM symbols never show for players.
import { describe, expect, it } from 'vitest';
import { buildScene, describeMap, HIDDEN_ASSETS, propHidden, sceneToSvg, validateMap, type DelveMap, type Prop } from '../src/index.ts';
import { testMap } from './fixtures.ts';

const withProps = (...props: Omit<Prop, 'type'>[]): DelveMap => {
  const map = testMap();
  map.objects.push(...props.map((p) => ({ type: 'prop' as const, ...p })));
  return validateMap(map);
};
/** The asset ids drawn in a view. */
const drawn = (map: DelveMap, view: 'gm' | 'players'): string[] =>
  buildScene(map, { view }).layers.flatMap((l) => ('items' in l && Array.isArray(l.items) ? (l.items as { asset?: string }[]).flatMap((i) => (i.asset ? [i.asset] : [])) : []));

describe('hidden props', () => {
  it('hide traps from players by default, and show the rest', () => {
    const map = withProps({ id: 'hp1', asset: 'pressure-plate', at: [12.5, 5.5] }, { id: 'hp2', asset: 'spike-trap', at: [13.5, 5.5] }, { id: 'hp3', asset: 'barrel', at: [14.5, 5.5] }, { id: 'hp4', asset: 'pit', at: [15.5, 5.5] });
    expect(drawn(map, 'gm')).toEqual(expect.arrayContaining(['pressure-plate', 'spike-trap', 'barrel', 'pit']));
    const players = drawn(map, 'players');
    expect(players).toEqual(expect.arrayContaining(['barrel', 'pit'])); // an open pit is plain to see
    expect(players).not.toContain('pressure-plate');
    expect(players).not.toContain('spike-trap');
    expect(sceneToSvg(buildScene(map, { view: 'players' }))).not.toContain('pressure-plate');
    expect([...HIDDEN_ASSETS].sort()).toEqual(['pressure-plate', 'rune', 'spike-trap']);
  });

  it('let the GM show a found trap, or hide any prop', () => {
    const map = withProps({ id: 'hp1', asset: 'pressure-plate', at: [12.5, 5.5], gmOnly: false }, { id: 'hp2', asset: 'chest', at: [13.5, 5.5], gmOnly: true });
    const players = drawn(map, 'players');
    expect(players).toContain('pressure-plate');
    expect(players).not.toContain('chest');
    expect(drawn(map, 'gm')).toContain('chest');
  });

  it('never show GM symbols to players, whatever the prop says', () => {
    expect(propHidden({ asset: 'trap' })).toBe(true); // "Trap Marker", a GM symbol
    expect(propHidden({ asset: 'trap', gmOnly: false })).toBe(true);
    expect(propHidden({ asset: 'barrel' })).toBe(false);
    expect(propHidden({ asset: 'rune' })).toBe(true);
  });

  it('keep the players’ picture the same size as the GM’s', () => {
    // a hidden trap far outside the rooms must not grow (or shrink) the players' picture differently
    const map = withProps({ id: 'hp1', asset: 'pressure-plate', at: [40.5, 40.5] });
    const gm = buildScene(map, { view: 'gm', fullBounds: true }).bounds;
    expect(buildScene(map, { view: 'players', fullBounds: true }).bounds).toEqual(gm);
  });

  it('are listed for Claude as hidden', () => {
    const text = describeMap(withProps({ id: 'hp1', asset: 'pressure-plate', at: [12.5, 5.5] }, { id: 'hp2', asset: 'barrel', at: [13.5, 5.5] }));
    expect(text).toMatch(/Pressure Plate \(hp1; hidden from players\)/);
    expect(text).toMatch(/Barrel \(hp2\)/);
  });
});
