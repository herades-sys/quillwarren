// The <head> every Quillwarren page shares: charset, viewport, title, icon, the theme
// boot script (first, before any paint) and the stylesheet.
import { UI_CSS_PATH, UI_CSS_VERSION } from './css.ts';
import { THEME_BOOT } from './theme.ts';

/** Escapes text for HTML content and attribute values. */
export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * A value as JSON for inside a <script> element (a type="application/json"
 * block or code). <, > and & become \u escapes, so a name holding "</script>"
 * or "<!--" can't end the script, and so do U+2028 and U+2029 (line ends to
 * older JavaScript). JSON.parse reads it back unchanged.
 */
export const jsonForScript = (value: unknown): string =>
  JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export interface HeadOptions {
  /** The page's own title; " · Quillwarren" is added unless it already ends so. */
  title: string;
  /** Markup appended at the end of <head> (page styles, preloads). */
  extra?: string;
}

export function head(o: HeadOptions): string {
  const title = /(^|· )Quillwarren( Table)?$/.test(o.title) ? o.title : `${o.title} · Quillwarren`;
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<script>${THEME_BOOT}</script>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${UI_CSS_PATH}?v=${UI_CSS_VERSION}">${o.extra ?? ''}`;
}

export interface DocumentOptions extends HeadOptions {
  body: string;
  /** Classes on <body>. */
  bodyClass?: string;
}

/** A whole page: doctype, <head> from head(), and the body. */
export function htmlDocument(o: DocumentOptions): string {
  return `<!doctype html><html lang="en"><head>${head(o)}</head><body${o.bodyClass ? ` class="${esc(o.bodyClass)}"` : ''}>${o.body}</body></html>`;
}
