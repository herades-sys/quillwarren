// Storeys. A multi-storey place (a tower, a keep with a cellar) is several
// maps that share `level.group`; each storey is its own map, with its own
// undo history and its own Roll20 page. They share one coordinate grid, so
// stairs line up from one storey to the next.
import { propBounds } from './assets/catalog.ts';
import { shapeBounds, type Bounds } from './geometry/shapes.ts';
import type { DelveMap, Level } from './schema.ts';

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

// ---------- how storeys connect ----------

export type ConnectorKind = 'stairs' | 'spiral' | 'ladder' | 'trapdoor';

/** Props that lead to another storey. (The stairs-up/down GM symbols are notes, not connections.) */
export const STAIR_PROPS: Record<string, ConnectorKind> ={ 'stairs-spiral': 'spiral', ladder: 'ladder', trapdoor: 'trapdoor' };

export interface Connector {
  storey: string;
  id: string;
  kind: ConnectorKind;
  name?: string;
  bounds: Bounds;
}

export interface StoreyInput {
  id: string;
  order: number;
  map: DelveMap;
}

export interface StairPlan {
  connectors: Connector[];
  /** Stairs that line up on two neighbouring storeys (lower is the one further down). */
  links: { lower: Connector; upper: Connector }[];
  /** Stairs with nothing on the storey above or below to meet them. */
  loose: Connector[];
}

export function connectorsOf(storey: string, map: DelveMap): Connector[] {
  const out: Connector[] = [];
  for (const o of map.objects) {
    const base = { storey, id: o.id, ...(o.name ? { name: o.name } : {}) };
    if (o.type === 'stairs') out.push({ ...base, kind: 'stairs', bounds: shapeBounds(o.shape) });
    else if (o.type === 'prop' && STAIR_PROPS[o.asset]) out.push({ ...base, kind: STAIR_PROPS[o.asset]!, bounds: propBounds(o) });
  }
  return out;
}

const overlap = (a: Bounds, b: Bounds): number =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** Which stairs meet across neighbouring storeys (neighbours by order, whatever the numbers are). */
export function stairLinks(storeys: readonly StoreyInput[]): StairPlan {
  const sorted = [...storeys].sort((a, b) => a.order - b.order);
  const byStorey = sorted.map((s) => connectorsOf(s.id, s.map));
  const links: StairPlan['links'] = [];
  const linked = new Set<Connector>();
  for (let i = 0; i + 1 < sorted.length; i++) {
    for (const lower of byStorey[i]!) {
      for (const upper of byStorey[i + 1]!) {
        if (overlap(lower.bounds, upper.bounds) > 1e-6) {
          links.push({ lower, upper });
          linked.add(lower);
          linked.add(upper);
        }
      }
    }
  }
  const connectors = byStorey.flat();
  return { connectors, links, loose: connectors.filter((c) => !linked.has(c)) };
}
