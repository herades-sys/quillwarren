import { describe, expect, it } from 'vitest';
import { MAX_RENDER_PIXELS, MAX_RENDER_SIDE, renderSizeProblem } from '../src/index.ts';

describe('renderSizeProblem', () => {
  it('lets a whole city through at Roll20 size', () => {
    // Feyvale at 10 ft a square: 157 × 106 squares, 81 megapixels at 70 px
    expect(renderSizeProblem(157, 106, 70)).toBeNull();
    expect(renderSizeProblem(30, 30, 300)).toBeNull(); // 81 megapixels
  });

  it('refuses more than MAX_RENDER_SIDE px a side', () => {
    expect(MAX_RENDER_SIDE).toBe(16_384);
    expect(renderSizeProblem(234, 10, 70)).toBeNull(); // 16,380 px
    expect(renderSizeProblem(235, 10, 70)).toBe('235 × 10 squares at 70 px a square is 16450 × 700 px; at most 16384 px a side');
    expect(renderSizeProblem(1000, 1000, 300)).toMatch(/is 300000 × 300000 px; at most 16384 px a side$/);
  });

  it('refuses more than MAX_RENDER_PIXELS in all', () => {
    expect(MAX_RENDER_PIXELS).toBe(100_000_000);
    expect(renderSizeProblem(200, 200, 50)).toBeNull(); // 10,000 px square: exactly 100 megapixels
    expect(renderSizeProblem(150, 150, 70)).toBe('150 × 150 squares at 70 px a square is 10500 × 10500 px (110 megapixels); at most 100');
  });
});
