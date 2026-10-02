// The whole stylesheet, in cascade order: tokens, the Nocturne layer, Delve's
// components. The server sends it as /assets/delve-ui.css?v=<UI_CSS_VERSION>.
import { NOCTURNE_CSS } from './base.ts';
import { COMPONENTS_CSS } from './components.ts';
import { TOKENS_CSS } from './tokens.ts';

export const UI_CSS = `/* Delve UI v1: tokens, Nocturne base, Delve components. Source: packages/ui. */
${TOKENS_CSS}
${NOCTURNE_CSS}
${COMPONENTS_CSS}`;

/** FNV-1a, 32 bit, as 8 hex digits: cheap, stable, and the same in Node and browsers. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Changes whenever the stylesheet does, so browsers may cache each version for good. */
export const UI_CSS_VERSION = hash(UI_CSS);

export const UI_CSS_PATH = '/assets/delve-ui.css';
