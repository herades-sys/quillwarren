// Ground families: terrain by region (in rooms, parts of rooms, map edges,
// corners, strips between things, rings around things), heights with units
// and edges (hills, cliffs, daises, sunken pits), labels, and requests that
// give explicit coordinates.
import { assetInfo, lengthInUnits, parseSquareUnit, shapeBounds, type DelveMap } from '@delve/core';
import { boxOf, boxGap, idRange, isRect, list, n, ofType, overlapArea, propsIn, rectOf, roomRef, toBounds, uniqueName, unitOf, type Rect, type Room } from '../kit.ts';
import type { Rng } from '../rng.ts';
import { call, CORNERS, OPPOSITE, region, said, SIDES, type Call, type Corner, type Side } from '../tools.ts';
import { LABEL_TEXTS } from '../words.ts';
import { an, ask, numWord, refRoom, skip, works, type Family } from './common.ts';

const CORNER_WORDS: Record<Corner, string> = { ne: 'north-east', nw: 'north-west', se: 'south-east', sw: 'south-west' };
const added = (start: DelveMap, final: DelveMap) => final.objects.filter((o) => !start.objects.some((x) => x.id === o.id));

/** What users call a terrain, and the id the model should pick (all listed in the lean prompt). */
const TERRAIN_WORDS: { words: string[]; asset: string; indoor: boolean; outdoor: boolean }[] = [
  { words: ['shallow water', 'water', 'a shallow pool'], asset: 'water-shallow', indoor: true, outdoor: true },
  { words: ['deep water'], asset: 'water-deep', indoor: true, outdoor: true },
  { words: ['a pond', 'pond water'], asset: 'c-water-pond', indoor: false, outdoor: true },
  { words: ['lava', 'molten lava'], asset: 'lava', indoor: true, outdoor: true },
  { words: ['grass'], asset: 'grass', indoor: false, outdoor: true },
  { words: ['short grass', 'a lawn'], asset: 'c-ground-grass-short', indoor: false, outdoor: true },
  { words: ['dirt', 'bare earth'], asset: 'dirt', indoor: true, outdoor: true },
  { words: ['mud', 'deep mud'], asset: 'mud', indoor: true, outdoor: true },
  { words: ['swamp', 'marsh'], asset: 'swamp', indoor: false, outdoor: true },
  { words: ['sand'], asset: 'sand', indoor: true, outdoor: true },
  { words: ['snow'], asset: 'snow', indoor: false, outdoor: true },
  { words: ['ice'], asset: 'ice', indoor: true, outdoor: true },
  { words: ['flagstones', 'a flagstone floor'], asset: 'flagstones', indoor: true, outdoor: false },
  { words: ['cobblestones'], asset: 'cobblestones', indoor: true, outdoor: true },
  { words: ['wooden planks', 'a wooden floor'], asset: 'wood-planks', indoor: true, outdoor: false },
  { words: ['carpet'], asset: 'carpet', indoor: true, outdoor: false },
  { words: ['rubble', 'a rubble field'], asset: 'rubble-field', indoor: true, outdoor: true },
  { words: ['moss'], asset: 'moss', indoor: true, outdoor: true },
  { words: ['cave floor'], asset: 'cave-floor', indoor: true, outdoor: false },
  { words: ['a chasm'], asset: 'chasm', indoor: true, outdoor: true },
];

const isOutdoor = (m: DelveMap) => ofType(m, 'terrain').some((t) => shapeBounds(t.shape).x1 - shapeBounds(t.shape).x0 >= 15) && ofType(m, 'room').length <= 3;

// ---------- terrain by region ----------

export const terrainRegion: Family = {
  id: 'terrain_region',
  title: 'Terrain by region: all or part of a room, map edges and corners, strips between things, rings around things',
  weight: 7,
  start: (rng) => ({ kind: rng.chance(0.55) ? 'dungeon' : 'outdoor', furnished: rng.chance(0.2) }),
  async run({ rng, convo }) {
    const m = convo.map;
    const outdoor = isOutdoor(m);
    const rooms = ofType(m, 'room');
    const terrain = ofType(m, 'terrain');
    for (let attempt = 0; attempt < 12; attempt++) {
      const kind = rng.weighted<'in' | 'in-part' | 'edge' | 'corner' | 'between' | 'around'>([
        ['in', rooms.length ? 5 : 0],
        ['in-part', rooms.filter(isRect).length ? 3 : 0],
        ['edge', outdoor ? 3 : 1],
        ['corner', outdoor ? 3 : 0],
        ['between', outdoor ? 3 : 0],
        ['around', outdoor ? 2 : 0],
      ]);
      const indoorish = kind === 'in' || kind === 'in-part';
      const t = rng.pick(TERRAIN_WORDS.filter((x) => (indoorish ? x.indoor : x.outdoor)));
      const word = rng.pick(t.words);
      let reg;
      let where: string;
      let answerWhere: string;
      let room: Room | undefined;
      if (kind === 'in') {
        room = rng.pick(rooms);
        reg = region.in(room.id);
        const ref = refRoom(rng, room, { selectable: false, unique: uniqueName(m, room) }).text;
        where = rng.pick([`in ${ref}`, `over all of ${ref}`, `across the floor of ${ref}`, `everywhere in ${ref}`]);
        answerWhere = `over all of ${roomRef(room)}`;
      } else if (kind === 'in-part') {
        room = rng.pick(rooms.filter(isRect));
        const ref = refRoom(rng, room, { selectable: false, unique: uniqueName(m, room) }).text;
        if (rng.chance(0.6)) {
          const side = rng.pick(SIDES);
          const depth = rng.chance(0.6) ? rng.int(1, 3) : undefined;
          reg = region.inEdge(room.id, side, depth);
          where = `along the ${side} wall of ${ref}${depth ? `, ${numWord(rng, depth)} square${depth > 1 ? 's' : ''} deep` : ''}`;
          answerWhere = `along the inside of the ${side} wall of ${roomRef(room)}`;
        } else {
          const c = rng.pick(CORNERS);
          const size = rng.chance(0.5) ? rng.int(2, 3) : undefined;
          reg = region.inCorner(room.id, c, size);
          where = `in the ${CORNER_WORDS[c]} corner of ${ref}${size ? ` (${size}×${size})` : ''}`;
          answerWhere = `in the ${CORNER_WORDS[c]} corner of ${roomRef(room)}`;
        }
      } else if (kind === 'edge') {
        const side = rng.pick(SIDES);
        const depth = rng.chance(0.6) ? rng.int(2, 6) : undefined;
        reg = region.edge(side, depth);
        where = rng.pick([`along the ${side} edge of the map`, `along the ${side} edge`, `in a strip on the ${side} side of the map`]) + (depth ? `, ${depth} squares wide` : '');
        answerWhere = `in a ${depth ?? 3}-square band along the ${side} edge of the map`;
      } else if (kind === 'corner') {
        const c = rng.pick(CORNERS);
        const size = rng.chance(0.6) ? rng.int(5, 10) : undefined;
        reg = region.corner(c, size);
        where = `in the ${CORNER_WORDS[c]} corner${size ? `, about ${size} by ${size} squares` : ' of the map'}`;
        answerWhere = `in the ${CORNER_WORDS[c]} corner of the map`;
      } else if (kind === 'around') {
        const targets = [...rooms, ...terrain.filter((x) => /water|pond/.test(x.asset))];
        if (!targets.length) continue;
        const tg = rng.pick(targets);
        const margin = rng.chance(0.5) ? rng.int(1, 3) : undefined;
        reg = region.around(tg.id, margin);
        const tname = tg.type === 'room' ? (tg.name ? `the ${tg.name.toLowerCase()}` : roomRef(tg)) : `the ${tg.name?.toLowerCase() ?? 'pond'} (${tg.id})`;
        where = `around ${tname}${margin ? `, ${margin} square${margin > 1 ? 's' : ''} wide` : ''}`;
        answerWhere = `in a ring around ${tg.id}`;
      } else {
        const ends: (string | Side)[] = [...SIDES, ...rooms.map((r) => r.id), ...terrain.filter((x) => /water|pond/.test(x.asset)).map((x) => x.id)];
        const a = rng.pick(ends);
        // two map edges only when they are opposite (a strip across the map)
        const b = rng.pick(ends.filter((x) => x !== a && (!SIDES.includes(x as Side) || !SIDES.includes(a as Side) || OPPOSITE[x as Side] === a)));
        if (!b) continue;
        const width = rng.chance(0.5) ? rng.int(1, 3) : undefined;
        reg = region.between(a, b, width);
        const say = (x: string) => (SIDES.includes(x as Side) ? `the ${x} edge` : x.startsWith('r') ? (m.objects.find((o) => o.id === x) as Room).name?.toLowerCase().replace(/^/, 'the ') ?? roomRef(m.objects.find((o) => o.id === x) as Room) : `the ${(m.objects.find((o) => o.id === x) as { name?: string }).name?.toLowerCase() ?? 'water'} (${x})`);
        where = `as a ${rng.pick(['path', 'track', 'strip', 'trail'])} from ${say(a)} to ${say(b)}${width ? `, ${width} wide` : ''}`;
        answerWhere = `as a ${width ?? 2}-square-wide strip from ${SIDES.includes(a as Side) ? `the ${a} edge` : a} to ${SIDES.includes(b as Side) ? `the ${b} edge` : b}`;
      }
      const c = call.terrainRegion({ asset: t.asset, region: reg });
      const runs = await works(convo, c);
      if (!runs) continue;
      const tid = runs[0]!.added[0]?.id;
      if (!tid) continue;
      if (kind === 'in' && !said.coversAll(runs[0]!.text)) continue;
      await convo.user(ask(rng, `${rng.pick(['paint', 'add', 'put'])} ${word} ${where}`));
      await convo.step(c);
      await convo.answer(`Added ${assetInfo(t.asset)!.name.toLowerCase()} ${tid} ${answerWhere}.`);
      const r0 = room;
      return {
        variant: kind,
        check(final, start) {
          const a = added(start, final);
          if (a.length !== 1 || a[0]!.type !== 'terrain' || a[0].asset !== t.asset) return ['terrain not added'];
          const tb = shapeBounds(a[0].shape);
          if (r0) {
            const rb = boxOf(r0);
            if (overlapArea(tb, rb) < 0.5 * (tb.x1 - tb.x0) * (tb.y1 - tb.y0)) return ['not in the room'];
          }
          return [];
        },
      };
    }
    skip('no terrain region works');
  },
};

// ---------- heights ----------

const heightText = (rng: Rng, m: DelveMap, kind: 'hill' | 'cliff' | 'dais' | 'pit'): { said: string; arg: string } => {
  const u = parseSquareUnit(m.grid.unit);
  const metric = u.name === 'm';
  // in squares now and then, but never a dais (2 squares on a 2 m map is a 4 m "step")
  if (kind !== 'dais' && rng.chance(0.15)) {
    const k = rng.int(1, 3);
    return { said: `${k} square${k > 1 ? 's' : ''}`, arg: `${k} square${k > 1 ? 's' : ''}` };
  }
  const v = metric ? (kind === 'dais' ? rng.pick([0.5, 1]) : rng.pick([2, 3, 4, 6, 8])) : kind === 'dais' ? rng.pick([1, 2, 3]) : rng.pick([5, 10, 15, 20, 30]);
  const unit = metric ? rng.pick(['m', 'm', 'metres']) : rng.pick(['ft', 'ft', 'feet']);
  return { said: `${v} ${unit}`, arg: `${v} ${metric ? 'm' : 'ft'}` };
};

export const heights: Family = {
  id: 'height',
  title: 'Heights with units (m, ft, squares) and edges: hills, cliffs and ledges outdoors, daises and sunken pits in rooms',
  weight: 5,
  start: (rng) => ({ kind: rng.chance(0.65) ? 'outdoor' : 'dungeon' }),
  async run({ rng, convo }) {
    const m = convo.map;
    const outdoor = isOutdoor(m);
    const rooms = ofType(m, 'room').filter(isRect);
    for (let attempt = 0; attempt < 12; attempt++) {
      const kind = outdoor ? rng.weighted<'hill' | 'cliff' | 'dais' | 'pit'>([['hill', 5], ['cliff', 3], ['pit', 1]]) : rng.weighted<'hill' | 'cliff' | 'dais' | 'pit'>([['dais', 4], ['pit', 3], ['cliff', 1]]);
      if (!outdoor && !rooms.length) skip('no rooms');
      const h = heightText(rng, m, kind);
      let reg;
      let where: string;
      let answerWhere: string;
      if (outdoor) {
        const how = rng.weighted<'corner' | 'edge'>([['corner', 3], ['edge', 2]]);
        if (how === 'corner') {
          const c = rng.pick(CORNERS);
          const size = rng.chance(0.6) ? rng.int(5, 10) : undefined;
          reg = region.corner(c, size);
          where = `in the ${CORNER_WORDS[c]} corner${size ? `, ${size} squares across` : ''}`;
          answerWhere = `the ${CORNER_WORDS[c]} corner of the map`;
        } else {
          const side = rng.pick(SIDES);
          const depth = rng.chance(0.6) ? rng.int(3, 6) : undefined;
          reg = region.edge(side, depth);
          where = `along the ${side} edge of the map${depth ? `, ${depth} squares deep` : ''}`;
          answerWhere = `a band along the ${side} edge of the map`;
        }
      } else {
        const room = rng.pick(rooms);
        const ref = refRoom(rng, room, { selectable: false, unique: uniqueName(m, room) }).text;
        if (kind === 'dais') {
          const side = rng.pick(SIDES);
          reg = region.inEdge(room.id, side, rng.chance(0.5) ? 2 : undefined);
          where = `along the ${side} wall of ${ref}`;
          answerWhere = `a band along the ${side} wall of ${roomRef(room)}`;
        } else {
          reg = region.in(room.id);
          where = `${ref}`;
          answerWhere = roomRef(room);
        }
      }
      // never the llm-bench hill: 5 m with a slope in the south-west
      if (kind === 'hill' && /^5 m/.test(h.arg) && JSON.stringify(reg).includes('"sw"')) continue;
      const edge = kind === 'hill' ? 'slope' : kind === 'dais' ? 'step' : kind === 'pit' ? 'cliff' : rng.pick(['cliff', 'rock'] as const);
      const sign = kind === 'pit' ? '-' : '';
      const c = call.heightRegion({ region: reg, height: `${sign}${h.arg}`, edge });
      const runs = await works(convo, c);
      if (!runs) continue;
      // "a 10-foot plateau", "a 3-metre hill", "a 2-square platform"
      const attr = h.said.replace(/ squares?$/, '-square').replace(/ (ft|feet)$/, '-foot').replace(/ (m|metres)$/, '-metre');
      const imperative =
        kind === 'hill'
          ? rng.pick([`raise a hill ${h.said} high ${where}`, `add a gentle hill ${where}, ${h.said} tall`, `make a rounded hill ${where} that rises ${h.said}`, `put a ${attr} hill you can walk up ${where}`])
          : kind === 'cliff'
            ? rng.pick([`raise a ${attr} plateau with sheer cliffs ${where}`, `make the ground ${where} a rocky ledge ${h.said} up`, `add a cliff ${h.said} high ${where}`])
            : kind === 'dais'
              ? rng.pick([`add a raised dais ${h.said} high ${where}`, `raise the floor ${where} by ${h.said} as a low step`, `make a ${attr} platform ${where}`])
              : outdoor
                ? rng.pick([`sink the ground ${where} by ${h.said} with steep sides`, `dig a pit ${h.said} deep ${where}`])
                : rng.pick([`make ${where} a sunken arena, ${h.said} deep`, `sink the floor of ${where} by ${h.said}`, `turn ${where} into a pit ${h.said} deep with sheer walls`]);
      await convo.user(ask(rng, imperative));
      const [r] = await convo.step(c);
      const ha = r!.added.find((o) => o.type === 'height')!;
      const stored = lengthInUnits(`${sign}${h.arg}`, unitOf(m)).value;
      const units = unitOf(m).name;
      await convo.answer(`${kind === 'pit' ? 'Sank' : 'Raised'} ${answerWhere} by ${h.arg.replace(/^-/, '')} (height area ${ha.id}, ${sign || '+'}${n(Math.abs(stored))} ${units}) with ${an(edge)} edge.`);
      return {
        variant: `${kind}${/square/.test(h.arg) ? '+squares' : ''}`,
        check(final, start) {
          const a = added(start, final);
          if (a.length !== 1 || a[0]!.type !== 'height') return ['no height area'];
          if (Math.abs(a[0].height - stored) > 0.05) return [`height ${a[0].height}, wanted ${stored}`];
          if ((a[0].edge ?? '') !== edge) return ['edge'];
          return [];
        },
      };
    }
    skip('no height works');
  },
};

// ---------- labels ----------

export const labels: Family = {
  id: 'label',
  title: 'Text labels by region (a room, a map edge, a corner) or at a point',
  weight: 3,
  start: (rng) => ({ kind: rng.chance(0.6) ? 'dungeon' : 'outdoor' }),
  async run({ rng, convo }) {
    const m = convo.map;
    const rooms = ofType(m, 'room');
    for (let attempt = 0; attempt < 8; attempt++) {
      const text = rng.pick(LABEL_TEXTS);
      const where = rng.weighted<'in' | 'edge' | 'corner'>([['in', rooms.length ? 4 : 0], ['edge', 3], ['corner', 2]]);
      let reg;
      let said: string;
      let ans: string;
      if (where === 'in') {
        const room = rng.pick(rooms);
        reg = region.in(room.id);
        const ref = refRoom(rng, room, { selectable: false, unique: uniqueName(m, room) }).text;
        said = rng.pick([`in ${ref}`, `in the middle of ${ref}`, `on ${ref}`]);
        ans = `in the middle of ${roomRef(room)}`;
      } else if (where === 'edge') {
        const side = rng.pick(SIDES);
        reg = region.edge(side);
        said = rng.pick([`along the ${side} edge`, `at the ${side} edge of the map`, `on the ${side} side of the map`]);
        ans = `by the ${side} edge of the map`;
      } else {
        const c = rng.pick(CORNERS);
        reg = region.corner(c);
        said = `in the ${CORNER_WORDS[c]} corner`;
        ans = `in the ${CORNER_WORDS[c]} corner of the map`;
      }
      const size = rng.chance(0.2) ? rng.pick([0.5, 1, 1.5]) : undefined;
      const c = call.labelIn({ text, region: reg, size });
      const runs = await works(convo, c);
      if (!runs) continue;
      const sizeWords = size ? (size > 0.9 ? rng.pick([' in big letters', ` (text ${size} square${size === 1 ? '' : 's'} tall)`]) : rng.pick([' in small letters', ` (size ${size})`])) : '';
      await convo.user(ask(rng, rng.pick([`write "${text}" ${said}${sizeWords}`, `add the label "${text}" ${said}${sizeWords}`, `label ${said.replace(/^(in|on|at|along) (the middle of )?/, '')} "${text}"${sizeWords}`])));
      const [r] = await convo.step(c);
      const l = r!.added[0]!;
      await convo.answer(`Added label ${l.id} "${text}" ${ans}.`);
      return {
        variant: where,
        check(final, start) {
          const a = added(start, final);
          return a.length === 1 && a[0]!.type === 'label' && a[0].text === text ? [] : ['label'];
        },
      };
    }
    skip('no label');
  },
};

// ---------- explicit coordinates ----------

function freeRect(rng: Rng, m: DelveMap, w: number, h: number): Rect | null {
  const rooms = ofType(m, 'room').map((r) => boxOf(r));
  const xs = rooms.flatMap((b) => [b.x0, b.x1]);
  const ys = rooms.flatMap((b) => [b.y0, b.y1]);
  const [x0, x1, y0, y1] = rooms.length ? [Math.min(...xs) - 4, Math.max(...xs) + 6, Math.min(...ys) - 4, Math.max(...ys) + 6] : [0, 30, 0, 20];
  for (let k = 0; k < 40; k++) {
    const r: Rect = [rng.int(Math.max(0, x0), x1), rng.int(Math.max(0, y0), y1), w, h];
    if (rooms.every((b) => boxGap(b, toBounds(r)) >= 2)) return r;
  }
  return null;
}

export const explicitCoords: Family = {
  id: 'explicit_coords',
  title: 'Requests with explicit coordinates: rooms by rect, props at a point, terrain and heights by rect, labels at a point, rows along a path',
  weight: 4,
  start: (rng) => ({ kind: rng.weighted<'dungeon' | 'outdoor' | 'small'>([['dungeon', 4], ['outdoor', 3], ['small', 2]]) }),
  async run({ rng, convo }) {
    const m = convo.map;
    const rooms = ofType(m, 'room').filter(isRect);
    const outdoor = isOutdoor(m);
    for (let attempt = 0; attempt < 12; attempt++) {
      const kind = rng.weighted<'room' | 'prop' | 'terrain' | 'label' | 'row' | 'height' | 'stairs'>([
        ['room', 3],
        ['prop', rooms.length ? 3 : 0],
        ['terrain', 2],
        ['label', 1],
        ['row', rooms.some((r) => rectOf(r)[2] >= 7) || outdoor ? 2 : 0],
        ['height', outdoor ? 2 : 0],
        ['stairs', rooms.some((r) => rectOf(r)[2] >= 4 && rectOf(r)[3] >= 4 && !propsIn(m, r).length) ? 2 : 0],
      ]);
      let c: Call;
      let request: string;
      let answer: (ids: string[]) => string;
      if (kind === 'room') {
        const [w, h] = [rng.int(3, 8), rng.int(3, 7)];
        const r = freeRect(rng, m, w, h);
        if (!r) continue;
        const name = rng.chance(0.4) ? rng.pick(['Cell', 'Closet', 'Shrine', 'Cave', 'Annex', 'Vault', 'Lookout']) : undefined;
        c = call.roomRect({ rect: r, name });
        request = rng.pick([
          `Add a room from x ${r[0]} to ${r[0] + w}, y ${r[1]} to ${r[1] + h}${name ? ` and call it ${name}` : ''}.`,
          `Make a ${w}×${h} room with its top-left corner at ${r[0]}, ${r[1]}${name ? `, named ${name}` : ''}.`,
          `Room at x=${r[0]} y=${r[1]}, ${w} wide and ${h} high${name ? ` (${name})` : ''}.`,
        ]);
        answer = (ids) => `Added room ${ids.find((i) => i.startsWith('r'))}${name ? ` "${name}"` : ''}: ${w}×${h} squares at ${r[0]},${r[1]} (x ${r[0]}–${r[0] + w}, y ${r[1]}–${r[1] + h}).`;
      } else if (kind === 'prop') {
        const room = rng.pick(rooms);
        const [x, y, w, h] = rectOf(room);
        const sx = rng.int(x + 1, x + w - 2);
        const sy = rng.int(y + 1, y + h - 2);
        const asset = rng.pick(['statue', 'chest-closed', 'barrel', 'brazier', 'altar', 'table-square', 'crate', 'urns', 'cage', 'font', 'lectern', 'obelisk']);
        const info = assetInfo(asset)!;
        const at: [number, number] = info.w === 1 && info.h === 1 ? [sx + 0.5, sy + 0.5] : [sx + info.w / 2, sy + info.h / 2];
        c = call.propAt({ asset, at });
        const square = info.w === 1 && info.h === 1 && rng.chance(0.5);
        request = square
          ? `Put ${an(assetInfo(asset)!.name.toLowerCase())} in the square at x ${sx}, y ${sy}.`
          : rng.pick([`Place ${an(asset.replace(/-/g, ' '))} centred at ${n(at[0])}, ${n(at[1])}.`, `Add ${an(asset.replace(/-/g, ' '))} at [${n(at[0])}, ${n(at[1])}].`]);
        answer = (ids) => `Added ${info.name} ${ids[0]} at [${n(at[0])}, ${n(at[1])}] in ${roomRef(room)}.`;
      } else if (kind === 'terrain') {
        const base = outdoor ? null : rooms.length ? rng.pick(rooms) : null;
        let r: Rect;
        if (base) {
          const [x, y, w, h] = rectOf(base);
          const rw = rng.int(2, Math.max(2, w - 1));
          const rh = rng.int(2, Math.max(2, h - 1));
          r = [rng.int(x, x + w - rw), rng.int(y, y + h - rh), rw, rh];
        } else {
          const tb = shapeBounds(ofType(m, 'terrain')[0]?.shape ?? { rect: [0, 0, 20, 14] });
          const rw = rng.int(3, 10);
          const rh = rng.int(3, 8);
          r = [rng.int(tb.x0, Math.max(tb.x0, tb.x1 - rw)), rng.int(tb.y0, Math.max(tb.y0, tb.y1 - rh)), rw, rh];
        }
        const t = rng.pick(TERRAIN_WORDS.filter((x) => (base ? x.indoor : x.outdoor)));
        c = call.terrainRect({ asset: t.asset, rect: r });
        request = rng.pick([`Cover x ${r[0]} to ${r[0] + r[2]}, y ${r[1]} to ${r[1] + r[3]} with ${t.words[0]}.`, `Paint ${t.words[0]} over the rectangle ${r[0]},${r[1]} to ${r[0] + r[2]},${r[1] + r[3]}.`, `${t.words[0]} from x ${r[0]} to ${r[0] + r[2]} and y ${r[1]} to ${r[1] + r[3]}, please.`]);
        answer = (ids) => `Added ${assetInfo(t.asset)!.name.toLowerCase()} ${ids[0]} over x ${r[0]}–${r[0] + r[2]}, y ${r[1]}–${r[1] + r[3]}.`;
      } else if (kind === 'stairs') {
        const room = rng.pick(rooms.filter((r) => rectOf(r)[2] >= 4 && rectOf(r)[3] >= 4 && !propsIn(m, r).length));
        const [x, y, w, h] = rectOf(room);
        const dir = rng.pick(['n', 'e', 's', 'w'] as const);
        const long = dir === 'n' || dir === 's' ? [rng.pick([1, 2]), rng.pick([2, 3])] : [rng.pick([2, 3]), rng.pick([1, 2])];
        const r: Rect = [rng.int(x + 1, Math.max(x + 1, x + w - 1 - long[0]!)), rng.int(y + 1, Math.max(y + 1, y + h - 1 - long[1]!)), long[0]!, long[1]!];
        const dirWord = { n: 'north', e: 'east', s: 'south', w: 'west' }[dir];
        c = call.stairs({ rect: r, direction: dir });
        request = rng.pick([
          `Add stairs from x ${r[0]} to ${r[0] + r[2]}, y ${r[1]} to ${r[1] + r[3]}, going up to the ${dirWord}.`,
          `Put a ${r[2]}×${r[3]} staircase at ${r[0]}, ${r[1]} (top-left) that goes up toward the ${dirWord}.`,
          `stairs at x=${r[0]} y=${r[1]}, ${r[2]} wide, ${r[3]} long, up to the ${dirWord}`,
        ]);
        answer = (ids) => `Added stairs ${ids[0]} at x ${r[0]}–${r[0] + r[2]}, y ${r[1]}–${r[1] + r[3]} in ${roomRef(room)}, going up to the ${dirWord}.`;
      } else if (kind === 'label') {
        const box = m.objects.length ? m.objects.map((o) => ('shape' in o ? shapeBounds(o.shape) : null)).filter((b): b is NonNullable<typeof b> => Boolean(b)) : [];
        const x = box.length ? rng.int(Math.floor(Math.min(...box.map((b) => b.x0))), Math.ceil(Math.max(...box.map((b) => b.x1)))) : rng.int(2, 20);
        const y = box.length ? rng.int(Math.floor(Math.min(...box.map((b) => b.y0))), Math.ceil(Math.max(...box.map((b) => b.y1)))) : rng.int(2, 14);
        const text = rng.pick(LABEL_TEXTS);
        c = call.labelAt({ text, at: [x, y] });
        request = rng.pick([`Put the label "${text}" at ${x}, ${y}.`, `Write "${text}" at x ${x}, y ${y}.`]);
        answer = (ids) => `Added label ${ids[0]} "${text}" at [${x}, ${y}].`;
      } else if (kind === 'row') {
        let path: [number, number][];
        let asset: string;
        let spacing: number;
        let what: string;
        if (outdoor || !rooms.length) {
          const tb = shapeBounds(ofType(m, 'terrain')[0]?.shape ?? { rect: [0, 0, 24, 16] });
          const y = rng.int(tb.y0 + 2, tb.y1 - 2);
          path = [[tb.x0 + 1, y], [tb.x1 - 1, y]];
          asset = rng.pick(['c-oak-a', 'c-pine-a', 'c-birch-a', 'tree']);
          spacing = rng.pick([3, 4, 5]);
          what = rng.pick(['trees', 'a row of trees', 'a line of trees']);
        } else {
          const room = rng.pick(rooms.filter((r) => rectOf(r)[2] >= 7));
          const [x, y, w, h] = rectOf(room);
          const yy = y + (rng.chance(0.5) ? 1.5 : h - 1.5);
          path = [[x + 1.5, yy], [x + w - 1.5, yy]];
          asset = rng.pick(['statue', 'brazier', 'pillar-broken', 'sconce']);
          spacing = rng.pick([2, 3]);
          what = rng.pick([`a row of ${asset === 'pillar-broken' ? 'broken pillars' : `${asset}s`}`, `${asset === 'pillar-broken' ? 'broken pillars' : `${asset}s`}`]);
        }
        c = call.propsPath({ asset, path, spacing, placement: 'regular' });
        request = rng.pick([
          `Add ${what} from ${n(path[0]![0])}, ${n(path[0]![1])} to ${n(path[1]![0])}, ${n(path[1]![1])}, one every ${spacing} squares.`,
          `Put ${what} along the line from [${n(path[0]![0])}, ${n(path[0]![1])}] to [${n(path[1]![0])}, ${n(path[1]![1])}], ${spacing} squares apart.`,
        ]);
        answer = (ids) => `Added ${ids.length} × ${assetInfo(asset)!.name.toLowerCase()} (${idRange(ids)}) from [${n(path[0]![0])}, ${n(path[0]![1])}] to [${n(path[1]![0])}, ${n(path[1]![1])}], ${spacing} squares apart.`;
      } else {
        const tb = shapeBounds(ofType(m, 'terrain')[0]!.shape);
        const [w, h] = [rng.int(3, 8), rng.int(3, 7)];
        const r: Rect = [rng.int(tb.x0, Math.max(tb.x0, tb.x1 - w)), rng.int(tb.y0, Math.max(tb.y0, tb.y1 - h)), w, h];
        const ht = heightText(rng, m, 'cliff');
        const edge = rng.pick(['cliff', 'slope', 'rock'] as const);
        c = call.heightRect({ rect: r, height: ht.arg, edge });
        request = `Raise x ${r[0]} to ${r[0] + w}, y ${r[1]} to ${r[1] + h} by ${ht.said}${edge === 'slope' ? ' as a slope' : edge === 'rock' ? ' with a rock face' : ' with a cliff edge'}.`;
        answer = (ids) => `Raised x ${r[0]}–${r[0] + w}, y ${r[1]}–${r[1] + h} by ${ht.arg} (height area ${ids[0]}) with ${an(edge)} edge.`;
      }
      const runs = await works(convo, c);
      if (!runs || !runs[0]!.added.length) continue;
      if (kind === 'row' && runs[0]!.added.length < 2) continue;
      await convo.user(request);
      const [r] = await convo.step(c);
      await convo.answer(answer(r!.added.map((o) => o.id)));
      const expectArgs = JSON.stringify(c.args);
      return {
        variant: kind,
        check(final, start) {
          const a = added(start, final);
          return a.length ? [] : [`nothing added for ${expectArgs}`];
        },
      };
    }
    skip('no coordinates work');
  },
};


// ---------- an outdoor map from scratch ----------

const GROUNDS: { words: string[]; asset: string }[] = [
  { words: ['grass', 'a meadow of grass'], asset: 'grass' },
  { words: ['short grass'], asset: 'c-ground-grass-short' },
  { words: ['snow'], asset: 'snow' },
  { words: ['sand', 'desert sand'], asset: 'sand' },
  { words: ['dirt', 'bare dirt'], asset: 'dirt' },
  { words: ['swamp'], asset: 'swamp' },
];

export const outdoorScratch: Family = {
  id: 'outdoor_scratch',
  title: 'An outdoor map from scratch: ground over the area the user gives, then water, trees, rocks, a stream or a hut by region, then check_map',
  weight: 3,
  start: (rng) => ({ kind: 'empty', unit: rng.chance(0.5) ? 'm' : 'ft' }),
  async run({ rng, convo }) {
    const m = convo.map;
    const W = rng.int(20, 40);
    const H = rng.int(14, 30);
    const g = rng.pick(GROUNDS);
    const ground = call.terrainRect({ asset: g.asset, rect: [0, 0, W, H] });
    type Feature = { key: string; say: string; calls: Call[]; answer: (ids: string[][]) => string };
    const pool: Feature[] = [];
    const c1 = rng.pick(CORNERS);
    const pondSize = rng.int(4, 8);
    const water = rng.pick(['c-water-pond', 'water-shallow', 'water-deep']);
    pool.push({ key: 'pond', say: `a pond in the ${CORNER_WORDS[c1]} corner`, calls: [call.terrainRegion({ asset: water, region: region.corner(c1, pondSize) })], answer: (ids) => `a pond ${ids[0]![0]} in the ${CORNER_WORDS[c1]} corner` });
    const side = rng.pick(SIDES.filter((s) => s !== 'north'));
    const tree = rng.pick(['c-oak-a', 'c-pine-a', 'c-birch-a']);
    const depth = rng.int(3, 5);
    pool.push({ key: 'trees', say: `${rng.pick(['trees', 'a strip of forest', 'woods'])} along the ${side} edge, ${depth} squares deep`, calls: [call.propsRegion({ asset: tree, region: region.edge(side, depth) })], answer: (ids) => `${ids[0]!.length} trees (${idRange(ids[0]!)}) along the ${side} edge` });
    const c2 = rng.pick(CORNERS.filter((c) => c !== c1));
    pool.push({ key: 'boulders', say: `some boulders in the ${CORNER_WORDS[c2]} corner`, calls: [call.propsRegion({ asset: 'c-boulder-a', region: region.corner(c2, rng.int(4, 7)) })], answer: (ids) => `${ids[0]!.length} boulders (${idRange(ids[0]!)}) in the ${CORNER_WORDS[c2]} corner` });
    const [a, b] = rng.pick([['north', 'south'], ['west', 'east']] as [Side, Side][]);
    pool.push({ key: 'stream', say: `a stream from the ${a} edge to the ${b} edge`, calls: [call.terrainRegion({ asset: 'water-shallow', region: region.between(a, b, 2) })], answer: (ids) => `a stream ${ids[0]![0]} from the ${a} edge to the ${b} edge` });
    const c3 = rng.pick(CORNERS.filter((c) => c !== c1 && c !== c2));
    const metricMap = unitOf(m).name === 'm';
    const ledgeH = metricMap ? `${rng.pick([2, 3, 4])} m` : `${rng.pick([10, 15, 20])} ft`;
    pool.push({ key: 'ledge', say: `a rocky ledge ${ledgeH} high in the ${CORNER_WORDS[c3]} corner`, calls: [call.heightRegion({ region: region.corner(c3, rng.int(5, 8)), height: ledgeH, edge: 'rock' })], answer: (ids) => `a ${ledgeH} rocky ledge ${ids[0]![0]} in the ${CORNER_WORDS[c3]} corner` });
    const [hw, hh] = [rng.int(4, 6), rng.int(4, 5)];
    const hut: Rect = [Math.floor(W / 2 - hw / 2), Math.floor(H / 2 - hh / 2), hw, hh];
    const hutDoor = rng.pick(SIDES);
    pool.push({
      key: 'hut',
      say: `a ${hw}×${hh} hut at x ${hut[0]}, y ${hut[1]} with a door on its ${hutDoor} side`,
      calls: [call.roomRect({ rect: hut, name: 'Hut' }), call.doorOnWall({ room: 'r1', wall: hutDoor })],
      answer: (ids) => `the hut ${ids[0]![0]} with door ${ids[1]?.[0]} on its ${hutDoor} side`,
    });
    const chosen = rng.sample(pool, rng.int(1, 3));
    // the hut's door needs the hut: it goes last, in its own step
    const parallel = chosen.flatMap((f) => (f.key === 'hut' ? [f.calls[0]!] : f.calls));
    const hutChosen = chosen.some((f) => f.key === 'hut');
    if (!(await works(convo, ground, ...parallel, ...(hutChosen ? [pool.find((f) => f.key === 'hut')!.calls[1]!] : [])))) skip('outdoor plan does not fit');
    const request =
      rng.pick([`This is an empty outdoor map. Cover x 0 to ${W}, y 0 to ${H} with ${rng.pick(g.words)}, then add `, `Make an outdoor area, ${W} by ${H} squares from 0,0, of ${rng.pick(g.words)}. Add `, `New wilderness map: ${rng.pick(g.words)} over x 0–${W}, y 0–${H}, and `]) +
      `${list(chosen.map((f) => f.say))}.`;
    await convo.user(request);
    const [rg] = await convo.step(ground);
    const runs = await convo.step(...parallel);
    const ids: string[][] = runs.map((r) => r.added.map((o) => o.id));
    let k = 0;
    const perFeature: string[][][] = chosen.map((f) => (f.key === 'hut' ? [ids[k++]!] : f.calls.map(() => ids[k++]!)));
    if (hutChosen) {
      const [dr] = await convo.step(pool.find((f) => f.key === 'hut')!.calls[1]!);
      perFeature[chosen.findIndex((f) => f.key === 'hut')]!.push(dr!.added.map((o) => o.id));
    }
    const [chk] = await convo.step(call.check());
    if (!said.noProblems(chk!.text)) skip('check_map not clean');
    await convo.answer(`Covered x 0–${W}, y 0–${H} with ${assetInfo(g.asset)!.name.toLowerCase()} (${rg!.added[0]!.id}) and added ${list(chosen.map((f, i) => f.answer(perFeature[i]!)))}. check_map finds no problems.`);
    return {
      variant: chosen.map((f) => f.key).sort().join('+'),
      check(final, start) {
        const errs: string[] = [];
        const a2 = added(start, final);
        if (!a2.some((o) => o.type === 'terrain' && o.asset === g.asset)) errs.push('no ground');
        if (a2.length < 1 + chosen.length) errs.push('features missing');
        return errs;
      },
    };
  },
};
