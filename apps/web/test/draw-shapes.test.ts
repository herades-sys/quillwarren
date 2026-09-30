// The Room and Pillar tools' shape and fill choices.
import { CUTOUT_FILLS, DRAW_SHAPES } from '@delve/core';
import { describe, expect, it } from 'vitest';
import { drawHint, FILL_CHOICES, SHAPE_CHOICES, shapeGhost } from '../src/draw-shapes.ts';

describe('shape and fill choices', () => {
  it('offers every shape core can draw, rectangle first, and both fills', () => {
    expect(SHAPE_CHOICES.map(([k]) => k)).toEqual([...DRAW_SHAPES]);
    expect(SHAPE_CHOICES[0]).toEqual(['rect', 'rectangle']);
    expect(FILL_CHOICES.map(([k]) => k).sort()).toEqual([...CUTOUT_FILLS].sort());
    expect(FILL_CHOICES[0]![0]).toBe('rock'); // today's look stays the default
  });

  it('explains drag and Shift, or drawing the outline for freehand', () => {
    expect(drawHint('hexagon', 'room')).toBe('Drag to draw a room. Shift keeps width and height equal.');
    expect(drawHint('rect', 'pillar')).toContain('Drag to cut floor away');
    expect(drawHint('freehand', 'room')).toBe("Hold the button and draw the room's outline; let go to close it.");
  });

  it('draws the ghost of the exact shape', () => {
    expect(shapeGhost({ rect: [1, 2, 3, 4] })).toEqual({ tag: 'rect', attrs: { x: 1, y: 2, width: 3, height: 4 } });
    expect(shapeGhost({ circle: [5, 5, 2] })).toEqual({ tag: 'circle', attrs: { cx: 5, cy: 5, r: 2 } });
    expect(shapeGhost({ poly: [[0, 0], [2, 0], [1, 1.5]] })).toEqual({ tag: 'polygon', attrs: { points: '0,0 2,0 1,1.5' } });
  });
});
