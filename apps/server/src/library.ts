// The start page's map library: maps on shelves by their category (the map
// field `category`, typed freely by an editor), and the storeys of one place (a
// level group, e.g. the Ashen Tower's three floors) as one row that opens to
// show each storey. A place's storeys share one category: setCategory files the
// whole place at once.
import { levelSiblings, ValidationError } from '@delve/core';
import type { MapService } from './service.ts';
import type { MapSummary } from './store.ts';

/** One row of the library: a single map, or every storey of a place (top storey first). */
export interface Place {
  /** The level group, or the map id of a single map. */
  key: string;
  name: string;
  storeys: MapSummary[];
  /** The newest change on any of its storeys. */
  updated: string;
  category: string | null;
}

/** A shelf: the places of one category (null: not filed yet), the most recently changed first. */
export interface Shelf {
  category: string | null;
  places: Place[];
}

export const MAX_CATEGORY = 60;

/** A category as typed: trimmed, inner spaces collapsed; blank means "no category" (null). */
export function cleanCategory(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new ValidationError(['category must be a text of up to 60 characters, or null']);
  const s = v.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (s.length > MAX_CATEGORY) throw new ValidationError([`category: at most ${MAX_CATEGORY} characters`]);
  return s || null;
}

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** Places (storeys grouped, top first) on shelves: named categories A–Z, then the maps without one. */
export function libraryShelves(maps: readonly MapSummary[]): Shelf[] {
  const places: Place[] = [];
  const done = new Set<string>();
  for (const m of maps) {
    if (done.has(m.id)) continue;
    const storeys = m.level ? [...levelSiblings(maps, m.id)].reverse() : [m];
    for (const s of storeys) done.add(s.id);
    const ground = storeys.find((s) => s.level?.order === 0) ?? storeys[storeys.length - 1]!;
    places.push({
      key: m.level?.group ?? m.id,
      name: ground.name,
      storeys,
      updated: storeys.map((s) => s.updated).sort().at(-1)!,
      category: storeys.find((s) => s.category)?.category ?? null,
    });
  }
  // the same category typed in different case is one shelf, named as first written
  const shelves = new Map<string, Shelf>();
  for (const p of places) {
    const key = p.category === null ? '' : p.category.toLocaleLowerCase();
    let shelf = shelves.get(key);
    if (!shelf) shelves.set(key, (shelf = { category: p.category, places: [] }));
    shelf.places.push(p);
  }
  for (const s of shelves.values()) s.places.sort((a, b) => b.updated.localeCompare(a.updated));
  return [...shelves.values()].sort((a, b) => (a.category === null ? 1 : b.category === null ? -1 : byName(a.category, b.category)));
}

/** Every category in use, A–Z (for the input's suggestions). */
export function categoriesOf(maps: readonly MapSummary[]): string[] {
  return libraryShelves(maps).flatMap((s) => (s.category === null ? [] : [s.category]));
}

/**
 * File a map, and every storey of its place, under a category (null: take it
 * off its shelf). Each storey that changes gets one update_map op, which, like
 * notes, redraws nothing. Returns the storeys changed.
 */
export function setCategory(service: MapService, id: string, category: unknown, by: string): { category: string | null; changed: string[] } {
  const typed = cleanCategory(category);
  service.store.get(id); // 404 for unknown maps
  const maps = service.store.list();
  const place = levelSiblings(maps, id);
  // "dungeons" files under the "Dungeons" shelf that already exists (the place's own spelling may change)
  const mine = new Set(place.map((s) => s.id));
  const others = maps.filter((m) => !mine.has(m.id));
  const clean = typed === null ? null : (categoriesOf(others).find((c) => c.toLocaleLowerCase() === typed.toLocaleLowerCase()) ?? typed);
  const changed: string[] = [];
  for (const s of place) {
    if ((s.category ?? null) === clean) continue;
    service.apply(s.id, [clean === null ? { op: 'update_map', unset: ['category'] } : { op: 'update_map', set: { category: clean } }], { by });
    changed.push(s.id);
  }
  return { category: clean, changed };
}

// ---------- the start page's markup ----------

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const when = (iso: string): string => iso.replace('T', ' ').slice(0, 16);

function actions(m: MapSummary, loggedIn: boolean): string {
  const base = `/api/v1/maps/${encodeURIComponent(m.id)}`;
  const del = loggedIn
    ? `\n    <button class="button danger" type="button" data-delete="${esc(m.id)}" data-name="${esc(m.level ? `${m.name} · ${m.level.name}` : m.name)}">Delete</button>`
    : '';
  return `<a class="button primary" href="/maps/${encodeURIComponent(m.id)}">Open live view</a>
    <a class="button" href="${base}/render.png?view=players">Roll20 PNG · players</a>
    <a class="button" href="${base}/render.png">PNG · GM</a> <a class="button" href="${base}/render.svg">SVG</a>
    <a class="button" href="${base}/export.ds" title="Open this map in Dungeon Scrawl">Dungeon Scrawl</a>
    <a class="button" href="/maps/${encodeURIComponent(m.id)}/handout" title="The players' map on old parchment, to print or hand out">Parchment handout</a>
    <a class="button" href="${base}/describe">Text</a>${del}`;
}

function categoryCell(p: Place, loggedIn: boolean): string {
  if (!loggedIn) return p.category ? `<span class="tag">${esc(p.category)}</span>` : '';
  const what = p.storeys.length > 1 ? `${p.name} (all ${p.storeys.length} storeys)` : p.name;
  return `<input class="cat-input" type="text" list="map-categories" maxlength="${MAX_CATEGORY}" value="${esc(p.category ?? '')}" placeholder="Category…" aria-label="Category of ${esc(what)}" title="Type a category and press Enter: the map moves to that shelf" data-cat-for="${esc(p.storeys[0]!.id)}">`;
}

function mapRow(m: MapSummary, loggedIn: boolean, opts: { storey?: boolean; category?: string } = {}): string {
  const storey = m.level ? ` <span class="tag" title="One storey of a multi-storey place">${esc(m.level.name)}</span>` : '';
  return `<tr${opts.storey ? ' class="storey"' : ''}>
  <td><strong>${esc(m.name)}</strong>${storey}<br><code>${esc(m.id)}</code></td>
  <td class="cat">${opts.category ?? ''}</td>
  <td class="num">${m.rev}</td><td class="num">${m.objects}</td>
  <td class="meta">${esc(when(m.updated))}</td>
  <td class="links">${actions(m, loggedIn)}</td>
</tr>`;
}

function placeRows(p: Place, loggedIn: boolean): string {
  if (p.storeys.length === 1) return `<tbody class="place single">${mapRow(p.storeys[0]!, loggedIn, { category: categoryCell(p, loggedIn) })}</tbody>`;
  const top = p.storeys[0]!;
  const ground = p.storeys.find((s) => s.level?.order === 0) ?? p.storeys[p.storeys.length - 1]!;
  const chips = p.storeys.map((s) => `<span class="tag">${esc(s.level?.name ?? s.name)}</span>`).join(' ');
  const objects = p.storeys.reduce((n, s) => n + s.objects, 0);
  const body = `place-${esc(p.key)}`;
  return `<tbody class="place group" data-place="${esc(p.key)}">
<tr class="place-head">
  <td><button class="place-toggle" type="button" aria-expanded="false" aria-controls="${body}" title="Show or hide the storeys"><span class="chev" aria-hidden="true">▸</span><strong>${esc(p.name)}</strong></button>
    <span class="tag storeys">${p.storeys.length} storeys</span><br><span class="chips">${chips}</span></td>
  <td class="cat">${categoryCell(p, loggedIn)}</td>
  <td class="num"></td><td class="num">${objects}</td>
  <td class="meta">${esc(when(p.updated))}</td>
  <td class="links"><a class="button primary" href="/maps/${encodeURIComponent(ground.id)}">Open live view</a>
    <a class="button" href="/maps/${encodeURIComponent(top.id)}/3d" title="All storeys stacked in 3D">3D view</a></td>
</tr>
</tbody>
<tbody class="place-storeys" id="${body}" hidden>${p.storeys.map((s) => mapRow(s, loggedIn, { storey: true })).join('\n')}</tbody>`;
}

// the same column widths on every shelf, so the shelves line up
const HEAD = `<colgroup><col class="c-map"><col class="c-cat"><col class="c-num"><col class="c-num"><col class="c-when"><col></colgroup><thead><tr><th>Map</th><th>Category</th><th class="num">Rev</th><th class="num">Objects</th><th>Updated (UTC)</th><th>Downloads</th></tr></thead>`;

/** The library on the start page: shelves of places, storeys folded up, categories editable when logged in. */
export function libraryHtml(maps: readonly MapSummary[], loggedIn: boolean): string {
  if (!maps.length) {
    return `<p class="note">No saved maps yet. Create one with <code>POST /api/v1/maps</code> (see docs/API.md).</p>`;
  }
  const shelves = libraryShelves(maps);
  const named = shelves.some((s) => s.category !== null);
  const shelfHtml = shelves
    .map((s) => {
      const count = s.places.reduce((n, p) => n + p.storeys.length, 0);
      const table = `<div class="table"><table class="library">${HEAD}${s.places.map((p) => placeRows(p, loggedIn)).join('\n')}</table></div>`;
      if (!named) return table;
      const title = s.category ?? 'No category';
      const key = s.category === null ? '' : s.category.toLocaleLowerCase();
      return `<section class="shelf" data-shelf="${esc(key)}">
<h3 class="shelf-head"><button class="shelf-toggle" type="button" aria-expanded="true"><span class="chev" aria-hidden="true">▾</span>${esc(title)}</button> <span class="count">${count} map${count === 1 ? '' : 's'}</span></h3>
<div class="shelf-body">${table}</div>
</section>`;
    })
    .join('\n');
  const list = `<datalist id="map-categories">${categoriesOf(maps)
    .map((c) => `<option value="${esc(c)}"></option>`)
    .join('')}</datalist>`;
  return `<div class="library-shelves">${shelfHtml}</div>${loggedIn ? list : ''}
<script>${LIBRARY_SCRIPT}${loggedIn ? LIBRARY_EDIT_SCRIPT : ''}</script>`;
}

// open storeys and folded shelves are remembered per browser
const LIBRARY_SCRIPT = `
(() => {
  const read = (k) => { try { return new Set(JSON.parse(localStorage.getItem(k) || '[]')); } catch { return new Set(); } };
  const save = (k, set) => { try { localStorage.setItem(k, JSON.stringify([...set])); } catch {} };
  const open = read('delve-library-open');
  const folded = read('delve-library-folded');
  const showPlace = (head, on) => {
    const btn = head.querySelector('.place-toggle');
    const body = document.getElementById(btn.getAttribute('aria-controls'));
    btn.setAttribute('aria-expanded', String(on));
    btn.querySelector('.chev').textContent = on ? '\\u25BE' : '\\u25B8';
    body.hidden = !on;
    head.classList.toggle('open', on);
  };
  document.querySelectorAll('tbody.place.group').forEach((head) => {
    const key = head.dataset.place;
    showPlace(head, open.has(key));
    head.querySelector('.place-toggle').addEventListener('click', () => {
      const on = !open.has(key);
      if (on) open.add(key); else open.delete(key);
      save('delve-library-open', open);
      showPlace(head, on);
    });
  });
  const showShelf = (shelf, on) => {
    const btn = shelf.querySelector('.shelf-toggle');
    btn.setAttribute('aria-expanded', String(on));
    btn.querySelector('.chev').textContent = on ? '\\u25BE' : '\\u25B8';
    shelf.querySelector('.shelf-body').hidden = !on;
  };
  document.querySelectorAll('section.shelf').forEach((shelf) => {
    const key = shelf.dataset.shelf;
    showShelf(shelf, !folded.has(key));
    shelf.querySelector('.shelf-toggle').addEventListener('click', () => {
      const on = folded.has(key);
      if (on) folded.delete(key); else folded.add(key);
      save('delve-library-folded', folded);
      showShelf(shelf, on);
    });
  });
})();
`;

// a typed category is saved on Enter or when the field loses focus; the page then reloads onto the new shelf
const LIBRARY_EDIT_SCRIPT = `
document.querySelectorAll('.cat-input').forEach((input) => {
  let saved = input.value;
  const commit = async () => {
    const value = input.value.trim();
    if (value === saved.trim()) return;
    input.disabled = true;
    try {
      const res = await fetch('/api/v1/maps/' + encodeURIComponent(input.dataset.catFor) + '/category', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: value || null }),
      });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error || ('HTTP ' + res.status)); }
      saved = value;
      location.reload();
    } catch (e) {
      input.disabled = false;
      input.value = saved;
      alert('Saving the category failed: ' + e.message);
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.value = saved; input.blur(); } });
  input.addEventListener('change', commit);
});
document.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
  if (!confirm('Delete "' + b.dataset.name + '"? It disappears from Delve for everyone.')) return;
  const res = await fetch('/api/v1/maps/' + encodeURIComponent(b.dataset.delete), { method: 'DELETE' });
  if (!res.ok) { const body = await res.json().catch(() => ({})); alert('Deleting failed: ' + (body.error || res.status)); return; }
  location.reload(); // a place's row and counts follow
}));
`;

export const LIBRARY_CSS = `
  .shelf { margin: 0 0 18px; }
  .shelf-head { display: flex; align-items: baseline; gap: 10px; margin: 0 0 8px; font-size: 1.05rem; }
  .shelf-toggle, .place-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px; margin: -2px -4px; border: 0; border-radius: 6px; background: none; color: inherit; font: inherit; cursor: pointer; text-align: left; }
  .shelf-toggle:hover, .place-toggle:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
  .shelf-toggle:focus-visible, .place-toggle:focus-visible { outline: 2px solid var(--accent, #6FA6D8); outline-offset: 2px; }
  .chev { display: inline-block; width: 1em; text-align: center; color: var(--muted, #888); }
  .shelf-head .count { color: var(--muted, #888); font-size: .85rem; font-weight: 400; }
  table.library { table-layout: fixed; width: 100%; }
  table.library col.c-map { width: 24%; } table.library col.c-cat { width: 15%; } table.library col.c-num { width: 6%; } table.library col.c-when { width: 10%; }
  table.library td { overflow-wrap: anywhere; }
  .cat-input { width: 100%; min-width: 130px; padding: 5px 8px; border: 1px solid var(--line, #888); border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: .88rem; }
  .cat-input:focus-visible { outline: 2px solid var(--accent, #6FA6D8); outline-offset: 0; border-color: transparent; }
  .cat-input:disabled { opacity: .55; }
  tbody.place.group tr.place-head td { border-bottom: 0; }
  tbody.place.group.open tr.place-head td { background: color-mix(in srgb, currentColor 4%, transparent); }
  tbody.place-storeys tr.storey td { background: color-mix(in srgb, currentColor 4%, transparent); }
  tbody.place-storeys tr.storey td:first-child { padding-left: 34px; }
  .tag.storeys { margin-left: 6px; }
  .chips { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; padding-left: 22px; }
  .chips .tag { margin-left: 0; }
`;
