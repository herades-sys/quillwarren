import { describe, expect, it } from 'vitest';
import { addMember, applyIntent, chatFor, eventFor, HELP, parseChat, TableError, type ChatMessage, type GameState } from '../src/index.ts';
import { ctx, seq, table } from './fixtures.ts';

/** The fixture game plus p3 "Cleo", p4 "Old Tom" and p5 "Anna". */
function game(): GameState {
  let s = table();
  for (const name of ['Cleo', 'Old Tom', 'Anna']) s = addMember(s, name).state;
  return s;
}

function send(s: GameState, from: string, text: string, ...dice: number[]): ChatMessage {
  const out = applyIntent(s, from, { type: 'chat.send', text }, ctx(...dice));
  expect(out.events).toEqual([]);
  return out.chat!;
}

const who = (s: GameState, m: ChatMessage): string[] => s.members.filter((x) => chatFor(s, x.id, m) !== null).map((x) => x.id);

describe('chat.send', () => {
  it('returns the full message with id, seq and time, and bumps rev', () => {
    const s = game();
    const out = applyIntent(s, 'p1', { type: 'chat.send', text: '  Hello there  ' }, ctx());
    expect(out.chat).toEqual({ id: 'm1', seq: 1, at: 1000, from: 'p1', speaker: 'Ann', kind: 'chat', text: 'Hello there' });
    expect(out.state.rev).toBe(s.rev + 1);
    expect(out.events).toEqual([]);
  });

  it('rolls inline in plain chat', () => {
    const m = send(game(), 'p1', 'I hit for [[2d6+1]]', 3, 4);
    expect(m).toMatchObject({ kind: 'chat', text: 'I hit for {{roll:0}}' });
    expect(m.rolls?.[0]?.total).toBe(8);
  });

  it('/r and /roll send one roll with the expression as text', () => {
    const m = send(game(), 'p2', '/r 2d6+3', 1, 6);
    expect(m).toMatchObject({ kind: 'roll', speaker: 'Bob', text: '2d6+3' });
    expect(m.rolls).toHaveLength(1);
    expect(m.rolls?.[0]?.total).toBe(10);
    expect(send(game(), 'p2', '/ROLL d20', 20)).toMatchObject({ kind: 'roll', text: 'd20' });
    expect(() => send(game(), 'p2', '/r')).toThrow('Usage: /r <dice>, e.g. /r 2d6+3');
    expect(() => send(game(), 'p2', '/r 2d6x')).toThrow("Unexpected 'x' at 4");
  });

  it('/em, /me and /ooc', () => {
    expect(send(game(), 'p1', '/em draws a sword')).toMatchObject({ kind: 'emote', text: 'draws a sword', speaker: 'Ann' });
    expect(send(game(), 'p1', '/me grins')).toMatchObject({ kind: 'emote', text: 'grins' });
    expect(send(game(), 'p1', '/ooc brb [[1d4]]', 2)).toMatchObject({ kind: 'ooc', text: 'brb {{roll:0}}' });
    expect(() => send(game(), 'p1', '/em')).toThrow('Usage: /em <action>');
  });

  it('/desc and /as are for the GM', () => {
    const s = game();
    expect(send(s, 'gm', '/desc The door creaks open.')).toMatchObject({ kind: 'desc', text: 'The door creaks open.' });
    expect(send(s, 'gm', '/as "Old Man" Welcome, [[1d6]] travellers', 5)).toMatchObject({
      kind: 'chat',
      from: 'gm',
      speaker: 'Old Man',
      text: 'Welcome, {{roll:0}} travellers',
    });
    expect(send(s, 'gm', '/as Guard Halt!')).toMatchObject({ speaker: 'Guard', text: 'Halt!' });
    expect(() => send(s, 'p1', '/desc nope')).toThrow('Only the GM can use /desc');
    expect(() => send(s, 'p1', '/as "King" bow')).toThrow('Only the GM can use /as');
    expect(() => send(s, 'gm', '/as "Unclosed hi')).toThrow('Missing the closing " after the name');
    expect(() => send(s, 'gm', '/as Guard')).toThrow('Usage: /as "Name" <message>');
  });

  it('/help answers only the sender', () => {
    const s = game();
    const m = send(s, 'p2', '/help');
    expect(m).toMatchObject({ kind: 'system', from: 'system', text: HELP, to: ['p2'] });
    expect(who(s, m)).toEqual(['p2']);
  });

  it('refuses unknown commands, empty and long lines', () => {
    const s = game();
    expect(() => send(s, 'p1', '/xyz hi')).toThrow(new TableError('Unknown command /xyz (try /help)'));
    expect(() => send(s, 'p1', '/')).toThrow('Unknown command / (try /help)');
    expect(() => send(s, 'p1', '   ')).toThrow('Nothing to send');
    expect(() => send(s, 'p1', 'x'.repeat(2001))).toThrow('Messages are at most 2000 characters');
    expect(send(s, 'p1', 'x'.repeat(2000)).text).toHaveLength(2000);
  });
});

describe('whispers', () => {
  it('go to the sender, the recipient and the GM only', () => {
    const s = game();
    const m = send(s, 'p1', '/w bob psst [[1d4]]', 3);
    expect(m).toMatchObject({ kind: 'whisper', from: 'p1', to: ['p2'], text: 'psst {{roll:0}}' });
    expect(who(s, m)).toEqual(['gm', 'p1', 'p2']);
    // through eventFor too
    expect(eventFor(s, 'p3', { type: 'chat', message: m })).toBeNull();
    expect(eventFor(s, 'p2', { type: 'chat', message: m })).toEqual({ type: 'chat', message: m });
  });

  it('find names by quotes, whole names with spaces, unique prefixes and "gm"', () => {
    const s = game();
    const to = (text: string): string[] | undefined => send(s, 'p2', text).to;
    expect(to('/w "Old Tom" hi')).toEqual(['p4']);
    expect(to('/w old tom hi')).toEqual(['p4']);
    expect(to('/w old hi')).toEqual(['p4']);
    expect(to('/w CLEO hi')).toEqual(['p3']);
    expect(to('/w gm hi')).toEqual(['gm']);
    expect(to('/w ann hi')).toEqual(['p1']); // exact beats the longer "Anna"
    expect(send(s, 'p2', '/w old tom hi').text).toBe('hi');
  });

  it('refuse unknown or ambiguous names and empty whispers', () => {
    const s = game();
    expect(() => send(s, 'p2', '/w zed hi')).toThrow('No one here is called "zed"');
    expect(() => send(s, 'p2', '/w an hi')).toThrow('"an" could be Ann or Anna');
    expect(() => send(s, 'p2', '/w bob')).toThrow('Usage: /w <name> <message>');
    expect(() => send(s, 'p2', '/w')).toThrow('Usage: /w <name> <message>');
  });

  it('a GM whisper reaches its recipient and nobody else', () => {
    const s = game();
    const m = send(s, 'gm', '/w Cleo you hear a voice');
    expect(who(s, m)).toEqual(['gm', 'p3']);
  });
});

describe('GM rolls', () => {
  it('go to the GM in full; the roller only learns that they rolled', () => {
    const s = game();
    const m = send(s, 'p1', '/gr 1d20+2', 17);
    expect(m).toMatchObject({ kind: 'gmroll', to: ['gm', 'p1'], text: '1d20+2' });
    expect(m.rolls?.[0]?.total).toBe(19);
    expect(chatFor(s, 'gm', m)).toBe(m);
    const mine = chatFor(s, 'p1', m)!;
    expect(mine.rolls).toBeUndefined();
    expect(mine.hiddenResult).toBe(true);
    expect(mine.text).toBe('rolled 1d20+2 secretly');
    expect(JSON.stringify(mine)).not.toMatch(/19|17/);
    expect(chatFor(s, 'p2', m)).toBeNull();
    expect(who(s, m)).toEqual(['gm', 'p1']);
  });

  it('from the GM go to the GM alone', () => {
    const s = game();
    const m = send(s, 'gm', '/gmroll 2d6', 1, 2);
    expect(m.to).toEqual(['gm']);
    expect(who(s, m)).toEqual(['gm']);
  });
});

describe('parseChat', () => {
  it('is usable on its own and refuses non-members', () => {
    const s = game();
    expect(parseChat(s, 'p1', '/r 1d6', seq(4))).toMatchObject({ kind: 'roll', speaker: 'Ann' });
    expect(() => parseChat(s, 'p9', 'hi', seq())).toThrow("You aren't in this game");
  });

  it('system messages without `to` reach everyone', () => {
    const s = game();
    const m: ChatMessage = { id: 'm9', seq: 9, at: 0, from: 'system', speaker: 'Quillwarren', kind: 'system', text: 'Ann joined' };
    expect(who(s, m)).toEqual(s.members.map((x) => x.id));
  });
});
