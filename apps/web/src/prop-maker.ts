// The editor's side of custom props (this Delve's own, drawn by Claude): the
// "New prop…" button in the Prop picker, which opens the Claude panel with a
// message to finish, and each custom prop's menu: rename, category, size,
// blocks, "Ask Claude to change it", delete. Changes go to /api/v1/props and
// then tell the page (custom-props.ts) to reload the list.
import { assetInfo, PROP_CATEGORIES, PROP_MAX_SIZE, PROP_MIN_SIZE, type AssetInfo, type Blocks } from '@delve/core';
import { customPropRow, propsChanged } from './custom-props.ts';
import { btn, field, h, iconBtn, iconEl, input, seg, select } from './dom.ts';

export interface PropMakerHost {
  toast(msg: string, kind?: 'error' | 'info'): void;
  /** The picker's category, offered as the new prop's (all and custom mean Custom). */
  category(): string;
}

/** Open the Claude panel with this text in the box, `pick` selected so typing replaces it. */
export function askClaude(text: string, pick?: string): boolean {
  if (!document.getElementById('chat-input')) return false;
  if (localAssistant()) return false; // the desktop app's local model has no prop-drawing tools
  window.dispatchEvent(new CustomEvent('delve:chat-prefill', { detail: { text, pick } }));
  return true;
}

const NO_CHAT = 'Drawing props needs the Claude panel, and the chat isn’t set up on this server. Claude Code with Delve’s MCP can draw one too (create_prop).';
/** The desktop app's chat panel answers with a local model (it carries the assistant's name), not Claude. */
const localAssistant = (): boolean => Boolean(document.getElementById('chat')?.dataset.assistant);
const noChat = (): string => (localAssistant() ? 'Drawing new props needs Claude: the local model in the desktop app can’t draw them yet.' : NO_CHAT);
const DESCRIBE = '<describe it>';
const CHANGE = '<what to change>';

/** The picker's "New prop…" button. */
export function newPropButton(host: PropMakerHost): HTMLButtonElement {
  return btn('New prop…', {
    kind: 'ghost',
    size: 'sm',
    icon: 'brush',
    title: 'Ask Claude to draw a prop that isn’t in the catalog',
    attrs: { 'data-act': 'new-prop' },
    onclick: () => {
      const cat = host.category();
      const category = PROP_CATEGORIES.some((c) => c.id === cat) ? cat : 'custom';
      if (!askClaude(`Draw a new prop: ${DESCRIBE}, size 1×1 squares, category ${category}.`, DESCRIBE)) host.toast(noChat(), 'info');
    },
  });
}

async function send(method: 'PUT' | 'DELETE', url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: { error?: string; problems?: string[]; maps?: { name: string; count: number }[]; notes?: string[] } }> {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---------- the menu on a custom prop's tile ----------

let openMenu: HTMLElement | null = null;
function closeMenu(): void {
  openMenu?.remove();
  openMenu = null;
}
window.addEventListener(
  'pointerdown',
  (e) => {
    if (openMenu && !openMenu.contains(e.target as Node)) closeMenu();
    // The pickers and the context bar float over the map, inside the stage, whose
    // tool handler listens in the capture phase: without this, pressing "New prop…",
    // a tile's ⋯ or a category chip also placed a prop under the pointer.
    if (e.target instanceof Element && e.target.closest('#flyout, #ctxbar')) e.stopPropagation();
  },
  true,
);
// and the mouse wheel over a picker scrolls the picker instead of zooming the map
window.addEventListener(
  'wheel',
  (e) => {
    if (e.target instanceof Element && e.target.closest('#flyout')) e.stopPropagation();
  },
  { capture: true, passive: true },
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openMenu) {
    closeMenu();
    e.stopPropagation();
  }
}, true);

/** A custom prop's tile: the picker's button, a "custom" badge and the ⋯ menu. */
export function customTile(button: HTMLElement, a: AssetInfo, host: PropMakerHost): HTMLElement {
  button.querySelector('.ed-asset-pic')?.append(h('span', { class: 'tag tag-sm tag-accent ed-asset-badge', title: `Drawn for this Delve${a.by ? ` by ${a.by}` : ''}` }, 'custom'));
  const more = iconBtn('more', `${a.name}: rename, change or delete`, (e) => {
    e.stopPropagation();
    if (openMenu) return closeMenu();
    const item = (label: string, sub: string | null, run: () => void, danger = false) =>
      h('button', { type: 'button', class: 'menu-item', role: 'menuitem', style: danger ? 'color:var(--color-danger)' : undefined, onclick: () => (closeMenu(), run()) }, h('span', {}, label, sub ? h('span', { class: 'menu-item-sub' }, sub) : null));
    const menu = h(
      'div',
      { class: 'menu ed-propmenu', role: 'menu', 'aria-label': `${a.name} menu` },
      item('Rename…', null, () => editDialog(a.id, host, 'name')),
      item('Change category…', null, () => editDialog(a.id, host, 'category')),
      item('Change size…', `now ${a.w}×${a.h} squares`, () => editDialog(a.id, host, 'size')),
      item('Change what it blocks…', null, () => editDialog(a.id, host, 'blocks')),
      item('Ask Claude to change it…', 'opens the Claude panel', () => {
        if (!askClaude(`Change the custom prop "${a.name}" (${a.id}): ${CHANGE}.`, CHANGE)) host.toast(noChat(), 'info');
      }),
      item('Delete…', null, () => deleteDialog(a.id, host), true),
    );
    const r = more.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 240, r.left))}px`;
    menu.style.top = `${Math.min(window.innerHeight - 280, r.bottom + 4)}px`;
    document.body.append(menu);
    openMenu = menu;
    menu.querySelector<HTMLElement>('.menu-item')?.focus();
  });
  more.classList.add('btn-sm', 'ed-asset-more');
  more.setAttribute('aria-haspopup', 'menu');
  return h('div', { class: 'ed-asset-wrap' }, button, more);
}

// ---------- dialogs ----------

function dialog(title: string, body: HTMLElement[], actions: HTMLElement[]): { close(): void; root: HTMLElement } {
  const titleId = `pd-${Math.random().toString(36).slice(2)}`;
  const close = () => {
    root.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      close();
    }
  };
  const root: HTMLDivElement = h(
    'div',
    { class: 'dialog-backdrop ed-propdlg', onclick: (e: Event) => e.target === root && close() },
    h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'dialog-head' }, h('div', { class: 'dialog-title', id: titleId }, title), iconBtn('x', 'Close', () => close())),
      ...body,
      h('div', { class: 'dialog-actions' }, ...actions),
    ),
  );
  window.addEventListener('keydown', onKey, true);
  document.body.append(root);
  return { close, root };
}

const SIZES: [string, string][] = [];
for (let v = PROP_MIN_SIZE; v <= PROP_MAX_SIZE; v += 0.5) SIZES.push([String(v), String(v)]);
const BLOCKS: [Blocks, string][] = [['none', 'Nothing'], ['movement', 'Movement'], ['sight', 'Sight too']];

/** Name, category, size and blocks of one custom prop, with its preview. */
export function editDialog(id: string, host: PropMakerHost, focus: 'name' | 'category' | 'size' | 'blocks' = 'name'): void {
  const a = assetInfo(id);
  const row = customPropRow(id);
  if (!a || !row) return host.toast('That prop is gone: the list is out of date.', 'error');
  const v = { name: a.name, category: a.category, w: a.w, h: a.h, blocks: a.blocks };
  const err = h('p', { class: 'field-error', hidden: true });
  const name = input({ value: v.name, maxlength: 60, 'data-f': 'name', oninput: (e: Event) => (v.name = (e.target as HTMLInputElement).value) });
  const cat = select(PROP_CATEGORIES.map((c) => [c.id, c.name] as [string, string]), v.category, (x) => (v.category = x), { 'data-f': 'category' });
  const wSel = select(SIZES, String(v.w), (x) => (v.w = Number(x)), { 'data-f': 'size', 'aria-label': 'Width in squares' });
  const hSel = select(SIZES, String(v.h), (x) => (v.h = Number(x)), { 'aria-label': 'Height in squares' });
  const blocks = seg(`blocks-${id}`, BLOCKS, v.blocks, (x) => (v.blocks = x), 'ed-seg-full');
  const save = btn('Save', { kind: 'primary' });
  const d = dialog(
    'Edit prop',
    [
      h('div', { class: 'ed-propdlg-preview' }, h('img', { src: row.preview, alt: `${a.name} on a floor in three map styles` })),
      h('p', { class: 'dialog-body' }, `${id} · drawn ${row.created.slice(0, 10)} by ${row.by}. Shared with every GM on this Delve.`),
      field('Name', name),
      field('Category', cat, { hint: 'Where it shows in the Prop picker. Decals lie under the walls; GM symbols only show in the GM view.' }),
      h('div', { class: 'ed-two' }, field('Width', wSel, { unit: 'sq' }), field('Height', hSel, { unit: 'sq' })),
      h('p', { class: 'field-hint', style: 'margin:0' }, 'A new size redraws the drawing at that size; its line weights stay.'),
      field('Blocks', blocks, { hint: 'Nothing: walk over it. Movement: in the way, but you can see past it. Sight too: walls off the view.' }),
      err,
    ],
    [btn('Cancel', { kind: 'ghost', onclick: () => d.close() }), save],
  );
  save.addEventListener('click', async () => {
    const patch: Record<string, unknown> = {};
    if (v.name.trim() !== a.name) patch.name = v.name.trim();
    if (v.category !== a.category) patch.category = v.category;
    if (v.w !== a.w) patch.w = v.w;
    if (v.h !== a.h) patch.h = v.h;
    if (v.blocks !== a.blocks) patch.blocks = v.blocks;
    if (!Object.keys(patch).length) return d.close();
    save.disabled = true;
    try {
      const r = await send('PUT', `/api/v1/props/${encodeURIComponent(id)}`, patch);
      if (!r.ok) {
        err.textContent = r.data.problems?.join(' ') ?? r.data.error ?? `The server said ${r.status}.`;
        err.hidden = false;
        return;
      }
      d.close();
      host.toast(`Saved ${v.name.trim() || a.name}.${r.data.notes?.length ? ` ${r.data.notes.join('; ')}.` : ''}`, 'info');
      propsChanged();
    } catch (e) {
      err.textContent = `Couldn’t save: ${(e as Error).message}`;
      err.hidden = false;
    } finally {
      save.disabled = false;
    }
  });
  d.root.querySelector<HTMLElement>(`[data-f="${focus}"]`)?.focus();
}

/** Delete, after a confirm; maps that still use it are named, with "Delete anyway". */
export function deleteDialog(id: string, host: PropMakerHost): void {
  const a = assetInfo(id);
  if (!a) return;
  const msg = h('p', { class: 'dialog-body' }, `“${a.name}” leaves every GM’s Prop picker. This can’t be undone.`);
  const go = btn('Delete', { kind: 'danger', icon: 'trash' });
  let force = false;
  const d = dialog('Delete prop?', [msg], [btn('Cancel', { kind: 'ghost', onclick: () => d.close() }), go]);
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const r = await send('DELETE', `/api/v1/props/${encodeURIComponent(id)}${force ? '?force=1' : ''}`);
      if (r.status === 409 && r.data.maps) {
        force = true;
        msg.textContent = `“${a.name}” is still on ${r.data.maps.map((m) => `${m.name} (${m.count}×)`).join(', ')}. Delete it anyway? Those maps then show a dashed outline where it stood.`;
        go.replaceChildren(iconEl('trash', 15), 'Delete anyway');
        return;
      }
      if (!r.ok) {
        host.toast(r.data.error ?? `The server said ${r.status}.`, 'error');
        return;
      }
      d.close();
      host.toast(`Deleted ${a.name}.`, 'info');
      propsChanged();
    } finally {
      go.disabled = false;
    }
  });
}
