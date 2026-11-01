// Chat lines and their commands (/r, /gr, /w, /em, /ooc, /desc, /as, /help),
// turned into what a ChatMessage needs. Inline [[rolls]] work in every kind
// that carries free text.
import { roll, rollInline, type Rng } from './dice.ts';
import { TableError } from './errors.ts';
import { cleanText } from './game.ts';
import type { ChatKind, GameState, Member, RollResult } from './protocol.ts';

export const MAX_CHAT = 2000;

export interface ParsedChat {
  kind: ChatKind;
  /** "system" for server notes (/help); otherwise the sender. */
  from?: 'system';
  speaker: string;
  text: string;
  rolls?: RollResult[];
  to?: string[];
}

export const HELP = [
  'Commands:',
  '/r <dice> (or /roll): roll dice, e.g. /r 4d6kh3+2',
  '/gr <dice> (or /gmroll): roll so that only the GM sees the result',
  '/w <name> <message>: whisper (quote names with spaces: /w "Old Tom" hello)',
  '/em <action> (or /me): emote',
  '/ooc <message>: out of character',
  '/desc <text>: a description (GM)',
  '/as "Name" <message>: speak as someone else (GM)',
  '[[2d6+3]] anywhere in a line rolls inline.',
  'Dice: NdX or dF; + - * / and ( ); kh/kl/dh/dl N keep or drop; ! explode; r / ro reroll; >N <N count successes; fN failures.',
].join('\n');

/** The member a /w name means: "gm", an exact name, or the one name it starts. */
export function findMember(state: GameState, name: string): Member {
  const lower = name.trim().toLowerCase();
  if (!lower) throw new TableError('Whisper to whom?');
  if (lower === 'gm') {
    const gm = state.members.find((m) => m.role === 'gm');
    if (gm) return gm;
  }
  const exact = state.members.find((m) => m.name.toLowerCase() === lower);
  if (exact) return exact;
  const prefix = state.members.filter((m) => m.name.toLowerCase().startsWith(lower));
  const [only] = prefix;
  if (prefix.length === 1 && only) return only;
  if (prefix.length === 0) throw new TableError(`No one here is called "${name}"`);
  throw new TableError(`"${name}" could be ${prefix.map((m) => m.name).join(' or ')}`);
}

/** Split `"Some Name" rest` or `Word rest`. */
function leadingName(rest: string): { name: string; body: string } {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    if (end === -1) throw new TableError('Missing the closing " after the name');
    return { name: rest.slice(1, end), body: rest.slice(end + 1).trim() };
  }
  const word = /^\S+/.exec(rest)?.[0] ?? '';
  return { name: word, body: rest.slice(word.length).trim() };
}

function whisperTarget(state: GameState, rest: string): { target: Member; body: string } {
  const lower = rest.toLowerCase();
  if (!rest.startsWith('"') && !/^gm(\s|$)/.test(lower)) {
    // "/w Old Tom hello": the longest member name the line starts with, so
    // unquoted names with spaces work too.
    const full = state.members
      .filter((m) => {
        const n = m.name.toLowerCase();
        return lower.startsWith(n) && (lower.length === n.length || /\s/.test(lower[n.length] ?? ''));
      })
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (full) return { target: full, body: rest.slice(full.name.length).trim() };
  }
  const { name, body } = leadingName(rest);
  return { target: findMember(state, name), body };
}

function need(body: string, usage: string): void {
  if (!body) throw new TableError(`Usage: ${usage}`);
}

/** Read one line of chat from `memberId`. Throws TableError (or DiceError) when it can't be sent. */
export function parseChat(state: GameState, memberId: string, text: unknown, rng: Rng): ParsedChat {
  const me = state.members.find((m) => m.id === memberId);
  if (!me) throw new TableError("You aren't in this game");
  if (typeof text !== 'string') throw new TableError('Chat must be text');
  if (text.length > MAX_CHAT) throw new TableError(`Messages are at most ${MAX_CHAT} characters`);
  const line = text.trim();
  if (!line) throw new TableError('Nothing to send');
  const gm = me.role === 'gm';

  const say = (kind: ChatKind, body: string, speaker = me.name): ParsedChat => {
    const inline = rollInline(body, rng);
    return { kind, speaker, text: inline.text, ...(inline.rolls.length ? { rolls: inline.rolls } : {}) };
  };
  const gmOnly = (cmd: string): void => {
    if (!gm) throw new TableError(`Only the GM can use /${cmd}`);
  };

  if (!line.startsWith('/')) return say('chat', line);
  const match = /^\/(\S*)\s*([\s\S]*)$/.exec(line);
  const cmd = (match?.[1] ?? '').toLowerCase();
  const rest = (match?.[2] ?? '').trim();

  switch (cmd) {
    case 'r':
    case 'roll': {
      need(rest, '/r <dice>, e.g. /r 2d6+3');
      const result = roll(rest, rng);
      return { kind: 'roll', speaker: me.name, text: result.expr, rolls: [result] };
    }
    case 'gr':
    case 'gmroll': {
      need(rest, '/gr <dice>, e.g. /gr 1d20');
      const result = roll(rest, rng);
      return { kind: 'gmroll', speaker: me.name, text: result.expr, rolls: [result], to: gm ? [me.id] : ['gm', me.id] };
    }
    case 'w':
    case 'whisper': {
      need(rest, '/w <name> <message>');
      const { target, body } = whisperTarget(state, rest);
      need(body, '/w <name> <message>');
      return { ...say('whisper', body), to: [target.id] };
    }
    case 'em':
    case 'me':
      need(rest, '/em <action>');
      return say('emote', rest);
    case 'ooc':
      need(rest, '/ooc <message>');
      return say('ooc', rest);
    case 'desc':
      gmOnly(cmd);
      need(rest, '/desc <text>');
      return say('desc', rest);
    case 'as': {
      gmOnly(cmd);
      need(rest, '/as "Name" <message>');
      const { name, body } = leadingName(rest);
      const speaker = cleanText(name, 'The name after /as', 80);
      need(body, '/as "Name" <message>');
      return say('chat', body, speaker);
    }
    case 'help':
      return { kind: 'system', from: 'system', speaker: 'Quillwarren', text: HELP, to: [me.id] };
    default:
      throw new TableError(`Unknown command /${cmd.slice(0, 20)} (try /help)`);
  }
}
