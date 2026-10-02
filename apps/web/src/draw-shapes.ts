// The Room and Pillar tools' shape and fill choices, and the ghost that shows
// the exact shape while dragging (the geometry itself is core's draw.ts).
// No DOM here, so it can be tested.
import type { CutoutFill, DrawShape, Shape } from '@delve/core';

export const SHAPE_CHOICES: [DrawShape, string][] = [
  ['rect', 'rectangle'],
  ['circle', 'circle'],
  ['oval', 'oval'],
  ['triangle', 'triangle'],
  ['hexagon', 'hexagon'],
  ['octagon', 'octagon'],
  ['freehand', 'freehand'],
];

export const FILL_CHOICES: [CutoutFill, string][] = [
  ['rock', 'like the rock'],
  ['solid', 'solid'],
];

/** The hint under the tools for the Room, Pillar and Open area tools, by shape. */
export function drawHint(kind: DrawShape, what: 'room' | 'pillar' | 'opening'): string {
  if (kind === 'freehand') return `Hold the button and draw the ${what === 'room' ? "room's" : what === 'pillar' ? "pillar's" : "open area's"} outline; let go to close it.`;
  const base =
    what === 'room'
      ? 'Drag to draw a room.'
      : what === 'pillar'
        ? 'Drag to cut floor away: pillars, pits, wall blocks.'
        : 'Drag over a wall or an edge: no hatching or shading inside it (with Open walls, no wall lines either).';
  return `${base} Shift keeps width and height equal.`;
}

/** A shape as SVG attributes for the ghost: the element name and its attributes (in squares). */
export function shapeGhost(shape: Shape): { tag: 'rect' | 'circle' | 'polygon'; attrs: Record<string, number | string> } {
  if ('rect' in shape) {
    const [x, y, width, height] = shape.rect;
    return { tag: 'rect', attrs: { x, y, width, height } };
  }
  if ('circle' in shape) {
    const [cx, cy, r] = shape.circle;
    return { tag: 'circle', attrs: { cx, cy, r } };
  }
  return { tag: 'polygon', attrs: { points: shape.poly.map((p) => p.join(',')).join(' ') } };
}
