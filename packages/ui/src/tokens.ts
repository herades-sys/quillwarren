// Delve's design tokens, exactly as in the design's delve-tokens.css (Nocturne's
// variable names, retuned for ink, stone and parchment). Two changes: the fonts
// are our own files under /fonts instead of Google Fonts, and a page without
// data-theme follows the system's light or dark setting.
//
// Themes: data-theme="dark" (Slate) or "light" (Limestone) on <html> or on any
// subtree. Canvas and marker colours never change with the theme.

/** Self-hosted fonts, served by the app (never a CDN). */
export const FONT_FACES = `@font-face { font-family: "IM Fell English"; src: url("/fonts/im-fell-english.ttf") format("truetype"); font-display: swap; }
@font-face { font-family: "IM Fell English"; font-style: italic; src: url("/fonts/im-fell-english-italic.ttf") format("truetype"); font-display: swap; }
@font-face { font-family: "Marcellus SC"; src: url("/fonts/marcellus-sc.ttf") format("truetype"); font-display: swap; }`;

/** The same in both themes: type, space, radius, sizes, motion, the map canvas and the GM markers. */
export const ROOT_TOKENS = `
  --font-display: "IM Fell English", "Iowan Old Style", Georgia, serif;
  --font-numeral: "Marcellus SC", "Iowan Old Style", Georgia, serif;
  --font-ui: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --font-heading: var(--font-ui); --font-heading-weight: 500; --font-body: var(--font-ui);

  --text-2xs: 10px; --text-xs: 11px; --text-sm: 12px; --text-md: 13px; --text-lg: 15px; --text-xl: 17px; --text-touch: 16px;
  --display-sm: 20px; --display-md: 26px; --display-lg: 34px; --display-xl: 46px;
  --leading-tight: 1.15; --leading-ui: 1.4; --leading-body: 1.55;

  --space-1: 3px; --space-2: 6px; --space-3: 8px; --space-4: 12px; --space-5: 16px;
  --space-6: 20px; --space-8: 24px; --space-10: 32px; --space-12: 48px;
  --radius-xs: 3px; --radius-sm: 4px; --radius-md: 8px; --radius-lg: 14px; --radius-pill: 999px;

  --control-sm: 28px; --control-md: 32px; --control-lg: 36px; --touch: 44px;
  --bar-h: 48px; --rail-w: 52px; --panel-w: 288px; --chat-w: 344px; --sheet-peek: 168px;
  --ease: cubic-bezier(.2,.7,.2,1); --dur-fast: 120ms; --dur: 200ms;

  --canvas-parchment: #EADCBB;
  --canvas-parchment-deep: #DCC9A2;
  --canvas-floor: #F4ECD7;
  --canvas-ink: #2B241D;
  --canvas-hatch: #4A3F33;
  --canvas-grid: rgba(74,63,51,.25);
  --canvas-select: #4F40A6;
  --canvas-fog: rgba(36,31,26,.84);

  --marker-discover: #D9961A;
  --marker-interact: #2F7FD1;
  --marker-trap: #C43A2F;
  --marker-ink: #1F1A15;
`;

/** Dark, "Slate": the default. */
export const DARK_TOKENS = `
  color-scheme: dark;
  --color-bg: #13151C;
  --color-surface: #1C1F28;
  --color-surface-2: #252935;
  --color-surface-3: #2E3240;
  --color-overlay: rgba(8,9,13,.62);
  --color-text: #E9E7E2;
  --color-text-muted: #A6A9B6;
  --color-text-faint: #8A8E9C;
  --color-border: #2C303C;
  --color-border-strong: #3E4352;
  --color-control-border: #6A7082;
  --color-divider: color-mix(in srgb, #E9E7E2 14%, transparent);
  --color-hover: color-mix(in srgb, #E9E7E2 7%, transparent);
  --color-press: color-mix(in srgb, #E9E7E2 13%, transparent);

  --color-accent: #9D92E4;
  --color-accent-text: #C9C2FA;
  --color-accent-100: #f5f4ff; --color-accent-200: #e7e5fe; --color-accent-300: #d2cefd; --color-accent-400: #b5abfc;
  --color-accent-500: #968ae0; --color-accent-600: #796cbf; --color-accent-700: #5d5294; --color-accent-800: #423a6a; --color-accent-900: #2b2741;
  --color-neutral-100: #f3f5fe; --color-neutral-200: #e4e7f5; --color-neutral-300: #cfd3e5; --color-neutral-400: #b2b6ca;
  --color-neutral-500: #9397ab; --color-neutral-600: #75798c; --color-neutral-700: #595d6c; --color-neutral-800: #3f424d; --color-neutral-900: #292b31;

  --color-danger: #E2685D; --color-warning: #E5A93B; --color-info: #6AA5E8;
  --tint-accent-bg: #2D2948;  --tint-accent-fg: #D2CEFD;
  --tint-neutral-bg: #2A2D38; --tint-neutral-fg: #D4D6DF;
  --tint-danger-bg: #3B1F1E;  --tint-danger-fg: #F2B1AA;
  --tint-warning-bg: #3A2C12; --tint-warning-fg: #F1CD8A;
  --tint-info-bg: #16283E;    --tint-info-fg: #A9CBF2;

  --shadow-sm: 0 0 0 1px #2C303C;
  --shadow-md: 0 0 0 1px #3A3F4E, 0 6px 18px rgba(0,0,0,.5);
  --shadow-lg: 0 0 0 1px #4A5062, 0 16px 40px rgba(0,0,0,.6);
`;

/** Light, "Limestone". */
export const LIGHT_TOKENS = `
  color-scheme: light;
  --color-bg: #E9E7E1;
  --color-surface: #F6F5F1;
  --color-surface-2: #FCFBF8;
  --color-surface-3: #EDEBE5;
  --color-overlay: rgba(34,30,24,.42);
  --color-text: #1F2027;
  --color-text-muted: #565965;
  --color-text-faint: #62656F;
  --color-border: #D9D6CD;
  --color-border-strong: #C4C0B5;
  --color-control-border: #8F8B80;
  --color-divider: color-mix(in srgb, #1F2027 16%, transparent);
  --color-hover: color-mix(in srgb, #1F2027 6%, transparent);
  --color-press: color-mix(in srgb, #1F2027 11%, transparent);

  --color-accent: #5546A8;
  --color-accent-text: #45378F;
  --color-accent-100: #F2F0FC; --color-accent-200: #E3DFF8; --color-accent-300: #C7C0EE; --color-accent-400: #A79DE2;
  --color-accent-500: #8578CF; --color-accent-600: #6B5DBF; --color-accent-700: #5546A8; --color-accent-800: #423687; --color-accent-900: #2D255E;
  --color-neutral-100: #FCFBF8; --color-neutral-200: #F6F5F1; --color-neutral-300: #EAE8E2; --color-neutral-400: #D5D2C9;
  --color-neutral-500: #A9A59B; --color-neutral-600: #7E7A71; --color-neutral-700: #5A5750; --color-neutral-800: #3A3833; --color-neutral-900: #22211E;

  --color-danger: #A8322A; --color-warning: #8A5B00; --color-info: #1F5FA8;
  --tint-accent-bg: #E6E2F8;  --tint-accent-fg: #3B2F82;
  --tint-neutral-bg: #E4E1D9; --tint-neutral-fg: #3A3833;
  --tint-danger-bg: #F6DEDA;  --tint-danger-fg: #8A2219;
  --tint-warning-bg: #F5E6C6; --tint-warning-fg: #6E4800;
  --tint-info-bg: #DCE8F6;    --tint-info-fg: #184C88;

  --shadow-sm: 0 0 0 1px #D9D6CD, 0 1px 2px rgba(40,32,20,.06);
  --shadow-md: 0 0 0 1px #D2CEC4, 0 6px 16px rgba(40,32,20,.12);
  --shadow-lg: 0 0 0 1px #C8C3B8, 0 18px 40px rgba(40,32,20,.18);
`;

/**
 * The token sheet. Dark is the default; [data-theme="light"] switches a page or
 * a subtree. Before the theme script has run (or without script), a page with
 * no data-theme follows the system setting.
 */
export const TOKENS_CSS = `${FONT_FACES}
:root {${ROOT_TOKENS}}
:root, [data-theme="dark"] {${DARK_TOKENS}}
[data-theme="light"] {${LIGHT_TOKENS}}
@media (prefers-color-scheme: light) { :root:not([data-theme]) {${LIGHT_TOKENS}} }
[data-theme] { color: var(--color-text); font-family: var(--font-ui); }
`;
