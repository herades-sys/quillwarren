// The map's background colour in the editor's map settings: a colour wheel
// (hue round the ring, saturation towards the rim, drawn on a canvas), a
// brightness slider, a hex field, ready-made colours and "Reset to the
// style's colour". Dragging, sliding and typing preview live; letting go (or
// a pause after the arrow keys) applies the colour as one undo step. The
// geometry is in colour-wheel-logic.ts.
import { normalizeHex, hsvToHex, type Hsv } from '@delve/core';
import { hsvOf, hsvText, wheelAt, wheelKey, wheelPixels, wheelPoint } from './colour-wheel-logic.ts';
import { btn, field, h } from './dom.ts';

export interface ColourControlOpts {
  /** The colour the map is drawn on now: its own, or the style's. */
  value: string;
  /** The style's own colour, and its name ("Classic hatching"). */
  styleColour: string;
  styleName: string;
  /** Ready-made colours offered after the style's own. */
  presets: readonly { id: string; name: string; hex: string }[];
  /** Live while dragging, sliding or typing; null ends the preview without a change. */
  onPreview(hex: string | null): void;
  /** Apply: the colour, or null for the style's own. One undo step. */
  onCommit(hex: string | null): void;
  /** What to say about a colour (hatching drawn lighter on it…). */
  hints(hex: string): string[];
}

/** The last colour picked, so a rebuilt panel keeps a grey's hue (greys have none of their own). */
let remembered: Hsv | undefined;
let uid = 0;
/** Pause after the last arrow key before the colour is applied. */
const KEY_COMMIT_MS = 700;

export function colourControl(o: ColourControlOpts): HTMLElement {
  const id = `cw-${++uid}`;
  const styleHex = normalizeHex(o.styleColour)!;
  let committed = normalizeHex(o.value) ?? styleHex;
  let hsv = hsvOf(committed, remembered);
  let shown = committed;
  let keyTimer = 0;

  // ---------- the wheel ----------
  const canvas = h('canvas', { class: 'cw-canvas', 'aria-hidden': 'true' });
  const knob = h('span', { class: 'cw-knob', 'aria-hidden': 'true' });
  const wheel = h(
    'div',
    { class: 'cw-wheel', tabindex: 0, role: 'slider', 'aria-label': 'Background colour: hue and saturation', 'aria-valuemin': 0, 'aria-valuemax': 359, 'aria-describedby': `${id}-keys` },
    canvas,
    knob,
  );
  const keys = h('span', { class: 'visually-hidden', id: `${id}-keys` }, 'Arrow keys: left and right turn the hue, up and down change the saturation; Shift takes bigger steps. Enter applies, Escape goes back.');

  // ---------- brightness, hex, swatch, reset ----------
  const brightOut = h('output', { class: 'range-value', for: `${id}-v` });
  const bright = h('input', { type: 'range', class: 'range cw-bright', id: `${id}-v`, min: 0, max: 100, step: 1, 'aria-label': 'Background brightness' });
  const hex = h('input', { class: 'input cw-hex', type: 'text', maxlength: 7, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'Background colour as hex' });
  const hexError = h('span', { class: 'field-hint cw-hex-error', id: `${id}-err`, hidden: true }, 'A colour like #2F4A33');
  hex.setAttribute('aria-describedby', `${id}-err`);
  const swatch = h('div', { class: 'cw-swatch', role: 'img' });
  const reset = btn('Reset to the style’s colour', { kind: 'ghost', size: 'sm', icon: 'rotate', onclick: () => apply(null), attrs: { class: 'btn btn-ghost btn-sm cw-reset' } });
  const hint = h('p', { class: 'hint cw-hint', 'aria-live': 'polite' });

  // ---------- ready-made colours ----------
  // the style's own colour first, as a small pill that says so
  const chips = [{ id: 'style', name: `${o.styleName}’s own`, hex: styleHex }, ...o.presets].map((p) =>
    h(
      'button',
      {
        type: 'button',
        class: `cw-chip${p.id === 'style' ? ' cw-chip-style' : ''}`,
        role: 'radio',
        'data-hex': p.hex,
        'aria-label': `${p.name}, ${p.hex}`,
        title: `${p.name} · ${p.hex}`,
        style: `--chip:${p.hex}`,
        onclick: () => apply(p.id === 'style' ? null : p.hex),
      },
      p.id === 'style' ? h('span', { class: 'cw-chip-dot', 'aria-hidden': 'true' }) : null,
      p.id === 'style' ? h('span', { 'aria-hidden': 'true' }, 'Style') : null,
    ),
  );
  const presets = h('div', { class: 'cw-chips', role: 'radiogroup', 'aria-label': 'Ready-made background colours' }, ...chips);

  // ---------- drawing ----------
  let drawnV = -1;
  let px = 0;
  function drawWheel(): void {
    const css = wheel.clientWidth || 132;
    const size = Math.round(css * Math.min(2, window.devicePixelRatio || 1));
    if (size === px && Math.abs(drawnV - hsv.v) < 1e-4) return;
    px = size;
    drawnV = hsv.v;
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.putImageData(new ImageData(wheelPixels(size, hsv.v), size, size), 0, 0);
  }

  /** Bring every part in step with `hsv` (the hex field too, unless the user is typing in it). */
  function sync(fromHex = false): void {
    shown = hsvToHex(hsv);
    drawWheel();
    const r = (wheel.clientWidth || 132) / 2;
    const p = wheelPoint(hsv, r);
    knob.style.transform = `translate(${p.x}px, ${p.y}px)`;
    knob.style.background = shown;
    wheel.setAttribute('aria-valuenow', String(Math.round(hsv.h)));
    wheel.setAttribute('aria-valuetext', `${shown}: ${hsvText(hsv)}`);
    bright.value = String(Math.round(hsv.v * 100));
    bright.style.setProperty('--fill', `${Math.round(hsv.v * 100)}%`);
    bright.style.setProperty('--cw-full', hsvToHex({ ...hsv, v: 1 }));
    bright.setAttribute('aria-valuetext', `${Math.round(hsv.v * 100)}%`);
    brightOut.textContent = `${Math.round(hsv.v * 100)}%`;
    if (!fromHex) {
      hex.value = shown;
      hex.removeAttribute('aria-invalid');
      hexError.hidden = true;
    }
    swatch.style.background = shown;
    const own = shown !== styleHex;
    swatch.setAttribute('aria-label', own ? `Background ${shown}` : `Background ${shown}, the style’s own`);
    swatch.dataset.own = String(own);
    reset.hidden = committed === styleHex && shown === styleHex;
    for (const c of chips) c.setAttribute('aria-checked', String(c.dataset.hex === shown));
    hint.textContent = o.hints(shown).join(' ');
  }

  function preview(): void {
    sync();
    o.onPreview(shown);
  }

  /** Apply a colour (null: the style's own) as one undo step. */
  function apply(next: string | null): void {
    clearTimeout(keyTimer);
    const target = next === null ? styleHex : (normalizeHex(next) ?? committed);
    hsv = hsvOf(target, hsv);
    remembered = hsv;
    sync();
    if (target === committed) {
      o.onPreview(null);
      return;
    }
    committed = target;
    reset.hidden = committed === styleHex;
    o.onCommit(target === styleHex ? null : target);
  }

  /** Back to the applied colour, dropping the preview. */
  function cancel(): void {
    clearTimeout(keyTimer);
    hsv = hsvOf(committed, hsv);
    sync();
    o.onPreview(null);
  }

  // ---------- pointer (mouse, pen, touch) on the wheel ----------
  let dragging = false;
  function pick(e: PointerEvent): void {
    const r = canvas.getBoundingClientRect();
    const radius = r.width / 2;
    const at = wheelAt(e.clientX - (r.left + radius), e.clientY - (r.top + radius), radius);
    // on black every hue looks the same: picking a hue lifts the brightness so the choice shows
    hsv = { ...hsv, ...at, v: hsv.v < 0.04 ? 0.6 : hsv.v };
    preview();
  }
  wheel.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    wheel.focus({ preventScroll: true });
    dragging = true;
    wheel.setPointerCapture(e.pointerId);
    wheel.classList.add('is-dragging');
    pick(e);
  });
  wheel.addEventListener('pointermove', (e) => {
    if (dragging) pick(e);
  });
  const drop = (e: PointerEvent, keep: boolean) => {
    if (!dragging) return;
    dragging = false;
    wheel.classList.remove('is-dragging');
    if (wheel.hasPointerCapture(e.pointerId)) wheel.releasePointerCapture(e.pointerId);
    if (keep) apply(shown);
    else cancel();
  };
  wheel.addEventListener('pointerup', (e) => drop(e, true));
  wheel.addEventListener('pointercancel', (e) => drop(e, false));
  wheel.addEventListener('lostpointercapture', (e) => drop(e, true));

  // ---------- keys on the wheel ----------
  wheel.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      apply(shown);
      return;
    }
    if (e.key === 'Escape') {
      if (shown === committed) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    const next = wheelKey(hsv, e.key, e.shiftKey);
    if (!next) return;
    // the editor's arrow keys move the selection: not while the wheel has them
    e.preventDefault();
    e.stopPropagation();
    hsv = { ...next, v: next.v < 0.04 && next.s !== hsv.s ? 0.6 : next.v };
    preview();
    clearTimeout(keyTimer);
    keyTimer = window.setTimeout(() => apply(shown), KEY_COMMIT_MS);
  });
  wheel.addEventListener('blur', () => {
    if (!dragging && shown !== committed) apply(shown);
  });

  // ---------- brightness ----------
  bright.addEventListener('input', () => {
    hsv = { ...hsv, v: Number(bright.value) / 100 };
    preview();
  });
  bright.addEventListener('change', () => apply(shown));
  bright.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shown !== committed) {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  });

  // ---------- hex ----------
  hex.addEventListener('input', () => {
    const v = normalizeHex(hex.value);
    const typed = hex.value.trim();
    const bad = !v && typed.replace('#', '').length >= 6;
    hex.toggleAttribute('aria-invalid', bad);
    hexError.hidden = !bad;
    if (!v) return;
    hsv = hsvOf(v, hsv);
    sync(true);
    o.onPreview(shown);
  });
  hex.addEventListener('change', () => {
    const v = normalizeHex(hex.value);
    if (v) apply(v);
    else {
      hex.setAttribute('aria-invalid', 'true');
      hexError.hidden = false;
      cancel();
      hex.value = committed;
    }
  });
  hex.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // the panel's own Escape puts the field back and redraws the panel; the preview ends with it
    o.onPreview(null);
  });

  const box = h(
    'div',
    { class: 'cw' },
    h(
      'div',
      { class: 'cw-top' },
      wheel,
      h('div', { class: 'cw-side' }, swatch, field('Hex', h('div', {}, hex, hexError))),
    ),
    h('div', {}, h('div', { class: 'range-head' }, h('label', { for: `${id}-v` }, 'Brightness'), brightOut), bright),
    presets,
    reset,
    hint,
    keys,
  );
  // the wheel draws at its real size once it is in the page (and again if that changes)
  new ResizeObserver(() => sync(document.activeElement === hex)).observe(wheel);
  sync();
  return box;
}
