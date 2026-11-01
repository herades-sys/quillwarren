// The editor for one area's GM notes (a room, corridor or terrain of the page's
// Quillwarren map): its name, the other areas under the same spot, and the notes,
// saved as map ops a moment after typing stops (so the editor, Claude and the
// GM's other tabs see them). Used by the 2D board's note box and the 3D Notes tab.
import { areaTitle, isNoteArea, NOTES_MAX, noteAreasAt, notesOps, type NoteArea, type Point } from '@delve/core';
import { h } from './dom.ts';
import { LOGIN_TO_EDIT, type GmMap } from './gm-map.ts';

const SAVE_MS = 700;
const KIND: Record<NoteArea['type'], string> = { room: 'Room', corridor: 'Corridor', terrain: 'Terrain' };

export interface AreaNote {
  /** The editor: head, other areas here, the notes, the save status. */
  el: HTMLElement;
  /** The area shown, or null. */
  id(): string | null;
  /** Show an area's notes; `at` is the spot clicked (for "also here"). */
  open(id: string, at?: Point | null, focus?: boolean): void;
  /** Save what's typed now, if anything. */
  flush(): void;
  /** Stop showing an area (after saving). */
  clear(): void;
  /** The map changed: show its notes, unless the GM is typing. */
  refresh(): void;
}

export function createAreaNote(o: { gmMap: GmMap; close?: () => void; onOpen?: (id: string | null) => void; rows?: number }): AreaNote {
  let cur: string | null = null;
  let at: Point | null = null;
  let pending: string | null = null;
  let timer: number | undefined;

  const title = h('strong', {});
  const kind = h('span', { class: 'note-kind' });
  const head = h('div', { class: 'note-head' }, title, kind);
  if (o.close) head.append(h('button', { type: 'button', class: 'note-close', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => o.close?.() }, '×'));
  const also = h('div', { class: 'note-also' });
  const text = h('textarea', { rows: o.rows ?? 7, maxLength: NOTES_MAX, placeholder: 'A description, monsters, loot… Only you see this.', 'aria-label': 'GM notes' });
  const ro = h('p', { class: 'note-ro' });
  const status = h('div', { class: 'note-status', role: 'status' });
  const el = h('div', { class: 'area-note' }, head, also, text, ro, status);
  el.style.display = 'grid';
  el.style.gap = '8px';

  const area = (): NoteArea | null => {
    const map = o.gmMap.map();
    const found = cur && map ? map.objects.find((x) => x.id === cur) : undefined;
    return found && isNoteArea(found) ? found : null;
  };
  const setStatus = (s: string, state: 'ok' | 'error' = 'ok') => {
    status.textContent = s;
    status.dataset.state = state;
  };

  async function save(id: string, value: string): Promise<void> {
    setStatus('Saving…');
    try {
      await o.gmMap.send(notesOps(id, value));
      if (cur === id && pending === null) setStatus('Saved.');
    } catch (e) {
      if (cur === id && pending === null) pending = value; // keep it, so a reload doesn't throw it away
      setStatus((e as Error).message, 'error');
    }
  }

  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    if (cur === null || pending === null) return;
    const value = pending;
    pending = null;
    const a = area();
    if (a && (a.notes ?? '') === value) return setStatus('Saved.');
    if (a && !value.trim() && !a.notes) return;
    void save(cur, value);
  }

  text.addEventListener('input', () => {
    pending = text.value;
    setStatus('Typing…');
    clearTimeout(timer);
    timer = window.setTimeout(flush, SAVE_MS);
  });
  text.addEventListener('blur', flush);
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && o.close) {
      e.stopPropagation();
      o.close();
    }
  });

  /** Fill everything from the map (the text only when the GM isn't typing in it). */
  function show(): void {
    const map = o.gmMap.map();
    const a = area();
    if (!map || !a) {
      title.textContent = cur ? 'This area is gone from the map' : '';
      kind.textContent = '';
      also.replaceChildren();
      text.hidden = true;
      ro.hidden = true;
      return;
    }
    title.textContent = areaTitle(map, a);
    title.title = title.textContent;
    kind.textContent = KIND[a.type];
    const others = at ? noteAreasAt(map, at).filter((x) => x.id !== a.id) : [];
    also.replaceChildren(
      ...(others.length
        ? [h('span', {}, 'Also here:'), ...others.map((x) => h('button', { type: 'button', title: `${KIND[x.type]}: show its notes`, onclick: () => open(x.id, at) }, areaTitle(map, x)))]
        : []),
    );
    // read only without the editor login; what the GM already typed stays in the box (to copy)
    const editable = o.gmMap.canEdit() !== false || pending !== null || document.activeElement === text;
    text.hidden = !editable;
    ro.hidden = editable;
    ro.textContent = a.notes?.trim() ? a.notes : '(no notes yet)';
    if (editable && pending === null && document.activeElement !== text && text.value !== (a.notes ?? '')) text.value = a.notes ?? '';
    if (!editable && !status.textContent) setStatus(LOGIN_TO_EDIT, 'error');
  }

  function open(id: string, where: Point | null = null, focus = false): void {
    if (cur !== id) {
      flush();
      pending = null;
      text.value = '';
      setStatus('');
    }
    cur = id;
    at = where;
    show();
    o.onOpen?.(id);
    if (focus && !text.hidden) text.focus();
  }

  return {
    el,
    id: () => cur,
    open,
    flush,
    clear() {
      flush();
      cur = null;
      at = null;
      text.value = '';
      setStatus('');
      o.onOpen?.(null);
    },
    refresh: show,
  };
}
