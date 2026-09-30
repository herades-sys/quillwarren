// GM marks for storeys: the floor number, large in the picture's top-left
// corner, and each stair's label (0A, 1A, −1C) on a small dark tag. Both are
// for the GM view only (buildScene decides); the players never see them.
import type { Bounds } from '../geometry/shapes.ts';
import { floorText, stairTags } from '../floors.ts';
import type { DelveMap } from '../schema.ts';
import type { Layer } from './scene.ts';
import type { Style } from './style.ts';

/** Stair tags are this many squares tall. */
export const TAG_SIZE = 0.5;

/** The floor number of a storey, drawn big and faded in the top-left corner; null for a map that isn't a storey. */
export function floorNumberLayer(map: DelveMap, bounds: Bounds, style: Style): Layer | null {
  if (!map.level) return null;
  const text = floorText(map.level.order);
  // big enough to find on a large map, small enough to stay in the corner of a small one
  const size = Math.max(1.6, Math.min(5, 0.045 * Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0)));
  const width = size * 0.62 * [...text].length; // Marcellus SC figures are about 0.6 em wide
  return {
    name: 'floor-number',
    kind: 'text',
    items: [{ text, at: [bounds.x0 + size * 0.3 + width / 2, bounds.y0 + size * 0.65], size }],
    color: style.labels.color,
    font: style.labels.numberFont,
    opacity: 0.55,
  };
}

/** Every stair, ladder, spiral stair and trapdoor with its label ("?" if it has none while others do); null if none has one. */
export function stairTagLayer(map: DelveMap, style: Style): Layer | null {
  const items = stairTags(map).map((t) => ({ text: t.text, at: t.at }));
  if (!items.length) return null;
  return { name: 'stair-labels', kind: 'tags', items, size: TAG_SIZE, fill: '#1B1F24', color: '#FFFFFF', font: style.labels.numberFont };
}
