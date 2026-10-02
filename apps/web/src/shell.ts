// The map page's chrome (the markup is apps/server/src/editor-page.ts): the
// Export and ⋯ menus, the GM / Players switch, the zoom and storeys controls,
// toasts, the live and saved status, the shortcuts dialog, and which layout is
// on: desk (≥ 1024), narrow (768–1023, the inspector is a drawer) or phone
// (< 768, sheets and a bottom toolbar).
import { floorText, storeyTitle, type View } from '@delve/core';
import type { IconName } from '@delve/ui';
import { h, iconEl } from './dom.ts';

export interface Storey {
  id: string;
  name: string;
  level?: { group: string; name: string; order: number };
}

export type Layout = 'desk' | 'narrow' | 'phone';
type Conn = 'live' | 'connecting' | 'offline' | 'deleted';

export interface ToastOpts {
  icon?: IconName;
  action?: { label: string; run(): void };
}

export interface ShellHooks {
  setView(v: View): void;
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
}

/** The design's list, with Delve's letters (the rail shows the same ones). */
export const SHORTCUTS: [string, string][] = [
  ['V', 'Select'],
  ['H', 'Pan (or hold Space)'],
  ['R', 'Room · 1–8 shape'],
  ['C', 'Corridor'],
  ['D', 'Door'],
  ['S', 'Stairs'],
  ['I', 'Pillar / cutout'],
  ['N', 'Open area: no hatching there'],
  ['P', 'Prop'],
  ['G', 'Terrain'],
  ['T', 'Label'],
  ['M', 'GM marker'],
  ['F', 'Fog reveal'],
  ['U', 'Image upload'],
  ['B', 'Segment'],
  ['Drag', 'Box select (Select, on empty ground)'],
  ['Shift / Ctrl drag', 'Add a box to the selection'],
  ['Middle / right drag', 'Pan'],
  ['Corner drag', 'Resize a prop or picture (Alt: free)'],
  ['Q / E', 'Rotate 15° (Shift: 90°)'],
  ['Del', 'Delete selection'],
  ['Ctrl Z', 'Undo · Shift to redo'],
  ['Ctrl D', 'Duplicate'],
  ['Ctrl 0', 'Fit map · + − zoom'],
  ['PgUp / PgDn', 'Storey up / down'],
  ['Shift P', 'GM / Players view'],
  ['Shift G', 'Grid on / off'],
  ['Ctrl .', 'Show / hide Claude'],
  ['/', 'Focus Claude chat'],
  ['Alt', 'Half squares while drawing'],
  ['Esc', 'Cancel · deselect'],
  ['?', 'This list'],
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const typing = (t: EventTarget | null) => t instanceof HTMLElement && Boolean(t.closest('input, select, textarea, [contenteditable="true"]'));

export function initShell(o: { mapId: string; edit: boolean; view: View; hooks: ShellHooks }) {
  const body = document.body;
  const toasts = $('toasts')!;
  const banner = $('players-banner');
  const conn = [$('conn'), $('conn-mini')].filter((e): e is HTMLElement => Boolean(e));
  const save = $('save-state');
  const pct = $('zoom-pct');
  const storeysBox = $('storeys');
  const storeyBtn = $<HTMLButtonElement>('storey-btn');
  const storeyChip = $('storey-chip');
  const shortcuts = $('shortcuts');
  const actions = new Map<string, () => void>();

  // ---------- layout ----------

  const phoneQ = matchMedia('(max-width: 767px)');
  const narrowQ = matchMedia('(max-width: 1023px)');
  const layoutHooks: ((l: Layout) => void)[] = [];
  const layout = (): Layout => (phoneQ.matches ? 'phone' : narrowQ.matches ? 'narrow' : 'desk');
  const onLayout = () => layoutHooks.forEach((f) => f(layout()));
  phoneQ.addEventListener('change', onLayout);
  narrowQ.addEventListener('change', onLayout);

  function setDrawer(open: boolean): void {
    body.classList.toggle('drawer-open', open);
  }
  function setSheet(which: 'inspector' | 'claude' | null): void {
    body.classList.toggle('sheet-inspector', which === 'inspector');
    body.classList.toggle('sheet-claude', which === 'claude');
  }

  // ---------- menus ----------

  let openMenu: { btn: HTMLElement; menu: HTMLElement; temp: boolean } | null = null;
  function closeMenu(): void {
    if (!openMenu) return;
    openMenu.btn.setAttribute('aria-expanded', 'false');
    if (openMenu.temp) openMenu.menu.remove();
    else openMenu.menu.hidden = true;
    openMenu = null;
  }
  function showMenu(btn: HTMLElement, menu: HTMLElement, temp = false): void {
    const again = openMenu?.btn === btn;
    closeMenu();
    if (again) return;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    openMenu = { btn, menu, temp };
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }
  for (const [b, m] of [
    ['export-btn', 'export-menu'],
    ['more-btn', 'more-menu'],
  ] as const) {
    const btn = $(b);
    const menu = $(m);
    if (btn && menu) btn.addEventListener('click', () => showMenu(btn, menu));
  }
  document.addEventListener('pointerdown', (e) => {
    if (openMenu && !openMenu.menu.contains(e.target as Node) && !openMenu.btn.contains(e.target as Node)) closeMenu();
  });
  document.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[role="menuitem"]');
    if (!item || !openMenu?.menu.contains(item)) return;
    const act = item.dataset.act;
    closeMenu();
    if (act === 'shortcuts') openShortcuts();
    else if (act) actions.get(act)?.();
  });
  document.addEventListener('keydown', (e) => {
    if (!openMenu) return;
    const items = [...openMenu.menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((el) => !el.closest('[hidden]'));
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      const btn = openMenu.btn;
      closeMenu();
      btn.focus();
      e.stopPropagation();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  }, true);

  // ---------- view ----------

  const radios = () => [...document.querySelectorAll<HTMLInputElement>('input[name="view"], input[name="view-phone"]')];
  function syncView(v: View): void {
    for (const r of radios()) r.checked = r.value === v;
    if (banner) banner.hidden = v !== 'players';
    // downloads follow the view
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="/render.png"]:not([data-crop]), a[href*="/render.svg"]:not([data-crop])')) {
      const url = new URL(a.href);
      url.searchParams.set('view', v);
      a.href = url.pathname + url.search;
    }
  }
  for (const r of radios()) r.addEventListener('change', () => r.checked && o.hooks.setView(r.value === 'players' ? 'players' : 'gm'));

  // ---------- zoom ----------

  $('zoom-in')?.addEventListener('click', () => o.hooks.zoomIn());
  $('zoom-out')?.addEventListener('click', () => o.hooks.zoomOut());
  $('fit')?.addEventListener('click', () => o.hooks.fit());
  function setZoom(p: number): void {
    if (pct) pct.textContent = `${Math.round(p)}%`;
  }

  // ---------- toasts ----------

  function toast(msg: string, kind: 'error' | 'info' = 'error', t: ToastOpts = {}): void {
    const close = () => el.remove();
    const el = h(
      'div',
      { class: `toast${kind === 'error' ? ' toast-error' : ''}`, role: kind === 'error' ? 'alert' : 'status' },
      iconEl(t.icon ?? (kind === 'error' ? 'alert' : 'check'), 16),
      h('span', {}, msg),
      t.action ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => (close(), t.action!.run()) }, t.action.label) : null,
      h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', onclick: close }, iconEl('x', 15)),
    );
    toasts.append(el);
    while (toasts.children.length > 3) toasts.firstElementChild!.remove();
    setTimeout(close, kind === 'error' ? 10000 : 4000);
  }

  // ---------- status ----------

  let lastActivity = '';
  function setConnection(state: Conn): void {
    const text = { live: 'Live', connecting: 'Connecting…', offline: 'Offline · retrying', deleted: 'Map deleted' }[state];
    for (const c of conn) {
      c.classList.remove('status-live', 'status-connecting', 'status-offline');
      c.classList.add(state === 'live' ? 'status-live' : state === 'connecting' ? 'status-connecting' : 'status-offline');
      c.textContent = c.id === 'conn-mini' && state === 'live' && save ? `Live · ${save.textContent?.toLowerCase() ?? 'saved'}` : text;
      c.title = state === 'live' ? `Connected to the live map${lastActivity ? ` · ${lastActivity}` : ''}` : text;
    }
  }
  function setActivity(text: string): void {
    lastActivity = text;
    for (const c of conn) if (c.classList.contains('status-live')) c.title = `Connected to the live map · ${text}`;
  }
  let saveTimer = 0;
  function setSave(state: 'saving' | 'saved' | 'failed'): void {
    if (!save) return;
    clearTimeout(saveTimer);
    const [ic, text] = state === 'saving' ? (['upload', 'Saving…'] as const) : state === 'saved' ? (['check', 'Saved'] as const) : (['alert', 'Not saved'] as const);
    save.classList.toggle('is-warning', state === 'failed');
    save.replaceChildren(iconEl(ic, 14), h('span', {}, text));
    const mini = $('conn-mini');
    if (mini?.classList.contains('status-live')) mini.textContent = `Live · ${text.toLowerCase()}`;
  }

  // ---------- storeys ----------

  let storeyList: Storey[] = [];
  let storeyOpts: { canAdd: boolean; onAdd(position: 'above' | 'below'): void } = { canAdd: false, onAdd: () => {} };
  const number = (s: Storey, i: number, list: Storey[]) => (s.level ? floorText(s.level.order) : String(list.length - 1 - i));
  function goStorey(id: string): void {
    if (id === o.mapId) return;
    const url = new URL(location.href);
    url.pathname = `/maps/${encodeURIComponent(id)}`;
    location.href = url.toString();
  }
  function renderStoreys(): void {
    const list = storeyList.length ? storeyList : [{ id: o.mapId, name: '' }];
    const many = storeyList.length > 1;
    if (storeyBtn) storeyBtn.hidden = !many;
    const cur = list.findIndex((s) => s.id === o.mapId);
    if (storeyChip) storeyChip.textContent = cur >= 0 ? number(list[cur]!, cur, list) : '';
    if (!storeysBox) return;
    if (!many && !storeyOpts.canAdd) {
      storeysBox.hidden = true;
      return;
    }
    storeysBox.hidden = false;
    const add = (position: 'above' | 'below') =>
      h('button', { type: 'button', class: 'ed-sbtn ed-sbtn-add', 'aria-label': `Add storey ${position}`, title: `Add storey ${position}`, onclick: () => storeyOpts.onAdd(position) }, iconEl('plus', 15));
    storeysBox.replaceChildren(
      ...(storeyOpts.canAdd ? [add('above')] : []),
      ...list.map((s, i) => {
        const here = s.id === o.mapId;
        const title = many ? storeyTitle(s) : 'This map';
        return h(
          'div',
          { style: 'position:relative' },
          h('button', { type: 'button', class: 'ed-sbtn', 'aria-current': String(here), 'aria-label': `Storey ${number(s, i, list)}, ${title}`, title, onclick: () => goStorey(s.id) }, number(s, i, list)),
          here && many ? h('span', { class: 'ed-sname' }, s.level?.name ?? s.name) : null,
        );
      }),
      ...(storeyOpts.canAdd ? [add('below')] : []),
      ...(many ? [h('span', { class: 'ed-skeys' }, 'PgUp/Dn')] : []),
    );
  }
  function setStoreys(list: Storey[], opts?: typeof storeyOpts): void {
    storeyList = list;
    if (opts) storeyOpts = opts;
    renderStoreys();
  }
  storeyBtn?.addEventListener('click', () => {
    const list = storeyList;
    const menu = h(
      'div',
      { class: 'menu ed-menu', role: 'menu', style: 'right:0;top:48px;width:240px' },
      ...list.map((s, i) =>
        h('button', { type: 'button', class: 'menu-item', role: 'menuitemradio', 'aria-checked': String(s.id === o.mapId), onclick: () => goStorey(s.id) }, h('span', { class: 'numeral', style: 'min-width:22px' }, number(s, i, list)), storeyTitle(s)),
      ),
      ...(storeyOpts.canAdd
        ? (['above', 'below'] as const).map((p) => h('button', { type: 'button', class: 'menu-item has-icon', role: 'menuitem', onclick: () => (closeMenu(), storeyOpts.onAdd(p)) }, iconEl('plus', 16), `Add a storey ${p}`))
        : []),
    );
    storeyBtn.parentElement!.style.position = 'relative';
    storeyBtn.after(menu);
    showMenu(storeyBtn, menu, true);
  });

  // ---------- shortcuts ----------

  function openShortcuts(): void {
    if (!shortcuts) return;
    const list = $('shortcuts-list')!;
    if (!list.childElementCount) list.replaceChildren(...SHORTCUTS.filter(([k]) => o.edit || ['Ctrl 0', 'PgUp / PgDn', 'Shift P', 'Shift G', 'Esc', '?'].includes(k)).map(([k, t]) => h('div', {}, h('kbd', {}, k), t)));
    shortcuts.hidden = false;
    shortcuts.querySelector<HTMLElement>('[data-close]')?.focus();
  }
  shortcuts?.addEventListener('click', (e) => {
    if (e.target === shortcuts || (e.target as HTMLElement).closest('[data-close]')) shortcuts.hidden = true;
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shortcuts && !shortcuts.hidden) {
      shortcuts.hidden = true;
      e.stopImmediatePropagation();
      return;
    }
    if (typing(e.target) || e.altKey) return;
    if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      openShortcuts();
    } else if ((e.key === 'PageUp' || e.key === 'PageDown') && storeyList.length > 1) {
      e.preventDefault();
      const i = storeyList.findIndex((s) => s.id === o.mapId);
      const next = storeyList[e.key === 'PageUp' ? i - 1 : i + 1];
      if (next) goStorey(next.id);
    }
  });

  syncView(o.view);
  return {
    toast,
    setConnection,
    setActivity,
    setSave,
    setZoom,
    syncView,
    setStoreys,
    layout,
    onLayout: (cb: (l: Layout) => void) => layoutHooks.push(cb),
    setDrawer,
    setSheet,
    openShortcuts,
    closeMenu,
    /** Run `cb` when a menu item with data-act="name" is chosen. */
    onAction: (name: string, cb: () => void) => actions.set(name, cb),
  };
}

export type Shell = ReturnType<typeof initShell>;
