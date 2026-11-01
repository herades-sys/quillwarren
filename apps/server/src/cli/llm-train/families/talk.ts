// Conversation families: questions answered from the map without changing
// it, follow-ups in a second message ("make it bigger", "move it north",
// "undo that"), recovery when Quillwarren refuses something for a real reason (the
// wall already has a door, there is no free spot) followed by the corrected
// call, and finding and fixing layout problems with check_map.
import { assetInfo, checkMap, compassWord, doorCentre, doorLeadsTo, mapBox, pointInShape, propBounds, shapeBounds, type DelveMap } from '@delve/core';
import {
  assetName,
  boxOf,
  byId,
  corridorBetween,
  doorsByWall,
  doorsOf,
  idRange,
  inUnits,
  isRect,
  list,
  n,
  neighbours,
  ofType,
  propsIn,
  rectOf,
  roomById,
  roomRef,
  roomTitle,
  uniqueName,
  unitOf,
  wallOf,
  boxGap,
  type Door,
  type Prop,
  type Rect,
  type Room,
} from '../kit.ts';
import type { Rng } from '../rng.ts';
import { PLACE_PHRASES, PROP_WORDS } from '../themes.ts';
import { call, CORNERS, OPPOSITE, refusal, said, SIDES, type Call, type DoorStyle, type Side } from '../tools.ts';
import { ROOM_KINDS } from '../words.ts';
import { an, ask, clean, numWord, refRoom, sidePhrase, sizePhrase, skip, STYLE_WORDS, styleAs, works, type Family, type FamilyResult } from './common.ts';

const unchanged = (start: DelveMap, final: DelveMap): string[] => (JSON.stringify(start.objects) === JSON.stringify(final.objects) ? [] : ['the map changed']);
const CORNER_WORDS: Record<string, string> = { ne: 'north-east', nw: 'north-west', se: 'south-east', sw: 'south-west' };
const roomCap = (r: Room) => {
  const t = roomTitle(r);
  if (t) return t.charAt(0).toUpperCase() + t.slice(1);
  const s = roomRef(r);
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// ---------- questions ----------

interface QA {
  q: string;
  a: string;
  /** A tool to call before answering (describe_map or check_map), or none. */
  tool?: Call;
  /** Builds the answer from the tool's result instead. */
  fromTool?: (text: string) => string;
  kind: string;
}

function questions(rng: Rng, m: DelveMap): QA[] {
  const out: QA[] = [];
  const rooms = ofType(m, 'room');
  const u = unitOf(m);
  const box = mapBox(m);
  if (rooms.length) {
    out.push({
      kind: 'count-rooms',
      q: rng.pick(['How many rooms are on this map?', 'How many rooms do we have?', 'how many rooms are there', 'Count the rooms for me.']),
      a: `There ${rooms.length === 1 ? 'is 1 room' : `are ${rooms.length} rooms`}: ${idRange(rooms.map((r) => r.id))}.`,
    });
    const r = rng.pick(rooms);
    const ref = refRoom(rng, r, { selectable: false, unique: uniqueName(m, r) }).text;
    const nb = neighbours(m, r.id).map((id) => roomById(m, id)!).filter(Boolean);
    out.push({
      kind: 'connections',
      q: rng.pick([`Which rooms is ${ref} connected to?`, `Where can you go from ${ref}?`, `What does ${ref} connect to?`]),
      a: nb.length
        ? `${roomCap(r)} is joined to ${list(nb.map((x) => `${roomRef(x)} (corridor ${corridorBetween(m, r.id, x.id)!.id})`))}.`
        : `${roomCap(r)} has no corridors, so it isn't joined to any other room.`,
    });
    const props = propsIn(m, r);
    const counts = new Map<string, Prop[]>();
    for (const p of props) counts.set(p.asset, [...(counts.get(p.asset) ?? []), p]);
    out.push({
      kind: 'contents',
      q: rng.pick([`What's in ${ref}?`, `What furniture is in ${ref}?`, `Is there anything in ${ref}?`, `List the props in ${ref}.`]),
      a: props.length
        ? `${roomCap(r)} has ${list([...counts].map(([a, ps]) => `${ps.length > 1 ? `${ps.length} × ` : ''}${assetName(a)} (${idRange(ps.map((p) => p.id))})`))}.`
        : `${roomCap(r)} is empty: there are no props in it.`,
    });
    if (isRect(r)) {
      const [, , w, h] = rectOf(r);
      out.push({
        kind: 'size',
        q: rng.pick([`How big is ${ref}?`, `What size is ${ref}?`, `How large is ${ref} in ${u.name === 'm' ? 'metres' : 'feet'}?`]),
        a: `${roomCap(r)} is ${n(w)}×${n(h)} squares, ${inUnits(m, w)} × ${inUnits(m, h)}.`,
      });
    }
    if (box && r.name && uniqueName(m, r)) {
      const b = boxOf(r);
      const where = compassWord([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2], box);
      out.push({
        kind: 'where',
        q: rng.pick([`Where is the ${r.name.toLowerCase()}?`, `Which room is the ${r.name.toLowerCase()}?`, `Where's the ${r.name.toLowerCase()} on the map?`]),
        a: `The ${r.name.toLowerCase()} is ${roomRef(r)} (${r.id}), ${where === 'middle' ? 'in the middle of the map' : `in the ${where} part of the map`} (x ${n(b.x0)}–${n(b.x1)}, y ${n(b.y0)}–${n(b.y1)}).`,
      });
    }
    // doors of a room, never room 1 (the llm-bench question is about room 1)
    const dr = rooms.filter((x) => x.label !== '1' && isRect(x));
    if (dr.length) {
      const room = rng.pick(dr);
      const ds = doorsOf(m, room);
      const b = boxOf(room);
      const dref = refRoom(rng, room, { selectable: false, unique: uniqueName(m, room) }).text;
      out.push({
        kind: 'doors',
        q: rng.pick([`How many doors does ${dref} have?`, `Which doors are in ${dref}'s walls?`, `What doors does ${dref} have?`]),
        a: ds.length
          ? `${roomCap(room)} has ${ds.length === 1 ? '1 door' : `${ds.length} doors`} in its walls: ${list(ds.map((d) => `${d.id} (${d.style ?? 'normal'}, ${wallOf(doorCentre(d), b)} wall)`))}.`
          : `${roomCap(room)} has no doors in its walls.`,
      });
    }
    const largest = [...rooms].sort((a, b) => {
      const A = boxOf(a);
      const B = boxOf(b);
      return (B.x1 - B.x0) * (B.y1 - B.y0) - (A.x1 - A.x0) * (A.y1 - A.y0);
    });
    const [first, second] = largest.map(boxOf);
    if (rooms.length > 1 && isRect(largest[0]!) && first && second && (first.x1 - first.x0) * (first.y1 - first.y0) > (second.x1 - second.x0) * (second.y1 - second.y0)) {
      out.push({
        kind: 'biggest',
        q: rng.pick(['Which is the biggest room?', 'What is the largest room on the map?', 'Which room has the most space?']),
        a: `${roomCap(largest[0]!)} is the biggest: ${n(first.x1 - first.x0)}×${n(first.y1 - first.y0)} squares.`,
      });
    }
    const noted = rooms.filter((x) => x.notes);
    if (noted.length) {
      const room = rng.pick(noted);
      out.push({
        kind: 'notes',
        q: rng.pick([`What are the GM notes for ${roomRef(room)}?`, `What did I note for ${roomRef(room)}?`, `Read me the notes of ${roomRef(room)}.`]),
        a: `The notes for ${roomRef(room)} say: "${room.notes}"`,
      });
    }
  }
  const doors = ofType(m, 'door');
  if (doors.length) {
    const style = rng.pick<DoorStyle>(['locked', 'secret', 'portcullis', 'archway']);
    const these = doors.filter((d) => d.style === style);
    out.push({
      kind: 'door-styles',
      q: style === 'locked' ? rng.pick(['Which doors are locked?', 'Are any doors locked?']) : style === 'secret' ? rng.pick(['Are there any secret doors?', 'Which doors are secret?']) : `Are there any ${style === 'archway' ? 'archways' : 'portcullises'}?`,
      a: these.length ? `${these.length === 1 ? 'One' : `${these.length}`}: ${list(these.map((d) => d.id))}.` : `No, there ${style === 'locked' ? 'are no locked doors' : `are no ${style === 'archway' ? 'archways' : style === 'secret' ? 'secret doors' : 'portcullises'}`} on this map.`,
    });
  }
  out.push({
    kind: 'unit',
    q: rng.pick(['How big is one square on this map?', 'What scale is this map?', 'Is this map in feet or metres?']),
    a: `One square is ${u.size} ${u.name} on this map.`,
  });
  const heights = ofType(m, 'height');
  if (heights.length) {
    const h = rng.pick(heights);
    out.push({
      kind: 'heights',
      q: rng.pick([`How high is ${h.name ? `the ${h.name.toLowerCase()}` : h.id}?`, `What's the height of ${h.id}?`]),
      a: `${h.name ? `The ${h.name.toLowerCase()} (${h.id})` : `Height area ${h.id}`} is ${h.height > 0 ? '+' : ''}${n(h.height)} ${u.name}${h.edge ? ` with ${an(h.edge)} edge` : ''}.`,
    });
  }
  const water = ofType(m, 'terrain').filter((t) => /water|pond|river|lake/.test(t.asset));
  out.push({
    kind: 'water',
    q: rng.pick(['Is there any water on this map?', 'Where is the water?', 'Any water here?']),
    a: water.length
      ? `There is ${list(
          water.map((t) => {
            const b = shapeBounds(t.shape);
            const where = box ? compassWord([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2], box) : 'middle';
            return `${assetName(t.asset).toLowerCase()} ${t.id}${t.name ? ` (${t.name})` : ''} ${where === 'middle' ? 'in the middle of the map' : `in the ${where}`}`;
          }),
        )}.`
      : 'There is no water on this map.',
  });
  out.push({
    kind: 'check',
    q: rng.pick(['Is anything wrong with the layout?', 'Can you check the map for problems?', 'Does the map have any layout problems?']),
    a: '',
    tool: call.check(),
    fromTool: (text) => (said.noProblems(text) ? 'No: check_map finds no problems. No rooms overlap or touch, the corridors keep out of other rooms, every door is on a wall and the props stand inside their rooms.' : ''),
  });
  return out;
}

export const question: Family = {
  id: 'question',
  title: 'Questions answered from the map (the context block, describe_map or check_map) without changing it',
  weight: 7,
  start: (rng) => ({ kind: rng.weighted<'dungeon' | 'small' | 'outdoor'>([['dungeon', 6], ['small', 2], ['outdoor', 2]]), furnished: rng.chance(0.6) }),
  async run({ rng, convo }): Promise<FamilyResult> {
    const m = convo.map;
    const qs = questions(rng, m).filter((q) => q.tool || q.a);
    if (!qs.length) skip('no question');
    const qa = rng.weighted(qs.map((q) => [q, q.kind === 'check' ? 1 : q.kind === 'unit' || q.kind === 'water' ? 1 : 3] as const));
    await convo.user(qa.q);
    let answer = qa.a;
    if (qa.tool) {
      const [r] = await convo.step(qa.tool);
      answer = qa.fromTool!(r!.text);
      if (!answer) skip('check_map not clean');
    } else if (rng.chance(0.15)) {
      // now and then a look at the map first
      await convo.step(call.describe());
    }
    await convo.answer(answer);
    return { variant: qa.kind, check: (final, start) => unchanged(start, final) };
  },
};

// ---------- follow-ups in a second message ----------

/** A bigger rect for a room, growing away from the walls that have doors. */
function biggerRect(m: DelveMap, room: Room, rng: Rng): Rect | null {
  const [x, y, w, h] = rectOf(room);
  const walls = doorsByWall(m, room);
  const dw = rng.int(1, 3);
  const dh = rng.int(1, 2);
  const nx = walls.west.length && walls.east.length ? null : walls.west.length ? x : walls.east.length ? x - dw : x;
  const ny = walls.north.length && walls.south.length ? null : walls.north.length ? y : walls.south.length ? y - dh : y;
  if (nx === null || ny === null) return null;
  return [nx, ny, w + dw, h + dh];
}

export const multiTurn: Family = {
  id: 'multi_turn',
  title: 'A request, then a follow-up in a second message about what was just made (bigger, move, door style, a prop in it, rename, connect, undo)',
  weight: 7,
  start: (rng) => ({ kind: rng.chance(0.8) ? 'dungeon' : 'small' }),
  async run({ rng, convo }) {
    const m = convo.map;
    const rooms = ofType(m, 'room');
    if (!rooms.length) skip('no rooms');
    // turn 1: a room beside a room, with a corridor and a door
    let first: { c: Call; base: Room; side: Side; w: number; h: number; door: DoorStyle } | null = null;
    for (let k = 0; k < 10 && !first; k++) {
      const base = rng.pick(rooms);
      const side = rng.pick(SIDES);
      const [w, h] = [rng.int(3, 7), rng.int(3, 6)];
      const door = rng.pick<DoorStyle>(['normal', 'normal', 'locked', 'archway', 'double']);
      const c = call.roomBeside({ beside: base.id, side, size: [w, h], connect: true, door });
      if (await works(convo, c)) first = { c, base, side, w, h, door };
    }
    if (!first) skip('no room fits');
    const { base, side, w, h, door } = first;
    const sw = rng.pick(STYLE_WORDS[door]!);
    await convo.user(
      ask(
        rng,
        rng.pick([
          `add a ${sizePhrase(rng, w, h)} room ${sidePhrase(rng, side)} ${roomRef(base)}, connected with ${an(sw)}`,
          `build a ${sizePhrase(rng, w, h)} room ${sidePhrase(rng, side)} ${roomRef(base)} with a corridor and ${an(sw)}`,
          `put a new room, ${sizePhrase(rng, w, h)}, ${sidePhrase(rng, side)} ${roomRef(base)} and join them with ${an(sw)}`,
        ]),
      ),
    );
    const [r1] = await convo.step(first.c);
    const room = r1!.added.find((o): o is Room => o.type === 'room')!;
    const cor = r1!.added.find((o) => o.type === 'corridor')!;
    const d = r1!.added.find((o): o is Door => o.type === 'door')!;
    await convo.answer(`Added room ${room.id} (${w}×${h}) ${side} of ${roomRef(base)}, joined by corridor ${cor.id} with ${an(door)} door ${d.id}.`);

    // turn 2: a follow-up about it
    const after1 = convo.map;
    const kinds = rng.shuffle(['bigger', 'move', 'door', 'prop', 'rename', 'connect', 'undo'] as const);
    for (const kind of kinds) {
      let calls: Call[] = [];
      let say = '';
      let answer: (runs: Awaited<ReturnType<typeof convo.step>>) => string;
      let checkF: (final: DelveMap) => string[];
      if (kind === 'bigger') {
        const nr = biggerRect(after1, roomById(after1, room.id)!, rng);
        if (!nr) continue;
        calls = [call.update(room.id, call.set.rect(nr))];
        say = rng.pick(['make it bigger', 'Make it a bit bigger.', 'make the new room larger', `Can you make it ${nr[2]}×${nr[3]}?`]);
        answer = () => `Made ${room.id} bigger: it is now ${nr[2]}×${nr[3]} squares (x ${n(nr[0])}–${n(nr[0] + nr[2])}, y ${n(nr[1])}–${n(nr[1] + nr[3])}).`;
        checkF = (f) => (JSON.stringify(rectOf(roomById(f, room.id)!)) === JSON.stringify(nr) ? [] : ['rect']);
      } else if (kind === 'move') {
        const dir = rng.pick(SIDES.filter((s) => s !== OPPOSITE[side]));
        const k = rng.int(1, 4);
        const [dx, dy] = { north: [0, -k], south: [0, k], east: [k, 0], west: [-k, 0] }[dir] as [number, number];
        calls = [call.move([room.id], dx, dy)];
        say = rng.pick([`move it ${numWord(rng, k)} square${k > 1 ? 's' : ''} ${dir}`, `Shift it ${k} ${dir}.`, `now move the new room ${k} square${k > 1 ? 's' : ''} to the ${dir}`]);
        answer = (runs) => {
          const followed = said.doorsFollowed(runs[0]!.text);
          return `Moved ${room.id} ${dir} by ${k} square${k > 1 ? "s" : ""}; corridor ${cor.id}${followed ? ` and door${/,/.test(followed) ? 's' : ''} ${followed}` : ''} moved with it.`;
        };
        const b0 = boxOf(roomById(after1, room.id)!);
        checkF = (f) => {
          const b = boxOf(roomById(f, room.id)!);
          return Math.abs(b.x0 - b0.x0 - dx) < 0.01 && Math.abs(b.y0 - b0.y0 - dy) < 0.01 ? [] : ['not moved'];
        };
      } else if (kind === 'door') {
        const style = rng.pick<DoorStyle>(['secret', 'locked', 'portcullis', 'archway'].filter((s) => s !== door) as DoorStyle[]);
        calls = [call.update(d.id, call.set.doorStyle(style))];
        say = rng.pick([`actually, make that door ${styleAs(style)}`, `Make its door ${styleAs(style)}.`, `change the door to ${style === 'locked' ? 'a locked one' : styleAs(style)}`]);
        answer = () => `Door ${d.id} is now ${styleAs(style)}.`;
        checkF = (f) => ((byId(f, d.id) as Door | undefined)?.style === style ? [] : ['style']);
      } else if (kind === 'prop') {
        const asset = rng.pick(['chest-closed', 'barrel', 'statue', 'table-round', 'bed-single', 'brazier', 'crates', 'altar']);
        const place = rng.pick(['center', `${rng.pick(CORNERS)} corner`, `${rng.pick(SIDES)} wall`]);
        calls = [call.propIn({ asset, in: room.id, place })];
        say = ask(rng, `put ${rng.pick(PROP_WORDS[asset] ?? [an(asset)])} ${rng.pick(PLACE_PHRASES[place]!)} it`);
        answer = (runs) => `Added ${assetInfo(asset)!.name} ${runs[0]!.added[0]!.id} ${place === 'center' ? 'in the middle of' : place.endsWith('wall') ? `against the ${place.replace(' wall', '')} wall of` : `in the ${CORNER_WORDS[place.slice(0, 2)]} corner of`} ${room.id}.`;
        checkF = (f) => (ofType(f, 'prop').some((p) => p.asset === asset && pointInShape(roomById(f, room.id)!.shape, p.at)) ? [] : ['prop']);
      } else if (kind === 'rename') {
        const name = rng.pick(Object.values(ROOM_KINDS).flat().filter((x) => !ofType(after1, 'room').some((r) => r.name === x)));
        calls = [call.update(room.id, call.set.name(name))];
        say = rng.pick([`call it the ${name}`, `Name it "${name}".`, `rename it to ${name}`]);
        answer = () => `Named ${room.id} "${name}".`;
        checkF = (f) => (roomById(f, room.id)?.name === name ? [] : ['name']);
      } else if (kind === 'connect') {
        const others = ofType(after1, 'room').filter((x) => x.id !== room.id && x.id !== base.id && !corridorBetween(after1, x.id, room.id) && boxGap(boxOf(x), boxOf(roomById(after1, room.id)!)) <= 8);
        if (!others.length) continue;
        const o = rng.pick(others);
        calls = [call.connect({ from: room.id, to: o.id, doors: 'to', doorStyle: 'normal' })];
        say = rng.pick([`connect it to ${roomRef(o)} as well`, `Also join it to ${roomRef(o)}, with a door.`, `now a corridor from the new room to ${roomRef(o)} too`]);
        answer = (runs) => `Added corridor ${runs[0]!.added.find((x) => x.type === 'corridor')!.id} from ${room.id} to ${roomRef(o)} with door ${runs[0]!.added.find((x) => x.type === 'door')?.id}.`;
        checkF = (f) => (corridorBetween(f, room.id, o.id) ? [] : ['no corridor']);
      } else {
        calls = [call.undo()];
        say = rng.pick(['undo that', 'Undo that, please.', 'Hmm, no. Undo it.', 'Take that back.']);
        answer = () => `Undid it: room ${room.id}, corridor ${cor.id} and door ${d.id} are gone again.`;
        checkF = (f) => (roomById(f, room.id) ? ['room still there'] : []);
      }
      // undo needs the map's history, which a sandbox copy doesn't have: it always works right after turn 1's change
      if (kind !== 'undo' && !(await works(convo, ...calls))) continue;
      await convo.user(say);
      const runs = await convo.step(...calls);
      if (kind === 'prop' && (runs[0]!.added.length !== 1 || !said.placedAsAsked(runs[0]!.text))) skip('prop not placed cleanly');
      await convo.answer(answer(runs));
      // now and then a third message: a question about the result
      if (rng.chance(0.15) && kind !== 'undo') {
        const now = convo.map;
        await convo.user(rng.pick(['How many rooms are there now?', 'how many rooms now?']));
        await convo.answer(`There are ${ofType(now, 'room').length} rooms now: ${idRange(ofType(now, 'room').map((r) => r.id))}.`);
      }
      return {
        variant: kind,
        check: (final) => checkF(final),
      };
    }
    skip('no follow-up works');
  },
};

// ---------- recovery: refused for a real reason, then the corrected call ----------

export const recovery: Family = {
  id: 'recovery',
  title: 'Quillwarren refuses a reasonable call for a real reason (the wall has no free stretch, no free spot, a prop on a tree); the model reads why and makes the corrected call',
  weight: 5,
  start: (rng) => ({ kind: rng.weighted<'dungeon' | 'outdoor'>([['dungeon', 7], ['outdoor', 3]]), furnished: rng.chance(0.5) }),
  async run({ rng, convo }) {
    const m = convo.map;
    // one kind first (by weight), the others as fallbacks: door refusals are easy to find, so they would crowd out the rest
    const first = rng.weighted<'door' | 'room' | 'prop' | 'overlap'>([['door', 3], ['prop', 3], ['overlap', 2], ['room', 2]]);
    const order = [first, ...rng.shuffle((['prop', 'overlap', 'room', 'door'] as const).filter((k) => k !== first))];
    for (const kind of order) {
      if (kind === 'door') {
        // a wall that has no free stretch: corridor mouths or doors take it
        const rooms = rng.shuffle(ofType(m, 'room').filter(isRect));
        for (const room of rooms.slice(0, 8)) {
          for (const wall of rng.shuffle(SIDES)) {
            const style = rng.weighted<DoorStyle>([['normal', 4], ['secret', 2], ['locked', 2], ['portcullis', 1], ['double', 1]]);
            const c = call.doorOnWall({ room: room.id, wall, style });
            const [p] = await convo.probe(c);
            if (!p!.isError || !refusal.wallFull(p!.text)) continue;
            const inWall = refusal.doorInWall(p!.text);
            const existing = inWall ? (byId(m, inWall) as Door | undefined) : undefined;
            // the wall already has a door (of that style, or the user just wants a door there): what was asked for is there, so a door on another wall would be a change nobody asked for
            if (existing && (style === 'normal' || (existing.style ?? 'normal') === style)) continue;
            let fix: Call;
            let fixText: (runs: Awaited<ReturnType<typeof convo.step>>) => string;
            if (existing && (existing.style ?? 'normal') !== style && style !== 'normal') {
              fix = call.update(existing.id, call.set.doorStyle(style));
              fixText = () => `The ${wall} wall of ${roomRef(room)} has no room for a second door, so I made the door already in it, ${existing.id}, ${styleAs(style)}.`;
            } else {
              const free = refusal.freeWalls(p!.text);
              if (!free.length) continue;
              const other = free[0]!;
              fix = call.doorOnWall({ room: room.id, wall: other, style });
              fixText = (runs) => {
                const dd = runs[0]!.added[0] as Door;
                const out = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[other] as [number, number];
                const leads = doorLeadsTo(runs[0]!.map, room.id, doorCentre(dd), out);
                return `The ${wall} wall of ${roomRef(room)} has no free stretch (${existing ? `door ${existing.id} and ` : ''}corridor mouths take it), so I put the ${style === 'normal' ? '' : `${style} `}door ${dd.id} in the ${other} wall instead; it ${leads === 'leads outside' ? 'leads outside' : `opens ${leads.replace(/ \(r\d+\)$/, '')}`}.`;
              };
            }
            if (!(await works(convo, fix))) continue;
            await convo.user(ask(rng, `put ${an(STYLE_WORDS[style]![0]!)} in the ${wall} wall of ${roomRef(room)}`));
            await convo.step(c);
            const runs = await convo.step(fix);
            await convo.answer(fixText(runs));
            return { variant: existing && fix.name === 'update' ? 'door-restyle' : 'door-other-wall', check: (final, start) => (ofType(final, 'door').length >= ofType(start, 'door').length ? [] : ['door lost']) };
          }
        }
      } else if (kind === 'room') {
        const rooms = ofType(m, 'room');
        for (let k = 0; k < 14 && rooms.length; k++) {
          const base = rng.pick(rooms);
          const side = rng.pick(SIDES);
          const [w, h] = [rng.int(8, 14), rng.int(7, 12)];
          const c = call.roomBeside({ beside: base.id, side, size: [w, h], connect: true, door: 'normal' });
          const [p] = await convo.probe(c);
          if (!p!.isError || !refusal.noRoomSpot(p!.text)) continue;
          // smaller on the same side, else the same size on another side
          const tries: { c: Call; how: string }[] = [];
          for (const s of [[w - 2, h - 2], [w - 4, h - 4], [6, 6], [4, 4]] as [number, number][]) if (s[0] >= 3 && s[1] >= 3) tries.push({ c: call.roomBeside({ beside: base.id, side, size: s, connect: true, door: 'normal' }), how: `made it ${s[0]}×${s[1]} instead` });
          for (const s2 of SIDES.filter((x) => x !== side)) tries.push({ c: call.roomBeside({ beside: base.id, side: s2, size: [w, h], connect: true, door: 'normal' }), how: `put it ${s2} of ${roomRef(base)} instead` });
          let fix: { c: Call; how: string } | null = null;
          for (const t of tries) if (await works(convo, t.c)) {
            fix = t;
            break;
          }
          if (!fix) continue;
          await convo.user(ask(rng, `add ${an(`${w}×${h}`)} room ${side} of ${roomRef(base)}, connected with a door`));
          await convo.step(c);
          const [r] = await convo.step(fix.c);
          const nr = r!.added.find((o) => o.type === 'room')!;
          const nc = r!.added.find((o) => o.type === 'corridor');
          await convo.answer(`There was no free ${w}×${h} spot ${side} of ${roomRef(base)}, so I ${fix.how}: room ${nr.id}, joined by corridor ${nc?.id} with a door.`);
          return { variant: fix.how.startsWith('made') ? 'room-smaller' : 'room-other-side', check: (final, start) => (ofType(final, 'room').length === ofType(start, 'room').length + 1 ? [] : ['no new room']) };
        }
      } else if (kind === 'prop') {
        const rooms = ofType(m, 'room').filter(isRect);
        for (let k = 0; k < 14 && rooms.length; k++) {
          const room = rng.pick(rooms);
          const asset = rng.pick(['bookshelf', 'bar-counter', 'wardrobe', 'altar', 'desk', 'workbench', 'bed-double', 'fireplace', 'supply-shelf', 'weapon-rack']);
          const wall = rng.pick(SIDES);
          const c = call.propIn({ asset, in: room.id, place: `${wall} wall` });
          const [p] = await convo.probe(c);
          if (!p!.isError) continue;
          const roomy = said.wallsWithRoom(p!.text);
          if (!roomy.length) continue;
          const other = roomy[0]!;
          const fix = call.propIn({ asset, in: room.id, place: `${other} wall` });
          const ok = await works(convo, fix);
          if (!ok || !said.againstWall(ok[0]!.text)) continue;
          await convo.user(ask(rng, `put ${rng.pick(PROP_WORDS[asset] ?? [an(assetName(asset).toLowerCase())])} against the ${wall} wall of ${roomRef(room)}`));
          await convo.step(c);
          const [r] = await convo.step(fix);
          await convo.answer(`The ${wall} wall of ${roomRef(room)} has no space for the ${assetName(asset).toLowerCase()} (doorways or other props take it), so it stands against the ${other} wall instead (${r!.added[0]!.id}).`);
          return { variant: 'prop-other-wall', check: (final, start) => (ofType(final, 'prop').length === ofType(start, 'prop').length + 1 ? [] : ['no prop']) };
        }
      } else {
        // a prop put on a tree or boulder at a given spot: Quillwarren warns and names the nearest free spot
        const blockers = ofType(m, 'prop').filter((p) => /tree|oak|pine|birch|beech|fir|spruce|maple|boulder/.test(p.asset) && !ofType(m, 'room').some((r) => pointInShape(r.shape, p.at)));
        for (const t of rng.shuffle(blockers).slice(0, 6)) {
          const asset = rng.pick(['tent', 'campfire', 'boulder', 'stump', 'log']);
          const at: [number, number] = [Math.round(t.at[0] * 2) / 2, Math.round(t.at[1] * 2) / 2];
          const c = call.propAt({ asset, at });
          const [p] = await convo.probe(c);
          if (p!.isError || !refusal.propOverlap(p!.text)) continue;
          const free = refusal.freeSpot(p!.text);
          if (!free) continue;
          const id = p!.added[0]!.id;
          const placed = p!.added[0] as Prop;
          const mv = call.move([id], Math.round((free[0] - placed.at[0]) * 100) / 100, Math.round((free[1] - placed.at[1]) * 100) / 100);
          const runs = await convo.probe(c, mv);
          if (!clean(runs[1]!)) continue;
          await convo.user(ask(rng, `put ${an(asset)} at ${n(at[0])}, ${n(at[1])}`));
          await convo.step(c);
          await convo.step(mv);
          await convo.answer(`Added the ${asset} ${id}, but [${n(at[0])}, ${n(at[1])}] is taken by ${t.id} (${assetName(t.asset)}), so I moved it to [${n(free[0])}, ${n(free[1])}], the nearest free spot.`);
          return { variant: 'prop-on-tree', check: (final) => (byId(final, id) ? [] : ['prop gone']) };
        }
      }
    }
    skip('nothing refused for a real reason here');
  },
};

// ---------- find and fix layout problems ----------

export const fixProblems: Family = {
  id: 'fix_problems',
  title: 'check_map lists real layout problems (a prop half outside a room, props on each other, a door off a wall, a prop in a doorway); fix each, check again',
  weight: 3,
  start: (rng) => ({ kind: 'dungeon', inject: rng.int(1, 2), rooms: [3, 8] }),
  async run({ rng, convo, start }) {
    const injected = start.injected ?? [];
    if (!injected.length) skip('nothing injected');
    // plan a fix for each problem on a sandbox, so the conversation only makes calls that work
    const box = await convo.sandbox();
    const fixes: { calls: Call[]; text: string }[] = [];
    try {
      for (const inj of injected) {
        const room = roomById(box.map, inj.room)!;
        const obj = byId(box.map, inj.id);
        if (!obj) skip('injected object gone');
        let done = false;
        if (obj.type === 'prop') {
          // a small move into the room first, else delete it and place it again by meaning
          const rb = boxOf(room);
          const fp = propBounds(obj);
          const moves: [number, number][] = [];
          const into: [number, number] = [fp.x0 < rb.x0 ? rb.x0 - fp.x0 : fp.x1 > rb.x1 ? rb.x1 - fp.x1 : 0, fp.y0 < rb.y0 ? rb.y0 - fp.y0 : fp.y1 > rb.y1 ? rb.y1 - fp.y1 : 0];
          if (into[0] || into[1]) moves.push(into);
          for (const d of [1, 1.5, 2]) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]] as [number, number][]) moves.push([dx, dy]);
          for (const [dx, dy] of moves) {
            const c = call.move([obj.id], dx, dy);
            const r = await box.keep(c, (x) => clean(x) && !/WARNING/.test(x.text));
            if (r) {
              fixes.push({ calls: [c], text: `moved ${obj.id} (${assetName(obj.asset)}) ${n(Math.hypot(dx, dy))} square${Math.hypot(dx, dy) === 1 ? '' : 's'} ${dx > 0 ? 'east' : dx < 0 ? 'west' : dy > 0 ? 'south' : 'north'}` });
              done = true;
              break;
            }
          }
          if (!done) {
            const del = call.del([obj.id]);
            await box.run(del);
            for (const place of rng.shuffle(['center', 'ne corner', 'nw corner', 'se corner', 'sw corner'])) {
              const add = call.propIn({ asset: obj.asset, in: room.id, place });
              const r = await box.keep(add, (x) => clean(x));
              if (r) {
                fixes.push({ calls: [del, add], text: `placed ${assetName(obj.asset).toLowerCase()} ${obj.id} again by meaning (${r.added[0]!.id}, ${place === 'center' ? 'in the middle' : `in the ${CORNER_WORDS[place.slice(0, 2)]} corner`} of ${room.id})` });
                done = true;
                break;
              }
            }
          }
        } else if (obj.type === 'door') {
          const del = call.del([obj.id]);
          await box.run(del);
          const b = boxOf(room);
          const c0 = doorCentre(obj);
          const nearest = [...SIDES].sort((a, c) => {
            const dist = (s: Side) => (s === 'north' ? c0[1] - b.y0 : s === 'south' ? b.y1 - c0[1] : s === 'west' ? c0[0] - b.x0 : b.x1 - c0[0]);
            return dist(a) - dist(c);
          });
          for (const wall of nearest) {
            const add = call.doorOnWall({ room: room.id, wall, style: (obj.style ?? 'normal') as DoorStyle });
            const r = await box.keep(add, (x) => clean(x));
            if (r) {
              fixes.push({ calls: [del, add], text: r.added[0]!.id === obj.id ? `put door ${obj.id}, which floated inside ${room.id}, on its ${wall} wall instead (deleted and added again)` : `replaced door ${obj.id}, which floated inside ${room.id}, with door ${r.added[0]!.id} on its ${wall} wall` });
              done = true;
              break;
            }
          }
        }
        if (!done) skip('no fix found');
      }
    } finally {
      await box.close();
    }
    await convo.user(rng.pick(['Check the map for problems and fix them.', 'Something looks off. Can you check the layout and fix it?', 'Run a check on the map and fix whatever is wrong.', 'please check this map for mistakes and fix them']));
    const [first] = await convo.step(call.check());
    const listed = String(said.problemCount(first!.text));
    // the fixes: deletes first where a fix needs one, then the rest
    for (const f of fixes) await convo.step(...f.calls);
    const [again] = await convo.step(call.check());
    if (!said.noProblems(again!.text)) skip('not all fixed');
    await convo.answer(`check_map listed ${listed} problem${listed === '1' ? '' : 's'}. I ${list(fixes.map((f) => f.text))}. check_map now finds no problems.`);
    return { variant: `${injected.map((i) => i.kind).join('+')}`, check: (final) => (newProblemsAgainstNone(final) ? ['problems left'] : []) };
  },
};

const newProblemsAgainstNone = (m: DelveMap): boolean => checkMap(m).length > 0;

