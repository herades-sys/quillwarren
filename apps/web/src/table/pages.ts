// The GM's pages tab: every page with where you and the players are, switching
// your own view, moving the players ("player banner"), renaming, the grid and
// deleting; plus new pages from a Quillwarren map, from a picture, or blank.
import type { Page } from '@delve/table';
import type { TableCtx } from './ctx.ts';
import { $, api, button, h, postJson, toast } from './dom.ts';
import { uploadImage } from './upload.ts';
import { visionControls } from './vision-panel.ts';
import { movementControls } from './movement-panel.ts';

interface MapSummary {
  id: string;
  name: string;
  objects: number;
  updated: string;
  level?: { group: string; name: string; order: number };
}

export function initPages(ctx: TableCtx): void {
  const panel = $('panel-pages');
  let maps: MapSummary[] | null = null;
  let picking = false;
  let filter = '';
  let busy = false;

  const search = h('input', { type: 'search', placeholder: 'Find a map', 'aria-label': 'Find a Quillwarren map' });
  search.addEventListener('input', () => {
    filter = search.value.trim().toLowerCase();
    draw();
    search.focus();
  });

  async function openPicker(): Promise<void> {
    picking = true;
    draw();
    try {
      maps = (await api<{ maps: MapSummary[] }>('/api/v1/maps')).maps;
    } catch (e) {
      maps = [];
      alertError(e);
    }
    draw();
    search.focus();
  }

  async function fromMap(m: MapSummary): Promise<void> {
    if (busy) return;
    busy = true;
    draw();
    try {
      const res = await postJson<{ id?: string; page?: Page }>(`/api/v1/games/${encodeURIComponent(ctx.gameId)}/pages/from-map`, { mapId: m.id });
      const id = res?.id ?? res?.page?.id;
      picking = false;
      if (id) void ctx.act({ type: 'page.view', id });
    } catch (e) {
      alertError(e);
    } finally {
      busy = false;
      draw();
    }
  }

  async function fromPicture(file: File): Promise<void> {
    const up = await uploadImage(ctx.gameId, file).catch(alertError);
    if (!up) return;
    const px = 70;
    const w = Math.max(1, Math.round(up.width / px));
    const hgt = Math.max(1, Math.round(up.height / px));
    const name = file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || 'Picture';
    await ctx.act({
      type: 'page.create',
      page: { name, width: w, height: hgt, origin: [0, 0], cellPx: px, cellUnit: '5 ft', showGrid: true, background: { kind: 'image', url: up.url, w, h: hgt } },
    });
  }

  function alertError(e: unknown): undefined {
    toast(e instanceof Error ? e.message : String(e));
    return undefined;
  }

  function pageRow(p: Page, viewing: boolean, players: boolean, only: boolean): HTMLElement {
    const bg = p.background.kind === 'delve' ? 'Quillwarren map' : p.background.kind === 'image' ? 'Picture' : 'Blank';
    return h(
      'li',
      { class: 'page-item' },
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'name grow', title: 'Look at this page (the players stay where they are)', onclick: () => void ctx.act({ type: 'page.view', id: p.id }) }, p.name),
        viewing ? h('span', { class: 'tag on' }, 'You') : null,
        players ? h('span', { class: 'tag players' }, 'Players') : null,
      ),
      h('div', { class: 'muted small-text' }, `${bg} · ${p.width}×${p.height} cells`),
      h(
        'div',
        { class: 'row' },
        players ? null : button('Move players here', () => void ctx.act({ type: 'page.activate', id: p.id }), { class: 'btn small primary' }),
        button('Rename', () => {
          const name = prompt('Page name', p.name)?.trim();
          if (name && name !== p.name) void ctx.act({ type: 'page.update', id: p.id, set: { name } });
        }, { class: 'btn small' }),
        button(p.showGrid ? 'Grid: on' : 'Grid: off', () => void ctx.act({ type: 'page.update', id: p.id, set: { showGrid: !p.showGrid } }), {
          class: 'btn small',
          'aria-pressed': String(p.showGrid),
        }),
        button('Delete', () => {
          if (confirm(`Delete the page "${p.name}" and its tokens?`)) void ctx.act({ type: 'page.delete', id: p.id });
        }, { class: 'btn small danger', disabled: only, title: only ? 'A game needs at least one page' : undefined }),
      ),
      visionControls(ctx, p),
      movementControls(ctx, p),
    );
  }

  function draw(): void {
    const view = ctx.state()?.view;
    if (!view) return;
    const list = h('ul', { class: 'list' });
    for (const p of view.pages) list.append(pageRow(p, p.id === view.pageId, p.id === view.playerPageId, view.pages.length < 2));
    const kids: (HTMLElement | null)[] = [h('h3', {}, 'Pages'), list, h('h3', {}, 'New page')];
    if (!picking) {
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', 'aria-label': 'Page from a picture' });
      file.addEventListener('change', () => {
        const f = file.files?.[0];
        if (f) void fromPicture(f);
        file.value = '';
      });
      kids.push(
        h(
          'div',
          { class: 'row' },
          button('From a Quillwarren map…', () => void openPicker(), { class: 'btn primary' }),
          h('span', { class: 'btn file-btn' }, 'From a picture…', file),
          button('Blank', () =>
            void ctx.act({
              type: 'page.create',
              page: { name: `Page ${view.pages.length + 1}`, width: 30, height: 20, origin: [0, 0], cellPx: 70, cellUnit: '5 ft', showGrid: true, background: { kind: 'none' } },
            }),
          ),
        ),
        h('p', { class: 'hint' }, 'A Quillwarren map page shows the players’ view with fog of war, and follows the map as you reveal it. A picture page is sized at 70 px per cell.'),
      );
    } else {
      kids.push(h('div', { class: 'row' }, search, button('Cancel', () => {
        picking = false;
        draw();
      })));
      if (!maps) kids.push(h('p', { class: 'empty' }, 'Loading maps…'));
      else {
        const shown = maps.filter((m) => !filter || m.name.toLowerCase().includes(filter) || (m.level?.name ?? '').toLowerCase().includes(filter));
        if (!shown.length) kids.push(h('p', { class: 'empty' }, maps.length ? 'No map matches.' : 'There are no Quillwarren maps yet. Make one in Quillwarren first.'));
        const ml = h('ul', { class: 'list' });
        for (const m of shown) {
          ml.append(
            h(
              'li',
              {},
              h('span', { class: 'grow', title: m.name }, m.level ? `${m.name} (${m.level.name})` : m.name),
              h('span', { class: 'muted small-text' }, `${m.objects} objects`),
              button(busy ? 'Adding…' : 'Add', () => void fromMap(m), { class: 'btn small primary', disabled: busy }),
            ),
          );
        }
        kids.push(ml);
      }
    }
    const focused = document.activeElement;
    panel.replaceChildren(...kids.filter((k): k is HTMLElement => k !== null));
    if (focused === search) search.focus();
  }

  ctx.on((c) => {
    if (c === 'all' || c === 'pages') draw();
  });
}
