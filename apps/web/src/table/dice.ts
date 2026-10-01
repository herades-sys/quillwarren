// The "3D dice" switch in the chat panel, and the loader for the dice bundle
// (/assets/table-dice.js, with three.js and the physics). Nothing loads until a
// roll comes in with the switch on. The switch is remembered per browser and
// starts off for people who asked their system for reduced motion.
import type { ChatMessage } from '@delve/table';
import type { Area, DiceTable } from '../table-dice.ts';
import type { TableCtx } from './ctx.ts';
import { diceForRolls } from './dice3d-logic.ts';
import { $, store, toast } from './dom.ts';

type DiceModule = typeof import('../table-dice.ts');

const KEY = 'delve-table-dice3d';

/** The part of the stage not covered by the phone layout's bottom sheet. */
function freeArea(stage: HTMLElement): Area {
  const s = stage.getBoundingClientRect();
  const side = document.getElementById('side');
  let bottom = s.bottom;
  if (side && side.getClientRects().length && getComputedStyle(side).position === 'fixed') bottom = Math.min(bottom, side.getBoundingClientRect().top);
  return { x: 0, y: 0, w: s.width, h: Math.max(140, bottom - s.top) };
}

export function initDice(ctx: TableCtx, version: string, stage: HTMLElement): { message(m: ChatMessage): void } {
  const toggle = $<HTMLInputElement>('dice-toggle');
  let reduced = false;
  try {
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    /* no media queries: keep the default */
  }
  let on = store.get<boolean>(KEY) ?? !reduced;
  toggle.checked = on;
  let table: Promise<DiceTable | null> | null = null;

  toggle.addEventListener('change', () => {
    on = toggle.checked;
    store.set(KEY, on);
    if (!on) void table?.then((t) => t?.clear());
  });

  function load(): Promise<DiceTable | null> {
    // a variable, so esbuild leaves the import to the browser
    const url = `/assets/table-dice.js?v=${encodeURIComponent(version)}`;
    table ??= (import(url) as Promise<DiceModule>)
      .then((mod) => mod.createDiceTable(stage, () => freeArea(stage)))
      .catch((e: unknown) => {
        console.warn('3D dice:', e);
        toast("3D dice couldn't start in this browser (they need WebGL). The rolls are in the chat.", 'info');
        return null;
      });
    return table;
  }

  return {
    message(m) {
      if (!on || document.hidden || !m.rolls?.length) return;
      const { dice, more } = diceForRolls(m.rolls);
      if (!dice.length) return;
      const color = ctx.state()?.view.members.find((x) => x.id === m.from)?.color ?? '#d4a017';
      void load().then((t) => t?.throw({ seed: `${m.id}:${m.at}`, dice, more, color }));
    },
  };
}
