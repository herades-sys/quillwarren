// The editor's Image tool (I): the user's own pictures. Upload one (the button,
// or drop or paste a picture while the tool is on), pick it from the uploaded
// ones, then click to place it: a ghost follows the pointer, snapped like a
// prop, and Q / E turn it. Also the panel fields of a selected picture.
// editor.ts hooks this in; the drawing itself is core's (render/scene.ts).
import { imageCentre, imageFit, imageUrl, nextId, type DelveMap, type MapImage, type MapObject, type Op, type Point } from '@delve/core';
import { SVG_NS } from './ctx.ts';

/** One uploaded picture, as GET /api/v1/images lists it. */
export interface ImageInfo {
  src: string;
  name: string;
  width: number;
  height: number;
}

export interface ImageHost {
  stage: HTMLElement;
  map(): DelveMap;
  /** The editor is on and the Image tool is the one in use. */
  active(): boolean;
  toMap(clientX: number, clientY: number): Point | null;
  apply(ops: Op[], select?: string[]): Promise<void>;
  toast(msg: string, kind?: 'error' | 'info'): void;
  /** Draw the tool options and the overlay again. */
  refresh(): void;
  /** The snap step in squares. */
  snap(): number;
}

export interface ImageTool {
  /** The tool's options: upload, the uploaded pictures to pick from, the turn. */
  picker(): HTMLElement;
  /** The picture about to be placed, drawn into the editor overlay at pointer p. */
  ghost(layer: SVGElement, p: Point, step: number): void;
  place(p: Point, step: number): void;
  /** Q / E: turn the picture about to be placed (tool on) or the selected pictures. False if there was nothing to turn. */
  turn(by: number, toolOn: boolean, selected: readonly (MapObject | undefined)[]): boolean;
  /** Panel fields for a selected picture (the editor adds Name above them). */
  fields(o: MapImage): HTMLElement[];
}

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = /^image\/(png|jpeg|webp|gif)$/;

type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') e.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) e.setAttribute(k, '');
    else if (k === 'value') (e as HTMLInputElement).value = String(v);
    else e.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== false) e.append(kid);
  return e;
}

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const degrees = (v: number) => ((Math.round(v) % 360) + 360) % 360;
const round2 = (v: number) => Math.max(0.05, Math.round(v * 100) / 100);
const baseName = (file: string) => file.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
const imageFile = (dt: DataTransfer | null): File | undefined => [...(dt?.files ?? [])].find((f) => f.type.startsWith('image/'));

/** The server's PNG export (resvg) can't read WebP, so the editor uploads a PNG copy when it isn't too big. */
async function webpAsPng(file: Blob): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d')?.drawImage(bmp, 0, 0);
    const png = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
    return png && png.size <= MAX_BYTES ? png : null;
  } catch {
    return null;
  }
}

export function initImages(host: ImageHost): ImageTool {
  let library: ImageInfo[] = [];
  let chosen: string | null = null;
  let rotation = 0;
  let keep = true; // "keep proportions" in the panel
  let busy = false;

  const infoOf = (src: string) => library.find((i) => i.src === src);
  const sizeOf = (src: string) => {
    const i = infoOf(src);
    return i ? imageFit(i.width, i.height) : { w: 2, h: 2 };
  };

  async function load(): Promise<void> {
    try {
      const res = await fetch('/api/v1/images');
      if (!res.ok) return;
      library = ((await res.json()) as { images: ImageInfo[] }).images;
      if (!chosen || !infoOf(chosen)) chosen = library[0]?.src ?? null;
      host.refresh();
    } catch {
      // offline: the list comes with the next upload
    }
  }
  void load();

  async function upload(file: File): Promise<ImageInfo | null> {
    // pasted pictures arrive as "image.png"
    const name = (file.name && !/^image\.\w+$/i.test(file.name) && baseName(file.name)) || 'Pasted picture';
    if (!TYPES.test(file.type)) {
      host.toast(`"${file.name || name}" isn't a PNG, JPEG, WebP or GIF picture.`);
      return null;
    }
    const body: Blob = file.type === 'image/webp' ? ((await webpAsPng(file)) ?? file) : file;
    if (body.size > MAX_BYTES) {
      host.toast(`"${name}" is too big: pictures can be at most 10 MB.`);
      return null;
    }
    const res = await fetch(`/api/v1/images?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': body.type }, body });
    const out = (await res.json().catch(() => ({}))) as Partial<ImageInfo> & { error?: string };
    if (!res.ok || !out.src) {
      host.toast(out.error ?? `uploading "${name}" failed (${res.status})`);
      return null;
    }
    const info: ImageInfo = { src: out.src, name: out.name ?? name, width: out.width ?? 0, height: out.height ?? 0 };
    library = [info, ...library.filter((i) => i.src !== info.src)];
    return info;
  }

  /** Upload the files one after another; the last one becomes the picture to place. */
  async function uploadAll(files: File[]): Promise<ImageInfo | null> {
    if (busy || !files.length) return null;
    busy = true;
    host.refresh();
    let last: ImageInfo | null = null;
    try {
      for (const f of files) last = (await upload(f)) ?? last;
    } finally {
      busy = false;
    }
    if (last) {
      chosen = last.src;
      host.toast(`"${last.name}" is ready: click on the map to place it.`, 'info');
    }
    host.refresh();
    return last;
  }

  async function forget(info: ImageInfo): Promise<void> {
    if (!confirm(`Remove the picture "${info.name}" from Delve? Maps that use it must drop it first.`)) return;
    const res = await fetch(`/api/v1/images/${encodeURIComponent(info.src)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return host.toast(body.error ?? `removing it failed (${res.status})`);
    }
    library = library.filter((i) => i.src !== info.src);
    if (chosen === info.src) chosen = library[0]?.src ?? null;
    host.refresh();
  }

  function place(p: Point, step: number): void {
    if (!chosen) return host.toast('Upload a picture (or pick one) in the panel first.', 'info');
    const { w, h } = sizeOf(chosen);
    const name = infoOf(chosen)?.name;
    const id = nextId(host.map(), 'img');
    const image: MapImage = { id, type: 'image', src: chosen, at: imageCentre(p, w, h, rotation, step), w, h, ...(rotation ? { rotation } : {}), ...(name ? { name } : {}) };
    void host.apply([{ op: 'add', object: image }], [id]);
  }

  // Dropping a picture on the map uploads it and places it there; pasting uploads it for the next click.
  host.stage.addEventListener('dragover', (e) => {
    if (!host.active() || ![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  host.stage.addEventListener('drop', (e) => {
    const file = host.active() ? imageFile(e.dataTransfer) : undefined;
    if (!file) return;
    e.preventDefault();
    const p = host.toMap(e.clientX, e.clientY);
    void uploadAll([file]).then((info) => {
      if (info && p) place(p, host.snap());
    });
  });
  window.addEventListener('paste', (e) => {
    const t = e.target as HTMLElement | null;
    if (!host.active() || t?.closest?.('input, textarea, [contenteditable]')) return;
    const file = imageFile(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    void uploadAll([file]);
  });

  function picker(): HTMLElement {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true });
    input.addEventListener('change', () => {
      void uploadAll([...(input.files ?? [])]);
      input.value = '';
    });
    const grid = library.length
      ? el(
          'div',
          { class: 'picker-grid', role: 'listbox', 'aria-label': 'Uploaded pictures' },
          ...library.map((i) =>
            el(
              'button',
              { type: 'button', 'aria-pressed': String(i.src === chosen), title: `${i.name} · ${i.width}×${i.height} px`, onclick: () => ((chosen = i.src), host.refresh()) },
              el('img', { src: imageUrl(i.src), alt: '', loading: 'lazy' }),
              i.name,
            ),
          ),
        )
      : el('p', { class: 'hint' }, 'No pictures uploaded yet.');
    const pick = chosen ? infoOf(chosen) : undefined;
    const box = el(
      'div',
      { class: 'picker image-picker' },
      el('div', { class: 'row' }, el('button', { type: 'button', class: 'upload', disabled: busy, onclick: () => input.click() }, busy ? 'Uploading…' : 'Upload a picture…'), input),
      el('p', { class: 'hint' }, 'PNG, JPEG, WebP or GIF, up to 10 MB. You can also drop a picture on the map or paste one (Ctrl+V) while this tool is on.'),
      el(
        'div',
        { class: 'rotate' },
        'Turned ',
        el('button', { type: 'button', title: 'Turn left (Q)', onclick: () => ((rotation = degrees(rotation - 90)), host.refresh()) }, '↺'),
        el('strong', {}, `${rotation}°`),
        el('button', { type: 'button', title: 'Turn right (E)', onclick: () => ((rotation = degrees(rotation + 90)), host.refresh()) }, '↻'),
      ),
      grid,
      ...(pick ? [el('button', { type: 'button', class: 'danger', title: 'Delete the uploaded file (only when no map uses it)', onclick: () => void forget(pick) }, `Remove “${pick.name}” from Delve`)] : []),
    );
    // the panel takes dropped pictures too
    box.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
      e.preventDefault();
      box.classList.add('drop');
    });
    box.addEventListener('dragleave', () => box.classList.remove('drop'));
    box.addEventListener('drop', (e) => {
      box.classList.remove('drop');
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      void uploadAll(files);
    });
    return box;
  }

  function ghost(layer: SVGElement, p: Point, step: number): void {
    if (!chosen) return;
    const { w, h } = sizeOf(chosen);
    const at = imageCentre(p, w, h, rotation, step);
    const box = { x: at[0] - w / 2, y: at[1] - h / 2, width: w, height: h, transform: `rotate(${rotation} ${at[0]} ${at[1]})` };
    layer.appendChild(svgEl('rect', { ...box, class: 'ghost' }));
    layer.appendChild(svgEl('image', { ...box, href: imageUrl(chosen), preserveAspectRatio: 'none', class: 'ghost-prop' }));
  }

  function turn(by: number, toolOn: boolean, selected: readonly (MapObject | undefined)[]): boolean {
    if (toolOn) {
      rotation = degrees(rotation + by);
      host.refresh();
      return true;
    }
    const pics = selected.filter((o): o is MapImage => o?.type === 'image');
    if (!pics.length) return false;
    void host.apply(
      pics.map((o): Op => {
        const r = degrees((o.rotation ?? 0) + by);
        return r ? { op: 'update', id: o.id, set: { rotation: r } } : { op: 'update', id: o.id, unset: ['rotation'] };
      }),
    );
    return true;
  }

  function fields(o: MapImage): HTMLElement[] {
    const id = o.id;
    const info = infoOf(o.src);
    const set = (s: Record<string, unknown>) => void host.apply([{ op: 'update', id, set: s }]);
    const unset = (k: string) => void host.apply([{ op: 'update', id, unset: [k] }]);
    const field = (label: string, input: HTMLElement) => el('label', { class: 'field' }, el('span', {}, label), input);
    const pair = (...kids: HTMLElement[]) => el('div', { class: 'pair' }, ...kids);
    const num = (value: number, step: number, on: (v: number) => void) =>
      el('input', {
        type: 'number',
        value,
        step,
        onchange: (e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(v)) on(v);
        },
      });
    // width or height; with "keep proportions" the other follows
    const resize = (w: number | null, h: number | null) => {
      const ratio = o.h / o.w;
      const nw = w ?? (keep ? round2(h! / ratio) : o.w);
      const nh = h ?? (keep ? round2(w! * ratio) : o.h);
      if (nw > 0 && nh > 0 && nw <= 1000 && nh <= 1000) set({ w: nw, h: nh });
    };
    const opacity = Math.round((o.opacity ?? 1) * 100);
    const shown = el('output', {}, `${opacity}%`);
    return [
      el(
        'div',
        { class: 'image-card' },
        el('img', { src: imageUrl(o.src), alt: '' }),
        el('span', { class: 'hint' }, info ? `${info.name} · ${info.width}×${info.height} px` : 'An uploaded picture'),
      ),
      pair(field('Width (squares)', num(o.w, 0.25, (v) => v > 0 && resize(v, null))), field('Height (squares)', num(o.h, 0.25, (v) => v > 0 && resize(null, v)))),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: keep, onchange: (e: Event) => (keep = (e.target as HTMLInputElement).checked) }), ' Keep proportions'),
      ...(info && info.width > 0 && Math.abs(o.h / o.w - info.height / info.width) > 0.01
        ? [el('button', { type: 'button', onclick: () => set({ h: round2((o.w * info.height) / info.width) }) }, 'Back to the picture’s own proportions')]
        : []),
      pair(field('X (centre)', num(o.at[0], 0.5, (v) => set({ at: [v, o.at[1]] }))), field('Y (centre)', num(o.at[1], 0.5, (v) => set({ at: [o.at[0], v] })))),
      el(
        'div',
        { class: 'rotate' },
        'Turned ',
        el('button', { type: 'button', title: 'Turn left (Q)', onclick: () => turn(-90, false, [o]) }, '↺'),
        el('input', { type: 'number', value: o.rotation ?? 0, step: 15, 'aria-label': 'Degrees clockwise', onchange: (e: Event) => { const v = degrees(Number((e.target as HTMLInputElement).value) || 0); if (v) set({ rotation: v }); else unset('rotation'); } }),
        '°',
        el('button', { type: 'button', title: 'Turn right (E)', onclick: () => turn(90, false, [o]) }, '↻'),
      ),
      field(
        'Lies',
        el(
          'select',
          { onchange: (e: Event) => ((e.target as HTMLSelectElement).value === 'floor' ? set({ layer: 'floor' }) : unset('layer')) },
          el('option', { value: 'props', selected: o.layer !== 'floor' }, 'on top (over walls, like a prop)'),
          el('option', { value: 'floor', selected: o.layer === 'floor' }, 'on the floor (under grid and walls)'),
        ),
      ),
      el(
        'div',
        { class: 'field opacity' },
        el('span', {}, 'Opacity ', shown),
        el('input', {
          type: 'range',
          min: 0,
          max: 100,
          step: 5,
          value: opacity,
          'aria-label': 'Opacity in percent',
          oninput: (e: Event) => (shown.textContent = `${(e.target as HTMLInputElement).value}%`),
          onchange: (e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (v >= 100) unset('opacity');
            else set({ opacity: v / 100 });
          },
        }),
      ),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: Boolean(o.gmOnly), onchange: (e: Event) => ((e.target as HTMLInputElement).checked ? set({ gmOnly: true }) : unset('gmOnly')) }), ' GM only (players never see it)'),
      field(
        'GM notes (never drawn)',
        el('textarea', { rows: 3, 'data-field': 'notes', onchange: (e: Event) => { const v = (e.target as HTMLTextAreaElement).value.trim(); if (v !== (o.notes ?? '')) (v ? set({ notes: v }) : unset('notes')); } }, o.notes ?? ''),
      ),
    ];
  }

  return { picker, ghost, place, turn, fields };
}
