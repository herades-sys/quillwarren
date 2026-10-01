// The GM's hint on rooms, corridors and terrain that have notes: a small note pin
// over the board (2D) or the 3D view, placed in screen pixels each frame like the
// name plates. Clicking one opens that area's notes. GM view only: the app hides
// them in the players' view, and players never load this at all.
import type { Point } from '@delve/core';
import type { PinItem } from './notes-logic.ts';

export { pinItems, type PinItem } from './notes-logic.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A sheet of notes with a folded corner: own artwork, as DOM nodes (no HTML strings). */
export function noteIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const sheet = document.createElementNS(SVG_NS, 'path');
  sheet.setAttribute('d', 'M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3');
  sheet.setAttribute('fill', 'none');
  sheet.setAttribute('stroke', 'currentColor');
  sheet.setAttribute('stroke-width', '1.4');
  sheet.setAttribute('stroke-linejoin', 'round');
  const lines = document.createElementNS(SVG_NS, 'path');
  lines.setAttribute('d', 'M5.5 8h5M5.5 10.5h5M5.5 13h3');
  lines.setAttribute('stroke', 'currentColor');
  lines.setAttribute('stroke-width', '1.3');
  lines.setAttribute('stroke-linecap', 'round');
  svg.append(sheet, lines);
  return svg;
}

export interface NotePins {
  set(items: readonly PinItem[]): void;
  /** Move the pins to where their spots are on screen now. */
  place(): void;
  /** Highlight the pin of the area whose notes are open. */
  setActive(id: string | null): void;
  show(on: boolean): void;
}

/**
 * Pins in a layer over `stage`. `project` gives a map point's position in the
 * stage's pixels (null: behind the camera).
 */
export function createPins(stage: HTMLElement, o: { project(x: number, y: number): [number, number] | null; open(id: string, at: Point): void; small?: () => boolean }): NotePins {
  const layer = document.createElement('div');
  layer.className = 'note-pins';
  stage.append(layer);
  let items: PinItem[] = [];
  const els = new Map<string, HTMLButtonElement>();
  let active: string | null = null;
  let key = '';

  function place(): void {
    if (layer.hidden) return;
    // every read first, then every write (no layout per pin, however many rooms have notes)
    const small = Boolean(o.small?.());
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const spots = items.map((it) => o.project(it.at[0], it.at[1]));
    // zoomed far out, the pins shrink so they don't hide the rooms
    layer.classList.toggle('small', small);
    items.forEach((it, i) => {
      const el = els.get(it.id);
      if (!el) return;
      const p = spots[i];
      if (!p || p[0] < -30 || p[1] < -30 || p[0] > w + 30 || p[1] > h + 30) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      // beside a room number (drawn in the room's middle), else on the spot
      const [x, y] = it.beside ? (small ? [p[0] + 12, p[1] - 9] : [p[0] + 20, p[1] - 14]) : p;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    });
  }

  return {
    set(next) {
      const k = JSON.stringify(next);
      if (k === key) return place();
      key = k;
      items = [...next];
      for (const [id, el] of els) {
        if (!items.some((it) => it.id === id)) {
          el.remove();
          els.delete(id);
        }
      }
      for (const it of items) {
        let el = els.get(it.id);
        if (!el) {
          el = document.createElement('button');
          el.type = 'button';
          el.className = 'note-pin';
          el.append(noteIcon());
          const id = it.id;
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            const cur = items.find((x) => x.id === id);
            if (cur) o.open(id, cur.at);
          });
          // the press is the pin's, not the board's (no pan, no deselect)
          el.addEventListener('pointerdown', (e) => e.stopPropagation());
          layer.append(el);
          els.set(it.id, el);
        }
        el.title = `${it.title}: GM notes`;
        el.setAttribute('aria-label', `Notes on ${it.title}`);
        el.setAttribute('aria-pressed', String(it.id === active));
      }
      place();
    },
    place,
    setActive(id) {
      active = id;
      for (const [k, el] of els) el.setAttribute('aria-pressed', String(k === id));
    },
    show(on) {
      layer.hidden = !on;
      if (on) place();
    },
  };
}
