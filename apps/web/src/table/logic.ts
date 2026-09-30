// Pure Delve Table client logic (no DOM, no Pixi), so it can be unit-tested:
// the camera, snapping and hit-testing, what the UI lets a member try, the
// local view reducer with optimistic moves, and chat/roll formatting.
import type { Bar, ChatMessage, GameEvent, GameView, Layer, Member, Page, RollResult, Token, TurnEntry, TurnOrder } from '@delve/table';

// ---------- camera ----------

/** screen = world * scale + (x, y). World units are cells; scale is screen pixels per cell. */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const MIN_SCALE = 4;
export const MAX_SCALE = 360;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const toScreen = (c: Camera, wx: number, wy: number): [number, number] => [wx * c.scale + c.x, wy * c.scale + c.y];
export const toWorld = (c: Camera, sx: number, sy: number): [number, number] => [(sx - c.x) / c.scale, (sy - c.y) / c.scale];

/** Zoom by `factor` (>1 zooms in) keeping the world point under (sx, sy) where it is. */
export function zoomAt(c: Camera, sx: number, sy: number, factor: number, min = MIN_SCALE, max = MAX_SCALE): Camera {
  const scale = clamp(c.scale * factor, min, max);
  const [wx, wy] = toWorld(c, sx, sy);
  return { scale, x: sx - wx * scale, y: sy - wy * scale };
}

export const panBy = (c: Camera, dx: number, dy: number): Camera => ({ ...c, x: c.x + dx, y: c.y + dy });

/** The camera that shows box b whole and centred in a vw×vh viewport. */
export function fitCamera(b: Box, vw: number, vh: number, pad = 28, min = MIN_SCALE, max = 140): Camera {
  const w = Math.max(b.x1 - b.x0, 1);
  const h = Math.max(b.y1 - b.y0, 1);
  const scale = clamp(Math.min(Math.max(vw - 2 * pad, 40) / w, Math.max(vh - 2 * pad, 40) / h), min, max);
  return { scale, x: vw / 2 - (b.x0 + w / 2) * scale, y: vh / 2 - (b.y0 + h / 2) * scale };
}

/** The world area on screen. */
export function visibleBox(c: Camera, vw: number, vh: number): Box {
  const [x0, y0] = toWorld(c, 0, 0);
  const [x1, y1] = toWorld(c, vw, vh);
  return { x0, y0, x1, y1 };
}

// ---------- pages ----------

export const pageBox = (p: Pick<Page, 'origin' | 'width' | 'height'>): Box => ({
  x0: p.origin[0],
  y0: p.origin[1],
  x1: p.origin[0] + p.width,
  y1: p.origin[1] + p.height,
});

/**
 * The background picture's URL, or null for a page without one. `bust` forces a
 * reload (the Delve map changed). A Delve page is drawn in the players' view with
 * only what they've seen, or for the GM the whole map with the unseen parts dimmed
 * and the GM's notes; both exactly in the page's frame, so they line up.
 */
export function backgroundUrl(p: Page, bust = 0, view: 'gm' | 'players' = 'players'): string | null {
  const bg = p.background;
  if (bg.kind === 'delve') {
    const b = pageBox(p);
    const q = `view=${view}&ppg=${p.cellPx || 70}&fog=1&grid=0&frame=${b.x0},${b.y0},${b.x1},${b.y1}${bust ? `&v=${bust}` : ''}`;
    return `/api/v1/maps/${encodeURIComponent(bg.mapId)}/render.png?${q}`;
  }
  if (bg.kind === 'image') return bg.url;
  return null;
}

/** Where the background goes, in cells: at the origin, sized by the page (images) or by its pixels (Delve renders). */
export function backgroundBox(p: Page, pxW: number, pxH: number): Box {
  const [x0, y0] = p.origin;
  if (p.background.kind === 'image') return { x0, y0, x1: x0 + p.background.w, y1: y0 + p.background.h };
  const px = p.cellPx || 70;
  return { x0, y0, x1: x0 + pxW / px, y1: y0 + pxH / px };
}

/**
 * Should a page.upsert fetch the background again? A rename or a grid switch
 * changes nothing on the picture; any other upsert may mean the Delve map
 * behind it changed (fog revealed, a room added), so it reloads.
 */
export function needsReload(prev: Page | null, next: Page): boolean {
  if (!prev || prev.id !== next.id) return false; // a different page loads anyway
  const cosmetic = new Set(['name', 'showGrid', 'cellUnit']);
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof Page>;
  const diff = [...keys].filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
  return !(diff.length > 0 && diff.every((k) => cosmetic.has(k)));
}

/** Grid spacing in cells for a zoom level: every cell, or every 5th / 25th when they'd be too dense to read. */
export const gridStep = (scale: number): number => (scale >= 9 ? 1 : scale >= 1.8 ? 5 : 25);

/** World x and y of the grid lines to draw: whole multiples of `step` inside both the page and the visible area. */
export function gridLines(page: Box, visible: Box, step: number): { xs: number[]; ys: number[] } {
  const lines = (lo: number, hi: number, vlo: number, vhi: number): number[] => {
    const out: number[] = [];
    const a = Math.max(lo, vlo);
    const b = Math.min(hi, vhi);
    if (b < a) return out;
    const first = Math.ceil(a / step - 1e-9);
    for (let i = first; i * step <= b + 1e-9 && out.length < 2000; i++) out.push(i * step + 0);
    return out;
  };
  return { xs: lines(page.x0, page.x1, visible.x0, visible.x1), ys: lines(page.y0, page.y1, visible.y0, visible.y1) };
}

// ---------- tokens: snapping, hit-testing, draw order ----------

// + 0 turns -0 into 0
const round3 = (v: number): number => Math.round(v * 1000) / 1000 + 0;

/** A top-left coordinate snapped to whole cells, or to multiples of the size for tokens smaller than a cell. */
export function snap(v: number, size: number): number {
  const step = size > 0 && size < 1 ? size : 1;
  return round3(Math.round(v / step) * step);
}

export interface DragStart {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where dragged tokens land. The token under the pointer (lead) snaps to the
 * grid and the others keep their offsets to it; `free` (Alt) skips snapping.
 */
export function dragTargets(starts: readonly DragStart[], leadId: string, dx: number, dy: number, free: boolean): { id: string; x: number; y: number }[] {
  const lead = starts.find((s) => s.id === leadId) ?? starts[0];
  if (!lead) return [];
  const ddx = free ? dx : snap(lead.x + dx, lead.w) - lead.x;
  const ddy = free ? dy : snap(lead.y + dy, lead.h) - lead.y;
  return starts.map((s) => ({ id: s.id, x: round3(s.x + ddx), y: round3(s.y + ddy) }));
}

export const LAYERS: readonly Layer[] = ['map', 'tokens', 'gm'];

/** Tokens in the order they are drawn: map layer, tokens, then the GM layer; list order within a layer. */
export function drawOrder(tokens: readonly Token[]): Token[] {
  return LAYERS.flatMap((l) => tokens.filter((t) => t.layer === l));
}

/** Is world point (x, y) on the token (its footprint, turned with it)? */
export function hits(t: Pick<Token, 'x' | 'y' | 'w' | 'h' | 'rotation'>, x: number, y: number): boolean {
  const cx = t.x + t.w / 2;
  const cy = t.y + t.h / 2;
  const a = (-(t.rotation ?? 0) * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= t.w / 2 && Math.abs(ly) <= t.h / 2;
}

/** The topmost token at a world point that passes `accept`. */
export function tokenAt(tokens: readonly Token[], x: number, y: number, accept: (t: Token) => boolean = () => true): Token | null {
  const order = drawOrder(tokens);
  for (let i = order.length - 1; i >= 0; i--) {
    const t = order[i]!;
    if (accept(t) && hits(t, x, y)) return t;
  }
  return null;
}

/** Top-left for a new w×h token centred on world point (x, y), on whole cells. */
export const placeAt = (x: number, y: number, w: number, h: number): { x: number; y: number } => ({ x: snap(x - w / 2, w), y: snap(y - h / 2, h) });

/** A bar's filled share 0..1, or null when it has no maximum. */
export function barFraction(b: Bar): number | null {
  if (b.max === undefined || !(b.max > 0)) return null;
  return clamp(b.value / b.max, 0, 1);
}

export const BAR_COLORS = ['#3FA34D', '#3B7DD8', '#C8433A'] as const;

// ---------- what the UI lets a member try (the server decides; see can() in @delve/table) ----------

export const isGm = (m: Pick<Member, 'role'>): boolean => m.role === 'gm';

export const controls = (me: Pick<Member, 'id'>, t: Pick<Token, 'controlledBy'>): boolean => t.controlledBy.includes(me.id) || t.controlledBy.includes('all');

/** GM: every token. Players: tokens they control, on the tokens layer. */
export const canMove = (me: Member, t: Token): boolean => isGm(me) || (t.layer === 'tokens' && controls(me, t));

/** full: everything (GM); limited: rotation and bars (a player's own token); none. */
export function editLevel(me: Member, t: Token): 'full' | 'limited' | 'none' {
  if (isGm(me)) return 'full';
  return canMove(me, t) ? 'limited' : 'none';
}

/** Which tokens a click may select: the GM works on one layer at a time, players on their own tokens. */
export const selectable = (me: Member, active: Layer) => (t: Token): boolean => (isGm(me) ? t.layer === active : canMove(me, t));

export function currentEntry(turn: TurnOrder | null): TurnEntry | null {
  if (!turn || !turn.entries.length) return null;
  return turn.entries[clamp(turn.current, 0, turn.entries.length - 1)] ?? null;
}

/** The GM, or a player whose token has the current turn. */
export function canEndTurn(me: Member, turn: TurnOrder | null, tokens: readonly Token[]): boolean {
  if (isGm(me)) return Boolean(turn?.entries.length);
  const cur = currentEntry(turn);
  if (!cur?.tokenId) return false;
  const t = tokens.find((x) => x.id === cur.tokenId);
  return Boolean(t && controls(me, t));
}

// ---------- the local view ----------

export interface TableState {
  view: GameView;
  chat: ChatMessage[];
}

export const CHAT_KEEP = 500;

/** Apply one server event to the local view. Returns a new state; the old one is left alone. */
export function reduce(s: TableState, ev: GameEvent): TableState {
  const v = s.view;
  switch (ev.type) {
    case 'token.upsert': {
      const rest = v.tokens.filter((t) => t.id !== ev.token.id);
      if (ev.token.pageId !== v.pageId) return { ...s, view: { ...v, tokens: rest } };
      const i = v.tokens.findIndex((t) => t.id === ev.token.id);
      const tokens = i < 0 ? [...v.tokens, ev.token] : v.tokens.map((t, k) => (k === i ? ev.token : t));
      return { ...s, view: { ...v, tokens } };
    }
    case 'token.remove': {
      const gone = new Set(ev.ids);
      return { ...s, view: { ...v, tokens: v.tokens.filter((t) => !gone.has(t.id)) } };
    }
    case 'page.upsert': {
      const i = v.pages.findIndex((p) => p.id === ev.page.id);
      const pages = i < 0 ? [...v.pages, ev.page] : v.pages.map((p, k) => (k === i ? ev.page : p));
      return { ...s, view: { ...v, pages } };
    }
    case 'page.remove':
      return { ...s, view: { ...v, pages: v.pages.filter((p) => p.id !== ev.id) } };
    case 'page.switch':
      // a fresh hello follows with the new page's tokens
      return { ...s, view: { ...v, pageId: ev.pageId, tokens: [] } };
    case 'chat': {
      if (s.chat.some((m) => m.id === ev.message.id)) return s;
      const chat = [...s.chat, ev.message].slice(-CHAT_KEEP);
      return { ...s, chat };
    }
    case 'turn':
      return { ...s, view: { ...v, turn: ev.turn } };
    case 'members': {
      const you = ev.members.find((m) => m.id === v.you.id) ?? v.you;
      return { ...s, view: { ...v, members: ev.members, you } };
    }
    case 'game':
      return { ...s, view: { ...v, name: ev.name, ...(ev.playerPageId ? { playerPageId: ev.playerPageId } : {}) } };
    default:
      return s;
  }
}

/** A move shown before the server confirms it. `ackRev`: the server's rev once it acked. */
export interface Optimistic {
  x: number;
  y: number;
  ref: number;
  ackRev?: number;
}

/** Tokens with optimistic positions laid over the server's. */
export function withOptimistic(tokens: readonly Token[], opt: ReadonlyMap<string, Optimistic>): Token[] {
  if (!opt.size) return [...tokens];
  return tokens.map((t) => {
    const o = opt.get(t.id);
    return o ? { ...t, x: o.x, y: o.y } : t;
  });
}

/**
 * The server acked `ref` at `rev`. Once the local view has caught up to that
 * rev, its events carry the real position, so the override goes; until then
 * it stays, so the token doesn't flick back.
 */
export function ackOptimistic(opt: Map<string, Optimistic>, ref: number, rev: number, viewRev: number): void {
  for (const [id, o] of opt) {
    if (o.ref !== ref) continue;
    if (viewRev >= rev) opt.delete(id);
    else o.ackRev = rev;
  }
}

/** The server refused `ref`: its tokens snap back to the server's position. */
export function failOptimistic(opt: Map<string, Optimistic>, ref: number): void {
  for (const [id, o] of opt) if (o.ref === ref) opt.delete(id);
}

/** After events up to `viewRev`, drop the acked overrides they settled. */
export function settleOptimistic(opt: Map<string, Optimistic>, viewRev: number): void {
  for (const [id, o] of opt) if (o.ackRev !== undefined && o.ackRev <= viewRev) opt.delete(id);
}

/** Reconnect delay: 0.5 s doubling to 15 s, with up to 30% jitter (`rand` in 0..1). */
export const backoff = (attempt: number, rand = 0): number => Math.round(Math.min(15000, 500 * 2 ** Math.max(0, attempt)) * (1 + 0.3 * rand));

/** Up/down through sent lines. `pos === history.length` is the line being typed. */
export const historyStep = (length: number, pos: number, dir: -1 | 1): number => clamp(pos + dir, 0, length);

// ---------- chat and rolls, as plain data for the DOM ----------

export type Segment = { kind: 'text'; text: string } | { kind: 'roll'; index: number; roll: RollResult | null };

const ROLL_MARK = /\{\{roll:(\d+)\}\}/g;

/** Split a message's text at its {{roll:N}} markers. */
export function segments(text: string, rolls: readonly RollResult[] = []): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(ROLL_MARK)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    const index = Number(m[1]);
    out.push({ kind: 'roll', index, roll: rolls[index] ?? null });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

export interface DieView {
  label: string;
  value: number;
  dropped: boolean;
  /** Highest face (a crit), or lowest (a fumble). */
  max: boolean;
  min: boolean;
  exploded: boolean;
  rerolled: boolean;
  success: boolean;
  failure: boolean;
}

export type TermView = { kind: 'dice'; text: string; dice: DieView[]; value: number } | { kind: 'number'; text: string } | { kind: 'op'; text: string };

const OP_TEXT: Record<string, string> = { '+': '+', '-': '−', '*': '×', '/': '÷', '(': '(', ')': ')' };

export function rollView(r: RollResult): { expr: string; total: number; terms: TermView[] } {
  const terms: TermView[] = r.terms.map((t) => {
    if (t.kind === 'number') return { kind: 'number', text: String(t.value) };
    if (t.kind === 'op') return { kind: 'op', text: OP_TEXT[t.op] ?? t.op };
    const fate = t.sides === 'F';
    const hi = fate ? 1 : t.sides;
    const lo = fate ? -1 : 1;
    return {
      kind: 'dice',
      text: t.text,
      value: t.value,
      dice: t.dice.map((d) => ({
        label: fate ? (d.value > 0 ? '+' : d.value < 0 ? '−' : '0') : String(d.value),
        value: d.value,
        dropped: Boolean(d.dropped || d.rerolled),
        max: d.value === hi && hi !== lo,
        min: d.value === lo && hi !== lo,
        exploded: Boolean(d.exploded),
        rerolled: Boolean(d.rerolled),
        success: Boolean(d.success),
        failure: Boolean(d.failure),
      })),
    };
  });
  return { expr: r.expr, total: r.total, terms };
}

/** A roll with a kept die on its highest face (crit) or its lowest (fumble); `kept` counts the dice that count. */
export function rollFlags(r: RollResult): { crit: boolean; fumble: boolean; kept: number } {
  const kept = rollView(r).terms.flatMap((t) => (t.kind === 'dice' ? t.dice.filter((d) => !d.dropped) : []));
  return { crit: kept.some((d) => d.max), fumble: kept.some((d) => d.min), kept: kept.length };
}

/** One line for a tooltip: "2d6 [6, 2] + 3 = 11"; dropped dice in parentheses. */
export function rollBreakdown(r: RollResult): string {
  const parts = rollView(r).terms.map((t) => {
    if (t.kind !== 'dice') return t.text;
    return `${t.text} [${t.dice.map((d) => (d.dropped ? `(${d.label})` : d.label)).join(', ')}]`;
  });
  return `${parts.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')')} = ${r.total}`;
}

export interface MessageView {
  /** CSS class for the kind. */
  kind: string;
  speaker: string;
  /** The speaker's member colour, when the sender is a member. */
  color: string | null;
  /** A small label after the speaker: "to Ana", "GM roll", "OOC". */
  label: string | null;
  /** A GM roll whose result is hidden from this member. */
  secret: boolean;
  /** Show the speaker at all (descriptions and system notes have none). */
  showSpeaker: boolean;
}

const names = (ids: readonly string[] | undefined, members: readonly Member[]): string =>
  (ids ?? []).map((id) => members.find((m) => m.id === id)?.name ?? id).join(', ');

export function messageView(m: ChatMessage, members: readonly Member[]): MessageView {
  const sender = members.find((x) => x.id === m.from);
  const base: MessageView = { kind: m.kind, speaker: m.speaker, color: sender?.color ?? null, label: null, secret: false, showSpeaker: true };
  switch (m.kind) {
    case 'whisper':
      return { ...base, label: `to ${names(m.to, members) || 'nobody'}` };
    case 'gmroll':
      return { ...base, label: 'GM roll', secret: Boolean(m.hiddenResult) };
    case 'ooc':
      return { ...base, label: 'OOC' };
    case 'desc':
    case 'system':
      return { ...base, showSpeaker: false, color: null };
    default:
      return base;
  }
}

/** Which of a message's rolls get a full card: all of them for /r and /gr, else those the text doesn't place inline. */
export function cardRolls(m: Pick<ChatMessage, 'kind' | 'text' | 'rolls'>): number[] {
  const rolls = m.rolls ?? [];
  if (m.kind === 'roll' || m.kind === 'gmroll') return rolls.map((_r, i) => i);
  const inline = new Set(segments(m.text, rolls).flatMap((s) => (s.kind === 'roll' ? [s.index] : [])));
  return rolls.map((_r, i) => i).filter((i) => !inline.has(i));
}

/** Is there text worth showing? /r and /gr messages carry their expression as the text, which the card shows already. */
export function showsText(m: Pick<ChatMessage, 'kind' | 'text' | 'rolls'>): boolean {
  const text = m.text.trim();
  if (!text) return false;
  if ((m.kind === 'roll' || m.kind === 'gmroll') && m.rolls?.some((r) => r.expr.trim() === text)) return false;
  return true;
}

/** "12:04" for a chat timestamp. */
export const clock = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Parse a number typed into a field, or fall back. */
export function num(s: string, fallback: number): number {
  const v = Number(s.trim().replace(',', '.'));
  return s.trim() !== '' && Number.isFinite(v) ? v : fallback;
}

/** The fields of `next` that differ from `prev` (shallow, arrays and objects by JSON). */
export function changed<T extends object>(prev: T, next: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(next) as (keyof T)[]) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) out[k] = next[k];
  }
  return out;
}
