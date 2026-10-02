# Delve UI

Delve's pages share one look: the user's design from Claude Design, committed in `docs/design/ui-v1/` ("Ink, stone & parchment", built on Nocturne). The design is the source of truth; `packages/ui` (`@delve/ui`) turns it into code, and `/ui` shows every token and component in both themes next to each other, laid out like the design document, so the two can be compared.

## What's in `@delve/ui`

| File | What |
|---|---|
| `src/tokens.ts` | The token sheet, value for value as in `delve-tokens.css`. The fonts are our own files under `/fonts`, never Google Fonts or a CDN. |
| `src/base.ts` | Nocturne's base and component layer, as it is in the design (`.btn`, `.seg`, `.field`, `.input`, `.card`, `.table`, `.tag`, `.dialog`…). |
| `src/components.ts` | Delve's components on top: everything in the design's "Components and their states". |
| `src/css.ts` | `UI_CSS` (all three, in that order) and `UI_CSS_VERSION`, a hash of it. |
| `src/theme.ts` | `THEME_BOOT`, the inline theme script, and `themeSwitch()`. |
| `src/icons.ts` | The design's 67 icons and `icon(name, {size, stroke, label, className})`. |
| `src/head.ts` | `head()`, `htmlDocument()` and `esc()`. |

The server sends the stylesheet as `/assets/delve-ui.css?v=<UI_CSS_VERSION>` (cached for good at its own version) and the fonts as `/fonts/im-fell-english.ttf`, `/fonts/im-fell-english-italic.ttf` and `/fonts/marcellus-sc.ttf`. `packages/ui/test/ui.test.ts` checks that every token and every icon matches the design files exactly.

## Making a page

```ts
import { htmlDocument, icon, themeSwitch } from '@delve/ui';

const html = htmlDocument({
  title: 'Library',            // becomes "Library · Delve"
  body: `<header class="topbar">…${themeSwitch()}…</header><main class="page">…</main>`,
  extra: '<style>/* only this page's layout, from the tokens */</style>',
});
```

`head()` puts the theme script first, so `data-theme` is set before the first paint. A web bundle (`apps/web`) can import `icon()` and the class names the same way; the stylesheet itself always comes from the `<link>`.

Rules:

- Take every colour, size, radius and shadow from a token (`var(--color-*)`, `--space-*`, `--radius-*`, `--shadow-*`, `--text-*`, `--display-*`). The canvas and marker colours (`--canvas-*`, `--marker-*`) are the same in both themes.
- Use the shared classes before writing page CSS. Page CSS is layout only.
- One primary button per view. Primary buttons are outlined, never filled.
- Icon-only buttons need `aria-label` and a `title` with the shortcut.
- Status always pairs colour with a word and a shape.
- IM Fell English (`--font-display`) is for titles and is never bold. Marcellus SC (`--font-numeral`) is for numbers that must read at a glance: rooms, storeys, dice totals.
- Phones: targets are at least 44 px (`.btn` grows by itself under 640 px) and inputs are 16 px, so iOS doesn't zoom.

## Themes

Dark ("Slate") is the default, light is "Limestone". The choice is kept in `localStorage["delve-theme"]` as `dark` or `light`; no key means "system". The boot script sets `data-theme` on `<html>` (and `data-theme-mode` to the choice), follows the system while the choice is "system", and keeps other tabs in step. `window.delveTheme.set('light' | 'dark' | 'system')` changes it from code; `themeSwitch()` is the control for pages. `data-theme="dark|light"` on any element themes that subtree, which is how `/ui` shows both themes at once.

## Components

The class names follow the design. Static state classes (`.is-hover`, `.is-active`, `.is-focus`, `.is-on`, `.is-disabled`) exist so `/ui` can draw every state side by side; real pages use the pseudo-classes and ARIA attributes in the "states" column.

| Component | Classes | States |
|---|---|---|
| Buttons | `.btn` + `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-ghost`, `.btn-plain`; sizes `.btn-sm` (28), default (32), `.btn-lg` (36), `.btn-touch` (44); `.btn-icon`; `.btn-block`; `.key` for a shortcut hint inside | `:hover`, `:active`, `:focus-visible`, `:disabled`, `aria-pressed` on icon buttons |
| Keys | `kbd` | |
| Segmented | `.seg` > `label.seg-opt` > `input[type=radio]` + content; `.seg-sm`, `.seg-ground` | checked radio, disabled radio |
| Tabs | `.tabs` (role tablist) > `.tab` (role tab) | `aria-selected`, `aria-current="page"`, `aria-disabled` |
| Tool rail | `.rail` > `.tool` (+ `.tool-key`), `.rail-sep` | `aria-pressed`, `:disabled` |
| Tooltip | `.tooltip` (+ `kbd`, `.tooltip-hint`), `.tip-card` + `.tip-grid` + `.tip-total` for dice | |
| Context bar | `.ctxbar` > `.ctxbar-title`, `.vsep`, `.ctxbar-opt` (+ `.ctxbar-num`) | `aria-checked` / `aria-pressed` |
| Fields | `.field` > `label` + `.input` (+ `.field-error`, `.field-hint`); `.field.has-error`; `.input-unit` > `.input` + `.unit`; `.select` > `select.input` + chevron icon; `.input-lg`; `.field-row` | `:hover`, `:focus-visible`, `:disabled`, `aria-invalid` |
| Checkbox | `label.check` > `input[type=checkbox]` + `span.box` (with `icon('check', {size: 12, stroke: 2.8})`) + text | checked, focus, disabled |
| Switch | `button.switch[role=switch]` | `aria-checked` (the page toggles it) |
| Slider | `.range-head` (label + `output.range-value`), `input.range`, `.range-ticks` | `:focus-visible`, `:disabled`; the theme script keeps `--fill` in step |
| Menu, listbox | `.menu` > `.menu-item` (+ `.has-icon`, `.menu-item-sub`) | `aria-selected` / `aria-checked`, `aria-disabled` |
| Cards | `.card`, `.panel` + `.panel-title`, `.elev-sm/md/lg`; map cards `.map-card` > `.map-card-thumb` (+ `.map-card-actions`) + `.map-card-body` > `.map-card-title` + `.map-card-meta`; `.new-tile` | actions appear on hover and focus-within |
| Tables | `.table-wrap` > `table.table`, `.end` for right-aligned cells | |
| Tags | `.tag` + `.tag-accent`, `.tag-neutral`, `.tag-outline`, `.tag-info`, `.tag-warning`, `.tag-danger`; `.tag-numeral`, `.tag-sm`; `.dot` | |
| Notices | `.notice` + `.notice-info`, `.notice-ok`, `.notice-warning`, `.notice-danger`; `.error` | |
| Toasts | `.toasts` (fixed, bottom centre) > `.toast` (+ `.toast-error`, `.toast-close`) | role `status`; errors role `alert` |
| Dialogs | `.dialog-backdrop` > `.dialog` > `.dialog-head`, `.dialog-title`, `.dialog-body`, `.dialog-actions`; `.section-label` | |
| Markers | `.marker` + `.marker-discover`, `.marker-interact`, `.marker-trap`; `.marker-sm`, `.marker-xs` | |
| Marker note | `.note-pop` > `.note-pop-head`, `label.note-line.check` | a ticked line is struck through |
| Chat | `.chat` > `.chat-head`, `.chat-log` > `.chat-sys`, `.chat-msg` (+ `.chat-whisper`) > `.avatar` + `.chat-msg-body` > `.chat-meta` + text; `.chat-input` | |
| Rolls | `.roll` (+ `.roll-fumble`) > `.chat-meta`, `.roll-total`, `.roll-formula`, `.roll-dice` > `.die` (+ `.die-dropped`) | |
| Sheet | `.sheet` > `.sheet-handle`, `.sheet-tabs` > `.sheet-tab` | `aria-selected` |
| Empty and loading | `.empty` (+ `.empty-title`, `.empty-text`), `.skeleton` (+ `.skeleton-line`), `.unrolling` (+ `.unrolling-text`, `.unrolling-bar`) | |
| Live and saving | `.status` + `.status-live`, `.status-connecting`, `.status-offline`; `.save-state` (+ `.is-warning`) | |
| Top bar | `.topbar` > `.topbar-brand`, `.vsep`, `.crumb`, `.crumb-sep`, `.crumb-title`, `.topbar-end`; `.avatar` (+ `-sm`, `-lg`, `-ink`) | |
| Layout and type | `.page` (+ `.page-narrow`), `.row`, `.stack`, `.spacer`; `.display-xl/lg/md/sm`, `.numeral`, `.kicker`, `.lead`, `.text-muted`, `.text-faint`, `.mono`, `.visually-hidden` | |

The editor's layout sizes are tokens too: `--bar-h` 48, `--rail-w` 52, `--panel-w` 288, `--chat-w` 344, `--sheet-peek` 168, `--touch` 44.

## Where the pages stand

- Built on `@delve/ui`: the login, setup, recovery-code, account and admin pages (`apps/server/src/accounts/pages.ts`) and the style guide (`/ui`, `apps/server/src/ui-guide.ts`).
- Also on it since stage 2: the map editor and viewer (`editor-page.ts`, `apps/web/src/shell.ts`, `dom.ts`), the start page and library, the 3D view, the handout, tracing, the players' screen, and Delve Table's lobby, join and Discord pages (`table/html.ts`). And since stage 2c the Delve Table 2D and 3D pages (`table/page.ts`, `page3d.ts`, `table/table-css.ts`, `notes-css.ts`).
