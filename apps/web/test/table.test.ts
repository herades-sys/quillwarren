import type { ChatMessage, GameView, Member, Page, RollResult, Token } from '@delve/table';
import { describe, expect, it } from 'vitest';
import {
  ackOptimistic,
  backgroundBox,
  backgroundUrl,
  backoff,
  barFraction,
  canEndTurn,
  canMove,
  cardRolls,
  changed,
  dragTargets,
  drawOrder,
  editLevel,
  failOptimistic,
  fitCamera,
  gridLines,
  gridStep,
  historyStep,
  hits,
  messageView,
  needsReload,
  num,
  pageBox,
  placeAt,
  reduce,
  rollBreakdown,
  rollFlags,
  rollView,
  segments,
  selectable,
  settleOptimistic,
  showsText,
  snap,
  toScreen,
  toWorld,
  tokenAt,
  visibleBox,
  withOptimistic,
  zoomAt,
  type Optimistic,
  type TableState,
} from '../src/table/logic.ts';

const gm: Member = { id: 'gm', name: 'GM', role: 'gm', color: '#d4a017' };
const ana: Member = { id: 'p1', name: 'Ana', role: 'player', color: '#e05252' };
const bo: Member = { id: 'p2', name: 'Bo', role: 'player', color: '#4f8fe0' };

const tok = (id: string, o: Partial<Token> = {}): Token => ({ id, pageId: 'pg1', layer: 'tokens', x: 0, y: 0, w: 1, h: 1, image: '/x.png', controlledBy: [], ...o });

const page: Page = {
  id: 'pg1',
  name: 'Crypt',
  width: 20,
  height: 10,
  origin: [-2, -1],
  cellPx: 70,
  cellUnit: '5 ft',
  showGrid: true,
  background: { kind: 'delve', mapId: 'm 1' },
};

const view = (o: Partial<GameView> = {}): GameView => ({
  id: 'g1',
  name: 'Game',
  rev: 5,
  you: ana,
  members: [gm, ana, bo],
  pages: [page],
  playerPageId: 'pg1',
  pageId: 'pg1',
  tokens: [tok('t1', { controlledBy: ['p1'] }), tok('t2')],
  turn: null,
  ...o,
});

const msg = (o: Partial<ChatMessage>): ChatMessage => ({ id: 'c1', seq: 1, at: 0, from: 'p1', speaker: 'Ana', kind: 'chat', text: '', ...o });

// 4d6kh3 + 2 with a 1 dropped, and a 1d20 that came up 20
const statRoll: RollResult = {
  expr: '4d6kh3+2',
  total: 16,
  terms: [
    { kind: 'dice', text: '4d6kh3', count: 4, sides: 6, value: 14, dice: [{ value: 6 }, { value: 5 }, { value: 3 }, { value: 1, dropped: true }] },
    { kind: 'op', op: '+' },
    { kind: 'number', value: 2 },
  ],
};
const nat20: RollResult = { expr: '1d20', total: 20, terms: [{ kind: 'dice', text: '1d20', count: 1, sides: 20, value: 20, dice: [{ value: 20 }] }] };

describe('camera', () => {
  it('converts between world cells and screen pixels', () => {
    const c = { x: 100, y: 50, scale: 40 };
    expect(toScreen(c, 2, 3)).toEqual([180, 170]);
    expect(toWorld(c, 180, 170)).toEqual([2, 3]);
  });

  it('zooms at the cursor, keeping the point under it fixed, and clamps', () => {
    const c = { x: 10, y: 20, scale: 40 };
    const z = zoomAt(c, 300, 200, 2);
    expect(z.scale).toBe(80);
    expect(toWorld(z, 300, 200)).toEqual(toWorld(c, 300, 200));
    expect(zoomAt(c, 0, 0, 1000).scale).toBe(360);
    expect(zoomAt(c, 0, 0, 0.0001).scale).toBe(4);
  });

  it('fits a box into the viewport, centred', () => {
    const c = fitCamera({ x0: 0, y0: 0, x1: 20, y1: 10 }, 1000, 600, 0);
    expect(c.scale).toBe(50);
    expect(toScreen(c, 10, 5)).toEqual([500, 300]);
    const v = visibleBox(c, 1000, 600);
    expect(v.x0).toBeCloseTo(0);
    expect(v.x1).toBeCloseTo(20);
  });
});

describe('pages', () => {
  it('builds the Delve background URL (players or GM, fogged, in the page frame) and its box', () => {
    expect(backgroundUrl(page)).toBe(`/api/v1/maps/m%201/render.png?view=players&ppg=70&fog=1&grid=0&frame=${page.origin[0]},${page.origin[1]},${page.origin[0] + page.width},${page.origin[1] + page.height}`);
    expect(backgroundUrl(page, 0, 'gm')).toContain('/render.png?view=gm&');
    expect(backgroundUrl(page, 5, 'players', 'g1')).toBe(`/api/v1/games/g1/pages/${page.id}/background.png?view=players&v=5`);
    expect(backgroundUrl(page, 123)).toMatch(/&v=123$/);
    expect(backgroundBox(page, 1400, 700)).toEqual({ x0: -2, y0: -1, x1: 18, y1: 9 });
    const img: Page = { ...page, background: { kind: 'image', url: '/api/v1/games/g1/assets/a.png', w: 12, h: 8 } };
    expect(backgroundUrl(img)).toBe('/api/v1/games/g1/assets/a.png');
    expect(backgroundBox(img, 999, 999)).toEqual({ x0: -2, y0: -1, x1: 10, y1: 7 });
    expect(backgroundUrl({ ...page, background: { kind: 'none' } })).toBeNull();
  });

  it('draws grid lines on whole cells inside the page and the view', () => {
    const b = pageBox(page);
    expect(b).toEqual({ x0: -2, y0: -1, x1: 18, y1: 9 });
    const { xs, ys } = gridLines(b, { x0: -0.5, y0: -5, x1: 3.2, y1: 2.5 }, 1);
    expect(xs).toEqual([0, 1, 2, 3]);
    expect(ys).toEqual([-1, 0, 1, 2]);
    expect(gridLines(b, { x0: 30, y0: 0, x1: 40, y1: 5 }, 1).xs).toEqual([]);
    expect(gridStep(40)).toBe(1);
    expect(gridStep(4)).toBe(5);
    expect(gridStep(1)).toBe(25);
  });

  it('reloads the background unless only the name, grid or unit changed', () => {
    expect(needsReload(page, { ...page, name: 'Crypt 2' })).toBe(false);
    expect(needsReload(page, { ...page, showGrid: false })).toBe(false);
    expect(needsReload(page, { ...page })).toBe(true); // same page sent again: the map behind it changed
    expect(needsReload(page, { ...page, width: 30 })).toBe(true);
    expect(needsReload(null, page)).toBe(false);
  });
});

describe('tokens', () => {
  it('snaps top-left corners to cells, or to the size for small tokens', () => {
    expect(snap(2.4, 1)).toBe(2);
    expect(snap(2.6, 2)).toBe(3);
    expect(snap(2.3, 0.5)).toBe(2.5);
    expect(snap(-0.4, 1)).toBe(0);
  });

  it('moves a group with the lead snapped and the offsets kept; Alt moves freely', () => {
    const starts = [
      { id: 'a', x: 1, y: 1, w: 1, h: 1 },
      { id: 'b', x: 3.5, y: 1, w: 1, h: 1 },
    ];
    expect(dragTargets(starts, 'a', 1.3, 0.6, false)).toEqual([
      { id: 'a', x: 2, y: 2 },
      { id: 'b', x: 4.5, y: 2 },
    ]);
    expect(dragTargets(starts, 'a', 1.3, 0.6, true)).toEqual([
      { id: 'a', x: 2.3, y: 1.6 },
      { id: 'b', x: 4.8, y: 1.6 },
    ]);
    expect(placeAt(5, 5, 2, 2)).toEqual({ x: 4, y: 4 });
  });

  it('hit-tests topmost first, by layer, and follows rotation', () => {
    const list = [tok('gm1', { layer: 'gm', x: 0, y: 0, w: 2, h: 2 }), tok('a', { x: 0, y: 0 }), tok('m', { layer: 'map', x: 0, y: 0, w: 4, h: 4 })];
    expect(drawOrder(list).map((t) => t.id)).toEqual(['m', 'a', 'gm1']);
    expect(tokenAt(list, 0.5, 0.5)?.id).toBe('gm1');
    expect(tokenAt(list, 0.5, 0.5, (t) => t.layer !== 'gm')?.id).toBe('a');
    expect(tokenAt(list, 3.5, 3.5)?.id).toBe('m');
    expect(tokenAt(list, 9, 9)).toBeNull();
    const long = tok('long', { x: 0, y: 0, w: 4, h: 1 });
    expect(hits(long, 3.5, 0.5)).toBe(true);
    expect(hits({ ...long, rotation: 90 }, 3.5, 0.5)).toBe(false);
    expect(hits({ ...long, rotation: 90 }, 2, 2)).toBe(true);
  });

  it('fills bars from value/max', () => {
    expect(barFraction({ value: 5, max: 10 })).toBe(0.5);
    expect(barFraction({ value: 15, max: 10 })).toBe(1);
    expect(barFraction({ value: -3, max: 10 })).toBe(0);
    expect(barFraction({ value: 3 })).toBeNull();
  });
});

describe('what the UI lets a member try', () => {
  it('lets the GM move everything and players only their own tokens-layer tokens', () => {
    const own = tok('t1', { controlledBy: ['p1'] });
    const everyone = tok('t2', { controlledBy: ['all'] });
    const ownMap = tok('t3', { controlledBy: ['p1'], layer: 'map' });
    expect(canMove(gm, ownMap)).toBe(true);
    expect(canMove(ana, own)).toBe(true);
    expect(canMove(bo, own)).toBe(false);
    expect(canMove(bo, everyone)).toBe(true);
    expect(canMove(ana, ownMap)).toBe(false);
    expect(editLevel(gm, own)).toBe('full');
    expect(editLevel(ana, own)).toBe('limited');
    expect(editLevel(bo, own)).toBe('none');
    expect(selectable(gm, 'map')(ownMap)).toBe(true);
    expect(selectable(gm, 'tokens')(ownMap)).toBe(false);
    expect(selectable(ana, 'map')(own)).toBe(true);
  });

  it('lets a player end the turn only when it is their token', () => {
    const turn = { entries: [{ id: 'e1', tokenId: 't1', name: 'Ana', initiative: 15 }, { id: 'e2', name: 'Goblin', initiative: 12 }], current: 0, round: 1, visible: true };
    const tokens = [tok('t1', { controlledBy: ['p1'] })];
    expect(canEndTurn(ana, turn, tokens)).toBe(true);
    expect(canEndTurn(bo, turn, tokens)).toBe(false);
    expect(canEndTurn(ana, { ...turn, current: 1 }, tokens)).toBe(false);
    expect(canEndTurn(gm, { ...turn, current: 1 }, tokens)).toBe(true);
    expect(canEndTurn(gm, null, tokens)).toBe(false);
  });
});

describe('the local view', () => {
  const s0: TableState = { view: view(), chat: [] };

  it('applies token, page, turn, member and game events', () => {
    let s = reduce(s0, { type: 'token.upsert', token: tok('t3', { x: 4 }) });
    expect(s.view.tokens.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    s = reduce(s, { type: 'token.upsert', token: tok('t1', { x: 9, controlledBy: ['p1'] }) });
    expect(s.view.tokens.find((t) => t.id === 't1')?.x).toBe(9);
    expect(s.view.tokens.map((t) => t.id)).toEqual(['t1', 't2', 't3']); // order kept
    s = reduce(s, { type: 'token.upsert', token: tok('t2', { pageId: 'pg2' }) }); // moved to another page
    expect(s.view.tokens.map((t) => t.id)).toEqual(['t1', 't3']);
    s = reduce(s, { type: 'token.remove', ids: ['t3'] });
    expect(s.view.tokens.map((t) => t.id)).toEqual(['t1']);
    s = reduce(s, { type: 'page.upsert', page: { ...page, name: 'Renamed' } });
    expect(s.view.pages[0]?.name).toBe('Renamed');
    s = reduce(s, { type: 'turn', turn: { entries: [], current: 0, round: 2, visible: true } });
    expect(s.view.turn?.round).toBe(2);
    s = reduce(s, { type: 'members', members: [gm, { ...ana, name: 'Anabel' }] });
    expect(s.view.you.name).toBe('Anabel');
    s = reduce(s, { type: 'game', name: 'New name', playerPageId: 'pg2' });
    expect(s.view.name).toBe('New name');
    expect(s.view.playerPageId).toBe('pg2');
    s = reduce(s, { type: 'page.switch', pageId: 'pg2' });
    expect(s.view.pageId).toBe('pg2');
    expect(s.view.tokens).toEqual([]);
    expect(s0.view.tokens).toHaveLength(2); // the old state is untouched
  });

  it('appends chat once per message id', () => {
    const m = msg({ id: 'c9', text: 'hi' });
    let s = reduce(s0, { type: 'chat', message: m });
    s = reduce(s, { type: 'chat', message: m });
    expect(s.chat).toHaveLength(1);
  });

  it('keeps optimistic moves until the server has caught up, and drops refused ones', () => {
    const opt = new Map<string, Optimistic>([
      ['t1', { x: 5, y: 5, ref: 1 }],
      ['t2', { x: 7, y: 7, ref: 2 }],
    ]);
    expect(withOptimistic(s0.view.tokens, opt).map((t) => [t.x, t.y])).toEqual([
      [5, 5],
      [7, 7],
    ]);
    ackOptimistic(opt, 1, 7, 6); // acked at rev 7, but we've only seen rev 6
    expect(opt.get('t1')?.ackRev).toBe(7);
    settleOptimistic(opt, 6);
    expect(opt.has('t1')).toBe(true);
    settleOptimistic(opt, 7);
    expect(opt.has('t1')).toBe(false);
    ackOptimistic(opt, 2, 7, 8); // the event came first: gone right away
    expect(opt.has('t2')).toBe(false);
    opt.set('t1', { x: 1, y: 1, ref: 3 });
    failOptimistic(opt, 3);
    expect(opt.size).toBe(0);
  });

  it('backs off reconnects up to 15 s', () => {
    expect(backoff(0)).toBe(500);
    expect(backoff(3)).toBe(4000);
    expect(backoff(10)).toBe(15000);
    expect(backoff(1, 1)).toBe(1300);
  });

  it('steps through the input history, ending on the draft', () => {
    expect(historyStep(3, 3, -1)).toBe(2);
    expect(historyStep(3, 0, -1)).toBe(0);
    expect(historyStep(3, 2, 1)).toBe(3);
    expect(historyStep(3, 3, 1)).toBe(3);
  });
});

describe('chat and rolls', () => {
  it('splits text at inline roll markers', () => {
    expect(segments('I hit for {{roll:0}} and {{roll:1}}!', [statRoll, nat20])).toEqual([
      { kind: 'text', text: 'I hit for ' },
      { kind: 'roll', index: 0, roll: statRoll },
      { kind: 'text', text: ' and ' },
      { kind: 'roll', index: 1, roll: nat20 },
      { kind: 'text', text: '!' },
    ]);
    expect(segments('{{roll:3}}', [])).toEqual([{ kind: 'roll', index: 3, roll: null }]);
    expect(segments('plain')).toEqual([{ kind: 'text', text: 'plain' }]);
  });

  it('shows every die with dropped, max and min marked', () => {
    const v = rollView(statRoll);
    expect(v.total).toBe(16);
    const dice = v.terms[0]!.kind === 'dice' ? v.terms[0]!.dice : [];
    expect(dice.map((d) => [d.label, d.dropped, d.max, d.min])).toEqual([
      ['6', false, true, false],
      ['5', false, false, false],
      ['3', false, false, false],
      ['1', true, false, true],
    ]);
    expect(v.terms.slice(1)).toEqual([
      { kind: 'op', text: '+' },
      { kind: 'number', text: '2' },
    ]);
    expect(rollBreakdown(statRoll)).toBe('4d6kh3 [6, 5, 3, (1)] + 2 = 16');
    expect(rollFlags(statRoll)).toEqual({ crit: true, fumble: false, kept: 3 }); // the dropped 1 doesn't count
    expect(rollFlags(nat20)).toEqual({ crit: true, fumble: false, kept: 1 });
  });

  it('labels fate dice and marks rerolled dice as dropped', () => {
    const fate: RollResult = {
      expr: '4dF',
      total: 0,
      terms: [{ kind: 'dice', text: '4dF', count: 4, sides: 'F', value: 0, dice: [{ value: 1 }, { value: -1 }, { value: 0 }, { value: 0 }] }],
    };
    const t = rollView(fate).terms[0]!;
    expect(t.kind === 'dice' && t.dice.map((d) => d.label)).toEqual(['+', '−', '0', '0']);
    const rr: RollResult = { expr: '1d6r1', total: 4, terms: [{ kind: 'dice', text: '1d6r1', count: 1, sides: 6, value: 4, dice: [{ value: 1, rerolled: true, dropped: true }, { value: 4 }] }] };
    const r = rollView(rr).terms[0]!;
    expect(r.kind === 'dice' && r.dice.map((d) => d.dropped)).toEqual([true, false]);
  });

  it('labels whispers, GM rolls and OOC, and hides the speaker of descriptions', () => {
    const members = [gm, ana, bo];
    expect(messageView(msg({ kind: 'whisper', to: ['p2'] }), members)).toMatchObject({ label: 'to Bo', color: '#e05252', showSpeaker: true });
    expect(messageView(msg({ kind: 'gmroll', hiddenResult: true }), members)).toMatchObject({ label: 'GM roll', secret: true });
    expect(messageView(msg({ kind: 'ooc' }), members).label).toBe('OOC');
    expect(messageView(msg({ kind: 'desc', from: 'gm' }), members)).toMatchObject({ showSpeaker: false, color: null });
    expect(messageView(msg({ kind: 'system', from: 'system', speaker: 'Delve' }), members).showSpeaker).toBe(false);
    expect(messageView(msg({ from: 'gm', speaker: 'The Innkeeper' }), members)).toMatchObject({ speaker: 'The Innkeeper', color: '#d4a017' });
  });

  it('shows the text of a roll message only when it says more than the card', () => {
    expect(showsText(msg({ kind: 'roll', text: '1d20', rolls: [nat20] }))).toBe(false);
    expect(showsText(msg({ kind: 'gmroll', text: 'rolled 1d20 secretly', hiddenResult: true }))).toBe(true);
    expect(showsText(msg({ kind: 'chat', text: '1d20' }))).toBe(true);
    expect(showsText(msg({ kind: 'chat', text: '  ' }))).toBe(false);
  });

  it('gives /r its roll cards and inline rolls their boxes', () => {
    expect(cardRolls(msg({ kind: 'roll', text: '{{roll:0}} to hit', rolls: [nat20] }))).toEqual([0]);
    expect(cardRolls(msg({ kind: 'chat', text: 'I deal {{roll:0}}', rolls: [statRoll] }))).toEqual([]);
    expect(cardRolls(msg({ kind: 'chat', text: 'no marker', rolls: [statRoll] }))).toEqual([0]);
  });

  it('parses numbers from fields and finds changed fields', () => {
    expect(num('3,5', 0)).toBe(3.5);
    expect(num('', 7)).toBe(7);
    expect(num('abc', 7)).toBe(7);
    const t = tok('t1', { bars: [{ value: 3, max: 10 }], name: 'Ana' });
    expect(changed(t, { name: 'Ana', bars: [{ value: 3, max: 10 }], rotation: 90 })).toEqual({ rotation: 90 });
  });
});
