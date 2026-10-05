// The editor's terrain edges (core render/terrain-edges.ts): how a terrain area
// meets the terrain under it. The Terrain tool's context bar (Edge: Auto, Hard,
// Ragged, Fade; the fade's width; Details) sets them for new areas, and the
// inspector changes a selected area's: its edge, fade width, details and which
// of two areas lies on top.
import {
  DEFAULT_FADE_WIDTH,
  defaultTerrainEdge,
  FADE_WIDTH_MAX,
  FADE_WIDTH_MIN,
  MATERIAL_STACK,
  STACK_MAX,
  terrainMaterial,
  type Shape,
  type Terrain,
  type TerrainEdge,
  type TerrainMaterial,
} from '@delve/core';
import { checkbox, field, h, miniRange, range, select, seg, type Kid } from './dom.ts';

export type TerrainEdgeChoice = TerrainEdge | 'auto';

/** What the Terrain tool gives new areas. */
export interface TerrainToolState {
  edge: TerrainEdgeChoice;
  fadeWidth: number;
  details: boolean;
}

export const TERRAIN_TOOL_DEFAULTS: TerrainToolState = { edge: 'auto', fadeWidth: DEFAULT_FADE_WIDTH, details: true };

export const TERRAIN_EDGE_NAME: Record<TerrainEdge, string> = { hard: 'Hard', ragged: 'Ragged', fade: 'Fade' };

const EDGE_TITLE: Record<TerrainEdgeChoice, string> = {
  auto: 'By material: natural ground and water fade into each other, indoor floors stay hard; against bare floor only ragged',
  hard: 'A crisp edge, exactly as drawn',
  ragged: 'A natural, wobbly outline',
  fade: 'Fades into the terrain under it, in patches and tongues',
};

/** Materials in words, for the inspector. */
export const MATERIAL_NAME: Record<TerrainMaterial, string> = {
  deep: 'deep water',
  water: 'water',
  ice: 'ice on water',
  lava: 'lava',
  shallow: 'shallow water',
  wet: 'mud and swamp',
  sand: 'sand',
  earth: 'earth',
  stone: 'stone and gravel',
  green: 'grass and moss',
  snow: 'snow and ice',
  floor: 'an indoor floor',
  chasm: 'a chasm',
};

/** The new area the Terrain tool makes from a drawn shape: only what differs from the defaults is stored. */
export function terrainObject(id: string, shape: Shape, asset: string, st: TerrainToolState): Terrain {
  return {
    id,
    type: 'terrain',
    shape,
    asset,
    ...(st.edge !== 'auto' ? { edge: st.edge } : {}),
    ...(st.fadeWidth !== DEFAULT_FADE_WIDTH ? { fadeWidth: st.fadeWidth } : {}),
    ...(st.details ? {} : { edgeDetails: false }),
  };
}

/** Does this choice fade for this texture (so the width matters)? */
export const fades = (edge: TerrainEdgeChoice, asset: string): boolean => (edge === 'auto' ? defaultTerrainEdge(asset) : edge) === 'fade';

export interface CtxKit {
  chip(label: Kid, on: boolean, pick: () => void, o?: { title?: string }): HTMLElement;
  group(label: string, ...kids: HTMLElement[]): HTMLElement;
}

/** The Terrain tool's edge chips, the fade's width (when it fades) and the details chip. */
export function terrainToolBar(kit: CtxKit, st: TerrainToolState, asset: string, change: (next: TerrainToolState) => void): HTMLElement[] {
  const auto = defaultTerrainEdge(asset);
  const out: HTMLElement[] = [
    kit.group(
      'Edge',
      ...(['auto', 'hard', 'ragged', 'fade'] as const).map((k) =>
        kit.chip(k === 'auto' ? `Auto · ${TERRAIN_EDGE_NAME[auto].toLowerCase()}` : TERRAIN_EDGE_NAME[k], st.edge === k, () => change({ ...st, edge: k }), { title: EDGE_TITLE[k] }),
      ),
    ),
  ];
  if (fades(st.edge, asset)) {
    out.push(
      miniRange('Fade', {
        value: st.fadeWidth,
        min: FADE_WIDTH_MIN,
        max: FADE_WIDTH_MAX,
        step: 0.25,
        show: (v) => `${v} sq`,
        onChange: (v) => change({ ...st, fadeWidth: v }),
        onInput: (v) => (st.fadeWidth = v),
      }),
    );
  }
  out.push(kit.group('Details', kit.chip('Details', st.details, () => change({ ...st, details: !st.details }), { title: 'Along soft edges: a wet shoreline with foam and pebbles, grass tufts over a road, a few patches' })));
  return out;
}

/**
 * The inspector's fields for a selected terrain area. `upd` sets fields, `unset` removes them (back to the default).
 * The width slider and the hint follow a change at once (the inspector isn't drawn again while one of its controls has focus).
 */
export function terrainEdgeFields(o: Terrain, upd: (set: Record<string, unknown>) => void, unset: (key: string) => void): HTMLElement[] {
  const material = terrainMaterial(o.asset);
  const st = { edge: (o.edge ?? 'auto') as TerrainEdgeChoice, width: o.fadeWidth ?? DEFAULT_FADE_WIDTH, stack: o.stack ?? MATERIAL_STACK[material] };
  const widthBox = h('div', {});
  const hint = h('p', { class: 'hint' });
  const slider = () =>
    range('Fade width', {
      value: st.width,
      min: FADE_WIDTH_MIN,
      max: FADE_WIDTH_MAX,
      step: 0.25,
      show: (v) => `${v} sq`,
      onChange: (v) => {
        st.width = v;
        hint.textContent = edgeHint(o.asset, st);
        if (v === DEFAULT_FADE_WIDTH) unset('fadeWidth');
        else upd({ fadeWidth: v });
      },
    });
  const refresh = () => {
    widthBox.replaceChildren(...(fades(st.edge, o.asset) ? [slider()] : []));
    hint.textContent = edgeHint(o.asset, st);
  };
  refresh();
  return [
    field(
      'Edge',
      seg(
        `terrain-edge-${o.id}`,
        (['auto', 'hard', 'ragged', 'fade'] as const).map((k): [TerrainEdgeChoice, string] => [k, k === 'auto' ? 'Auto' : TERRAIN_EDGE_NAME[k]]),
        st.edge,
        (v) => {
          st.edge = v;
          refresh();
          if (v === 'auto') unset('edge');
          else upd({ edge: v });
        },
        'ed-seg-full',
      ),
    ),
    widthBox,
    checkbox('Edge details', o.edgeDetails ?? true, (on) => (on ? unset('edgeDetails') : upd({ edgeDetails: false })), { hint: 'shoreline, tufts, patches' }),
    field(
      'Lies on top',
      select(
        [['auto', `Auto · ${MATERIAL_STACK[material]} (${MATERIAL_NAME[material]})`], ...Array.from({ length: STACK_MAX + 1 }, (_, k): [string, string] => [String(k), stackLabel(k)])],
        o.stack === undefined ? 'auto' : String(o.stack),
        (v) => {
          st.stack = v === 'auto' ? MATERIAL_STACK[material] : Number(v);
          hint.textContent = edgeHint(o.asset, st);
          if (v === 'auto') unset('stack');
          else upd({ stack: Number(v) });
        },
        { 'aria-label': 'Which area lies on top where two fade into each other' },
      ),
    ),
    hint,
  ];
}

/** What the inspector says about an area's edge. */
function edgeHint(asset: string, st: { edge: TerrainEdgeChoice; width: number; stack: number }): string {
  const eff = st.edge === 'auto' ? defaultTerrainEdge(asset) : st.edge;
  const how =
    eff === 'fade'
      ? `Fades into the terrain under it over ${st.width} square${st.width === 1 ? '' : 's'}, in patches; against bare floor or the background only ragged.`
      : eff === 'ragged'
        ? 'A ragged, natural outline.'
        : 'A hard edge, exactly as drawn.';
  return (
    `${st.edge === 'auto' ? `Auto for ${MATERIAL_NAME[terrainMaterial(asset)]}: ` : ''}${how} ` +
    `Where two areas fade into each other, the one with the higher number (this one ${st.stack}) lies on top and forms the patches. A later area still covers an earlier one where they overlap.`
  );
}

/** "5 · like grass" for the stack select. */
function stackLabel(k: number): string {
  const like = (Object.entries(MATERIAL_STACK) as [TerrainMaterial, number][]).filter(([m, v]) => v === k && m !== 'chasm' && m !== 'ice' && m !== 'lava').map(([m]) => MATERIAL_NAME[m]);
  return like.length ? `${k} · like ${like.join(', ')}` : String(k);
}
