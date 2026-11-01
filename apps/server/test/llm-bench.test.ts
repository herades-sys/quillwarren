// The local-model benchmark's checks (cli/llm-bench-lib.ts): for each task a
// map built the right way passes, and typical mistakes give partial or fail.
// The maps come from Quillwarren's own templates and ops, no model involved.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOps, connectOps, type DelveMap, type MapObject, type Op } from '@delve/core';
import { buildApp } from '../src/app.ts';
import { emptyStats, type CallRecord } from '../src/chat/local-agent.ts';
import { allConnected, callLog, grade, pickTasks, renderReport, TASKS, toOutline, type BenchTask, type Check, type CheckInput, type RunResult } from '../src/cli/llm-bench-lib.ts';

const TOKEN = 'llm-bench-test-token';
let app: ReturnType<typeof buildApp>;
const templates = new Map<string, { map: DelveMap; rev: number }>();

beforeAll(async () => {
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  for (const [key, payload] of [
    ['test-dungeon', { name: 'bench', template: 'test-dungeon' }],
    ['empty', { name: 'bench', template: 'empty' }],
    ['empty-m', { name: 'bench', template: 'empty', unit: '1.5 m' }],
  ] as const) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/maps', headers: { authorization: `Bearer ${TOKEN}` }, payload });
    templates.set(key, res.json() as { map: DelveMap; rev: number });
  }
});
afterAll(async () => {
  await app.close();
});

const task = (id: string): BenchTask => TASKS.find((t) => t.id === id)!;
const add = (object: Record<string, unknown>): Op => ({ op: 'add', object: object as unknown as MapObject });

/** The task's checks on the template after ops (each list of ops one change), with an answer and tool calls. */
function run(id: string, steps: ((m: DelveMap) => Op[])[], extra: Partial<CheckInput> = {}): { checks: Check[]; grade: string } {
  const t = task(id);
  const before = templates.get(t.template === 'empty' && t.unit ? 'empty-m' : t.template)!;
  let map = before.map;
  for (const s of steps) map = applyOps(map, s(map)).map;
  const checks = t.check({ before: before.map, after: map, beforeRev: before.rev, afterRev: before.rev + steps.length, answer: '', calls: [], ...extra });
  return { checks, grade: grade(checks) };
}
const failed = (r: { checks: Check[] }) => r.checks.filter((c) => !c.ok).map((c) => c.name);
const call = (name: string, args: Record<string, unknown>, ok = true): CallRecord => ({ turn: 1, name, args, ok, result: '', ms: 1, source: 'native', repaired: false });

describe('the benchmark tasks', () => {
  it('has 8 tasks, from easy to hard, picked by number or id', () => {
    expect(TASKS.map((t) => t.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(pickTasks('2,t5').map((t) => t.id)).toEqual(['t2-rename-lock', 't5-forest-north']);
    expect(pickTasks('crypt').map((t) => t.n)).toEqual([7]);
    expect(pickTasks(undefined)).toHaveLength(8);
  });

  it('grades: all checks pass, some core check partial, else fail', () => {
    const c = (ok: boolean, core = true): Check => ({ name: 'x', ok, core });
    expect(grade([c(true), c(true, false)])).toBe('pass');
    expect(grade([c(true), c(false)])).toBe('partial');
    expect(grade([c(false), c(true, false)])).toBe('fail');
  });

  it('1: a room east of room 1, joined with a door', () => {
    const room = (rect: number[]) => () => [add({ id: 'r7', type: 'room', shape: { rect }, label: '7' })];
    const link = (m: DelveMap) => connectOps(m, 'r1', 'r7', { doors: 'to' }).ops;
    expect(run('t1-room-east', [room([16, 26, 6, 4]), link])).toMatchObject({ grade: 'pass' });
    // a corridor drawn by hand counts too
    const drawn = () => [add({ id: 'c9', type: 'corridor', width: 2, path: [[13, 28], [16, 28]] }), add({ id: 'd9', type: 'door', at: [16, 27], along: 'y', width: 2 })];
    expect(run('t1-room-east', [room([16, 26, 6, 4]), drawn]).grade).toBe('pass');
    const west = run('t1-room-east', [room([-8, 26, 6, 4]), (m) => connectOps(m, 'r1', 'r7', { doors: 'to' }).ops]);
    expect(failed(west)).toEqual(['it lies east of room 1']);
    expect(west.grade).toBe('partial');
    const noDoor = run('t1-room-east', [room([16, 26, 4, 4]), (m) => connectOps(m, 'r1', 'r7').ops]);
    expect(failed(noDoor)).toEqual(['the new room is 6×4', 'a new door on that connection']);
    // joined to room 2 instead: not a corridor to room 1
    const elsewhere = run('t1-room-east', [room([16, 26, 6, 4]), (m) => connectOps(m, 'r2', 'r7', { doors: 'both' }).ops]);
    expect(failed(elsewhere)).toContain('a corridor joins it to room 1');
    expect(run('t1-room-east', []).grade).toBe('fail');
  });

  it('2: rename room 3 and lock its door', () => {
    const rename = () => [{ op: 'update', id: 'r3', set: { name: 'Armoury' } } as Op];
    const lock = () => [{ op: 'update', id: 'd2', set: { style: 'locked' } } as Op];
    expect(run('t2-rename-lock', [rename, lock]).grade).toBe('pass');
    expect(failed(run('t2-rename-lock', [rename]))).toEqual(['its door is locked']);
    // a new locked door instead of locking the old one
    const extra = run('t2-rename-lock', [rename, () => [add({ id: 'd9', type: 'door', at: [4, 14], along: 'y', width: 1, style: 'locked' })]]);
    expect(failed(extra)).toEqual(['its door is locked', 'no new door added']);
    // the room number changed instead of the name
    expect(failed(run('t2-rename-lock', [() => [{ op: 'update', id: 'r3', set: { label: 'Armoury' } } as Op], lock]))).toEqual(['room 3 is named Armoury', 'room number kept']);
    expect(run('t2-rename-lock', []).grade).toBe('fail');
  });

  it('3: a tavern in room 2', () => {
    // room 2 is rect [6, 15, 8, 6]
    const props = (list: [string, number, number][]) => () => list.map(([asset, x, y], k) => add({ id: `i${k + 1}`, type: 'prop', asset, at: [x, y] }));
    // the table covers x 9–11, y 17.5–18.5; chairs around it, the bar along the north wall
    const good: [string, number, number][] = [['table-rect', 10, 18], ['chair', 8.5, 18], ['chair', 11.5, 18], ['chair', 9.5, 16.5], ['c-stool', 10.5, 19.5], ['bar-counter', 8.5, 15.5]];
    expect(run('t3-tavern', [props(good)]).grade).toBe('pass');
    expect(run('t3-tavern', [props([...good.slice(0, 5), ['c-bar-counter-colour', 11.5, 20.5]])]).grade).toBe('pass');
    const out = run('t3-tavern', [props([...good, ['chair', 3, 3]])]);
    expect(failed(out)).toEqual(['all new props inside room 2']);
    expect(out.grade).toBe('partial');
    // chairs standing on the table, and a bar counter centred on the wall line (the pilot run's mistakes)
    const sloppy = run('t3-tavern', [props([['table-rect', 10, 18], ['chair', 9, 18], ['chair', 11, 18], ['chair', 10, 17], ['chair', 10, 19], ['bar-counter', 10, 15]])]);
    expect(failed(sloppy)).toEqual(['all new props inside room 2', 'no props on top of each other']);
    // table-round has chairs drawn on it, but they are no chair props
    expect(failed(run('t3-tavern', [props([['table-round', 10, 18], ['bar-counter', 8.5, 15.5]])]))).toEqual(['at least four chairs']);
    expect(run('t3-tavern', []).grade).toBe('fail');
  });

  it('4: water in room 5 with a bridge over it', () => {
    // room 5 is rect [4, 1, 12, 10]
    const water = (asset: string, rect: number[]) => () => [add({ id: 't1', type: 'terrain', asset, shape: { rect } })];
    const bridge = (asset: string, at: number[], rotation = 0) => () => [add({ id: 'i1', type: 'prop', asset, at, rotation })];
    expect(run('t4-water-bridge', [water('water-deep', [4, 1, 12, 10]), bridge('plank-bridge', [10, 6])]).grade).toBe('pass');
    expect(run('t4-water-bridge', [water('c-water-pond', [6, 3, 8, 6]), bridge('c-bridge-stone', [10, 6], 90)]).grade).toBe('pass');
    const dry = run('t4-water-bridge', [water('grass', [4, 1, 12, 10]), bridge('plank-bridge', [10, 6])]);
    expect(failed(dry)).toEqual(['water covers room 5', 'the bridge lies over the water', 'the bridge is at least 3 squares long']);
    expect(failed(run('t4-water-bridge', [water('water-shallow', [4, 1, 12, 10]), bridge('plank-bridge', [10, 18])]))).toEqual(['a bridge in room 5', 'the bridge lies over the water', 'the bridge is at least 3 squares long']);
  });

  it('5: a forest along the north edge, with the prop brush', () => {
    const trees = (list: [string, number, number][]) => () => list.map(([asset, x, y], k) => add({ id: `i${k + 1}`, type: 'prop', asset, at: [x, y] }));
    const north: [string, number, number][] = [['c-oak-a', 1, -2], ['c-oak-b', 4, -1.5], ['c-oak-c', 7, -2.5], ['c-oak-a', 10, -1], ['c-oak-b', 13, -2], ['c-oak-c', 16, -1.5]];
    const brush = [call('add_props_along', { asset: 'c-oak-a', path: [[0, -2], [18, -2]] })];
    expect(run('t5-forest-north', [trees(north)], { calls: brush }).grade).toBe('pass');
    expect(failed(run('t5-forest-north', [trees(north)]))).toEqual(['placed with the prop brush']);
    // one kind only, and one in the boss chamber (rect [4, 1, 12, 10])
    const same: [string, number, number][] = [['tree', 1, -2], ['tree', 4, -2], ['tree', 7, -2], ['tree', 10, -2], ['tree', 10, 2]];
    expect(failed(run('t5-forest-north', [trees(same)], { calls: [call('add_props_along', { asset: 'tree', path: [] })] }))).toEqual(['mixed (2+ kinds of tree)', 'none inside a room']);
    // south of the dungeon
    expect(failed(run('t5-forest-north', [trees(north.map(([a, x, y]) => [a, x, 36 - y]))], { calls: brush }))).toEqual(['along the north edge']);
  });

  it('6: grass, a hill in the south-west and a path up to it', () => {
    const base = () => [add({ id: 't1', type: 'terrain', asset: 'grass', shape: { rect: [0, 0, 30, 20] } })];
    const hill = (rect: number[], h = 5, edge = 'slope') => () => [add({ id: 'h1', type: 'height', shape: { rect }, height: h, edge })];
    const path = (rect: number[], asset = 'dirt') => () => [add({ id: 't2', type: 'terrain', asset, shape: { rect } })];
    expect(run('t6-hill-path', [base, hill([2, 11, 10, 7]), path([10, 13, 20, 2])]).grade).toBe('pass');
    expect(run('t6-hill-path', [base, hill([2, 11, 10, 7]), () => [add({ id: 't2', type: 'terrain', asset: 'c-ground-dirt', shape: { poly: [[29, 5], [30, 6], [11, 15], [10, 14]] } })]]).grade).toBe('pass');
    expect(failed(run('t6-hill-path', [base, hill([18, 2, 10, 7], 10, 'cliff'), path([10, 13, 20, 2])]))).toEqual(['a hill 5 high', 'with a slope edge', 'in the south-west', 'on the grass', 'a dirt path from the east up to it']);
    expect(failed(run('t6-hill-path', [hill([2, 11, 10, 7])]))).toEqual(['grass covers the area', 'on the grass', 'a dirt path from the east up to it']);
    // a first try left on the map: the better hill is judged
    const second = () => [add({ id: 'h2', type: 'height', shape: { rect: [2, 11, 10, 7] }, height: 5, edge: 'slope' })];
    expect(run('t6-hill-path', [base, hill([18, 2, 6, 6]), second, path([10, 13, 20, 2])]).grade).toBe('pass');
  });

  it('7: a crypt of 4 connected rooms with a secret door and a sarcophagus', () => {
    const rooms = () => [[0, 0, 6, 6], [10, 0, 6, 6], [0, 10, 6, 6], [10, 10, 8, 8]].map((rect, k) => add({ id: `r${k + 1}`, type: 'room', shape: { rect }, label: String(k + 1) }));
    const link = (a: string, b: string, style?: 'secret') => (m: DelveMap) => connectOps(m, a, b, { doors: 'both', ...(style ? { doorStyle: style } : {}) }).ops;
    const sarc = () => [add({ id: 'i1', type: 'prop', asset: 'sarcophagus', at: [14, 14] })];
    const good = run('t7-crypt', [rooms, link('r1', 'r2'), link('r1', 'r3'), link('r2', 'r4', 'secret'), sarc]);
    expect(good.grade).toBe('pass');
    const apart = run('t7-crypt', [rooms, link('r1', 'r2'), link('r2', 'r4', 'secret'), sarc]);
    expect(failed(apart)).toEqual(['all rooms connected', 'joined by corridors (3 or more)']);
    expect(failed(run('t7-crypt', [rooms, link('r1', 'r2'), link('r1', 'r3'), link('r2', 'r4')]))).toEqual(['a secret door', 'a sarcophagus', 'the secret door sits on a room\'s wall', 'the sarcophagus stands in a room']);
    // a secret door in the middle of a room, and a corridor drawn straight through room 1
    const sloppy = run('t7-crypt', [
      rooms,
      link('r1', 'r2'),
      link('r2', 'r4'),
      () => [add({ id: 'c9', type: 'corridor', width: 2, path: [[3, 10], [3, 3], [10, 3]] }), add({ id: 'd9', type: 'door', at: [3, 2], along: 'y', width: 1, style: 'secret' })],
      sarc,
    ]);
    expect(failed(sloppy)).toEqual(['the secret door sits on a room\'s wall', 'corridors stay out of other rooms']);
    expect(sloppy.checks.find((c) => c.name === 'corridors stay out of other rooms')!.detail).toBe('c9 through r1');
    expect(sloppy.grade).toBe('partial');
    expect(run('t7-crypt', []).grade).toBe('fail');
  });

  it('8: a question answered without changing the map', () => {
    const ask = (answer: string, changes = 0) => run('t8-question', Array.from({ length: changes }, () => () => [{ op: 'update', id: 'r1', set: { notes: 'x' } } as Op]), { answer });
    expect(ask('Room 1 has 2 doors: d1 to the Crossroads and d5, which leads outside.').grade).toBe('pass');
    expect(ask('The Entrance hall has two doors. Door d5 on its south wall leads outside.').grade).toBe('pass');
    expect(ask('Doors of room 1: 2 (d1 and d5); d5 leads outside.').grade).toBe('pass');
    expect(failed(ask('Room 1 has 3 doors; d5 leads outside.'))).toEqual(['says 2 doors']);
    expect(failed(ask('Room 1 has 2 doors: d1 and d5 (outside).', 1))).toEqual(['the map is unchanged']);
    expect(ask('').grade).toBe('partial'); // the map is unchanged, at least
  });

  it('geometry helpers', () => {
    const b = { x0: 0, y0: 0, x1: 6, y1: 4 };
    expect(toOutline([3, 0], b)).toBe(0);
    expect(toOutline([3, 1], b)).toBe(1);
    expect(toOutline([9, 8], b)).toBe(5);
    expect(allConnected(templates.get('test-dungeon')!.map)).toBe(true);
    expect(allConnected(applyOps(templates.get('test-dungeon')!.map, [add({ id: 'r9', type: 'room', shape: { rect: [30, 30, 4, 4] } })]).map)).toBe(false);
  });
});

describe('the report', () => {
  it('sums up runs and lists every task', () => {
    const stats = { ...emptyStats(), turns: 3, toolCalls: 4, toolErrors: 1, repaired: 1, completionTokens: 600, evalMs: 10_000, promptTokens: 9000, promptMs: 3000, maxPrompt: 5000, wallMs: 42_000, thinkChars: 300, outputChars: 100 };
    const run: RunResult = {
      model: 'qwen3:8b',
      tools: 'lean',
      api: 'ollama',
      baseUrl: 'http://192.168.1.40:11434',
      numCtx: 16384,
      serverVersion: '0.35.1',
      delveVersion: 'dev',
      started: '2026-10-06T20:00:00.000Z',
      finished: '2026-10-06T20:10:00.000Z',
      size: { system: 6000, tools: 5000, user: 3000 },
      toolCount: 16,
      tasks: [
        { task: 't2-rename-lock', n: 2, title: 'Rename | lock', prompt: 'p', grade: 'partial', checks: [{ name: 'its door is locked', ok: false, core: true, detail: 'd2 normal' }, { name: 'room 3 is named Armoury', ok: true, core: true }], stop: 'answer', answer: 'Renamed r3.\nDone.', lastText: '', stats, mapId: 'map_1', png: 'qwen3-8b-lean/t2-rename-lock.png', transcript: 'qwen3-8b-lean/t2-rename-lock.json', callLog: 'update update✗' },
      ],
    };
    const md = renderReport([run, { ...run, tools: 'full' }], new Date('2026-10-06T20:15:00Z'));
    expect(md).toContain('| qwen3:8b | lean | 0 | 1 | 0 | 4 | 1 | 1 | 42 s | 60 | 3000 | 5.0k | 75 % |');
    expect(md).toContain('| 2 | Rename \\| lock | partial 1/2 | partial 1/2 |');
    expect(md).toContain('| 2 | Rename \\| lock | partial | 1/2 | 4 | 1 | 1 | 42 s | 60 | answer | Renamed r3. Done. |');
    expect(md).toContain('not met: its door is locked (d2 normal)');
    expect(md).toContain('[picture](qwen3-8b-lean/t2-rename-lock.png)');
    expect(md).toContain('calls: update update✗');
    // runs with helping steps say which; held-back calls and a final check that handed back are noted per task
    const helped = renderReport([{ ...run, steps: 'ids, final', tasks: [{ ...run.tasks[0]!, stats: { ...stats, notRun: 2, finalChecks: 1 }, callLog: 'add_terrain✗ add_height⊘ add_terrain⊘' }] }]);
    expect(helped).toContain('Helping steps: ids, final.');
    expect(helped).toContain('calls: add_terrain✗ add_height⊘ add_terrain⊘; 2 held back after a failed call (⊘); the final check handed problems back once');
    expect(md).not.toContain('Helping steps');
  });

  it('marks failed and held-back calls in the call log', () => {
    expect(callLog([call('add_terrain', {}, false), { ...call('add_height', {}, false), notRun: true }, call('add_terrain', {})])).toBe('add_terrain✗ add_height⊘ add_terrain');
  });
});
