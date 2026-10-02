// The picture tracer page (/import/image): load a map picture, check what kind
// of map it is (dungeon or city, painted or flat) and its scale (the printed
// grid it found, a scale bar, two grid lines or the picture's width), give each
// main colour a role, check the outlines over the picture (or the finished map)
// and create it. The heavy work runs in trace-worker.js.
import { metresPerSquare, parseSquareUnit, squareUnit, tracedMap, TRACE_MIN_WIDTH, TRACE_ROLES, type ColourSpace, type MapObject, type Point, type RGB, type TraceMode, type TraceResult, type TraceRole } from '@delve/core';
import type { Analysis, Crop, FromWorker, ToWorker, TraceSettings } from './trace-protocol.ts';

interface Initial {
  version: string;
  loggedIn: boolean;
  presets: { id: string; name: string }[];
}

type P = [number, number];
type ScaleFrom = 'grid' | 'bar' | 'width';
type Tool = 'pan' | 'measure' | 'lines' | 'crop';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const initial = JSON.parse($('delve-initial').textContent ?? '{}') as Initial;

/** Pictures are traced at most this many pixels on their longer side (bigger ones are shrunk first). */
const MAX_SIDE = 2000;
const M_PER_FT = 0.3048;

/** What each role means, in either kind of map. */
const ROLE_NAMES: Record<TraceMode, Record<TraceRole, string>> = {
  dungeon: {
    ignore: 'Leave out (ground, hatching)',
    building: 'Floor (rooms)',
    wall: 'Wall lines, text',
    water: 'Water',
    road: 'Paving',
    grass: 'Grass',
    field: 'Dirt',
    sand: 'Sand',
  },
  city: {
    ignore: 'Leave out (ground, text)',
    building: 'Building / roof',
    wall: 'City wall',
    water: 'Water',
    road: 'Street / plaza',
    grass: 'Grass, gardens, trees',
    field: 'Field',
    sand: 'Sand',
  },
};
/** Singular and plural for the counts. */
const NOUNS: Record<string, [string, string]> = {
  room: ['room', 'rooms'],
  corridor: ['corridor', 'corridors'],
  door: ['door', 'doors'],
  pillar: ['pillar or pit', 'pillars and pits'],
  wall: ['wall piece', 'wall pieces'],
  tower: ['tower', 'towers'],
  terrain: ['terrain area', 'terrain areas'],
  building: ['building', 'buildings'],
  water: ['water area', 'water areas'],
  road: ['street area', 'street areas'],
  grass: ['grass area', 'grass areas'],
  field: ['field', 'fields'],
  sand: ['sand area', 'sand areas'],
};
const LEGEND: Record<TraceMode, [string, string][]> = {
  dungeon: [
    ['rgba(214,120,42,.55)', 'room'],
    ['rgba(200,160,40,.55)', 'corridor'],
    ['#E0409A', 'door'],
    ['rgba(255,255,255,.8)', 'pillar'],
    ['rgba(176,58,46,.7)', 'wall'],
    ['rgba(40,110,200,.5)', 'water'],
  ],
  city: [
    ['rgba(214,120,42,.55)', 'building'],
    ['rgba(176,58,46,.7)', 'wall'],
    ['rgba(220,40,40,.7)', 'tower'],
    ['rgba(40,110,200,.5)', 'water'],
    ['rgba(60,150,60,.5)', 'grass'],
    ['rgba(120,110,150,.5)', 'street'],
    ['rgba(140,100,50,.5)', 'field'],
  ],
};

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
  painted: $<HTMLInputElement>('painted'),
  kindNote: $('kind-note'),
  unit: $<HTMLSelectElement>('unit'),
  cell: $<HTMLInputElement>('cell'),
  cellSquares: $<HTMLInputElement>('cell-squares'),
  linesCount: $<HTMLInputElement>('lines-count'),
  gridNote: $('grid-note'),
  measureLen: $<HTMLInputElement>('measure-len'),
  measureUnit: $<HTMLSelectElement>('measure-unit'),
  widthLen: $<HTMLInputElement>('width-len'),
  widthUnit: $<HTMLSelectElement>('width-unit'),
  scale: $('scale-readout'),
  showGrid: $<HTMLInputElement>('show-grid'),
  grid: $<HTMLInputElement>('grid'),
  join: $<HTMLInputElement>('join'),
  fill: $<HTMLInputElement>('fill'),
  split: $<HTMLInputElement>('split'),
  snap: $<HTMLInputElement>('snap'),
  regular: $<HTMLInputElement>('regular'),
  minArea: $<HTMLInputElement>('min-area'),
  minWidths: $('min-widths'),
  legend: $('legend'),
  name: $<HTMLInputElement>('name'),
  style: $<HTMLSelectElement>('style'),
  create: $<HTMLButtonElement>('create'),
  status: $('status'),
  counts: $('counts'),
  cropClear: $<HTMLButtonElement>('crop-clear'),
};

let pic: { width: number; height: number; data: ImageData } | null = null;
let analysis: Analysis | null = null;
let colours: { colour: RGB; share: number }[] = [];
let roles: TraceRole[] = [];
let space: ColourSpace = 'lab';
let mode: TraceMode = 'dungeon';
const minWidth: Partial<Record<TraceRole, number>> = { ...TRACE_MIN_WIDTH };
let crop: Crop | null = null;
/** The grid in picture pixels: found in the picture, or set by hand. */
let grid: { cell: number; offset: P } | null = null;
let scaleFrom: ScaleFrom = 'grid';
let measure: { a: P; b: P | null } | null = null;
let lines: { a: P; b: P | null } | null = null;
let result: TraceResult | null = null;
let resultCrop: Crop | null = null;
let resultPx = 0;
let resultOrigin: P = [0, 0];
let view: 'picture' | 'result' = 'picture';
let tool: Tool = 'pan';
let pan = { x: 0, y: 0, k: 1 };
let traceId = 0;
let renderId = 0;
let busy = false;
let pending = false;
let timer = 0;

const status = (text: string, bad = false) => {
  els.status.textContent = text;
  els.status.classList.toggle('bad', bad);
};
const radios = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)];
const setRadio = (name: string, value: string) => radios(name).forEach((r) => (r.checked = r.value === value));

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
  send({ type: 'load', width, height, rgba: copy }, [copy.buffer]);
  analysis = null;
  colours = [];
  crop = null;
  measure = null;
  lines = null;
  result = null;
  grid = null;
  els.colours.replaceChildren();
  els.result.replaceChildren();
  els.counts.textContent = '';
  els.create.disabled = true;
  els.name.value = file.name.replace(/\.\w+$/, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  els.overlay.setAttribute('width', String(width));
  els.overlay.setAttribute('height', String(height));
  els.overlay.setAttribute('viewBox', `0 0 ${width} ${height}`);
  els.drop.hidden = true;
  els.work.hidden = false;
  setView('picture');
  fit();
  status(f < 1 ? `Shrunk to ${width} × ${height} px for tracing. Looking at the picture…` : 'Looking at the picture: colours, grid, kind of map…');
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

// ---------- kind of map ----------

/** Shows the options that belong to the kind of map. */
function showKind(): void {
  setRadio('kind', mode);
  for (const el of document.querySelectorAll<HTMLElement>('[data-for]')) {
    const f = el.dataset.for!;
    el.hidden = f === 'dungeon' ? mode !== 'dungeon' : f === 'city' ? mode !== 'city' : f === 'painted' ? !els.painted.checked : f === 'flat' ? els.painted.checked : false;
  }
  els.legend.replaceChildren(
    ...LEGEND[mode].map(([c, label]) => {
      const s = document.createElement('span');
      const i = document.createElement('i');
      i.style.background = c;
      s.append(i, label);
      return s;
    }),
  );
  const a = analysis;
  els.kindNote.textContent = a
    ? `${a.mode === 'dungeon' ? 'Looks like a dungeon or battle map' : 'Looks like a city plan'} (${a.why})${a.painted ? '; painted or textured, so it is smoothed first' : ''}.`
    : '';
}

function recolour(): void {
  if (!pic) return;
  status('Finding the main colours…');
  send({ type: 'colours', k: Number(els.k.value), mode, painted: els.painted.checked, ...(grid ? { cell: grid.cell } : {}) });
}

for (const r of radios('kind')) {
  r.addEventListener('change', () => {
    if (!r.checked) return;
    mode = r.value as TraceMode;
    els.minArea.value = mode === 'dungeon' ? '0.5' : '0.3';
    els.k.value = els.painted.checked ? '12' : mode === 'city' ? '7' : '8';
    showKind();
    recolour();
  });
}
els.painted.addEventListener('change', () => {
  els.k.value = els.painted.checked ? '12' : mode === 'city' ? '7' : '8';
  showKind();
  recolour();
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
      for (const r of TRACE_ROLES) sel.add(new Option(ROLE_NAMES[mode][r], r, false, roles[i] === r));
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
      row.append(`${ROLE_NAMES.city[r].replace(/ \(.*\)$/, '')}: skip parts thinner than`, input, 'sq');
      return row;
    }),
  );
}

$('recolour').addEventListener('click', recolour);

/** Which colour a picture pixel is closest to (as the page sees it; good enough to find a colour's row). */
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

/** Metres one square stands for. */
const squareMetres = () => metresPerSquare(parseSquareUnit(els.unit.value));
const toMetres = (len: number, u: string) => (u === 'm' ? len : len * M_PER_FT);
const area = (): Crop => crop ?? { x0: 0, y0: 0, x1: pic?.width ?? 0, y1: pic?.height ?? 0 };

function pxPerSquare(): number {
  if (!pic) return 0;
  if (scaleFrom === 'grid') {
    const cell = Number(els.cell.value);
    const n = Number(els.cellSquares.value) || 1;
    return cell > 0 ? cell / n : 0;
  }
  if (scaleFrom === 'bar') {
    const len = toMetres(Number(els.measureLen.value), els.measureUnit.value);
    if (!measure?.b || !(len > 0)) return 0;
    const px = Math.hypot(measure.b[0] - measure.a[0], measure.b[1] - measure.a[1]);
    return (px / len) * squareMetres();
  }
  const width = toMetres(Number(els.widthLen.value), els.widthUnit.value);
  return width > 0 ? (pic.width / width) * squareMetres() : 0;
}

/** Where square (0, 0) is, in picture pixels: on the grid's lines when the scale comes from the grid. */
function origin(): P {
  if (scaleFrom === 'grid' && grid) return grid.offset;
  const a = area();
  return [a.x0, a.y0];
}

function showScale(): void {
  for (const k of ['grid', 'bar', 'width'] as const) $(`from-${k}`).hidden = scaleFrom !== k;
  const s = pxPerSquare();
  if (!pic || !s) {
    els.scale.textContent = scaleFrom === 'bar' ? 'Measure the scale bar and enter its length.' : scaleFrom === 'width' ? 'Enter the picture width.' : 'Enter the grid cell size.';
    return;
  }
  const a = area();
  const w = Math.ceil((a.x1 - a.x0) / s);
  const h = Math.ceil((a.y1 - a.y0) / s);
  const u = parseSquareUnit(els.unit.value);
  els.scale.textContent = `${s.toFixed(1)} px per square · the map will be ${w} × ${h} squares (${Math.round(w * u.size)} × ${Math.round(h * u.size)} ${u.name})`;
  els.scale.classList.toggle('bad', s < 3 || w * h > 250_000);
}

/** The scale bar measured or its length typed: use it. */
function applyMeasure(): void {
  if (!measure?.b) return;
  setScaleFrom('bar');
}

/** Two grid lines clicked: the cell from their distance. */
function applyLines(): void {
  if (!lines?.b) return;
  const dx = Math.abs(lines.b[0] - lines.a[0]);
  const dy = Math.abs(lines.b[1] - lines.a[1]);
  const n = Math.max(1, Number(els.linesCount.value) || 1);
  const cell = Math.max(dx, dy) / n;
  if (cell < 3) return;
  // the first click lies on a line: the grid goes through it (the other axis keeps what was found)
  const prev = grid?.offset ?? [0, 0];
  const offset: P = dx >= dy ? [((lines.a[0] % cell) + cell) % cell, prev[1] % cell] : [prev[0] % cell, ((lines.a[1] % cell) + cell) % cell];
  grid = { cell, offset };
  els.cell.value = cell.toFixed(2);
  els.cellSquares.value = '1';
  els.gridNote.textContent = `Set by hand: ${cell.toFixed(1)} px per cell.`;
  setScaleFrom('grid');
}

function setScaleFrom(f: ScaleFrom): void {
  scaleFrom = f;
  setRadio('scale-from', f);
  schedule();
}
for (const r of radios('scale-from')) r.addEventListener('change', () => r.checked && setScaleFrom(r.value as ScaleFrom));

els.unit.addEventListener('change', schedule);
els.cell.addEventListener('input', () => {
  const c = Number(els.cell.value);
  if (c > 0) grid = { cell: c, offset: grid?.offset ?? [0, 0] };
  schedule();
});
els.cellSquares.addEventListener('input', schedule);
els.linesCount.addEventListener('input', applyLines);
els.widthLen.addEventListener('input', () => setScaleFrom('width'));
els.widthUnit.addEventListener('change', schedule);
els.measureLen.addEventListener('input', applyMeasure);
els.measureUnit.addEventListener('change', schedule);
els.showGrid.addEventListener('change', draw);
for (const el of [els.grid, els.join, els.fill, els.split, els.snap, els.regular, els.minArea]) el.addEventListener('input', schedule);

/** First look at a picture: kind, colours, grid; the scale from the grid when there is one. */
function useAnalysis(a: Analysis, ms: number): void {
  analysis = a;
  mode = a.mode;
  colours = a.colours;
  roles = a.roles;
  space = a.space;
  els.painted.checked = a.painted;
  els.k.value = a.painted ? '12' : mode === 'city' ? '7' : '8';
  els.minArea.value = mode === 'dungeon' ? '0.5' : '0.3';
  els.unit.value = mode === 'dungeon' ? '5 ft' : '2 m';
  const found = a.grid ?? (mode === 'dungeon' ? a.wallGrid : null);
  grid = found ? { cell: found.cell, offset: found.offset } : null;
  if (grid) {
    els.cell.value = grid.cell.toFixed(2);
    els.cellSquares.value = '1';
    els.gridNote.textContent = a.grid
      ? `Found a grid: ${grid.cell.toFixed(1)} px per cell. The pink squares over the picture show it.`
      : `No grid printed, but the walls stand on squares of ${grid.cell.toFixed(1)} px (pink over the picture). Check them, or measure a known length.`;
  } else {
    els.cell.value = '';
    els.gridNote.textContent = 'No grid found. Measure a scale bar, click two grid lines, or give the width.';
  }
  // a guess to start from: 12 px per square (cities), or the walls' usual thickness (dungeons without a grid)
  const guess = mode === 'dungeon' && a.wallScale ? a.wallScale : 12;
  els.widthUnit.value = mode === 'city' ? 'm' : 'ft';
  const widthM = (pic!.width / guess) * squareMetres();
  const widthLen = els.widthUnit.value === 'm' ? widthM : widthM / M_PER_FT;
  els.widthLen.value = String(Math.round(widthLen));
  scaleFrom = grid && mode === 'dungeon' ? 'grid' : 'width';
  setRadio('scale-from', scaleFrom);
  showKind();
  showColours();
  const hint = scaleFrom === 'grid' ? 'Check the squares against the grid' : mode === 'city' ? 'Measure the scale bar (Measure, then its length) for the right size' : 'Set the scale';
  status(`${hint}, and the colour roles, then create the map. (${(ms / 1000).toFixed(1)} s)`);
  schedule();
}

// ---------- tracing ----------

function settings(): TraceSettings | null {
  const s = pxPerSquare();
  if (!pic || !colours.length || s < 1.5) return null;
  const painted = els.painted.checked;
  return {
    mode,
    painted,
    colours: colours.map((c) => c.colour),
    space,
    roles: [...roles],
    pxPerSquare: s,
    origin: origin(),
    printedGrid: mode === 'dungeon' && scaleFrom === 'grid' && grid !== null && analysis?.grid !== null && (Number(els.cellSquares.value) || 1) === 1,
    crop,
    minArea: Math.max(0, Number(els.minArea.value) || 0),
    minWidth: { ...minWidth },
    fillHoles: mode === 'dungeon' ? 0.35 : els.fill.checked ? 3 : 0,
    join: els.join.checked,
    grid: els.grid.checked,
    split: els.split.checked,
    snap: els.snap.checked ? 0.2 : 0,
    regular: els.regular.checked,
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
    if (pic && colours.length) status(pxPerSquare() ? 'Squares would be smaller than 1.5 pixels: change the scale.' : 'Set the scale first.', true);
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
  resultOrigin = s.origin;
  send({ type: 'trace', id: ++traceId, settings: s });
}

const newMapId = () => `map_${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

function buildMap() {
  if (!result) throw new Error('nothing traced yet');
  return tracedMap(result, {
    id: newMapId(),
    name: els.name.value,
    unit: squareUnit(els.unit.value),
    style: els.style.value,
    seed: crypto.getRandomValues(new Uint32Array(1))[0]! % 2 ** 31 || 1,
  });
}

function showCounts(ms: number): void {
  if (!result) return;
  const parts = Object.entries(result.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${(NOUNS[k] ?? [k, k])[n === 1 ? 0 : 1]}`);
  els.counts.textContent = `${parts.join(' · ') || 'Nothing traced: give a colour a role.'} — ${result.size[0]} × ${result.size[1]} squares, ${(ms / 1000).toFixed(1)} s`;
  els.create.disabled = !initial.loggedIn || !result.objects.length;
}

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const msg = e.data;
  if (msg.type === 'analysed') useAnalysis(msg.analysis, msg.ms);
  else if (msg.type === 'colours') {
    colours = msg.colours;
    roles = msg.roles;
    space = msg.space;
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
    if (view === 'result') renderResult();
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

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/** What one traced object looks like over the picture. */
function classOf(o: MapObject): string {
  if (o.type === 'terrain') return `o-terrain o-${o.asset}`;
  if (o.type === 'cutout') return o.name === 'Wall' ? 'o-wall' : 'o-cutout';
  if (o.type !== 'room') return '';
  if (o.name === 'Wall') return 'o-wall';
  if (o.name === 'Tower') return 'o-tower';
  if (o.name === 'Corridor') return 'o-corridor';
  return mode === 'dungeon' ? 'o-room' : 'o-building';
}

function draw(): void {
  if (!pic) return;
  const parts: SVGElement[] = [];
  const a = area();
  const s = pxPerSquare();
  if (result) {
    const [ox, oy] = resultOrigin;
    const k = resultPx;
    const pt = ([x, y]: Point) => `${f1(x * k + ox)} ${f1(y * k + oy)}`;
    const ring = (r: readonly Point[]) => `M${r.map(pt).join('L')}Z`;
    const groups = new Map<string, string>();
    const add = (cls: string, d: string) => groups.set(cls, (groups.get(cls) ?? '') + d);
    for (const o of result.objects) {
      if (o.type === 'door') {
        const b: Point = o.along === 'x' ? [o.at[0] + o.width, o.at[1]] : [o.at[0], o.at[1] + o.width];
        add('o-door', `M${pt(o.at)}L${pt(b)}`);
        continue;
      }
      if (!('shape' in o)) continue;
      const cls = classOf(o);
      if (!cls) continue;
      const sh = o.shape;
      if ('poly' in sh) add(cls, ring(sh.poly) + (o.type === 'terrain' ? (o.holes ?? []).map(ring).join('') : ''));
      else if ('circle' in sh) {
        const [cx, cy, r] = sh.circle;
        const [px, py] = [cx * k + ox, cy * k + oy];
        const rr = r * k;
        add(cls, `M${f1(px - rr)} ${f1(py)}a${f1(rr)} ${f1(rr)} 0 1 0 ${f1(2 * rr)} 0a${f1(rr)} ${f1(rr)} 0 1 0 ${f1(-2 * rr)} 0Z`);
      } else {
        const [x, y, w, h] = sh.rect;
        add(cls, ring([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]));
      }
    }
    // terrain first (underneath), then rooms, walls, doors
    const order = (c: string) => (c.startsWith('o-terrain') ? 0 : c === 'o-door' ? 3 : c === 'o-wall' || c === 'o-tower' ? 2 : 1);
    for (const [cls, d] of [...groups].sort((p, q) => order(p[0]) - order(q[0]))) parts.push(el('path', { d, class: cls, 'fill-rule': 'evenodd' }));
  }
  if (els.showGrid.checked && s >= 4) {
    // the squares, so the scale can be checked against the picture (on the grid's lines when it comes from the grid)
    const [ox, oy] = origin();
    const pat = el('pattern', { id: 'sq', width: f1(s), height: f1(s), patternUnits: 'userSpaceOnUse', x: f1(ox), y: f1(oy) });
    pat.append(el('path', { d: `M${f1(s)} 0H0V${f1(s)}`, class: scaleFrom === 'grid' && grid ? 'o-gridline' : 'o-grid' }));
    const defs = el('defs', {});
    defs.append(pat);
    parts.unshift(defs, el('rect', { x: a.x0, y: a.y0, width: a.x1 - a.x0, height: a.y1 - a.y0, fill: 'url(#sq)' }));
  }
  if (crop) {
    parts.push(el('path', { d: `M0 0H${pic.width}V${pic.height}H0Z M${crop.x0} ${crop.y0}V${crop.y1}H${crop.x1}V${crop.y0}Z`, class: 'o-outside' }));
    parts.push(el('rect', { x: crop.x0, y: crop.y0, width: crop.x1 - crop.x0, height: crop.y1 - crop.y0, class: 'o-crop' }));
  }
  for (const m of [measure, lines]) {
    if (!m) continue;
    const b = m.b ?? m.a;
    parts.push(el('line', { x1: m.a[0], y1: m.a[1], x2: b[0], y2: b[1], class: 'o-measure' }));
    for (const p of [m.a, b]) parts.push(el('circle', { cx: p[0], cy: p[1], r: 4 / pan.k, class: 'o-measure-end' }));
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

function setView(m: 'picture' | 'result'): void {
  view = m;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
  els.canvas.hidden = m !== 'picture';
  els.overlay.style.display = m === 'picture' ? '' : 'none';
  els.result.hidden = m !== 'result';
  if (m === 'result') {
    els.result.replaceChildren();
    renderResult();
  } else fit();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.addEventListener('click', () => setView(b.dataset.mode as 'picture' | 'result'));

function setTool(t: Tool): void {
  tool = t;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  els.viewport.dataset.tool = t;
  if (t === 'measure') status('Click (or drag) from one end of the scale bar to the other, then enter its length.');
  if (t === 'lines') status('Click a grid line, then another one a known number of squares away (enter how many).');
  if (t === 'crop') status('Drag a box around the part of the picture to trace.');
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool as Tool));
els.cropClear.addEventListener('click', () => {
  crop = null;
  schedule();
});
$('fit').addEventListener('click', fit);

function contentSize(): [number, number] {
  if (view === 'result') {
    const svg = els.result.querySelector('svg');
    return [Number(svg?.getAttribute('width')) || 1, Number(svg?.getAttribute('height')) || 1];
  }
  return [pic?.width ?? 1, pic?.height ?? 1];
}

function applyView(): void {
  els.content.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${pan.k})`;
  els.overlay.style.setProperty('--px', String(1 / pan.k));
}

function fit(): void {
  const [cw, ch] = contentSize();
  const r = els.viewport.getBoundingClientRect();
  const k = Math.min(r.width / cw, r.height / ch) * 0.98;
  pan = { k, x: (r.width - cw * k) / 2, y: (r.height - ch * k) / 2 };
  applyView();
  draw();
}

const toPic = (e: { clientX: number; clientY: number }): P => {
  const r = els.viewport.getBoundingClientRect();
  return [(e.clientX - r.left - pan.x) / pan.k, (e.clientY - r.top - pan.y) / pan.k];
};
const clampP = ([x, y]: P): P => [Math.max(0, Math.min(pic?.width ?? 0, x)), Math.max(0, Math.min(pic?.height ?? 0, y))];

let drag: { kind: Tool; sx: number; sy: number; vx: number; vy: number; start: P; moved: boolean } | null = null;

els.viewport.addEventListener('pointerdown', (e) => {
  if (!pic || (e.button !== 0 && e.button !== 1)) return;
  const p = clampP(toPic(e));
  const kind = e.button === 1 || view === 'result' ? 'pan' : tool;
  drag = { kind, sx: e.clientX, sy: e.clientY, vx: pan.x, vy: pan.y, start: p, moved: false };
  els.viewport.setPointerCapture(e.pointerId);
  if (kind === 'measure' || kind === 'lines') {
    const cur = kind === 'measure' ? measure : lines;
    const next = cur && !cur.b ? { a: cur.a, b: p } : { a: p, b: null };
    if (kind === 'measure') measure = next;
    else lines = next;
    draw();
  }
  e.preventDefault();
});
els.viewport.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) drag.moved = true;
  const p = clampP(toPic(e));
  if (drag.kind === 'pan') {
    pan.x = drag.vx + e.clientX - drag.sx;
    pan.y = drag.vy + e.clientY - drag.sy;
    applyView();
  } else if ((drag.kind === 'measure' || drag.kind === 'lines') && drag.moved) {
    const m = drag.kind === 'measure' ? measure : lines;
    if (m) m.b = p;
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
  if (d.kind === 'pan' && !d.moved && view === 'picture') {
    const i = colourAt(p);
    if (i >= 0) flashColour(i);
  } else if (d.kind === 'measure' || d.kind === 'lines') {
    const m = d.kind === 'measure' ? measure : lines;
    if (!m) return;
    if (d.moved) m.b = p;
    if (m.b && Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]) < 2) m.b = null;
    draw();
    if (!m.b) return;
    const px = Math.round(Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]));
    if (d.kind === 'measure') {
      els.measureLen.focus();
      status(`Measured ${px} px. Enter what that length is on the map.`);
      applyMeasure();
    } else {
      els.linesCount.focus();
      status(`${px} px between the lines. Enter how many squares apart they are.`);
      applyLines();
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
    const k = Math.max(0.05, Math.min(40, pan.k * Math.exp(-e.deltaY * 0.0015)));
    pan = { k, x: mx - ((mx - pan.x) * k) / pan.k, y: my - ((my - pan.y) * k) / pan.k };
    applyView();
    if (measure || lines) draw();
  },
  { passive: false },
);
window.addEventListener('resize', () => pic && fit());

// ---------- creating the map ----------

for (const p of initial.presets) els.style.add(new Option(p.name, p.id, false, p.id === 'clean'));
els.style.addEventListener('change', () => view === 'result' && renderResult());

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
showKind();
