// GM notes in the 3D view (docs/TABLE.md, "GM notes"): a "Notes" tab in the side
// panel (rooms, characters, the session notebook; notes-panel.ts), pins on the
// rooms that have notes, and a click on a room's floor while the Notes tab shows
// (or on a pin, any time) opens that room's notes in the tab. The banner's
// "Notes" button opens the tab. GM only; players never load any of this.
import { noteAreaAt } from '@delve/core';
import type { Table3dCtx } from './app3d.ts';
import { $, toast } from './dom.ts';
import { createGmMap } from './gm-map.ts';
import { createPins, pinItems } from './note-pins.ts';
import { initNotesPanel } from './notes-panel.ts';

export function initNotes3d(ctx: Table3dCtx): void {
  if (ctx.me().role !== 'gm') return;
  const gmMap = createGmMap();
  const panelEl = ctx.addPanel('notes', 'Notes');
  panelEl.classList.add('notes-panel');
  const usable = () => ctx.page()?.background.kind === 'delve' && ctx.seeAs() === 'gm' && gmMap.map() !== null;

  const panel = initNotesPanel({
    gameId: ctx.gameId,
    panel: panelEl,
    page: ctx.page,
    tokens: () => ctx.state()?.view.tokens ?? [],
    selected: ctx.selected,
    select: ctx.select,
    act: ctx.act,
    seeAs: ctx.seeAs,
    gmMap,
    focus: (at) => ctx.view()?.focusPoint(at[0], at[1]),
    focusToken: (id) => ctx.view()?.focusToken(id),
    where: 'view',
    on: ctx.on,
    onMessage: ctx.onMessage,
  });

  const stage = $('stage');
  const pins = createPins(stage, {
    project: (x, y) => ctx.view()?.project(x, y) ?? null,
    open(id, at) {
      ctx.showPanel('notes');
      panel.showArea(id, at);
      pins.setActive(id);
    },
    // far away (a cell less than 16 px across in the middle of the page), the pins shrink
    small() {
      const v = ctx.view();
      const b = ctx.scene()?.bounds;
      if (!v || !b) return false;
      const cx = (b.x0 + b.x1) / 2;
      const cy = (b.y0 + b.y1) / 2;
      const p = v.project(cx, cy);
      const q = v.project(cx + 1, cy);
      return Boolean(p && q && Math.hypot(q[0] - p[0], q[1] - p[1]) < 16);
    },
  });
  function drawPins(): void {
    const ok = usable();
    pins.show(ok);
    pins.set(ok ? pinItems(gmMap.map()) : []);
    pins.setActive(panel.areaId());
  }
  gmMap.onChange(drawPins);
  ctx.view()?.onFrame(() => pins.place());

  // a click on a room's floor, while the Notes tab is up, shows its notes there
  ctx.view()?.onFloorClick((x, y) => {
    if (ctx.shownPanel() !== 'notes' || !usable()) return;
    const map = gmMap.map();
    const area = map ? noteAreaAt(map, [x, y]) : null;
    if (!area) return toast('No room, corridor or terrain here.', 'info');
    panel.showArea(area.id, [x, y]);
    pins.setActive(area.id);
  });

  // the banner's button: open the Notes tab
  ctx.onBanner((banner) => {
    const p = ctx.page();
    if (!p || ctx.seeAs() !== 'gm') return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'see-as notes-open';
    b.textContent = 'Notes';
    b.title = p.background.kind === 'delve' ? 'GM notes: rooms (click a room’s floor while the tab is open), characters, the session notebook' : 'GM notes: characters and the session notebook';
    b.addEventListener('click', () => {
      ctx.showPanel('notes');
      panel.section(p.background.kind === 'delve' ? 'rooms' : 'notebook');
    });
    banner.append(b);
  });

  // the GM's view or the players': pins and the Rooms section follow
  let seen = '';
  ctx.on(() => {
    const p = ctx.page();
    const key = JSON.stringify([p?.id, p?.background, ctx.seeAs()]);
    if (key === seen) return;
    seen = key;
    panel.roomsChanged();
    drawPins();
  });
  // the map: fresh with every hello (another page, a reconnect), again when the page is sent
  // again (its map changed), and when only its notes changed ("map.notes", no picture changed)
  ctx.onMessage((m) => {
    if (m.type === 'hello') gmMap.setPage(ctx.page(), true);
    else if (m.type === 'map.notes' && m.mapId === gmMap.mapId()) void gmMap.reload();
    else if (m.type === 'events' && m.events.some((e) => e.type === 'page.upsert' && e.page.id === ctx.page()?.id)) gmMap.setPage(ctx.page(), true);
  });
}
