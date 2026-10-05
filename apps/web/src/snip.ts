// Snip mode: export exactly the part of the map you drag a box over, like the
// Windows Snipping Tool. Shift S or the Snip button starts it: the map dims,
// you drag a box (whole squares), adjust it by its handles or the arrow keys,
// and Save PNG (or SVG, or the parchment handout of that area). Pan and zoom
// keep working; the editor's tools step aside until it ends. Admin and GM
// accounts only (the page leaves the button out for everyone else, and the
// viewer doesn't start this). The geometry and URLs are in snip-logic.ts.
import { selectionBounds, type Bounds, type DelveMap, type Point, type View } from '@delve/core';
import { onControl } from './ctx.ts';
import { btn, checkbox, h, iconBtn, seg, select, svgEl } from './dom.ts';
import type { Shell } from './shell.ts';
import {
  adjust,
  boxFromDrag,
  cursorFor,
  DEFAULT_OPTIONS,
  fileNameOf,
  handleAt,
  keyAdjust,
  memoryKey,
  parseMemory,
  PPG_CHOICES,
  sizeLabel,
  sizeProblem,
  snipUrls,
  squaresOf,
  type Handle,
  type SnipOptions,
} from './snip-logic.ts';

export interface SnipCtx {
  mapId: string;
  stage: HTMLElement;
  overlay: SVGSVGElement;
  shell: Shell;
  handled: WeakSet<Event>;
  map(): DelveMap;
  view(): View;
  setView(v: View): void;
  /** The ?style= override of the page, if any. */
  style(): string | null;
  toMap(clientX: number, clientY: number): Point | null;
  toScreen(p: Point): { x: number; y: number } | null;
  squaresPerPx(): number;
  /** The part of the map on screen (the overlay's viewBox). */
  viewBox(): Bounds | null;
  /** The whole picture, as Export draws it. */
  mapBounds(): Bounds | null;
  /** The editor's selection (empty when only viewing). */
  selection(): string[];
  suspendEditor(on: boolean): void;
  onRender(cb: () => void): void;
  onView(cb: () => void): void;
}

export interface Snip {
  start(): void;
  stop(): void;
  toggle(): void;
  active(): boolean;
}

const store = {
  get: (k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string): void => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private window: the snip just isn't remembered */
    }
  },
};

const typing = (t: EventTarget | null) => t instanceof HTMLElement && Boolean(t.closest('input, select, textarea, [contenteditable="true"]'));
const rectD = (b: Bounds) => `M${b.x0} ${b.y0}H${b.x1}V${b.y1}H${b.x0}Z`;
/** The keys that keep working while snipping: zoom, fit, the view and the grid, the shortcuts list. */
const passThrough = (e: KeyboardEvent): boolean =>
  ['+', '=', '-', '?', 'PageUp', 'PageDown'].includes(e.key) || ((e.ctrlKey || e.metaKey) && e.key === '0') || (e.shiftKey && ['p', 'g'].includes(e.key.toLowerCase()));

type Drag = { kind: 'new'; start: Point; x: number; y: number; moved: boolean } | { kind: Handle; from: Point; orig: Bounds };

export function initSnip(ctx: SnipCtx): Snip {
  let active = false;
  let box: Bounds | null = null;
  let opts: SnipOptions = { ...DEFAULT_OPTIONS };
  let drag: Drag | null = null;
  let spaceDown = false;
  let busy = false;
  const button = document.getElementById('snip-btn');

  const layer = svgEl('g', { class: 'snip' });
  const hint = h('div', { class: 'snip-hint', role: 'status' });
  const bar = h('div', { class: 'snip-bar', role: 'toolbar', 'aria-label': 'Snip an area' });

  // ---------- the snip bar ----------

  const readout = h('span', { class: 'snip-size', 'aria-live': 'polite' });
  const problemEl = h('span', { class: 'snip-problem', role: 'alert' });
  let viewSeg: HTMLDivElement;
  let revealedBox: HTMLLabelElement;
  let selectionBtn: HTMLButtonElement;
  let saveBtn: HTMLButtonElement;
  let svgBtn: HTMLButtonElement;
  let handoutBtn: HTMLButtonElement;

  function buildBar(): void {
    viewSeg = seg<View>(
      'snip-view',
      [
        ['gm', 'GM'],
        ['players', 'Players'],
      ],
      ctx.view(),
      (v) => ctx.setView(v),
      'seg-ground snip-view',
    );
    const ppgs: [string, string][] = PPG_CHOICES.map((n) => [String(n), n === 70 ? '70 px · Roll20' : `${n} px`]);
    if (!PPG_CHOICES.includes(opts.ppg as (typeof PPG_CHOICES)[number])) ppgs.push([String(opts.ppg), `${opts.ppg} px`]);
    const ppgSelect = select(ppgs, String(opts.ppg), (v) => setOpt({ ppg: Number(v) }), { 'aria-label': 'Pixels per square', title: 'Pixels per square' });
    revealedBox = checkbox('Only what’s revealed', opts.revealed, (on) => setOpt({ revealed: on }));
    selectionBtn = btn('Selection', { kind: 'ghost', size: 'sm', title: 'The selection plus a square, like Crop to selection', onclick: () => frame(selectionFrame()) });
    svgBtn = btn('SVG', { kind: 'secondary', size: 'sm', title: 'Save this area as an SVG', onclick: () => void save('svg') });
    handoutBtn = btn('Handout', { kind: 'secondary', size: 'sm', icon: 'notes', title: 'The parchment handout of this area', onclick: () => handout() });
    saveBtn = btn('Save PNG', { kind: 'primary', size: 'sm', icon: 'download', title: 'Save this area as a PNG · Enter', onclick: () => void save('png') });
    bar.replaceChildren(
      h(
        'div',
        { class: 'snip-row' },
        readout,
        viewSeg,
        h('div', { class: 'snip-ppg' }, ppgSelect),
        checkbox('Grid', opts.grid, (on) => setOpt({ grid: on })),
        checkbox('Transparent', opts.transparent, (on) => setOpt({ transparent: on }), { hint: 'no parchment' }),
        revealedBox,
      ),
      h(
        'div',
        { class: 'snip-row' },
        selectionBtn,
        btn('Whole map', { kind: 'ghost', size: 'sm', title: 'Everything Export would draw', onclick: () => frame(wholeFrame()) }),
        problemEl,
        h('span', { class: 'spacer' }),
        handoutBtn,
        svgBtn,
        saveBtn,
        iconBtn('x', 'Cancel snip', () => stop(), { title: 'Cancel · Esc', size: 16 }),
      ),
    );
  }

  function setOpt(o: Partial<SnipOptions>): void {
    opts = { ...opts, ...o };
    remember();
    update();
  }

  function syncBar(): void {
    if (!box) {
      bar.hidden = true;
      return;
    }
    bar.hidden = Boolean(drag);
    const view = ctx.view();
    for (const r of viewSeg.querySelectorAll<HTMLInputElement>('input')) r.checked = r.value === view;
    revealedBox.hidden = view !== 'players';
    selectionBtn.hidden = !selectionFrame();
    readout.textContent = sizeLabel(box, opts.ppg);
    const problem = sizeProblem(box, opts.ppg);
    problemEl.textContent = problem ? `Too big: ${problem}` : '';
    problemEl.hidden = !problem;
    readout.classList.toggle('is-bad', Boolean(problem));
    saveBtn.disabled = busy || Boolean(problem);
    svgBtn.disabled = busy;
    handoutBtn.disabled = busy;
  }

  /** Under the box, or above it at the bottom of the screen, or along the bottom when the box fills the view. */
  function placeBar(): void {
    if (!box || bar.hidden) return;
    const a = ctx.toScreen([box.x0, box.y0]);
    const b = ctx.toScreen([box.x1, box.y1]);
    if (!a || !b) return;
    const sr = ctx.stage.getBoundingClientRect();
    const bw = bar.offsetWidth;
    const bh = bar.offsetHeight;
    const gap = 12;
    let top = b.y - sr.top + gap;
    if (top + bh > sr.height - gap) top = a.y - sr.top - gap - bh;
    if (top < gap) top = sr.height - bh - 64;
    const left = Math.min(Math.max((a.x + b.x) / 2 - sr.left - bw / 2, gap), Math.max(gap, sr.width - bw - gap));
    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(Math.max(gap, top))}px`;
  }

  // ---------- drawing ----------

  function draw(): void {
    layer.replaceChildren();
    const vb = ctx.viewBox();
    if (!active || !vb) return;
    const px = ctx.squaresPerPx();
    // the veil over everything but the box; the overlay draws past its viewBox, so reach well beyond the view
    const w = vb.x1 - vb.x0;
    const ht = vb.y1 - vb.y0;
    const all = { x0: vb.x0 - 2 * w, y0: vb.y0 - 2 * ht, x1: vb.x1 + 2 * w, y1: vb.y1 + 2 * ht };
    layer.appendChild(svgEl('path', { d: rectD(all) + (box ? rectD(box) : ''), 'fill-rule': 'evenodd', class: 'snip-veil' }));
    if (!box) return;
    layer.appendChild(svgEl('rect', { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0, class: 'snip-box' }));
    const s = 8 * px;
    const mx = (box.x0 + box.x1) / 2;
    const my = (box.y0 + box.y1) / 2;
    for (const [x, y] of [[box.x0, box.y0], [mx, box.y0], [box.x1, box.y0], [box.x1, my], [box.x1, box.y1], [mx, box.y1], [box.x0, box.y1], [box.x0, my]] as Point[]) {
      layer.appendChild(svgEl('rect', { x: x - s / 2, y: y - s / 2, width: s, height: s, class: 'handle' }));
    }
    // the size chip at the top-left corner: above the box, or just inside it at the top of the view
    const text = sizeLabel(box, opts.ppg);
    const cw = (text.length * 6.4 + 14) * px;
    const ch = 20 * px;
    const cx = box.x0;
    const cy = box.y0 - ch - 6 * px < vb.y0 ? box.y0 + 6 * px : box.y0 - ch - 6 * px;
    layer.appendChild(svgEl('rect', { x: cx, y: cy, width: cw, height: ch, rx: 4 * px, class: 'dim-bg' }));
    const label = svgEl('text', { x: cx + cw / 2, y: cy + 14 * px, 'font-size': 11 * px, 'text-anchor': 'middle', class: 'dim' });
    label.textContent = text;
    layer.appendChild(label);
  }

  function update(): void {
    if (!active) return;
    hint.textContent = box ? 'Drag the edges to adjust · arrows move, Shift + arrows resize · Enter saves · Esc cancels' : 'Drag over the area to export · Esc cancels';
    draw();
    syncBar();
    placeBar();
  }

  // ---------- frames ----------

  function selectionFrame(): Bounds | null {
    const b = selectionBounds(ctx.map(), ctx.selection());
    return b ? boxFromDrag([b.x0 - 1, b.y0 - 1], [b.x1 + 1, b.y1 + 1]) : null;
  }
  function wholeFrame(): Bounds | null {
    const b = ctx.mapBounds();
    return b ? boxFromDrag([b.x0, b.y0], [b.x1, b.y1]) : null;
  }
  function frame(b: Bounds | null): void {
    if (!b) return;
    box = b;
    remember();
    update();
  }

  function remember(): void {
    if (box) store.set(memoryKey(ctx.mapId), JSON.stringify({ box, options: opts }));
  }

  // ---------- saving ----------

  async function save(kind: 'png' | 'svg'): Promise<void> {
    if (!box || busy) return;
    const problem = kind === 'png' ? sizeProblem(box, opts.ppg) : null;
    if (problem) return ctx.shell.toast(`Too big: ${problem}`);
    const urls = snipUrls(ctx.mapId, box, ctx.view(), opts, ctx.style());
    const { w, h: hs } = squaresOf(box);
    remember();
    busy = true;
    syncBar();
    if (kind === 'png') saveBtn.textContent = 'Saving…';
    try {
      const res = await fetch(kind === 'png' ? urls.png : urls.svg);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `the export failed (${res.status})`);
      }
      const name = fileNameOf(res.headers.get('content-disposition'), `map_${w}x${hs}.${kind}`);
      const url = URL.createObjectURL(await res.blob());
      const a = h('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      ctx.shell.toast(`Saved ${name}`, 'info');
      busy = false;
      stop();
    } catch (e) {
      ctx.shell.toast((e as Error).message);
    } finally {
      busy = false;
      if (active) {
        buildBar();
        update();
      }
    }
  }

  function handout(): void {
    if (!box) return;
    remember();
    window.open(snipUrls(ctx.mapId, box, ctx.view(), opts, ctx.style()).handout, '_blank', 'noopener');
    stop();
  }

  // ---------- start and stop ----------

  function start(): void {
    if (active) return;
    const mem = parseMemory(store.get(memoryKey(ctx.mapId)));
    opts = mem ? mem.options : { ...DEFAULT_OPTIONS };
    box = mem ? mem.box : null;
    active = true;
    drag = null;
    ctx.shell.closeMenu();
    ctx.suspendEditor(true);
    document.body.classList.add('snipping');
    ctx.stage.classList.add('snipping');
    ctx.overlay.appendChild(layer);
    buildBar();
    ctx.stage.append(hint, bar);
    button?.setAttribute('aria-pressed', 'true');
    update();
  }

  function stop(): void {
    if (!active) return;
    active = false;
    drag = null;
    spaceDown = false;
    layer.replaceChildren();
    layer.remove();
    hint.remove();
    bar.remove();
    document.body.classList.remove('snipping');
    ctx.stage.classList.remove('snipping', 'panning');
    ctx.stage.style.removeProperty('cursor');
    button?.setAttribute('aria-pressed', 'false');
    ctx.suspendEditor(false);
  }

  const toggle = () => (active ? stop() : start());
  button?.addEventListener('click', toggle);
  ctx.shell.onAction('snip', start);

  // ---------- pointer (capturing, so it comes before the markers and the editor) ----------

  const cursor = (c: string) => ctx.stage.style.setProperty('cursor', c, 'important');

  ctx.stage.addEventListener(
    'pointerdown',
    (e) => {
      if (!active || busy || onControl(e)) return;
      if (e.button !== 0 || spaceDown) return; // middle or right drag, and Space-drag, pan as always
      const p = ctx.toMap(e.clientX, e.clientY);
      if (!p) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      ctx.handled.add(e);
      const grab = box ? handleAt(box, p, 8 * ctx.squaresPerPx()) : null;
      drag = grab && box ? { kind: grab, from: p, orig: box } : { kind: 'new', start: p, x: e.clientX, y: e.clientY, moved: false };
      ctx.stage.setPointerCapture(e.pointerId);
    },
    { capture: true },
  );

  ctx.stage.addEventListener(
    'pointermove',
    (e) => {
      if (!active) return;
      const p = ctx.toMap(e.clientX, e.clientY);
      if (!p) return;
      if (!drag) {
        if (!spaceDown) cursor(cursorFor(box && !onControl(e) ? handleAt(box, p, 8 * ctx.squaresPerPx()) : null));
        return;
      }
      if (drag.kind === 'new') {
        if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
        drag.moved = true;
        box = boxFromDrag(drag.start, p);
      } else box = adjust(drag.orig, drag.kind, p[0] - drag.from[0], p[1] - drag.from[1]);
      update();
    },
    { capture: true },
  );

  const endDrag = () => {
    if (!active || !drag) return;
    drag = null; // a click without a drag keeps the box there is
    remember();
    update();
  };
  ctx.stage.addEventListener('pointerup', endDrag, { capture: true });
  ctx.stage.addEventListener('pointercancel', endDrag, { capture: true });

  ctx.onView(() => {
    if (!active) return;
    draw();
    placeBar();
  });
  ctx.onRender(() => update()); // the view switched (the bar's GM / Players, or Shift P)

  // ---------- keys (capturing, so the editor's tool letters don't fire while snipping) ----------

  window.addEventListener(
    'keydown',
    (e) => {
      const k = e.key;
      if (!active) {
        if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && k.toLowerCase() === 's' && !typing(e.target) && !document.querySelector('.dialog-backdrop:not([hidden])')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          start();
        }
        return;
      }
      if (k === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (drag) {
          drag = null;
          update();
        } else stop();
        return;
      }
      if (typing(e.target)) return; // the bar's select and checkboxes keep their keys
      if (k === 'Enter' && !(e.target instanceof HTMLElement && e.target.closest('button, a'))) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void save('png');
        return;
      }
      if (e.shiftKey && k.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        stop();
        return;
      }
      if (k === ' ') {
        e.preventDefault();
        e.stopImmediatePropagation();
        spaceDown = true;
        ctx.stage.classList.add('panning');
        ctx.stage.style.removeProperty('cursor');
        return;
      }
      const moved = box && !e.ctrlKey && !e.metaKey && !e.altKey ? keyAdjust(box, k, e.shiftKey) : null;
      if (moved) {
        e.preventDefault();
        e.stopImmediatePropagation();
        box = moved;
        remember();
        update();
        return;
      }
      if (passThrough(e)) return;
      e.stopImmediatePropagation(); // tool letters, Delete, Ctrl Z and the rest wait until the snip is done
    },
    { capture: true },
  );
  const spaceUp = () => {
    if (!spaceDown) return;
    spaceDown = false;
    ctx.stage.classList.remove('panning');
  };
  window.addEventListener('keyup', (e) => e.key === ' ' && spaceUp());
  window.addEventListener('blur', spaceUp);

  return { start, stop, toggle, active: () => active };
}
