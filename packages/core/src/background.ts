// A map's own background colour: stored as style.overrides.background
// ("#RRGGBB"), drawn by resolveStyle wherever the scene's background is
// (editor and viewer, exports, the players' screen, Quillwarren Table pages). Unset
// means the style's own colour. The parchment handout keeps its own paper.
import { contrastRatio, normalizeHex } from './colour-math.ts';
import type { Op } from './ops.ts';
import { MIN_HATCH_CONTRAST, PRESETS, resolveStyle, type Style } from './render/style.ts';
import type { DelveMap } from './schema.ts';

/** The ready-made colours the editor offers next to the style's own (the same for every style). */
export const BACKGROUND_PRESETS: readonly { id: string; name: string; hex: string }[] = [
  { id: 'parchment', name: 'Parchment beige', hex: '#E6D7B8' },
  { id: 'slate', name: 'Slate', hex: '#4A525C' },
  { id: 'forest', name: 'Forest green', hex: '#2F4A33' },
  { id: 'night', name: 'Night blue', hex: '#1A2540' },
  { id: 'white', name: 'White', hex: '#FFFFFF' },
  { id: 'black', name: 'Black', hex: '#000000' },
];

const DEFAULT_PRESET = 'classic-hatching';

/** The style's own background colour, "#RRGGBB". */
export function styleBackground(preset: string | undefined): string {
  const p = PRESETS[preset ?? DEFAULT_PRESET] ?? PRESETS[DEFAULT_PRESET]!;
  return normalizeHex(p.background)!;
}

/** The map's own background colour ("#RRGGBB"), or null when it uses the style's. */
export function mapBackground(map: Pick<DelveMap, 'style'>): string | null {
  const v = (map.style?.overrides as Record<string, unknown> | undefined)?.background;
  const hex = normalizeHex(v);
  return hex && hex !== styleBackground(map.style?.preset) ? hex : null;
}

/** The colour the map is drawn on: its own, or the style's. */
export const shownBackground = (map: Pick<DelveMap, 'style'>): string => mapBackground(map) ?? styleBackground(map.style?.preset);

/**
 * Reads a typed background: "#RRGGBB", "#RGB" (with or without the #) or
 * "reset" (also "", null, "style", "default") for the style's own colour.
 * Throws with a message fit to show for anything else.
 */
export function parseBackground(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string' && ['', 'reset', 'style', 'default', 'none'].includes(input.trim().toLowerCase())) return null;
  const hex = normalizeHex(input);
  if (!hex) throw new Error(`background must be a colour like "#2F4A33" (or "reset" for the style's own), not ${JSON.stringify(input)}`);
  return hex;
}

/**
 * The map's style with its background set to `hex` (null, or the style's own
 * colour: back to the style's). Every other override stays as it is.
 */
export function withBackground(map: Pick<DelveMap, 'style'>, hex: string | null): NonNullable<DelveMap['style']> {
  const cur = map.style ?? { preset: DEFAULT_PRESET };
  const overrides: Record<string, unknown> = { ...(cur.overrides ?? {}) };
  delete overrides.background;
  const n = hex === null ? null : normalizeHex(hex);
  if (hex !== null && !n) throw new Error(`background must be a colour like "#2F4A33", not ${JSON.stringify(hex)}`);
  if (n && n !== styleBackground(cur.preset)) overrides.background = n;
  return { preset: cur.preset, ...(Object.keys(overrides).length ? { overrides } : {}) };
}

/** One update_map op that sets (or, with null, resets) the map's background: one undo step. */
export function backgroundOps(map: Pick<DelveMap, 'style'>, hex: string | null): Op[] {
  return [{ op: 'update_map', set: { style: withBackground(map, hex) } }];
}

/**
 * The map's style with a different preset: its own background colour comes
 * along (it's the map's, not the style's); the other overrides, made for the
 * old style, don't.
 */
export function withPreset(map: Pick<DelveMap, 'style'>, preset: string): NonNullable<DelveMap['style']> {
  const bg = mapBackground(map);
  return withBackground({ style: { preset } }, bg);
}

/** What the editor says about a background: hatching drawn lighter so it stays visible, or ink that reads poorly. */
export function backgroundHints(map: Pick<DelveMap, 'style'>, hex: string = shownBackground(map)): string[] {
  const style: Style = resolveStyle({ style: withBackground(map, hex) });
  const own = resolveStyle({ style: withBackground(map, null) });
  const hints: string[] = [];
  if (own.hatching && style.hatching && style.hatching.color !== own.hatching.color) {
    hints.push('Hatching is drawn in a lighter ink on this dark colour, so it stays visible.');
  } else if (style.hatching && contrastRatio(style.hatching.color, style.background) < MIN_HATCH_CONTRAST + 0.5) {
    hints.push('The hatching shows only faintly on this colour.');
  }
  if (contrastRatio(style.background, style.floor.color) < 1.15 && !style.shadow && !style.hatching && !style.shading) {
    hints.push('The rooms are about the colour of the background: only their walls set them apart.');
  }
  return hints;
}
