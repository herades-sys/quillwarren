// The one permission check (can) and the one way to change a game (applyIntent).
// applyIntent validates the untrusted intent, asks can(), and returns a new
// state (rev + 1) plus the unfiltered events; the server filters each event per
// member with eventFor. The input state is never mutated.
import { parseChat } from './chat.ts';
import { TableError } from './errors.ts';
import { cleanText, defaultPage, ID_PATTERN, memberName, nextNumber } from './game.ts';
import { isCliff, moveRefusal } from './movement.ts';
import type {
  Background,
  Bar,
  ChatMessage,
  GameEvent,
  GameState,
  Intent,
  Layer,
  Member,
  Page,
  PageCliff,
  PageDoor,
  PageLight,
  PageVision,
  Sight,
  Token,
  TokenLight,
  TurnEntry,
  TurnOrder,
} from './protocol.ts';

export interface ApplyContext {
  now: number;
  /** A uniform whole number from 1 to sides. */
  rng: (sides: number) => number;
  /** The next chat sequence number. */
  nextSeq: () => number;
}

export interface Outcome {
  state: GameState;
  events: GameEvent[];
  chat?: ChatMessage;
  /** A GM tool for a page's explored fog (vision.explored): the server's vision keeper does it; nothing in the state changes. */
  explored?: { pageId: string; action: 'reset' | 'reveal' | 'hide' };
}

type Obj = Record<string, unknown>;

const INTENT_TYPES = new Set<string>([
  'token.create',
  'token.update',
  'token.move',
  'token.delete',
  'page.create',
  'page.update',
  'page.delete',
  'page.view',
  'page.activate',
  'chat.send',
  'turn.add',
  'turn.update',
  'turn.remove',
  'turn.sort',
  'turn.next',
  'turn.clear',
  'turn.visible',
  'member.remove',
  'member.rename',
  'game.rename',
  'door.set',
  'vision.explored',
]);

const GM_ONLY = new Map<string, string>([
  ['token.create', 'Only the GM can create tokens'],
  ['token.delete', 'Only the GM can delete tokens'],
  ['page.create', 'Only the GM can change pages'],
  ['page.update', 'Only the GM can change pages'],
  ['page.delete', 'Only the GM can change pages'],
  ['page.view', 'Only the GM can switch pages'],
  ['page.activate', 'Only the GM can move the players to a page'],
  ['turn.update', 'Only the GM can change the turn order'],
  ['turn.remove', 'Only the GM can change the turn order'],
  ['turn.sort', 'Only the GM can change the turn order'],
  ['turn.clear', 'Only the GM can change the turn order'],
  ['turn.visible', 'Only the GM can change the turn order'],
  ['member.remove', 'Only the GM can remove players'],
  ['game.rename', 'Only the GM can rename the game'],
  ['door.set', 'Only the GM can open and shut doors'],
  ['vision.explored', 'Only the GM can change what has been explored'],
]);

/** What a player may change on a token they control. */
const PLAYER_TOKEN_FIELDS = new Set(['x', 'y', 'rotation', 'bars', 'name', 'showName']);

/** Sanity limits, so one game's state (sent whole to the GM) stays small. */
export const MAX_TOKENS = 5000;
export const MAX_PAGES = 200;
export const MAX_TURN_ENTRIES = 500;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const findMember = (state: GameState, id: unknown): Member | undefined => state.members.find((m) => m.id === id);
const findToken = (state: GameState, id: unknown): Token | undefined => state.tokens.find((t) => t.id === id);
const controls = (t: Token, memberId: string): boolean => t.controlledBy.includes(memberId) || t.controlledBy.includes('all');

// A player can only reach tokens they can see; a gm-layer token looks like no token at all.
function playerToken(state: GameState, me: Member, id: unknown): true | string {
  const t = findToken(state, id);
  if (!t || t.layer === 'gm') return 'No such token';
  if (t.pageId !== state.playerPageId) return "That token isn't on your page";
  if (!controls(t, me.id)) return "You don't control that token";
  if (t.layer !== 'tokens') return 'You can only move tokens on the tokens layer';
  return true;
}

/**
 * Respect heights (movement.ts): on a page with it on, a player's token may not
 * cross a cliff edge without stairs or a ladder, a wall or a shut door. Bad
 * numbers pass here and fail in apply's checks.
 */
function movable(state: GameState, id: unknown, x: unknown, y: unknown): true | string {
  const t = findToken(state, id);
  if (!t) return true;
  const nx = x === undefined ? t.x : x;
  const ny = y === undefined ? t.y : y;
  if (typeof nx !== 'number' || typeof ny !== 'number' || !Number.isFinite(nx) || !Number.isFinite(ny)) return true;
  return moveRefusal(state.pages.find((p) => p.id === t.pageId), t, nx, ny) ?? true;
}

/** true if `memberId` may do `intent`, otherwise the reason (for the error reply). */
export function can(state: GameState, memberId: string, intent: Intent): true | string {
  const me = findMember(state, memberId);
  if (!me) return "You aren't in this game";
  if (me.role === 'gm') return true;
  const raw = intent as unknown;
  if (!isObj(raw) || typeof raw.type !== 'string') return 'That is not something you can do';
  switch (intent.type) {
    case 'chat.send':
      return true;
    case 'token.move':
      return playerToken(state, me, intent.id) === true ? movable(state, intent.id, intent.x, intent.y) : playerToken(state, me, intent.id);
    case 'token.update': {
      const ok = playerToken(state, me, intent.id);
      if (ok !== true || !isObj(intent.set)) return ok;
      for (const key of Object.keys(intent.set)) {
        if (!PLAYER_TOKEN_FIELDS.has(key)) return `Only the GM can change a token's ${key}`;
      }
      // a move by setting x or y: the same height rule as token.move
      return 'x' in intent.set || 'y' in intent.set ? movable(state, intent.id, intent.set.x, intent.set.y) : true;
    }
    case 'turn.add': {
      const entry = intent.entry as unknown;
      const tokenId = isObj(entry) ? entry.tokenId : undefined;
      if (tokenId === undefined) return 'Only the GM can add names to the turn order';
      const t = findToken(state, tokenId);
      if (!t || t.layer === 'gm') return 'No such token';
      return controls(t, me.id) ? true : 'You can only add tokens you control';
    }
    case 'turn.next': {
      const { turn } = state;
      if (!turn.visible) return 'The turn order is hidden';
      const entry = turn.entries[turn.current];
      if (!entry) return 'The turn order is empty';
      const t = entry.tokenId === undefined ? undefined : findToken(state, entry.tokenId);
      return t && t.layer !== 'gm' && controls(t, me.id) ? true : "It isn't your turn";
    }
    case 'member.rename':
      return intent.id === me.id ? true : 'You can only rename yourself';
    default:
      return GM_ONLY.get(intent.type) ?? 'Only the GM can do that';
  }
}

// ---------- value checks (all throw TableError) ----------

function fail(message: string): never {
  throw new TableError(message);
}

function num(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${what} must be a number from ${min} to ${max}`);
  return v;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') fail(`${what} must be true or false`);
  return v;
}

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string') fail(`${what} must be text`);
  if (v.length > max) fail(`${what} is too long (max ${max} characters)`);
  return v;
}

/** An image on this server: a path like /api/v1/games/g1/assets/ab12.png, never another origin or a script. */
function imagePath(v: unknown, what: string): string {
  const s = text(v, what, 1000);
  // A backslash counts as a slash in browsers, so "/\evil.com" would leave the origin.
  if (!s.startsWith('/') || s.includes('//') || s.includes('\\') || /javascript:/i.test(s) || /[\s"'<>`]/.test(s)) {
    fail(`${what} must be a path on this server, starting with /`);
  }
  return s;
}

function layerOf(v: unknown): Layer {
  if (v !== 'map' && v !== 'tokens' && v !== 'gm') fail('Layer must be map, tokens or gm');
  return v;
}

function idList(v: unknown, what: string, max: number): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > max) fail(`${what} must be a list of 1 to ${max} ids`);
  const ids = v.map((id) => (typeof id === 'string' ? id : fail(`${what} must be a list of ids`)));
  return [...new Set(ids)];
}

function newId(provided: unknown, existing: string[], prefix: string, what: string): string {
  if (provided === undefined) return `${prefix}${nextNumber(existing, prefix)}`;
  if (typeof provided !== 'string' || !ID_PATTERN.test(provided)) {
    fail(`${what} ids start with a letter and use only letters, digits, _ or - (max 32)`);
  }
  if (existing.includes(provided)) fail(`${what} id ${provided} is already in use`);
  return provided;
}

function controlledBy(state: GameState, v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 100) fail('controlledBy must be a list of member ids (or "all")');
  const out = new Set<string>();
  for (const id of v) {
    if (id !== 'all' && !findMember(state, id)) fail(`No member ${JSON.stringify(id)}`);
    out.add(id as string);
  }
  return [...out];
}

function bars(v: unknown): Bar[] {
  if (!Array.isArray(v) || v.length > 3) fail('A token has at most 3 bars');
  return v.map((b, i) => {
    if (!isObj(b)) fail(`Bar ${i + 1} must be {value, max}`);
    for (const k of Object.keys(b)) if (k !== 'value' && k !== 'max') fail(`Bars have no field "${k}"`);
    const bar: Bar = { value: num(b.value, `Bar ${i + 1} value`, -1e9, 1e9) };
    if (b.max !== undefined) bar.max = num(b.max, `Bar ${i + 1} max`, -1e9, 1e9);
    return bar;
  });
}

function only(v: Obj, keys: readonly string[], what: string): void {
  for (const k of Object.keys(v)) if (!keys.includes(k)) fail(`${what} has no field "${k}"`);
}

function tokenLight(v: unknown): TokenLight {
  if (!isObj(v)) fail('light must be {bright, dim} in cells');
  only(v, ['bright', 'dim'], 'light');
  return { bright: num(v.bright ?? 0, 'Bright light', 0, 200), dim: num(v.dim ?? 0, 'Dim light', 0, 200) };
}

function sight(v: unknown): Sight {
  if (!isObj(v)) fail('sight must be {enabled?, range?, darkvision?}');
  only(v, ['enabled', 'range', 'darkvision'], 'sight');
  const out: Sight = {};
  if (v.enabled !== undefined) out.enabled = bool(v.enabled, 'sight.enabled');
  if (v.range !== undefined) out.range = num(v.range, 'Sight range', 0, 1000);
  if (v.darkvision !== undefined) out.darkvision = num(v.darkvision, 'Darkvision', 0, 1000);
  return out;
}

/** Quillwarren map ids (doors, props), as page doors and lights carry them. */
const MAP_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function mapId(v: unknown, what: string): string {
  if (typeof v !== 'string' || !MAP_ID.test(v)) fail(`${what} must be a Quillwarren map id`);
  return v;
}

function pageVision(v: unknown): PageVision {
  if (!isObj(v)) fail('vision must be {mode: "off" | "dynamic", ambient?: "dark" | "dim" | "bright"}');
  only(v, ['mode', 'ambient'], 'vision');
  if (v.mode !== 'off' && v.mode !== 'dynamic') fail('vision.mode must be off or dynamic');
  const out: PageVision = { mode: v.mode };
  if (v.ambient !== undefined) {
    if (v.ambient !== 'dark' && v.ambient !== 'dim' && v.ambient !== 'bright') fail('vision.ambient must be dark, dim or bright');
    out.ambient = v.ambient;
  }
  return out;
}

function pageDoors(v: unknown): PageDoor[] {
  if (!Array.isArray(v) || v.length > 5000) fail('doors must be a list of at most 5000 doors');
  return v.map((d) => {
    if (!isObj(d)) fail('A door is {id, a, b, style, open?}');
    only(d, ['id', 'a', 'b', 'style', 'open'], 'A door');
    const door: PageDoor = { id: mapId(d.id, 'Door id'), a: point(d.a, 'Door end'), b: point(d.b, 'Door end'), style: text(d.style, 'Door style', 20) };
    if (d.open !== undefined) door.open = bool(d.open, 'Door open');
    return door;
  });
}

function pageLights(v: unknown): PageLight[] {
  if (!Array.isArray(v) || v.length > 5000) fail('lights must be a list of at most 5000 lights');
  return v.map((l) => {
    if (!isObj(l)) fail('A light is {id, x, y, bright, dim, asset?}');
    only(l, ['id', 'x', 'y', 'bright', 'dim', 'asset'], 'A light');
    const light: PageLight = {
      id: mapId(l.id, 'Light id'),
      x: num(l.x, 'Light x', -100000, 100000),
      y: num(l.y, 'Light y', -100000, 100000),
      bright: num(l.bright, 'Bright light', 0, 200),
      dim: num(l.dim, 'Dim light', 0, 200),
    };
    if (l.asset !== undefined) light.asset = text(l.asset, 'Light asset', 100);
    return light;
  });
}

function doorStates(v: unknown): Record<string, boolean> {
  if (!isObj(v) || Object.keys(v).length > 5000) fail('doorState must be {doorId: true | false} for at most 5000 doors');
  const out: Record<string, boolean> = {};
  for (const [k, x] of Object.entries(v)) out[mapId(k, 'Door id')] = bool(x, `Door ${k}`);
  return out;
}

function pageCliffs(v: unknown): PageCliff[] {
  if (!Array.isArray(v) || v.length > 50000) fail('cliffs must be a list of at most 50000 edges');
  return v.map((c) => {
    if (!isCliff(c)) fail('A cliff is {a: [x, y], b: [x, y], drop}');
    return { a: [c.a[0], c.a[1]], b: [c.b[0], c.b[1]], drop: c.drop };
  });
}

type Patch<T> = { [K in keyof T]?: T[K] | undefined };

/** Check the token fields in `set`; undefined removes an optional field. */
function tokenPatch(state: GameState, set: Obj): Patch<Token> {
  const out: Patch<Token> = {};
  for (const [k, v] of Object.entries(set)) {
    switch (k) {
      case 'layer':
        out.layer = layerOf(v);
        break;
      case 'x':
      case 'y':
        out[k] = num(v, `Token ${k}`, -1000, 10000);
        break;
      case 'w':
      case 'h':
        out[k] = num(v, `Token ${k}`, 0.25, 50);
        break;
      case 'rotation':
        out.rotation = v === undefined ? undefined : num(v, 'Token rotation', -36000, 36000);
        break;
      case 'name':
        out.name = v === undefined ? undefined : text(v, 'Token name', 80);
        break;
      case 'showName':
        out.showName = v === undefined ? undefined : bool(v, 'showName');
        break;
      case 'image':
        out.image = imagePath(v, 'Token image');
        break;
      case 'controlledBy':
        out.controlledBy = controlledBy(state, v);
        break;
      case 'bars':
        out.bars = v === undefined ? undefined : bars(v);
        break;
      case 'gmNotes':
        out.gmNotes = v === undefined ? undefined : text(v, 'GM notes', 5000);
        break;
      case 'light':
        out.light = v === undefined || v === null ? undefined : tokenLight(v);
        break;
      case 'sight':
        out.sight = v === undefined || v === null ? undefined : sight(v);
        break;
      case 'id':
      case 'pageId':
        fail(`A token's ${k} can't be changed`);
        break;
      default:
        fail(`Tokens have no field "${k}"`);
    }
  }
  return out;
}

function background(v: unknown): Background {
  if (!isObj(v)) fail('Background must be {kind: "none" | "delve" | "image", …}');
  switch (v.kind) {
    case 'none':
      return { kind: 'none' };
    case 'delve': {
      const mapId = v.mapId;
      if (typeof mapId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(mapId)) fail('Background mapId must be a Quillwarren map id');
      return { kind: 'delve', mapId };
    }
    case 'image':
      return {
        kind: 'image',
        url: imagePath(v.url, 'Background image'),
        w: num(v.w, 'Background image width', 1, 100000),
        h: num(v.h, 'Background image height', 1, 100000),
      };
    default:
      return fail('Background kind must be none, delve or image');
  }
}

function point(v: unknown, what: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) fail(`${what} must be [x, y]`);
  return [num(v[0], what, -100000, 100000), num(v[1], what, -100000, 100000)];
}

function walls(v: unknown): [[number, number], [number, number]][] {
  if (!Array.isArray(v) || v.length > 50000) fail('Walls must be a list of at most 50000 segments');
  return v.map((seg) => {
    if (!Array.isArray(seg) || seg.length !== 2) fail('A wall segment is [[x1, y1], [x2, y2]]');
    return [point(seg[0], 'Wall point'), point(seg[1], 'Wall point')];
  });
}

function pagePatch(set: Obj): Patch<Page> {
  const out: Patch<Page> = {};
  for (const [k, v] of Object.entries(set)) {
    switch (k) {
      case 'name':
        out.name = cleanText(v, 'Page name', 80);
        break;
      case 'width':
      case 'height':
        out[k] = num(v, `Page ${k}`, 1, 2000);
        break;
      case 'origin':
        out.origin = point(v, 'Page origin');
        break;
      case 'cellPx':
        out.cellPx = num(v, 'cellPx', 8, 512);
        break;
      case 'cellUnit':
        out.cellUnit = text(v, 'cellUnit', 20);
        break;
      case 'showGrid':
        out.showGrid = bool(v, 'showGrid');
        break;
      case 'background':
        out.background = background(v);
        break;
      case 'walls':
        out.walls = v === undefined ? undefined : walls(v);
        break;
      case 'vision':
        out.vision = v === undefined || v === null ? undefined : pageVision(v);
        break;
      case 'doors':
        out.doors = v === undefined ? undefined : pageDoors(v);
        break;
      case 'lights':
        out.lights = v === undefined ? undefined : pageLights(v);
        break;
      case 'doorState':
        out.doorState = v === undefined || v === null ? undefined : doorStates(v);
        break;
      case 'cliffs':
        out.cliffs = v === undefined ? undefined : pageCliffs(v);
        break;
      case 'respectHeights':
        out.respectHeights = v === undefined || v === null ? undefined : bool(v, 'respectHeights');
        break;
      case 'id':
        fail("A page's id can't be changed");
        break;
      default:
        fail(`Pages have no field "${k}"`);
    }
  }
  return out;
}

function turnPatch(state: GameState, set: Obj): Patch<TurnEntry> {
  const out: Patch<TurnEntry> = {};
  for (const [k, v] of Object.entries(set)) {
    switch (k) {
      case 'tokenId':
        if (v !== undefined && !findToken(state, v)) fail(`No token ${JSON.stringify(v)}`);
        out.tokenId = v as string | undefined;
        break;
      case 'name':
        out.name = cleanText(v, 'Turn entry name', 80);
        break;
      case 'initiative':
        out.initiative = num(v, 'Initiative', -1e6, 1e6);
        break;
      case 'id':
        fail("A turn entry's id can't be changed");
        break;
      default:
        fail(`Turn entries have no field "${k}"`);
    }
  }
  return out;
}

/** Dynamic vision can't hide anything of an uploaded picture: players load the image itself. */
function visionFits(page: Page): Page {
  if (page.vision?.mode === 'dynamic' && page.background.kind === 'image') {
    fail('Dynamic vision needs a page drawn from a Quillwarren map (or a blank one): a picture page’s image goes to the players whole');
  }
  return page;
}

/** A copy of `target` with `patch` applied; undefined values remove the field. */
function patched<T extends object>(target: T, patch: Patch<T>): T {
  const out = { ...target } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

/** Drop turn entries; the current turn stays with the same entry (or the next one if it went). */
function withoutEntries(turn: TurnOrder, drop: (e: TurnEntry) => boolean): TurnOrder {
  let current = turn.current;
  const entries = turn.entries.filter((e, i) => {
    if (!drop(e)) return true;
    if (i < turn.current) current--;
    return false;
  });
  if (current >= entries.length || current < 0) current = 0;
  return { ...turn, entries, current };
}

// ---------- applying ----------

interface Change {
  state: GameState;
  events: GameEvent[];
  chat?: ChatMessage;
  explored?: Outcome['explored'];
}

function removeTokens(state: GameState, ids: Set<string>): Change {
  const removed = state.tokens.filter((t) => ids.has(t.id));
  const events: GameEvent[] = [];
  // One event per page and visibility, so eventFor can route them after the tokens are gone.
  const groups = new Map<string, { pageId: string; hidden: boolean; ids: string[] }>();
  for (const t of removed) {
    const hidden = t.layer === 'gm';
    const key = `${t.pageId}\u0000${hidden}`;
    const group = groups.get(key) ?? { pageId: t.pageId, hidden, ids: [] };
    group.ids.push(t.id);
    groups.set(key, group);
  }
  for (const g of groups.values()) {
    events.push({ type: 'token.remove', ids: g.ids, pageId: g.pageId, ...(g.hidden ? { hidden: true } : {}) });
  }
  let next: GameState = { ...state, tokens: state.tokens.filter((t) => !ids.has(t.id)) };
  if (state.turn.entries.some((e) => e.tokenId !== undefined && ids.has(e.tokenId))) {
    next = { ...next, turn: withoutEntries(state.turn, (e) => e.tokenId !== undefined && ids.has(e.tokenId)) };
    events.push({ type: 'turn', turn: next.turn });
  }
  return { state: next, events };
}

function apply(state: GameState, memberId: string, intent: Intent, ctx: ApplyContext): Change {
  const turnEvent = (s: GameState): Change => ({ state: s, events: [{ type: 'turn', turn: s.turn }] });
  const needPage = (id: unknown): Page => state.pages.find((p) => p.id === id) ?? fail(`No page ${JSON.stringify(id)}`);
  const needToken = (id: unknown): Token => findToken(state, id) ?? fail(`No token ${JSON.stringify(id)}`);
  const needEntry = (id: unknown): TurnEntry => state.turn.entries.find((e) => e.id === id) ?? fail(`No turn entry ${JSON.stringify(id)}`);
  const needObj = (v: unknown, what: string): Obj => (isObj(v) ? v : fail(`${what} must be an object`));

  switch (intent.type) {
    case 'token.create': {
      if (state.tokens.length >= MAX_TOKENS) fail(`A game holds at most ${MAX_TOKENS} tokens`);
      const input = needObj(intent.token, 'token');
      const { id: wantId, pageId, ...fields } = input;
      const page = needPage(pageId);
      if (fields.x === undefined || fields.y === undefined || fields.image === undefined) fail('A new token needs x, y and an image');
      const id = newId(wantId, state.tokens.map((t) => t.id), 'k', 'Token');
      const base: Token = { id, pageId: page.id, layer: 'tokens', x: 0, y: 0, w: 1, h: 1, image: '/', controlledBy: [] };
      const token = patched(base, tokenPatch(state, fields));
      return { state: { ...state, tokens: [...state.tokens, token] }, events: [{ type: 'token.upsert', token }] };
    }
    case 'token.update':
    case 'token.move': {
      const old = needToken(intent.id);
      const patch =
        intent.type === 'token.move'
          ? { x: num(intent.x, 'Token x', -1000, 10000), y: num(intent.y, 'Token y', -1000, 10000) }
          : tokenPatch(state, needObj(intent.set, 'set'));
      const token = patched(old, patch);
      // nothing but the GM's notes changed: players needn't hear of it at all
      const keys = Object.keys(patch);
      const gmOnly = intent.type === 'token.update' && keys.length > 0 && keys.every((k) => k === 'gmNotes');
      return {
        state: { ...state, tokens: state.tokens.map((t) => (t.id === old.id ? token : t)) },
        events: [{ type: 'token.upsert', token, prevLayer: old.layer, ...(gmOnly ? { gmOnly: true } : {}) }],
      };
    }
    case 'token.delete': {
      const ids = idList(intent.ids, 'ids', 1000);
      for (const id of ids) needToken(id);
      return removeTokens(state, new Set(ids));
    }

    case 'page.create': {
      if (state.pages.length >= MAX_PAGES) fail(`A game holds at most ${MAX_PAGES} pages`);
      const input = needObj(intent.page, 'page');
      const { id: wantId, ...fields } = input;
      const id = newId(wantId, state.pages.map((p) => p.id), 'pg', 'Page');
      const page = visionFits(patched(defaultPage(id, `Page ${state.pages.length + 1}`), pagePatch(fields)));
      return { state: { ...state, pages: [...state.pages, page] }, events: [{ type: 'page.upsert', page }] };
    }
    case 'page.update': {
      const old = needPage(intent.id);
      const page = visionFits(patched(old, pagePatch(needObj(intent.set, 'set'))));
      return { state: { ...state, pages: state.pages.map((p) => (p.id === old.id ? page : p)) }, events: [{ type: 'page.upsert', page }] };
    }
    case 'page.delete': {
      const page = needPage(intent.id);
      if (state.pages.length === 1) fail('A game needs at least one page');
      const pages = state.pages.filter((p) => p.id !== page.id);
      const onPage = new Set(state.tokens.filter((t) => t.pageId === page.id).map((t) => t.id));
      const gone = removeTokens({ ...state, pages }, onPage);
      // Members on the deleted page get a fresh view anyway, so its token.remove events aren't needed.
      const events: GameEvent[] = [{ type: 'page.remove', id: page.id, ...(state.playerPageId === page.id ? { wasPlayerPage: true } : {}) }];
      events.push(...gone.events.filter((e) => e.type === 'turn'));
      let next = gone.state;
      const fallback = pages[0]?.id ?? '';
      if (state.playerPageId === page.id) {
        next = { ...next, playerPageId: fallback };
        events.push({ type: 'page.switch', pageId: fallback, audience: 'players' }, { type: 'game', name: next.name, playerPageId: fallback });
      }
      if (state.gmPageId === page.id) {
        next = { ...next, gmPageId: next.playerPageId };
        events.push({ type: 'page.switch', pageId: next.playerPageId, audience: 'gm' });
      }
      return { state: next, events };
    }
    case 'page.view': {
      const page = needPage(intent.id);
      return { state: { ...state, gmPageId: page.id }, events: [{ type: 'page.switch', pageId: page.id, audience: 'gm' }] };
    }
    case 'page.activate': {
      const page = needPage(intent.id);
      return {
        state: { ...state, playerPageId: page.id },
        events: [
          { type: 'page.switch', pageId: page.id, audience: 'players' },
          { type: 'game', name: state.name, playerPageId: page.id },
        ],
      };
    }

    case 'chat.send': {
      const parsed = parseChat(state, memberId, intent.text, ctx.rng);
      const seq = ctx.nextSeq();
      const chat: ChatMessage = {
        id: `m${seq}`,
        seq,
        at: ctx.now,
        from: parsed.from ?? memberId,
        speaker: parsed.speaker,
        kind: parsed.kind,
        text: parsed.text,
      };
      if (parsed.rolls) chat.rolls = parsed.rolls;
      if (parsed.to) chat.to = parsed.to;
      return { state, events: [], chat };
    }

    case 'turn.add': {
      if (state.turn.entries.length >= MAX_TURN_ENTRIES) fail(`The turn order holds at most ${MAX_TURN_ENTRIES} entries`);
      const input = needObj(intent.entry, 'entry');
      const { id: wantId, ...fields } = input;
      const token = fields.tokenId === undefined ? undefined : needToken(fields.tokenId);
      if (fields.name === undefined) {
        if (!token) fail('A turn entry needs a name or a token');
        fields.name = token.name?.trim() || 'Token';
      }
      if (fields.initiative === undefined) fields.initiative = 0;
      const id = newId(wantId, state.turn.entries.map((e) => e.id), 't', 'Turn entry');
      const entry = patched({ id, name: '', initiative: 0 } as TurnEntry, turnPatch(state, fields));
      return turnEvent({ ...state, turn: { ...state.turn, entries: [...state.turn.entries, entry] } });
    }
    case 'turn.update': {
      const old = needEntry(intent.id);
      const entry = patched(old, turnPatch(state, needObj(intent.set, 'set')));
      return turnEvent({ ...state, turn: { ...state.turn, entries: state.turn.entries.map((e) => (e.id === old.id ? entry : e)) } });
    }
    case 'turn.remove': {
      const old = needEntry(intent.id);
      return turnEvent({ ...state, turn: withoutEntries(state.turn, (e) => e.id === old.id) });
    }
    case 'turn.sort': {
      const { turn } = state;
      const currentId = turn.entries[turn.current]?.id;
      const entries = [...turn.entries].sort((a, b) => b.initiative - a.initiative); // stable
      const current = Math.max(0, entries.findIndex((e) => e.id === currentId));
      return turnEvent({ ...state, turn: { ...turn, entries, current } });
    }
    case 'turn.next': {
      const { turn } = state;
      if (turn.entries.length === 0) fail('The turn order is empty');
      const wrap = turn.current + 1 >= turn.entries.length;
      return turnEvent({ ...state, turn: { ...turn, current: wrap ? 0 : turn.current + 1, round: wrap ? turn.round + 1 : turn.round } });
    }
    case 'turn.clear':
      return turnEvent({ ...state, turn: { entries: [], current: 0, round: 1, visible: state.turn.visible } });
    case 'turn.visible':
      return turnEvent({ ...state, turn: { ...state.turn, visible: bool(intent.visible, 'visible') } });

    case 'member.remove': {
      const target = findMember(state, intent.id) ?? fail(`No member ${JSON.stringify(intent.id)}`);
      if (target.role === 'gm') fail("The GM can't be removed");
      const events: GameEvent[] = [];
      const members = state.members.filter((m) => m.id !== target.id);
      events.push({ type: 'members', members });
      const tokens = state.tokens.map((t) => {
        if (!t.controlledBy.includes(target.id)) return t;
        const token = { ...t, controlledBy: t.controlledBy.filter((id) => id !== target.id) };
        events.push({ type: 'token.upsert', token, prevLayer: t.layer });
        return token;
      });
      return { state: { ...state, members, tokens }, events };
    }
    case 'member.rename': {
      const target = findMember(state, intent.id) ?? fail(`No member ${JSON.stringify(intent.id)}`);
      const name = memberName(state, intent.name, target.id);
      const members = state.members.map((m) => (m.id === target.id ? { ...m, name } : m));
      return { state: { ...state, members }, events: [{ type: 'members', members }] };
    }
    case 'game.rename': {
      const name = cleanText(intent.name, 'Game name', 80);
      return { state: { ...state, name }, events: [{ type: 'game', name, playerPageId: state.playerPageId }] };
    }

    case 'door.set': {
      const page = needPage(intent.pageId);
      const id = intent.id as unknown;
      if (typeof id !== 'string' || !(page.doors ?? []).some((d) => d.id === id)) fail(`No door ${JSON.stringify(id)?.slice(0, 70)} on that page`);
      const open = bool(intent.open, 'open');
      const doorState: Record<string, boolean> = { ...(page.doorState ?? {}) };
      doorState[id] = open;
      const next: Page = { ...page, doorState };
      return { state: { ...state, pages: state.pages.map((p) => (p.id === page.id ? next : p)) }, events: [{ type: 'page.upsert', page: next }] };
    }
    case 'vision.explored': {
      const page = needPage(intent.pageId);
      const action = intent.action as unknown;
      if (action !== 'reset' && action !== 'reveal' && action !== 'hide') fail('action must be reset, reveal or hide');
      return { state, events: [], explored: { pageId: page.id, action } };
    }
  }
}

/** Validate, check permission and apply one intent. Throws TableError when refused or invalid. */
export function applyIntent(state: GameState, memberId: string, intent: Intent, ctx: ApplyContext): Outcome {
  if (!findMember(state, memberId)) throw new TableError("You aren't in this game");
  const raw = intent as unknown;
  if (!isObj(raw) || typeof raw.type !== 'string') throw new TableError('An intent needs a type');
  if (!INTENT_TYPES.has(raw.type)) throw new TableError(`Unknown intent ${JSON.stringify(raw.type).slice(0, 40)}`);
  const allowed = can(state, memberId, intent);
  if (allowed !== true) throw new TableError(allowed);
  const change = apply(state, memberId, intent, ctx);
  const out: Outcome = { state: { ...change.state, rev: state.rev + 1 }, events: change.events };
  if (change.chat) out.chat = change.chat;
  if (change.explored) out.explored = change.explored;
  return out;
}
