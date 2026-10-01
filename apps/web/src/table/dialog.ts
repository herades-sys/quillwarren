// The token settings dialog (double-click a token). The GM edits everything;
// a player edits the rotation and bars of their own tokens, and sees the rest.
// Only the fields that changed are sent, as one token.update.
// Sight and light (dynamic vision) are the GM's: the rules refuse them from players.
import type { Bar, Layer, Sight, Token, TokenLight } from '@delve/table';
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

  // dynamic vision: what it sees, and the light it gives (cells)
  const sees = h(
    'select',
    { class: 'field', 'aria-label': 'Sight' },
    h('option', { value: '', selected: t.sight?.enabled === undefined }, 'Default: sees if a player controls it'),
    h('option', { value: 'on', selected: t.sight?.enabled === true }, 'Sees (shares its sight with the players)'),
    h('option', { value: 'off', selected: t.sight?.enabled === false }, 'Sees nothing'),
  );
  const cells = (v: number | undefined, placeholder: string, max: number, label: string) =>
    h('input', { type: 'number', min: '0', max: String(max), step: '0.5', value: v === undefined ? '' : String(v), placeholder, 'aria-label': label });
  const range = cells(t.sight?.range, 'no limit', 1000, 'Sight range in cells');
  const darkvision = cells(t.sight?.darkvision, 'none', 1000, 'Darkvision in cells');
  const bright = cells(t.light?.bright, '0', 200, 'Bright light in cells');
  const dim = cells(t.light?.dim, '0', 200, 'Dim light in cells, beyond the bright');
  const preset = (label: string, b: number, d: number) =>
    button(label, () => {
      bright.value = b ? String(b) : '';
      dim.value = d ? String(d) : '';
    }, { class: 'btn small' });

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
      field('Sight (dynamic vision)', sees),
      h('div', { class: 'grid2' }, field('Sight range (cells)', range), field('Darkvision (cells)', darkvision)),
      h('div', { class: 'grid2' }, field('Bright light (cells)', bright), field('Dim light beyond (cells)', dim)),
      h('div', { class: 'row' }, preset('Torch', 4, 4), preset('Lantern', 6, 6), preset('Candle', 1, 1), preset('No light', 0, 0)),
      field('Image', image),
      field('GM notes', notes),
    );
  } else {
    const told: string[] = [];
    if (t.light) told.push(`gives light (${t.light.bright} bright, ${t.light.dim} dim)`);
    if (t.sight?.darkvision) told.push(`has darkvision ${t.sight.darkvision}`);
    if (t.sight?.range !== undefined) told.push(`sees ${t.sight.range} cells far`);
    form.append(h('p', { class: 'hint' }, `You can turn this token and change its bars. The GM sets the rest${told.length ? `; it ${told.join(', ')}` : ''}.`));
  }

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
    const n = (input: HTMLInputElement, max: number): number | undefined => (input.value.trim() === '' ? undefined : Math.min(max, Math.max(0, num(input.value, 0))));
    const sight: Sight = {};
    if (sees.value === 'on') sight.enabled = true;
    if (sees.value === 'off') sight.enabled = false;
    const r = n(range, 1000);
    if (r !== undefined) sight.range = r;
    const dv = n(darkvision, 1000);
    if (dv) sight.darkvision = dv;
    const lb = n(bright, 200) ?? 0;
    const ld = n(dim, 200) ?? 0;
    const light: TokenLight | null = lb > 0 || ld > 0 ? { bright: lb, dim: ld } : null;
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
      // null takes it off the token
      ...({ light, sight: Object.keys(sight).length ? sight : null } as unknown as Partial<Token>),
    };
  }

  async function save(): Promise<void> {
    const cur: Token = ctx.state()?.view.tokens.find((x) => x.id === id) ?? t;
    const base: Token = {
      ...cur,
      rotation: cur.rotation ?? 0,
      bars: cur.bars ?? [],
      name: cur.name ?? '',
      showName: Boolean(cur.showName),
      gmNotes: cur.gmNotes ?? '',
      ...({ light: cur.light ?? null, sight: cur.sight ?? null } as unknown as Partial<Token>),
    };
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
