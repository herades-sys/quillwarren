// Resizing props and pictures by their corners (edit-logic.ts): a prop scales
// uniformly about its centre in steps that keep its footprint on half squares
// (Alt: free), within 25–400 %; a picture takes any width and height.
import { describe, expect, it } from 'vitest';
import { cornerAt, corners, MAX_SCALE, MIN_SCALE, scaleFromCorner, scaleStep, sizeFromCorner, sizeText, snapScale } from '../src/edit-logic.ts';

describe('prop corner handles', () => {
  it('sit on the footprint’s corners, turned with it', () => {
    expect(corners({ at: [4, 5.5], w: 2, h: 1 })).toEqual([[3, 5], [5, 5], [5, 6], [3, 6]]);
    // a quarter turn: the long side runs down
    expect(corners({ at: [4, 5.5], w: 2, h: 1, rotation: 90 })).toEqual([[4.5, 4.5], [4.5, 6.5], [3.5, 6.5], [3.5, 4.5]]);
    expect(cornerAt({ at: [4, 5.5], w: 2, h: 1 }, [5.05, 6.04], 0.1)).toBe(2);
    expect(cornerAt({ at: [4, 5.5], w: 2, h: 1 }, [4, 5.5], 0.1)).toBeNull();
  });

  it('step so both sides stay whole half squares', () => {
    expect(scaleStep(1, 1)).toBe(0.5); // 0.5, 1, 1.5 squares…
    expect(scaleStep(2, 1)).toBe(0.5); // 1 × 0.5, 2 × 1, 3 × 1.5
    expect(scaleStep(2, 2)).toBe(0.25); // 0.5, 1, 1.5…
    expect(scaleStep(3, 1)).toBe(0.5);
    expect(scaleStep(1.5, 1)).toBe(1); // 1.5 × 1, 3 × 2
    expect(scaleStep(1.3, 1)).toBeCloseTo(0.5 / 1.3); // not in half squares: the longer side steps by ½
  });

  it('snaps the scale, frees it with Alt, and keeps it within 25–400 %', () => {
    expect(snapScale(1.4, 1, 1)).toBe(1.5);
    expect(snapScale(1.2, 1, 1)).toBe(1);
    expect(snapScale(1.2, 2, 2)).toBe(1.25);
    expect(snapScale(1.234, 1, 1, true)).toBe(1.23);
    expect(snapScale(0.1, 1, 1)).toBe(0.5); // the smallest step at or above 25 %
    expect(snapScale(0.1, 2, 2)).toBe(MIN_SCALE);
    expect(snapScale(0.1, 1, 1, true)).toBe(MIN_SCALE);
    expect(snapScale(9, 1, 1)).toBe(MAX_SCALE);
    expect(snapScale(9, 1.5, 1)).toBe(4);
  });

  it('scales about the centre by the side the pointer pulls furthest', () => {
    const barrel = { at: [3.5, 5.5] as [number, number] };
    // the bottom-right corner dragged from 4,6 to 4.5,6.6: half sides 1 and 1.1 → 2.2 → snapped to 2
    expect(scaleFromCorner(barrel, { w: 1, h: 1 }, [4.5, 6.6])).toBe(2);
    expect(scaleFromCorner(barrel, { w: 1, h: 1 }, [4.5, 6.6], true)).toBe(2.2);
    // any corner works the same: the top-left pulled out
    expect(scaleFromCorner(barrel, { w: 1, h: 1 }, [2.75, 4.75])).toBe(1.5);
    // a 2 × 1 table turned a quarter: its long side runs down, so pulling down 1.5 from the centre is 150 %
    expect(scaleFromCorner({ at: [4, 5.5], rotation: 90 }, { w: 2, h: 1 }, [4.2, 7])).toBe(1.5);
  });

  it('labels the footprint as it lies', () => {
    expect(sizeText(3, 1.5, 0, 1.5)).toBe('3 × 1.5 sq · 150 %');
    expect(sizeText(3, 1.5, 90, 1.5)).toBe('1.5 × 3 sq · 150 %');
    expect(sizeText(2, 1)).toBe('2 × 1 sq');
  });
});

describe('picture corner handles', () => {
  const rug = { at: [5, 5] as [number, number], w: 2, h: 1 };

  it('size width and height to the pointer in half squares, or freely with Alt', () => {
    expect(sizeFromCorner(rug, [6.6, 6.1])).toEqual({ w: 3, h: 2 });
    expect(sizeFromCorner(rug, [6.63, 6.1], { free: true })).toEqual({ w: 3.26, h: 2.2 });
    expect(sizeFromCorner(rug, [5.01, 5.01])).toEqual({ w: 0.5, h: 0.5 });
  });

  it('keep the proportions with Shift, and follow a turned picture', () => {
    expect(sizeFromCorner(rug, [7, 5.2], { keep: true })).toEqual({ w: 4, h: 2 });
    expect(sizeFromCorner({ ...rug, rotation: 90 }, [5.6, 7])).toEqual({ w: 4, h: 1 });
  });
});
