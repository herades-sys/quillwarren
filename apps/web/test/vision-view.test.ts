// The table client's dynamic-vision helpers: folding vision messages, how dark
// things are drawn for whom, hitting doors, and the GM's look as the players.
import { describe, expect, it } from 'vitest';
import type { Page, PageDoor, Token, VisionView } from '@delve/table';
import { darknessPolygons, doorAt, doorLook, fogAlphas, fogResolution, hasFog, mergeVision, overlayLights, previewTokens, reloadDelay } from '../src/table/vision-view.ts';

const sq = (x0: number, y0: number, x1: number, y1: number) => ({ outer: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][], holes: [] });
const view = (over: Partial<VisionView> = {}): VisionView => ({ pageId: 'pg1', visible: [sq(0, 0, 2, 2)], bright: [], exploredVersion: 1, ambient: 'dark', ...over });
const page = (over: Partial<Page> = {}): Page => ({
  id: 'pg1',
  name: 'Crypt',
  width: 20,
  height: 10,
  origin: [0, 0],
  cellPx: 70,
  cellUnit: '5 ft',
  showGrid: true,
  background: { kind: 'delve', mapId: 'm1' },
  vision: { mode: 'dynamic' },
  ...over,
});
const tok = (id: string, over: Partial<Token> = {}): Token => ({ id, pageId: 'pg1', layer: 'tokens', x: 0, y: 0, w: 1, h: 1, image: '/x.png', controlledBy: [], ...over });

describe('vision messages', () => {
  it('keep the explored fog when a message leaves it out, and drop it on another page', () => {
    const a = mergeVision(null, 'pg1', view({ explored: [sq(0, 0, 5, 5)] }))!;
    expect(a.explored).toEqual([sq(0, 0, 5, 5)]);
    const b = mergeVision(a, 'pg1', view({ visible: [sq(1, 1, 3, 3)], exploredVersion: 1 }))!;
    expect(b.explored).toEqual([sq(0, 0, 5, 5)]);
    expect(b.visible).toEqual([sq(1, 1, 3, 3)]);
    expect(mergeVision(b, 'pg2', view({ pageId: 'pg2' }))!.explored).toEqual([]);
    expect(mergeVision(b, 'pg1', view({ explored: 'all', exploredVersion: 2 }))!.explored).toBe('all');
    expect(mergeVision(b, 'pg1', null)).toBeNull();
    expect(mergeVision(null, 'pg1', view({ seen: ['k1'] }))!.seen).toEqual(new Set(['k1']));
  });
});

describe('darkness', () => {
  it('is real for players and for the GM looking as them, a faint hint otherwise', () => {
    expect(fogAlphas(false, 'gm')).toEqual(fogAlphas(true, 'players'));
    expect(fogAlphas(false, 'players').unexplored).toBe(1);
    expect(fogAlphas(true, 'gm').unexplored).toBeLessThan(0.5);
    expect(hasFog(page())).toBe(true);
    expect(hasFog(page({ vision: undefined }))).toBe(false);
    expect(hasFog(null)).toBe(false);
    expect(fogResolution(20, 10)).toBe(16);
    expect(fogResolution(400, 100)).toBe(5);
    expect(fogResolution(5000, 10)).toBe(2);
  });
});

describe('doors and lights for the GM', () => {
  const doors: PageDoor[] = [
    { id: 'd1', a: [10, 4], b: [10, 6], style: 'normal' },
    { id: 'a1', a: [12, 4], b: [12, 6], style: 'archway' },
    { id: 's1', a: [4, 10], b: [6, 10], style: 'secret' },
  ];
  it('finds the door under the pointer, never an archway', () => {
    expect(doorAt(doors, 10.1, 5, 0.3)?.id).toBe('d1');
    expect(doorAt(doors, 10.5, 5, 0.3)).toBeNull();
    expect(doorAt(doors, 12, 5, 0.3)).toBeNull();
    expect(doorAt(doors, 5, 9.9, 0.3)?.id).toBe('s1');
    expect(doorAt(undefined, 0, 0, 1)).toBeNull();
  });

  it('shows doors open, shut or secret by the table’s state', () => {
    expect(doorLook({}, doors[0]!)).toEqual({ state: 'shut', blocks: true });
    expect(doorLook({ doorState: { d1: true } }, doors[0]!)).toEqual({ state: 'open', blocks: false });
    expect(doorLook({}, doors[2]!)).toEqual({ state: 'secret', blocks: true });
    expect(doorLook({ doorState: { s1: true } }, doors[2]!).state).toBe('open');
    expect(doorLook({}, { id: 'p', a: [0, 0], b: [1, 0], style: 'portcullis' })).toEqual({ state: 'shut', blocks: false });
  });

  it('lists the map’s lights and the tokens’', () => {
    const p = page({ lights: [{ id: 'l1', x: 3, y: 3, bright: 4, dim: 4 }] });
    expect(overlayLights(p, [tok('k1', { light: { bright: 1, dim: 2 } })])).toEqual([
      { x: 3, y: 3, bright: 4, dim: 4 },
      { x: 0.5, y: 0.5, bright: 1, dim: 2 },
    ]);
  });
});

describe('the GM looking as the players', () => {
  it('shows the tokens the party sees and the players’ own, never the gm layer', () => {
    const tokens = [tok('pc', { controlledBy: ['p1'] }), tok('seen'), tok('unseen'), tok('boss', { layer: 'gm' })];
    const v = mergeVision(null, 'pg1', view({ seen: ['seen', 'pc'] }));
    expect(previewTokens(tokens, page(), v).map((t) => t.id)).toEqual(['pc', 'seen']);
    expect(previewTokens(tokens, page(), null).map((t) => t.id)).toEqual(['pc']);
    expect(previewTokens(tokens, page({ vision: { mode: 'off' } }), v).map((t) => t.id)).toEqual(['pc', 'seen', 'unseen']);
  });

  it('fetches the picture again at most about once a gap', () => {
    expect(reloadDelay(10_000, 0, 900)).toBe(0);
    expect(reloadDelay(10_000, 9_500, 900)).toBe(400);
  });
});

describe('darkness in the 3D view', () => {
  it('covers the page except what the party sees, with the shadows inside sight dark again', () => {
    const ring = { outer: sq(2, 2, 8, 6).outer, holes: [sq(4, 3, 5, 4).outer] };
    const dark = darknessPolygons({ x0: 0, y0: 0, x1: 20, y1: 10 }, [ring, sq(10, 2, 12, 4)]);
    expect(dark[0]!.outer).toEqual(sq(0, 0, 20, 10).outer);
    expect(dark[0]!.holes).toEqual([ring.outer, sq(10, 2, 12, 4).outer]);
    expect(dark.slice(1)).toEqual([{ outer: sq(4, 3, 5, 4).outer, holes: [] }]);
    expect(darknessPolygons({ x0: 0, y0: 0, x1: 1, y1: 1 }, [])).toEqual([{ outer: sq(0, 0, 1, 1).outer, holes: [] }]);
  });
});
