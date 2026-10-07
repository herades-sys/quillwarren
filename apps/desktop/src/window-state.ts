// The window's size and place, remembered between launches. Pure (no
// Electron): the caller passes the screens' work areas. A saved place that is
// off every screen now (a monitor unplugged) is moved back onto the primary one.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds?: Rect;
  maximized: boolean;
  fullScreen: boolean;
}

export const DEFAULT_SIZE = { width: 1440, height: 900 };
export const MIN_SIZE = { width: 800, height: 560 };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A saved state from JSON, or the defaults for anything odd in it. */
export function parseWindowState(json: unknown): WindowState {
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const b = (o.bounds && typeof o.bounds === 'object' ? o.bounds : {}) as Record<string, unknown>;
  const bounds = isNum(b.x) && isNum(b.y) && isNum(b.width) && isNum(b.height) && b.width > 0 && b.height > 0 ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : undefined;
  return { ...(bounds ? { bounds } : {}), maximized: o.maximized === true, fullScreen: o.fullScreen === true };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where to open the window: the saved bounds when enough of them (a title bar's
 * worth) is on some screen, shrunk to fit it; else centred on the primary
 * screen at the default size (or as much of it as fits).
 */
export function placeWindow(state: WindowState, screens: Rect[], primary: Rect): Rect {
  const fit = (r: Rect, area: Rect): Rect => {
    const width = Math.max(Math.min(r.width, area.width), Math.min(MIN_SIZE.width, area.width));
    const height = Math.max(Math.min(r.height, area.height), Math.min(MIN_SIZE.height, area.height));
    const x = Math.min(Math.max(r.x, area.x), area.x + area.width - width);
    const y = Math.min(Math.max(r.y, area.y), area.y + area.height - height);
    return { x, y, width, height };
  };
  const b = state.bounds;
  if (b) {
    // the screen showing most of it; enough means the top 40 px across at least 120 px
    const titleBar = { x: b.x, y: b.y, width: b.width, height: 40 };
    const best = screens.map((s) => ({ s, a: overlap(titleBar, s) })).sort((p, q) => q.a - p.a)[0];
    if (best && best.a >= 120 * 40) return fit(b, best.s);
  }
  const width = Math.min(DEFAULT_SIZE.width, primary.width);
  const height = Math.min(DEFAULT_SIZE.height, primary.height);
  return { x: primary.x + Math.round((primary.width - width) / 2), y: primary.y + Math.round((primary.height - height) / 2), width, height };
}
