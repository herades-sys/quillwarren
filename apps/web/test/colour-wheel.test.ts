// The colour wheel's geometry and keys (apps/web/src/colour-wheel-logic.ts).
import { hexToHsv, hsvToHex } from '@delve/core';
import { describe, expect, it } from 'vitest';
import { hsvOf, hsvText, SAT_GAMMA, wheelAt, wheelKey, wheelPixels, wheelPoint } from '../src/colour-wheel-logic.ts';

describe('the colour wheel', () => {
  it('puts red at the top and turns clockwise, grey in the middle', () => {
    const R = 60;
    const near = (p: { x: number; y: number }, x: number, y: number) => {
      expect(p.x).toBeCloseTo(x, 6);
      expect(p.y).toBeCloseTo(y, 6);
    };
    near(wheelPoint({ h: 0, s: 1 }, R), 0, -R);
    near(wheelPoint({ h: 90, s: 1 }, R), R, 0);
    near(wheelPoint({ h: 180, s: 1 }, R), 0, R);
    near(wheelPoint({ h: 270, s: 1 }, R), -R, 0);
    near(wheelPoint({ h: 123, s: 0 }, R), 0, 0);
    // saturation runs along the radius squared: a muted colour sits well away from the centre
    expect(Math.hypot(wheelPoint({ h: 36, s: 0.054 }, R).x, wheelPoint({ h: 36, s: 0.054 }, R).y)).toBeCloseTo(R * 0.054 ** (1 / SAT_GAMMA), 6);
    expect(wheelAt(0, -R, R)).toEqual({ h: 0, s: 1 });
    expect(wheelAt(0, 0, R)).toEqual({ h: 0, s: 0 });
    // outside the rim counts as the rim
    expect(wheelAt(3 * R, 0, R)).toEqual({ h: 90, s: 1 });
  });

  it('finds a point again from its colour, all round the wheel', () => {
    for (let h = 0; h < 360; h += 7.5) {
      for (const s of [0.01, 0.054, 0.25, 0.5, 0.8, 1]) {
        const p = wheelPoint({ h, s }, 80);
        const back = wheelAt(p.x, p.y, 80);
        expect(back.h).toBeCloseTo(h, 6);
        expect(back.s).toBeCloseTo(s, 9);
      }
    }
  });

  it('moves the hue with ← → and the saturation with ↑ ↓, Shift for bigger steps', () => {
    const c = { h: 10, s: 0.5, v: 0.8 };
    expect(wheelKey(c, 'ArrowRight', false)).toEqual({ h: 12, s: 0.5, v: 0.8 });
    expect(wheelKey(c, 'ArrowLeft', false)).toEqual({ h: 8, s: 0.5, v: 0.8 });
    expect(wheelKey(c, 'ArrowLeft', true)).toEqual({ h: 355, s: 0.5, v: 0.8 }); // wraps
    expect(wheelKey({ ...c, h: 359 }, 'ArrowRight', false)!.h).toBe(1);
    expect(wheelKey(c, 'ArrowUp', false)!.s).toBe(0.52);
    expect(wheelKey(c, 'ArrowDown', true)!.s).toBe(0.4);
    expect(wheelKey({ ...c, s: 0.99 }, 'ArrowUp', true)!.s).toBe(1);
    expect(wheelKey({ ...c, s: 0.01 }, 'ArrowDown', false)!.s).toBe(0);
    expect(wheelKey(c, 'Home', false)!.s).toBe(0);
    expect(wheelKey(c, 'End', false)!.s).toBe(1);
    expect(wheelKey(c, 'a', false)).toBeNull();
    expect(wheelKey(c, 'Enter', false)).toBeNull();
  });

  it('keeps the hue of a grey, so the brightness can go to black and back', () => {
    const olive = hexToHsv('#6B6B2F');
    expect(hsvOf('#000000', olive)).toEqual({ ...olive, v: 0 });
    expect(hsvToHex(hsvOf('#000000', olive))).toBe('#000000');
    const grey = hsvOf('#808080', olive);
    expect(grey.h).toBe(olive.h);
    expect(grey.s).toBe(0);
    // the colour the wheel was on comes back as it was (no rounding drift)
    const exact = { h: 33.3, s: 0.123, v: 0.777 };
    expect(hsvOf(hsvToHex(exact), exact)).toBe(exact);
    // a different colour is just that colour
    expect(hsvOf('#FF0000', olive)).toEqual({ h: 0, s: 1, v: 1 });
    expect(hsvText({ h: 36.9, s: 0.054, v: 0.937 })).toBe('hue 37°, saturation 5%, brightness 94%');
  });

  it('draws the wheel: white in the middle, red at the top, nothing in the corners, darker at lower brightness', () => {
    const size = 64;
    const px = wheelPixels(size, 1);
    const at = (i: number, j: number) => [...px.slice((j * size + i) * 4, (j * size + i) * 4 + 4)];
    const mid = at(32, 32);
    expect(mid[0]).toBeGreaterThan(245);
    expect(mid[1]).toBeGreaterThan(245);
    expect(mid[2]).toBeGreaterThan(245);
    const top = at(32, 1);
    expect(top[0]).toBeGreaterThan(240);
    expect(top[1]).toBeLessThan(40);
    expect(top[3]).toBe(255);
    expect(at(0, 0)[3]).toBe(0);
    expect(at(63, 63)[3]).toBe(0);
    const dim = wheelPixels(size, 0.5);
    expect(dim[(32 * size + 32) * 4]).toBeLessThan(130);
    expect(wheelPixels(size, 0)[(32 * size + 32) * 4]).toBe(0);
  });
});
