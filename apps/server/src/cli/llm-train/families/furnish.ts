// Furnishing families: a room furnished by theme (several add_prop calls by
// place, then check_map), single props by place, props the catalog in the
// prompt doesn't list (found with list_assets first), and the prop brush
// (forests along edges, groves, trees round a building, rubble in a room).
import { assetInfo, groupVariants, pointInShape, type DelveMap } from '@delve/core';
import type { Sandbox } from '../convo.ts';
import type { ToolRun } from '../delve.ts';
import { assetName, boxOf, idRange, isRect, list, newProblems, ofType, propsIn, roomRef, uniqueName, type Room } from '../kit.ts';
import type { Rng } from '../rng.ts';
import { PLACE_PHRASES, PROP_WORDS, THEMES, type Theme, type ThemeStep } from '../themes.ts';
import { call, CORNERS, region, said, SIDES, type Call, type Corner } from '../tools.ts';
import { ask, clean, numWord, refRoom, skip, works, type Family, type FamilyResult } from './common.ts';

const CORNER_WORDS: Record<Corner, string> = { ne: 'north-east', nw: 'north-west', se: 'south-east', sw: 'south-west' };

/** A placed step: the call that worked, the ids it made, where in words, and the earlier prop it needs (around / near). */
interface Placed {
  step: ThemeStep;
  call: Call;
  ids: string[];
  where: string;
  after?: Placed;
}

/** Did a wall or corner placement land where it was meant to (flush, in the corner)? */
const landed = (r: ToolRun, place: string): boolean => {
  if (!clean(r) || !r.added.length) return false;
  if (/wall$/.test(place)) return said.againstWall(r.text);
  if (/corner$/.test(place)) return said.inCorner(r.text);
  if (/^around /.test(place)) return said.allFit(r.text);
  return true;
};

/**
 * Plan a theme in a room on a sandbox, in the order the conversation will
 * make the calls: each step at a place that works, optional steps left out
 * (`use`) or dropped when they don't fit. `of` in a step is an index into
 * `steps`.
 */
async function planTheme(box: Sandbox, rng: Rng, room: Room, steps: readonly ThemeStep[], use: readonly boolean[], startMap: DelveMap): Promise<Placed[] | null> {
  const byStep: (Placed | null)[] = [];
  const out: Placed[] = [];
  const usedCorners = new Set<Corner>();
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si]!;
    byStep[si] = null;
    if (!use[si]) continue;
    const p = step.place;
    const count = step.count ?? 1;
    let after: Placed | undefined;
    let candidates: { place: string; where: string; count?: number; corners?: Corner[] }[] = [];
    if (p.kind === 'center') candidates = [{ place: 'center', where: 'in the middle' }];
    else if (p.kind === 'wall') candidates = rng.shuffle(p.side ? [p.side] : SIDES).map((s) => ({ place: `${s} wall`, where: `against the ${s} wall`, ...(count > 1 ? { count } : {}) }));
    else if (p.kind === 'corner') {
      const free = rng.shuffle(CORNERS.filter((c) => !usedCorners.has(c)));
      candidates = count > 1 ? [{ place: '', where: '', corners: free.slice(0, count) }] : free.map((c) => ({ place: `${c} corner`, where: `in the ${CORNER_WORDS[c]} corner` }));
    } else {
      after = byStep[p.of] ?? undefined;
      if (!after) {
        if (step.optional) continue;
        return null;
      }
      const tid = after.ids[0]!;
      candidates = p.kind === 'around' ? [{ place: `around ${tid}`, where: `around ${tid}`, count: p.count }] : [{ place: `near ${tid}`, where: `next to ${tid}` }];
    }
    for (const cand of candidates) {
      if (cand.corners) {
        // statues in two corners: one call per corner
        const calls = cand.corners.map((c) => call.propIn({ asset: step.asset, in: room.id, place: `${c} corner` }));
        const runs: ToolRun[] = [];
        for (const c of calls) {
          const r = await box.keep(c, (x) => landed(x, c.args.place as string));
          if (!r) break;
          runs.push(r);
        }
        if (runs.length === calls.length) {
          cand.corners.forEach((c) => usedCorners.add(c));
          calls.forEach((c, k) => out.push({ step, call: c, ids: runs[k]!.added.map((o) => o.id), where: `in the ${CORNER_WORDS[cand.corners![k]!]} corner` }));
          byStep[si] = out[out.length - calls.length]!;
          break;
        }
        // undo the corners that did go in, so a later candidate starts clean
        for (let k = 0; k < runs.length; k++) await box.run(call.undo());
        continue;
      }
      const c = call.propIn({ asset: step.asset, in: room.id, place: cand.place, ...(cand.count && cand.count > 1 ? { count: cand.count } : {}) });
      const r = await box.keep(c, (x) => landed(x, cand.place));
      if (!r) continue;
      if (/corner$/.test(cand.place)) usedCorners.add(cand.place.split(' ')[0] as Corner);
      const placed: Placed = { step, call: c, ids: r.added.map((o) => o.id), where: cand.where, ...(after ? { after } : {}) };
      out.push(placed);
      byStep[si] = placed;
      break;
    }
    if (!byStep[si] && !step.optional) return null;
  }
  return newProblems(startMap, box.map).length ? null : out;
}

/** Calls in order, one assistant reply per run of calls that don't need each other's ids. */
export function groupCalls<T>(items: readonly T[], needs: (item: T) => T | undefined): T[][] {
  const groups: T[][] = [];
  let cur: T[] = [];
  for (const it of items) {
    const dep = needs(it);
    if (dep !== undefined && cur.includes(dep)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(it);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const itemText = (p: Placed): string => {
  const k = p.ids.length;
  const word = k > 1 ? `${k} ${p.step.plural ?? p.step.word}` : p.step.word;
  return `${word} ${p.where.replace(/^next to (i\d+)$/, 'next to $1')} (${idRange(p.ids)})`;
};

export const furnishTheme: Family = {
  id: 'furnish_theme',
  title: 'Furnish a room by theme: several add_prop calls by place (walls, corners, center, around/near an earlier prop), then check_map',
  weight: 9,
  start: (rng) => ({ kind: rng.chance(0.75) ? 'dungeon' : 'small', furnished: rng.chance(0.25) }),
  async run({ rng, convo }): Promise<FamilyResult> {
    const m = convo.map;
    const rooms = ofType(m, 'room').filter((r) => isRect(r) && propsIn(m, r).length === 0);
    for (let attempt = 0; attempt < 8; attempt++) {
      if (!rooms.length) break;
      const room = rng.pick(rooms);
      const b = boxOf(room);
      const [w, h] = [b.x1 - b.x0, b.y1 - b.y0];
      const fits = THEMES.filter((t) => (w >= t.min[0] && h >= t.min[1]) || (w >= t.min[1] && h >= t.min[0]));
      if (!fits.length) continue;
      const theme: Theme = rng.pick(fits);
      const listed = rng.chance(0.45);
      const use = theme.steps.map((s) => !s.optional || rng.chance(listed ? 0.5 : 0.6));
      const box = await convo.sandbox();
      let plan: Placed[] | null;
      try {
        plan = await planTheme(box, rng, room, theme.steps, use, m);
      } finally {
        await box.close();
      }
      if (!plan || plan.length < 2) continue;
      // the user's words
      const ref = refRoom(rng, room, { unique: uniqueName(m, room) });
      const themeWord = rng.pick(theme.words);
      let request: string;
      if (listed) {
        const items = plan.reduce<string[]>((acc, p, i) => {
          if (i > 0 && plan![i - 1]!.step === p.step) return acc; // two corners of one step: said once
          const k = p.step.place.kind === 'corner' && (p.step.count ?? 1) > 1 ? p.step.count! : p.ids.length;
          acc.push(k > 1 ? `${numWord(rng, k)} ${p.step.plural ?? p.step.word}` : p.step.word);
          return acc;
        }, []);
        request = rng.pick([
          `Furnish ${ref.text} as ${themeWord}: ${list(items)}.`,
          `Turn ${ref.text} into ${themeWord} with ${list(items)}.`,
          `${ref.text.charAt(0).toUpperCase()}${ref.text.slice(1)} is ${themeWord}. Put in ${list(items)}.`,
          `Make ${ref.text} ${themeWord}: I want ${list(items)}.`,
        ]);
      } else {
        request = ask(rng, rng.pick([`furnish ${ref.text} as ${themeWord}`, `make ${ref.text} look like ${themeWord}`, `set up ${ref.text} as ${themeWord}`, `fill ${ref.text} with furniture for ${themeWord}`]));
      }
      await convo.user(request, ref.selection ? { selection: ref.selection } : {});
      // the calls in plan order, one reply per run of calls that don't need each other's ids
      for (const group of groupCalls(plan, (p) => p.after)) await convo.step(...group.map((p) => p.call));
      const checkRun = plan.length >= 3 ? await convo.step(call.check()) : null;
      if (checkRun && !said.noProblems(checkRun[0]!.text)) skip('check_map not clean');
      // ids as the conversation made them (the same as the plan's: same map, same order)
      const real = convo.turn.steps.flat().filter((s) => s.name === 'add_prop');
      plan.forEach((p, i) => (p.ids = real[i]!.run.added.map((o) => o.id)));
      const parts = plan.map(itemText);
      await convo.answer(`Furnished ${roomRef(room)} as ${themeWord}: ${list(parts)}.${checkRun ? ' check_map finds no problems.' : ''}`);
      const assets = plan.flatMap((p) => p.ids.map(() => p.step.asset));
      return {
        variant: `${theme.id}${listed ? '+list' : ''}`,
        check(final) {
          const errs: string[] = [];
          const r = final.objects.find((o) => o.id === room.id) as Room | undefined;
          if (!r) return ['room gone'];
          const ps = ofType(final, 'prop').filter((p) => !m.objects.some((o) => o.id === p.id));
          if (ps.length !== assets.length) errs.push(`${ps.length} props, planned ${assets.length}`);
          for (const p of ps) if (!pointInShape(r.shape, p.at)) errs.push(`${p.id} outside`);
          if ([...ps.map((p) => p.asset)].sort().join() !== [...assets].sort().join()) errs.push('assets differ');
          return errs;
        },
      };
    }
    skip('no empty room fits a theme');
  },
};

// ---------- one prop by place ----------

const PROP_KINDS_INDOOR = Object.keys(PROP_WORDS).filter((a) => !['campfire', 'tent', 'boulder', 'boulder-large', 'tree-dead', 'stump', 'log'].includes(a));

export const singleProp: Family = {
  id: 'single_prop',
  title: 'One prop (or a few) by place in a room: center, against a wall, in a corner, next to another prop',
  weight: 7,
  start: (rng) => ({ kind: rng.weighted<'dungeon' | 'small' | 'outdoor'>([['dungeon', 6], ['small', 3], ['outdoor', 1]]), furnished: rng.chance(0.5) }),
  async run({ rng, convo }) {
    const m = convo.map;
    const rooms = ofType(m, 'room');
    for (let attempt = 0; attempt < 12 && rooms.length; attempt++) {
      const room = rng.pick(rooms);
      const asset = rng.pick(PROP_KINDS_INDOOR);
      const info = assetInfo(asset);
      if (!info || info.kind !== 'prop') continue;
      const here = propsIn(m, room).filter((p) => assetInfo(p.asset)?.layer !== 'floor');
      const placeKind = rng.weighted<string>([['center', 3], ['wall', 4], ['corner', 4], ['near', here.length ? 3 : 0]]);
      let place: string;
      let words: string;
      const count = (placeKind === 'wall' || placeKind === 'corner') && rng.chance(0.12) ? 2 : 1;
      if (placeKind === 'center') {
        place = 'center';
        words = rng.pick(PLACE_PHRASES.center!);
      } else if (placeKind === 'wall') {
        const s = rng.pick(SIDES);
        place = `${s} wall`;
        words = rng.pick(PLACE_PHRASES[place]!);
      } else if (placeKind === 'corner') {
        const c = rng.pick(CORNERS);
        place = `${c} corner`;
        words = rng.pick(PLACE_PHRASES[place]!);
      } else {
        const t = rng.pick(here);
        place = `near ${t.id}`;
        words = `next to the ${assetName(t.asset).toLowerCase()} (${t.id}) in`;
      }
      const c = call.propIn({ asset, in: room.id, place, count: count > 1 ? count : undefined });
      const runs = await works(convo, c);
      if (!runs || !landed(runs[0]!, place) || runs[0]!.added.length !== count) continue;
      const ref = refRoom(rng, room, { unique: uniqueName(m, room) });
      const what = count > 1 ? `two ${(PROP_WORDS[asset]![0]!).replace(/^(a|an|some) /, '')}s` : rng.pick(PROP_WORDS[asset]!);
      const verb = rng.weighted<string>([['put', 4], ['add', 4], ['place', 2]]);
      const hidden = asset === 'pressure-plate' || asset === 'spike-trap';
      await convo.user(ask(rng, `${verb} ${what} ${words} ${ref.text}`), ref.selection ? { selection: ref.selection } : {});
      const [r] = await convo.step(c);
      const ids = r!.added.map((o) => o.id);
      const whereAns = placeKind === 'near' ? `next to ${place.slice(5)} in` : placeKind === 'center' ? 'in the middle of' : placeKind === 'wall' ? `against the ${place.replace(' wall', '')} wall of` : `in the ${CORNER_WORDS[place.slice(0, 2) as Corner]} corner of`;
      await convo.answer(`Added ${count > 1 ? `2 × ${info.name}` : info.name} ${idRange(ids)} ${whereAns} ${roomRef(room)}${placeKind === 'wall' ? ', facing into the room' : ''}.${hidden ? ' It is hidden from the players.' : ''}`);
      return {
        variant: placeKind,
        check(final, start) {
          const ps = ofType(final, 'prop').filter((p) => !start.objects.some((o) => o.id === p.id));
          const errs: string[] = [];
          if (ps.length !== count) errs.push(`${ps.length} props`);
          for (const p of ps) {
            if (p.asset !== asset) errs.push('asset');
            if (!pointInShape(room.shape, p.at)) errs.push('outside the room');
          }
          return errs;
        },
      };
    }
    skip('no prop fits');
  },
};

// ---------- props the prompt doesn't list: list_assets first ----------

const LOOKUPS: { words: string[]; search: string; id: string; terrain?: boolean }[] = [
  { words: ['a harp'], search: 'harp', id: 'c-harp' },
  { words: ['a globe'], search: 'globe', id: 'c-globe' },
  { words: ['a bathtub', 'a bath tub'], search: 'bathtub', id: 'c-bathtub' },
  { words: ['a training dummy'], search: 'dummy', id: 'c-training-dummy' },
  { words: ['an archery target'], search: 'archery', id: 'c-archery-target' },
  { words: ['a scarecrow'], search: 'scarecrow', id: 'c-scarecrow' },
  { words: ['a beehive'], search: 'beehive', id: 'c-beehive' },
  { words: ['a dartboard'], search: 'dartboard', id: 'c-dartboard-wall' },
  { words: ['a crystal ball'], search: 'crystal ball', id: 'c-crystal-ball' },
  { words: ['a potion shelf', 'a shelf of potions'], search: 'potion', id: 'c-potion-shelf' },
  { words: ['a suit of armour', 'a suit of armor'], search: 'suit', id: 'c-suit-armor' },
  { words: ['a harpsichord'], search: 'harpsichord', id: 'c-harpsichord' },
  { words: ['a cradle'], search: 'cradle', id: 'c-cradle' },
  { words: ['a folding screen'], search: 'screen', id: 'c-screen-folding' },
  { words: ['a coat rack'], search: 'coat', id: 'c-coat-rack' },
  { words: ['a small stage'], search: 'stage', id: 'c-stage-small' },
  { words: ['a portal'], search: 'portal', id: 'c-portal' },
  { words: ['a reading chair', 'a reading armchair'], search: 'reading', id: 'c-reading-chair' },
  { words: ['a map table'], search: 'map table', id: 'c-map-table' },
  { words: ['a scroll rack'], search: 'scroll', id: 'c-scroll-rack' },
  { words: ['a dresser'], search: 'dresser', id: 'c-dresser' },
  { words: ['a vanity table'], search: 'vanity', id: 'c-vanity' },
  { words: ['a sink'], search: 'sink', id: 'c-sink-basin' },
  { words: ['a cheese rack', 'cheese wheels'], search: 'cheese', id: 'c-cheese-wheels' },
  { words: ['a reliquary'], search: 'reliquary', id: 'c-reliquary' },
  { words: ['a golden idol'], search: 'idol', id: 'c-idol-gold' },
  { words: ['a banner'], search: 'banner', id: 'c-banner-stand' },
  { words: ['oak floorboards', 'an oak plank floor'], search: 'planks', id: 'c-floor-planks-oak', terrain: true },
  { words: ['a marble floor', 'white marble on the floor'], search: 'marble', id: 'c-floor-marble-white', terrain: true },
  { words: ['a chequered marble floor', 'a checkered floor'], search: 'checker', id: 'c-floor-marble-checker', terrain: true },
  { words: ['straw on the floor', 'a straw floor'], search: 'straw', id: 'c-floor-straw', terrain: true },
  { words: ['a mosaic floor'], search: 'mosaic', id: 'c-floor-mosaic', terrain: true },
  { words: ['hexagonal floor tiles', 'hex tiles'], search: 'hex', id: 'c-floor-tiles-hex', terrain: true },
  { words: ['a red carpet floor', 'red carpet everywhere'], search: 'carpet', id: 'c-floor-carpet-red', terrain: true },
  { words: ['brick paving', 'a brick floor'], search: 'brick', id: 'c-floor-brick', terrain: true },
];

export const findAndPlace: Family = {
  id: 'find_and_place',
  title: 'A prop or floor texture the prompt does not list: list_assets search first, then place it',
  weight: 3,
  start: (rng) => ({ kind: rng.chance(0.7) ? 'dungeon' : 'small' }),
  async run({ rng, convo }) {
    const m = convo.map;
    const rooms = ofType(m, 'room').filter(isRect);
    for (let attempt = 0; attempt < 10 && rooms.length; attempt++) {
      const item = rng.pick(LOOKUPS);
      if (!assetInfo(item.id)) continue;
      const room = rng.pick(rooms);
      const search = call.listAssets(item.search);
      const [found] = await convo.probe(search);
      if (!found || found.isError || !found.text.includes(item.id)) continue;
      const ref = refRoom(rng, room, { unique: uniqueName(m, room) });
      let place = '';
      let c: Call;
      if (item.terrain) {
        c = call.terrainRegion({ asset: item.id, region: region.in(room.id) });
      } else {
        place = rng.pick(['center', `${rng.pick(SIDES)} wall`, `${rng.pick(CORNERS)} corner`]);
        c = call.propIn({ asset: item.id, in: room.id, place });
      }
      const runs = await works(convo, c);
      if (!runs || (place && !landed(runs[0]!, place))) continue;
      const word = rng.pick(item.words);
      const request = item.terrain
        ? ask(rng, rng.pick([`give ${ref.text} ${word}`, `put ${word} in ${ref.text}`]))
        : ask(rng, `${rng.pick(['put', 'add', 'place'])} ${word} ${rng.pick(PLACE_PHRASES[place]!)} ${ref.text}`);
      await convo.user(request, ref.selection ? { selection: ref.selection } : {});
      await convo.step(search);
      const [r] = await convo.step(c);
      const id = r!.added[0]!.id;
      const name = assetInfo(item.id)!.name;
      await convo.answer(
        item.terrain
          ? `Covered ${roomRef(room)} with ${name} (${item.id}, terrain ${id}).`
          : `Added ${name} ${id} (${item.id}) ${place === 'center' ? 'in the middle of' : place.endsWith('wall') ? `against the ${place.replace(' wall', '')} wall of` : `in the ${CORNER_WORDS[place.slice(0, 2) as Corner]} corner of`} ${roomRef(room)}.`,
      );
      return {
        variant: item.terrain ? 'texture' : 'prop',
        check(final, start) {
          const added = final.objects.filter((o) => !start.objects.some((x) => x.id === o.id));
          return added.length === 1 && 'asset' in added[0]! && added[0].asset === item.id ? [] : ['not added'];
        },
      };
    }
    skip('nothing to look up');
  },
};

// ---------- the prop brush ----------

const FOREST: { words: string[]; asset: string; lookup?: string }[] = [
  { words: ['an oak forest', 'oak trees', 'a forest of oaks'], asset: 'c-oak-a' },
  { words: ['a pine forest', 'pine trees', 'some pines'], asset: 'c-pine-a' },
  { words: ['birch trees', 'a birch wood', 'a stand of birches'], asset: 'c-birch-a' },
  { words: ['a forest', 'some woods', 'trees', 'a mixed forest'], asset: 'c-oak-a' },
  { words: ['beech trees', 'a beech wood'], asset: 'c-beech-a', lookup: 'beech' },
  { words: ['fir trees', 'a fir forest'], asset: 'c-fir-a', lookup: 'fir' },
  { words: ['spruces', 'a spruce forest'], asset: 'c-spruce-a', lookup: 'spruce' },
  { words: ['maple trees', 'maples'], asset: 'c-maple-a', lookup: 'maple' },
  { words: ['dead trees', 'a dead forest'], asset: 'tree-dead' },
];
const SCATTER: { words: string[]; asset: string }[] = [
  { words: ['rubble', 'debris and rubble'], asset: 'rubble' },
  { words: ['mushrooms', 'glowing mushrooms'], asset: 'mushrooms' },
  { words: ['bones', 'old bones'], asset: 'bones' },
  { words: ['crates', 'boxes'], asset: 'crate' },
  { words: ['stalagmites'], asset: 'stalagmites' },
];

export const propsAlong: Family = {
  id: 'props_along',
  title: 'The prop brush by region: forests along an edge, groves in a corner, trees around a building, things scattered in a room',
  weight: 5,
  start: (rng) => ({ kind: rng.weighted<'dungeon' | 'outdoor'>([['dungeon', 4], ['outdoor', 6]]) }),
  async run({ rng, convo }) {
    const m = convo.map;
    const rooms = ofType(m, 'room');
    const outdoor = ofType(m, 'terrain').length > 0 && rooms.length < 3;
    for (let attempt = 0; attempt < 10; attempt++) {
      const where = rng.weighted<'edge' | 'corner' | 'around' | 'in' | 'row'>([['edge', 5], ['corner', outdoor ? 3 : 1], ['around', rooms.length && outdoor ? 2 : 0], ['in', rooms.length ? 2 : 0], ['row', outdoor ? 2 : 0]]);
      let asset: string;
      let words: string;
      let lookup: string | undefined;
      if (where === 'in') {
        const s = rng.pick(SCATTER);
        asset = s.asset;
        words = rng.pick(s.words);
      } else {
        const f = rng.pick(FOREST);
        asset = f.asset;
        words = rng.pick(f.words);
        lookup = f.lookup;
      }
      let reg;
      let whereText: string;
      let answerWhere: string;
      let target: Room | undefined;
      if (where === 'edge') {
        // never the north edge: a forest along the north edge is an llm-bench task, kept out of the training data
        const side = rng.pick(SIDES.filter((s) => s !== 'north'));
        const depth = rng.chance(0.5) ? rng.int(3, 6) : undefined;
        reg = region.edge(side, depth);
        whereText = rng.pick([`along the ${side} edge of the map`, `along the ${side} edge`, `on the ${side} side of the map`]) + (depth ? rng.pick([`, ${depth} squares deep`, ` (${depth} deep)`]) : '');
        answerWhere = `in a ${depth ?? 3}-square band along the ${side} edge of the map`;
      } else if (where === 'corner') {
        const c = rng.pick(CORNERS);
        const size = rng.chance(0.5) ? rng.int(5, 9) : undefined;
        reg = region.corner(c, size);
        whereText = `in the ${CORNER_WORDS[c]} corner${size ? `, about ${size} squares across` : ''}`;
        answerWhere = `in the ${CORNER_WORDS[c]} corner of the map`;
      } else if (where === 'row') {
        // a single row of trees from one thing to another: a strip one square wide
        const things = [...rooms.map((r) => r.id), ...ofType(m, 'terrain').filter((t) => /water|pond/.test(t.asset)).map((t) => t.id)];
        if (!things.length) continue;
        const isSide = (x: string) => (SIDES as readonly string[]).includes(x);
        const a = rng.pick(things);
        const b = rng.pick([...things.filter((x) => x !== a), ...SIDES.filter((s) => s !== 'north')].filter((x) => !(isSide(x) && isSide(a))));
        reg = region.between(a, b, 1);
        const tname = (x: string) => (m.objects.find((o) => o.id === x) as { name?: string } | undefined)?.name?.toLowerCase();
        const say = (x: string) => (isSide(x) ? `the ${x} edge` : x.startsWith('r') ? roomRef(rooms.find((r) => r.id === x)!) : tname(x) ? `the ${tname(x)}` : `the water (${x})`);
        whereText = `from ${say(a)} to ${say(b)}`;
        answerWhere = `in a row from ${say(a)} to ${say(b)}`;
        words = rng.pick(['a row of trees', 'a line of trees', 'a tree line', `a row of ${words.replace(/^(a|an|some) /, '').replace(/ (forest|wood)$/, ' trees')}`]);
      } else if (where === 'around') {
        target = rng.pick(rooms);
        const margin = rng.chance(0.5) ? rng.int(2, 4) : undefined;
        reg = region.around(target.id, margin);
        whereText = `around ${target.name ? `the ${target.name.toLowerCase()}` : roomRef(target)}${margin ? `, ${margin} squares out` : ''}`;
        answerWhere = `in a ${margin ?? 2}-square ring around ${roomRef(target)}`;
      } else {
        target = rng.pick(rooms.filter(isRect).length ? rooms.filter(isRect) : rooms);
        reg = region.in(target.id);
        whereText = rng.pick([`over ${roomRef(target)}`, `all over the floor of ${roomRef(target)}`, `across ${roomRef(target)}`]);
        answerWhere = `over ${roomRef(target)}`;
      }
      const spacing = where !== 'in' && rng.chance(0.15) ? rng.pick([2, 3, 4]) : undefined;
      const c = call.propsRegion({ asset, region: reg, spacing });
      const runs = await works(convo, c);
      if (!runs || runs[0]!.added.length < 3) continue;
      const density = spacing ? rng.pick([` Space them about ${spacing} squares apart.`, ` About ${spacing} squares between them.`]) : '';
      const verb = where === 'in' ? rng.pick(['scatter', 'spread', 'put']) : rng.pick(['plant', 'add', 'put', 'grow']);
      await convo.user(`${ask(rng, `${verb} ${words} ${whereText}`)}${density}`);
      if (lookup) await convo.step(call.listAssets(lookup));
      const [r] = await convo.step(c);
      const ids = r!.added.map((o) => o.id);
      const kinds = [...new Set(r!.added.map((o) => (o.type === 'prop' ? (assetInfo(o.asset)?.name ?? o.asset).toLowerCase() : '')))];
      const name = assetInfo(asset)!.name.toLowerCase();
      const groupName = assetInfo(asset)?.group;
      const what = where === 'in' ? `${ids.length} × ${name}` : kinds.length > 1 ? `${ids.length} ${groupName ?? 'mixed'} trees of ${kinds.length} kinds (${idRange(ids)})` : `${ids.length} × ${name} (${idRange(ids)})`;
      await convo.answer(where === 'in' ? `Scattered ${what} (${idRange(ids)}) ${answerWhere}.` : `Planted ${what} ${answerWhere}.`);
      const group = new Set(groupVariants(asset));
      return {
        variant: `${where}${lookup ? '+lookup' : ''}`,
        check(final, start) {
          const added = ofType(final, 'prop').filter((p) => !start.objects.some((o) => o.id === p.id));
          const errs: string[] = [];
          if (added.length < 3) errs.push(`${added.length} props`);
          if (added.some((p) => !group.has(p.asset) && p.asset !== asset)) errs.push('other assets');
          if (where !== 'in' && added.some((p) => rooms.some((rm) => pointInShape(rm.shape, p.at)))) errs.push('in a room');
          if (where === 'in' && target && added.some((p) => !pointInShape(target!.shape, p.at))) errs.push('outside the room');
          return errs;
        },
      };
    }
    skip('brush placed nothing');
  },
};

