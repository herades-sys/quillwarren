// The turn order tab. Everyone sees the entries (players only while the GM
// shows the list), the current turn and the round. The GM adds the selected
// tokens or a free name with an initiative, edits values, sorts, steps, hides
// and clears it; a player can end their own turn.
import type { TableCtx } from './ctx.ts';
import { $, button, h } from './dom.ts';
import { canEndTurn, currentEntry, isGm, num } from './logic.ts';

export function initTurns(ctx: TableCtx): void {
  const panel = $('panel-turn');
  const gm = isGm(ctx.me());
  // kept across redraws so typing isn't lost when the list changes
  const initInput = h('input', { type: 'number', step: 'any', placeholder: 'Initiative', 'aria-label': 'Initiative for new entries', class: 'init-new' });
  const nameInput = h('input', { type: 'text', placeholder: 'Name (not a token)', maxLength: 60, 'aria-label': 'Name of a new entry' });

  function addSelected(): void {
    const ids = ctx.selected();
    const turn = ctx.state()?.view.turn;
    const tokens = ctx.tokens().filter((t) => ids.includes(t.id) && !turn?.entries.some((e) => e.tokenId === t.id));
    if (!tokens.length) {
      nameInput.focus();
      return;
    }
    const initiative = num(initInput.value, 0);
    for (const t of tokens) void ctx.act({ type: 'turn.add', entry: { tokenId: t.id, name: t.name || 'Token', initiative } });
  }

  function addName(): void {
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    void ctx.act({ type: 'turn.add', entry: { name, initiative: num(initInput.value, 0) } }).then((ok) => {
      if (ok) nameInput.value = '';
    });
  }

  function draw(): void {
    const view = ctx.state()?.view;
    if (!view) return;
    const turn = view.turn;
    const kids: (HTMLElement | null)[] = [];
    if (!turn) {
      panel.replaceChildren(h('p', { class: 'empty' }, 'The GM isn’t showing the turn order right now.'));
      return;
    }
    const cur = currentEntry(turn);
    kids.push(
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'round' }, `Round ${turn.round}`),
        gm ? h('span', { class: `tag${turn.visible ? ' on' : ''}` }, turn.visible ? 'Players see it' : 'Hidden from players') : null,
        h('span', { class: 'spacer' }),
        canEndTurn(ctx.me(), turn, ctx.tokens()) ? button(gm ? 'Next turn' : 'End my turn', () => void ctx.act({ type: 'turn.next' }), { class: 'btn primary' }) : null,
      ),
    );
    if (!turn.entries.length) kids.push(h('p', { class: 'empty' }, gm ? 'Nobody is in the turn order yet. Select tokens and add them below.' : 'The turn order is empty.'));
    const list = h('ul', { class: 'list turns' });
    for (const e of turn.entries) {
      const onPage = e.tokenId ? ctx.tokens().find((t) => t.id === e.tokenId) : undefined;
      const name = onPage
        ? h('button', { type: 'button', class: 'name grow', title: 'Show this token', onclick: () => {
            ctx.select([onPage.id]);
            ctx.board()?.focus(onPage.x + onPage.w / 2, onPage.y + onPage.h / 2);
          } }, e.name)
        : h('span', { class: 'grow' }, e.name);
      const init = gm
        ? h('input', {
            type: 'number',
            step: 'any',
            class: 'init',
            value: String(e.initiative),
            'aria-label': `Initiative of ${e.name}`,
            onchange: (ev: Event) => {
              const v = num((ev.target as HTMLInputElement).value, e.initiative);
              if (v !== e.initiative) void ctx.act({ type: 'turn.update', id: e.id, set: { initiative: v } });
            },
          })
        : h('span', { class: 'init-v' }, e.initiative);
      list.append(
        h(
          'li',
          { class: e === cur ? 'current' : '', 'aria-current': e === cur ? 'true' : undefined },
          name,
          init,
          gm ? button('✕', () => void ctx.act({ type: 'turn.remove', id: e.id }), { class: 'btn small', title: `Remove ${e.name}`, 'aria-label': `Remove ${e.name}` }) : null,
        ),
      );
    }
    if (turn.entries.length) kids.push(list);
    if (gm) {
      kids.push(
        h('h3', {}, 'Add'),
        h('div', { class: 'row' }, initInput, button('Add selected tokens', addSelected, { title: 'Adds the tokens you have selected on the page' })),
        h(
          'div',
          { class: 'row' },
          nameInput,
          button('Add', addName),
        ),
        h(
          'div',
          { class: 'row' },
          button('Sort', () => void ctx.act({ type: 'turn.sort' }), { title: 'Highest initiative first', disabled: turn.entries.length < 2 }),
          button(turn.visible ? 'Hide from players' : 'Show to players', () => void ctx.act({ type: 'turn.visible', visible: !turn.visible })),
          button('Clear', () => {
            if (confirm('Clear the turn order?')) void ctx.act({ type: 'turn.clear' });
          }, { class: 'btn danger', disabled: !turn.entries.length }),
        ),
      );
    }
    const focused = document.activeElement;
    panel.replaceChildren(...kids.filter((k): k is HTMLElement => k !== null));
    if (focused === initInput) initInput.focus();
    else if (focused === nameInput) nameInput.focus();
  }

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addName();
  });
  ctx.on((c) => {
    if (c === 'all' || c === 'turn') draw();
    // tokens only change who may end the turn: don't rebuild under someone typing
    else if (c === 'tokens' && !panel.contains(document.activeElement)) draw();
  });
}
