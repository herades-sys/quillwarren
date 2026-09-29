// Storeys. A multi-storey place (a tower, a keep with a cellar) is several
// maps that share `level.group`; each storey is its own map, with its own
// undo history and its own Roll20 page. They share one coordinate grid, so
// stairs line up from one storey to the next.
import type { Level } from './schema.ts';

export interface LevelEntry {
  id: string;
  name: string;
  level?: Level;
}

/** The storeys of map `id`, in order (just the map itself when it isn't part of a group). */
export function levelSiblings<T extends LevelEntry>(maps: readonly T[], id: string): T[] {
  const me = maps.find((m) => m.id === id);
  if (!me) return [];
  const group = me.level?.group;
  if (!group) return [me];
  return maps
    .filter((m) => m.level?.group === group)
    .sort((a, b) => a.level!.order - b.level!.order || a.name.localeCompare(b.name));
}
