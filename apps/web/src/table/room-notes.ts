// GM notes on the 2D board (Quillwarren pages, the GM's own view): pins on the rooms,
// corridors and terrain that have notes, and a note box like the markers' one.
// Two ways to open an area's notes, so they never fight token selection:
// - click its pin;
// - "Notes" mode (the button in the top bar, or N): a click on a room's floor
//   opens its notes. Tokens, markers and doors still take their own clicks, and
//   dragging still pans.
// The notes are the Quillwarren map's (gm-map.ts): saved as map ops with the editor login.
import { noteAreaAt, type Point } from '@delve/core';
import type { Member, Page, Token } from '@delve/table';
import { createAreaNote } from './area-note.ts';
import type { Board } from './board.ts';
import { toast } from './dom.ts';
import type { GmMap } from './gm-map.ts';
import { selectable, tokenAt } from './logic.ts';
import { createPins, pinItems } from './note-pins.ts';
import { doorAt, hasFog } from './vision-view.ts';

export interface RoomNotes {
  /** The page, the GM's view or the map changed: redraw the pins, close a box that no longer fits. */
  update(): void;
  mode(): boolean;
  setMode(on: boolean): void;
  /** Open an area's notes in the box (from the Notes tab's list). */
  open(id: string, at?: Point | null): void;
  close(): void;
  /** Hear when the mode or the open area changes. */
  onChange(cb: () => void): void;
  /** The area whose box is open. */
  openId(): string | null;
}

export function initRoomNotes(o: {
  stage: HTMLElement;
  board: Board;
  gmMap: GmMap;
  page: () => Page | null;
  seeAs: () => 'gm' | 'players';
  tokens: () => Token[];
  me: () => Member;
  layer: () => Token['layer'];
}): RoomNotes {
  const listeners: (() => void)[] = [];
  const changed = () => listeners.forEach((f) => f());
  let notesMode = false;
  let boxAt: Point | null = null;

  const usable = () => {
    const p = o.page();
    return Boolean(p && p.background.kind === 'delve' && o.seeAs() === 'gm' && o.gmMap.map());
  };

  // ---------- the box ----------

  const box = document.createElement('div');
  box.className = 'note-box';
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'GM notes');
  document.body.append(box);
  const editor = createAreaNote({ gmMap: o.gmMap, close: () => close(), onOpen: (id) => pins.setActive(id) });
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Only you see these notes. They are saved in the Quillwarren map.';
  box.append(editor.el, hint);

  function place(): void {
    if (box.hidden || !boxAt) return;
    const [sx, sy] = o.board.toClient(boxAt[0], boxAt[1]);
    const r = o.stage.getBoundingClientRect();
    if (sx < r.left - 20 || sx > r.right + 20 || sy < r.top - 20 || sy > r.bottom + 20) {
      box.style.visibility = 'hidden';
      return;
    }
    box.style.visibility = '';
    const w = box.offsetWidth;
    const hgt = box.offsetHeight;
    let x = sx + 18;
    if (x + w > window.innerWidth - 8) x = sx - 18 - w;
    box.style.left = `${Math.max(8, x)}px`;
    box.style.top = `${Math.max(8, Math.min(window.innerHeight - hgt - 8, sy - 30))}px`;
  }

  function open(id: string, at: Point | null = null): void {
    const map = o.gmMap.map();
    const a = map?.objects.find((x) => x.id === id);
    if (!map || !a) return;
    boxAt = at;
    if (!boxAt) {
      const pin = pinItems(map).find((p) => p.id === id);
      boxAt = pin?.at ?? null;
    }
    editor.open(id, at, true);
    box.hidden = false;
    place();
    changed();
  }

  function close(): void {
    if (box.hidden) return;
    editor.clear();
    box.hidden = true;
    boxAt = null;
    changed();
  }

  // ---------- pins ----------

  const pins = createPins(o.stage, {
    project(x, y) {
      const [cx, cy] = o.board.toClient(x, y);
      const r = o.stage.getBoundingClientRect();
      return [cx - r.left, cy - r.top];
    },
    open: (id, at) => open(id, at),
    small: () => o.board.pxPerCell() < 16,
  });

  function update(): void {
    const ok = usable();
    pins.show(ok);
    pins.set(ok ? pinItems(o.gmMap.map()) : []);
    if (!ok) {
      close();
      if (notesMode && o.page()?.background.kind !== 'delve') setMode(false);
    } else if (!box.hidden) {
      const id = editor.id();
      if (id && !o.gmMap.map()?.objects.some((x) => x.id === id)) close();
      else editor.refresh();
    }
    document.body.classList.toggle('notes-mode', notesMode && ok);
  }
  o.gmMap.onChange(update);
  o.board.onView(() => {
    pins.place();
    place();
  });
  window.addEventListener('resize', place);

  // ---------- Notes mode: a click on a room's floor ----------

  function setMode(on: boolean): void {
    if (on && o.page()?.background.kind !== 'delve') {
      toast('Room notes live on pages made from a Quillwarren map.', 'info');
      on = false;
    }
    notesMode = on;
    document.body.classList.toggle('notes-mode', on && usable());
    if (on) toast('Notes: click a room to read and write its notes. N or Esc to stop.', 'info');
    changed();
  }

  let press: { x: number; y: number; at: Point } | null = null;
  // registered after the markers' listener: a click on a marker stays the marker's
  o.stage.addEventListener(
    'pointerdown',
    (e) => {
      press = null;
      // only presses on the board itself: the banner's buttons, the zoom and the pins take their own
      if (!(e.target instanceof HTMLCanvasElement)) return;
      if (!box.hidden) close();
      if (!notesMode || e.button !== 0 || !usable() || e.shiftKey) return;
      const at = o.board.toWorld(e.clientX, e.clientY);
      // tokens and doors keep their clicks
      if (tokenAt(o.tokens(), at[0], at[1], selectable(o.me(), o.layer()))) return;
      const p = o.page();
      if (p && hasFog(p) && doorAt(p.doors, at[0], at[1], Math.max(0.25, 9 / o.board.pxPerCell()))) return;
      press = { x: e.clientX, y: e.clientY, at };
    },
    { capture: true },
  );
  window.addEventListener(
    'pointerup',
    (e) => {
      const p = press;
      press = null;
      if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return; // a drag pans
      const map = o.gmMap.map();
      const area = map ? noteAreaAt(map, p.at) : null;
      if (area) open(area.id, p.at);
      else toast('No room, corridor or terrain here.', 'info');
    },
    { capture: true },
  );
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!box.hidden) close();
    else if (notesMode) setMode(false);
  });

  return {
    update,
    mode: () => notesMode,
    setMode,
    open,
    close,
    onChange: (cb) => void listeners.push(cb),
    openId: () => (box.hidden ? null : editor.id()),
  };
}
