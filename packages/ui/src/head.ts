// The <head> every Delve page shares: charset, viewport, title, icon, the theme
// boot script (first, before any paint) and the stylesheet.
import { UI_CSS_PATH, UI_CSS_VERSION } from './css.ts';
import { THEME_BOOT } from './theme.ts';

/** Escapes text for HTML content and attribute values. */
export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface HeadOptions {
  /** The page's own title; " · Delve" is added unless it already ends so. */
  title: string;
  /** Markup appended at the end of <head> (page styles, preloads). */
  extra?: string;
}

export function head(o: HeadOptions): string {
  const title = /(^|· )Delve( Table)?$/.test(o.title) ? o.title : `${o.title} · Delve`;
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
