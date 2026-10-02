// The start page's map library: maps on shelves by their category (the map
// field `category`, typed freely by an editor), and the storeys of one place (a
// level group, e.g. the Ashen Tower's three floors) as one row that opens to
// show each storey. A place's storeys share one category: setCategory files the
// whole place at once.
import { floorText, levelSiblings, ValidationError } from '@delve/core';
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

export const MAX_NAME = 200;

/** A map name as typed: trimmed, inner spaces collapsed, 1 to 200 characters. */
export function cleanName(v: unknown, what = 'name', max = MAX_NAME): string {
  const s = typeof v === 'string' ? v.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
  if (!s || s.length > max) throw new ValidationError([`${what}: give a name of 1 to ${max} characters`]);
  return s;
}

/**
 * Rename a place: the map and every storey of it share one name ("The Ashen
 * Tower"), so all of them get it. Returns the storeys changed.
 */
export function renamePlace(service: MapService, id: string, name: unknown, by: string): { name: string; changed: string[] } {
  const clean = cleanName(name);
  service.store.get(id); // 404 for unknown maps
  const changed: string[] = [];
  for (const s of levelSiblings(service.store.list(), id)) {
    if (s.name === clean) continue;
    service.apply(s.id, [{ op: 'update_map', set: { name: clean } }], { by });
    changed.push(s.id);
  }
  return { name: clean, changed };
}

/** Rename one storey ("Cellar"): its level name; other storeys keep theirs. */
export function renameStorey(service: MapService, id: string, name: unknown, by: string): { storey: string; changed: string[] } {
  const clean = cleanName(name, 'storey', 60);
  const { map } = service.store.get(id);
  if (!map.level) throw new ValidationError(['storey: this map is not a storey of a place (rename the map instead)']);
  if (map.level.name === clean) return { storey: clean, changed: [] };
  service.apply(id, [{ op: 'update_map', set: { level: { ...map.level, name: clean } } }], { by });
  // the other storeys' editors show the storey list: refresh it
  for (const s of levelSiblings(service.store.list(), id)) if (s.id !== id) service.hub.broadcast(s.id, { type: 'levels' });
  return { storey: clean, changed: [id] };
}

// ---------- the start page's markup ----------
// The design's map cards (docs/design/ui-v1, "Cards, tables, tags"): a picture
// of the map, its name and when it changed, Open and 3D on hover. Shelves fold,
// a place's storeys open under its card; both are remembered per browser.

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 d ago", then the date. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return iso.slice(0, 10);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Big maps (a Watabou city) take seconds in the hatched styles: their card picture uses the plain one. */
const BIG = 300;
const thumbUrl = (m: MapSummary): string => `/api/v1/maps/${encodeURIComponent(m.id)}/render.svg?view=gm${m.objects > BIG ? '&style=clean' : ''}&rev=${m.rev}`;

const ICON = {
  play: '<svg class="icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
  more: '<svg class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18.5" cy="12" r="1"/></svg>',
  chev: '<svg class="icon chev" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  dl: '<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
};

/** A map's downloads (and Delete for editors), in a small menu. */
function menu(m: MapSummary, loggedIn: boolean, label: string): string {
  const base = `/api/v1/maps/${encodeURIComponent(m.id)}`;
  const item = (href: string, text: string, sub = '', attrs = '') => `<a class="menu-item has-icon" role="menuitem" href="${href}"${attrs}>${ICON.dl}<span class="spacer">${text}${sub ? `<span class="menu-item-sub">${sub}</span>` : ''}</span></a>`;
  // renaming: a place's name (all its storeys share it) and, for a storey, its own name
  const pen = '<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>';
  const rename = (kind: 'place' | 'storey', text: string, current: string) =>
    `<button class="menu-item has-icon lib-rename" role="menuitem" type="button" data-rename="${esc(m.id)}" data-rename-kind="${kind}" data-current="${esc(current)}">${pen}<span class="spacer">${text}</span></button>`;
  const renames = loggedIn ? (m.level ? rename('storey', 'Rename storey…', m.level.name) + rename('place', 'Rename the place…', m.name) : rename('place', 'Rename…', m.name)) : '';
  const del = loggedIn
    ? `${renames}<button class="menu-item has-icon lib-delete" role="menuitem" type="button" data-delete="${esc(m.id)}" data-name="${esc(m.level ? `${m.name} · ${m.level.name}` : m.name)}"><svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9.5 4h5M6 7l1 13h10l1-13M10 11v5.5M14 11v5.5"/></svg><span class="spacer">Delete</span></button>`
    : '';
  return `<details class="lib-more"><summary class="btn btn-icon" aria-label="${esc(label)}" title="Downloads">${ICON.more}</summary><div class="menu" role="menu">
  <span class="lib-menu-id"><code>${esc(m.id)}</code></span>
  ${item(`${base}/render.png?view=players`, 'Roll20 PNG · players', '70 px per square, no GM marks', ' download')}
  ${item(`${base}/render.png`, 'PNG · GM', '', ' download')}
  ${item(`${base}/render.svg`, 'SVG', '', ' download')}
  ${item(`${base}/export.ds`, 'Dungeon Scrawl .ds', 'Opens in Dungeon Scrawl', ' download title="Open this map in Dungeon Scrawl"')}
  ${item(`/maps/${encodeURIComponent(m.id)}/handout`, 'Parchment handout', 'The players’ map to print', ' title="The players\' map on old parchment, to print or hand out"')}
  ${item(`${base}/describe`, 'Text', 'What Claude reads')}
  ${del}</div></details>`;
}

function categoryCell(p: Place, loggedIn: boolean): string {
  if (!loggedIn) return p.category ? `<span class="tag">${esc(p.category)}</span>` : '';
  const what = p.storeys.length > 1 ? `${p.name} (all ${p.storeys.length} storeys)` : p.name;
  return `<input class="cat-input" type="text" list="map-categories" maxlength="${MAX_CATEGORY}" value="${esc(p.category ?? '')}" placeholder="Category…" aria-label="Category of ${esc(what)}" title="Type a category and press Enter: the map moves to that shelf" data-cat-for="${esc(p.storeys[0]!.id)}">`;
}

/** One storey in a place's opened list. */
function storeyRow(m: MapSummary, loggedIn: boolean): string {
  const floor = m.level ? floorText(m.level.order) : '';
  return `<div class="lib-storey"><span class="lib-floor" title="Floor">${esc(floor)}</span><a class="lib-storey-name" href="/maps/${encodeURIComponent(m.id)}">${esc(m.level?.name ?? m.name)}</a><code>${esc(m.id)}</code><span class="lib-storey-meta">${m.objects} · ${esc(ago(m.updated))}</span>${menu(m, loggedIn, `Downloads for ${m.level?.name ?? m.name}`)}</div>`;
}

function placeCard(p: Place, loggedIn: boolean): string {
  const top = p.storeys[0]!;
  const ground = p.storeys.find((s) => s.level?.order === 0) ?? p.storeys[p.storeys.length - 1]!;
  const group = p.storeys.length > 1;
  const objects = p.storeys.reduce((n, s) => n + s.objects, 0);
  const open = `/maps/${encodeURIComponent(ground.id)}`;
  const body = `place-${esc(p.key)}`;
  const meta = `${group ? '' : `${objects} object${objects === 1 ? '' : 's'} · `}edited ${esc(ago(p.updated))}`;
  return `<article class="card map-card elev-sm place ${group ? 'group' : 'single'}"${group ? ` data-place="${esc(p.key)}"` : ''}>
  <div class="map-card-thumb"><a class="map-card-thumb-link" href="${open}" tabindex="-1" aria-hidden="true"><img src="${thumbUrl(ground)}" alt="" loading="lazy"></a>
  <div class="map-card-actions"><a class="btn btn-primary btn-sm" href="${open}">${ICON.play}Open</a>${group ? `<a class="btn btn-secondary btn-sm" href="/maps/${encodeURIComponent(top.id)}/3d" title="All storeys stacked in 3D">3D</a>` : ''}</div></div>
  <div class="map-card-body">
    <div class="lib-title-row"><a class="map-card-title" href="${open}">${esc(p.name)}</a>${group ? '' : menu(ground, loggedIn, `Downloads for ${p.name}`)}</div>
    <span class="map-card-meta">${group ? `<button class="place-toggle" type="button" aria-expanded="false" aria-controls="${body}" title="Show or hide the storeys">${ICON.chev}<span class="tag storeys">${p.storeys.length} storeys</span></button> · ` : ''}${meta}</span>
    <div class="lib-cat">${categoryCell(p, loggedIn)}</div>
  </div>
  ${group ? `<div class="place-storeys" id="${body}" hidden>${p.storeys.map((s) => storeyRow(s, loggedIn)).join('')}</div>` : ''}
</article>`;
}

/** The library on the start page: shelves of map cards, storeys folded up, categories editable when logged in. */
export function libraryHtml(maps: readonly MapSummary[], loggedIn: boolean, opts: { newTile?: boolean } = {}): string {
  const tile = opts.newTile ? `<button class="new-tile" type="button" data-new-map><svg class="icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span class="new-tile-label">New map</span><kbd>N</kbd></button>` : '';
  if (!maps.length) {
    return `<div class="empty lib-empty"><svg class="icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4 3 8.8l9 4.8 9-4.8z"/><path d="M3 13.2 12 18l9-4.8"/></svg><span class="empty-title">No maps yet</span><p class="empty-text">${loggedIn ? 'Start from a blank sheet, bring in a Dungeon Scrawl file, or ask Claude to build one.' : 'Log in to make maps, or ask Claude to build one over the API (see docs/API.md).'}</p>${loggedIn ? '<div class="row" style="gap:6px"><button class="btn btn-primary btn-sm" type="button" data-new-map>New map</button></div>' : ''}</div>`;
  }
  const shelves = libraryShelves(maps);
  const named = shelves.some((s) => s.category !== null);
  const shelfHtml = shelves
    .map((s, i) => {
      const count = s.places.reduce((n, p) => n + p.storeys.length, 0);
      const grid = `<div class="lib-grid">${i === 0 ? tile : ''}${s.places.map((p) => placeCard(p, loggedIn)).join('\n')}</div>`;
      if (!named) return grid;
      const title = s.category ?? 'No category';
      const key = s.category === null ? '' : s.category.toLocaleLowerCase();
      return `<section class="shelf" data-shelf="${esc(key)}">
<h3 class="shelf-head"><button class="shelf-toggle" type="button" aria-expanded="true">${ICON.chev}${esc(title)}</button> <span class="count">${count} map${count === 1 ? '' : 's'}</span></h3>
<div class="shelf-body">${grid}</div>
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
  const showPlace = (card, on) => {
    const btn = card.querySelector('.place-toggle');
    const body = document.getElementById(btn.getAttribute('aria-controls'));
    btn.setAttribute('aria-expanded', String(on));
    body.hidden = !on;
    card.classList.toggle('open', on);
  };
  document.querySelectorAll('.place.group').forEach((card) => {
    const key = card.dataset.place;
    showPlace(card, open.has(key));
    card.querySelector('.place-toggle').addEventListener('click', () => {
      const on = !open.has(key);
      if (on) open.add(key); else open.delete(key);
      save('delve-library-open', open);
      showPlace(card, on);
    });
  });
  const showShelf = (shelf, on) => {
    shelf.querySelector('.shelf-toggle').setAttribute('aria-expanded', String(on));
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
  // one downloads menu open at a time; a click elsewhere closes it
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.lib-more[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
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
document.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', async () => {
  const storey = b.dataset.renameKind === 'storey';
  const next = prompt(storey ? 'New name for this storey:' : 'New name (every storey of the place gets it):', b.dataset.current);
  if (next === null || !next.trim() || next.trim() === b.dataset.current) return;
  const res = await fetch('/api/v1/maps/' + encodeURIComponent(b.dataset.rename) + '/name', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(storey ? { storey: next } : { name: next }),
  });
  if (!res.ok) { const body = await res.json().catch(() => ({})); alert('Renaming failed: ' + (body.error || res.status)); return; }
  location.reload();
}));
document.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
  if (!confirm('Delete "' + b.dataset.name + '"? It disappears from Delve for everyone.')) return;
  const res = await fetch('/api/v1/maps/' + encodeURIComponent(b.dataset.delete), { method: 'DELETE' });
  if (!res.ok) { const body = await res.json().catch(() => ({})); alert('Deleting failed: ' + (body.error || res.status)); return; }
  location.reload(); // a place's card and counts follow
}));
`;

export const LIBRARY_CSS = `
  .library-shelves { display: flex; flex-direction: column; gap: var(--space-8); }
  .shelf-head { display: flex; align-items: baseline; gap: 10px; margin: 0 0 var(--space-4); font-weight: 400; }
  .shelf-toggle, .place-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 2px 6px; margin: -2px -6px; border: 0; border-radius: 6px; background: none; color: inherit; font: inherit; cursor: pointer; text-align: left; }
  .shelf-toggle { font-family: var(--font-display); font-size: var(--display-sm); }
  .shelf-toggle:hover, .place-toggle:hover { background: var(--color-hover); }
  .chev { color: var(--color-text-muted); transition: transform var(--dur-fast) var(--ease); }
  [aria-expanded="true"] > .chev { transform: rotate(90deg); }
  .shelf-head .count { color: var(--color-text-muted); font-size: var(--text-sm); }
  .lib-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr)); gap: var(--space-4); align-items: start; }
  .lib-grid .new-tile { min-height: 0; aspect-ratio: 16 / 13.5; }
  .map-card .map-card-title { text-decoration: none; }
  .map-card .map-card-title:hover { color: var(--color-accent-text); }
  .map-card.place { overflow: visible; }
  .map-card.place .map-card-thumb { border-radius: var(--radius-md) var(--radius-md) 0 0; }
  .map-card:has(details[open]) { z-index: 20; }
  .map-card.open { box-shadow: var(--shadow-md), 0 0 0 1px var(--color-accent); }
  .map-card-thumb img { object-fit: contain; padding: 6px; }
  /* the picture links to the map; Open and 3D sit on the picture (as in the design), so an opened storey list never covers them */
  .map-card-thumb-link { display: block; width: 100%; height: 100%; }
  .lib-title-row { display: flex; align-items: flex-start; gap: 6px; }
  .lib-title-row .map-card-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .lib-cat:empty { display: none; }
  .lib-cat { margin-top: 6px; }
  .cat-input { width: 100%; min-height: 28px; padding: 3px 8px; font: inherit; font-size: var(--text-sm); color: var(--color-text); background: var(--color-surface-2); border: 1px solid var(--color-control-border); border-radius: var(--radius-md); }
  .cat-input:hover { border-color: var(--color-text-muted); }
  .cat-input:focus-visible { border-color: var(--color-accent); outline: 2px solid var(--color-accent); outline-offset: 0; }
  .cat-input::placeholder { color: var(--color-text-faint); }
  .cat-input:disabled { opacity: .55; }
  .tag { background: var(--tint-neutral-bg); color: var(--tint-neutral-fg); }
  .tag.storeys { padding: 1px 8px; }
  .lib-more { position: relative; flex: none; }
  .lib-more > summary { list-style: none; width: 28px; height: 28px; margin: -3px -4px 0 0; }
  .lib-more > summary::-webkit-details-marker { display: none; }
  .lib-more[open] > summary { background: var(--color-press); color: var(--color-text); }
  .lib-more .menu { position: absolute; right: 0; top: 30px; width: 250px; z-index: 30; }
  .lib-menu-id { padding: 4px 10px 6px; font-size: var(--text-xs); color: var(--color-text-faint); }
  .lib-menu-id code { font-size: var(--text-xs); }
  .menu .lib-delete { color: var(--color-danger); }
  .place-storeys { display: flex; flex-direction: column; padding: 0 8px 8px; gap: 2px; }
  .lib-storey { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; grid-template-areas: "floor name more" "floor meta more"; align-items: center; column-gap: 8px; padding: 6px 6px; border-radius: 7px; background: var(--color-surface-2); }
  /* floor numbers in the UI font: the numeral font draws 1 and 0 like I and O at this size */
  .lib-floor { grid-area: floor; text-align: center; font: 600 var(--text-lg)/1 var(--font-ui); font-variant-numeric: tabular-nums; color: var(--color-text-muted); }
  .lib-storey-name { grid-area: name; color: var(--color-text); text-decoration: none; font-weight: 500; overflow-wrap: anywhere; }
  .lib-storey-name:hover { color: var(--color-accent-text); }
  .lib-storey code { display: none; }
  .lib-storey-meta { grid-area: meta; font-size: var(--text-xs); color: var(--color-text-muted); }
  .lib-storey .lib-more { grid-area: more; }
`;
