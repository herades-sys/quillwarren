// Building families: rooms beside rooms (with corridors and doors), corridors
// between rooms, doors on named walls, and whole small layouts on an empty map.
import { doorCentre, doorLeadsTo, type DelveMap } from '@delve/core';
import {
  boxOf,
  corridorBetween,
  corridorDoors,
  idRange,
  list,
  n,
  ofType,
  roomById,
  roomRef,
  toOutline,
  unitOf,
  wallOf,
  isRect,
  boxGap,
  newProblems,
  type Room,
  type Door,
} from '../kit.ts';
import type { Rng } from '../rng.ts';
import { call, OPPOSITE, said, SIDES, type Call, type DoorStyle, type Side } from '../tools.ts';
import { ROOM_KINDS } from '../words.ts';
import { an, ask, numAfter, numWord, refRoom, sidePhrase, sizePhrase, skip, STYLE_WORDS, styleAs, works, type Family, type FamilyResult } from './common.ts';
import { groupCalls } from './furnish.ts';

const DOOR_STYLES_MIX: [DoorStyle, number][] = [
  ['normal', 40],
  ['locked', 18],
  ['secret', 14],
  ['double', 8],
  ['portcullis', 6],
  ['archway', 14],
];

const styleWord = (rng: Rng, s: DoorStyle) => rng.pick(STYLE_WORDS[s]!);

/** A size in the map's own units when it comes out even ("30 ft", "9 m"), for requests that give units. */
function unitSize(map: DelveMap, squares: number): string | null {
  const u = unitOf(map);
  const v = squares * u.size;
  return Number.isInteger(v) || Number.isInteger(v * 2) ? `${n(v)} ${u.name}` : null;
}

const usedNames = (m: DelveMap) => new Set(ofType(m, 'room').map((r) => r.name?.toLowerCase()).filter(Boolean));

function freshName(rng: Rng, m: DelveMap, kinds?: string[]): { name: string; kind: string } | undefined {
  const taken = usedNames(m);
  for (let k = 0; k < 8; k++) {
    const kind = rng.pick(kinds ?? Object.keys(ROOM_KINDS).filter((x) => x !== 'plain'));
    const name = rng.pick(ROOM_KINDS[kind]!);
    if (!taken.has(name.toLowerCase())) return { name, kind };
  }
  return undefined;
}

const sideOk = (side: Side, nb: ReturnType<typeof boxOf>, bb: ReturnType<typeof boxOf>): boolean =>
  side === 'east' ? nb.x0 >= bb.x1 - 0.01 : side === 'west' ? nb.x1 <= bb.x0 + 0.01 : side === 'north' ? nb.y1 <= bb.y0 + 0.01 : nb.y0 >= bb.y1 - 0.01;

const removedIds = (start: DelveMap, final: DelveMap): string[] => {
  const now = new Set(final.objects.map((o) => o.id));
  return start.objects.filter((o) => !now.has(o.id)).map((o) => o.id);
};

const leadsWords = (text: string): string =>
  text === 'leads outside' ? 'it leads outside' : text.startsWith('into ') ? `it opens ${text.replace(/ \(r\d+\)$/, '')}` : `it opens ${text}`;

// ---------- a room beside a room ----------

export const roomBeside: Family = {
  id: 'room_beside',
  title: 'A new room beside an existing one (side, size, units, corridor, door style, name)',
  weight: 10,
  start: (rng) => ({ kind: rng.chance(0.8) ? 'dungeon' : 'small', furnished: rng.chance(0.35) }),
  async run({ rng, convo }): Promise<FamilyResult> {
    const map = convo.map;
    const rooms = ofType(map, 'room');
    if (!rooms.length) skip('no rooms');
    for (let attempt = 0; attempt < 14; attempt++) {
      const base = rng.pick(rooms);
      const side = rng.pick(SIDES);
      const [w, h] = [rng.weighted<number>([[3, 1], [4, 4], [5, 4], [6, 4], [7, 2], [8, 2], [10, 1]]), rng.weighted<number>([[3, 1], [4, 4], [5, 4], [6, 4], [7, 2], [8, 2]])];
      const connect = rng.chance(0.85);
      const door = connect && rng.chance(0.78) ? rng.weighted(DOOR_STYLES_MIX) : undefined;
      const named = rng.chance(0.5) ? freshName(rng, map) : undefined;
      const gap = rng.chance(0.1) ? rng.int(1, 4) : undefined;
      const us = rng.chance(0.25) ? [unitSize(map, w), unitSize(map, h)] : [null, null];
      const withUnits = us[0] !== null && us[1] !== null;
      const size: [number | string, number | string] = withUnits ? [us[0]!, us[1]!] : [w, h];
      const c = call.roomBeside({ beside: base.id, side, size, gap, connect, door, name: named?.name });
      if (!(await works(convo, c))) continue;

      const ref = refRoom(rng, base, { selectable: false });
      const sizeText = withUnits
        ? rng.weighted<string>([
            [`${us[0]} by ${us[1]}`, 3],
            [`${us[0]} × ${us[1]}`, 2],
            [`${(us[0] as string).replace(/ (ft|m)$/, '')} by ${us[1]}`, 3],
          ])
        : sizePhrase(rng, w, h);
      const what = named
        ? rng.weighted<string>([
            [`${an(sizeText)} ${named.name.toLowerCase()}`, 3],
            [`${an(sizeText)} room called "${named.name}"`, 2],
            [`a new ${named.name.toLowerCase()}, ${sizeText},`, 2],
            [`${an(sizeText)} room for the ${named.name.toLowerCase()}`, 1],
          ])
        : rng.weighted<string>([
            [`${an(sizeText)} room`, 5],
            [`a new ${sizeText} room`, 2],
            [`another room, ${sizeText},`, 1],
          ]);
      const sq = gap === 1 ? 'square' : 'squares';
      const gapText = gap ? rng.pick([` ${numAfter(rng, gap, ref.text)} ${sq} away`, `, ${numWord(rng, gap)} ${sq} from it,`, ` with a gap of ${gap} ${sq}`]) : '';
      const joint = !connect
        ? rng.weighted<string>([
            ['', 5],
            [' (no corridor yet)', 1],
          ])
        : door
          ? rng.weighted<string>([
              [`, joined to it by a corridor with ${an(styleWord(rng, door))}`, 4],
              [` and connect it with a corridor and ${an(styleWord(rng, door))}`, 3],
              [` with ${an(styleWord(rng, door))} and a corridor between them`, 2],
              [`, connected by a corridor; put ${an(styleWord(rng, door))} where it enters the new room`, 1],
            ])
          : rng.weighted<string>([
              [', joined by a corridor', 3],
              [' and connect them with a corridor (no door)', 2],
              [', with an open corridor between them', 1],
            ]);
      const verb = rng.weighted<string>([['add', 6], ['build', 2], ['make', 1], ['put', 1]]);
      const request = ask(rng, `${verb} ${what} ${sidePhrase(rng, side)} ${ref.text}${gapText}${joint}`.replace(/,,/g, ',').replace(/, ([,.])/g, '$1'));

      await convo.user(request);
      const [r] = await convo.step(c);
      const room = r!.added.find((o): o is Room => o.type === 'room')!;
      const corridor = r!.added.find((o) => o.type === 'corridor');
      const d = r!.added.find((o): o is Door => o.type === 'door');
      const b = boxOf(room);
      const dims = `${n(b.x1 - b.x0)}×${n(b.y1 - b.y0)}`;
      const head = rng.weighted<string>([
        [`Added ${named ? `${named.name.toLowerCase()} ` : 'room '}${room.id} (${dims})`, 3],
        [`Added room ${room.id}${named ? ` "${named.name}"` : ''}, ${dims} squares,`, 2],
      ]);
      const join = corridor ? `, joined by corridor ${corridor.id}${d ? ` with ${an(d.style ?? 'normal')} door ${d.id}` : ''}` : '';
      await convo.answer(`${head} ${side} of ${roomRef(base)}${join}.`.replace(/, (\w+ of)/, ' $1'));

      const expect = [w, h];
      return {
        variant: `${connect ? (door ? 'door' : 'corridor') : 'alone'}${withUnits ? '+units' : ''}`,
        check(final, start) {
          const errs: string[] = [];
          const added = ofType(final, 'room').filter((x) => !start.objects.some((o) => o.id === x.id));
          if (added.length !== 1) errs.push(`${added.length} new rooms`);
          const nr = added[0];
          const br = roomById(final, base.id);
          if (!nr || !br) return [...errs, 'room missing'];
          const nb = boxOf(nr);
          if (n(nb.x1 - nb.x0) !== n(expect[0]!) || n(nb.y1 - nb.y0) !== n(expect[1]!)) errs.push(`size ${nb.x1 - nb.x0}×${nb.y1 - nb.y0}, wanted ${expect.join('×')}`);
          if (!sideOk(side, nb, boxOf(br))) errs.push(`not ${side} of ${base.id}`);
          const cor = corridorBetween(final, base.id, nr.id);
          if (connect && !cor) errs.push('no corridor');
          if (!connect && cor) errs.push('unasked corridor');
          if (door && cor && !corridorDoors(final, cor).some((x) => (x.style ?? 'normal') === door)) errs.push(`no ${door} door`);
          if (named && nr.name !== named.name) errs.push('name');
          if (removedIds(start, final).length) errs.push('removed objects');
          return errs;
        },
      };
    }
    skip('no free spot beside any room');
  },
};

// ---------- a corridor between two rooms ----------

export const connectRooms: Family = {
  id: 'connect_rooms',
  title: 'A corridor between two existing rooms (doors at one or both ends, styles, width)',
  weight: 4,
  start: () => ({ kind: 'dungeon', rooms: [4, 9] }),
  async run({ rng, convo }) {
    const map = convo.map;
    const rooms = ofType(map, 'room');
    const pairs: [Room, Room][] = [];
    for (const a of rooms) for (const b of rooms) if (a.id < b.id && !corridorBetween(map, a.id, b.id) && boxGap(boxOf(a), boxOf(b)) <= 10) pairs.push([a, b]);
    for (const [a0, b0] of rng.shuffle(pairs).slice(0, 8)) {
      const [a, b] = rng.chance(0.5) ? [a0, b0] : [b0, a0];
      const doors = rng.weighted<'none' | 'from' | 'to' | 'both'>([['both', 35], ['to', 25], ['from', 15], ['none', 25]]);
      const style = doors !== 'none' && rng.chance(0.6) ? rng.weighted(DOOR_STYLES_MIX) : undefined;
      const narrow = rng.chance(0.2);
      const c = call.connect({ from: a.id, to: b.id, doors: doors === 'none' ? undefined : doors, doorStyle: style, width: narrow ? 1 : undefined });
      if (!(await works(convo, c))) continue;
      const ra = refRoom(rng, a, { selectable: false }).text;
      const rb = refRoom(rng, b, { selectable: false }).text;
      const sw = style ? styleWord(rng, style) : 'door';
      const doorText =
        doors === 'both'
          ? rng.pick([`, with ${an(sw)} at each end`, `, with doors at both ends${style && style !== 'normal' ? ` (${style})` : ''}`])
          : doors === 'to'
            ? rng.pick([`, with ${an(sw)} where it enters ${rb}`, `, ${an(sw)} on the ${rb.replace(/^the /, "")} end`])
            : doors === 'from'
              ? rng.pick([`, with ${an(sw)} at the ${ra.replace(/^the /, "")} end`, `, ${an(sw)} where it leaves ${ra}`])
              : rng.pick(['', '', ', no doors']);
      const narrowText = narrow ? rng.pick([', 1 square wide', ' (narrow, one square wide)', ', only 1 wide']) : '';
      const what = narrow && rng.chance(0.5) ? 'a narrow corridor' : rng.pick(['a corridor', 'a passage', 'a hallway']);
      const imperative = rng.weighted<string>([
        [`connect ${ra} to ${rb} with ${what}${narrowText}${doorText}`, 4],
        [`join ${ra} and ${rb} with ${what}${narrowText}${doorText}`, 3],
        [`add ${what} between ${ra} and ${rb}${narrowText}${doorText}`, 3],
        [`run ${what} from ${ra} to ${rb}${narrowText}${doorText}`, 1],
      ]);
      await convo.user(ask(rng, imperative));
      const [r] = await convo.step(c);
      const cor = r!.added.find((o) => o.type === 'corridor')!;
      const ds = r!.added.filter((o): o is Door => o.type === 'door');
      const doorsText = ds.length === 0 ? '' : ds.length === 1 ? ` with ${an(ds[0]!.style ?? 'normal')} door ${ds[0]!.id} at the ${doors === 'to' ? roomRef(b) : roomRef(a)} end` : ` with ${ds[0]!.style === 'normal' ? '' : `${ds[0]!.style} `}doors ${ds.map((x) => x.id).join(' and ')}`;
      const round = said.routedAround(r!.text) ? ' It goes round the rooms in between.' : '';
      await convo.answer(`Added corridor ${cor.id} from ${roomRef(a)} to ${roomRef(b)}${narrow ? ', 1 square wide,' : ''}${doorsText}.${round}`);
      const want = doors === 'both' ? 2 : doors === 'none' ? 0 : 1;
      return {
        variant: `${doors}${narrow ? '+narrow' : ''}`,
        check(final, start) {
          const errs: string[] = [];
          const k = corridorBetween(final, a.id, b.id);
          if (!k) return ['no corridor'];
          const added = ofType(final, 'door').filter((x) => !start.objects.some((o) => o.id === x.id));
          if (added.length !== want) errs.push(`${added.length} doors, wanted ${want}`);
          if (style && added.some((x) => (x.style ?? 'normal') !== style)) errs.push('door style');
          if (narrow && k.width !== 1) errs.push('width');
          if (removedIds(start, final).length) errs.push('removed objects');
          return errs;
        },
      };
    }
    skip('no pair of rooms to join');
  },
};

// ---------- a door on a named wall ----------

export const doorWall: Family = {
  id: 'door_wall',
  title: 'A door on a named wall of a room (style, width, where it leads)',
  weight: 6,
  start: (rng) => ({ kind: rng.weighted<'dungeon' | 'small' | 'outdoor'>([['dungeon', 6], ['small', 3], ['outdoor', 1]]), furnished: rng.chance(0.3) }),
  async run({ rng, convo }) {
    const map = convo.map;
    const rooms = ofType(map, 'room').filter(isRect);
    if (!rooms.length) skip('no box rooms');
    for (let attempt = 0; attempt < 12; attempt++) {
      const room = rng.pick(rooms);
      const wall = rng.pick(SIDES);
      const style = rng.weighted(DOOR_STYLES_MIX);
      const wide = (style === 'double' && rng.chance(0.6)) || (style === 'archway' && rng.chance(0.3)) || rng.chance(0.05);
      const c = call.doorOnWall({ room: room.id, wall, style: style === 'normal' && rng.chance(0.5) ? undefined : style, width: wide ? 2 : undefined });
      const probe = await works(convo, c);
      if (!probe) continue;
      const ref = refRoom(rng, room);
      const sw = styleWord(rng, style);
      const wideText = wide ? rng.pick([' 2 squares wide', ', 2 wide,', ' (two squares wide)']) : '';
      const imperative = rng.weighted<string>([
        [`put ${an(sw)}${wideText} in the ${wall} wall of ${ref.text}`, 4],
        [`add ${an(sw)}${wideText} on the ${wall} side of ${ref.text}`, 3],
        [`give ${ref.text} ${an(sw)}${wideText} in its ${wall} wall`, 2],
        [`make ${an(sw)}${wideText} in ${ref.text}'s ${wall} wall`, 1],
        [`NEEDS:${ref.text} needs ${an(sw)}${wideText} on the ${wall} wall`, 1],
      ]);
      const said0 = imperative.replace(/,(\s+in| on)/, '$1');
      // a statement ("room 8 needs an archway …") is said as it is; the rest are imperatives in one of the ways people ask
      await convo.user(said0.startsWith('NEEDS:') ? `${said0.slice(6).charAt(0).toUpperCase()}${said0.slice(7)}.` : ask(rng, said0), ref.selection ? { selection: ref.selection } : {});
      const [r] = await convo.step(c);
      const d = r!.added.find((o): o is Door => o.type === 'door')!;
      const out = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[wall] as [number, number];
      const leads = leadsWords(doorLeadsTo(r!.map, room.id, doorCentre(d), out));
      await convo.answer(`Added ${an(d.style ?? 'normal')} door ${d.id}${wide ? ' (2 squares wide)' : ''} in the ${wall} wall of ${roomRef(room)}; ${leads}.`);
      return {
        variant: `${style}${wide ? '+wide' : ''}`,
        check(final, start) {
          const added = ofType(final, 'door').filter((x) => !start.objects.some((o) => o.id === x.id));
          if (added.length !== 1) return [`${added.length} new doors`];
          const x = added[0]!;
          const rb = boxOf(roomById(final, room.id)!);
          const errs: string[] = [];
          if ((x.style ?? 'normal') !== style) errs.push('style');
          if (toOutline(doorCentre(x), rb) > 0.3 || wallOf(doorCentre(x), rb) !== wall) errs.push('not on that wall');
          if (wide && x.width !== 2) errs.push('width');
          return errs;
        },
      };
    }
    skip('no free wall');
  },
};

// ---------- a small layout from scratch ----------

interface Planned {
  name: string;
  size: [number, number];
  beside?: number;
  side?: Side;
  door?: DoorStyle;
}

const LAYOUTS: { what: string[]; kinds: string[] }[] = [
  { what: ['hideout', "smugglers' hideout", 'bandit hideout'], kinds: ['store', 'barracks', 'guard', 'treasury', 'plain'] },
  { what: ['guard outpost', 'watch post', 'small fort'], kinds: ['guard', 'barracks', 'armoury', 'store', 'kitchen'] },
  { what: ['temple', 'small shrine complex', 'monastery wing'], kinds: ['shrine', 'library', 'bedroom', 'store', 'plain'] },
  { what: ['goblin lair', 'kobold den', 'orc camp underground'], kinds: ['hall', 'store', 'treasury', 'prison', 'plain'] },
  { what: ["wizard's cellar", 'mage tower basement', "alchemist's workshop"], kinds: ['lab', 'library', 'store', 'bedroom', 'treasury'] },
  { what: ['dwarven mine office', 'mine entrance', 'forge hall'], kinds: ['smithy', 'store', 'barracks', 'hall', 'guard'] },
  { what: ['manor cellar', 'inn basement', 'tavern'], kinds: ['tavern', 'kitchen', 'store', 'bedroom', 'plain'] },
];

export const scratchBuild: Family = {
  id: 'scratch_build',
  title: 'Several rooms from scratch on an empty map: first room by rect, the rest beside it, then check_map',
  weight: 4,
  start: () => ({ kind: 'empty' }),
  async run({ rng, convo }) {
    const map = convo.map;
    const layout = rng.pick(LAYOUTS);
    const what = rng.pick(layout.what);
    const count = rng.weighted<number>([[2, 2], [3, 4], [4, 3], [5, 2], [6, 1]]);
    const kinds = rng.sample(layout.kinds, count).concat(Array(Math.max(0, count - layout.kinds.length)).fill('plain'));
    const taken = new Set<string>();
    const plan: Planned[] = kinds.map((k, i) => {
      let name = rng.pick(ROOM_KINDS[k]!);
      for (let t = 0; t < 5 && taken.has(name); t++) name = rng.pick(ROOM_KINDS[rng.pick(Object.keys(ROOM_KINDS))]!);
      taken.add(name);
      const size: [number, number] = i === 0 ? [rng.int(5, 10), rng.int(4, 8)] : [rng.int(3, 8), rng.int(3, 7)];
      return { name, size };
    });
    // a tree: each later room beside an earlier one
    const special = count >= 3 && rng.chance(0.6) ? rng.pick<DoorStyle>(['locked', 'secret', 'portcullis', 'locked', 'double']) : undefined;
    const specialAt = special ? rng.int(1, count - 1) : -1;
    // sides already taken round each room: the way back to its own parent and its other children
    const usedSides = plan.map(() => new Set<Side>());
    for (let i = 1; i < count; i++) {
      let parent = rng.chance(0.6) ? i - 1 : rng.int(0, i - 1);
      if (usedSides[parent]!.size >= 4) parent = usedSides.findIndex((s, j) => j < i && s.size < 4);
      const side = rng.pick(SIDES.filter((s) => !usedSides[parent]!.has(s)));
      plan[i]!.beside = parent;
      plan[i]!.side = side;
      usedSides[parent]!.add(side);
      usedSides[i]!.add(OPPOSITE[side]);
      plan[i]!.door = i === specialAt ? special! : rng.weighted<DoorStyle>([['normal', 8], ['archway', 1], ['double', 1]]);
    }
    const origin: [number, number] = rng.pick([[0, 0], [1, 1], [2, 2], [0, 0], [4, 2], [5, 5]] as [number, number][]);
    const first: Call = call.roomRect({ rect: [origin[0], origin[1], plan[0]!.size[0], plan[0]!.size[1]], name: plan[0]!.name });
    const outside = rng.chance(0.4) ? rng.pick(SIDES) : undefined;
    // the whole plan must work on a copy first
    const ids = plan.map((_, i) => `r${i + 1}`);
    const calls: Call[] = [first, ...plan.slice(1).map((p) => call.roomBeside({ beside: ids[p.beside!]!, side: p.side!, size: p.size, connect: true, door: p.door, name: p.name }))];
    if (outside) calls.push(call.doorOnWall({ room: 'r1', wall: outside, style: rng.pick<DoorStyle>(['normal', 'double', 'portcullis']) }));
    if (!(await works(convo, ...calls))) skip('plan does not fit');

    const detailed = rng.chance(0.65);
    const roomText = (p: Planned, i: number) => {
      const nm = p.name.toLowerCase();
      if (i === 0) return `${an(sizePhrase(rng, p.size[0], p.size[1]))} ${nm}`;
      const rel = `${sidePhrase(rng, p.side!)} the ${plan[p.beside!]!.name.toLowerCase()}`;
      return `${an(sizePhrase(rng, p.size[0], p.size[1]))} ${nm} ${rel}`;
    };
    let request: string;
    if (detailed) {
      const parts = plan.map(roomText);
      const doorsText = special ? ` Make the door into the ${plan[specialAt]!.name.toLowerCase()} ${special === 'secret' ? 'a secret door' : special === 'portcullis' ? 'a portcullis' : special === 'double' ? 'a double door' : 'locked'}.` : '';
      const out = outside ? ` Put a way in on the ${outside} side of the ${plan[0]!.name.toLowerCase()}.` : '';
      const start = rng.pick([`Build ${/^small /.test(what) ? an(what) : `a small ${what}`} on this empty map: `, `Let's make ${an(what)}. `, `New ${what}: `, `On this empty map, build ${an(what)} with `]);
      request = `${start}${list(parts)}, all joined by corridors with doors.${doorsText}${out}`;
      if (origin[0] === 0 && origin[1] === 0 && rng.chance(0.5)) request = request.replace(`${plan[0]!.name.toLowerCase()}`, `${plan[0]!.name.toLowerCase()} in the top-left corner`);
    } else {
      const special2 = special ? ` One of the doors should be ${special === 'secret' ? 'a secret door' : special === 'portcullis' ? 'a portcullis' : special === 'double' ? 'a double door' : 'locked'}.` : '';
      request = rng.pick([
        `Make me a ${count}-room ${what} on this empty map, connected with corridors and doors.${special2}`,
        `Build ${/^small /.test(what) ? an(what) : `a small ${what}`} with ${numWord(rng, count)} rooms, all connected.${special2}`,
        `Can you sketch ${an(what)}? ${count} rooms joined by corridors with doors.${special2}`,
      ]);
      if (outside) request += ` Add an entrance from outside too.`;
    }
    await convo.user(request);
    // first the room the others stand beside, then each room once the one it stands beside exists
    await convo.step(first);
    // then the others in order (so their ids come out as planned), one reply per run of rooms whose neighbour already exists
    const rest = plan.map((_, i) => i).slice(1);
    for (const group of groupCalls(rest, (i) => plan[i]!.beside)) await convo.step(...group.map((i) => calls[i]!));
    if (outside) await convo.step(calls[calls.length - 1]!);
    const check = await convo.step(call.check());
    if (!said.noProblems(check[0]!.text)) skip('check_map not clean');
    const final = convo.map;
    const corridors = ofType(final, 'corridor').map((c) => c.id);
    const doors = ofType(final, 'door');
    const specialDoor = special ? doors.find((d) => d.style === special) : undefined;
    const outDoor = outside ? doors[doors.length - 1] : undefined;
    const names = ofType(final, 'room').map((r) => `${r.name?.toLowerCase()} ${r.id}`);
    await convo.answer(
      `Built the ${what}: ${list(names)}, joined by corridor${corridors.length > 1 ? 's' : ''} ${idRange(corridors)} with doors.` +
        `${specialDoor ? ` Door ${specialDoor.id} into the ${plan[specialAt]!.name.toLowerCase()} is ${styleAs(special!)}.` : ''}` +
        `${outDoor ? ` ${outDoor.id} on the ${outside} wall of r1 leads outside.` : ''} check_map finds no problems.`,
    );
    return {
      variant: `${count}-rooms${detailed ? '' : '+vague'}`,
      check(f) {
        const errs: string[] = [];
        const rs = ofType(f, 'room');
        if (rs.length !== count) errs.push(`${rs.length} rooms`);
        if (ofType(f, 'corridor').length !== count - 1) errs.push('corridors');
        for (let i = 1; i < count; i++) if (!corridorBetween(f, ids[i]!, ids[plan[i]!.beside!]!)) errs.push(`r${i + 1} not joined`);
        if (special && !ofType(f, 'door').some((d) => d.style === special)) errs.push('special door');
        if (newProblems(map, f).length) errs.push('problems');
        return errs;
      },
    };
  },
};

