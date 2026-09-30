// MCP arguments for rooms and cutouts in other shapes: `preset` fills a box
// with an oval, triangle, hexagon or octagon, as the editor's Shape choice does.
import { z } from 'zod';
import { PRESET_SHAPES, shapeFromBox, ValidationError, type Point, type Shape } from '@delve/core';

export const presetArg = z
  .object({
    kind: z.enum(PRESET_SHAPES),
    box: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]).describe('[x, y, width, height] in squares'),
  })
  .optional()
  .describe('Instead of rect, poly or circle: a shape filling a box, e.g. {"kind": "hexagon", "box": [4, 2, 6, 6]}. Kinds: oval, triangle (point up), hexagon (flat top), octagon');

/** Exactly one of rect, poly, circle or preset, as a shape. */
export function shapeOrPreset(a: {
  rect?: [number, number, number, number];
  poly?: Point[];
  circle?: [number, number, number];
  preset?: { kind: (typeof PRESET_SHAPES)[number]; box: [number, number, number, number] };
}): Shape {
  const given = [a.rect && { rect: a.rect }, a.poly && { poly: a.poly }, a.circle && { circle: a.circle }, a.preset && shapeFromBox(a.preset.kind, a.preset.box)].filter(Boolean) as Shape[];
  if (given.length !== 1) throw new ValidationError(['give exactly one of rect, poly or circle (or a preset)']);
  return given[0]!;
}
