// The GM's "Respect heights" switch for a page in the Pages tab (Delve pages):
// with it on, the server refuses a player's move over a cliff edge of the map's
// height areas where no stairs or ladder cross it, and through walls and shut
// doors (packages/table movement.ts). Off by default: it changes play.
import { respectsHeights, type Page } from '@delve/table';
import type { TableCtx } from './ctx.ts';
import { button, h } from './dom.ts';

export function movementControls(ctx: TableCtx, p: Page): HTMLElement | null {
  if (p.background.kind !== 'delve') return null;
  const on = respectsHeights(p);
  const cliffs = p.cliffs?.length ?? 0;
  const toggle = button(on ? 'Moves: respect heights' : 'Moves: free', () => void ctx.act({ type: 'page.update', id: p.id, set: { respectHeights: !on } }), {
    class: 'btn small',
    'aria-pressed': String(on),
    title: on
      ? 'Players can’t move a token over a cliff edge without stairs or a ladder, nor through walls and shut doors. You always can. Click to let them move freely.'
      : 'Players move their tokens anywhere. Click to hold them to the map’s heights (cliffs need stairs or a ladder), walls and shut doors.',
  });
  return h(
    'div',
    { class: 'movement-tools', style: 'display: grid; gap: 6px' },
    h('div', { class: 'row' }, toggle),
    on ? h('p', { class: 'hint' }, cliffs ? `${cliffs} cliff edge piece${cliffs === 1 ? '' : 's'} on this map. Moves are checked in a straight line, centre to centre.` : 'This map has no cliff edges: walls and shut doors still hold the players back.') : null,
  );
}
