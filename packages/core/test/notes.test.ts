// GM notes on rooms, corridors and terrain: which area a click picks, where its
// hint goes, which changes touch nothing but notes, and that Claude's text view
// lists them while no picture or export carries them.
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  areaTitle,
  assetInfo,
  buildScene,
  describeMap,
  noteAnchor,
  noteAreaAt,
  noteAreasAt,
  notedAreas,
  notesOnly,
  notesOps,
  sceneToSvg,
  toDungeonScrawl,
  type DelveMap,
  type MapObject,
} from '../src/index.ts';
import { testMap } from './fixtures.ts';

const SECRET = 'Cult leader + 4 acolytes. Pillars give half cover.';

function withObjects(...objects: MapObject[]): DelveMap {
  return applyOps(testMap(), objects.map((object) => ({ op: 'add', object }))).map;
}

describe('picking a note area', () => {
  it('finds the room, then the corridor, under a point', () => {
    const map = testMap();
    expect(noteAreaAt(map, [8, 5])?.id).toBe('r5');
    expect(noteAreaAt(map, [9, 27])?.id).toBe('r1');
    expect(noteAreaAt(map, [10, 23])?.id).toBe('c1'); // between r1 and r2
    expect(noteAreaAt(map, [0.5, 0.5])).toBeNull();
    // the edge of a room counts
    expect(noteAreaAt(map, [7, 25])?.id).toBe('r1');
  });

  it('puts the topmost room first, then corridors, then terrain', () => {
    const map = withObjects(
      { id: 'r7', type: 'room', shape: { rect: [5, 2, 2, 2] }, label: '7', name: 'Alcove' },
      { id: 't1', type: 'terrain', asset: 'water-shallow', shape: { rect: [4.5, 1.5, 3, 3] } },
    );
    expect(noteAreasAt(map, [5.5, 2.5]).map((o) => o.id)).toEqual(['r7', 'r5', 't1']);
    expect(noteAreasAt(map, [4.75, 1.75]).map((o) => o.id)).toEqual(['r5', 't1']);
  });

  it('leaves out a terrain hole and corridor ends, keeps square corners', () => {
    const map = withObjects(
      { id: 't2', type: 'terrain', asset: 'grass', shape: { rect: [30, 0, 10, 10] }, holes: [[[33, 3], [37, 3], [37, 7], [33, 7]]] },
      { id: 'c9', type: 'corridor', width: 2, path: [[50, 0], [54, 0], [54, 4]] },
    );
    expect(noteAreaAt(map, [31, 1])?.id).toBe('t2');
    expect(noteAreaAt(map, [35, 5])).toBeNull();
    expect(noteAreaAt(map, [54.9, -0.9])?.id).toBe('c9'); // the corner's square join
    expect(noteAreaAt(map, [52, 0.9])?.id).toBe('c9');
    expect(noteAreaAt(map, [49.5, 0])).toBeNull(); // past the butt end
    expect(noteAreaAt(map, [52, 1.1])).toBeNull();
    // an auto-routed corridor follows its rooms
    const auto = withObjects({ id: 'c8', type: 'corridor', from: 'r3', to: 'r4', width: 1 });
    const at = noteAnchor(auto, auto.objects.find((o) => o.id === 'c8') as never)!;
    expect(noteAreasAt(auto, at).map((o) => o.id)).toContain('c8');
  });
});

describe('titles and hints', () => {
  it('names rooms by number and name, corridors by their rooms, terrain by its kind', () => {
    const map = withObjects({ id: 't1', type: 'terrain', asset: 'water-shallow', shape: { rect: [8, 4, 3, 3] } }, { id: 'r8', type: 'room', shape: { rect: [40, 40, 2, 2] } });
    const get = (id: string) => map.objects.find((o) => o.id === id) as never;
    expect(areaTitle(map, get('r5'))).toBe('5 Boss chamber');
    expect(areaTitle(map, get('r8'))).toBe('Room r8');
    expect(areaTitle(map, get('c1'))).toBe('Corridor 1–2');
    expect(areaTitle(map, get('t1'))).toBe(assetInfo('water-shallow')!.name);
  });

  it('anchors the hint by a room number and half way along a corridor', () => {
    const map = testMap();
    const get = (id: string) => map.objects.find((o) => o.id === id) as never;
    expect(noteAnchor(map, get('r1'))).toEqual([10, 28]);
    expect(noteAnchor(map, get('c1'))).toEqual([10, 23]);
    expect(notedAreas(map).map((o) => o.id)).toEqual(['r5']);
  });
});

describe('changes to notes', () => {
  it('knows when ops touch nothing but notes', () => {
    expect(notesOnly([{ op: 'update', id: 'r5', set: { notes: 'x' } }])).toBe(true);
    expect(notesOnly([{ op: 'update', id: 'r5', unset: ['notes'] }])).toBe(true);
    expect(notesOnly([{ op: 'batch', ops: [{ op: 'update', id: 'r5', set: { notes: 'x' } }, { op: 'update', id: 'c1', set: { notes: 'y' } }] }])).toBe(true);
    expect(notesOnly([{ op: 'update', id: 'r5', set: { notes: 'x', name: 'Hall' } }])).toBe(false);
    expect(notesOnly([{ op: 'update', id: 'r5', set: { notes: 'x' } }, { op: 'move', ids: ['r5'], dx: 1, dy: 0 }])).toBe(false);
    expect(notesOnly([{ op: 'update', id: 'r5', set: {} }])).toBe(false);
    expect(notesOnly([])).toBe(false);
  });

  it('writes notes, removes blank ones, and keeps the schema limit', () => {
    expect(notesOps('r1', 'Two ogres')).toEqual([{ op: 'update', id: 'r1', set: { notes: 'Two ogres' } }]);
    expect(notesOps('r1', '  \n ')).toEqual([{ op: 'update', id: 'r1', unset: ['notes'] }]);
    const map = applyOps(testMap(), notesOps('c1', 'Slippery')).map;
    expect(map.objects.find((o) => o.id === 'c1')).toMatchObject({ notes: 'Slippery' });
    expect(() => applyOps(testMap(), notesOps('r1', 'x'.repeat(10_001)))).toThrow(/notes/);
  });
});

describe('where notes show', () => {
  it('lists them for Claude and the GM in describeMap', () => {
    const map = applyOps(testMap(), notesOps('c1', 'Slick with oil\nDC 10')).map;
    const text = describeMap(map);
    expect(text).toContain('GM notes (GM only, never drawn):');
    expect(text).toContain(`  5 Boss chamber [r5]: ${JSON.stringify(SECRET)}`);
    expect(text).toContain('  Corridor 1–2 [c1]: "Slick with oil\\nDC 10"');
    expect(describeMap(map, { notesMax: 10 })).toContain('  5 Boss chamber [r5]: "Cult lead…"');
  });

  it('never draws them, in either view, nor exports them to Dungeon Scrawl', () => {
    const map = applyOps(testMap(), [...notesOps('c1', 'corridor-secret'), ...notesOps('r1', 'room-secret')]).map;
    for (const view of ['gm', 'players'] as const) {
      const svg = sceneToSvg(buildScene(map, { view }));
      for (const s of ['Cult leader', 'corridor-secret', 'room-secret']) expect(svg).not.toContain(s);
      const ds = JSON.stringify(toDungeonScrawl(map, { view }));
      for (const s of ['Cult leader', 'corridor-secret', 'room-secret']) expect(ds).not.toContain(s);
    }
  });
});
