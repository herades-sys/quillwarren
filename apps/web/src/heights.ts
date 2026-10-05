// The editor's Height tool (K): raised and sunken ground within one map (core
// heights.ts). Its context bar (shape, height, edge, flat or hill), the inspector's fields,
// the dashed outlines of the areas while the tool is on, and "Where you can go"
// (Shift K): the movement overlay, ground tinted by height, cliff edges nobody
// crosses as a red dashed line, crossings (stairs, ladders, slopes, steps) green.
import { HEIGHT_EDGES, type DelveMap, type HeightArea, type HeightEdge, type HeightProfile, type Shape, type SquareUnit } from '@delve/core';
import { h, type Kid } from './dom.ts';

export { bandColor, drawMovement, loadMovement, movementIcon, MOVEMENT_KEY, saveMovement } from './movement-overlay.ts';
import { heightValue, parseHeight } from './height-text.ts';
export { heightValue, parseHeight };

export type EdgeChoice = HeightEdge | 'auto';
export type ProfileChoice = HeightProfile | 'auto';

export interface HeightToolState {
  height: number;
  edge: EdgeChoice;
  profile?: ProfileChoice;
}

export const PROFILE_CHOICES: [ProfileChoice, string, string][] = [
  ['auto', 'Auto', 'A hill when the edge is a slope, else flat'],
  ['plateau', 'Flat', 'A plateau, flat on top: ledges, arenas, built platforms'],
  ['hill', 'Hill', 'Rounded: rises from its edge to the full height toward the middle; long shapes become ridges'],
];

/** The profile chips: Auto, Flat, Hill. */
export function profileChips(kit: CtxKit, value: ProfileChoice, pick: (v: ProfileChoice) => void): HTMLElement {
  return kit.group('Top', ...PROFILE_CHOICES.map(([k, label, title]) => kit.chip(label, value === k, () => pick(k), { title })));
}

/** The inspector's profile select ("Auto" is no `profile`). */
export const PROFILE_OPTIONS: [string, string][] = [
  ['auto', 'Auto (hill for a slope)'],
  ['plateau', 'Flat'],
  ['hill', 'Hill'],
];

export const EDGE_CHOICES: [EdgeChoice, string, string][] = [
  ['auto', 'Auto', 'A drop of a square or more is a cliff (indoors) or rock face (outdoors), less a step'],
  ['cliff', 'Cliff', 'A sheer ledge: a firm line with ticks on the low side. Not walkable'],
  ['rock', 'Rock face', 'A cliff drawn as a band of rock, as wide as the drop. Not walkable'],
  ['slope', 'Slope', 'A hill or ramp, walkable: contours and soft shading'],
  ['step', 'Step', 'A low step or rubble: walkable'],
];

export const EDGE_NAME: Record<HeightEdge, string> = { cliff: 'Cliff', rock: 'Rock face', slope: 'Slope', step: 'Step' };

export const HEIGHT_HINT = 'Drag over a room or terrain to raise or sink the ground there: a ledge, a hill, a pit. A hill rounds off toward its middle, a flat top stays level. Stairs or a ladder across a cliff edge are the way up. Shift keeps width and height equal.';

/** The new area the Height tool makes from a drawn shape. */
export function heightObject(map: DelveMap, id: string, shape: Shape, st: HeightToolState): HeightArea {
  return { id, type: 'height', shape, height: st.height, ...(st.edge !== 'auto' ? { edge: st.edge } : {}), ...(st.profile && st.profile !== 'auto' ? { profile: st.profile } : {}) };
}

/** A small legend for the overlay (the map settings and the Height tool's bar show it). */
export function movementLegend(): HTMLElement {
  const key = (color: string, dash: boolean, text: string) =>
    h('span', { style: 'display:inline-flex;align-items:center;gap:5px' }, h('span', { style: `width:18px;height:0;border-top:3px ${dash ? 'dashed' : 'solid'} ${color}` }), text);
  return h('span', { class: 'ed-ctx-hint', style: 'display:inline-flex;gap:10px;flex-wrap:wrap' }, key('#e5484d', true, 'blocked'), key('#30a46c', false, 'crossing'));
}

// ---------- the context bar and the inspector ----------

export interface CtxKit {
  chip(label: Kid, on: boolean, pick: () => void, o?: { title?: string }): HTMLElement;
  group(label: string, ...kids: HTMLElement[]): HTMLElement;
  rerender(): void;
}

/** The Height tool's height box: −, the value, +; the steps are a square's size. */
export function heightBox(value: number, unit: SquareUnit, on: (v: number) => void): HTMLElement {
  const box = h('input', {
    class: 'input',
    type: 'text',
    inputmode: 'decimal',
    'aria-label': `Height in ${unit.name}`,
    value: heightValue(value),
    style: 'width:62px;min-height:28px;padding:2px 6px;text-align:center;font-variant-numeric:tabular-nums',
    onchange: (e: Event) => {
      const v = parseHeight((e.target as HTMLInputElement).value);
      if (v === null) (e.target as HTMLInputElement).value = heightValue(value);
      else on(v);
    },
  });
  const stepBtn = (d: number, label: string, glyph: string) => h('button', { type: 'button', class: 'btn btn-plain btn-sm', 'aria-label': label, title: label, style: 'width:28px;padding:0;justify-content:center', onclick: () => on(Math.round((value + d) * 100) / 100) }, glyph);
  return h(
    'span',
    { style: 'display:inline-flex;align-items:center;gap:2px', role: 'group', 'aria-label': 'Height' },
    h('span', { class: 'ed-ctx-label' }, 'Height'),
    stepBtn(-unit.size, `${unit.size} ${unit.name} lower`, '−'),
    box,
    stepBtn(unit.size, `${unit.size} ${unit.name} higher`, '+'),
    h('span', { class: 'ed-ctx-hint', style: 'padding:0 2px' }, unit.name),
  );
}

/** The edge chips: Auto, Cliff, Rock face, Slope, Step. */
export function edgeChips(kit: CtxKit, value: EdgeChoice, pick: (v: EdgeChoice) => void): HTMLElement {
  return kit.group('Edge', ...EDGE_CHOICES.map(([k, label, title]) => kit.chip(label, value === k, () => pick(k), { title })));
}

/** Which edge kinds a selected area may have, for its inspector select ("Auto" is no `edge`). */
export const EDGE_OPTIONS: [string, string][] = [['auto', 'Auto (by the drop)'], ...HEIGHT_EDGES.map((k): [string, string] => [k, EDGE_NAME[k]])];
