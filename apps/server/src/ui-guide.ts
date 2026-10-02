// The style guide at /ui: every token and component of @delve/ui in both
// themes, laid out like the design (docs/design/ui-v1/Delve Design System.dc.html)
// so the two can be compared side by side. It is built from the real classes,
// so it shows what the pages get. Map pictures come from the real renderer.
import { DARK_TOKENS, ICON_GROUPS, LIGHT_TOKENS, esc, htmlDocument, icon, themeSwitch, type IconName } from '@delve/ui';

type Theme = 'dark' | 'light';
const THEMES: Theme[] = ['dark', 'light'];

const tokenValues = (block: string): Map<string, string> =>
  new Map([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
const VALUES: Record<Theme, Map<string, string>> = { dark: tokenValues(DARK_TOKENS), light: tokenValues(LIGHT_TOKENS) };

// WCAG contrast, measured against --color-surface as in the design.
const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string): number => {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** [group heading, token, use, what it must pass: text 4.5:1, ui 3:1, or nothing]. */
const COLOUR_ROWS: [string | null, string, string, 'text' | 'ui' | null][] = [
  ['Ground & surface', '--color-bg', 'App ground', null],
  [null, '--color-surface', 'Panels, bars, cards', null],
  [null, '--color-surface-2', 'Menus, inputs, raised', null],
  [null, '--color-surface-3', 'Tooltips, tracks', null],
  ['Text', '--color-text', 'Primary text', 'text'],
  [null, '--color-text-muted', 'Labels, meta', 'text'],
  [null, '--color-text-faint', 'Hints, key letters', 'text'],
  ['Lines', '--color-border', 'Panel edges', null],
  [null, '--color-border-strong', 'Separators, kbd', null],
  [null, '--color-control-border', 'Input & checkbox edges', 'ui'],
  ['Accent: violet ink', '--color-accent', 'Focus, selection, active', 'text'],
  [null, '--color-accent-text', 'Accent in body copy', 'text'],
  [null, '--tint-accent-bg', 'Selected fills', null],
  ['Status', '--color-danger', 'Errors, delete, offline', 'text'],
  [null, '--color-warning', 'Unsaved, queued', 'text'],
  [null, '--color-info', 'Info, whispers', 'text'],
];

const CANVAS: [string, string, string][] = [
  ['--canvas-parchment', '#EADCBB', 'Ground'],
  ['--canvas-floor', '#F4ECD7', 'Room floors'],
  ['--canvas-ink', '#2B241D', 'Walls, text'],
  ['--canvas-hatch', '#4A3F33', 'Hatching'],
  ['--canvas-parchment-deep', '#DCC9A2', 'Map edge, wells'],
  ['--canvas-grid', 'rgba(74,63,51,.25)', 'Grid lines'],
  ['--canvas-select', '#4F40A6', 'Selection on map'],
  ['--canvas-fog', 'rgba(36,31,26,.84)', 'Fog of war'],
];

/** [token, spec, font, size, tracking, sample, use]. */
const TYPE: [string, string, string, string, string, string, string][] = [
  ['--display-xl', 'IM Fell English · 46 / 1.0', 'var(--font-display)', '46px', '0', 'The Sunken Abbey', 'Page titles, library header'],
  ['--display-lg', 'IM Fell English · 34 / 1.1', 'var(--font-display)', '34px', '0', 'Delve Table · Session 12', 'Screen titles'],
  ['--display-md', 'IM Fell English · 26 / 1.15', 'var(--font-display)', '26px', '0', 'Delete storey −1?', 'Dialogs, sheet titles'],
  ['--display-sm', 'IM Fell English · 20 / 1.15', 'var(--font-display)', '20px', '0', 'Chapter house', 'Inspector, cards, panels'],
  ['--font-numeral', 'Marcellus SC · 17–32', 'var(--font-numeral)', '30px', '.02em', '3 · 12 · −1 · 0 · 2 · 23', 'Rooms, storeys, dice totals'],
  ['--text-xl', 'System sans · 17 / 1.4', 'var(--font-ui)', '17px', '0', 'Players join with an invite link', 'Phone headings'],
  ['--text-lg', 'System sans · 15 / 1.5', 'var(--font-ui)', '15px', '0', 'Body text on phones and long notes', 'Phone body, notes'],
  ['--text-md', 'System sans · 13 / 1.4', 'var(--font-ui)', '13px', '0', 'Desktop UI text, fields, menus, chat', 'Default desktop UI'],
  ['--text-sm', 'System sans · 12 / 1.4', 'var(--font-ui)', '12px', '0', 'Labels, meta, timestamps', 'Field labels'],
  ['--text-xs', 'System sans · 11 / 1.3 · caps +.08em', 'var(--font-ui)', '11px', '.08em', 'SECTION LABEL · ROOM · STOREY 0', 'Kickers, table heads'],
  ['--font-mono', 'ui-monospace · 13', 'var(--font-mono)', '14px', '0', '/r 2d20kh1+5   /w gm the door is warm', 'Dice notation, codes'],
];

const SPACES: [string, number][] = [['--space-1', 3], ['--space-2', 6], ['--space-3', 8], ['--space-4', 12], ['--space-5', 16], ['--space-6', 20], ['--space-8', 24], ['--space-10', 32], ['--space-12', 48]];
const RADII: [string, string][] = [['--radius-xs', '3px'], ['--radius-sm', '4px'], ['--radius-md', '8px'], ['--radius-lg', '14px'], ['--radius-pill', '28px']];

/** The test dungeon from the real renderer (the same map as the start page). */
const map = (view: 'gm' | 'players' = 'gm'): string => `/preview/parchment.svg?view=${view}`;

const i = (name: IconName, size = 18, stroke?: number): string => icon(name, stroke === undefined ? { size } : { size, stroke });

const sectionHead = (num: string, title: string): string =>
  `<div class="sg-section-head"><span class="numeral text-faint">${num}</span><h2 class="sg-h2">${title}</h2></div>`;

/** A component specimen in both themes, side by side. */
function pair(title: string, sub: string, render: (t: Theme) => string, panel = 'sg-panel'): string {
  return `<div class="sg-block"><div class="sg-block-head"><span class="sg-h3">${title}</span><span class="sg-sub">${sub}</span></div>
<div class="sg-pair">${THEMES.map((t) => `<div data-theme="${t}" class="${panel}">${render(t)}</div>`).join('')}</div></div>`;
}

function colours(): string {
  const panels = THEMES.map((t) => {
    const surface = VALUES[t].get('--color-surface')!;
    const rows = COLOUR_ROWS.map(([group, name, use, kind]) => {
      const v = VALUES[t].get(name)!;
      let r = '';
      if (kind) {
        const q = ratio(v, surface);
        const pass = kind === 'text' ? q >= 4.5 : q >= 3;
        r = `<span class="sg-ratio${pass ? '' : ' text-danger'}">${q.toFixed(1)} : 1 ${pass ? (kind === 'text' ? 'AA' : 'UI 3:1') : 'fail'}</span>`;
      }
      return `${group ? `<div class="sg-colour-group">${group}</div>` : ''}<div class="sg-colour-row"><span class="sg-swatch" style="background:${v}"></span><span class="mono sg-ellipsis">${name}</span><span class="mono text-muted">${v}</span><span class="text-muted">${use}</span>${r || '<span></span>'}</div>`;
    }).join('');
    return `<div data-theme="${t}" class="sg-colour-panel"><div class="row sg-colour-title">${i(t === 'dark' ? 'moon' : 'sun', 16)}<span class="kicker">${t === 'dark' ? 'Dark · slate' : 'Light · limestone'}</span></div>${rows}</div>`;
  }).join('');
  const canvas = CANVAS.map(([n, v, use]) => `<div class="sg-canvas-cell"><span style="background:${v}"></span><span class="mono">${n}</span><span class="sg-parch-muted">${use}</span></div>`).join('');
  return `<section class="sg-section" id="colour">${sectionHead('01', 'Colour tokens')}
<p class="sg-p">The token names are the same in both themes; set <code>data-theme="dark|light"</code> on any element. Ratios are measured against <code>--color-surface</code>. Text needs 4.5 : 1, control edges and icons need 3 : 1.</p>
<div class="sg-pair">${panels}</div>
<div class="sg-canvas-pair">
<div class="sg-parch"><span class="sg-parch-title">Canvas: the same in both themes</span><div class="sg-canvas-grid">${canvas}</div></div>
<div class="sg-parch"><span class="sg-parch-title">GM markers: fixed brand colours</span>
<div class="stack" style="gap:12px">
<div class="sg-marker-row"><span class="marker marker-discover">?</span><span class="spacer"><span class="sg-parch-name">Discover</span><span class="sg-parch-muted"> · something to find</span></span><span class="mono">#D9961A · ink glyph</span></div>
<div class="sg-marker-row"><span class="marker marker-interact">!</span><span class="spacer"><span class="sg-parch-name">Interact</span><span class="sg-parch-muted"> · something to use</span></span><span class="mono">#2F7FD1 · paper glyph</span></div>
<div class="sg-marker-row"><span class="marker marker-trap">${i('skull', 17, 2)}</span><span class="spacer"><span class="sg-parch-name">Trap</span><span class="sg-parch-muted"> · something that hurts</span></span><span class="mono">#C43A2F · paper glyph</span></div>
<p class="sg-parch-muted" style="margin:0">Markers are told apart by their glyph as well as their colour, so they still read in greyscale prints and for colour-blind players. In the UI, status text uses the theme's own red, amber and blue, which are tuned for contrast.</p>
</div></div></div></section>`;
}

function type(): string {
  const rows = TYPE.map(
    ([token, spec, font, size, track, sample, use]) =>
      `<div class="sg-type-row"><div class="stack" style="gap:0"><span class="mono" style="font-size:12px">${token}</span><span class="text-muted" style="font-size:12px">${spec}</span></div><span class="sg-ellipsis" style="font-family:${font}; font-size:${size}; line-height:1.15; letter-spacing:${track}">${esc(sample)}</span><span class="text-muted" style="font-size:12.5px">${use}</span></div>`,
  ).join('');
  return `<section class="sg-section" id="type">${sectionHead('02', 'Type')}<div>${rows}</div>
<p class="sg-p">IM Fell English has a single 400 weight and is never bolded, which fits Nocturne's rule of hierarchy through size. Marcellus SC is only for numbers that must read at a glance. UI text uses the system sans at 13 px on desktop and 15–16 px on phones; inputs on phones are 16 px so iOS does not zoom.</p></section>`;
}

function space(): string {
  const spaces = SPACES.map(([n, px]) => `<div class="sg-space-row"><span class="mono">${n}</span><span class="text-muted">${px}px</span><span class="sg-space-bar" style="width:${px}px"></span></div>`).join('');
  const radii = RADII.map(([n, px]) => `<div class="sg-radius"><span style="border-radius:${px}"></span><span class="mono">${n}</span><span class="text-muted">${px}</span></div>`).join('');
  const elev = THEMES.map((t) => `<div data-theme="${t}" class="sg-elev"><div style="box-shadow:var(--shadow-sm)">sm</div><div style="box-shadow:var(--shadow-md)">md</div><div style="background:var(--color-surface-2); box-shadow:var(--shadow-lg)">lg</div></div>`).join('');
  return `<section class="sg-section" id="space">${sectionHead('03', 'Space, radius, elevation')}
<div class="sg-two"><div class="stack" style="gap:8px">${spaces}
<div class="sg-sizes"><span><span class="mono">--control-sm/md/lg</span> 28 · 32 · 36</span><span><span class="mono">--touch</span> 44</span><span><span class="mono">--bar-h</span> 48</span><span><span class="mono">--rail-w</span> 52</span><span><span class="mono">--panel-w</span> 288</span><span><span class="mono">--chat-w</span> 344</span></div></div>
<div class="stack" style="gap:20px"><div class="row" style="gap:16px; align-items:flex-end">${radii}</div><div class="sg-elev-pair">${elev}</div>
<p class="text-muted" style="margin:0; font-size:12.5px">sm: cards and panels. md: floating canvas controls, tooltips. lg: menus, dialogs, sheets, toasts. In dark, elevation is an edge plus ambient shade. In light, it is a warm ink-tinted shadow.</p></div></div></section>`;
}

function icons(): string {
  const groups = ICON_GROUPS.map(
    (g, gi) =>
      `<div class="stack" style="gap:10px"><div class="row" style="align-items:baseline; gap:10px"><span class="sg-h4">${g.title}</span><span class="sg-sub">${g.note}</span></div>
<div class="sg-icon-grid">${g.icons.map((n) => `<div class="sg-icon${gi === 1 ? ' is-new' : ''}">${i(n, 22)}<span class="mono">${n}</span></div>`).join('')}</div></div>`,
  ).join('');
  return `<section class="sg-section" id="icons">${sectionHead('04', 'Icons')}
<p class="sg-p">24 px grid, 1.7 stroke, round caps and joins, drawn in currentColor. The 30 brand icons are stand-ins drawn to the list; swap the originals into <code>packages/ui/src/icons.ts</code> and every screen picks them up. Use them at 16, 18, 20 or 24.</p>${groups}</section>`;
}

// ---------- components ----------

const states = ['Default', 'Hover', 'Active', 'Focus', 'Disabled'];
const STATE_CLASS = ['', ' is-hover', ' is-active', ' is-focus', ''];

function buttons(): string {
  return pair('Buttons', '.btn + .btn-primary · .btn-secondary · .btn-danger · .btn-sm · .btn-icon', () => {
    const row = (label: string, make: (cls: string, disabled: boolean) => string): string =>
      `<span class="sg-row-label">${label}</span>${STATE_CLASS.map((c, n) => make(c, n === 4)).join('')}`;
    const dis = (d: boolean): string => (d ? ' disabled' : '');
    return `<div class="sg-states">
<span></span>${states.map((s) => `<span class="state-label">${s}</span>`).join('')}
${row('Primary', (c, d) => `<button class="btn btn-primary${c}"${dis(d)}>Play</button>`)}
${row('Secondary', (c, d) => `<button class="btn btn-secondary${c}"${dis(d)}>Export</button>`)}
${row('Danger', (c, d) => `<button class="btn btn-danger${c}"${dis(d)}>Delete</button>`)}
${row('Small', (c, d) => `<button class="btn btn-secondary btn-sm${c}"${dis(d)}>Reveal</button>`)}
<span class="sg-row-label">Icon only</span>
<div class="row" style="gap:4px"><button class="btn btn-icon" aria-label="Settings" title="Settings">${i('settings')}</button><button class="btn btn-icon" aria-label="Delete" title="Delete">${i('trash')}</button></div>
<button class="btn btn-icon is-hover" aria-label="Settings">${i('settings')}</button>
<button class="btn btn-icon" aria-pressed="true" aria-label="Settings">${i('settings')}</button>
<button class="btn btn-icon is-focus" aria-label="Settings">${i('settings')}</button>
<button class="btn btn-icon" disabled aria-label="Settings">${i('settings')}</button>
</div>
<div class="row" style="padding-top:18px">
<button class="btn btn-primary">${i('play', 15)}Play</button>
<button class="btn btn-secondary">${i('admin', 15)}Admin</button>
<button class="btn btn-ghost">Undo</button>
<button class="btn btn-primary btn-touch">${i('play', 17)}Touch 44</button>
<span class="sg-note">One primary per view. Icon-only buttons always carry aria-label and a tooltip with the shortcut.</span></div>`;
  });
}

function segments(): string {
  return pair('Segmented controls and tabs', '.seg + .seg-opt on native radios · .tabs + .tab (role="tablist")', (t) => `<div class="row" style="gap:18px; align-items:flex-end">
<div class="stack" style="gap:6px"><span class="state-label">Live</span><div class="seg" role="radiogroup" aria-label="View as"><label class="seg-opt"><input type="radio" name="sv-${t}" checked>${i('eye', 15)}GM view</label><label class="seg-opt"><input type="radio" name="sv-${t}">${i('eye-off', 15)}Players</label></div></div>
<div class="stack" style="gap:6px"><span class="state-label">Live</span><div class="seg" role="radiogroup" aria-label="Board"><label class="seg-opt"><input type="radio" name="sd-${t}" checked>2D</label><label class="seg-opt"><input type="radio" name="sd-${t}">${i('3d', 15)}3D</label></div></div>
<div class="stack" style="gap:6px"><span class="state-label">Hover · focus · disabled</span><div class="seg"><span class="seg-opt is-on">Lines</span><span class="seg-opt is-hover">Dots</span><span class="seg-opt is-focus">None</span><span class="seg-opt is-disabled">Hex</span></div></div>
<div class="stack" style="gap:6px"><span class="state-label">Theme</span>${themeSwitch(`theme-${t}`)}</div>
</div>
<div class="stack" style="gap:6px; padding-top:18px"><span class="state-label">Tabs · active · hover · focus · disabled</span>
<div class="tabs" role="tablist"><span class="tab" role="tab" aria-selected="true">${i('chat', 15)}Chat</span><span class="tab is-hover" role="tab">${i('dice', 15)}Turn order</span><span class="tab is-focus" role="tab">${i('layers', 15)}Pages</span><span class="tab" role="tab">${i('prop', 15)}Tokens</span><span class="tab" role="tab" aria-disabled="true">${i('notes', 15)}Notes</span></div>
<span class="sg-note">Arrow keys move between tabs, Home and End jump to the ends. GM-only tabs are hidden from players, not shown as disabled.</span></div>`);
}

function rail(): string {
  const tools: [IconName, string, string, string][] = [
    ['select', 'V', 'Select', ''],
    ['room', 'R', 'Room', ' is-hover'],
    ['corridor', 'C', 'Corridor', ' is-active'],
    ['door', 'D', 'Door', ''],
    ['stairs', 'S', 'Stairs', ' is-focus'],
    ['fog', 'F', 'Fog reveal', ' is-disabled'],
  ];
  const shapes: IconName[] = ['shape-rect', 'shape-circle', 'shape-oval', 'shape-triangle', 'shape-hexagon', 'shape-octagon', 'shape-freehand'];
  return pair('Tool rail, tooltip and context bar', '38 × 36 buttons in a 52 px rail · letter shortcut in the corner', () => `<div class="row" style="gap:28px; align-items:flex-start; flex-wrap:nowrap">
<nav class="rail sg-rail" aria-label="Tools">${tools
    .map(
      ([ic, key, label, st]) =>
        `<div style="position:relative"><button class="tool${st}" aria-label="${label}" aria-keyshortcuts="${key}"${st === ' is-active' ? ' aria-pressed="true"' : ''}>${i(ic, 20)}<span class="tool-key">${key}</span></button>${st === ' is-hover' ? `<div class="tooltip sg-tooltip" role="tooltip"><span>Room</span><kbd>R</kbd><span class="tooltip-hint">1–7 change shape</span></div>` : ''}</div>`,
    )
    .join('')}</nav>
<div class="stack" style="flex:1; min-width:0; gap:16px; padding-top:150px">
<div class="stack sg-note" style="gap:7px"><span><b>Default</b> muted ink. <b>Hover</b> shows the tooltip after 400 ms, or at once while another is open.</span><span><b>Active</b> accent tint, a 1 px accent edge and aria-pressed. <b>Focus</b> 2 px ring. Arrow keys move along the rail.</span><span><b>Disabled</b> 45 %, for example Fog reveal on a storey without fog.</span></div>
<div class="ctxbar" style="align-self:flex-start"><span class="ctxbar-title">${i('room', 16)}Room</span><span class="vsep"></span>${shapes.map((s, n) => `<span class="ctxbar-opt${s === 'shape-octagon' ? ' is-active' : ''}">${i(s, 17)}<span class="ctxbar-num">${n + 1}</span></span>`).join('')}</div>
<span class="sg-note">The context bar floats top-centre on the canvas and changes with the tool: options, sliders, then shortcut hints.</span></div></div>`);
}

function fields(): string {
  const checks: [string, boolean, string, string][] = [
    ['Unchecked', false, 'default', ''],
    ['Hidden from players', true, 'checked', ''],
    ['Snap to grid', false, 'focus', ' is-focus'],
    ['Locked layer', true, 'disabled', ''],
  ];
  return pair(
    'Inspector fields',
    '.field · .input · .range · .check · .select · .menu',
    (t) => `<div class="sg-five">
<div class="field"><label for="f1-${t}">Default</label><input id="f1-${t}" class="input" value="Chapter house"></div>
<div class="field"><label for="f2-${t}">Hover</label><input id="f2-${t}" class="input is-hover" value="Chapter house"></div>
<div class="field"><label for="f3-${t}">Focus</label><input id="f3-${t}" class="input is-focus" value="Chapter ho"></div>
<div class="field"><label for="f4-${t}">Disabled</label><input id="f4-${t}" class="input" value="Locked" disabled></div>
<div class="field has-error"><label for="f5-${t}">Error</label><input id="f5-${t}" class="input" value="12.3.4" aria-invalid="true" aria-describedby="f5e-${t}"><span class="field-error" id="f5e-${t}">Use a number</span></div>
</div>
<div class="sg-two" style="gap:22px">
<div class="stack" style="gap:14px">
<div class="field-row"><div class="field"><label for="w-${t}">Width</label><div class="input-unit"><input id="w-${t}" class="input" value="9" inputmode="decimal"><span class="unit">sq</span></div></div><div class="field"><label for="r-${t}">Rotation</label><div class="input-unit"><input id="r-${t}" class="input" value="45" inputmode="decimal"><span class="unit">°</span></div></div></div>
<div><div class="range-head"><label for="rough-${t}">Roughness</label><output class="range-value" id="rough-${t}-out" for="rough-${t}">${t === 'dark' ? 4 : 7}</output></div>
<input type="range" class="range" id="rough-${t}" min="1" max="10" step="1" value="${t === 'dark' ? 4 : 7}" data-output="rough-${t}-out">
<div class="range-ticks" aria-hidden="true">${Array.from({ length: 10 }, (_, n) => `<span>${n + 1}</span>`).join('')}</div></div>
<div class="row" style="gap:20px; flex-wrap:nowrap"><span class="state-label" style="width:52px">Focus</span><input type="range" class="range is-focus" min="0" max="100" value="60" aria-label="Focus example" tabindex="-1"></div>
<div class="row" style="gap:20px; flex-wrap:nowrap"><span class="state-label" style="width:52px">Disabled</span><input type="range" class="range" min="0" max="100" value="30" aria-label="Disabled example" disabled></div>
</div>
<div class="stack" style="gap:10px">
<div class="stack" style="gap:7px">${checks
      .map(
        ([label, on, st, cls]) =>
          `<label class="check${st === 'disabled' ? ' is-disabled' : ''}"><input type="checkbox"${on ? ' checked' : ''}${st === 'disabled' ? ' disabled' : ''}><span class="box${cls}">${i('check', 12, 2.8)}</span><span class="spacer">${label}</span><span class="state-label">${st}</span></label>`,
      )
      .join('')}</div>
<div class="field"><span class="label">Select · open</span>
<div class="select"><span class="input is-focus" style="display:flex; align-items:center">Ink, hatched</span>${i('chevron-down', 14)}</div>
<div class="menu" role="listbox" aria-label="Wall style" style="margin-top:4px"><span class="menu-item" role="option" aria-selected="true">${i('check', 14)}Ink, hatched</span><span class="menu-item is-hover" role="option">Ink, plain</span><span class="menu-item" role="option">Rubble</span><span class="menu-item" role="option" aria-disabled="true">Cave (needs terrain pack)</span></div></div>
<div class="field"><label for="sel-${t}">Select · native</label><div class="select"><select id="sel-${t}" class="input"><option>Everyone</option><option>Owner + GM</option><option>GM only</option></select>${i('chevron-down', 14)}</div></div>
</div></div>`,
    'sg-panel sg-panel-surface',
  );
}

function cards(): string {
  return pair('Cards, tables, tags', '.map-card · .new-tile · .table · .tag', () => `<div class="sg-three">
<a class="card map-card elev-sm" href="/"><div class="map-card-thumb"><img src="${map()}" alt="" loading="lazy"></div><div class="map-card-body"><span class="map-card-title">The Sunken Abbey</span><span class="map-card-meta">3 storeys · edited 2 h ago</span></div></a>
<div class="card map-card is-hover"><div class="map-card-thumb"><img src="${map()}" alt="" loading="lazy" style="transform:scale(1.9); transform-origin:78% 40%"><div class="map-card-actions"><span class="btn btn-primary btn-sm">${i('play', 13)}Play</span><span class="btn btn-secondary btn-sm">Edit</span></div></div><div class="map-card-body"><span class="map-card-title">Chapter house</span><span class="map-card-meta">1 storey · edited yesterday</span></div></div>
<button class="new-tile is-focus" type="button">${i('plus', 22)}<span class="new-tile-label">New map</span><span style="font-size:11.5px">N</span></button>
</div>
<div class="row state-label" style="gap:24px; margin-top:6px"><span class="spacer">Default</span><span class="spacer">Hover · actions appear</span><span class="spacer">Focus</span></div>
<div class="table-wrap" style="margin-top:14px"><table class="table"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Sign-in</th><th class="end">Last seen</th></tr></thead><tbody>
<tr><td>Mara Venn</td><td><span class="tag tag-accent">Admin</span></td><td><span class="tag tag-neutral"><span class="dot"></span>Active</span></td><td class="text-muted">Password + code</td><td class="end text-muted">now</td></tr>
<tr><td>Oskar Lind</td><td><span class="tag tag-outline">GM</span></td><td><span class="tag tag-neutral"><span class="dot"></span>Active</span></td><td class="text-muted">Password only</td><td class="end text-muted">3 d</td></tr>
<tr><td>Priya S.</td><td><span class="tag tag-outline">Player</span></td><td><span class="tag tag-warning">Invited</span></td><td class="text-muted">Discord</td><td class="end text-muted">—</td></tr>
<tr><td class="text-muted">Tom Ashby</td><td><span class="tag tag-outline">Player</span></td><td><span class="tag tag-danger">Disabled</span></td><td class="text-muted">Password only</td><td class="end text-muted">4 mo</td></tr>
</tbody></table></div>
<div class="row" style="gap:6px; margin-top:16px"><span class="tag tag-accent">accent</span><span class="tag tag-neutral">neutral</span><span class="tag tag-outline">outline</span><span class="tag tag-info">info</span><span class="tag tag-warning">warning</span><span class="tag tag-danger">danger</span><span class="tag tag-neutral tag-numeral">Storey −1</span><span class="tag tag-neutral">${i('lock', 12)}Password only</span></div>`);
}

function messages(): string {
  return pair('Toasts, dialogs, the marker note', '.toast (role="status") · .dialog · .note-pop anchored to a marker', (t) => `<div class="stack" style="gap:8px; align-items:flex-start">
<div class="toast" role="status">${i('check', 16)}Exported “The Sunken Abbey.png”<button class="btn btn-ghost">Show file</button><button class="toast-close" aria-label="Dismiss">${i('x', 15)}</button></div>
<div class="toast" role="status">${i('trash', 16)}Room 3 deleted<button class="btn btn-ghost">Undo</button><kbd>Ctrl Z</kbd><span style="width:22px"></span></div>
<div class="toast toast-error" role="alert">${i('offline', 16)}Connection lost. 3 changes queued.<button class="btn btn-ghost">Retry now</button></div>
<span class="sg-note">Bottom-centre, stacked, auto-dismiss after 4 s. Errors stay until resolved and use role="alert".</span></div>
<div class="sg-overlay"><div class="dialog" role="dialog" aria-labelledby="dlg-${t}" style="width:min(400px, 100%)"><div id="dlg-${t}" class="dialog-title">Delete storey −1?</div><div class="dialog-body">“Flooded crypt” has 4 rooms, 11 props and 2 GM notes. The stairs from Room 5 will lead nowhere. You can undo this until you close the map.</div><div class="dialog-actions"><button class="btn btn-secondary">Cancel<span class="key">Esc</span></button><button class="btn btn-danger">Delete storey</button></div></div></div>
<div class="sg-mapbox" style="background-image:url('${map()}'); background-size:260%; background-position:30% 40%">
<div class="note-pop" role="dialog" aria-label="Marker note" style="position:absolute; left:calc(20% + 26px); top:18px"><div class="note-pop-head"><span class="marker marker-sm marker-discover">?</span><span class="kicker">Discover · Room 2</span>${i('x', 15)}</div>
<div class="stack" style="gap:8px"><label class="note-line check is-done"><input type="checkbox" checked><span class="box">${i('check', 12, 2.8)}</span><span>Loose flagstone by the second pillar</span></label><label class="note-line check"><input type="checkbox"><span class="box">${i('check', 12, 2.8)}</span><span>Under it: a silver key and a note in the prior's hand (DC 13 Investigation)</span></label></div>
<div class="row" style="gap:6px; padding-top:2px"><button class="btn btn-secondary btn-sm">Edit</button><button class="btn btn-ghost btn-sm">Reveal to players</button></div></div></div>
<span class="sg-note" style="margin-top:-10px">Clicking a marker opens its note. Tick a line to strike it through once the party has found it. Only the GM sees struck lines.</span>`, 'sg-panel sg-panel-gap');
}

function chat(): string {
  return pair('Chat lines and roll cards', 'Delve Table sidebar · dice notation in mono · totals in Marcellus SC', (t) => `<div class="sg-chat">
<div class="chat"><div class="chat-head"><span class="chat-head-title">Chat</span><span class="text-muted" style="font-size:12px">3D dice</span><button class="switch" role="switch" aria-checked="${t === 'dark'}" aria-label="3D dice"></button></div>
<div class="chat-log"><span class="chat-sys">Isolde joined the table · 20:14</span>
<div class="chat-msg"><span class="avatar avatar-sm avatar-ink">BR</span><div class="chat-msg-body"><span class="chat-meta"><b>Brannoc</b> · 20:16</span><span>I check the altar for traps before I touch it.</span></div></div>
<div class="chat-msg chat-whisper">${i('lock', 15)}<div class="chat-msg-body"><span class="chat-meta"><b>Whisper · Mara → Brannoc</b> · 20:16</span><span class="chat-text">You notice faint scratches around the base.</span></div></div>
<div class="chat-msg"><span class="avatar avatar-sm avatar-ink">BR</span><div class="roll"><span class="chat-meta"><b>Brannoc</b> · Longsword attack</span><span class="roll-total" title="2d20kh1 + 5">23</span><code class="roll-formula">/r 2d20kh1+5</code><span class="roll-dice"><span class="die">18</span><span class="die die-dropped">7</span>+ 5 · hits AC 16</span></div></div>
<div class="chat-msg"><span class="avatar avatar-sm avatar-ink" style="background:#7A5A8C">IS</span><div class="roll roll-fumble"><span class="chat-meta"><b>Isolde</b> · Dexterity save</span><span class="roll-total">3</span><span class="row" style="gap:8px"><code class="roll-formula">/r 1d20+2</code><span class="tag tag-danger tag-sm">Natural 1</span></span></div></div>
</div>
<div class="chat-input"><input class="input" placeholder="Message, or /r 1d20+3" aria-label="Message"><button class="btn btn-icon" aria-label="Roll" title="Roll dice">${i('dice')}</button><button class="btn btn-primary btn-icon" aria-label="Send">${i('send', 16)}</button></div></div>
<div class="stack" style="gap:10px; padding-top:150px"><span class="state-label">Hover on a total</span>
<div class="tip-card" role="tooltip"><code>2d20kh1 + 5</code><div class="tip-grid"><span>d20</span><span>kept</span><span class="numeral" style="color:var(--color-text)">18</span><span>d20</span><span>dropped</span><span class="numeral" style="text-decoration:line-through">7</span><span>mod</span><span>Strength</span><span class="numeral" style="color:var(--color-text)">+5</span></div><div class="tip-total"><span>Total</span><span class="numeral" style="font-size:15px">23</span></div></div>
<span class="sg-note">The total has a 1.5 px edge: accent for a normal roll, red for a natural 1, and accent with a “Natural 20” tag for a crit. Rolls are also announced to screen readers.</span></div></div>`);
}

function sheet(): string {
  return pair('Token settings and the bottom sheet', 'dialog on desktop · the same content becomes a sheet on phones', (t) => `<div class="sg-sheet-pair">
<div class="dialog" role="dialog" aria-label="Token settings" style="width:100%; gap:14px">
<div class="dialog-head"><span class="avatar avatar-lg avatar-ink">BR</span><div><div class="dialog-title" style="font-size:22px">Brannoc</div><span class="text-muted" style="font-size:12px">Token · owned by Sam</span></div><button class="btn btn-icon" aria-label="Close">${i('x', 17)}</button></div>
<div class="field-row"><div class="field"><label for="hp-${t}">HP</label><input id="hp-${t}" class="input" value="31"></div><div class="field"><label for="mhp-${t}">Max HP</label><input id="mhp-${t}" class="input" value="38"></div><div class="field"><label for="bar-${t}">Bar shown to</label><div class="select"><select id="bar-${t}" class="input"><option>Everyone</option><option>Owner + GM</option><option>GM only</option></select>${i('chevron-down', 14)}</div></div></div>
<div class="stack" style="gap:10px; padding-top:4px"><span class="section-label">Vision and light</span>
<label class="check"><input type="checkbox" checked><span class="box">${i('check', 12, 2.8)}</span>Has sight<span class="check-hint">· reveals fog as it moves</span></label>
<div class="field-row"><div class="field"><label for="dv-${t}">Darkvision</label><div class="input-unit"><input id="dv-${t}" class="input" value="60"><span class="unit">ft</span></div></div><div class="field"><label for="bl-${t}">Bright light</label><div class="input-unit"><input id="bl-${t}" class="input" value="20"><span class="unit">ft</span></div></div><div class="field"><label for="dl-${t}">Dim light</label><div class="input-unit"><input id="dl-${t}" class="input" value="40"><span class="unit">ft</span></div></div></div>
<span class="text-muted" style="font-size:12px">Torch preset: 20 bright, 20 dim. The page's vision mode and ambient light still apply.</span></div>
<div class="dialog-actions" style="margin-top:0"><button class="btn btn-secondary">Cancel</button><button class="btn btn-primary">Save token</button></div></div>
<div class="sg-phone" style="background-image:url('${map('players')}')">
<div class="sheet" style="position:absolute; left:0; right:0; bottom:0; height:262px"><span class="sheet-handle"></span>
<div class="sheet-tabs" role="tablist"><button class="sheet-tab" role="tab" aria-selected="true">${i('chat')}Chat</button><button class="sheet-tab" role="tab">${i('dice')}Turn</button><button class="sheet-tab" role="tab">${i('notes')}Sheet</button></div>
<div class="stack" style="flex:1; padding:8px 12px; gap:8px; overflow:hidden"><span><span class="text-muted">Brannoc</span> I check the altar.</span><span class="sg-sheet-roll"><code class="roll-formula spacer" style="font-size:11.5px">/r 1d20+4</code><span class="numeral" style="font-size:19px">17</span></span></div>
<div class="row" style="gap:6px; padding:8px 10px 20px; box-shadow:inset 0 1px 0 var(--color-border); flex-wrap:nowrap"><input class="input" placeholder="Message" aria-label="Message" style="min-height:44px; font-size:15px"><button class="btn btn-primary btn-icon" aria-label="Send" style="width:44px; height:44px">${i('send')}</button></div></div></div></div>`) + `<p class="sg-note" style="margin-top:-16px">Sheet stops: peek 168 px (tabs plus the last line), half screen, and full height minus 96 px. Drag the handle or tap a tab to raise it, swipe down to lower it. The board stays interactive above the sheet.</p>`;
}

function states_(): string {
  return pair('Empty, loading, live and offline', '.empty · .skeleton · .unrolling · .status · .save-state', () => `<div class="sg-two" style="gap:12px">
<div class="empty">${i('layers', 22)}<span class="empty-title">No maps yet</span><p class="empty-text">Start from a blank sheet, or bring in a Dungeon Scrawl file.</p><div class="row" style="gap:6px; padding-top:4px"><button class="btn btn-primary btn-sm">${i('plus', 14)}New map</button><button class="btn btn-secondary btn-sm">${i('upload', 14)}Import .ds</button></div></div>
<div class="empty" style="padding:12px; align-items:stretch" aria-busy="true" aria-label="Loading maps"><span class="skeleton" style="aspect-ratio:16/9"></span><span class="skeleton skeleton-line" style="width:62%"></span><span class="skeleton skeleton-line" style="width:40%; height:10px"></span></div></div>
<div class="unrolling" role="status" style="height:96px; margin-top:18px"><span class="unrolling-text">Unrolling the map…</span><span class="unrolling-bar"><span style="width:64%"></span></span></div>
<div class="row" style="gap:8px 18px; margin-top:18px"><span class="status status-live">Live</span><span class="status status-connecting">Connecting…</span><span class="status status-offline">Offline · retrying in 4 s</span><span class="tag tag-accent tag-sm"><span class="dot"></span>Claude editing</span></div>
<div class="row" style="gap:8px 18px; margin-top:12px"><span class="save-state">${i('check', 14)}Saved</span><span class="save-state">${i('upload', 14)}Saving…</span><span class="save-state is-warning">${i('alert', 14)}Unsaved changes</span><span class="save-state is-warning">${i('offline', 14)}3 changes queued</span></div>
<span class="sg-note" style="display:block; margin-top:14px">Status always pairs colour with a word and a shape (filled, ring or icon), so it never depends on colour alone.</span>`);
}

// The guide's own layout. Everything inside the specimens is the shared stylesheet.
const GUIDE_CSS = `<style>
  .sg { max-width: 1440px; padding: 56px 40px 96px; display: flex; flex-direction: column; gap: 72px; font-size: 14px; line-height: 1.5; }
  .sg code { font-size: 13px; color: var(--color-text); }
  .sg-head { display: flex; flex-direction: column; gap: 20px; max-width: 980px; }
  .sg-head .kicker { font-size: 12px; letter-spacing: .12em; }
  .sg-title { margin: 0; font-family: var(--font-display); font-weight: 400; font-size: 64px; line-height: 1; letter-spacing: 0; }
  .sg-principles { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 28px; padding-top: 8px; }
  .sg-principles > div { display: flex; flex-direction: column; gap: 4px; }
  .sg-principles b { font-family: var(--font-display); font-size: 21px; font-weight: 400; }
  .sg-principles span { color: var(--color-text-muted); text-wrap: pretty; }
  .sg-section { display: flex; flex-direction: column; gap: 24px; }
  .sg-section-head { display: flex; align-items: baseline; gap: 16px; }
  .sg-section-head .numeral { font-size: 18px; }
  .sg-h2 { margin: 0; font-family: var(--font-display); font-weight: 400; font-size: 38px; letter-spacing: 0; line-height: 1.12; }
  .sg-h3 { font-family: var(--font-display); font-size: 24px; }
  .sg-h4 { font-family: var(--font-display); font-size: 20px; }
  .sg-sub, .sg-note { font-size: 12.5px; color: var(--color-text-muted); }
  .sg-note b { color: var(--color-text); font-weight: 400; }
  .sg-p { margin: 0; max-width: 820px; color: var(--color-text-muted); text-wrap: pretty; }
  .sg-block { display: flex; flex-direction: column; gap: 12px; }
  .sg-block-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .sg-pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 600px), 1fr)); gap: 20px; }
  .sg-panel { background: var(--color-bg); color: var(--color-text); border-radius: 14px; padding: 20px 22px; box-shadow: 0 0 0 1px var(--color-border); min-width: 0; font-size: 13px; display: flex; flex-direction: column; gap: 0; }
  .sg-panel-surface { background: var(--color-surface); gap: 18px; }
  .sg-panel-gap { gap: 20px; }
  .sg-states { display: grid; grid-template-columns: 76px repeat(5, minmax(0, 1fr)); gap: 12px 10px; align-items: center; }
  .sg-row-label { font-size: 12px; color: var(--color-text-muted); }
  .sg-colour-panel { background: var(--color-surface); color: var(--color-text); border-radius: 14px; padding: 20px 22px; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .sg-colour-title { gap: 8px; padding-bottom: 10px; }
  .sg-colour-title .icon { color: var(--color-accent); }
  .sg-colour-title .kicker { font-size: 12px; letter-spacing: .1em; }
  .sg-colour-group { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--color-text-faint); padding: 12px 0 4px; }
  .sg-colour-row { display: grid; grid-template-columns: 30px minmax(0, 1.3fr) 76px minmax(0, 1.4fr) 74px; align-items: center; gap: 12px; padding: 5px 0; font-size: 12.5px; }
  .sg-colour-row .mono { font-size: 12px; }
  .sg-swatch { width: 30px; height: 30px; border-radius: 7px; box-shadow: inset 0 0 0 1px var(--color-border-strong); }
  .sg-ratio { justify-self: end; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--color-text-muted); }
  .sg-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sg-canvas-pair { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 20px; }
  .sg-parch { border-radius: 14px; overflow: hidden; background: var(--canvas-parchment); color: var(--canvas-ink); padding: 22px; display: flex; flex-direction: column; gap: 14px; box-shadow: var(--shadow-sm); }
  .sg-parch-title { font-family: var(--font-display); font-size: 22px; }
  .sg-parch-name { font-family: var(--font-display); font-size: 17px; }
  .sg-parch-muted { font-size: 12.5px; color: #5A4E40; }
  .sg-parch .mono { font-size: 11.5px; }
  .sg-canvas-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  .sg-canvas-cell { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .sg-canvas-cell > span:first-child { height: 48px; border-radius: 7px; box-shadow: inset 0 0 0 1px rgba(43,36,29,.3); }
  .sg-canvas-cell .mono { font-size: 11px; overflow-wrap: anywhere; }
  .sg-marker-row { display: flex; align-items: center; gap: 12px; }
  .sg-type-row { display: grid; grid-template-columns: 200px minmax(0, 1fr) 220px; align-items: baseline; gap: 24px; padding: 14px 0; box-shadow: inset 0 -1px 0 var(--color-border); }
  .sg-two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 40px; }
  .sg-three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .sg-five { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
  .sg-space-row { display: grid; grid-template-columns: 96px 40px minmax(0, 1fr); align-items: center; gap: 12px; font-size: 12px; }
  .sg-space-bar { height: 12px; background: var(--color-accent); border-radius: 2px; }
  .sg-sizes { display: flex; flex-wrap: wrap; gap: 12px 20px; padding-top: 12px; font-size: 12.5px; color: var(--color-text-muted); }
  .sg-sizes .mono { color: var(--color-text); }
  .sg-radius { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 11.5px; }
  .sg-radius > span:first-child { width: 56px; height: 56px; background: var(--color-surface-2); box-shadow: inset 0 0 0 1.5px var(--color-accent); }
  .sg-elev-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .sg-elev { background: var(--color-bg); border-radius: 12px; padding: 18px; display: flex; gap: 12px; box-shadow: 0 0 0 1px var(--color-border); }
  .sg-elev > div { flex: 1; height: 64px; border-radius: 8px; background: var(--color-surface); display: grid; place-items: center; font-family: var(--font-mono); font-size: 11px; color: var(--color-text-muted); }
  .sg-icon-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; }
  .sg-icon { height: 78px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; border-radius: 8px; background: var(--color-surface); box-shadow: inset 0 0 0 1px var(--color-border); }
  .sg-icon.is-new { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 45%, transparent); }
  .sg-icon .mono { font-size: 10.5px; color: var(--color-text-muted); }
  .sg-rail { border-radius: 10px; box-shadow: var(--shadow-sm); }
  .sg-tooltip { position: absolute; left: 46px; top: 50%; transform: translateY(-50%); z-index: 4; }
  .sg-overlay { border-radius: 12px; padding: 28px 20px; background: var(--color-overlay); display: grid; place-items: center; }
  .sg-mapbox { position: relative; height: 260px; border-radius: 12px; overflow: hidden; background-color: var(--canvas-parchment); background-repeat: no-repeat; }
  .sg-chat { display: grid; grid-template-columns: minmax(0, 1fr) 210px; gap: 20px; }
  .sg-sheet-pair { display: grid; grid-template-columns: minmax(0, 1fr) 250px; gap: 20px; align-items: start; }
  .sg-phone { width: 250px; height: 440px; position: relative; overflow: hidden; border-radius: 28px; box-shadow: 0 0 0 6px #050608, 0 0 0 7px var(--color-border-strong); background-color: var(--canvas-parchment); background-size: 300%; background-position: 40% 30%; background-repeat: no-repeat; }
  .sg-sheet-roll { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; background: var(--color-surface-2); box-shadow: inset 0 0 0 1px var(--color-border-strong); }
  .sg-page-top { position: sticky; top: 0; }
  @media (max-width: 900px) {
    .sg { padding: 32px 16px 64px; gap: 48px; }
    .sg-title { font-size: 44px; }
    .sg-canvas-pair, .sg-two, .sg-chat, .sg-sheet-pair { grid-template-columns: minmax(0, 1fr); }
    .sg-five, .sg-three { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .sg-type-row { grid-template-columns: minmax(0, 1fr); gap: 4px; }
    .sg-states { overflow-x: auto; }
    .sg-colour-row { grid-template-columns: 30px minmax(0, 1fr) 70px; }
    .sg-colour-row > :nth-child(4), .sg-colour-row > :nth-child(5) { display: none; }
  }
</style>`;

// Live bits: range outputs and the switch. The theme boot script does the rest.
const GUIDE_JS = `<script>
  document.addEventListener('input', function (e) { var t = e.target; var out = t.dataset && t.dataset.output && document.getElementById(t.dataset.output); if (out) out.textContent = t.value; });
  document.addEventListener('click', function (e) { var s = e.target.closest && e.target.closest('.switch'); if (s) s.setAttribute('aria-checked', s.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); });
</script>`;

export function uiGuidePage(o: { version: string }): string {
  const body = `<header class="topbar sg-page-top"><a class="topbar-brand" href="/">Delve</a><span class="vsep"></span><a class="crumb" href="/">Library</a>${icon('chevron-right', { size: 14, className: 'crumb-sep' })}<span class="crumb-title">Style guide</span>
<div class="topbar-end"><span class="text-muted mono" style="font-size:12px; padding:0 8px">${esc(o.version)}</span>${themeSwitch()}</div></header>
<main class="sg">
<header class="sg-head">
<span class="kicker">Delve · design system v1 · built on Nocturne</span>
<h1 class="sg-title">Ink, stone &amp; parchment</h1>
<p class="lead">A quiet toolkit for the cartographer's desk. The map is always the hero, so the chrome stays low-chroma stone in both themes. One violet ink accent marks focus, selection and the active tool. Red, amber and blue only appear for status and the three GM markers.</p>
<div class="sg-principles"><div><b>The map leads</b><span>The canvas is parchment in both themes. Panels never float more than a third over it, and nothing around it is saturated.</span></div><div><b>Keys first, thumbs welcome</b><span>Every GM tool shows its letter. On phones every target is at least 44 px, and sheets replace panels.</span></div><div><b>Lines, not floods</b><span>From Nocturne: outlined primary buttons, 8 px radii, a 2 px focus ring, and elevation made of an edge plus soft shade.</span></div></div>
<div class="row"><a class="btn btn-primary" href="/">${i('room', 16)}Open Delve</a><span class="btn btn-secondary mono" style="cursor:default; font-size:12.5px">/assets/delve-ui.css</span><span class="btn btn-secondary mono" style="cursor:default; font-size:12.5px">@delve/ui</span><span class="btn btn-secondary mono" style="cursor:default; font-size:12.5px">docs/UI.md</span></div>
</header>
${colours()}
${type()}
${space()}
${icons()}
<section class="sg-section" id="components">${sectionHead('05', 'Components and their states')}
<p class="sg-p">Each specimen is shown in both themes. Hover, active and focus are drawn statically (with the .is-hover, .is-active and .is-focus twins of the real rules) so they can be compared side by side; the live controls also respond to the pointer and keyboard. Disabled is always 45 % opacity with a not-allowed cursor. Focus is always a 2 px accent outline with a 2 px offset.</p>
${buttons()}
${segments()}
${rail()}
${fields()}
${cards()}
${messages()}
${chat()}
${sheet()}
${states_()}
</section>
</main>${GUIDE_JS}`;
  return htmlDocument({ title: 'Style guide', body, extra: GUIDE_CSS });
}
