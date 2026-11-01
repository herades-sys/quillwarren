// The GM's Notes tab, on the 2D table's sidebar and in the 3D view's side panel:
// - Rooms: the GM notes of the page's Quillwarren map (rooms, corridors, terrain). In 3D
//   the area clicked is edited here; on the 2D board it opens in the note box.
// - Characters: the selected token's GM notes (through token.update, so the rules
//   and the players' filter apply as for the token dialog), and every token on the
//   page that has notes.
// - Notebook: the session notebook (session log, NPCs, to-dos), per game, over
//   REST (docs/TABLE.md, "GM notes"); other GM tabs follow through "notebook" messages.
// GM only: players never load or get any of it.
import { areaTitle, noteAnchor, notedAreas, type Point } from '@delve/core';
import { NOTEBOOK_TEXT_MAX, NOTEBOOK_TITLE_MAX, type Intent, type NotebookEntry, type Page, type ServerMessage, type Token } from '@delve/table';
import { createAreaNote, type AreaNote } from './area-note.ts';
import type { Change } from './ctx.ts';
import { api, button, h, store, toast } from './dom.ts';
import type { GmMap } from './gm-map.ts';
import { filterEntries, insertStamp, mergeEntry, notedTokens, removeEntry, snippet, stamp, tokenName, whenText } from './notes-logic.ts';

export type NotesSection = 'rooms' | 'characters' | 'notebook';

export interface NotesHost {
  gameId: string;
  panel: HTMLElement;
  page(): Page | null;
  /** The tokens on the page, every layer (the GM's). */
  tokens(): Token[];
  selected(): string[];
  select(ids: string[]): void;
  act(intent: Intent): Promise<boolean>;
  seeAs(): 'gm' | 'players';
  gmMap: GmMap;
  /** 2D: open an area's notes in the board's note box. Unset (3D): the Rooms section edits it. */
  openOnBoard?(id: string, at: Point | null): void;
  /** The board's Notes mode (2D): a click on a room opens its notes. */
  notesMode?: { get(): boolean; set(on: boolean): void };
  /** Point the view at a spot, or at a token. */
  focus?(at: Point): void;
  focusToken?(id: string): void;
  /** Words for "on the board" (2D) or "in the view" (3D). */
  where: 'board' | 'view';
  on(fn: (c: Change) => void): () => void;
  onMessage(fn: (m: ServerMessage) => void): () => void;
}

export interface NotesPanel {
  /** Show an area's notes in the Rooms section (3D). */
  showArea(id: string, at?: Point | null): void;
  /** The area edited in the Rooms section, or null. */
  areaId(): string | null;
  section(s: NotesSection): void;
  /** The map, the page or the GM's view changed: redraw the Rooms section. */
  roomsChanged(): void;
}

const SAVE_MS = 700;
const KEY = { section: 'delve-table-notes-section', entry: 'delve-table-notebook-open' };

export function initNotesPanel(host: NotesHost): NotesPanel {
  const { gmMap } = host;
  let section: NotesSection = store.get<NotesSection>(KEY.section) ?? 'rooms';
  if (!['rooms', 'characters', 'notebook'].includes(section)) section = 'rooms';

  // ---------- the sections and their switch ----------

  const subBtn = (id: NotesSection, label: string) => h('button', { type: 'button', role: 'tab', 'aria-selected': 'false', onclick: () => show(id) }, label);
  const subs: Record<NotesSection, HTMLButtonElement> = { rooms: subBtn('rooms', 'Rooms'), characters: subBtn('characters', 'Characters'), notebook: subBtn('notebook', 'Notebook') };
  const parts: Record<NotesSection, HTMLElement> = {
    rooms: h('div', { class: 'nsec' }),
    characters: h('div', { class: 'nsec' }),
    notebook: h('div', { class: 'nsec' }),
  };
  for (const p of Object.values(parts)) {
    p.style.display = 'grid';
    p.style.gap = '10px';
  }
  host.panel.replaceChildren(h('div', { class: 'subtabs', role: 'tablist', 'aria-label': 'Notes' }, subs.rooms, subs.characters, subs.notebook), parts.rooms, parts.characters, parts.notebook);

  function show(id: NotesSection): void {
    if (section !== id) {
      if (section === 'characters') char.flush();
      if (section === 'notebook') nb.flush();
      if (section === 'rooms') roomEditor?.flush();
    }
    section = id;
    store.set(KEY.section, id);
    for (const k of Object.keys(parts) as NotesSection[]) {
      parts[k].hidden = k !== id;
      subs[k].setAttribute('aria-selected', String(k === id));
    }
    if (id === 'notebook') nb.ensureLoaded();
  }

  // ---------- Rooms ----------

  const roomEditor: AreaNote | null = host.openOnBoard ? null : createAreaNote({ gmMap, rows: 9, onOpen: () => drawRooms() });
  const roomsNote = h('p', { class: 'hint' });
  const roomsList = h('ul', { class: 'nlist', 'aria-label': 'Areas with notes' });
  const roomsHead = h('h3', {}, 'With notes on this page');
  const modeBox = h('input', { type: 'checkbox' });
  modeBox.addEventListener('change', () => host.notesMode?.set(modeBox.checked));
  const modeRow = host.notesMode ? h('label', { class: 'check' }, modeBox, 'Notes mode: a click on a room opens its notes (N)') : null;
  parts.rooms.append(...[roomEditor?.el, modeRow, roomsNote, roomsHead, roomsList].filter((x): x is HTMLElement => Boolean(x)));
  let roomsKey = '';

  function drawRooms(): void {
    const page = host.page();
    const map = gmMap.map();
    const delve = page?.background.kind === 'delve';
    const asPlayers = host.seeAs() !== 'gm';
    if (modeRow) {
      modeBox.checked = Boolean(host.notesMode?.get());
      modeRow.hidden = !delve || asPlayers;
    }
    const usable = delve && !asPlayers && map !== null;
    roomsNote.textContent = !delve
      ? 'Room notes live on pages made from a Quillwarren map; this page has none. Characters and the notebook work on every page.'
      : asPlayers
        ? 'You are looking as the players do: switch back to the GM view to see room notes.'
        : !map
          ? 'Loading the map…'
          : host.openOnBoard
            ? 'Click a room’s note pin on the board, or turn on Notes mode and click any room, corridor or terrain to read and write its notes. They are saved in the Quillwarren map; the editor shows them too.'
            : roomEditor?.id()
              ? 'Saved in the Quillwarren map; the editor and the 2D table show them too.'
              : 'Click the floor of a room, corridor or terrain while this tab is open (or a note pin) to read and write its notes.';
    if (roomEditor) {
      roomEditor.el.hidden = !usable || !roomEditor.id();
      if (usable) roomEditor.refresh();
    }
    const noted = usable && map ? notedAreas(map) : [];
    const open = roomEditor?.id() ?? null;
    const key = JSON.stringify([noted.map((a) => [a.id, a.notes, map ? areaTitle(map, a) : '']), open]);
    roomsHead.hidden = !usable;
    roomsList.hidden = !usable;
    if (key === roomsKey) return;
    roomsKey = key;
    if (!noted.length) {
      roomsList.replaceChildren(h('li', { class: 'empty' }, 'No room has notes yet.'));
      return;
    }
    roomsList.replaceChildren(
      ...noted.map((a) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              'aria-current': String(a.id === open),
              onclick: () => {
                const at = map ? noteAnchor(map, a) : null;
                if (at) host.focus?.(at);
                if (host.openOnBoard) host.openOnBoard(a.id, at);
                else showArea(a.id, null);
              },
            },
            h('span', { class: 't' }, map ? areaTitle(map, a) : a.id),
            h('span', { class: 's' }, snippet(a.notes ?? '')),
          ),
        ),
      ),
    );
  }

  function showArea(id: string, at: Point | null = null): void {
    if (!roomEditor) return;
    show('rooms');
    roomEditor.open(id, at);
    drawRooms();
  }

  gmMap.onChange(drawRooms);

  // ---------- Characters ----------

  const char = (() => {
    let id: string | null = null;
    let pending: string | null = null;
    let timer: number | undefined;
    const img = h('img', { alt: '' });
    const name = h('strong', {});
    const layer = h('span', { class: 'tag' });
    const who = h('div', { class: 'who' }, img, name, layer);
    const text = h('textarea', { rows: 8, maxLength: 5000, placeholder: 'Who they are, what they want, what they know… Only you see this.', 'aria-label': 'GM notes on this token' });
    const status = h('div', { class: 'note-status', role: 'status' });
    const editor = h('div', {}, who, text, status);
    editor.style.display = 'grid';
    editor.style.gap = '8px';
    const note = h('p', { class: 'hint' });
    const listHead = h('h3', {}, 'With notes on this page');
    const list = h('ul', { class: 'nlist', 'aria-label': 'Tokens with notes' });
    parts.characters.append(editor, note, listHead, list);
    let listKey = '';

    const token = (tid: string | null): Token | undefined => (tid ? host.tokens().find((t) => t.id === tid) : undefined);
    const setStatus = (s: string, state: 'ok' | 'error' = 'ok') => {
      status.textContent = s;
      status.dataset.state = state;
    };

    async function save(tid: string, value: string): Promise<void> {
      setStatus('Saving…');
      const ok = await host.act({ type: 'token.update', id: tid, set: { gmNotes: value } });
      if (id !== tid || pending !== null) return;
      if (ok) setStatus('Saved.');
      else {
        pending = value;
        setStatus('Not saved (see the message above).', 'error');
      }
    }

    function flush(): void {
      clearTimeout(timer);
      timer = undefined;
      if (id === null || pending === null) return;
      const value = pending;
      pending = null;
      const t = token(id);
      if (!t) return setStatus('This token is gone.', 'error');
      if ((t.gmNotes ?? '') === value) return;
      void save(id, value);
    }

    text.addEventListener('input', () => {
      pending = text.value;
      setStatus('Typing…');
      clearTimeout(timer);
      timer = window.setTimeout(flush, SAVE_MS);
    });
    text.addEventListener('blur', flush);

    function draw(): void {
      const sel = host.selected();
      const target = sel.find((s) => token(s)) ?? null;
      if (target !== id) {
        flush();
        id = target;
        pending = null;
        text.value = '';
        setStatus('');
      }
      const t = token(id);
      editor.hidden = !t;
      if (t) {
        img.src = t.image;
        name.textContent = tokenName(t);
        layer.textContent = t.layer === 'gm' ? 'GM only' : t.layer === 'map' ? 'Map layer' : 'Token';
        if (pending === null && document.activeElement !== text && text.value !== (t.gmNotes ?? '')) text.value = t.gmNotes ?? '';
      }
      note.textContent = t
        ? sel.length > 1
          ? `${sel.length} tokens selected: these are the notes of ${tokenName(t)}.`
          : 'Saved on the token; players never get them. The token dialog has them too.'
        : `Select a token or mini ${host.where === 'board' ? 'on the board' : 'in the view'} to write notes about that character or NPC.`;
      const noted = notedTokens(host.tokens());
      const key = JSON.stringify([noted.map((x) => [x.id, x.name, x.gmNotes, x.layer]), id]);
      listHead.hidden = false;
      if (key === listKey) return;
      listKey = key;
      list.replaceChildren(
        ...(noted.length
          ? noted.map((x) =>
              h(
                'li',
                {},
                h(
                  'button',
                  {
                    type: 'button',
                    'aria-current': String(x.id === id),
                    onclick: () => {
                      host.select([x.id]);
                      host.focusToken?.(x.id);
                    },
                  },
                  h('span', { class: 't' }, `${tokenName(x)}${x.layer === 'gm' ? ' (GM only)' : ''}`),
                  h('span', { class: 's' }, snippet(x.gmNotes ?? '')),
                ),
              ),
            )
          : [h('li', { class: 'empty' }, 'No token on this page has notes yet.')]),
      );
    }
    return { draw, flush };
  })();

  // ---------- Notebook ----------

  const nb = (() => {
    const base = `/api/v1/games/${encodeURIComponent(host.gameId)}/notebook`;
    let entries: NotebookEntry[] | null = null;
    let loading = false;
    let openId: string | null = store.get<string>(KEY.entry);
    let query = '';
    let pending: { title?: string; text?: string } | null = null;
    let timer: number | undefined;
    let chain: Promise<unknown> = Promise.resolve();

    const search = h('input', { type: 'search', placeholder: 'Search the notebook…', 'aria-label': 'Search the notebook' });
    const add = button('New', () => void create(), { class: 'btn primary', title: 'A new notebook entry' });
    const list = h('ul', { class: 'nlist', 'aria-label': 'Notebook entries' });
    const listNote = h('p', { class: 'hint' }, 'A session log, NPCs, to-dos: plain text, saved as you type. Only you see the notebook.');
    const listView = h('div', {}, h('div', { class: 'row' }, search, add), list, listNote);

    const back = button('← All entries', () => openEntry(null), { class: 'btn small back' });
    const title = h('input', { type: 'text', maxLength: NOTEBOOK_TITLE_MAX, placeholder: 'Title', 'aria-label': 'Title' });
    const text = h('textarea', { class: 'long', rows: 16, maxLength: NOTEBOOK_TEXT_MAX, placeholder: 'Write here. Line breaks stay.', 'aria-label': 'Notebook entry' });
    const status = h('div', { class: 'note-status', role: 'status' });
    const stampBtn = button('Insert time stamp', () => addStamp(), { class: 'btn small', title: 'Put the date and time at the cursor, on a new line (for a session log)' });
    const del = button('Delete', () => void remove(), { class: 'btn small danger' });
    const entryView = h('div', {}, back, title, text, h('div', { class: 'row' }, stampBtn, h('span', { class: 'spacer' }), del), status);
    for (const v of [listView, entryView]) {
      v.style.display = 'grid';
      v.style.gap = '8px';
    }
    parts.notebook.append(listView, entryView);

    const entry = (id: string | null) => (id ? entries?.find((e) => e.id === id) : undefined);
    const setStatus = (s: string, state: 'ok' | 'error' = 'ok') => {
      status.textContent = s;
      status.dataset.state = state;
    };

    async function load(): Promise<void> {
      if (loading) return;
      loading = true;
      try {
        const body = await api<{ entries: NotebookEntry[] }>(base, { cache: 'no-store' });
        // what this tab hasn't saved yet stays as it is
        entries = body.entries;
        if (openId && !entry(openId)) openId = null;
      } catch (e) {
        if (!entries) list.replaceChildren(h('li', { class: 'empty' }, `The notebook didn't load: ${(e as Error).message}`));
        loading = false;
        return;
      }
      loading = false;
      draw();
    }

    function draw(): void {
      const cur = entry(openId);
      listView.hidden = Boolean(cur);
      entryView.hidden = !cur;
      if (cur) {
        const typing = document.activeElement === title || document.activeElement === text;
        if (pending?.title === undefined && !(typing && document.activeElement === title) && title.value !== cur.title) title.value = cur.title;
        if (pending?.text === undefined && !(typing && document.activeElement === text) && text.value !== cur.text) text.value = cur.text;
        if (!status.textContent) setStatus(`Changed ${whenText(cur.updated, Date.now())}`);
        return;
      }
      if (!entries) {
        list.replaceChildren(h('li', { class: 'empty' }, 'Loading…'));
        return;
      }
      const shown = filterEntries(entries, query);
      const now = Date.now();
      list.replaceChildren(
        ...(shown.length
          ? shown.map((e) =>
              h(
                'li',
                {},
                h(
                  'button',
                  { type: 'button', onclick: () => openEntry(e.id) },
                  h('span', { class: 't' }, e.title),
                  h('span', { class: 's' }, snippet(e.text) || '(empty)'),
                  h('span', { class: 'm' }, whenText(e.updated, now)),
                ),
              ),
            )
          : [h('li', { class: 'empty' }, entries.length ? 'Nothing matches.' : 'No entries yet. New starts one: the session log, NPCs, to-dos.')]),
      );
    }

    function openEntry(id: string | null): void {
      flush();
      openId = id;
      store.set(KEY.entry, id);
      pending = null;
      setStatus('');
      const cur = entry(id);
      if (cur) {
        title.value = cur.title;
        text.value = cur.text;
      }
      draw();
      if (!cur) search.focus();
    }

    async function create(): Promise<void> {
      flush();
      try {
        const now = new Date();
        const res = await api<{ entry: NotebookEntry }>(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: `Session ${now.toLocaleDateString()}`, text: '' }),
        });
        entries = mergeEntry(entries ?? [], res.entry);
        openEntry(res.entry.id);
        title.focus();
        title.select();
      } catch (e) {
        toast((e as Error).message);
      }
    }

    /** Send what's typed, one save after the other (so an older one never lands last). */
    function flush(keepalive = false): void {
      clearTimeout(timer);
      timer = undefined;
      const id = openId;
      const patch = pending;
      pending = null;
      if (!id || !patch) return;
      const cur = entry(id);
      if (cur && (patch.title === undefined || patch.title === cur.title) && (patch.text === undefined || patch.text === cur.text)) return;
      setStatus('Saving…');
      chain = chain.then(async () => {
        try {
          const res = await api<{ entry: NotebookEntry }>(`${base}/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
            keepalive,
          });
          entries = mergeEntry(entries ?? [], res.entry);
          if (openId === id && pending === null) setStatus(`Saved ${whenText(res.entry.updated, Date.now())}`);
        } catch (e) {
          if (openId === id) {
            pending = { ...patch, ...(pending ?? {}) };
            setStatus(`Not saved: ${(e as Error).message}`, 'error');
          }
        }
      });
    }

    const typed = (k: 'title' | 'text', v: string) => {
      pending = { ...(pending ?? {}), [k]: v };
      setStatus('Typing…');
      clearTimeout(timer);
      timer = window.setTimeout(() => flush(), SAVE_MS + 100);
    };
    title.addEventListener('input', () => typed('title', title.value));
    text.addEventListener('input', () => typed('text', text.value));
    title.addEventListener('blur', () => flush());
    text.addEventListener('blur', () => flush());
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        text.focus();
      }
    });
    search.addEventListener('input', () => {
      query = search.value;
      draw();
    });
    window.addEventListener('pagehide', () => flush(true));

    function addStamp(): void {
      const start = text.selectionStart ?? text.value.length;
      const end = text.selectionEnd ?? start;
      const out = insertStamp(text.value, start, end, stamp(new Date()));
      text.value = out.text;
      text.focus();
      text.setSelectionRange(out.caret, out.caret);
      typed('text', text.value);
    }

    async function remove(): Promise<void> {
      const cur = entry(openId);
      if (!cur) return;
      if (!confirm(`Delete “${cur.title}” from the notebook? This can’t be undone.`)) return;
      clearTimeout(timer);
      pending = null;
      try {
        await api(`${base}/${encodeURIComponent(cur.id)}`, { method: 'DELETE' });
        entries = removeEntry(entries ?? [], cur.id);
        openEntry(null);
      } catch (e) {
        toast((e as Error).message);
      }
    }

    function heard(msg: Extract<ServerMessage, { type: 'notebook' }>): void {
      if (!entries) return; // not loaded yet: the load brings it
      if (msg.entry) entries = mergeEntry(entries, msg.entry);
      if (msg.removed) {
        entries = removeEntry(entries, msg.removed);
        if (openId === msg.removed) {
          toast('That notebook entry was deleted (in another tab).', 'info');
          pending = null;
          openId = null;
        }
      }
      draw();
    }

    return {
      ensureLoaded: () => (entries ? draw() : void load()),
      /** Fetch again (after a reconnect), if it was ever loaded. */
      reload: () => {
        if (entries) void load();
      },
      flush: () => flush(),
      heard,
      draw,
    };
  })();

  // ---------- keeping up ----------

  host.on((c) => {
    if (c === 'all' || c === 'tokens' || c === 'selection' || c === 'pages') char.draw();
    if (c === 'all' || c === 'pages') drawRooms();
  });
  host.onMessage((m) => {
    if (m.type === 'notebook') nb.heard(m);
    // a reconnect (or another page) may have missed notebook messages
    else if (m.type === 'hello') nb.reload();
  });

  show(section);
  drawRooms();
  char.draw();

  return {
    showArea,
    areaId: () => roomEditor?.id() ?? null,
    section: show,
    roomsChanged: drawRooms,
  };
}
