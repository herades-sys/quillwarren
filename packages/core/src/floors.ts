// Floor numbers and stair labels. A storey's floor number is its level.order:
// 0 is ground level, -1 the first floor below ground, 1 the first floor up. A
// map that isn't a storey counts as floor 0. Every stair, ladder, spiral stair
// and trapdoor gets a GM label: its floor number, then a letter shared by the
// connectors that line up across neighbouring storeys (0A, 1A, 2A; then 2B, 3B).
import { connectorsOf, STAIR_PROPS, stairLinks, type Connector } from './levels.ts';
import type { Op } from './ops.ts';
import type { DelveMap, Level, MapObject } from './schema.ts';

/** The proper minus sign, for drawing (data keeps the plain hyphen: "-1C"). */
export const MINUS = '−';

export const floorOf = (map: Pick<DelveMap, 'level'>): number => map.level?.order ?? 0;

/** A floor number as shown: "2", "0", "−1". */
export const floorText = (n: number): string => (n < 0 ? `${MINUS}${-n}` : String(n));

/** A stair label as drawn: "-1C" becomes "−1C". */
export const labelText = (label: string): string => label.replace(/^-/, MINUS);

/** A storey as the storey picker lists it: "2 · Wizard's floor", "−1 · Cellar" (a plain map: its name). */
export const storeyTitle = (s: { name: string; level?: Level }): string => (s.level ? `${floorText(s.level.order)} · ${s.level.name}` : s.name);

/** Stairs and the props that lead to another storey (ladder, trapdoor, spiral stairs). */
export const isConnector = (o: MapObject): boolean => o.type === 'stairs' || (o.type === 'prop' && Boolean(STAIR_PROPS[o.asset]));

/** 0 → A, 25 → Z, 26 → AA. */
export function chainLetter(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export interface StoreyMap {
  id: string;
  map: DelveMap;
}

const centre = (c: Connector): [number, number] => [(c.bounds.x0 + c.bounds.x1) / 2, (c.bounds.y0 + c.bounds.y1) / 2];

/**
 * The label for every connector of these storeys (one group, or a single map):
 * storey id → object id → label. Connectors that `stairLinks` joins across
 * neighbouring storeys form one chain and share a letter; an unlinked one is a
 * chain of its own. Letters go by the chain's lowest floor, then its lowest
 * connector from top to bottom and left to right.
 */
export function stairLabels(storeys: readonly StoreyMap[]): Map<string, Map<string, string>> {
  const inputs = storeys.map((s) => ({ id: s.id, order: floorOf(s.map), map: s.map }));
  const floor = new Map(inputs.map((s) => [s.id, s.order]));
  const plan = stairLinks(inputs);
  const key = (c: Connector) => `${c.storey}\u0000${c.id}`;
  const parent = new Map(plan.connectors.map((c) => [key(c), key(c)]));
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let at = k; at !== root; ) {
      const next = parent.get(at)!;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  for (const { lower, upper } of plan.links) parent.set(find(key(lower)), find(key(upper)));

  const chains = new Map<string, Connector[]>();
  for (const c of plan.connectors) {
    const root = find(key(c));
    chains.set(root, [...(chains.get(root) ?? []), c]);
  }
  const lead = (list: Connector[]) => {
    const low = Math.min(...list.map((c) => floor.get(c.storey)!));
    const first = list
      .filter((c) => floor.get(c.storey) === low)
      .sort((a, b) => centre(a)[1] - centre(b)[1] || centre(a)[0] - centre(b)[0] || a.storey.localeCompare(b.storey) || a.id.localeCompare(b.id))[0]!;
    return { low, first };
  };
  const ordered = [...chains.values()]
    .map((list) => ({ list, ...lead(list) }))
    .sort(
      (a, b) =>
        a.low - b.low ||
        centre(a.first)[1] - centre(b.first)[1] ||
        centre(a.first)[0] - centre(b.first)[0] ||
        a.first.storey.localeCompare(b.first.storey) ||
        a.first.id.localeCompare(b.first.id),
    );

  const out = new Map(storeys.map((s) => [s.id, new Map<string, string>()]));
  ordered.forEach(({ list }, i) => {
    for (const c of list) out.get(c.storey)!.set(c.id, `${floor.get(c.storey)}${chainLetter(i)}`);
  });
  return out;
}

/** The update ops that give a map's connectors these labels (none for the ones already right). */
export function stairLabelOps(map: DelveMap, labels: ReadonlyMap<string, string>): Op[] {
  const ops: Op[] = [];
  for (const o of map.objects) {
    const label = labels.get(o.id);
    if (label !== undefined && (o.type === 'stairs' || o.type === 'prop') && o.label !== label) ops.push({ op: 'update', id: o.id, set: { label } });
  }
  return ops;
}

/** A map's connectors with the label each one shows: its own, or "?" when others on the map have one and it doesn't. */
export function stairTags(map: DelveMap): { id: string; text: string; at: [number, number] }[] {
  const list = connectorsOf(map.id, map);
  const byId = new Map(map.objects.map((o) => [o.id, o]));
  const labelOf = (id: string) => {
    const o = byId.get(id);
    return o && (o.type === 'stairs' || o.type === 'prop') ? o.label : undefined;
  };
  if (!list.some((c) => labelOf(c.id))) return [];
  return list.map((c) => ({ id: c.id, text: labelText(labelOf(c.id) ?? '?'), at: centre(c) }));
}
