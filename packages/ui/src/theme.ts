// The theme: dark, light or system, kept in localStorage "delve-theme" (no key
// means system). THEME_BOOT goes inline at the top of <head>, so data-theme is
// on <html> before the first paint and a light page never flashes dark.
//
// It also wires up the controls the stylesheet can't do alone:
// - radios with data-theme-set="dark|light|system" switch the theme (see themeSwitch());
// - every input.range keeps its --fill in step with its value.

import { icon } from './icons.ts';

export type ThemeMode = 'dark' | 'light' | 'system';

export const THEME_KEY = 'delve-theme';

/** Pure ES5, so it parses everywhere. Exposes window.delveTheme.get() / .set(mode). */
export const THEME_BOOT = `(function () {
  var d = document.documentElement, key = '${THEME_KEY}', light = window.matchMedia('(prefers-color-scheme: light)');
  function mode() { try { var v = localStorage.getItem(key); return v === 'dark' || v === 'light' ? v : 'system'; } catch (e) { return 'system'; } }
  function apply() {
    var m = mode();
    d.setAttribute('data-theme-mode', m);
    d.setAttribute('data-theme', m === 'system' ? (light.matches ? 'light' : 'dark') : m);
    var radios = document.querySelectorAll('input[data-theme-set]');
    for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === m;
  }
  function fill(r) { var lo = +r.min || 0, hi = r.max === '' ? 100 : +r.max, v = +r.value; r.style.setProperty('--fill', (hi > lo ? (v - lo) / (hi - lo) * 100 : 0) + '%'); }
  apply();
  if (light.addEventListener) light.addEventListener('change', apply);
  window.addEventListener('storage', function (e) { if (e.key === key) apply(); });
  window.delveTheme = {
    get: mode,
    set: function (m) { try { if (m === 'dark' || m === 'light') localStorage.setItem(key, m); else localStorage.removeItem(key); } catch (e) {} apply(); }
  };
  document.addEventListener('change', function (e) { var t = e.target; if (t && t.getAttribute && t.getAttribute('data-theme-set') !== null) window.delveTheme.set(t.value); });
  document.addEventListener('input', function (e) { var t = e.target; if (t && t.classList && t.classList.contains('range')) fill(t); });
  document.addEventListener('DOMContentLoaded', function () {
    apply();
    var ranges = document.querySelectorAll('input.range');
    for (var i = 0; i < ranges.length; i++) fill(ranges[i]);
  });
})();`;

/**
 * The theme picker: a small segmented control (system, light, dark). The boot
 * script ticks the current choice and saves changes. `name` must be unique on
 * the page if there are several.
 */
export function themeSwitch(name = 'delve-theme'): string {
  const opt = (value: ThemeMode, label: string, ic: 'screen' | 'sun' | 'moon'): string =>
    `<label class="seg-opt" title="${label}"><input type="radio" name="${name}" value="${value}" data-theme-set${value === 'system' ? ' checked' : ''}>${icon(ic, { size: 15 })}<span class="visually-hidden">${label}</span></label>`;
  return `<div class="seg seg-sm" role="radiogroup" aria-label="Theme">${opt('system', 'System theme', 'screen')}${opt('light', 'Light theme', 'sun')}${opt('dark', 'Dark theme', 'moon')}</div>`;
}
