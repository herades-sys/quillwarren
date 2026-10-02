// The app's top bar for server pages: Delve, the breadcrumb, this page's
// title, then whatever the page puts on the right (buttons, the theme switch,
// who is logged in). The map editor builds its own, richer one.
import { esc } from './head.ts';
import { icon } from './icons.ts';

export interface TopBarOptions {
  /** Links between the brand and the title, e.g. [{ href: '/', text: 'Library' }]. */
  crumbs?: { href: string; text: string }[];
  /** This page's title, in the display face. */
  title?: string;
  /** Markup for the right-hand end. */
  end?: string;
  /** Extra classes on the bar. */
  className?: string;
}

export function topBar(o: TopBarOptions = {}): string {
  const crumbs = (o.crumbs ?? []).map((c) => `<a class="crumb" href="${esc(c.href)}">${esc(c.text)}</a>${icon('chevron-right', { size: 14, className: 'crumb-sep' })}`).join('');
  const sep = crumbs || o.title ? '<span class="vsep"></span>' : '';
  return `<header class="topbar${o.className ? ` ${esc(o.className)}` : ''}"><a class="topbar-brand" href="/">Delve</a>${sep}${crumbs}${o.title ? `<span class="crumb-title">${esc(o.title)}</span>` : ''}<div class="topbar-end">${o.end ?? ''}</div></header>`;
}
