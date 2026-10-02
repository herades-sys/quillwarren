// The handout page's Notes tool (/maps/:id/handout, for the GM with the editor
// login): handwritten notes on the parchment. Click the sheet to write one
// (Enter starts a new line, Ctrl+Enter or a click elsewhere saves, Esc
// cancels), drag a note to move it, double-click it to change the text, and
// Delete removes it; the panel sets size, tilt, ink and "also on the map".
// Every change is a map op (POST /api/v1/maps/:id/ops with the editor login,
// same origin), so the editor and viewers follow and undo works.
//
// While the tool is on, the preview is drawn without the notes
// (handout.png?inscriptions=0) and this script draws them on top with core's
// own renderer (inscriptions.ts), in the page's copy of the same italic font, so
// a note moves as it is dragged. The page's inline script (handout-page.ts) owns
// the preview: it says where the map sits on the sheet (the x-handout-frame
// header) with a "handout:drawn" event, and redraws on window.delveHandout.refresh().
import {
  applyOps,
  frameTransform,
  INSCRIPTION_INK,
  INSCRIPTION_INKS,
  INSCRIPTION_MAX,
  INSCRIPTION_SIZE,
  inscriptionNear,
  inscriptionSeed,
  inscriptionSvg,
  mapSeedOf,
  type DelveMap,
  type Inscription,
  type InscriptionInk,
  type Op,
} from '@delve/core';
import { btn, checkbox, h, range, seg } from './dom.ts';
import { cleanText, defaultPen, newNote, noteUpdate, parseFrame, pointsToSize, sheetToSquares, sizeInPoints, slightTilt, squaresToSheet, withUpdate, type Pen, type SheetFrame } from './handout-logic.ts';

interface Drawn {
  frame: SheetFrame | null;
  /** Whether the preview picture has the notes in it (false while the tool is on). */
  notes: boolean;
}
/** What the page's script hands over: the x-handout-frame header as it came. */
interface DrawnRaw {
  frame: string | null;
  notes: boolean;
}
const fromRaw = (r: DrawnRaw | null | undefined): Drawn | null => (r ? { frame: parseFrame(r.frame), notes: r.notes } : null);
interface HandoutPage {
  /** The preview's extra query (inscriptions=0 while the tool is on); draws it again. */
  preview(extra: Record<string, string>): void;
  /** Draw the preview again (the map changed). */
  refresh(): void;
  last: DrawnRaw | null;
}
declare global {
  interface Window {
    delveHandout?: HandoutPage;
  }
}

const SVG = 'http://www.w3.org/2000/svg';
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const init = JSON.parse(document.getElementById('delve-initial')!.textContent!) as { id: string };
const api = `/api/v1/maps/${encodeURIComponent(init.id)}`;

const sheet = document.getElementById('sheet') as HTMLImageElement;
const table = sheet.parentElement as HTMLElement;
const panel = document.getElementById('notes-panel')!;
const status = document.getElementById('status')!;
const page = (): HandoutPage | undefined => window.delveHandout;

// the layer over the preview: the notes, their pick boxes and the selection
const overlay = document.createElementNS(SVG, 'svg');
overlay.setAttribute('id', 'notes-layer');
overlay.setAttribute('preserveAspectRatio', 'none');
overlay.setAttribute('aria-hidden', 'true');
overlay.style.display = 'none';
const inkLayer = document.createElementNS(SVG, 'g');
inkLayer.setAttribute('opacity', '0.94'); // like the handout's own ink
const layer = document.createElementNS(SVG, 'g');
inkLayer.appendChild(layer);
overlay.appendChild(inkLayer);
table.appendChild(overlay);

let map: DelveMap | null = null;
let rev = 0;
let drawn: Drawn | null = fromRaw(page()?.last);
let on = false;
let selected: string | null = null;
let pen: Pen = defaultPen(drawn?.frame ?? null);
let penSized = Boolean(drawn?.frame);
/** Changes on their way to the server, shown at once: the note (null: deleted), kept until the map reaches rev `until`. */
const local = new Map<string, { note: Inscription | null; until: number | null }>();
/** A slider being dragged: the selected note as it would look, not saved yet. */
let preview: Inscription | null = null;
let editing: { id: string | null; at: [number, number]; box: HTMLTextAreaElement; done: boolean } | null = null;
let drag: { id: string; x: number; y: number; X: number; Y: number; moved: boolean } | null = null;
/** The last press on a note, to tell a double click (on touch screens too). */
let lastPress: { id: string; t: number } | null = null;

const frame = (): SheetFrame | null => drawn?.frame ?? null;

/** The notes as they are now: the map's, with the local changes on top. */
function notes(): Inscription[] {
  const out: Inscription[] = [];
  const seen = new Set<string>();
  const shown = (n: Inscription) => (preview?.id === n.id ? preview : n);
  for (const o of map?.objects ?? []) {
    if (o.type !== 'inscription') continue;
    seen.add(o.id);
    const l = local.get(o.id);
    const n = l ? l.note : o;
    if (n) out.push(shown(n));
  }
  for (const [id, l] of local) if (!seen.has(id) && l.note) out.push(shown(l.note));
  return out;
}
const noteById = (id: string | null | undefined): Inscription | undefined => (id ? notes().find((o) => o.id === id) : undefined);

// ---------- talking to the server ----------

const say = (text: string): void => {
  status.textContent = text;
};

/** Send ops; `shown` are the notes as they'll be, drawn at once and kept until the map catches up. */
async function send(ops: Op[], shown: [string, Inscription | null][]): Promise<void> {
  for (const [id, note] of shown) local.set(id, { note, until: null });
  draw();
  try {
    const res = await fetch(`${api}/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops, by: 'handout' }) });
    const body = (await res.json().catch(() => ({}))) as { rev?: number; error?: string };
    if (!res.ok || typeof body.rev !== 'number') throw new Error(body.error ?? `saving failed (${res.status})`);
    const done = body.rev;
    for (const [id] of shown) {
      const l = local.get(id);
      if (l && l.until === null) l.until = done;
    }
    settle();
    if (rev < done) setTimeout(() => rev < done && void reload(), 2000); // no broadcast? fetch the map
  } catch (e) {
    for (const [id] of shown) local.delete(id);
    say(`The note wasn’t saved: ${(e as Error).message}`);
  }
  draw();
  if (!interacting()) renderPanel();
}

/** Drop the local changes the map has caught up with. */
function settle(): void {
  for (const [id, l] of local) if (l.until !== null && rev >= l.until) local.delete(id);
}

async function history(action: 'undo' | 'redo'): Promise<void> {
  const res = await fetch(`${api}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: 'handout' }) });
  if (!res.ok) say(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${action} failed (${res.status})`);
}

/** The map without its notes: when that changes, the preview picture must be drawn again. */
const withoutNotes = (m: DelveMap | null): string => JSON.stringify(m ? { ...m, objects: m.objects.filter((o) => o.type !== 'inscription') } : null);

function changed(next: DelveMap, nextRev: number): void {
  const before = map;
  map = next;
  rev = nextRev;
  settle();
  if (selected && !noteById(selected)) selected = null;
  // the picture has the notes in it while the tool is off, and the rest of the map always
  if (before && (!on || withoutNotes(before) !== withoutNotes(next))) page()?.refresh();
  draw();
  if (!interacting()) renderPanel();
}

async function reload(): Promise<void> {
  const res = await fetch(api);
  if (!res.ok) return;
  const body = (await res.json()) as { rev: number; map: DelveMap };
  if (body.rev !== rev || !map) changed(body.map, body.rev);
}

let retry = 1000;
function connect(): void {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${api}/live`);
  socket.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { type: string; rev?: number; map?: DelveMap; ops?: Op[] };
    if (msg.type === 'hello' && msg.map && typeof msg.rev === 'number') {
      retry = 1000;
      if (msg.rev !== rev || !map) changed(msg.map, msg.rev);
    } else if (msg.type === 'ops' && typeof msg.rev === 'number' && msg.ops) {
      if (msg.rev <= rev) return;
      if (map && msg.rev === rev + 1) {
        try {
          return changed(applyOps(map, msg.ops).map, msg.rev);
        } catch {
          // fetch a fresh copy instead
        }
      }
      void reload();
    }
  };
  socket.onclose = () => {
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 15000);
  };
}

// ---------- the layer over the preview ----------

/** Lay the overlay exactly over the preview picture. */
/** Where the preview picture's top left corner is, in the table's own (scrolling) box. */
function origin(): { left: number; top: number } {
  const s = sheet.getBoundingClientRect();
  const t = table.getBoundingClientRect();
  return { left: s.left - t.left - table.clientLeft + table.scrollLeft, top: s.top - t.top - table.clientTop + table.scrollTop };
}

function place(): void {
  const s = sheet.getBoundingClientRect();
  const o = origin();
  overlay.style.left = `${o.left}px`;
  overlay.style.top = `${o.top}px`;
  overlay.style.width = `${s.width}px`;
  overlay.style.height = `${s.height}px`;
}

/** CSS pixels of the preview per point of the sheet. */
const pxPerPt = (f: SheetFrame): number => Math.max(1, sheet.getBoundingClientRect().width) / f.w;

function sheetPoint(e: { clientX: number; clientY: number }, f: SheetFrame): [number, number] {
  const r = sheet.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * f.w, ((e.clientY - r.top) / r.height) * f.h];
}

const wrapOf = (id: string): SVGGElement | null => layer.querySelector<SVGGElement>(`g.hn[data-id="${CSS.escape(id)}"]`);

function rect(b: DOMRect, pad: number, cls: string): SVGRectElement {
  const r = document.createElementNS(SVG, 'rect');
  for (const [k, v] of Object.entries({ x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad, class: cls })) r.setAttribute(k, String(v));
  return r;
}

/** The dashed outline around the selected note (in its own tilted frame). */
function decorate(): void {
  for (const old of layer.querySelectorAll('.hn-sel')) old.remove();
  const note = selected ? (wrapOf(selected)?.querySelector<SVGGraphicsElement>(':scope > g[data-inscription]') ?? null) : null;
  if (note) note.append(rect(note.getBBox(), (noteById(selected)?.size ?? INSCRIPTION_SIZE) * 0.18, 'hn-sel'));
}

function draw(): void {
  const f = frame();
  // shown while the tool is on, and (not clickable) while the picture under it still leaves the notes out
  const shown = Boolean(f) && (on || drawn?.notes === false);
  overlay.style.display = shown ? '' : 'none';
  overlay.classList.toggle('is-on', on);
  if (!shown || !f) return;
  place();
  overlay.setAttribute('viewBox', `0 0 ${f.w} ${f.h}`);
  layer.setAttribute('transform', frameTransform(f));
  // the notes are drawn here only while the picture under them leaves them out
  if (!map || drawn?.notes !== false) {
    layer.replaceChildren();
    return;
  }
  const seed = mapSeedOf(map);
  // a note that runs far off the sheet is left out of the picture (core handoutSvg): shown faint here, to drag back
  const sheetArea = { x0: f.x0 - f.x / f.k, y0: f.y0 - f.y / f.k, x1: f.x0 + (f.w - f.x) / f.k, y1: f.y0 + (f.h - f.y) / f.k };
  const slack = (0.25 * Math.min(f.w, f.h)) / f.k;
  layer.innerHTML = notes()
    .filter((o) => editing?.id !== o.id)
    .map((o) => {
      const off = !inscriptionNear(o, sheetArea, slack);
      return `<g class="hn${off ? ' hn-off' : ''}" data-id="${esc(o.id)}">${off ? '<title>Too far off the sheet: left out of the handout. Drag it back.</title>' : ''}${inscriptionSvg(o, inscriptionSeed(seed, o.id))}</g>`;
    })
    .join('');
  // a pick box in each note's own tilted frame
  for (const wrap of layer.querySelectorAll<SVGGElement>('g.hn')) {
    const note = wrap.querySelector<SVGGraphicsElement>(':scope > g[data-inscription]');
    if (note) note.prepend(rect(note.getBBox(), (noteById(wrap.dataset.id)?.size ?? INSCRIPTION_SIZE) * 0.18, 'hn-hit'));
  }
  decorate();
  if (drag?.moved) wrapOf(drag.id)?.setAttribute('transform', `translate(${(drag.X - drag.x) / f.k} ${(drag.Y - drag.y) / f.k})`);
}

// ---------- writing ----------

function openEditor(id: string | null, at: [number, number], text = ''): void {
  const f = frame();
  if (!f || !map) return;
  closeEditor(false);
  const o = noteById(id);
  const box = h('textarea', {
    class: 'hn-editor',
    rows: 1,
    wrap: 'off',
    maxlength: INSCRIPTION_MAX,
    spellcheck: 'false',
    'aria-label': 'The note: Enter starts a new line, Ctrl+Enter saves, Esc cancels',
  });
  box.value = text;
  const [X, Y] = squaresToSheet(f, at);
  const k = pxPerPt(f);
  const o0 = origin();
  box.style.left = `${o0.left + X * k}px`;
  box.style.top = `${o0.top + Y * k}px`;
  box.style.fontSize = `${Math.max(10, (o?.size ?? pen.size) * f.k * k)}px`;
  box.style.color = INSCRIPTION_INK[o?.ink ?? pen.ink].color;
  box.style.transform = `translate(-50%, -50%) rotate(${o?.rotation ?? 0}deg)`;
  const fit = () => {
    box.style.width = '0';
    box.style.height = '0';
    box.style.width = `${Math.max(box.scrollWidth + 8, 140)}px`;
    box.style.height = `${box.scrollHeight + 2}px`;
  };
  box.addEventListener('input', fit);
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      closeEditor(false);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      closeEditor(true);
    }
  });
  box.addEventListener('blur', () => closeEditor(true));
  editing = { id, at, box, done: false };
  table.appendChild(box);
  fit();
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
  draw();
  renderPanel();
}

/** Close the text box, saving what was typed (a note emptied out is deleted), or not. */
function closeEditor(save: boolean): void {
  const e = editing;
  if (!e || e.done) return;
  e.done = true;
  editing = null;
  const text = cleanText(e.box.value);
  e.box.remove();
  const o = noteById(e.id);
  if (save && map && !o && text) {
    const note = newNote(map, text, e.at, pen, slightTilt(Math.random()), [...local.keys()]);
    selected = note.id;
    void send([{ op: 'add', object: note }], [[note.id, note]]);
  } else if (save && o && !text) {
    selected = null;
    void send([{ op: 'delete', ids: [o.id] }], [[o.id, null]]);
  } else if (save && o && text !== o.text) {
    const op = noteUpdate(o, { text });
    if (op) void send([op], [[o.id, withUpdate(o, op)]]);
  }
  draw();
  renderPanel();
}

function remove(id: string): void {
  if (selected === id) selected = null;
  void send([{ op: 'delete', ids: [id] }], [[id, null]]);
}

/** Change the selected note (or, with none selected, the pen for new ones). */
function change(fields: Partial<Pick<Inscription, 'size' | 'rotation' | 'ink' | 'onMap'>>): void {
  const o = noteById(selected);
  // the next note is written in the same size and ink; "on the map" is set for new notes only when none is selected
  const { rotation: _tilt, onMap, ...forPen } = fields;
  pen = { ...pen, ...(forPen as Partial<Pen>), ...(onMap !== undefined && !o ? { onMap } : {}) };
  preview = null;
  const op = o ? noteUpdate(o, fields) : null;
  if (o && op) void send([op], [[o.id, withUpdate(o, op)]]);
  else {
    draw();
    renderPanel();
  }
}

function nudge(o: Inscription, dx: number, dy: number): void {
  const op = noteUpdate(o, { at: [Math.round((o.at[0] + dx) * 100) / 100, Math.round((o.at[1] + dy) * 100) / 100] });
  if (op) void send([op], [[o.id, withUpdate(o, op)]]);
}

// ---------- pointer and keys ----------

overlay.addEventListener('pointerdown', (e) => {
  const f = frame();
  if (!on || !f || !map || e.button !== 0) return;
  e.preventDefault();
  if (editing) return closeEditor(true); // a click away saves, and does no more
  const [X, Y] = sheetPoint(e, f);
  const id = (e.target as Element).closest<SVGGElement>('g.hn')?.dataset.id;
  const o = noteById(id);
  if (o) {
    const again = lastPress?.id === o.id && e.timeStamp - lastPress.t < 450;
    lastPress = { id: o.id, t: e.timeStamp };
    if (again) {
      lastPress = null;
      return openEditor(o.id, [o.at[0], o.at[1]], o.text);
    }
    const before = selected;
    selected = o.id;
    drag = { id: o.id, x: X, y: Y, X, Y, moved: false };
    overlay.setPointerCapture(e.pointerId);
    decorate();
    if (before !== o.id) renderPanel();
    return;
  }
  lastPress = null;
  if (selected) {
    // a click on bare parchment first lets go of the selected note
    selected = null;
    decorate();
    renderPanel();
    return;
  }
  openEditor(null, sheetToSquares(f, X, Y));
});

overlay.addEventListener('pointermove', (e) => {
  const f = frame();
  if (!drag || !f) return;
  [drag.X, drag.Y] = sheetPoint(e, f);
  if (!drag.moved && Math.hypot(drag.X - drag.x, drag.Y - drag.y) * pxPerPt(f) > 3) {
    drag.moved = true;
    lastPress = null;
  }
  if (drag.moved) wrapOf(drag.id)?.setAttribute('transform', `translate(${(drag.X - drag.x) / f.k} ${(drag.Y - drag.y) / f.k})`);
});

const endDrag = (e: PointerEvent) => {
  const f = frame();
  const d = drag;
  drag = null;
  if (!d || !f) return;
  if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
  const o = noteById(d.id);
  if (!d.moved || !o) return;
  if (e.type === 'pointercancel') return draw();
  nudge(o, (d.X - d.x) / f.k, (d.Y - d.y) / f.k);
};
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

window.addEventListener('keydown', (e) => {
  if (!on || editing) return;
  if ((e.target as HTMLElement).closest?.('input, select, textarea, [contenteditable]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && (key === 'z' || key === 'y')) {
    e.preventDefault();
    void history(key === 'y' || e.shiftKey ? 'redo' : 'undo');
    return;
  }
  const o = noteById(selected);
  if (!o || mod || e.altKey) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    remove(o.id);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openEditor(o.id, [o.at[0], o.at[1]], o.text);
  } else if (e.key === 'Escape') {
    selected = null;
    decorate();
    renderPanel();
  } else if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const s = e.shiftKey ? 0.5 : 0.1;
    const [dx, dy] = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key] ?? [0, 0];
    nudge(o, dx!, dy!);
  }
});

// ---------- the panel ----------

/** A slider is being dragged, or something in the panel has focus: don't rebuild it under the pointer. */
const interacting = (): boolean => Boolean(preview) || (panel.contains(document.activeElement) && document.activeElement?.id !== 'notes-toggle');

const inkChoices = (): [InscriptionInk, Node][] =>
  INSCRIPTION_INKS.map((k) => [k, h('span', { class: 'hn-ink', title: `${INSCRIPTION_INK[k].name} ink` }, h('span', { class: 'hn-ink-dot', style: `background:${INSCRIPTION_INK[k].color}` }), INSCRIPTION_INK[k].name)]);

function setOn(next: boolean): void {
  on = next;
  if (!on) {
    closeEditor(true);
    selected = null;
  }
  document.body.classList.toggle('writing-notes', on);
  page()?.preview(on ? { inscriptions: '0' } : {});
  draw();
  renderPanel();
}

function renderPanel(): void {
  const f = frame();
  const o = noteById(selected);
  const kids: Node[] = [
    btn(on ? 'Done writing' : 'Write notes on the sheet', {
      kind: 'secondary',
      icon: 'label',
      onclick: () => setOn(!on),
      attrs: { 'aria-pressed': String(on), id: 'notes-toggle' },
    }),
  ];
  if (!on) {
    const count = notes().length;
    kids.push(h('p', { class: 'note' }, count ? `${count} note${count === 1 ? '' : 's'} on this handout. Turn writing on to add, move or change them.` : 'Write on the parchment by hand: “Here be dragons”, a warning over a door, a rhyme in the margin.'));
    panel.replaceChildren(...kids);
    return;
  }
  kids.push(
    h(
      'p',
      { class: 'note' },
      editing
        ? 'Enter starts a new line. Ctrl+Enter or a click elsewhere saves; Esc cancels.'
        : o
          ? 'Drag the note to move it (arrow keys nudge it), double-click it or press Enter to change the text, Delete removes it.'
          : 'Click the parchment to write a note there.',
    ),
  );
  const live = (fields: Partial<Inscription>) => {
    if (!o) return;
    preview = { ...o, ...fields };
    draw();
  };
  kids.push(h('div', { class: 'kicker', style: 'margin-top:4px' }, o ? 'This note' : 'New notes'));
  if (f) {
    kids.push(
      range('Size', {
        value: sizeInPoints(f, o ? o.size : pen.size),
        min: 6,
        max: 72,
        step: 1,
        show: (v) => `${v} pt`,
        onInput: (v) => live({ size: pointsToSize(f, v) }),
        onChange: (v) => change({ size: pointsToSize(f, v) }),
      }),
    );
  }
  if (o) {
    kids.push(
      range('Tilt', {
        value: Math.round(o.rotation ?? 0),
        min: -45,
        max: 45,
        step: 1,
        show: (v) => `${v < 0 ? '−' : ''}${Math.abs(v)}°`,
        onInput: (v) => live({ rotation: v }),
        onChange: (v) => change({ rotation: v }),
      }),
    );
  }
  kids.push(
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Ink'), seg('hn-ink', inkChoices(), o?.ink ?? (o ? 'brown' : pen.ink), (v) => change({ ink: v }), 'hn-inks')),
    checkbox('Also on the normal map', o ? Boolean(o.onMap) : pen.onMap, (v) => change({ onMap: v })),
  );
  if (o) {
    kids.push(
      h(
        'div',
        { class: 'hn-acts' },
        btn('Change the text', { icon: 'label', keyHint: 'Enter', onclick: () => openEditor(o.id, [o.at[0], o.at[1]], o.text) }),
        btn('Delete', { kind: 'danger', icon: 'trash', keyHint: 'Del', onclick: () => remove(o.id) }),
      ),
    );
  }
  panel.replaceChildren(...kids);
}

// ---------- start ----------

document.addEventListener('handout:drawn', (e) => {
  const before = JSON.stringify(drawn?.frame ?? null);
  drawn = fromRaw((e as CustomEvent<DrawnRaw>).detail);
  const f = frame();
  if (f && !penSized) {
    pen = { ...pen, size: defaultPen(f).size };
    penSized = true;
  }
  // another paper or orientation moves the map on the sheet: an open text box is saved first
  if (editing && JSON.stringify(f) !== before) closeEditor(true);
  draw();
  if (!interacting()) renderPanel();
});
new ResizeObserver(() => draw()).observe(sheet);
// the overlay measures the letters, so it draws again once the italic is in
void document.fonts?.load('italic 20px "IM Fell English"').then(() => draw());
renderPanel();
connect();
