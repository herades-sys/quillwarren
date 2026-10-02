// Small DOM helpers that build @delve/ui's components (docs/UI.md), so the
// editor, its tools and the chat all make the same markup: fields, selects,
// checkboxes, sliders, segmented controls, buttons and icons.
import { icon, type IconName } from '@delve/ui';

export const SVG_NS = 'http://www.w3.org/2000/svg';

export type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;
export type Kid = Node | string | null | false | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== false && kid !== undefined) el.append(kid);
  return el;
}

export function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const parser = document.createElement('template');
/** An icon from the design's set as an element. */
export function iconEl(name: IconName, size = 18, stroke?: number): SVGSVGElement {
  parser.innerHTML = icon(name, stroke === undefined ? { size } : { size, stroke });
  return parser.content.firstElementChild as SVGSVGElement;
}

let uid = 0;
const nextId = () => `f-${++uid}`;

/** A labelled field: the label points at the input; `unit` sits inside the box on the right. */
export function field(label: string, input: HTMLElement, o: { unit?: string; hint?: string; error?: boolean } = {}): HTMLDivElement {
  const control = input.matches('input, select, textarea') ? input : input.querySelector<HTMLElement>('input, select, textarea');
  if (control && !control.id) control.id = nextId();
  const hintId = o.hint ? nextId() : undefined;
  if (control && hintId) control.setAttribute('aria-describedby', hintId);
  const box = o.unit ? h('div', { class: 'input-unit' }, input, h('span', { class: 'unit' }, o.unit)) : input;
  return h(
    'div',
    { class: `field${o.error ? ' has-error' : ''}` },
    h('label', control ? { for: control.id } : {}, label),
    box,
    o.hint ? h('span', { class: 'field-hint', id: hintId }, o.hint) : null,
  );
}

/** A text or number box in the design's look. */
export function input(attrs: Attrs = {}): HTMLInputElement {
  return h('input', { class: 'input', type: 'text', ...attrs });
}

export function textarea(value: string, attrs: Attrs = {}): HTMLTextAreaElement {
  const t = h('textarea', { class: 'input', rows: 3, ...attrs });
  t.value = value;
  return t;
}

/** A native select with the design's chevron. `options` are [value, label] or ready <option>/<optgroup> elements. */
export function select(options: ([string, string] | HTMLElement)[], value: string, onchange: (v: string) => void, attrs: Attrs = {}): HTMLDivElement {
  const sel = h(
    'select',
    { class: 'input', onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value), ...attrs },
    ...options.map((o) => (Array.isArray(o) ? h('option', { value: o[0], selected: o[0] === value }, o[1]) : o)),
  );
  if (options.every((o) => !Array.isArray(o))) sel.value = value;
  return h('div', { class: 'select' }, sel, iconEl('chevron-down', 14));
}

/** The design's checkbox: a native input, drawn as a box with a tick. */
export function checkbox(label: Kid, checked: boolean, onchange: (on: boolean) => void, o: { hint?: string; key?: string; disabled?: boolean } = {}): HTMLLabelElement {
  return h(
    'label',
    { class: 'check' },
    h('input', { type: 'checkbox', checked, disabled: o.disabled, onchange: (e: Event) => onchange((e.target as HTMLInputElement).checked) }),
    h('span', { class: 'box' }, iconEl('check', 12, 2.8)),
    h('span', {}, label),
    o.hint ? h('span', { class: 'check-hint' }, o.hint) : null,
    o.key ? h('span', { class: 'ed-check-key' }, o.key) : null,
  );
}

export interface RangeOpts {
  value: number;
  min: number;
  max: number;
  step: number;
  /** The badge text for a value. */
  show(v: number): string;
  /** Committed on release (change); `onInput` follows the drag. */
  onChange(v: number): void;
  onInput?(v: number): void;
  /** Faint text between the label and the badge, e.g. "Q / E". */
  keys?: string;
}

const fillOf = (v: number, min: number, max: number) => `${max > min ? ((v - min) / (max - min)) * 100 : 0}%`;

/** A labelled slider with its value in a badge, as in the inspector. */
export function range(label: string, o: RangeOpts): HTMLDivElement {
  const out = h('output', { class: 'range-value' }, o.show(o.value));
  const r = h('input', {
    type: 'range',
    class: 'range',
    min: o.min,
    max: o.max,
    step: o.step,
    value: o.value,
    'aria-label': label,
    oninput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      out.textContent = o.show(v);
      o.onInput?.(v);
    },
    onchange: (e: Event) => o.onChange(Number((e.target as HTMLInputElement).value)),
  });
  r.style.setProperty('--fill', fillOf(o.value, o.min, o.max));
  return h('div', {}, h('div', { class: 'range-head' }, h('span', {}, label), o.keys ? h('span', { class: 'text-faint', style: 'font-size:11px;margin-right:6px' }, o.keys) : null, out), r);
}

/** A compact slider for the context bar: label, track, value. */
export function miniRange(label: string, o: RangeOpts): HTMLLabelElement {
  const out = h('output', {}, o.show(o.value));
  const r = h('input', {
    type: 'range',
    class: 'range',
    min: o.min,
    max: o.max,
    step: o.step,
    value: o.value,
    'aria-label': label,
    oninput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      out.textContent = o.show(v);
      o.onInput?.(v);
    },
    onchange: (e: Event) => o.onChange(Number((e.target as HTMLInputElement).value)),
  });
  r.style.setProperty('--fill', fillOf(o.value, o.min, o.max));
  return h('label', { class: 'ed-ctx-slider' }, h('span', {}, label), r, out);
}

/** A segmented control on native radios. */
export function seg<T extends string>(name: string, options: [T, Kid][], value: T, onchange: (v: T) => void, cls = ''): HTMLDivElement {
  return h(
    'div',
    { class: `seg ${cls}`.trim(), role: 'radiogroup' },
    ...options.map(([v, label]) => h('label', { class: 'seg-opt' }, h('input', { type: 'radio', name, value: v, checked: v === value, onchange: () => onchange(v) }), label)),
  );
}

export interface BtnOpts {
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'plain';
  size?: 'sm';
  icon?: IconName;
  iconSize?: number;
  title?: string;
  /** A shortcut shown faint inside the button ("Ctrl D"). */
  keyHint?: string;
  onclick?: (e: Event) => void;
  disabled?: boolean;
  attrs?: Attrs;
}

export function btn(label: Kid, o: BtnOpts = {}): HTMLButtonElement {
  const cls = ['btn', `btn-${o.kind ?? 'secondary'}`, o.size === 'sm' ? 'btn-sm' : ''].filter(Boolean).join(' ');
  return h(
    'button',
    { type: 'button', class: cls, title: o.title, onclick: o.onclick, disabled: o.disabled, ...o.attrs },
    o.icon ? iconEl(o.icon, o.iconSize ?? (o.size === 'sm' ? 14 : 15)) : null,
    label,
    o.keyHint ? h('span', { class: 'key' }, o.keyHint) : null,
  );
}

/** An icon-only button: needs a label, and gets a title with the shortcut. */
export function iconBtn(name: IconName, label: string, onclick: (e: Event) => void, o: { title?: string; size?: number; pressed?: boolean } = {}): HTMLButtonElement {
  return h(
    'button',
    { type: 'button', class: 'btn btn-icon', 'aria-label': label, title: o.title ?? label, onclick, 'aria-pressed': o.pressed === undefined ? undefined : String(o.pressed) },
    iconEl(name, o.size ?? 17),
  );
}
