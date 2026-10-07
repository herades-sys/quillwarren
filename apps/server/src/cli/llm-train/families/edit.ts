// Editing families: renaming, relabelling, notes and door styles (update),
// moving rooms and props, resizing rooms, and deleting things (asking first
// before a large part of the map goes).
import { pointInShape, shapeBounds, type DelveMap, type MapObject } from '@delve/core';
import {
  assetName,
  boxOf,
  byId,
  corridorDoors,
  corridorsOf,
  doorsByWall,
  doorsOf,
  idRange,
  isRect,
  list,
  n,
  ofType,
  propsIn,
  rectOf,
  roomById,
  roomRef,
  unitOf,
  uniqueName,
  type Door,
  type Prop,
  type Rect,
  type Room,
} from '../kit.ts';
import type { Rng } from '../rng.ts';
import { call, said, SIDES, type Call, type DoorStyle, type Side } from '../tools.ts';
import { DICTATED_NOTES } from '../words.ts';
import { an, ask, numAfter, numWord, refRoom, skip, STYLE_WORDS, styleAs, works, type Family, type FamilyResult } from './common.ts';

const removed = (start: DelveMap, final: DelveMap): string[] => {
  const now = new Set(final.objects.map((o) => o.id));
  return start.objects.filter((o) => !now.has(o.id)).map((o) => o.id);
};
const addedObjects = (start: DelveMap, final: DelveMap): MapObject[] => final.objects.filter((o) => !byId(start, o.id));

const NEW_NAMES = ['Chapel', 'Guard post', 'Larder', 'Wine cellar', 'Bone pit', 'Map room', 'Study', 'Dormitory', 'Vestry', 'Kennels', 'Mess hall', 'Well room', 'Trophy room', 'Lookout', 'Workshop', 'Ritual chamber', 'Sleeping quarters', 'Bath house', 'Shrine of the Moon', "Captain's cabin", 'Lair', 'Pantry', 'Hall of Statues', 'Gallery'];
const DIRS: Record<Side, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const dirWords = (rng: Rng, s: Side) => rng.weighted<string>([[s, 6], [`to the ${s}`, 2], [{ north: 'up', south: 'down', east: 'to the right', west: 'to the left' }[s], 1]]);

// ---------- update: names, numbers, notes, door styles ----------

type Edit = { calls: Call[]; request: string; answer: string; variant: string; check(f: DelveMap): string[] };

async function renameEdit(rng: Rng, m: DelveMap, room: Room): Promise<Edit | null> {
  const taken = new Set(ofType(m, 'room').map((r) => r.name?.toLowerCase()));
  const name = rng.pick(NEW_NAMES.filter((x) => !taken.has(x.toLowerCase())));
  const ref = refRoom(rng, room, { unique: uniqueName(m, room) });
  const imperative = rng.weighted<string>([
    [`rename ${ref.text} to "${name}"`, 4],
    [`call ${ref.text} the ${name}`, 2],
    [`change the name of ${ref.text} to ${name}`, 2],
    [`name ${ref.text} "${name}"`, 2],
  ]);
  return {
    calls: [call.update(room.id, call.set.name(name))],
    request: ask(rng, imperative) + (ref.selection ? '' : ''),
    answer: `Renamed ${roomRef(room)} to "${name}".`,
    variant: 'rename',
    check: (f) => (roomById(f, room.id)?.name === name ? [] : ['name']),
  };
}

async function relabelEdit(rng: Rng, m: DelveMap, room: Room): Promise<Edit | null> {
  const used = new Set(ofType(m, 'room').map((r) => r.label));
  let k = rng.int(7, 40);
  while (used.has(String(k))) k++;
  const ref = refRoom(rng, room, { selectable: false, unique: uniqueName(m, room) });
  const imperative = rng.pick([`change the number of ${ref.text} to ${k}`, `give ${ref.text} the room number ${k}`, `renumber ${ref.text} as ${k}`, `make ${ref.text} room ${k}`]);
  return {
    calls: [call.update(room.id, call.set.label(String(k)))],
    request: ask(rng, imperative),
    answer: `${room.id} is now numbered ${k}.`,
    variant: 'relabel',
    check: (f) => (roomById(f, room.id)?.label === String(k) ? [] : ['label']),
  };
}

async function notesEdit(rng: Rng, m: DelveMap, room: Room): Promise<Edit | null> {
  const ref = refRoom(rng, room, { unique: uniqueName(m, room) });
  if (room.notes && rng.chance(0.5)) {
    const imperative = rng.pick([`remove the GM notes from ${ref.text}`, `clear the notes on ${ref.text}`, `delete the note in ${ref.text}`]);
    return {
      calls: [call.update(room.id, undefined, call.unsetNotes)],
      request: ask(rng, imperative),
      answer: `Removed the notes from ${roomRef(room)}.`,
      variant: 'unset-notes',
      check: (f) => (roomById(f, room.id)?.notes === undefined ? [] : ['notes still there']),
    };
  }
  const note = rng.pick(DICTATED_NOTES);
  const text = rng.chance(0.4) ? `${note}.` : note;
  const request = rng.weighted<string>([
    [`Add a GM note to ${ref.text}: ${text}`, 3],
    [`Note for ${ref.text}: ${text}`, 2],
    [`Put this in the notes of ${ref.text}: "${note}"`, 2],
    [`${ref.text[0]!.toUpperCase()}${ref.text.slice(1)} notes: ${text}`, 1],
  ]);
  return {
    calls: [call.update(room.id, call.set.notes(text))],
    request: request + (room.notes ? '' : ''),
    answer: `${room.notes ? 'Replaced' : 'Added'} the GM note on ${roomRef(room)}.`,
    variant: room.notes ? 'replace-notes' : 'notes',
    check: (f) => (roomById(f, room.id)?.notes === text ? [] : ['notes']),
  };
}

async function doorStyleEdit(rng: Rng, m: DelveMap, room: Room): Promise<Edit | null> {
  const styles: DoorStyle[] = ['locked', 'secret', 'portcullis', 'archway', 'double', 'normal'];
  const mode = rng.weighted<'id' | 'between' | 'all'>([['id', 4], ['between', 4], ['all', 2]]);
  let doors: Door[] = [];
  let what = '';
  let answerWhat = '';
  if (mode === 'between') {
    const pairs = corridorsOf(m, room.id).filter((c) => corridorDoors(m, c).length === 1);
    if (!pairs.length) return null;
    const c = rng.pick(pairs);
    const other = roomById(m, c.from === room.id ? c.to! : c.from!)!;
    doors = corridorDoors(m, c);
    what = `the door between ${refRoom(rng, room, { selectable: false, unique: uniqueName(m, room) }).text} and ${refRoom(rng, other, { selectable: false, unique: uniqueName(m, other) }).text}`;
    answerWhat = `door ${doors[0]!.id} between ${roomRef(room)} and ${roomRef(other)}`;
  } else if (mode === 'all') {
    doors = doorsOf(m, room);
    if (doors.length < 2) return null;
    what = `all the doors of ${refRoom(rng, room, { selectable: false, unique: uniqueName(m, room) }).text}`;
    answerWhat = `doors ${list(doors.map((d) => d.id))} of ${roomRef(room)}`;
  } else {
    doors = doorsOf(m, room);
    if (!doors.length) return null;
    doors = [rng.pick(doors)];
    what = rng.pick([`door ${doors[0]!.id}`, `the door ${doors[0]!.id}`, `${doors[0]!.id}`]);
    answerWhat = `door ${doors[0]!.id}`;
  }
  const style = rng.pick(styles.filter((s) => doors.some((d) => (d.style ?? 'normal') !== s)));
  const imperative =
    style === 'locked'
      ? rng.pick([`lock ${what}`, `make ${what} locked`])
      : style === 'normal'
        ? rng.pick([`unlock ${what}`, `make ${what} a normal door again`, `change ${what} to a plain door`])
        : rng.pick([`make ${what} ${an(STYLE_WORDS[style]![0]!)}`, `change ${what} to ${an(style)}`, `turn ${what} into ${an(STYLE_WORDS[style]![0]!)}`]);
  const changing = doors.filter((d) => (d.style ?? 'normal') !== style);
  const sWord = style === 'normal' ? 'a normal door again' : styleAs(style);
  return {
    calls: changing.map((d) => call.update(d.id, call.set.doorStyle(style))),
    request: ask(rng, imperative),
    answer: changing.length < doors.length ? `Set ${list(changing.map((d) => d.id))} to ${style}; ${list(doors.filter((d) => !changing.includes(d)).map((d) => d.id))} already was.` : `${answerWhat.charAt(0).toUpperCase()}${answerWhat.slice(1)} ${doors.length > 1 ? 'are' : 'is'} now ${sWord}.`,
    variant: `door-${mode}`,
    check: (f) => (doors.every((d) => ((byId(f, d.id) as Door | undefined)?.style ?? 'normal') === style) ? [] : ['door style']),
  };
}

async function propNotesEdit(rng: Rng, m: DelveMap): Promise<Edit | null> {
  const props = ofType(m, 'prop').filter((p) => /chest|barrel|crate|coffin|sarcophagus|desk|bookshelf|altar|statue|cage|sack/.test(p.asset));
  if (!props.length) return null;
  const p = rng.pick(props);
  const note = rng.pick(['50 gp and a scroll of fireball', 'Empty, but the bottom is false', 'A sleeping rat swarm', 'The key to the vault', 'Poisoned needle trap, DC 15', 'Three potions of healing', 'A letter from the cult leader', 'Old bones and a silver ring']);
  const name = assetName(p.asset).toLowerCase();
  return {
    calls: [call.update(p.id, call.set.notes(note))],
    request: rng.pick([`Add a note to the ${name} ${p.id}: ${note}`, `Note on ${p.id}: ${note}`, `${p.id} (the ${name}) holds this, put it in its notes: ${note}`]),
    answer: `Added the note to ${p.id} (${assetName(p.asset)}).`,
    variant: 'prop-notes',
    check: (f) => ((byId(f, p.id) as Prop | undefined)?.notes === note ? [] : ['prop notes']),
  };
}

export const editFields: Family = {
  id: 'edit_fields',
  title: 'Rename, renumber, GM notes and door styles with update (one or two changes)',
  weight: 8,
  start: (rng) => ({ kind: rng.chance(0.75) ? 'dungeon' : 'small', furnished: rng.chance(0.4) }),
  async run({ rng, convo }): Promise<FamilyResult> {
    const m = convo.map;
    const rooms = ofType(m, 'room');
    if (!rooms.length) skip('no rooms');
    const make = async (kind: string): Promise<Edit | null> => {
      const room = rng.pick(rooms);
      switch (kind) {
        case 'rename':
          return renameEdit(rng, m, room);
        case 'relabel':
          return relabelEdit(rng, m, room);
        case 'notes':
          return notesEdit(rng, m, rng.pick(rooms.filter((r) => r.notes).concat(rooms)));
        case 'door':
          return doorStyleEdit(rng, m, room);
        default:
          return propNotesEdit(rng, m);
      }
    };
    let edits: Edit[] = [];
    for (let t = 0; t < 10 && !edits.length; t++) {
      const first = await make(rng.weighted<string>([['rename', 30], ['relabel', 6], ['notes', 22], ['door', 32], ['prop', 10]]));
      if (first) edits = [first];
    }
    if (!edits.length) skip('nothing to edit');
    // now and then two changes in one message
    if (rng.chance(0.25)) {
      const second = await make(edits[0]!.variant === 'rename' ? 'door' : 'rename');
      if (second && !second.calls.some((c) => edits[0]!.calls.some((d) => d.args.id === c.args.id))) edits.push(second);
    }
    const calls = edits.flatMap((e) => e.calls);
    if (!calls.length || !(await works(convo, ...calls))) skip('edit refused');
    const request = edits.length === 1 ? edits[0]!.request : `${edits[0]!.request.replace(/[.?!]?$/, '')}, and ${edits[1]!.request.charAt(0).toLowerCase()}${edits[1]!.request.slice(1)}`.replace(/\?(.)/, '$1');
    await convo.user(request);
    await convo.step(...calls);
    await convo.answer(edits.map((e) => e.answer).join(' '));
    return {
      variant: edits.map((e) => e.variant).join('+'),
      check(final, start) {
        const errs = edits.flatMap((e) => e.check(final));
        if (removed(start, final).length || addedObjects(start, final).length) errs.push('objects added or removed');
        return errs;
      },
    };
  },
};

// ---------- move ----------

export const moveThings: Family = {
  id: 'move',
  title: 'Move rooms (corridors and doors follow) or props by a number of squares in a direction',
  weight: 4,
  start: (rng) => ({ kind: rng.chance(0.8) ? 'dungeon' : 'small', furnished: rng.chance(0.6) }),
  async run({ rng, convo }) {
    const m = convo.map;
    const rooms = ofType(m, 'room');
    const props = ofType(m, 'prop').filter((p) => rooms.some((r) => pointInShape(r.shape, p.at)));
    for (let attempt = 0; attempt < 14; attempt++) {
      const side = rng.pick(SIDES);
      const k = rng.weighted<number>([[1, 3], [2, 4], [3, 3], [4, 2], [5, 1], [6, 1]]);
      const [dx, dy] = [DIRS[side][0] * k, DIRS[side][1] * k];
      const which = props.length && rng.chance(0.35) ? 'prop' : rooms.length > 2 && rng.chance(0.12) ? 'rooms' : 'room';
      let ids: string[];
      let what: string;
      let answerWhat: string;
      if (which === 'prop') {
        const p = rng.pick(props);
        ids = [p.id];
        const name = assetName(p.asset).toLowerCase();
        what = rng.pick([`the ${name} ${p.id}`, `${p.id}`, `the ${name} (${p.id})`]);
        answerWhat = `${assetName(p.asset)} ${p.id}`;
      } else if (which === 'rooms') {
        const two = rng.sample(rooms, 2);
        ids = two.map((r) => r.id);
        what = `${two.map((r) => roomRef(r)).join(' and ')}`.replace(/room (\d+) and room/, 'rooms $1 and');
        answerWhat = list(two.map(roomRef));
      } else {
        const r = rng.pick(rooms);
        ids = [r.id];
        what = refRoom(rng, r, { unique: uniqueName(m, r) }).text;
        answerWhat = roomRef(r);
      }
      const c = call.move(ids, dx, dy);
      const runs = await works(convo, c);
      if (!runs) continue;
      const kText = numAfter(rng, k, what);
      const sq = k === 1 ? (/\d$/.test(what) ? rng.pick(['one square', 'a square']) : rng.pick(['one square', 'a square', '1 square'])) : `${kText} squares`;
      const imperative = rng.weighted<string>([
        [`move ${what} ${sq} ${dirWords(rng, side)}`, 5],
        [`shift ${what} ${sq} ${dirWords(rng, side)}`, 2],
        [`push ${what} ${dirWords(rng, side)} by ${sq}`, 1],
      ]);
      await convo.user(ask(rng, imperative));
      const [r] = await convo.step(c);
      const followed = said.doorsFollowed(r!.text);
      const cors = which === 'prop' ? [] : ids.flatMap((id) => corridorsOf(m, id).map((x) => x.id));
      const tail = which === 'prop' ? '' : cors.length || followed ? `; ${[cors.length ? `corridor${cors.length > 1 ? 's' : ''} ${list([...new Set(cors)])}` : '', followed ? `door${/,/.test(followed) ? 's' : ''} ${followed}` : ''].filter(Boolean).join(' and ')} moved with ${ids.length > 1 ? 'them' : 'it'}` : '';
      await convo.answer(`Moved ${answerWhat} ${side} by ${k} square${k > 1 ? 's' : ''}${tail}.`);
      return {
        variant: which,
        check(final, start) {
          const errs: string[] = [];
          for (const id of ids) {
            const a = byId(start, id)!;
            const b = byId(final, id);
            if (!b) {
              errs.push(`${id} gone`);
              continue;
            }
            const pa = a.type === 'prop' ? a.at : a.type === 'room' ? [shapeBounds(a.shape).x0, shapeBounds(a.shape).y0] : null;
            const pb = b.type === 'prop' ? b.at : b.type === 'room' ? [shapeBounds(b.shape).x0, shapeBounds(b.shape).y0] : null;
            if (!pa || !pb || Math.abs(pb[0]! - pa[0]! - dx) > 0.01 || Math.abs(pb[1]! - pa[1]! - dy) > 0.01) errs.push(`${id} not moved by ${dx},${dy}`);
          }
          if (removed(start, final).length) errs.push('removed objects');
          return errs;
        },
      };
    }
    skip('nothing moves cleanly');
  },
};

// ---------- resize ----------

export const resizeRoom: Family = {
  id: 'resize',
  title: 'Resize a room with update {"shape": {"rect": …}}, keeping the walls that have doors in place',
  weight: 3,
  start: (rng) => ({ kind: rng.chance(0.75) ? 'dungeon' : 'small' }),
  async run({ rng, convo }) {
    const m = convo.map;
    const rooms = ofType(m, 'room').filter(isRect);
    for (let attempt = 0; attempt < 12 && rooms.length; attempt++) {
      const room = rng.pick(rooms);
      const [x, y, w, h] = rectOf(room);
      const walls = doorsByWall(m, room);
      const has = (s: Side) => walls[s].length > 0;
      const mode = rng.weighted<'size' | 'extend' | 'units'>([['size', 5], ['extend', 4], ['units', 2]]);
      let rect: Rect;
      let imperative: string;
      const ref = refRoom(rng, room, { unique: uniqueName(m, room) });
      if (mode === 'extend') {
        const side = rng.pick(SIDES.filter((s) => !has(s)));
        if (!side) continue;
        const k = rng.weighted<number>([[1, 2], [2, 4], [3, 2], [4, 1]]);
        const grow = rng.chance(0.8) ? k : -Math.min(k, (side === 'east' || side === 'west' ? w : h) - 3);
        if (grow === 0) continue;
        rect = side === 'east' ? [x, y, w + grow, h] : side === 'west' ? [x - grow, y, w + grow, h] : side === 'south' ? [x, y, w, h + grow] : [x, y - grow, w, h + grow];
        imperative =
          grow > 0
            ? rng.pick([`extend ${ref.text} ${numAfter(rng, grow, ref.text)} square${grow > 1 ? 's' : ''} to the ${side}`, `make ${ref.text} ${numAfter(rng, grow, ref.text)} square${grow > 1 ? 's' : ''} bigger on the ${side} side`, `grow ${ref.text} by ${grow} toward the ${side}`])
            : rng.pick([`shrink ${ref.text} by ${-grow} square${grow < -1 ? 's' : ''} on the ${side} side`, `pull the ${side} wall of ${ref.text} in by ${-grow}`]);
      } else {
        const W = Math.max(3, w + rng.pick([-2, -1, 1, 2, 2, 3, 4]));
        const H = Math.max(3, h + rng.pick([-2, -1, 1, 2, 2, 3]));
        if (W === w && H === h) continue;
        // keep the walls that have doors: grow or shrink away from them
        const nx = has('west') ? x : has('east') ? x + w - W : x;
        const ny = has('north') ? y : has('south') ? y + h - H : y;
        if ((has('west') && has('east') && W !== w) || (has('north') && has('south') && H !== h)) continue;
        rect = [nx, ny, W, H];
        const u = unitOf(m);
        const sizeText = mode === 'units' && Number.isInteger(W * u.size) && Number.isInteger(H * u.size) ? `${n(W * u.size)} by ${n(H * u.size)} ${u.name}` : `${W}×${H}`;
        imperative = rng.pick([...(/\d$/.test(ref.text) ? [] : [`make ${ref.text} ${sizeText}`]), `resize ${ref.text} to ${sizeText}`, `change ${ref.text} to ${sizeText}${/ (ft|m)$/.test(sizeText) ? '' : ' squares'}`, `${W > w || H > h ? 'enlarge' : 'shrink'} ${ref.text} to ${sizeText}`]);
      }
      const c = call.update(room.id, call.set.rect(rect));
      if (!(await works(convo, c))) continue;
      await convo.user(ask(rng, imperative), ref.selection ? { selection: ref.selection } : {});
      await convo.step(c);
      await convo.answer(`${roomRef(room).replace(/^r/, 'R').replace(/^room/, 'Room')} is now ${rect[2]}×${rect[3]} squares (x ${n(rect[0])}–${n(rect[0] + rect[2])}, y ${n(rect[1])}–${n(rect[1] + rect[3])}).`);
      return {
        variant: mode,
        check(final, start) {
          const r = roomById(final, room.id);
          const errs: string[] = [];
          if (!r || JSON.stringify(rectOf(r)) !== JSON.stringify(rect)) errs.push('rect');
          if (removed(start, final).length) errs.push('removed objects');
          return errs;
        },
      };
    }
    skip('no room resizes cleanly');
  },
};

// ---------- delete ----------

/** A room with everything that belongs to it: its corridors and their doors, doors in its walls, and what stands inside. */
export function roomBundle(m: DelveMap, room: Room): string[] {
  const ids = new Set<string>([room.id]);
  for (const c of corridorsOf(m, room.id)) {
    ids.add(c.id);
    for (const d of corridorDoors(m, c)) ids.add(d.id);
  }
  for (const d of doorsOf(m, room)) ids.add(d.id);
  const b = boxOf(room);
  for (const o of m.objects) {
    if (o.type === 'prop' || o.type === 'label' || o.type === 'marker') {
      if (pointInShape(room.shape, o.at)) ids.add(o.id);
    } else if (o.type === 'terrain' || o.type === 'height' || o.type === 'cutout' || o.type === 'stairs') {
      const ob = shapeBounds(o.shape);
      if (ob.x0 >= b.x0 - 0.01 && ob.y0 >= b.y0 - 0.01 && ob.x1 <= b.x1 + 0.01 && ob.y1 <= b.y1 + 0.01) ids.add(o.id);
    }
  }
  return [...ids];
}

const describeBundle = (m: DelveMap, ids: string[], room?: Room): string => {
  const kinds = (t: MapObject['type']) => ids.filter((id) => byId(m, id)?.type === t);
  const parts: string[] = [];
  const cs = kinds('corridor');
  const ds = kinds('door');
  const ps = kinds('prop');
  const rs = kinds('room').filter((id) => id !== room?.id);
  if (rs.length) parts.push(`rooms ${idRange(rs)}`);
  if (cs.length) parts.push(`${cs.length > 1 ? 'corridors' : 'corridor'} ${list(cs)}`);
  if (ds.length) parts.push(`${ds.length > 1 ? 'doors' : 'door'} ${list(ds)}`);
  if (ps.length) parts.push(`${ps.length > 1 ? `the ${ps.length} props` : 'the prop'} in it (${idRange(ps)})`);
  const kindWord: Record<string, [string, string]> = { cutout: ['pillar', 'pillars'], stairs: ['stairs', 'stairs'], terrain: ['terrain', 'terrain'], label: ['label', 'labels'], height: ['height area', 'height areas'], marker: ['marker', 'markers'] };
  const other = new Map<string, string[]>();
  for (const id of ids) {
    const t = byId(m, id)?.type ?? '';
    if (['room', 'corridor', 'door', 'prop'].includes(t)) continue;
    other.set(t, [...(other.get(t) ?? []), id]);
  }
  for (const [t, xs] of other) parts.push(`${(kindWord[t] ?? [t, `${t}s`])[xs.length > 1 ? 1 : 0]} ${list(xs)}`);
  return list(parts);
};

export const deleteThings: Family = {
  id: 'delete',
  title: 'Delete props, terrain or a room with its corridors and doors; ask first before a large part of the map goes',
  weight: 5,
  start: (rng) => ({ kind: 'dungeon', furnished: rng.chance(0.6), rooms: [3, 10] }),
  async run({ rng, convo }) {
    const m = convo.map;
    const rooms = ofType(m, 'room');
    const mode = rng.weighted<'props' | 'room' | 'terrain' | 'big'>([['props', 3], ['room', 4], ['terrain', 1], ['big', 2]]);
    if (mode === 'big') {
      if (rooms.length < 5) skip('map too small for a big deletion');
      // most of the map: everything but one room, a half of it, or all of it
      const how = rng.weighted<'all' | 'except' | 'half'>([['all', 2], ['except', 2], ['half', 3]]);
      const box = rooms.map(boxOf).reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
      const side = rng.pick(SIDES);
      const mid = side === 'east' || side === 'west' ? (box.x0 + box.x1) / 2 : (box.y0 + box.y1) / 2;
      const keep = rng.pick(rooms);
      const doomed = rooms.filter((r) => {
        if (how === 'all') return true;
        if (how === 'except') return r.id !== keep.id;
        const c = boxOf(r);
        const cx = (c.x0 + c.x1) / 2;
        const cy = (c.y0 + c.y1) / 2;
        return side === 'east' ? cx > mid : side === 'west' ? cx < mid : side === 'north' ? cy < mid : cy > mid;
      });
      if (doomed.length < 3 || doomed.length < 0.4 * rooms.length) skip('not big enough');
      const ids = [...new Set(doomed.flatMap((r) => roomBundle(m, r)))];
      const c = call.del(ids);
      if (!(await works(convo, c))) skip('big delete refused');
      const request =
        how === 'all'
          ? rng.pick(['Delete everything on this map.', 'Clear the whole map.', 'Remove all the rooms.', 'wipe the map, I want to start over'])
          : how === 'except'
            ? rng.pick([`Delete every room except ${roomRef(keep)}.`, `Remove everything but ${roomRef(keep)}.`, `Keep only ${roomRef(keep)} and delete the rest.`])
            : rng.pick([`Delete all the rooms in the ${side} half of the map.`, `Remove the ${side}ern part of the dungeon.`, `Get rid of everything on the ${side} side.`]);
      await convo.user(request);
      const props = ids.filter((id) => byId(m, id)?.type === 'prop').length;
      await convo.answer(
        `That would delete ${doomed.length === rooms.length ? `all ${rooms.length} rooms` : `${doomed.length} of the ${rooms.length} rooms`} (${idRange(doomed.map((r) => r.id))}) with their corridors and doors${props ? ` and ${props} props` : ''}${how === 'all' ? ': the whole map' : ''}. Should I go ahead?`,
      );
      const yes = rng.chance(0.7);
      if (yes) {
        await convo.user(rng.pick(['Yes, go ahead.', 'yes', 'Yes, delete them.', 'Do it.', 'Yes please.', 'ok go']));
        await convo.step(c);
        await convo.answer(`Deleted ${doomed.length} rooms (${idRange(doomed.map((r) => r.id))}) with their corridors, doors and everything in them. Undo brings them back.`);
      } else {
        const one = rng.pick(doomed);
        const one_ids = roomBundle(m, one);
        const c1 = call.del(one_ids);
        if (!(await works(convo, c1))) skip('single delete refused');
        await convo.user(rng.pick([`No, only ${roomRef(one)}.`, `No wait, just delete ${roomRef(one)}.`, `Actually only ${roomRef(one)}, keep the rest.`]));
        await convo.step(c1);
        await convo.answer(`Deleted ${roomRef(one)}${one_ids.length > 1 ? ` with ${describeBundle(m, one_ids.filter((x) => x !== one.id), one)}` : ''}; the rest stays.`);
        return {
          variant: 'ask-first+no',
          check(final) {
            return one_ids.filter((id) => byId(final, id)).map((id) => `${id} still there`).concat(rooms.filter((r) => r.id !== one.id && !roomById(final, r.id)).map((r) => `${r.id} gone`));
          },
        };
      }
      return {
        variant: `ask-first+yes`,
        check(final) {
          return ids.filter((id) => byId(final, id)).map((id) => `${id} still there`);
        },
      };
    }
    if (mode === 'terrain') {
      const ts = ofType(m, 'terrain');
      if (!ts.length) skip('no terrain');
      const t = rng.pick(ts);
      const room = rooms.find((r) => pointInShape(r.shape, [(shapeBounds(t.shape).x0 + shapeBounds(t.shape).x1) / 2, (shapeBounds(t.shape).y0 + shapeBounds(t.shape).y1) / 2]));
      const name = assetName(t.asset).toLowerCase();
      const c = call.del([t.id]);
      if (!(await works(convo, c))) skip('terrain delete refused');
      await convo.user(ask(rng, room ? rng.pick([`remove the ${name} in ${roomRef(room)}`, `get rid of the ${name} from ${roomRef(room)}`]) : rng.pick([`remove the ${name} (${t.id})`, `delete terrain ${t.id}`])));
      await convo.step(c);
      await convo.answer(`Removed the ${name} ${t.id}${room ? ` from ${roomRef(room)}` : ''}.`);
      return { variant: 'terrain', check: (final) => (byId(final, t.id) ? ['still there'] : []) };
    }
    if (mode === 'props') {
      const withProps = rooms.filter((r) => propsIn(m, r).length);
      if (!withProps.length) skip('no props');
      const room = rng.pick(withProps);
      const here = propsIn(m, room);
      const byAsset = new Map<string, Prop[]>();
      for (const p of here) byAsset.set(p.asset, [...(byAsset.get(p.asset) ?? []), p]);
      const [asset, group] = rng.pick([...byAsset]);
      const all = rng.chance(0.25) && here.length > 1;
      const doomed = all ? here : group.length > 1 && rng.chance(0.6) ? group : [rng.pick(group)];
      const name = assetName(asset).toLowerCase();
      const ref = refRoom(rng, room, { unique: uniqueName(m, room) });
      const imperative = all
        ? rng.pick([`remove all the furniture from ${ref.text}`, `clear out ${ref.text}`, `delete every prop in ${ref.text}`])
        : doomed.length > 1
          ? rng.pick([`delete the ${name}s in ${ref.text}`, `remove all ${name} props from ${ref.text}`])
          : rng.pick([`remove the ${name} ${doomed[0]!.id}`, `delete ${doomed[0]!.id}`, `get rid of the ${name} in ${ref.text}`.replace(/ in .*/, group.length === 1 ? ` in ${ref.text}` : ` ${doomed[0]!.id}`)]);
      const c = call.del(doomed.map((p) => p.id));
      if (!(await works(convo, c))) skip('prop delete refused');
      await convo.user(ask(rng, imperative), ref.selection ? { selection: ref.selection } : {});
      await convo.step(c);
      await convo.answer(`Deleted ${doomed.length > 1 ? `${doomed.length} props` : `the ${name}`} (${idRange(doomed.map((p) => p.id))}) from ${roomRef(room)}.`);
      return {
        variant: all ? 'props-all' : doomed.length > 1 ? 'props-group' : 'prop',
        check(final, start) {
          const errs = doomed.filter((p) => byId(final, p.id)).map((p) => `${p.id} still there`);
          if (removed(start, final).length !== doomed.length) errs.push('removed more');
          return errs;
        },
      };
    }
    // a room with what belongs to it
    if (rooms.length < 2) skip('only one room');
    for (const room of rng.shuffle(rooms).slice(0, 5)) {
      const ids = roomBundle(m, room);
      const c = call.del(ids);
      if (!(await works(convo, c))) continue;
      const ref = refRoom(rng, room, { unique: uniqueName(m, room) });
      const imperative = rng.pick([`delete ${ref.text}`, `remove ${ref.text}`, `get rid of ${ref.text} and its corridor`, `remove ${ref.text} and everything in it`]);
      await convo.user(ask(rng, imperative), ref.selection ? { selection: ref.selection } : {});
      await convo.step(c);
      const rest = ids.filter((id) => id !== room.id);
      await convo.answer(`Deleted ${roomRef(room)}${rest.length ? ` together with ${describeBundle(m, rest, room)}` : ''}.`);
      return {
        variant: 'room',
        check(final, start) {
          const errs = ids.filter((id) => byId(final, id)).map((id) => `${id} still there`);
          if (removed(start, final).length !== ids.length) errs.push('removed more');
          return errs;
        },
      };
    }
    skip('no room deletes cleanly');
  },
};

