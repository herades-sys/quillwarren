// GM markers in the viewer: click a "?", "!" or skull badge to open its note in
// a small box, Shift-click it to strike it through (done) or back. Only in the
// GM view. Editing the note or striking it through needs the editor login;
// anyone looking at the GM view can read it.
import { markerAt, MARKERS, type DelveMap, type Marker, type Op, type Point } from '@delve/core';
import { checkbox, h, iconBtn, iconEl } from './dom.ts';

export interface MarkerCtx {
  stage: HTMLElement;
  handled: WeakSet<Event>;
  map(): DelveMap;
  view(): 'gm' | 'players';
  toMap(clientX: number, clientY: number): Point | null;
  toScreen(p: Point): { x: number; y: number } | null;
  squaresPerPx(): number;
  canEdit: boolean;
  send(ops: Op[]): Promise<number>;
  toast(msg: string, kind?: 'error' | 'info'): void;
  onRender(cb: () => void): void;
  onView(cb: () => void): void;
  /** The editor's tool while editing, or null when only viewing. */
  editorTool(): string | null;
}

export interface Markers {
  /** Open a marker's note (once it exists: a marker just added opens when it arrives). */
  open(id: string, focus?: boolean): void;
  close(): void;
}


export function initMarkers(ctx: MarkerCtx): Markers {
  const box = document.createElement('div');
  box.className = 'note-pop ed-note';
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  document.body.appendChild(box);

  let openId: string | null = null;
  let wantOpen: { id: string; focus: boolean } | null = null;
  let saveTimer = 0;
  let unsaved: string | null = null;
  let press: { id: string; x: number; y: number; shift: boolean; consumed: boolean } | null = null;

  const byId = (id: string) => ctx.map().objects.find((o): o is Marker => o.type === 'marker' && o.id === id);
  const hitAt = (e: { clientX: number; clientY: number }): Marker | null => {
    if (ctx.view() !== 'gm') return null;
    const p = ctx.toMap(e.clientX, e.clientY);
    return p ? markerAt(ctx.map().objects, p, 4 * ctx.squaresPerPx()) : null;
  };

  async function update(id: string, set: Record<string, unknown>, unset?: string[]): Promise<void> {
    try {
      await ctx.send([{ op: 'update', id, ...(Object.keys(set).length ? { set } : {}), ...(unset ? { unset } : {}) }]);
    } catch (err) {
      ctx.toast((err as Error).message);
    }
  }

  function toggleDone(m: Marker): void {
    if (!ctx.canEdit) return ctx.toast('Log in to edit to strike markers through.', 'info');
    void (m.done ? update(m.id, {}, ['done']) : update(m.id, { done: true }));
  }

  function flush(): void {
    clearTimeout(saveTimer);
    if (openId && unsaved !== null) {
      const m = byId(openId);
      if (m && m.text !== unsaved) void update(openId, { text: unsaved });
    }
    unsaved = null;
  }

  function place(): void {
    const m = openId ? byId(openId) : undefined;
    if (!m || ctx.view() !== 'gm') return close();
    const s = ctx.toScreen(m.at);
    if (!s) return;
    const r = ctx.stage.getBoundingClientRect();
    if (s.x < r.left - 20 || s.x > r.right + 20 || s.y < r.top - 20 || s.y > r.bottom + 20) {
      box.style.visibility = 'hidden';
      return;
    }
    box.style.visibility = '';
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const gap = 14;
    // to the right of the badge, or the left when there's no room; kept on screen
    let x = s.x + gap;
    if (x + w > window.innerWidth - 8) x = s.x - gap - w;
    const y = Math.max(8, Math.min(window.innerHeight - h - 8, s.y - 24));
    box.style.left = `${Math.max(8, x)}px`;
    box.style.top = `${y}px`;
  }

  function build(m: Marker, focus: boolean): void {
    const info = MARKERS[m.kind];
    const badge = h('span', { class: `marker marker-sm marker-${m.kind}` }, m.kind === 'trap' ? iconEl('skull', 13, 2) : m.kind === 'discover' ? '?' : '!');
    const head = h('div', { class: 'note-pop-head' }, badge, h('span', { class: 'kicker' }, info.name), iconBtn('x', 'Close the note', close, { title: 'Close · Esc', size: 15 }));

    let body: HTMLElement;
    if (ctx.canEdit) {
      const ta = document.createElement('textarea');
      ta.className = 'input';
      ta.value = m.text;
      ta.rows = 4;
      ta.maxLength = 2000;
      ta.placeholder = m.kind === 'discover' ? 'e.g. A silver coin is hidden under the loose flagstone.' : m.kind === 'interact' ? 'e.g. The lever for the trapdoor in room 4 is hidden here.' : 'e.g. Poison dart trap: pressure plate, DC 14 to spot.';
      ta.addEventListener('input', () => {
        unsaved = ta.value;
        clearTimeout(saveTimer);
        saveTimer = window.setTimeout(flush, 600);
      });
      ta.addEventListener('blur', flush);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      });
      body = ta;
    } else {
      body = document.createElement('p');
      body.className = 'ed-note-text';
      body.textContent = m.text || '(no note)';
    }
    body.classList.add('marker-text');

    const foot = h(
      'div',
      { class: 'ed-note-foot' },
      ctx.canEdit ? checkbox('Done: strike it through', Boolean(m.done), () => toggleDone(byId(m.id) ?? m)) : null,
      h('span', {}, 'Shift-click a marker to strike it through'),
    );

    box.replaceChildren(head, body, foot);
    box.dataset.kind = m.kind;
    box.classList.toggle('done', Boolean(m.done));
    box.setAttribute('aria-label', info.name);
    box.hidden = false;
    place();
    if (focus && body instanceof HTMLTextAreaElement) body.focus();
  }

  function open(id: string, focus = false): void {
    const m = byId(id);
    if (!m) {
      wantOpen = { id, focus };
      return;
    }
    if (openId && openId !== id) flush();
    openId = id;
    wantOpen = null;
    build(m, focus);
  }

  function close(): void {
    flush();
    openId = null;
    box.hidden = true;
  }

  /** Keep the box in step with the map: text or done changed elsewhere, the marker moved or went away. */
  function refresh(): void {
    if (wantOpen && byId(wantOpen.id)) return open(wantOpen.id, wantOpen.focus);
    if (!openId) return;
    const m = byId(openId);
    if (!m || ctx.view() !== 'gm') return close();
    box.classList.toggle('done', Boolean(m.done));
    const done = box.querySelector<HTMLInputElement>('.ed-note-foot input');
    if (done) done.checked = Boolean(m.done);
    const text = box.querySelector<HTMLTextAreaElement | HTMLParagraphElement>('.marker-text');
    if (text instanceof HTMLTextAreaElement) {
      if (document.activeElement !== text && unsaved === null && text.value !== m.text) text.value = m.text;
    } else if (text) text.textContent = m.text || '(no note)';
    if (box.dataset.kind !== m.kind) build(m, false);
    place();
  }

  // Registered before the editor's listeners, so a Shift-click on a marker never
  // reaches the selection, and a click in view mode doesn't start a pan.
  ctx.stage.addEventListener(
    'pointerdown',
    (e) => {
      press = null;
      if (e.button !== 0) return;
      const tool = ctx.editorTool();
      if (tool !== null && tool !== 'select' && tool !== 'marker') return; // other tools draw over markers
      const m = hitAt(e);
      if (!m) {
        if (openId && !box.contains(e.target as Node)) close();
        return;
      }
      // In the editor a plain click still selects (and drags) the marker; everything else is ours.
      const consumed = e.shiftKey || tool !== 'select';
      press = { id: m.id, x: e.clientX, y: e.clientY, shift: e.shiftKey, consumed };
      if (consumed) {
        ctx.handled.add(e);
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    { capture: true },
  );
  window.addEventListener(
    'pointerup',
    (e) => {
      const p = press;
      press = null;
      if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return;
      const m = byId(p.id);
      if (!m) return;
      if (p.shift) toggleDone(m);
      else open(m.id);
    },
    { capture: true },
  );
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openId) close();
  });
  window.addEventListener('resize', place);
  ctx.onView(place);
  ctx.onRender(refresh);

  // a pointer cursor over markers, so they read as clickable
  ctx.stage.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    const tool = ctx.editorTool();
    const over = (tool === null || tool === 'select' || tool === 'marker') && hitAt(e) !== null;
    ctx.stage.classList.toggle('on-marker', over);
  });

  return { open, close };
}
