// Delve Table in the browser: holds this member's view of the game, applies the
// server's events to it, lays optimistic token moves over it, and wires the
// board, the side panels, the header and the keyboard together.
import type { ChatMessage, GameEvent, Intent, Layer, Member, ServerMessage, Token } from '@delve/table';
import { createBoard, type Board } from './board.ts';
import { initTableMarkers, type TableMarkers } from './gm-markers.ts';
import { createGmMap } from './gm-map.ts';
import { initNotesPanel } from './notes-panel.ts';
import { initRoomNotes, type RoomNotes } from './room-notes.ts';
import { initMovementView, type MovementView } from './movement-view.ts';
import { initChat } from './chat.ts';
import type { Change, TableCtx } from './ctx.ts';
import { initDice } from './dice.ts';
import { openTokenDialog } from './dialog.ts';
import { $, store, toast } from './dom.ts';
import { initLibrary } from './library.ts';
import { ackOptimistic, canMove, failOptimistic, isGm, needsReload, reduce, settleOptimistic, withOptimistic, type Optimistic, type TableState } from './logic.ts';
import { connect, type ConnState } from './net.ts';
import { initPages } from './pages.ts';
import { initPlayers } from './players.ts';
import { initTurns } from './turns.ts';
import { doorIsOpen } from '@delve/table';
import { mergeVision, previewTokens, reloadDelay, type BoardVision } from './vision-view.ts';

export interface Initial {
  gameId: string;
  gameName: string;
  me: { id: string; name: string; role: 'gm' | 'player' };
  version: string;
}

const CHANGE: Record<GameEvent['type'], Change> = {
  'token.upsert': 'tokens',
  'token.remove': 'tokens',
  'page.upsert': 'pages',
  'page.remove': 'pages',
  'page.switch': 'pages',
  chat: 'chat',
  turn: 'turn',
  members: 'members',
  game: 'game',
};

const NARROW = window.matchMedia('(max-width: 720px)');

export function startTable(initial: Initial): void {
  let state: TableState | null = null;
  const opt = new Map<string, Optimistic>();
  let selection = new Set<string>();
  let layer: Layer = 'tokens';
  let board: Board | null = null;
  const listeners = new Set<(c: Change) => void>();
  const emit = (changes: Iterable<Change>) => {
    for (const c of new Set(changes)) for (const f of [...listeners]) f(c);
  };

  const fallbackMe: Member = { ...initial.me, color: '#d4a017' };
  const me = (): Member => state?.view.you ?? fallbackMe;
  const page = () => (state ? (state.view.pages.find((p) => p.id === state!.view.pageId) ?? null) : null);
  const tokens = (): Token[] => (state ? withOptimistic(state.view.tokens, opt) : []);
  const gm = isGm(initial.me);
  /** The GM can look at a Delve page as the players see it. */
  let seeAs: 'gm' | 'players' = gm ? 'gm' : 'players';
  let tableMarkers: TableMarkers | null = null;
  let dice: ReturnType<typeof initDice> | null = null;
  // GM notes (docs/TABLE.md, "GM notes"): the page's Delve map for its notes and markers, the board's pins and note box
  const gmMap = gm ? createGmMap() : null;
  let roomNotes: RoomNotes | null = null;
  /** "Where you can go" over the board (GM, Delve pages with height areas): K or the top bar's Heights button. */
  let movementView: MovementView | null = null;
  let notesPanel: ReturnType<typeof initNotesPanel> | null = null;
  const msgListeners = new Set<(m: ServerMessage) => void>();

  // ---------- dynamic vision (vision-view.ts) ----------

  /** The last vision message for the page we look at; null: none (yet), or the page has no dynamic vision. */
  let vision: BoardVision | null = null;
  /** The picture follows the explored fog, but at most about once a second. */
  const BG_GAP_MS = 900;
  let bgLast = 0;
  let bgTimer: number | undefined;
  function reloadForFog(): void {
    if (bgTimer !== undefined) return;
    bgTimer = window.setTimeout(() => {
      bgTimer = undefined;
      bgLast = Date.now();
      board?.reloadBackground();
    }, reloadDelay(Date.now(), bgLast, BG_GAP_MS));
  }
  function onVision(pageId: string, v: Parameters<typeof mergeVision>[2]): void {
    if (!state || pageId !== state.view.pageId) return;
    const before = vision;
    vision = mergeVision(vision, pageId, v);
    board?.visionChanged();
    // players' pictures (and the GM's look as them) are cut to the explored fog: fetch it again when it grew
    if (before && vision && before.exploredVersion !== vision.exploredVersion && seeAs === 'players') reloadForFog();
    board?.update(); // the GM's look as the players shows the tokens the party sees
  }
  function toggleDoor(id: string): void {
    const p = page();
    const d = p?.doors?.find((x) => x.id === id);
    if (!p || !d) return;
    void act({ type: 'door.set', pageId: p.id, id, open: !doorIsOpen(p, d) });
  }

  function select(ids: string[]): void {
    selection = new Set(ids);
    board?.update();
    emit(['selection']);
  }

  // ---------- sending ----------

  function send(intent: Intent): Promise<number> {
    return conn.send(intent).done;
  }

  async function act(intent: Intent): Promise<boolean> {
    try {
      await send(intent);
    } catch (e) {
      toast((e as Error).message);
      return false;
    }
    // no event tells this tab where the players went, so note it from our own ack
    if (intent.type === 'page.activate' && state) {
      state = { ...state, view: { ...state.view, playerPageId: intent.id } };
      emit(['pages']);
      showBanner();
    }
    return true;
  }

  /** Move tokens now and tell the server; a refusal snaps them back. */
  function moveTokens(moves: { id: string; x: number; y: number }[]): void {
    for (const m of moves) {
      const { ref, done } = conn.send({ type: 'token.move', id: m.id, x: m.x, y: m.y });
      opt.set(m.id, { x: m.x, y: m.y, ref });
      done
        .then((rev) => {
          if (state) ackOptimistic(opt, ref, rev, state.view.rev);
        })
        .catch((e: Error) => {
          failOptimistic(opt, ref);
          toast(e.message);
        })
        .finally(() => {
          board?.update();
          emit(['tokens']);
        });
    }
    board?.update();
    emit(['tokens']);
  }

  // ---------- receiving ----------

  function onMessage(msg: ServerMessage): void {
    handle(msg);
    for (const f of [...msgListeners]) f(msg);
  }

  function handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'hello': {
        const again = state !== null && state.view.pageId === msg.view.pageId;
        state = { view: msg.view, chat: msg.chat };
        vision = null; // a vision message follows on a dynamic page; until then players see darkness
        board?.visionChanged();
        opt.clear();
        selection = new Set([...selection].filter((id) => msg.view.tokens.some((t) => t.id === id)));
        board?.setPage(page(), again); // a reconnect fetches the picture again: the map may have changed meanwhile
        gmMap?.setPage(page(), true);
        tableMarkers?.pageChanged(page());
        roomNotes?.update();
        board?.update();
        showHeader();
        showBanner();
        emit(['all']);
        break;
      }
      case 'events': {
        if (!state) return;
        const changes = new Set<Change>();
        let reload = false;
        const rolled: ChatMessage[] = [];
        for (const ev of msg.events) {
          const before = page();
          if (ev.type === 'chat' && ev.message.rolls?.length && !state.chat.some((m) => m.id === ev.message.id)) rolled.push(ev.message);
          state = reduce(state, ev);
          changes.add(CHANGE[ev.type]);
          if (ev.type === 'game' && ev.playerPageId) changes.add('pages');
          if (ev.type === 'page.upsert' && ev.page.id === state.view.pageId && needsReload(before, ev.page)) reload = true;
        }
        state = { ...state, view: { ...state.view, rev: Math.max(state.view.rev, msg.rev) } };
        settleOptimistic(opt, state.view.rev);
        const ids = new Set(state.view.tokens.map((t) => t.id));
        if ([...selection].some((id) => !ids.has(id))) {
          selection = new Set([...selection].filter((id) => ids.has(id)));
          changes.add('selection');
        }
        if (changes.has('pages')) {
          board?.setPage(page(), reload);
          // the page sent again: its Delve map (or the door state) changed, so fetch the map's notes and markers again
          gmMap?.setPage(page(), msg.events.some((ev) => ev.type === 'page.upsert' && ev.page.id === state?.view.pageId));
          tableMarkers?.pageChanged(page());
          roomNotes?.update();
        }
        board?.update();
        if (changes.has('game') || changes.has('members')) showHeader();
        if (changes.has('pages') || changes.has('game')) showBanner();
        emit(changes);
        for (const m of rolled) dice?.message(m); // only live rolls: a hello's backlog throws nothing
        break;
      }
      case 'vision':
        onVision(msg.pageId, msg.vision);
        break;
      case 'map.notes':
        // only notes changed (no picture did): fetch them, leave the picture alone
        if (gmMap && msg.mapId === gmMap.mapId()) void gmMap.reload();
        break;
      case 'error':
        if (msg.ref === undefined) toast(msg.error);
        break;
      case 'ping':
        // the server echoes our own pings; those were drawn when we made them
        if (state && msg.pageId === state.view.pageId && msg.from !== me().id) board?.showPing(msg.x, msg.y, msg.color);
        break;
      default:
        break;
    }
  }

  // ---------- header, banner, connection ----------

  const ui = {
    name: $('game-name'),
    dot: $('conn-dot'),
    conn: $('conn-text'),
    meName: $('me-name'),
    meDot: $('me-dot'),
    banner: $('page-banner'),
    note: $('board-note'),
    sideToggle: $<HTMLButtonElement>('side-toggle'),
    sideBadge: $('side-badge'),
    chatBadge: $('chat-badge'),
  };

  function showHeader(): void {
    const v = state?.view;
    if (!v) return;
    ui.name.textContent = v.name;
    document.title = `${v.name} · Delve Table`;
    ui.meName.textContent = v.you.name;
    ui.meDot.style.setProperty('--c', v.you.color);
  }

  function showBanner(): void {
    const v = state?.view;
    const p = page();
    const kids: HTMLElement[] = [];
    if (p) kids.push(Object.assign(document.createElement('span'), { textContent: p.name }));
    if (gm && p?.background.kind === 'delve') {
      // the GM sees the whole map (fog dimmed, room numbers, notes); one click shows it as the players do
      const b = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'see-as',
        textContent: seeAs === 'gm' ? 'GM view' : "Players' view",
        title: seeAs === 'gm' ? "Showing the whole map, unrevealed parts dimmed. Click to see what the players see." : 'Showing what the players see. Click for the whole map.',
      });
      b.addEventListener('click', () => {
        seeAs = seeAs === 'gm' ? 'players' : 'gm';
        board?.setPage(page(), true); // same page, other picture
        board?.visionChanged(); // the players' darkness, or the GM's hint of it
        tableMarkers?.pageChanged(page());
        roomNotes?.update(); // no note pins in the players' view
        movementView?.update(); // nor the movement overlay
        notesPanel?.roomsChanged();
        board?.update();
        showBanner();
      });
      kids.push(b);
      if (seeAs === 'gm' && roomNotes) {
        // Notes mode: a click on a room's floor opens its GM notes (pins open them any time)
        const on = roomNotes.mode();
        const n = Object.assign(document.createElement('button'), {
          type: 'button',
          className: 'see-as notes-mode',
          textContent: on ? 'Notes: on' : 'Notes',
          title: on ? 'Click a room, corridor or terrain to read and write its GM notes. Click here (or N, Esc) to stop.' : 'Notes mode (N): click a room to read and write its GM notes. Rooms with notes have a pin.',
        });
        n.setAttribute('aria-pressed', String(on));
        n.addEventListener('click', () => roomNotes?.setMode(!roomNotes.mode()));
        kids.push(n);
      }
    }
    if (gm && seeAs === 'gm' && movementView?.available()) {
      const on = movementView.on();
      const mv = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'see-as movement-mode',
        textContent: on ? 'Heights: on' : 'Heights',
        title: on ? 'Where you can go: red dashes are cliff edges nobody can walk over, green the stairs, ladders and slopes. Click (or K) to hide.' : 'Show where you can go (K): the height areas, which edges block, where stairs cross.',
      });
      mv.setAttribute('aria-pressed', String(on));
      mv.addEventListener('click', () => {
        movementView?.toggle();
        showBanner();
      });
      kids.push(mv);
    }
    if (v && gm && v.playerPageId !== v.pageId) {
      const other = v.pages.find((x) => x.id === v.playerPageId);
      kids.push(Object.assign(document.createElement('span'), { className: 'players', textContent: `Players are on: ${other?.name ?? '?'}` }));
    }
    ui.banner.replaceChildren(...kids);
  }

  function showConn(s: ConnState, detail?: string): void {
    ui.dot.dataset.state = s;
    ui.conn.textContent = { live: 'Live', connecting: 'Connecting…', offline: 'Offline, retrying', closed: 'Disconnected' }[s];
    if (s === 'closed') {
      document.body.classList.add('closed');
      ui.note.replaceChildren(detail ?? 'The connection was closed.', document.createElement('br'));
      if (gm) ui.note.append(Object.assign(document.createElement('a'), { href: '/play', textContent: 'Back to all games' }));
      else ui.note.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Ask your GM for a new invite link.' }));
      ui.note.hidden = false;
    }
  }

  if (gm) {
    ui.name.addEventListener('click', () => {
      const cur = state?.view.name ?? initial.gameName;
      const name = prompt('Name of the game', cur)?.trim();
      if (name && name !== cur) void act({ type: 'game.rename', name });
    });
    const layerSel = $<HTMLSelectElement>('layer-select');
    layerSel.addEventListener('change', () => {
      layer = layerSel.value as Layer;
      select([]);
      emit(['layer']);
    });
  }

  // ---------- side panel and tabs ----------

  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  const panels = [...document.querySelectorAll<HTMLElement>('[data-panel]')];
  let activeTab = store.get<string>('delve-table-tab') ?? 'chat';
  if (!tabs.some((t) => t.dataset.tab === activeTab)) activeTab = 'chat';

  const sideOpen = () => (NARROW.matches ? document.body.classList.contains('sheet-open') : !document.body.classList.contains('side-closed'));
  const chatVisible = () => sideOpen() && activeTab === 'chat';

  function showTab(id: string): void {
    activeTab = id;
    store.set('delve-table-tab', id);
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.tab === id));
    for (const p of panels) p.hidden = p.dataset.panel !== id;
    if (chatVisible()) chat.seen();
  }
  for (const t of tabs) t.addEventListener('click', () => showTab(t.dataset.tab ?? 'chat'));

  function setSide(open: boolean): void {
    if (NARROW.matches) document.body.classList.toggle('sheet-open', open);
    else {
      document.body.classList.toggle('side-closed', !open);
      store.set('delve-table-side', open);
    }
    ui.sideToggle.setAttribute('aria-pressed', String(open));
    if (chatVisible()) chat.seen();
  }
  ui.sideToggle.addEventListener('click', () => setSide(!sideOpen()));
  document.body.classList.toggle('side-closed', store.get<boolean>('delve-table-side') === false);
  NARROW.addEventListener('change', () => ui.sideToggle.setAttribute('aria-pressed', String(sideOpen())));

  function showUnread(n: number): void {
    for (const b of [ui.chatBadge, ui.sideBadge]) {
      b.textContent = n > 99 ? '99+' : String(n);
      b.hidden = n === 0;
    }
  }

  // ---------- the context the panels work with ----------

  const ctx: TableCtx = {
    gameId: initial.gameId,
    me,
    state: () => state,
    page,
    tokens,
    selected: () => [...selection],
    select,
    layer: () => (gm ? layer : 'tokens'),
    send,
    act,
    board: () => board,
    openToken: (id) => openTokenDialog(ctx, id),
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onMessage(fn) {
      msgListeners.add(fn);
      return () => msgListeners.delete(fn);
    },
    seeAs: () => seeAs,
  };

  const chat = initChat(ctx, chatVisible, showUnread);
  dice = initDice(ctx, initial.version, $('stage'));
  initTurns(ctx);
  if (gm) {
    initPages(ctx);
    initLibrary(ctx);
    const centre = (t: Token): [number, number] => [t.x + t.w / 2, t.y + t.h / 2];
    notesPanel = initNotesPanel({
      gameId: initial.gameId,
      panel: $('panel-notes'),
      page,
      tokens,
      selected: () => [...selection],
      select,
      act,
      seeAs: () => seeAs,
      gmMap: gmMap!,
      openOnBoard: (id, at) => roomNotes?.open(id, at),
      notesMode: { get: () => roomNotes?.mode() ?? false, set: (on) => roomNotes?.setMode(on) },
      focus: (at) => board?.focus(at[0], at[1]),
      focusToken: (id) => {
        const t = tokens().find((x) => x.id === id);
        if (t) board?.focus(...centre(t));
      },
      where: 'board',
      on: ctx.on,
      onMessage: ctx.onMessage,
    });
  }
  initPlayers(ctx);
  showTab(activeTab);
  ui.sideToggle.setAttribute('aria-pressed', String(sideOpen()));

  // ---------- keyboard ----------

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable], dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
    const sel = tokens().filter((x) => selection.has(x.id));
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const arrow = arrows[e.key];
    if (e.key === '+' || e.key === '=') board?.zoom(1.25);
    else if (e.key === '-' || e.key === '_') board?.zoom(0.8);
    else if (e.key === 'f' || e.key === 'F') board?.fit();
    else if ((e.key === 'n' || e.key === 'N') && roomNotes && page()?.background.kind === 'delve' && seeAs === 'gm') roomNotes.setMode(!roomNotes.mode());
    else if ((e.key === 'k' || e.key === 'K') && movementView?.available() && seeAs === 'gm') {
      movementView.toggle();
      showBanner();
    }
    else if (e.key === 'Escape' && selection.size) select([]);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && gm && sel.length) void act({ type: 'token.delete', ids: sel.map((x) => x.id) });
    else if (arrow && sel.length) {
      const movable = sel.filter((x) => canMove(me(), x));
      if (!movable.length) return;
      moveTokens(movable.map((x) => ({ id: x.id, x: x.x + arrow[0], y: x.y + arrow[1] })));
    } else return;
    e.preventDefault();
  });

  // ---------- the board ----------

  $('zoom-in').addEventListener('click', () => board?.zoom(1.25));
  $('zoom-out').addEventListener('click', () => board?.zoom(0.8));
  $('fit').addEventListener('click', () => board?.fit());

  createBoard($('stage'), {
    me,
    page,
    // looking as the players do: GM-layer tokens are left out too, and on a dynamic page what the party doesn't see
    tokens: () => (gm && seeAs === 'players' ? previewTokens(tokens(), page(), vision) : tokens()),
    selection: () => selection,
    setSelection: select,
    activeLayer: () => ctx.layer(),
    move: moveTokens,
    open: (id) => openTokenDialog(ctx, id),
    ping(x, y) {
      const p = page();
      if (!p) return;
      conn.ping(p.id, x, y);
      board?.showPing(x, y, me().color);
    },
    backgroundView: () => seeAs,
    gameId: () => initial.gameId,
    vision: () => vision,
    toggleDoor,
  })
    .then((b) => {
      board = b;
      b.setPage(page(), false);
      if (gm && gmMap) {
        // markers first: their listener takes a click on a marker before the notes' one sees it
        tableMarkers = initTableMarkers({ stage: $('stage'), board: b, seeAs: () => seeAs, gmMap });
        tableMarkers.pageChanged(page());
        roomNotes = initRoomNotes({ stage: $('stage'), board: b, gmMap, page, seeAs: () => seeAs, tokens, me, layer: () => ctx.layer() });
        roomNotes.onChange(() => {
          showBanner();
          notesPanel?.roomsChanged();
        });
        roomNotes.update();
        movementView = initMovementView({ stage: $('stage'), board: b, gmMap, page, seeAs: () => seeAs });
        gmMap.onChange(() => showBanner()); // the Heights button shows once the map is in
        showBanner();
      }
      b.update();
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => b.retheme());
    })
    .catch((e: Error) => {
      ui.note.textContent = `This browser couldn't start the table's drawing (${e.message}). Chat and the panels still work; try another browser, or turn on hardware acceleration.`;
      ui.note.hidden = false;
    });

  const conn = connect(initial.gameId, { message: onMessage, state: showConn });
}
