import { MAX_CROP } from '@delve/core';
import { describe, expect, it } from 'vitest';
import {
  adjust,
  boxFromDrag,
  cursorFor,
  DEFAULT_OPTIONS,
  fileNameOf,
  handleAt,
  keyAdjust,
  memoryKey,
  parseMemory,
  sizeLabel,
  sizeProblem,
  snipUrls,
} from '../src/snip-logic.ts';

const B = { x0: 2, y0: 3, x1: 10, y1: 7 };

describe('boxFromDrag', () => {
  it('takes every square the drag touches, whichever way it goes', () => {
    expect(boxFromDrag([2.4, 3.9], [9.1, 6.2])).toEqual({ x0: 2, y0: 3, x1: 10, y1: 7 });
    expect(boxFromDrag([9.1, 6.2], [2.4, 3.9])).toEqual({ x0: 2, y0: 3, x1: 10, y1: 7 });
    expect(boxFromDrag([-1.5, -0.2], [0.5, 1])).toEqual({ x0: -2, y0: -1, x1: 1, y1: 1 });
  });

  it('keeps exact grid lines (no extra square for floating point) and is never empty', () => {
    expect(boxFromDrag([2, 3], [10.0000000001, 7])).toEqual(B);
    expect(boxFromDrag([4.2, 4.2], [4.6, 4.3])).toEqual({ x0: 4, y0: 4, x1: 5, y1: 5 });
  });

  it('stops at MAX_CROP squares, keeping the corner the drag started from', () => {
    expect(boxFromDrag([0, 0], [MAX_CROP + 50, 3])).toEqual({ x0: 0, y0: 0, x1: MAX_CROP, y1: 3 });
    expect(boxFromDrag([MAX_CROP + 50, 3], [0, 0])).toEqual({ x0: 50, y0: 0, x1: MAX_CROP + 50, y1: 3 });
  });
});

describe('adjust', () => {
  it('moves the whole box by whole squares', () => {
    expect(adjust(B, 'move', 1.4, -2.6)).toEqual({ x0: 3, y0: 0, x1: 11, y1: 4 });
  });

  it('drags one edge or a corner', () => {
    expect(adjust(B, 'e', 2.2, 5)).toEqual({ ...B, x1: 12 });
    expect(adjust(B, 'nw', -1, -1)).toEqual({ x0: 1, y0: 2, x1: 10, y1: 7 });
    expect(adjust(B, 's', 0, 0.4)).toEqual(B);
  });

  it('never gets smaller than one square, even dragged past the other edge', () => {
    expect(adjust(B, 'w', 20, 0)).toEqual({ ...B, x0: 9 });
    expect(adjust(B, 'n', 0, 30)).toEqual({ ...B, y0: 6 });
  });

  it('never grows past MAX_CROP', () => {
    expect(adjust(B, 'e', 5000, 0).x1).toBe(B.x0 + MAX_CROP);
  });
});

describe('handleAt', () => {
  const tol = 0.4;
  it('finds corners, edges, the inside and the outside', () => {
    expect(handleAt(B, [2.1, 3.2], tol)).toBe('nw');
    expect(handleAt(B, [10.3, 7.1], tol)).toBe('se');
    expect(handleAt(B, [6, 3.1], tol)).toBe('n');
    expect(handleAt(B, [9.8, 5], tol)).toBe('e');
    expect(handleAt(B, [6, 5], tol)).toBe('move');
    expect(handleAt(B, [12, 5], tol)).toBeNull();
    expect(handleAt(B, [6, 2.5], tol)).toBeNull();
  });

  it('on a box narrower than the grab distance, picks the nearer edge', () => {
    const thin = { x0: 0, y0: 0, x1: 1, y1: 10 };
    expect(handleAt(thin, [0.2, 5], 0.6)).toBe('w');
    expect(handleAt(thin, [0.8, 5], 0.6)).toBe('e');
  });

  it('has a cursor for each', () => {
    expect(cursorFor('ne')).toBe('nesw-resize');
    expect(cursorFor('move')).toBe('move');
    expect(cursorFor(null)).toBe('crosshair');
  });
});

describe('keyAdjust', () => {
  it('moves with the arrows and resizes with Shift', () => {
    expect(keyAdjust(B, 'ArrowLeft', false)).toEqual({ x0: 1, y0: 3, x1: 9, y1: 7 });
    expect(keyAdjust(B, 'ArrowRight', true)).toEqual({ ...B, x1: 11 });
    expect(keyAdjust(B, 'ArrowUp', true)).toEqual({ ...B, y1: 6 });
    expect(keyAdjust(B, 'a', false)).toBeNull();
  });
});

describe('size', () => {
  it('labels squares and pixels', () => {
    expect(sizeLabel(B, 70)).toBe('8 × 4 squares · 560 × 280 px');
    expect(sizeLabel({ x0: 0, y0: 0, x1: 1, y1: 1 }, 140)).toBe('1 × 1 square · 140 × 140 px');
  });

  it("uses the server's limit", () => {
    expect(sizeProblem(B, 300)).toBeNull();
    expect(sizeProblem({ x0: 0, y0: 0, x1: 300, y1: 10 }, 70)).toMatch(/at most 16384 px a side/);
  });
});

describe('snipUrls', () => {
  it('builds the render, SVG and handout links for the box', () => {
    const u = snipUrls('map_1', B, 'gm', DEFAULT_OPTIONS, null);
    expect(u.png).toBe('/api/v1/maps/map_1/render.png?view=gm&ppg=70&frame=2%2C3%2C10%2C7');
    expect(u.svg).toBe('/api/v1/maps/map_1/render.svg?view=gm&ppg=70&frame=2%2C3%2C10%2C7');
    expect(u.handout).toBe('/maps/map_1/handout?crop=2,3,10,7');
  });

  it('adds the style, no grid, a transparent background, and fog only for the players', () => {
    const o = { ppg: 140, grid: false, transparent: true, revealed: true };
    expect(snipUrls('m', B, 'players', o, 'print').png).toBe('/api/v1/maps/m/render.png?view=players&ppg=140&frame=2%2C3%2C10%2C7&style=print&grid=0&background=0&fog=1');
    expect(snipUrls('m', B, 'gm', o, null).png).not.toContain('fog');
  });
});

describe('fileNameOf', () => {
  it('reads the name from Content-Disposition', () => {
    expect(fileNameOf('inline; filename="crypt_classic-hatching_gm_8x4.png"', 'x.png')).toBe('crypt_classic-hatching_gm_8x4.png');
    expect(fileNameOf(null, 'x.png')).toBe('x.png');
  });
});

describe('memory', () => {
  it('round-trips the last snip of a map', () => {
    const text = JSON.stringify({ box: B, options: { ppg: 140, grid: false, transparent: true, revealed: false } });
    expect(memoryKey('map_1')).toBe('delve-snip:map_1');
    expect(parseMemory(text)).toEqual({ box: B, options: { ppg: 140, grid: false, transparent: true, revealed: false } });
  });

  it('ignores anything broken, and fills missing options with the defaults', () => {
    expect(parseMemory(null)).toBeNull();
    expect(parseMemory('not json')).toBeNull();
    expect(parseMemory(JSON.stringify({ box: { x0: 5, y0: 0, x1: 2, y1: 3 } }))).toBeNull();
    expect(parseMemory(JSON.stringify({ box: { x0: 0, y0: 0, x1: 2.5, y1: 3 } }))).toBeNull();
    expect(parseMemory(JSON.stringify({ box: B, options: { ppg: 9000 } }))).toEqual({ box: B, options: DEFAULT_OPTIONS });
  });
});
