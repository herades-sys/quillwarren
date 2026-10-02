// Handwritten notes on the parchment handout: the inscription object.
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  buildScene,
  collectSegment,
  countsText,
  describeMap,
  handoutSvg,
  INSCRIPTION_INK,
  inscriptionBounds,
  inscriptionNear,
  inscriptionSvg,
  objectBounds,
  placeSegmentOps,
  resolveStyle,
  sceneToSvg,
  segmentCounts,
  toDungeonScrawl,
  turnSegment,
  validateMap,
  type DelveMap,
  type Inscription,
} from '../src/index.ts';
import { testMap } from './fixtures.ts';

const DRAGONS: Inscription = { id: 'w1', type: 'inscription', text: 'Here be dragons', at: [22, 3], rotation: -4 };
const CRYPT: Inscription = { id: 'w2', type: 'inscription', text: 'Beware the crypt!\nNone return.', at: [8, 30], size: 1.1, ink: 'red', rotation: 3, onMap: true };

const withNotes = (...notes: Inscription[]): DelveMap => {
  const map = testMap();
  map.objects.push(...(notes.length ? notes : [DRAGONS, CRYPT]));
  return validateMap(map);
};
const count = (s: string, part: string) => s.split(part).length - 1;

describe('handwritten handout notes', () => {
  it('are map objects with text, a spot, a size, a tilt, an ink and "on the map"', () => {
    expect(() => withNotes()).not.toThrow();
    const bad = (o: Record<string, unknown>) => () => withNotes({ ...DRAGONS, ...o } as Inscription);
    expect(bad({ text: 'x'.repeat(301) })).toThrow(/text/);
    expect(bad({ text: '  \n ' })).toThrow(/blank/);
    expect(bad({ text: '' })).toThrow(/text/);
    expect(bad({ ink: 'blue' })).toThrow(/ink/);
    expect(bad({ size: 0 })).toThrow(/size/);
    expect(bad({ size: 25 })).toThrow(/size/);
    expect(bad({ rotation: 200 })).toThrow(/rotation/);
    expect(bad({ colour: 'red' })).toThrow(/unknown field "colour"/);
    expect(() => withNotes({ ...DRAGONS, text: 'x'.repeat(300) })).not.toThrow();
  });

  it('are added, changed, moved and deleted with ops, and every step undoes exactly', () => {
    const map = testMap();
    const steps = [
      [{ op: 'add', object: CRYPT }],
      [{ op: 'update', id: 'w2', set: { text: 'Turn back', ink: 'black' }, unset: ['onMap'] }],
      [{ op: 'move', ids: ['w2'], dx: 2, dy: -1.5 }],
      [{ op: 'delete', ids: ['w2'] }],
    ] as const;
    let cur = map;
    for (const ops of steps) {
      const { map: next, inverse } = applyOps(cur, ops as never);
      expect(applyOps(next, inverse).map).toEqual(cur);
      cur = next;
    }
    const moved = applyOps(applyOps(map, [{ op: 'add', object: CRYPT }]).map, [{ op: 'move', ids: ['w2'], dx: 2, dy: -1.5 }]).map;
    expect(moved.objects.find((o) => o.id === 'w2')).toMatchObject({ at: [10, 28.5] });
    expect(() => applyOps(map, [{ op: 'add', object: { ...CRYPT, ink: 'green' } as unknown as Inscription }])).toThrow(/ink/);
  });

  it('are written on the handout in IM FELL English Italic, wobbling by hand but the same every time', () => {
    const { svg } = handoutSvg(withNotes());
    expect(svg).toContain('data-layer="inscriptions"');
    expect(svg).toMatch(/<g data-inscription="w1" transform="rotate\(-4 22 3\)" font-family="IM FELL English, Georgia, serif" font-style="italic"/);
    // one <text> per line, a <tspan> per word, in the note's ink
    const crypt = /<g data-inscription="w2"[\s\S]*?<\/text><\/g>/.exec(svg)![0];
    expect(count(crypt, '<text ')).toBe(2);
    expect(count(crypt, '<tspan ')).toBe(5);
    expect(crypt).toContain(`fill="${INSCRIPTION_INK.red.color}"`);
    expect(crypt).toContain('>crypt!</tspan>');
    // drawn once, though w2 is on the map too, and outside the map's own frame (free to run into the margin)
    expect(count(svg, 'data-inscription="w2"')).toBe(1);
    expect(svg.indexOf('data-inscription')).toBeGreaterThan(svg.indexOf('</svg>'));
    expect(svg).not.toContain('feDisplacementMap');
    expect(handoutSvg(withNotes()).svg).toBe(svg);
    // another seed, another hand
    expect(inscriptionSvg(CRYPT, 1)).not.toBe(inscriptionSvg(CRYPT, 2));
    expect(inscriptionSvg(CRYPT, 1)).toBe(inscriptionSvg(CRYPT, 1));
  });

  it('can be left out of the handout (the page draws them itself), and say where the map sits on the sheet', () => {
    const map = withNotes();
    const h = handoutSvg(map, { inscriptions: false });
    expect(h.svg).not.toContain('data-inscription');
    // the frame: the square (x0, y0) at (x, y) points, k points per square
    expect(h.frame.k).toBeGreaterThan(10);
    expect(h.frame.x).toBeGreaterThan(0);
    const { x0, y0 } = buildScene(map, { view: 'players', margin: 0.5 }, resolveStyle({ style: { preset: 'parchment' } })).bounds;
    expect([h.frame.x0, h.frame.y0]).toEqual([x0, y0]);
    expect(handoutSvg(map).svg).toContain(`<g data-layer="inscriptions" transform="translate(${Math.round(h.frame.x * 100) / 100} `);
  });

  it('are on the normal map only with onMap, in both views, and fog never hides them', () => {
    const map = withNotes();
    for (const view of ['gm', 'players'] as const) {
      const scene = buildScene(map, { view });
      const layer = scene.layers.find((l) => l.kind === 'inscriptions');
      expect(layer?.kind === 'inscriptions' && layer.items.map((o) => o.id)).toEqual(['w2']);
      const svg = sceneToSvg(scene);
      expect(svg).toContain('data-inscription="w2"');
      expect(svg).toContain('font-style="italic"');
      expect(svg).not.toContain('data-inscription="w1"');
    }
    const off = withNotes({ ...CRYPT, onMap: false });
    expect(buildScene(off).layers.some((l) => l.kind === 'inscriptions')).toBe(false);
    // fog: nothing revealed, yet the note is drawn for the players (and on the handout of what they've seen)
    const fogged: DelveMap = { ...map, fog: { on: true, revealed: ['r1'] } };
    expect(sceneToSvg(buildScene(fogged, { view: 'players', fog: 'hide', fullBounds: true }))).toContain('data-inscription="w2"');
    const stirs: Inscription = { id: 'w3', type: 'inscription', text: 'Something stirs', at: [10, 23] };
    expect(handoutSvg({ ...fogged, objects: [...fogged.objects, stirs] }, { revealedOnly: true }).svg).toContain('data-inscription="w3"');
  });

  it('leave out notes far off the picture, which resvg could not draw', () => {
    const far: Inscription = { id: 'w9', type: 'inscription', text: 'far away', at: [400, -300], onMap: true };
    const huge: Inscription = { id: 'w8', type: 'inscription', text: 'A huge note that runs far past both edges of the sheet, on and on', at: [10, 20], size: 20, onMap: true };
    const map = withNotes(DRAGONS, CRYPT, far, huge);
    const sheet = handoutSvg(map).svg;
    expect(sheet).toContain('data-inscription="w1"');
    expect(sheet).not.toContain('data-inscription="w9"');
    expect(sheet).not.toContain('data-inscription="w8"');
    expect(sceneToSvg(buildScene(map))).not.toContain('data-inscription="w9"');
    const area = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(inscriptionNear({ text: 'ok', at: [5, 5] }, area, 0)).toBe(true);
    expect(inscriptionNear({ text: 'ok', at: [12, 5] }, area, 0)).toBe(false);
    expect(inscriptionNear({ text: 'ok', at: [12, 5] }, area, 4)).toBe(true);
  });

  it('cover a box turned with them, for picking and zooming', () => {
    const flat = inscriptionBounds({ text: 'Here be dragons', at: [10, 10] });
    expect(flat.x1 - flat.x0).toBeCloseTo(15 * 0.8 * 0.42);
    expect(flat.y1 - flat.y0).toBeCloseTo(0.8 * 1.2);
    const upright = inscriptionBounds({ text: 'Here be dragons', at: [10, 10], rotation: 90 });
    expect(upright.y1 - upright.y0).toBeCloseTo(flat.x1 - flat.x0);
    expect(objectBounds(DRAGONS, testMap())).toEqual(inscriptionBounds(DRAGONS));
    // a line per line break, the widest line sets the width
    const two = inscriptionBounds({ text: 'a\nlonger line', at: [0, 0], size: 1 });
    expect(two.y1 - two.y0).toBeCloseTo(2.4);
    expect(two.x1 - two.x0).toBeCloseTo(11 * 0.42);
  });

  it('are listed by describeMap as handout notes', () => {
    const text = describeMap(withNotes());
    expect(text).toContain("Handout notes (handwritten on the players' parchment handout; players see them):");
    expect(text).toContain('w1 at 22,3 outside rooms (brown ink, tilted -4°, handout only): "Here be dragons"');
    expect(text).toContain('w2 at 8,30 in 1 Entrance hall (red ink, size 1.1, tilted 3°, also on the map): "Beware the crypt!\\nNone return."');
    expect(text).not.toContain('Also:');
  });

  it('travel with segments, staying upright when one turns, and are left out of Dungeon Scrawl files', () => {
    const map = withNotes();
    const seg = collectSegment(map, { rect: [0, 25, 20, 10] });
    expect(seg.objects.some((o) => o.type === 'inscription')).toBe(true);
    expect(countsText(segmentCounts(seg.objects))).toContain('1 handout note');
    const turned = turnSegment(seg, 90).objects.find((o) => o.type === 'inscription');
    expect(turned).toMatchObject({ rotation: 3 });
    const placed = placeSegmentOps(map, seg, [40, 40]);
    const copy = placed.ops.map((o) => (o.op === 'add' ? o.object : null)).find((o) => o?.type === 'inscription');
    expect(copy?.id).toBe('w3');
    expect(JSON.stringify(toDungeonScrawl(map))).toBe(JSON.stringify(toDungeonScrawl(testMap())));
  });

  it('draws plain text and strokes only: no filters', () => {
    const svg = inscriptionSvg(CRYPT, 1234);
    expect(svg).not.toMatch(/filter|feDisplacementMap|<image/);
    expect(svg).toContain('paint-order="stroke"');
    expect(inscriptionSvg({ ...CRYPT, text: 'a <b> & "c"' }, 1)).toContain('>&lt;b&gt;</tspan>');
  });
});
