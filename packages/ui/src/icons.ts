// Delve's icon set, from the design (docs/design/ui-v1/delve-icons.js): a 24 px
// grid, 1.7 stroke, round caps and joins, drawn in currentColor. Each entry is
// the inner SVG markup. Use them at 16, 18, 20 or 24 px.

export const ICONS = {
  chat: '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  corridor: '<path d="M3 9h9V3M3 15h15V3"/>',
  door: '<path d="M3 12h4.5M16.5 12H21"/><rect x="7.5" y="9.5" width="9" height="5" rx=".5"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  eraser: '<path d="M9 20h11M5.2 14.8l8.6-8.6a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L10 20H8.5l-3.3-3.3a1.4 1.4 0 0 1 0-1.9zM9.5 10.5l4 4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M9.9 5.8A10 10 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.7 3.4M6.3 7.3C3.9 9 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1M10 10a3 3 0 0 0 4 4M4 4l16 16"/>',
  fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16"/>',
  label: '<path d="M5 7V4.5h14V7M12 4.5v15M9 19.5h6"/>',
  layers: '<path d="M12 4 3 8.8l9 4.8 9-4.8z"/><path d="M3 13.2 12 18l9-4.8"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="1.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="9.5" rx="1.5"/><path d="M8 10.5V8a4 4 0 0 1 7.6-1.7"/>',
  pan: '<path d="M12 3v18M3 12h18M9.5 5.5 12 3l2.5 2.5M9.5 18.5 12 21l2.5-2.5M5.5 9.5 3 12l2.5 2.5M18.5 9.5 21 12l-2.5 2.5"/>',
  pillar: '<path d="M6 4.5h12M6 19.5h12M8.5 4.5 9.5 7v10l-1 2.5M15.5 4.5 14.5 7v10l1 2.5M12 7v10"/>',
  polygon: '<path d="M12 3.5 20.5 9.7 17.3 19.5H6.7L3.5 9.7z"/>',
  prop: '<rect x="4" y="9" width="16" height="10.5" rx="1"/><path d="M4 13h16M10.5 13v2h3v-2M5.5 9l1.5-3.5h10L18.5 9"/>',
  redo: '<path d="M15 5l5 5-5 5M20 10H9.5a5 5 0 0 0 0 10H13"/>',
  undo: '<path d="M9 5 4 10l5 5M4 10h10.5a5 5 0 0 1 0 10H11"/>',
  room: '<path d="M10 20H4V4h16v16h-4"/>',
  select: '<path d="M6 3.5 18 11l-5.6 1.4 3 6.2-2.3 1.1-3-6.2L6 17.5z"/>',
  send: '<path d="M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4z"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  stairs: '<path d="M4 20h4v-4h4v-4h4V8h4V4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  terrain: '<path d="M3 19 9 9.5l3.5 5 2.5-3.5 6 8z"/>',
  trash: '<path d="M4 7h16M9.5 4h5M6 7l1 13h10l1-13M10 11v5.5M14 11v5.5"/>',
  upload: '<path d="M12 15V4M7 9l5-5 5 5M5 20h14"/>',
  'zoom-in': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20M8 10.5h5M10.5 8v5"/>',
  'zoom-out': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20M8 10.5h5"/>',
  marker: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.2"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17.5l5-4.5 4 3.5 2.5-2 4.5 3.5"/>',
  segment: '<path d="M3.5 7V3.5H7M10.5 3.5h3M17 3.5h3.5V7M20.5 10.5v3M20.5 17v3.5H17M13.5 20.5h-3M7 20.5H3.5V17M3.5 13.5v-3"/><rect x="8" y="8" width="8" height="8" rx=".5"/>',
  fog: '<path d="M3 8h10M16.5 8H21M3 12h4M10.5 12H21M3 16h8.5M15 16h6"/>',
  dice: '<path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4z"/><path d="M12 7.5 7.5 15h9z"/><path d="M12 2.8v4.7M4 16.6l3.5-1.6M20 16.6 16.5 15"/>',
  '3d': '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  play: '<path d="M7.5 4.5v15l12-7.5z"/>',
  admin: '<path d="M12 3 19 6v5.5c0 4.4-3 7.8-7 9.5-4-1.7-7-5.1-7-9.5V6z"/><path d="M9 12l2 2 4-4"/>',
  notes: '<path d="M6 3.5h8.5l3.5 3.5v13.5H6z"/><path d="M14.5 3.5V7H18M9 11.5h6M9 15h4.5"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>', 'chevron-up': '<path d="M6 15l6-6 6 6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>', 'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>', plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  more: '<circle cx="5.5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18.5" cy="12" r="1"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M15.5 5a3.5 3.5 0 0 1 0 7M18 14.3c2 .8 3.5 2.8 3.5 5.7"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  screen: '<rect x="3" y="4" width="18" height="12.5" rx="1.5"/><path d="M8.5 20h7M12 16.5V20"/>',
  brush: '<path d="M14 4.5 19.5 10l-7 7-5.5-5.5z"/><path d="M7 11.5c-2.5 0-3.5 2-3.5 4V20h4c2 0 3.5-1.3 3.5-3.5"/>',
  rotate: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v4h-4"/>',
  'rotate-ccw': '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4v4h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A7.5 7.5 0 1 1 9.5 4.5a6 6 0 0 0 10 10z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4M12 16.8v.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.01"/>',
  offline: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5v.01M4 4l16 16"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M7 14h10"/>',
  ping: '<circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2"/>',
  skull: '<path d="M12 3.5c-4.4 0-7.5 3-7.5 7 0 2.3 1 3.9 2.5 5V19h2v-1.5h1V19h4v-1.5h1V19h2v-3.5c1.5-1.1 2.5-2.7 2.5-5 0-4-3.1-7-7.5-7z"/><circle cx="9" cy="11" r="1.6"/><circle cx="15" cy="11" r="1.6"/>',
  'shape-rect': '<rect x="4.5" y="6" width="15" height="12" rx=".5"/>',
  'shape-circle': '<circle cx="12" cy="12" r="7.5"/>',
  'shape-oval': '<ellipse cx="12" cy="12" rx="8.5" ry="5.5"/>',
  'shape-triangle': '<path d="M12 4.5 20 19H4z"/>',
  'shape-hexagon': '<path d="M7.7 4.5h8.6L20.5 12l-4.2 7.5H7.7L3.5 12z"/>',
  'shape-octagon': '<path d="M9 4h6l5 5v6l-5 5H9l-5-5V9z"/>',
  'shape-freehand': '<path d="M4.5 15c1.5-6 4-9 6-8s-1.5 6 1 7 3.5-6 5.5-6 1 6-1 8.5"/>'
} as const satisfies Record<string, string>;

export type IconName = keyof typeof ICONS;

/** The design's three groups, in its order (the style guide shows them so). */
export const ICON_GROUPS: { title: string; note: string; icons: IconName[] }[] = [
  {
    title: 'Brand set · 30',
    note: 'Stand-ins until the originals are dropped in',
    icons: ['chat', 'corridor', 'door', 'download', 'eraser', 'eye', 'eye-off', 'fit', 'grid', 'label', 'layers', 'lock', 'unlock', 'pan', 'pillar', 'polygon', 'prop', 'redo', 'undo', 'room', 'select', 'send', 'settings', 'stairs', 'stop', 'terrain', 'trash', 'upload', 'zoom-in', 'zoom-out'],
  },
  {
    title: 'New for Delve · 9',
    note: 'marker, image, segment, fog, dice, 3D, play, admin, notes',
    icons: ['marker', 'image', 'segment', 'fog', 'dice', '3d', 'play', 'admin', 'notes'],
  },
  {
    title: 'Utility and room shapes',
    note: 'Chevrons, actions, status and the seven Room tool shapes',
    icons: ['shape-rect', 'shape-circle', 'shape-oval', 'shape-triangle', 'shape-hexagon', 'shape-octagon', 'shape-freehand', 'chevron-down', 'chevron-right', 'x', 'plus', 'minus', 'search', 'check', 'more', 'users', 'link', 'screen', 'brush', 'rotate', 'rotate-ccw', 'copy', 'external', 'alert', 'info', 'offline', 'keyboard', 'ping', 'skull', 'sun', 'moon'],
  },
];

export interface IconOptions {
  /** Width and height in px (default 18). */
  size?: number;
  /** Stroke width (default 1.7). */
  stroke?: number;
  /** An accessible name. Without one the icon is decorative (aria-hidden). */
  label?: string;
  /** Extra classes after "icon". */
  className?: string;
}

const attr = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** An inline SVG icon. Every icon has class "icon", so CSS can size or colour it. */
export function icon(name: IconName, o: IconOptions = {}): string {
  const size = o.size ?? 18;
  const a11y = o.label ? `role="img" aria-label="${attr(o.label)}"` : 'aria-hidden="true"';
  const cls = o.className ? `icon ${attr(o.className)}` : 'icon';
  return `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${o.stroke ?? 1.7}" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${ICONS[name]}</svg>`;
}
