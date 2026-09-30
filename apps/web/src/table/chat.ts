// The chat tab: the log (speakers in their member colours, each kind styled,
// roll cards with every die, inline rolls as small boxes with the breakdown on
// hover) and the input, with ↑/↓ through what you sent. Rolling happens on the
// server; this only shows what came back.
import type { ChatMessage, RollResult } from '@delve/table';
import type { TableCtx } from './ctx.ts';
import { $, h, memberMark, store } from './dom.ts';
import { CHAT_KEEP, cardRolls, clock, historyStep, isGm, messageView, rollBreakdown, rollFlags, rollView, segments, showsText } from './logic.ts';

const MAX_DICE_SHOWN = 60;

/** crit/fumble colouring. Card totals only get it for a single die (a natural 20), not for any 6 in 4d6. */
function flagClass(r: RollResult, singleOnly = false): string {
  const f = rollFlags(r);
  if (singleOnly && f.kept !== 1) return '';
  return f.crit && !f.fumble ? ' crit' : f.fumble && !f.crit ? ' fumble' : '';
}

function rollCard(r: RollResult): HTMLElement {
  const v = rollView(r);
  const dice = h('div', { class: 'rc-dice' });
  for (const t of v.terms) {
    if (t.kind === 'op') dice.append(h('span', { class: 'rc-op' }, t.text));
    else if (t.kind === 'number') dice.append(h('span', { class: 'rc-num' }, t.text));
    else {
      const term = h('span', { class: 'rc-term' }, h('span', { class: 'rc-term-name' }, t.text));
      for (const d of t.dice.slice(0, MAX_DICE_SHOWN)) {
        const cls = ['die', d.dropped ? 'dropped' : '', d.max ? 'max' : '', d.min ? 'min' : '', d.exploded ? 'exploded' : '', d.success ? 'succ' : '', d.failure ? 'fail' : ''];
        const why = d.rerolled ? 'rerolled' : d.dropped ? 'dropped' : d.exploded ? 'exploded' : '';
        term.append(h('span', { class: cls.filter(Boolean).join(' '), title: why || undefined }, d.label));
      }
      if (t.dice.length > MAX_DICE_SHOWN) term.append(h('span', { class: 'muted' }, `+${t.dice.length - MAX_DICE_SHOWN} more`));
      dice.append(term);
    }
  }
  return h(
    'div',
    { class: 'roll-card', title: rollBreakdown(r) },
    h('div', { class: 'rc-expr' }, v.expr),
    h('div', { class: `rc-total${flagClass(r, true)}`, 'aria-label': `total ${v.total}` }, v.total),
    dice,
  );
}

function inlineRoll(r: RollResult | null): HTMLElement {
  if (!r) return h('span', { class: 'iroll', title: 'This roll is missing' }, '?');
  const b = rollBreakdown(r);
  return h('span', { class: `iroll${flagClass(r)}`, tabIndex: 0, dataset: { breakdown: b }, 'aria-label': b }, r.total);
}

export function initChat(ctx: TableCtx, visible: () => boolean, onUnread: (n: number) => void): { seen(): void } {
  const log = $('chat-log');
  const form = $<HTMLFormElement>('chat-form');
  const input = $<HTMLTextAreaElement>('chat-input');
  const hint = $('chat-hint');
  const rendered = new Map<string, ChatMessage>();
  let last: ChatMessage | undefined;
  let unread = 0;

  // the command hint under the input
  const cmds: [string, string][] = [
    ['/r 1d20+5', 'roll'],
    ['/w Name …', 'whisper'],
    ['/em …', 'emote'],
    ['/ooc …', 'out of character'],
    ['/gr 1d20', 'roll for the GM only'],
    ['[[2d6]]', 'inline roll'],
  ];
  if (isGm(ctx.me())) cmds.push(['/desc', 'describe'], ['/as "Name"', 'speak as']);
  hint.replaceChildren(...cmds.flatMap(([c, what], i) => [i ? ' · ' : '', h('code', {}, c), ` ${what}`]));

  function messageEl(m: ChatMessage, prev: ChatMessage | undefined): HTMLElement {
    const members = ctx.state()?.view.members ?? [];
    const mv = messageView(m, members);
    const box = h('div', { class: `cm ${mv.kind}`, dataset: { id: m.id } });
    if (mv.color) box.style.setProperty('--c', mv.color);
    const grouped =
      prev !== undefined && prev.from === m.from && prev.speaker === m.speaker && prev.kind === m.kind && (m.kind === 'chat' || m.kind === 'roll') && m.at - prev.at < 120_000;
    if (grouped) box.classList.add('cont');
    if (mv.showSpeaker && m.kind !== 'emote' && !grouped) {
      // the sender's picture, unless the GM speaks as someone else (/as)
      const sender = members.find((x) => x.id === m.from);
      box.append(
        h(
          'div',
          { class: 'cm-head' },
          sender?.avatar && sender.name === m.speaker ? memberMark(sender) : null,
          h('span', { class: 'cm-speaker' }, mv.speaker),
          mv.label ? h('span', { class: 'cm-label' }, mv.label) : null,
          h('time', { class: 'cm-time', dateTime: new Date(m.at).toISOString() }, clock(m.at)),
        ),
      );
    }
    const cards = new Set(cardRolls(m));
    const body = h('div', { class: 'cm-body' });
    if (m.kind === 'emote') body.append(h('span', { class: 'who' }, mv.speaker), ' ');
    for (const s of showsText(m) ? segments(m.text, m.rolls) : []) {
      if (s.kind === 'text') body.append(s.text);
      else if (!cards.has(s.index)) body.append(inlineRoll(s.roll));
    }
    const said = Boolean((body.textContent ?? '').trim() || body.querySelector('.iroll'));
    if (said) box.append(body);
    // the server says "rolled 1d20 secretly" itself; this covers a copy without text
    if (mv.secret) {
      body.classList.add('roll-secret');
      if (!said) box.append(h('div', { class: 'roll-secret' }, 'rolled secretly'));
    }
    for (const i of cards) {
      const r = m.rolls?.[i];
      if (r) box.append(rollCard(r));
    }
    return box;
  }

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;

  function drawAll(): void {
    const chat = ctx.state()?.chat ?? [];
    rendered.clear();
    last = undefined;
    const kids: HTMLElement[] = [];
    for (const m of chat) {
      kids.push(messageEl(m, last));
      rendered.set(m.id, m);
      last = m;
    }
    if (!kids.length) kids.push(h('p', { class: 'empty' }, 'No messages yet. Say hello, or roll with /r 1d20.'));
    log.replaceChildren(...kids);
    log.scrollTop = log.scrollHeight;
  }

  function drawNew(): void {
    const chat = ctx.state()?.chat ?? [];
    const fresh = chat.filter((m) => !rendered.has(m.id));
    if (!fresh.length) return;
    const stick = nearBottom();
    log.querySelector(':scope > .empty')?.remove();
    let mine = false;
    for (const m of fresh) {
      log.append(messageEl(m, last));
      rendered.set(m.id, m);
      last = m;
      if (m.from === ctx.me().id) mine = true;
    }
    while (log.children.length > CHAT_KEEP) log.firstElementChild?.remove();
    if (stick || mine) log.scrollTop = log.scrollHeight;
    if (!visible()) {
      unread += fresh.filter((m) => m.from !== ctx.me().id).length;
      onUnread(unread);
    }
  }

  ctx.on((c) => {
    if (c === 'all') drawAll();
    else if (c === 'chat') drawNew();
    else if (c === 'members') drawAll(); // colours and names in labels
  });

  // ---------- input ----------

  const histKey = `delve-table-history:${ctx.gameId}`;
  const history: string[] = store.get<string[]>(histKey) ?? [];
  let pos = history.length;
  let draft = '';

  async function submit(): Promise<void> {
    const text = input.value.trim();
    if (!text) return;
    if (history.at(-1) !== text) history.push(text);
    history.splice(0, Math.max(0, history.length - 50));
    store.set(histKey, history);
    pos = history.length;
    draft = '';
    input.value = '';
    const ok = await ctx.act({ type: 'chat.send', text });
    if (!ok && !input.value) input.value = text; // keep it for fixing, e.g. a dice typo
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
      return;
    }
    const before = input.value.slice(0, input.selectionStart ?? 0);
    const after = input.value.slice(input.selectionEnd ?? input.value.length);
    if (e.key === 'ArrowUp' && !before.includes('\n') && history.length) {
      e.preventDefault();
      if (pos === history.length) draft = input.value;
      pos = historyStep(history.length, pos, -1);
      input.value = history[pos] ?? '';
    } else if (e.key === 'ArrowDown' && !after.includes('\n') && pos < history.length) {
      e.preventDefault();
      pos = historyStep(history.length, pos, 1);
      input.value = pos === history.length ? draft : (history[pos] ?? '');
    } else if (e.key === 'Escape') input.blur();
  });

  return {
    seen() {
      unread = 0;
      onUnread(0);
      log.scrollTop = log.scrollHeight;
    },
  };
}
