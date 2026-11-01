// The GM's tokens tab: upload a picture and drop it on the page as a token, or
// pick one of Quillwarren's props. New tokens land in the middle of the view on the
// layer being worked on, controlled by nobody (the GM) until set otherwise.
import type { TableCtx } from './ctx.ts';
import { $, api, h, store, toast } from './dom.ts';
import { placeAt } from './logic.ts';
import { uploadImage } from './upload.ts';

interface AssetEntry {
  id: string;
  name: string;
  category: string;
  kind: 'prop' | 'terrain';
  w: number;
  h: number;
  tags: string[];
  available: boolean;
}
interface Catalog {
  categories: { id: string; name: string }[];
  assets: AssetEntry[];
}
interface Uploaded {
  url: string;
  name: string;
}

const SHOW = 120;

export function initLibrary(ctx: TableCtx): void {
  const panel = $('panel-tokens');
  const upKey = `delve-table-uploads:${ctx.gameId}`;
  const uploaded: Uploaded[] = store.get<Uploaded[]>(upKey) ?? [];
  let catalog: Catalog | null = null;
  let loadError = '';

  const search = h('input', { type: 'search', placeholder: 'Find a prop (chest, statue…)', 'aria-label': 'Find a prop' });
  const category = h('select', { class: 'field', 'aria-label': 'Prop category' });
  const grid = h('div', { class: 'props-grid' });
  const upGrid = h('div', { class: 'props-grid' });
  const layerNote = h('p', { class: 'hint' });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', 'aria-label': 'Upload a picture' });

  async function add(image: string, name: string, w: number, hgt: number): Promise<void> {
    const page = ctx.page();
    if (!page) return toast('There is no page to put the token on.');
    const [cx, cy] = ctx.board()?.centre() ?? [page.origin[0] + page.width / 2, page.origin[1] + page.height / 2];
    const { x, y } = placeAt(cx, cy, w, hgt);
    await ctx.act({ type: 'token.create', token: { pageId: page.id, layer: ctx.layer(), x, y, w, h: hgt, image, name, showName: false, controlledBy: [] } });
  }

  function drawUploads(): void {
    upGrid.replaceChildren(
      ...uploaded.map((u) =>
        h(
          'button',
          { type: 'button', title: `Add ${u.name} as a token`, onclick: () => void add(u.url, u.name, 1, 1) },
          h('img', { src: u.url, alt: '', loading: 'lazy' }),
          u.name,
        ),
      ),
    );
    upGrid.hidden = !uploaded.length;
  }

  function drawProps(): void {
    if (!catalog) {
      grid.replaceChildren(h('p', { class: 'empty' }, loadError || 'Loading props…'));
      return;
    }
    const q = search.value.trim().toLowerCase();
    const cat = category.value;
    const hits = catalog.assets.filter(
      (a) =>
        a.kind === 'prop' &&
        a.available &&
        (!cat || a.category === cat) &&
        (!q || a.name.toLowerCase().includes(q) || a.id.includes(q) || a.tags.some((t) => t.includes(q))),
    );
    grid.replaceChildren(
      ...hits.slice(0, SHOW).map((a) =>
        h(
          'button',
          { type: 'button', title: `${a.name} (${a.w}×${a.h})`, onclick: () => void add(`/assets/props/${encodeURIComponent(a.id)}.svg`, a.name, Math.max(0.5, a.w), Math.max(0.5, a.h)) },
          h('img', { src: `/assets/props/${encodeURIComponent(a.id)}.svg`, alt: '', loading: 'lazy' }),
          a.name,
        ),
      ),
    );
    if (!hits.length) grid.append(h('p', { class: 'empty' }, 'No prop matches.'));
    else if (hits.length > SHOW) grid.append(h('p', { class: 'empty' }, `${hits.length - SHOW} more: narrow the search.`));
  }

  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    void uploadImage(ctx.gameId, f)
      .then(async (up) => {
        const name = f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || 'Token';
        if (!uploaded.some((u) => u.url === up.url)) uploaded.unshift({ url: up.url, name });
        uploaded.splice(40);
        store.set(upKey, uploaded);
        drawUploads();
        await add(up.url, name, 1, 1);
      })
      .catch((e: Error) => toast(e.message));
  });
  search.addEventListener('input', drawProps);
  category.addEventListener('change', drawProps);

  panel.replaceChildren(
    h('h3', {}, 'Pictures'),
    h('div', { class: 'row' }, h('span', { class: 'btn primary file-btn' }, 'Upload a picture…', file)),
    upGrid,
    h('h3', {}, 'Quillwarren props'),
    h('div', { class: 'row' }, search, category),
    grid,
    layerNote,
  );
  drawUploads();
  drawProps();

  const showLayer = () => {
    const name = { map: 'map', tokens: 'tokens', gm: 'GM-only' }[ctx.layer()];
    layerNote.textContent = `New tokens go in the middle of your view, on the ${name} layer. Double-click a token to set its size, bars, who controls it and more.`;
  };
  showLayer();
  ctx.on((c) => {
    if (c === 'layer') showLayer();
  });

  void api<Catalog>('/api/v1/assets')
    .then((c) => {
      catalog = c;
      const used = new Set(c.assets.filter((a) => a.kind === 'prop' && a.available).map((a) => a.category));
      category.replaceChildren(
        h('option', { value: '' }, 'All kinds'),
        ...c.categories.filter((k) => used.has(k.id)).map((k) => h('option', { value: k.id }, k.name)),
      );
      drawProps();
    })
    .catch((e: Error) => {
      loadError = `The props didn't load: ${e.message}`;
      drawProps();
    });
}
