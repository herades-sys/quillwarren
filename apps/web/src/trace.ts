// The picture tracer page (/import/image): load a map picture, give each main
// colour a role, set the scale, check the outlines over the picture (or the
// finished map) and create it. The heavy work runs in trace-worker.js.
import { guessRoles, tracedMap, TRACE_MIN_WIDTH, TRACE_ROLES, type MapObject, type Point, type RGB, type TraceResult, type TraceRole } from '@delve/core';
import type { Crop, FromWorker, ToWorker, TraceSettings } from './trace-protocol.ts';

interface Initial {
  version: string;
  loggedIn: boolean;
  presets: { id: string; name: string }[];
}

type P = [number, number];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const initial = JSON.parse($('delve-initial').textContent ?? '{}') as Initial;

/** Pictures are traced at most this many pixels on their longer side (bigger ones are shrunk first). */
const MAX_SIDE = 2000;
const ROLE_NAMES: Record<TraceRole, string> = {
  ignore: 'Ignore (ground, text)',
  building: 'Building / room',
  wall: 'Wall',
  water: 'Water',
  road: 'Road / paving',
  grass: 'Grass',
  field: 'Field / dirt',
  sand: 'Sand',
};
const PLURAL: Record<TraceRole, [string, string]> = {
  ignore: ['', ''],
  building: ['building', 'buildings'],
  wall: ['wall piece', 'wall pieces'],
  water: ['water area', 'water areas'],
  road: ['road area', 'road areas'],
  grass: ['grass area', 'grass areas'],
  field: ['field', 'fields'],
  sand: ['sand area', 'sand areas'],
};
const FT_PER_M = 3.28084;

const worker = new Worker(`/assets/trace-worker.js?v=${encodeURIComponent(initial.version)}`, { type: 'module' });
const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);

const els = {
  drop: $('drop'),
  file: $<HTMLInputElement>('file'),
  work: $('work'),
  viewport: $('viewport'),
  content: $('content'),
  canvas: $<HTMLCanvasElement>('pic'),
  overlay: $('overlay') as unknown as SVGSVGElement,
  result: $('result'),
  colours: $('colours'),
  k: $<HTMLSelectElement>('k'),
  feet: $<HTMLSelectElement>('feet'),
  widthFt: $<HTMLInputElement>('width-ft'),
  measureLen: $<HTMLInputElement>('measure-len'),
  measureUnit: $<HTMLSelectElement>('measure-unit'),
  scale: $('scale-readout'),
  grid: $<HTMLInputElement>('grid'),
  join: $<HTMLInputElement>('join'),
  fill: $<HTMLInputElement>('fill'),
  minArea: $<HTMLInputElement>('min-area'),
  minWidths: $('min-widths'),
  name: $<HTMLInputElement>('name'),
  style: $<HTMLSelectElement>('style'),
  create: $<HTMLButtonElement>('create'),
  status: $('status'),
  counts: $('counts'),
  cropClear: $<HTMLButtonElement>('crop-clear'),
};

let pic: { width: number; height: number; data: ImageData } | null = null;
let colours: { colour: RGB; share: number }[] = [];
let roles: TraceRole[] = [];
const minWidth: Partial<Record<TraceRole, number>> = { ...TRACE_MIN_WIDTH };
let crop: Crop | null = null;
let measure: { a: P; b: P | null } | null = null;
let result: TraceResult | null = null;
let resultCrop: Crop | null = null;
let resultPx = 0;
let mode: 'picture' | 'result' = 'picture';
let tool: 'pan' | 'measure' | 'crop' = 'pan';
let view = { x: 0, y: 0, k: 1 };
let traceId = 0;
let renderId = 0;
let busy = false;
let pending = false;
let timer = 0;

const status = (text: string, bad = false) => {
  els.status.textContent = text;
  els.status.classList.toggle('bad', bad);
};

// ---------- loading ----------

async function load(file: File): Promise<void> {
  status(`Reading ${file.name}…`);
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    status(`${file.name} is not a picture this browser can read (use PNG, JPG or WebP).`, true);
    return;
  }
  const f = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const width = Math.max(1, Math.round(bmp.width * f));
  const height = Math.max(1, Math.round(bmp.height * f));
  els.canvas.width = width;
  els.canvas.height = height;
  const ctx = els.canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const data = ctx.getImageData(0, 0, width, height);
  pic = { width, height, data };
  const copy = data.data.slice();
  send({ type: 'load', width, height, rgba: copy, k: Number(els.k.value) }, [copy.buffer]);
  crop = null;
  measure = null;
  result = null;
  els.result.replaceChildren();
  els.name.value = file.name.replace(/\.\w+$/, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  // start at 12 pixels per square; the scale bar or a known width sets it properly
  els.widthFt.value = String(Math.round((width / 12) * Number(els.feet.value)));
  els.overlay.setAttribute('width', String(width));
  els.overlay.setAttribute('height', String(height));
  els.overlay.setAttribute('viewBox', `0 0 ${width} ${height}`);
  els.drop.hidden = true;
  els.work.hidden = false;
  setMode('picture');
  fit();
  status(f < 1 ? `Shrunk to ${width} × ${height} px for tracing. Finding the main colours…` : 'Finding the main colours…');
}

for (const input of [els.file, $<HTMLInputElement>('file2')]) {
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) void load(f);
    input.value = '';
  });
}
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f) void load(f);
});
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  const f = item?.getAsFile();
  if (f) void load(f);
});

// ---------- colours and roles ----------

const hex = ({ r, g, b }: RGB) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function showColours(): void {
  els.colours.replaceChildren(
    ...colours.map(({ colour, share }, i) => {
      const row = document.createElement('label');
      row.className = 'colour';
      row.dataset.i = String(i);
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = hex(colour);
      const pct = document.createElement('span');
      pct.className = 'share';
      pct.textContent = `${(share * 100).toFixed(share < 0.01 ? 1 : 0)}%`;
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', `Role of colour ${hex(colour)}`);
      for (const r of TRACE_ROLES) sel.add(new Option(ROLE_NAMES[r], r, false, roles[i] === r));
      sel.addEventListener('change', () => {
        roles[i] = sel.value as TraceRole;
        showMinWidths();
        schedule();
      });
      row.append(sw, pct, sel);
      return row;
    }),
  );
  showMinWidths();
}

function showMinWidths(): void {
  const used = TRACE_ROLES.filter((r) => r !== 'ignore' && roles.includes(r));
  els.minWidths.replaceChildren(
    ...used.map((r) => {
      const row = document.createElement('label');
      row.className = 'inline';
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '10';
      input.step = '0.1';
      input.value = String(minWidth[r] ?? 0);
      input.addEventListener('input', () => {
        minWidth[r] = Math.max(0, Number(input.value) || 0);
        schedule();
      });
      row.title = 'Thinner parts of this colour (text, outlines, shadows) are left out';
      row.append(`${ROLE_NAMES[r].replace(/ \(.*\)$/, '')}: skip parts thinner than`, input, 'sq');
      return row;
    }),
  );
}

$('recolour').addEventListener('click', () => {
  if (!pic) return;
  status('Finding the main colours…');
  send({ type: 'colours', k: Number(els.k.value) });
});

/** Which colour a picture pixel is closest to. */
function colourAt([x, y]: P): number {
  if (!pic || x < 0 || y < 0 || x >= pic.width || y >= pic.height) return -1;
  const i = (Math.floor(y) * pic.width + Math.floor(x)) * 4;
  const d = pic.data.data;
  let best = -1;
  let bd = Infinity;
  colours.forEach(({ colour: c }, k) => {
    const dist = (d[i]! - c.r) ** 2 + (d[i + 1]! - c.g) ** 2 + (d[i + 2]! - c.b) ** 2;
    if (dist < bd) {
      bd = dist;
      best = k;
    }
  });
  return best;
}

function flashColour(i: number): void {
  const row = els.colours.querySelector<HTMLElement>(`[data-i="${i}"]`);
  if (!row) return;
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
  row.querySelector('select')?.focus();
}

// ---------- scale ----------

const feet = () => Number(els.feet.value);
function pxPerSquare(): number {
  const w = Number(els.widthFt.value);
  return pic && w > 0 ? (pic.width * feet()) / w : 0;
}
const area = (): Crop => crop ?? { x0: 0, y0: 0, x1: pic?.width ?? 0, y1: pic?.height ?? 0 };

function showScale(): void {
  const s = pxPerSquare();
  if (!pic || !s) {
    els.scale.textContent = 'Enter the picture width.';
    return;
  }
  const a = area();
  const w = Math.ceil((a.x1 - a.x0) / s);
  const h = Math.ceil((a.y1 - a.y0) / s);
  els.scale.textContent = `${s.toFixed(1)} px per square · the map will be ${w} × ${h} squares (${Math.round(w * feet())} × ${Math.round(h * feet())} ft)`;
  els.scale.classList.toggle('bad', s < 3 || w * h > 250_000);
}

function applyMeasure(): void {
  if (!pic || !measure?.b) return;
  const len = Number(els.measureLen.value);
  const px = Math.hypot(measure.b[0] - measure.a[0], measure.b[1] - measure.a[1]);
  if (!(len > 0) || px < 2) return;
  const lenFt = els.measureUnit.value === 'm' ? len * FT_PER_M : len;
  els.widthFt.value = String(Math.round(((pic.width * lenFt) / px) * 10) / 10);
  schedule();
}

els.feet.addEventListener('change', schedule);
els.widthFt.addEventListener('input', schedule);
els.measureLen.addEventListener('input', applyMeasure);
els.measureUnit.addEventListener('change', applyMeasure);
for (const el of [els.grid, els.join, els.fill, els.minArea]) el.addEventListener('input', schedule);

// ---------- tracing ----------

function settings(): TraceSettings | null {
  const s = pxPerSquare();
  if (!pic || !colours.length || s < 1.5) return null;
  return {
    colours: colours.map((c) => c.colour),
    roles: [...roles],
    pxPerSquare: s,
    crop,
    minArea: Math.max(0, Number(els.minArea.value) || 0),
    minWidth: { ...minWidth },
    fillHoles: els.fill.checked ? 3 : 0,
    join: els.join.checked,
    grid: els.grid.checked,
  };
}

function schedule(): void {
  showScale();
  draw();
  clearTimeout(timer);
  timer = window.setTimeout(run, 250);
}

function run(): void {
  const s = settings();
  if (!s) {
    if (pic && colours.length) status('Squares would be smaller than 1.5 pixels: make the picture width smaller.', true);
    return;
  }
  if (busy) {
    pending = true;
    return;
  }
  busy = true;
  status('Tracing…');
  resultCrop = s.crop;
  resultPx = s.pxPerSquare;
  send({ type: 'trace', id: ++traceId, settings: s });
}

const newMapId = () => `map_${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

function buildMap() {
  if (!result) throw new Error('nothing traced yet');
  return tracedMap(result, {
    id: newMapId(),
    name: els.name.value,
    feetPerSquare: feet(),
    style: els.style.value,
    seed: crypto.getRandomValues(new Uint32Array(1))[0]! % 2 ** 31 || 1,
  });
}

function showCounts(ms: number): void {
  if (!result) return;
  const parts = TRACE_ROLES.filter((r) => r !== 'ignore' && result!.counts[r] !== undefined).map((r) => {
    const n = result!.counts[r]!;
    return `${n} ${PLURAL[r][n === 1 ? 0 : 1]}`;
  });
  els.counts.textContent = `${parts.join(' · ') || 'Nothing traced: give a colour a role.'} — ${result.size[0]} × ${result.size[1]} squares, ${(ms / 1000).toFixed(1)} s`;
  els.create.disabled = !initial.loggedIn || !result.objects.length;
}

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const msg = e.data;
  if (msg.type === 'colours') {
    colours = msg.colours;
    roles = guessRoles(colours);
    showColours();
    status('Check the colour roles and the scale, then create the map.');
    schedule();
  } else if (msg.type === 'traced') {
    busy = false;
    if (pending) {
      pending = false;
      run();
    }
    if (msg.id !== traceId) return;
    result = msg.result;
    showCounts(msg.ms);
    draw();
    if (!pending) status('Traced. Check the outlines, then create the map.');
    if (mode === 'result') renderResult();
  } else if (msg.type === 'rendered') {
    if (msg.id !== renderId) return;
    els.result.innerHTML = msg.svg;
    status('This is how the map will look.');
    fit();
  } else if (msg.type === 'error') {
    busy = false;
    status(`Tracing failed: ${msg.error}`, true);
  }
};
worker.onerror = (e) => status(`The tracer stopped: ${e.message}`, true);

// ---------- drawing ----------

const SVG = 'http://www.w3.org/2000/svg';
const f1 = (v: number) => Math.round(v * 10) / 10;

function pathOf(objects: MapObject[], s: number, ox: number, oy: number): string {
  let d = '';
  for (const o of objects) {
    if (!('shape' in o) || !('poly' in o.shape)) continue;
    d += `M${o.shape.poly.map(([x, y]: Point) => `${f1(x * s + ox)} ${f1(y * s + oy)}`).join('L')}Z`;
  }
  return d;
}

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

function draw(): void {
  if (!pic) return;
  const parts: SVGElement[] = [];
  const a = area();
  const s = pxPerSquare();
  if (result) {
    const ox = resultCrop?.x0 ?? 0;
    const oy = resultCrop?.y0 ?? 0;
    const groups: [string, MapObject[]][] = [];
    const by = (cls: string, o: MapObject) => {
      const g = groups.find(([c]) => c === cls);
      if (g) g[1].push(o);
      else groups.push([cls, [o]]);
    };
    for (const o of result.objects) {
      if (o.type === 'terrain') by(`o-terrain o-${o.asset}`, o);
      else if (o.type === 'cutout') by('o-cutout', o);
      else if (o.type === 'room') by(o.name === 'Wall' ? 'o-wall' : 'o-building', o);
    }
    for (const [cls, list] of groups) parts.push(el('path', { d: pathOf(list, resultPx, ox, oy), class: cls }));
  }
  if (s >= 4) {
    // the squares, so the scale can be checked against the picture
    const pat = el('pattern', { id: 'sq', width: f1(s), height: f1(s), patternUnits: 'userSpaceOnUse', x: a.x0, y: a.y0 });
    pat.append(el('path', { d: `M${f1(s)} 0H0V${f1(s)}`, class: 'o-grid' }));
    const defs = el('defs', {});
    defs.append(pat);
    parts.unshift(defs, el('rect', { x: a.x0, y: a.y0, width: a.x1 - a.x0, height: a.y1 - a.y0, fill: 'url(#sq)' }));
  }
  if (crop) {
    parts.push(el('path', { d: `M0 0H${pic.width}V${pic.height}H0Z M${crop.x0} ${crop.y0}V${crop.y1}H${crop.x1}V${crop.y0}Z`, class: 'o-outside' }));
    parts.push(el('rect', { x: crop.x0, y: crop.y0, width: crop.x1 - crop.x0, height: crop.y1 - crop.y0, class: 'o-crop' }));
  }
  if (measure) {
    const b = measure.b ?? measure.a;
    parts.push(el('line', { x1: measure.a[0], y1: measure.a[1], x2: b[0], y2: b[1], class: 'o-measure' }));
    for (const p of [measure.a, b]) parts.push(el('circle', { cx: p[0], cy: p[1], r: 4 / view.k, class: 'o-measure-end' }));
  }
  els.overlay.replaceChildren(...parts);
  els.cropClear.disabled = !crop;
}

function renderResult(): void {
  if (!result) return;
  status('Drawing the map…');
  send({ type: 'render', id: ++renderId, map: buildMap() });
}

// ---------- view: modes, tools, pan and zoom ----------

function setMode(m: 'picture' | 'result'): void {
  mode = m;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
  els.canvas.hidden = m !== 'picture';
  els.overlay.style.display = m === 'picture' ? '' : 'none';
  els.result.hidden = m !== 'result';
  if (m === 'result') {
    els.result.replaceChildren();
    renderResult();
  } else fit();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode as 'picture' | 'result'));

function setTool(t: typeof tool): void {
  tool = t;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  els.viewport.dataset.tool = t;
  if (t === 'measure') status('Click (or drag) from one end of the scale bar to the other, then enter its length.');
  if (t === 'crop') status('Drag a box around the part of the picture to trace.');
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool as typeof tool));
els.cropClear.addEventListener('click', () => {
  crop = null;
  schedule();
});
$('fit').addEventListener('click', fit);

function contentSize(): [number, number] {
  if (mode === 'result') {
    const svg = els.result.querySelector('svg');
    return [Number(svg?.getAttribute('width')) || 1, Number(svg?.getAttribute('height')) || 1];
  }
  return [pic?.width ?? 1, pic?.height ?? 1];
}

function applyView(): void {
  els.content.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  els.overlay.style.setProperty('--px', String(1 / view.k));
}

function fit(): void {
  const [cw, ch] = contentSize();
  const r = els.viewport.getBoundingClientRect();
  const k = Math.min(r.width / cw, r.height / ch) * 0.98;
  view = { k, x: (r.width - cw * k) / 2, y: (r.height - ch * k) / 2 };
  applyView();
  draw();
}

const toPic = (e: { clientX: number; clientY: number }): P => {
  const r = els.viewport.getBoundingClientRect();
  return [(e.clientX - r.left - view.x) / view.k, (e.clientY - r.top - view.y) / view.k];
};
const clampP = ([x, y]: P): P => [Math.max(0, Math.min(pic?.width ?? 0, x)), Math.max(0, Math.min(pic?.height ?? 0, y))];

let drag: { kind: 'pan' | 'measure' | 'crop'; sx: number; sy: number; vx: number; vy: number; start: P; moved: boolean } | null = null;

els.viewport.addEventListener('pointerdown', (e) => {
  if (!pic || (e.button !== 0 && e.button !== 1)) return;
  const p = clampP(toPic(e));
  const kind = e.button === 1 || mode === 'result' ? 'pan' : tool;
  drag = { kind, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, start: p, moved: false };
  els.viewport.setPointerCapture(e.pointerId);
  if (kind === 'measure') {
    if (measure && !measure.b) measure.b = p; // second click
    else measure = { a: p, b: null };
    draw();
  }
  e.preventDefault();
});
els.viewport.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
  const p = clampP(toPic(e));
  if (drag.kind === 'pan') {
    view.x = drag.vx + e.clientX - drag.sx;
    view.y = drag.vy + e.clientY - drag.sy;
    applyView();
  } else if (drag.kind === 'measure' && drag.moved && measure) {
    measure.b = p;
    draw();
  } else if (drag.kind === 'crop' && drag.moved) {
    const [ax, ay] = drag.start;
    crop = { x0: Math.min(ax, p[0]), y0: Math.min(ay, p[1]), x1: Math.max(ax, p[0]), y1: Math.max(ay, p[1]) };
    draw();
    showScale();
  }
});
els.viewport.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  const p = clampP(toPic(e));
  if (d.kind === 'pan' && !d.moved && mode === 'picture') {
    const i = colourAt(p);
    if (i >= 0) flashColour(i);
  } else if (d.kind === 'measure' && measure) {
    if (d.moved) measure.b = p;
    if (measure.b && Math.hypot(measure.b[0] - measure.a[0], measure.b[1] - measure.a[1]) < 2) measure.b = null;
    draw();
    if (measure.b) {
      els.measureLen.focus();
      status(`Measured ${Math.round(Math.hypot(measure.b[0] - measure.a[0], measure.b[1] - measure.a[1]))} px. Enter what that length is on the map.`);
      applyMeasure();
    }
  } else if (d.kind === 'crop') {
    if (crop && (crop.x1 - crop.x0 < 8 || crop.y1 - crop.y0 < 8)) crop = null;
    schedule();
  }
});
els.viewport.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const r = els.viewport.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const k = Math.max(0.05, Math.min(40, view.k * Math.exp(-e.deltaY * 0.0015)));
    view = { k, x: mx - ((mx - view.x) * k) / view.k, y: my - ((my - view.y) * k) / view.k };
    applyView();
    if (measure) draw();
  },
  { passive: false },
);
window.addEventListener('resize', () => pic && fit());

// ---------- creating the map ----------

for (const p of initial.presets) els.style.add(new Option(p.name, p.id, false, p.id === 'clean'));
els.style.addEventListener('change', () => mode === 'result' && renderResult());

els.create.addEventListener('click', async () => {
  if (!result) return;
  els.create.disabled = true;
  status('Creating the map…');
  try {
    const res = await fetch('/api/v1/maps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ map: buildMap(), by: 'trace' }) });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok || !body.id) {
      status(res.status === 401 || res.status === 403 ? 'Log in first (in another tab), then press Create again.' : `Creating failed: ${body.error ?? res.status}`, true);
      els.create.disabled = false;
      return;
    }
    location.href = `/maps/${encodeURIComponent(body.id)}?edit=1`;
  } catch (e) {
    status(`Creating failed: ${(e as Error).message}`, true);
    els.create.disabled = false;
  }
});

setTool('pan');
