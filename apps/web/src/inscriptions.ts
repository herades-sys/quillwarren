// Handwritten handout notes (inscription objects) in the map editor: drawn on
// the editor's overlay as a dashed outline with their text, so the GM sees
// them, and their inspector fields. They are placed on the handout page
// (/maps/:id/handout, apps/web/src/handout.ts); here they can be selected,
// moved, changed and deleted like any object.
import {
  INSCRIPTION_INK,
  INSCRIPTION_INKS,
  INSCRIPTION_MAX,
  INSCRIPTION_SIZE,
  inscriptionBox,
  inscriptionSeed,
  inscriptionsOf,
  inscriptionSvg,
  mapSeedOf,
  type DelveMap,
  type Inscription,
  type InscriptionInk,
  type Op,
} from '@delve/core';
import { checkbox, field, h, input, range, seg, svgEl, textarea } from './dom.ts';

const OUTLINE = 'fill:none;stroke:var(--canvas-select);stroke-opacity:.75;stroke-width:1.5px;stroke-dasharray:4 3;vector-effect:non-scaling-stroke';

/**
 * Every note on the overlay (map squares): a dashed box turned with the note,
 * and, for the ones only on the handout (the map's picture doesn't have them),
 * the text itself, faint, as the handout draws it.
 */
export function drawInscriptions(layer: SVGElement, map: DelveMap): void {
  const notes = inscriptionsOf(map);
  if (!notes.length) return;
  const seed = mapSeedOf(map);
  const g = svgEl('g', { class: 'ed-inscriptions', 'pointer-events': 'none' });
  for (const o of notes) {
    const { w, h: hh } = inscriptionBox(o);
    const pad = (o.size ?? INSCRIPTION_SIZE) * 0.15;
    const turn = o.rotation ? `rotate(${o.rotation} ${o.at[0]} ${o.at[1]})` : '';
    const box = svgEl('rect', { x: o.at[0] - w / 2 - pad, y: o.at[1] - hh / 2 - pad, width: w + 2 * pad, height: hh + 2 * pad, rx: pad, style: OUTLINE, ...(turn ? { transform: turn } : {}) });
    g.appendChild(box);
    if (!o.onMap) {
      const text = svgEl('g', { opacity: 0.6 });
      text.innerHTML = inscriptionSvg(o, inscriptionSeed(seed, o.id));
      g.appendChild(text);
    }
  }
  layer.appendChild(g);
}

export interface InscriptionFieldDeps {
  apply(ops: Op[]): Promise<void>;
  mapId: string;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** The inspector's fields for a note: text, size, tilt, ink, "also on the map", and where it is. */
export function inscriptionFields(o: Inscription, { apply, mapId }: InscriptionFieldDeps): HTMLElement[] {
  const set = (fields: Record<string, unknown>) => void apply([{ op: 'update', id: o.id, set: fields }]);
  const unset = (key: string) => void apply([{ op: 'update', id: o.id, unset: [key] }]);
  const num = (value: number, on: (v: number) => void) =>
    input({
      inputmode: 'decimal',
      value: String(value),
      style: 'font-variant-numeric:tabular-nums',
      onchange: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value.replace(',', '.').trim());
        if (Number.isFinite(v)) on(round2(v));
      },
    });
  const text = textarea(o.text, {
    rows: 3,
    maxlength: INSCRIPTION_MAX,
    'data-field': 'text',
    style: 'font-family:var(--font-display);font-style:italic;font-size:15px',
    onchange: (e: Event) => {
      const v = (e.target as HTMLTextAreaElement).value.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
      if (v.trim() && v !== o.text) set({ text: v });
    },
  });
  const inks: [InscriptionInk, Node][] = INSCRIPTION_INKS.map((k) => [
    k,
    h('span', { style: 'display:inline-flex;align-items:center;gap:5px' }, h('span', { style: `width:9px;height:9px;border-radius:50%;background:${INSCRIPTION_INK[k].color}` }), INSCRIPTION_INK[k].name),
  ]);
  const tilt = Math.round(o.rotation ?? 0);
  return [
    field('Text', text, { hint: 'Enter starts a new line; written in the handout’s old italic hand' }),
    field('Size (text height)', num(o.size ?? INSCRIPTION_SIZE, (v) => (v > 0 && v !== INSCRIPTION_SIZE ? set({ size: Math.min(20, v) }) : unset('size'))), { unit: 'sq' }),
    h('div', { class: 'ed-two' }, field('X (centre)', num(o.at[0], (v) => set({ at: [v, o.at[1]] })), { unit: 'sq' }), field('Y (centre)', num(o.at[1], (v) => set({ at: [o.at[0], v] })), { unit: 'sq' })),
    range('Tilt', { value: tilt, min: -45, max: 45, step: 1, show: (v) => `${v < 0 ? '−' : ''}${Math.abs(v)}°`, onChange: (v) => (v ? set({ rotation: v }) : unset('rotation')) }),
    field('Ink', seg(`ink-${o.id}`, inks, o.ink ?? 'brown', (v) => (v === 'brown' ? unset('ink') : set({ ink: v })), 'ed-seg-full')),
    checkbox('Also on the normal map', Boolean(o.onMap), (on) => (on ? set({ onMap: true }) : unset('onMap'))),
    h('p', { class: 'hint' }, 'Players see handout notes, whatever the fog. ', h('a', { href: `/maps/${encodeURIComponent(mapId)}/handout` }, 'Open the handout'), ' to place and drag them on the sheet.'),
  ];
}
