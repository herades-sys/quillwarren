// The GM's dynamic-vision controls for a page in the Pages tab: vision off or
// dynamic (line of sight, lights, explored fog), how lit the page is, and the
// explored fog's tools. Doors are opened and shut by clicking them on the board.
import { visionOf, type Ambient, type Page } from '@delve/table';
import type { TableCtx } from './ctx.ts';
import { button, h } from './dom.ts';

const AMBIENT: Record<Ambient, string> = {
  dark: 'Dark: only lights and darkvision',
  dim: 'Dim: lit, but dimmed',
  bright: 'Bright: everything lit',
};

/** The controls, or null for a picture page (its image goes to players whole, so there is nothing to hide it with). */
export function visionControls(ctx: TableCtx, p: Page): HTMLElement | null {
  if (p.background.kind === 'image') return null;
  const v = visionOf(p);
  const on = v.mode === 'dynamic';
  const set = (vision: Page['vision']) => void ctx.act({ type: 'page.update', id: p.id, set: { vision } });
  const toggle = button(on ? 'Vision: line of sight' : 'Vision: room fog', () => set({ mode: on ? 'off' : 'dynamic', ambient: v.ambient }), {
    class: 'btn small',
    'aria-pressed': String(on),
    title: on
      ? 'Players see what their characters see: walls and shut doors block, lights and darkvision show. Click to go back to the Quillwarren map’s own room fog.'
      : 'Players see the Quillwarren map’s revealed rooms. Click for line of sight: what their characters see is revealed and stays explored.',
  });
  const box = h('div', { class: 'vision-tools', style: 'display: grid; gap: 6px' }, h('div', { class: 'row' }, toggle));
  if (!on) return box;
  const ambient = h('select', { 'aria-label': 'Light on this page' }, ...(Object.keys(AMBIENT) as Ambient[]).map((a) => h('option', { value: a, selected: v.ambient === a }, AMBIENT[a])));
  ambient.addEventListener('change', () => set({ mode: 'dynamic', ambient: ambient.value as Ambient }));
  const explored = (action: 'reset' | 'reveal' | 'hide', ask: string) => () => {
    if (confirm(ask)) void ctx.act({ type: 'vision.explored', pageId: p.id, action });
  };
  box.append(
    h('div', { class: 'row' }, ambient),
    h(
      'div',
      { class: 'row' },
      button('Forget explored', explored('reset', 'Forget what the players have explored on this page? What they see right now stays.'), { class: 'btn small' }),
      button('Reveal all', explored('reveal', 'Show the players the whole page? Tokens still show only while in sight.'), { class: 'btn small' }),
      button('Hide everything', explored('hide', 'Black out the whole page for the players, until their characters next move or a door turns?'), { class: 'btn small danger' }),
    ),
    h('p', { class: 'hint' }, 'Click a door on the board to open or shut it. Token sight and light are in each token’s settings.'),
  );
  return box;
}
