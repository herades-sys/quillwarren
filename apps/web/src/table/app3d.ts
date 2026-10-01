// The 3D table view in the browser (/play/:gameId/3d): the same live game as the
// 2D table, over the same WebSocket (net.ts), with the same reducer, optimistic
// moves and intents (logic.ts), shown with three.js (view3d.ts). A move here shows
// on everyone's 2D table at once, and the other way round.
//
// The scene (walls, doors, stairs, the floor picture) comes from the server's
// scene3d.json, filtered for this member, and is fetched again whenever the page
// or its Delve map changes. Players follow the page the GM moves them to; the
// GM picks pages and can look as the players do.
//
// startTable3d returns a Table3dCtx for later panels (notes): addPanel() gives
// them a tab in the side panel.
import type { GameEvent, Intent, Member, Page, Scene3D, ServerMessage, Token } from '@delve/table';
import type { Change } from './ctx.ts';
import { $, api, h, store, toast } from './dom.ts';
import { ackOptimistic, canMove, failOptimistic, isGm, needsReload, reduce, settleOptimistic, withOptimistic, type Optimistic, type TableState } from './logic.ts';
import { connect, type ConnState } from './net.ts';
import { baseColor, followSubject, shownTokens } from './scene3d-logic.ts';
import { createView3d, type View3d } from './view3d.ts';
import { darknessPolygons, fogAlphas, mergeVision, previewTokens, reloadDelay, type BoardVision } from './vision-view.ts';

export interface Initial3d {
  gameId: string;
  gameName: string;
  me: { id: string; name: string; role: 'gm' | 'player' };
  version: string;
}

/** What the 3D view's panels get (the notes of step 3 plug in here). */
export interface Table3dCtx {
  gameId: string;
  me(): Member;
  state(): TableState | null;
  /** The page this member is looking at. */
  page(): Page | null;
  /** Tokens shown in 3D, optimistic moves included. */
  tokens(): Token[];
  /** The scene as last fetched (null while loading). */
  scene(): Scene3D | null;
  selected(): string[];
  select(ids: string[]): void;
  /** Send an intent and toast its error; true when it went through. */
  act(intent: Intent): Promise<boolean>;
  view(): View3d | null;
  /** A new tab in the side panel; returns the (empty) panel to fill. */
  addPanel(id: string, label: string): HTMLElement;
  /** Switch the side panel to a tab (and open the panel). */
  showPanel(id: string): void;
  /** The tab the side panel shows, or null when the panel is closed. */
  shownPanel(): string | null;
  /** The page's banner was rebuilt: add your own controls to it (GM notes' button). */
  onBanner(fn: (banner: HTMLElement) => void): void;
  on(fn: (c: Change) => void): () => void;
  /** Every message from the server, after the view has handled it. */
  onMessage(fn: (m: ServerMessage) => void): () => void;
  /** The GM's own view, or as the players see it (players: always). */
  seeAs(): 'gm' | 'players';
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
const KEY = { flat:'delve-table3d-flat', walls: 'delve-table3d-walls', shadows: 'delve-table3d-shadows', tab: 'delve-table3d-tab', side: 'delve-table3d-side' };

export function startTable3d(initial: Initial3d): Table3dCtx {
  let state: TableState | null = null;
  const opt = new Map<string, Optimistic>();
  let selection = new Set<string>();
  let view: View3d | null = null;
  let scene: Scene3D | null = null;
  let sceneSerial = 0;
  const listeners = new Set<(c: Change) => void>();
  const emit = (changes: Iterable<Change>) => {
    for (const c of new Set(changes)) for (const f of [...listeners]) f(c);
  };

  const gm = isGm(initial.me);
  const fallbackMe: Member = { ...initial.me, color: '#d4a017' };
  const me = (): Member => state?.view.you ?? fallbackMe;
  const members = (): Member[] => state?.view.members ?? [];
  const page = (): Page | null => (state ? (state.view.pages.find((p) => p.id === state!.view.pageId) ?? null) : null);
  /** The GM can look at a page as the players see it (their scene, no gm layer); like the 2D table, every load starts in the GM's view. */
  let seeAs: 'gm' | 'players' = gm ? 'gm' : 'players';
  /** The last vision message for the page we look at (dynamic vision); null: none, or the page has none. */
  let vision: BoardVision | null = null;
  const tokens = (): Token[] => {
    if (!state) return [];
    const list = withOptimistic(state.view.tokens, opt);
    // the GM looking as the players: on a dynamic page only what the party sees, like the 2D table
    return gm && seeAs === 'players' ? previewTokens(list, page(), vision) : shownTokens(list, seeAs);
  };
  let flat = store.get<boolean>(KEY.flat) ?? false;
  let wallH = store.get<number>(KEY.walls) ?? 0.9;
  let shadows = store.get<boolean>(KEY.shadows) ?? true;

  const ui = {
    name: $('game-name'),
    dot: $('conn-dot'),
    conn: $('conn-text'),
    meName: $('me-name'),
    meDot: $('me-dot'),
    banner: $('page-banner'),
    note: $('board-note'),
    status: $('status3d'),
    side: $('side'),
    tabs: $('tabs3d'),
    sideToggle: $<HTMLButtonElement>('side-toggle'),
    follow: $<HTMLButtonElement>('cam-follow'),
    flat: $<HTMLButtonElement>('cam-flat'),
  };

  function select(ids: string[]): void {
    selection = new Set(ids);
    // following one mini and picking another: follow that one
    if (view?.following() && ids.length === 1 && ids[0] !== view.following()) view.follow(ids[0]!);
    view?.update();
    showBanner();
    emit(['selection']);
  }

  // ---------- sending ----------

  async function act(intent: Intent): Promise<boolean> {
    try {
      await conn.send(intent).done;
    } catch (e) {
      toast((e as Error).message);
      return false;
    }
    if (intent.type === 'page.activate' && state) {
      state = { ...state, view: { ...state.view, playerPageId: intent.id } };
      showBanner();
      emit(['pages']);
    }
    return true;
  }

  /** Move minis now and tell the server; a refusal snaps them back (as on the 2D table). */
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
          view?.update();
          emit(['tokens']);
        });
    }
    view?.update();
    emit(['tokens']);
  }

  // ---------- the scene ----------

  async function loadScene(bust: number): Promise<void> {
    const p = page();
    const serial = ++sceneSerial;
    if (!p) {
      scene = null;
      view?.setScene(null, null, 0);
      return;
    }
    try {
      const s = await api<Scene3D>(`/api/v1/games/${encodeURIComponent(initial.gameId)}/pages/${encodeURIComponent(p.id)}/scene3d.json?view=${seeAs}`);
      if (serial !== sceneSerial) return;
      scene = s;
      view?.setScene(s, page(), bust);
      showDarkness();
      emit(['pages']);
    } catch (e) {
      if (serial !== sceneSerial) return;
      ui.status.hidden = false;
      ui.status.textContent = `This page didn't load in 3D: ${(e as Error).message}`;
    }
  }

  // ---------- dynamic vision (the server cuts the scene; this only draws the darkness) ----------

  /** The scene follows the explored fog, but at most about once a second. */
  const FOG_GAP_MS = 900;
  let fogLast = 0;
  let fogTimer: number | undefined;
  function reloadForFog(): void {
    if (fogTimer !== undefined) return;
    fogTimer = window.setTimeout(() => {
      fogTimer = undefined;
      fogLast = Date.now();
      void loadScene(Date.now());
    }, reloadDelay(Date.now(), fogLast, FOG_GAP_MS));
  }

  /** Dim what the party saw before but doesn't see now (unexplored ground isn't in the players' scene at all). */
  function showDarkness(): void {
    if (!view) return;
    const box = scene?.bounds;
    if (!vision || !box) return view.overlays.set('darkness', null);
    view.overlays.set('darkness', view.overlays.polygons(darknessPolygons(box, vision.visible), '#000000', fogAlphas(gm, seeAs).explored));
  }

  function onVision(pageId: string, v: Parameters<typeof mergeVision>[2]): void {
    if (!state || pageId !== state.view.pageId) return;
    const before = vision;
    vision = mergeVision(vision, pageId, v);
    // the players' scene (and the GM's look as them) is cut to the explored fog: fetch it again when it grew
    if (before && vision && before.exploredVersion !== vision.exploredVersion && seeAs === 'players') reloadForFog();
    showDarkness();
    view?.update();
    emit(['tokens']);
  }

  // ---------- receiving ----------

  const msgListeners = new Set<(m: ServerMessage) => void>();
  function onMessage(msg: ServerMessage): void {
    handle(msg);
    for (const f of [...msgListeners]) f(msg);
  }

  function handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'hello': {
        state = { view: msg.view, chat: msg.chat };
        opt.clear();
        vision = null; // a vision message follows on a dynamic page
        showDarkness();
        selection = new Set([...selection].filter((id) => msg.view.tokens.some((t) => t.id === id)));
        showHeader();
        showBanner();
        emit(['all']);
        // a reconnect fetches the scene again (the map may have changed meanwhile); a new page loads fresh
        void loadScene(scene?.pageId === msg.view.pageId ? Date.now() : 0);
        view?.update();
        break;
      }
      case 'events': {
        if (!state) return;
        const changes = new Set<Change>();
        let reload = false;
        let cosmetic = false;
        for (const ev of msg.events) {
          const before = page();
          state = reduce(state, ev);
          changes.add(CHANGE[ev.type]);
          if (ev.type === 'game' && ev.playerPageId) changes.add('pages');
          if (ev.type === 'page.upsert' && ev.page.id === state.view.pageId) {
            if (needsReload(before, ev.page)) reload = true;
            else cosmetic = true;
          }
        }
        state = { ...state, view: { ...state.view, rev: Math.max(state.view.rev, msg.rev) } };
        settleOptimistic(opt, state.view.rev);
        const ids = new Set(state.view.tokens.map((t) => t.id));
        if ([...selection].some((id) => !ids.has(id))) {
          selection = new Set([...selection].filter((id) => ids.has(id)));
          changes.add('selection');
        }
        // the Delve map behind the page changed (a room revealed, a door moved): new geometry and picture
        if (reload) void loadScene(Date.now());
        else if (cosmetic && scene) view?.setScene(scene, page(), 0);
        view?.update();
        if (changes.has('game') || changes.has('members')) showHeader();
        if (changes.has('pages') || changes.has('game') || changes.has('tokens')) showBanner();
        emit(changes);
        break;
      }
      case 'error':
        if (msg.ref === undefined) toast(msg.error);
        break;
      case 'ping':
        if (state && msg.pageId === state.view.pageId && msg.from !== me().id) view?.showPing(msg.x, msg.y, msg.color);
        break;
      case 'vision':
        onVision(msg.pageId, msg.vision);
        break;
      default:
        break;
    }
  }

  // ---------- header, banner, connection ----------

  function showHeader(): void {
    const v = state?.view;
    if (!v) return;
    ui.name.textContent = v.name;
    document.title = `${v.name} in 3D · Delve Table`;
    ui.meName.textContent = v.you.name;
    ui.meDot.style.setProperty('--c', v.you.color);
  }

  let bannerKey = '';
  const bannerHooks: ((banner: HTMLElement) => void)[] = [];
  function showBanner(): void {
    const v = state?.view;
    const p = page();
    const f = view?.following();
    const ft = f ? tokens().find((t) => t.id === f) : undefined;
    // rebuilt only when what it shows changes, so an open page picker isn't closed by a mini moving
    const key = JSON.stringify([v?.pages.map((x) => [x.id, x.name]), v?.pageId, v?.playerPageId, p?.background.kind, seeAs, ft?.id, ft?.name]);
    if (key === bannerKey) return;
    bannerKey = key;
    const kids: HTMLElement[] = [];
    if (v && gm && v.pages.length > 1) {
      // the GM's page picker: the same as switching pages on the 2D table (page.view)
      const sel = h('select', { 'aria-label': 'Page', title: 'The page you look at (players stay where they are)' });
      for (const pg of v.pages) sel.append(h('option', { value: pg.id, selected: pg.id === v.pageId }, pg.id === v.playerPageId ? `${pg.name} ★` : pg.name));
      sel.addEventListener('change', () => void act({ type: 'page.view', id: sel.value }));
      kids.push(sel);
    } else if (p) kids.push(h('span', {}, p.name));
    if (gm && p) {
      const delve = p.background.kind === 'delve';
      kids.push(
        h(
          'button',
          {
            type: 'button',
            class: 'see-as',
            title:
              seeAs === 'gm'
                ? `Showing everything${delve ? ' (the whole map)' : ''}. Click to see what the players see${delve ? ' (their walls, their picture)' : ' (no GM-only minis)'}.`
                : 'Showing what the players see. Click for the GM’s view.',
            onclick: () => {
              seeAs = seeAs === 'gm' ? 'players' : 'gm';
              void loadScene(0);
              showDarkness();
              view?.update();
              showBanner();
              emit(['tokens']);
            },
          },
          seeAs === 'gm' ? 'GM view' : "Players' view",
        ),
      );
    }
    if (v && gm && v.playerPageId !== v.pageId) {
      const other = v.pages.find((x) => x.id === v.playerPageId);
      kids.push(h('span', { class: 'players' }, `Players are on: ${other?.name ?? '?'}`));
      kids.push(h('button', { type: 'button', title: 'Move the players to this page', onclick: () => p && void act({ type: 'page.activate', id: p.id }) }, 'Bring them here'));
    }
    if (ft) kids.push(h('button', { type: 'button', class: 'follow', title: 'Stop following', onclick: () => setFollow(null) }, `Following ${ft.name?.trim() || 'mini'} ×`));
    ui.banner.replaceChildren(...kids);
    for (const f of bannerHooks) f(ui.banner);
  }

  function showConn(s: ConnState, detail?: string): void {
    ui.dot.dataset.state = s;
    ui.conn.textContent = { live: 'Live', connecting: 'Connecting…', offline: 'Offline, retrying', closed: 'Disconnected' }[s];
    if (s === 'closed') {
      document.body.classList.add('closed');
      ui.note.replaceChildren(detail ?? 'The connection was closed.', document.createElement('br'));
      if (gm) ui.note.append(h('a', { href: '/play' }, 'Back to all games'));
      else ui.note.append(h('span', { class: 'muted' }, 'Ask your GM for a new invite link.'));
      ui.note.hidden = false;
    }
  }

  // ---------- side panel ----------

  const panels = new Map<string, { tab: HTMLButtonElement; panel: HTMLElement }>();
  let activeTab = store.get<string>(KEY.tab) ?? 'minis';
  // the tab picked last time, even while it isn't added yet (the Notes tab comes after the view's own)
  let wantedTab = activeTab;

  function showTab(id: string, remember = true): void {
    if (!panels.has(id)) id = panels.keys().next().value ?? id;
    activeTab = id;
    if (remember) {
      wantedTab = id;
      store.set(KEY.tab, id);
    }
    for (const [k, p] of panels) {
      p.tab.setAttribute('aria-selected', String(k === id));
      p.panel.hidden = k !== id;
    }
  }

  function addPanel(id: string, label: string): HTMLElement {
    const tab = h('button', { type: 'button', role: 'tab', id: `tab-${id}`, 'aria-controls': `panel-${id}`, 'aria-selected': 'false', onclick: () => showTab(id) }, label);
    const panel = h('section', { class: 'panel', id: `panel-${id}`, role: 'tabpanel', 'aria-labelledby': `tab-${id}`, hidden: true });
    ui.tabs.append(tab);
    ui.side.append(panel);
    panels.set(id, { tab, panel });
    if (panels.has(wantedTab)) showTab(wantedTab);
    else showTab(panels.has(activeTab) ? activeTab : (panels.keys().next().value ?? id), false);
    return panel;
  }

  const sideOpen = () => (NARROW.matches ? document.body.classList.contains('sheet-open') : !document.body.classList.contains('side-closed'));
  function setSide(open: boolean): void {
    if (NARROW.matches) document.body.classList.toggle('sheet-open', open);
    else {
      document.body.classList.toggle('side-closed', !open);
      store.set(KEY.side, open);
    }
    ui.sideToggle.setAttribute('aria-pressed', String(open));
  }
  ui.sideToggle.addEventListener('click', () => setSide(!sideOpen()));
  document.body.classList.toggle('side-closed', store.get<boolean>(KEY.side) === false);
  NARROW.addEventListener('change', () => ui.sideToggle.setAttribute('aria-pressed', String(sideOpen())));
  ui.sideToggle.setAttribute('aria-pressed', String(sideOpen()));

  // the minis on this page: select, find, follow
  const minisPanel = addPanel('minis', 'Minis');
  let minisKey = '';
  function drawMinis(): void {
    const list = tokens().filter((t) => t.layer !== 'map');
    const mem = members();
    // positions aren't shown: a mini moving doesn't rebuild the list (and the button under the pointer)
    const key = JSON.stringify([list.map((t) => [t.id, t.name, t.image, t.layer, t.controlledBy, selection.has(t.id)]), mem.map((m) => [m.id, m.name, m.color]), canMoveAny()]);
    if (key === minisKey) return;
    minisKey = key;
    const kids: HTMLElement[] = [h('h3', {}, 'On this page')];
    if (!list.length) {
      kids.push(h('p', { class: 'empty' }, gm ? 'No minis yet. Add characters from the 2D table’s Tokens tab; they show up here at once.' : 'No minis on this page yet.'));
    } else {
      const ul = h('ul', { class: 'list' });
      for (const t of list) {
        const dot = h('span', { class: 'swatch' });
        dot.style.setProperty('--c', baseColor(t, mem));
        const who = t.controlledBy.includes('all') ? 'everyone' : t.controlledBy.map((id) => mem.find((m) => m.id === id)?.name).filter(Boolean).join(', ');
        ul.append(
          h(
            'li',
            { class: selection.has(t.id) ? 'selected' : '' },
            h('img', { src: t.image, alt: '', loading: 'lazy' }),
            dot,
            h('button', { type: 'button', class: 'grow', title: 'Select and look at it', onclick: () => (select([t.id]), view?.focusToken(t.id)) }, t.name?.trim() || 'Unnamed'),
            t.layer === 'gm' ? h('span', { class: 'tag' }, 'GM only') : who ? h('span', { class: 'tag', title: 'Controlled by' }, who) : null,
            h('button', { type: 'button', class: 'btn small', title: 'Keep it in the middle of the view', onclick: () => (select([t.id]), setFollow(t.id)) }, 'Follow'),
          ),
        );
      }
      kids.push(ul);
    }
    kids.push(h('p', { class: 'hint' }, canMoveAny() ? 'Drag a mini to move it (snaps to the grid; hold Alt to place it freely). Arrow keys move the selected one.' : 'You can move the minis you control.'));
    minisPanel.replaceChildren(...kids);
  }
  const canMoveAny = () => tokens().some((t) => canMove(me(), t) && t.layer !== 'map');

  // settings of the view (kept per browser)
  const viewPanel = addPanel('view', 'View');
  {
    const walls = h('input', { type: 'range', min: '0', max: '2.5', step: '0.1', value: String(wallH), 'aria-label': 'Wall height' });
    walls.addEventListener('input', () => {
      wallH = Number(walls.value);
      store.set(KEY.walls, wallH);
      view?.setWallHeight(wallH);
    });
    const flatBox = h('input', { type: 'checkbox', checked: flat });
    flatBox.addEventListener('change', () => setFlat(flatBox.checked));
    const shadowBox = h('input', { type: 'checkbox', checked: shadows });
    shadowBox.addEventListener('change', () => {
      shadows = shadowBox.checked;
      store.set(KEY.shadows, shadows);
      view?.setShadows(shadows);
    });
    ui.flat.addEventListener('click', () => {
      setFlat(!flat);
      flatBox.checked = flat;
    });
    viewPanel.append(
      h('h3', {}, 'View'),
      h('label', { class: 'slider' }, 'Wall height', walls),
      h('label', { class: 'check' }, flatBox, 'Flat minis (discs seen from above)'),
      h('label', { class: 'check' }, shadowBox, 'Shadows'),
      h('p', { class: 'hint' }, 'Drag to turn the view, right-drag or Shift-drag to pan, scroll or pinch to zoom. Top looks straight down, Fit shows the whole page, Follow keeps the selected mini in the middle. Double-click a mini to look at it; hold still on the floor to ping.'),
    );
  }

  function setFlat(on: boolean): void {
    flat = on;
    store.set(KEY.flat, flat);
    ui.flat.setAttribute('aria-pressed', String(flat));
    view?.setFlat(flat);
  }
  ui.flat.setAttribute('aria-pressed', String(flat));

  function setFollow(id: string | null): void {
    view?.follow(id);
    ui.follow.setAttribute('aria-pressed', String(id !== null));
    showBanner();
  }
  ui.follow.addEventListener('click', () => {
    if (view?.following()) return setFollow(null);
    const id = followSubject(tokens(), selection, me());
    if (!id) return toast('Select a mini to follow first.', 'info');
    if (!selection.has(id)) select([id]);
    setFollow(id);
  });
  $('cam-top').addEventListener('click', () => view?.top());
  $('cam-fit').addEventListener('click', () => view?.fit());

  const redrawMinis = (c: Change) => {
    if (c === 'all' || c === 'tokens' || c === 'selection' || c === 'members' || c === 'pages') drawMinis();
  };
  listeners.add(redrawMinis);
  drawMinis();

  // ---------- keyboard ----------

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable], dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const arrow = arrows[e.key];
    if (e.key === 'f' || e.key === 'F') view?.fit();
    else if (e.key === 't' || e.key === 'T') view?.top();
    else if (e.key === 'l' || e.key === 'L') ui.follow.click();
    else if (e.key === 'Escape' && selection.size) select([]);
    else if (arrow && selection.size) {
      const movable = tokens().filter((x) => selection.has(x.id) && canMove(me(), x));
      if (!movable.length) return;
      moveTokens(movable.map((x) => ({ id: x.id, x: x.x + arrow[0], y: x.y + arrow[1] })));
    } else return;
    e.preventDefault();
  });

  // ---------- the view ----------

  try {
    view = createView3d($('stage'), $('tags3d'), {
      me,
      members,
      tokens,
      selection: () => selection,
      setSelection: select,
      move: moveTokens,
      ping(x, y) {
        const p = page();
        if (!p) return;
        conn.ping(p.id, x, y);
        view?.showPing(x, y, me().color);
      },
      followEnded: () => setFollow(null),
    });
    view.setFlat(flat);
    view.setWallHeight(wallH);
    view.setShadows(shadows);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => view?.retheme());
  } catch (e) {
    ui.status.hidden = true;
    ui.note.replaceChildren(
      `This browser couldn't start the 3D view (${(e as Error).message}). Try another browser, or turn on hardware acceleration. `,
      h('a', { href: `/play/${encodeURIComponent(initial.gameId)}` }, 'Open the 2D table'),
    );
    ui.note.hidden = false;
  }

  const conn = connect(initial.gameId, { message: onMessage, state: showConn });

  return {
    gameId: initial.gameId,
    me,
    state: () => state,
    page,
    tokens,
    scene: () => scene,
    selected: () => [...selection],
    select,
    act,
    view: () => view,
    addPanel,
    showPanel(id) {
      if (!sideOpen()) setSide(true);
      showTab(id);
    },
    shownPanel: () => (sideOpen() ? activeTab : null),
    onBanner(fn) {
      bannerHooks.push(fn);
      fn(ui.banner);
    },
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
}
