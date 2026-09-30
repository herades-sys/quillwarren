// The token settings dialog (double-click a token). The GM edits everything;
// a player edits the rotation and bars of their own tokens, and sees the rest.
// Only the fields that changed are sent, as one token.update.
import type { Bar, Layer, Token } from '@delve/table';
import type { TableCtx } from './ctx.ts';
import { button, h } from './dom.ts';
import { BAR_COLORS, changed, editLevel, num } from './logic.ts';

const BAR_NAMES = ['green', 'blue', 'red'];

export function openTokenDialog(ctx: TableCtx, id: string): void {
  const found = ctx.state()?.view.tokens.find((x) => x.id === id);
  if (!found) return;
  const t: Token = found;
  const level = editLevel(ctx.me(), t);
  if (level === 'none') return;
  const full = level === 'full';
  document.querySelector('dialog.tok')?.remove();

  const field = (label: string, input: HTMLElement) => h('label', { class: 'field' }, h('span', {}, label), input);
  const name = h('input', { type: 'text', value: t.name ?? '', maxLength: 80, disabled: !full });
  const showName = h('input', { type: 'checkbox', checked: Boolean(t.showName), disabled: !full });
  const w = h('input', { type: 'number', min: '0.25', max: '50', step: '0.25', value: String(t.w), disabled: !full });
  const hh = h('input', { type: 'number', min: '0.25', max: '50', step: '0.25', value: String(t.h), disabled: !full });
  const rot = h('input', { type: 'number', min: '-360', max: '360', step: '15', value: String(t.rotation ?? 0) });
  const bars = [0, 1, 2].map((i) => {
    const b = t.bars?.[i];
    return {
      value: h('input', { type: 'number', step: 'any', value: b ? String(b.value) : '', placeholder: 'value', 'aria-label': `Bar ${i + 1} value` }),
      max: h('input', { type: 'number', step: 'any', value: b?.max !== undefined ? String(b.max) : '', placeholder: 'max', 'aria-label': `Bar ${i + 1} maximum` }),
    };
  });

  const layer = h(
    'select',
    { class: 'field' },
    ...(['map', 'tokens', 'gm'] as Layer[]).map((l) => h('option', { value: l, selected: t.layer === l }, { map: 'Map (under tokens)', tokens: 'Tokens', gm: 'GM only (hidden from players)' }[l])),
  );
  const members = (ctx.state()?.view.members ?? []).filter((m) => m.role === 'player');
  const ctl = [{ id: 'all', name: 'All players' }, ...members].map((m) => ({ id: m.id, box: h('input', { type: 'checkbox', checked: t.controlledBy.includes(m.id) }), name: m.name }));
  const image = h('input', { type: 'text', value: t.image, 'aria-label': 'Image address' });
  const notes = h('textarea', { rows: 3, value: t.gmNotes ?? '', maxLength: 4000, placeholder: 'Only you see these' });

  const form = h('form', { method: 'dialog' });
  const dlg = h('dialog', { class: 'tok', 'aria-label': `Token ${t.name ?? ''}` }, form);

  const barRows = h('div', { class: 'grid3' });
  bars.forEach((b, i) => {
    const sw = h('span', { class: 'swatch', title: `Bar ${i + 1} (${BAR_NAMES[i]})` });
    sw.style.setProperty('--c', BAR_COLORS[i] ?? '#888');
    barRows.append(sw, b.value, b.max);
  });

  form.append(
    h('h2', {}, h('img', { src: t.image, alt: '' }), t.name || 'Token'),
    h('div', { class: 'grid2' }, field('Name', name), h('label', { class: 'check' }, showName, 'Show the name')),
    h('div', { class: 'grid2' }, field('Width (cells)', w), field('Height (cells)', hh)),
    field('Rotation (degrees)', rot),
    h('div', { class: 'field' }, h('span', {}, 'Bars (value / max; leave empty for none)'), barRows),
  );
  if (full) {
    form.append(
      field('Layer', layer),
      h('div', { class: 'field' }, h('span', {}, 'Controlled by'), h('div', { class: 'checks' }, ...ctl.map((c) => h('label', { class: 'check' }, c.box, c.name)))),
      field('Image', image),
      field('GM notes', notes),
    );
  } else form.append(h('p', { class: 'hint' }, 'You can turn this token and change its bars. The GM sets the rest.'));

  function collect(): Partial<Token> {
    const outBars: Bar[] = [];
    for (const b of bars) {
      if (b.value.value.trim() === '' && b.max.value.trim() === '') continue;
      const bar: Bar = { value: num(b.value.value, 0) };
      if (b.max.value.trim() !== '') bar.max = num(b.max.value, 0);
      outBars.push(bar);
    }
    const next: Partial<Token> = { rotation: ((num(rot.value, 0) % 360) + 360) % 360, bars: outBars };
    if (!full) return next;
    const controlledBy = ctl.filter((c) => c.box.checked).map((c) => c.id);
    return {
      ...next,
      name: name.value.trim(),
      showName: showName.checked,
      w: Math.min(50, Math.max(0.25, num(w.value, t.w))),
      h: Math.min(50, Math.max(0.25, num(hh.value, t.h))),
      layer: layer.value as Layer,
      controlledBy: controlledBy.includes('all') ? ['all'] : controlledBy,
      image: image.value.trim() || t.image,
      gmNotes: notes.value,
    };
  }

  async function save(): Promise<void> {
    const cur: Token = ctx.state()?.view.tokens.find((x) => x.id === id) ?? t;
    const base: Token = { ...cur, rotation: cur.rotation ?? 0, bars: cur.bars ?? [], name: cur.name ?? '', showName: Boolean(cur.showName), gmNotes: cur.gmNotes ?? '' };
    const set = changed(base, collect());
    if (!Object.keys(set).length) return dlg.close();
    if (await ctx.act({ type: 'token.update', id, set })) dlg.close();
  }

  form.append(
    h(
      'div',
      { class: 'dlg-foot' },
      full
        ? button('Delete', () => {
            void ctx.act({ type: 'token.delete', ids: [id] }).then((ok) => ok && dlg.close());
          }, { class: 'btn danger' })
        : null,
      button('Cancel', () => dlg.close()),
      h('button', { type: 'submit', class: 'btn primary' }, 'Save'),
    ),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void save();
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();

  // gone while open (deleted by someone else, or the page switched): close
  const off = ctx.on((c) => {
    if ((c === 'tokens' || c === 'all') && !ctx.state()?.view.tokens.some((x) => x.id === id)) dlg.close();
  });
  dlg.addEventListener('close', off);
}
