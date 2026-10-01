/* <delve-map> — ink-on-parchment dungeon renderer with pan/zoom (demo data: The Sunken Abbey, storey 0).
   attrs: view="gm|players" grid="on|off" selected="r3" ghost="room" rough="1-10" zoom="1" focus="x,y" focus-at="0.5,0.5" static fog-opacity tokens="on"
   <delve-prop kind="barrel" size="44"> — one prop glyph from the same library. */
(function () {
  const C = 32, INK = '#2B241D', HATCH = '#4A3F33', FLOOR = '#F4ECD7', PARCH = '#EADCBB', SEL = '#4F40A6';
  const MK = { discover: '#D9961A', interact: '#2F7FD1', trap: '#C43A2F' };
  let uid = 0;
  const rng = s => () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const SHAPES = [
    { id: 'r1', n: 1, t: 'rect', x: 3, y: 10, w: 6, h: 6, lx: 6, ly: 12.4 },
    { id: 'c1', t: 'rect', x: 8.85, y: 12, w: 5.3, h: 2 },
    { id: 'r2', n: 2, t: 'rect', x: 14, y: 8, w: 14, h: 10, lx: 15.2, ly: 9.3 },
    { id: 'c2', t: 'rect', x: 27.85, y: 12, w: 2.45, h: 2 },
    { id: 'r3', n: 3, t: 'oct', cx: 34.5, cy: 13, r: 4.5, lx: 32.2, ly: 10.2 },
    { id: 'c3', t: 'rect', x: 20, y: 17.85, w: 2, h: 2.2 },
    { id: 'r4', n: 4, t: 'circle', cx: 21, cy: 22.8, r: 3, lx: 19.1, ly: 20.9 },
    { id: 'c4', t: 'rect', x: 33.5, y: 17.3, w: 2, h: 2.85 },
    { id: 'r5', n: 5, t: 'rect', x: 31, y: 20, w: 8, h: 5, lx: 32.2, ly: 23.9 },
    { id: 'c5', t: 'rect', x: 17, y: 5.85, w: 2, h: 2.3 },
    { id: 'r6', n: 6, t: 'rect', x: 15.5, y: 2, w: 5, h: 4, lx: 19.6, ly: 3 },
    { id: 'c6', t: 'rect', x: 24, y: 5.85, w: 2, h: 2.3 },
    { id: 'r7', n: 7, t: 'rect', x: 22.5, y: 2, w: 5, h: 4, lx: 26.6, ly: 3 }
  ];
  const UNEXPLORED = ['r5', 'c4', 'r7', 'c6'];
  const DOORS = [[9, 13, 'v'], [14, 13, 'v'], [30, 13, 'v'], [21, 18, 'h'], [34.5, 20, 'h'], [18, 6, 'h'], [25, 6, 'h', 'secret']];
  const PROPS = [
    ['barrel', 4, 11, 0], ['barrel', 4.85, 11.05, 0], ['barrel', 4.4, 11.8, 0], ['crate', 4.2, 14.9, 12], ['rubble', 7.8, 15, 0],
    ['bench', 17.2, 13, 90], ['bench', 18.4, 13, 90], ['bench', 19.6, 13, 90], ['bench', 20.8, 13, 90], ['bench', 22, 13, 90], ['bench', 23.2, 13, 90],
    ['altar', 26.7, 13, 0], ['brazier', 26.6, 10.4, 0], ['brazier', 26.6, 15.6, 0],
    ['roundtable', 34.5, 13, 0], ['chair', 34.5, 11.35, 0], ['chair', 34.5, 14.65, 180], ['chair', 33.05, 12.2, -60], ['chair', 35.95, 12.2, 60], ['chair', 33.05, 13.8, -120], ['chair', 35.95, 13.8, 120],
    ['well', 21, 22.8, 0], ['chest', 32.1, 21.1, 0], ['shelf', 33.4, 24.5, 0], ['candle', 37.9, 20.6, 0], ['bones', 34.5, 18.7, 20],
    ['bed', 16.3, 3.1, 0], ['chair', 18.2, 4.9, 0], ['bed', 23.3, 3.1, 0], ['table', 25.7, 2.75, 0], ['candle', 26.9, 2.6, 0], ['rug', 25.4, 4.5, 0]
  ];
  const PILLARS = [16.5, 19.5, 22.5, 25.5].flatMap(x => [[x, 10.8], [x, 15.2]]);
  const MARKERS = [['discover', 23.6, 9.1, 'Loose flagstone'], ['interact', 37.3, 10.6, 'Chapter bell'], ['trap', 35.6, 18.6, 'Needle trap']];
  const P = {
    barrel: '<circle r=".38"/><circle r=".24" fill="none"/><path d="M-.38 0H.38" fill="none"/>',
    crate: '<rect x="-.42" y="-.42" width=".84" height=".84"/><path d="M-.42 -.42L.42 .42M.42 -.42L-.42 .42" fill="none"/>',
    table: '<rect x="-.8" y="-.42" width="1.6" height=".84" rx=".05"/>',
    roundtable: '<circle r=".9"/><circle r=".74" fill="none" stroke-width=".025"/>',
    chair: '<rect x="-.22" y="-.2" width=".44" height=".42" rx=".05"/><path d="M-.24 -.25H.24" fill="none" stroke-width=".09"/>',
    bed: '<rect x="-.45" y="-.9" width=".9" height="1.8" rx=".06"/><rect x="-.32" y="-.8" width=".64" height=".32" rx=".08"/><path d="M-.45 -.3H.45" fill="none"/>',
    bench: '<rect x="-.8" y="-.17" width="1.6" height=".34" rx=".04"/>',
    shelf: '<rect x="-.95" y="-.22" width="1.9" height=".44"/><path d="M-.6 -.22v.44M-.3 -.22v.44M0 -.22v.44M.3 -.22v.44M.6 -.22v.44" fill="none"/>',
    chest: '<rect x="-.45" y="-.3" width=".9" height=".6" rx=".06"/><path d="M-.45 -.08H.45" fill="none"/><circle cy=".03" r=".06" fill="' + INK + '"/>',
    altar: '<rect x="-.42" y="-.95" width=".84" height="1.9"/><rect x="-.28" y="-.8" width=".56" height="1.6" fill="none"/>',
    brazier: '<circle r=".36"/><circle r=".16" fill="' + INK + '"/><path d="M0 -.36V-.52M.31 .18l.14.08M-.31 .18l-.14.08" fill="none"/>',
    statue: '<rect x="-.45" y="-.45" width=".9" height=".9"/><circle r=".27" fill="' + INK + '"/>',
    sarcophagus: '<path d="M-.3 -.9H.3L.42 -.4V.8L.3 .95H-.3L-.42 .8V-.4Z"/><path d="M-.18 -.6H.18" fill="none"/>',
    candle: '<circle r=".13"/><circle r=".04" fill="' + INK + '"/>',
    bones: '<path d="M-.4 -.22L.4 .22M-.4 .22L.4 -.22" fill="none" stroke-width=".1"/><circle cx=".05" cy="-.42" r=".15"/>',
    rubble: '<path d="M-.42 .1L-.2 -.22L.05 -.06L0 .2Z M.1 -.32L.36 -.26L.3 0L.12 -.06Z M.14 .14L.42 .2L.3 .42L.1 .36Z"/>',
    well: '<circle r=".78"/><circle r=".54" fill="#C9D1CA"/><path d="M-1 0H1" fill="none" stroke-width=".09"/>',
    rug: '<rect x="-.9" y="-.55" width="1.8" height="1.1"/><rect x="-.72" y="-.38" width="1.44" height=".76" fill="none" stroke-dasharray=".08 .08" stroke-width=".03"/>',
    pillar: '<circle r=".42" fill="' + INK + '"/>'
  };
  function prop(k, x, y, s, rot) {
    return '<g transform="translate(' + x + ' ' + y + ') rotate(' + (rot || 0) + ') scale(' + s + ')" fill="' + FLOOR + '" stroke="' + INK + '" stroke-width="' + (1.6 / s).toFixed(4) + '" stroke-linejoin="round" stroke-linecap="round">' + (P[k] || '') + '</g>';
  }
  function poly(s) {
    if (s.t === 'rect') return [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]];
    if (s.t === 'oct') { const R = s.r / Math.cos(Math.PI / 8); return [...Array(8)].map((_, k) => { const a = Math.PI / 8 + k * Math.PI / 4; return [s.cx + R * Math.cos(a), s.cy + R * Math.sin(a)]; }); }
    return [...Array(52)].map((_, k) => { const a = k / 52 * Math.PI * 2; return [s.cx + s.r * Math.cos(a), s.cy + s.r * Math.sin(a)]; });
  }
  function rough(p, amp, R) {
    const o = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), n = Math.max(1, Math.round(L / .55)), nx = -dy / L, ny = dx / L;
      for (let j = 0; j < n; j++) { const t = j / n, f = (R() - .5) * amp * (j ? 1 : .4); o.push([a[0] + dx * t + nx * f, a[1] + dy * t + ny * f]); }
    }
    return o;
  }
  const D = p => 'M' + p.map(q => (q[0] * C).toFixed(1) + ' ' + (q[1] * C).toFixed(1)).join('L') + 'Z';
  function hatchTile() {
    const R = rng(11); let s = '';
    for (let i = 0; i < 16; i++) {
      const cx = R() * 48, cy = R() * 48, a = R() * Math.PI, len = 5 + R() * 4.5, n = 3 + (R() > .6 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const off = (k - (n - 1) / 2) * 2.3, ox = Math.cos(a + Math.PI / 2) * off, oy = Math.sin(a + Math.PI / 2) * off, ex = Math.cos(a) * len / 2, ey = Math.sin(a) * len / 2;
        for (const X of [-48, 0, 48]) for (const Y of [-48, 0, 48]) s += 'M' + (cx + ox - ex + X).toFixed(1) + ' ' + (cy + oy - ey + Y).toFixed(1) + 'L' + (cx + ox + ex + X).toFixed(1) + ' ' + (cy + oy + ey + Y).toFixed(1);
      }
    }
    return s;
  }
  const HATCH_D = hatchTile();
  function door(x, y, o, kind) {
    const X = x * C, Y = y * C, w = 9;
    let s = '';
    if (o === 'v') s += '<path d="M' + X + ' ' + (Y - C) + 'V' + (Y - C * .5) + 'M' + X + ' ' + (Y + C * .5) + 'V' + (Y + C) + '" stroke="' + INK + '" stroke-width="' + w + '"/>';
    else s += '<path d="M' + (X - C) + ' ' + Y + 'H' + (X - C * .5) + 'M' + (X + C * .5) + ' ' + Y + 'H' + (X + C) + '" stroke="' + INK + '" stroke-width="' + w + '"/>';
    if (kind === 'secret') return s.replace('M' + (X - C * .5), 'M' + (X - C * .5)) + '<path d="M' + (X - C * .5) + ' ' + Y + 'H' + (X + C * .5) + '" stroke="' + INK + '" stroke-width="' + w + '"/>';
    const rw = o === 'v' ? 13 : C, rh = o === 'v' ? C : 13;
    return s + '<rect x="' + (X - rw / 2) + '" y="' + (Y - rh / 2) + '" width="' + rw + '" height="' + rh + '" fill="' + FLOOR + '" stroke="' + INK + '" stroke-width="2.2"/>';
  }
  function marker(kind, x, y) {
    const X = x * C, Y = y * C, r = 13;
    let g = '';
    if (kind === 'discover') g = '<text x="' + X + '" y="' + (Y + 1) + '" text-anchor="middle" dominant-baseline="central" font-family="Marcellus SC, Georgia, serif" font-size="18" fill="#1F1A15">?</text>';
    else if (kind === 'interact') g = '<text x="' + X + '" y="' + (Y + 1) + '" text-anchor="middle" dominant-baseline="central" font-family="Marcellus SC, Georgia, serif" font-size="18" fill="' + FLOOR + '">!</text>';
    else g = '<g transform="translate(' + (X - 9) + ' ' + (Y - 9.5) + ') scale(.75)" fill="none" stroke="' + FLOOR + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5c-4.4 0-7.5 3-7.5 7 0 2.3 1 3.9 2.5 5V19h2v-1.5h1V19h4v-1.5h1V19h2v-3.5c1.5-1.1 2.5-2.7 2.5-5 0-4-3.1-7-7.5-7z"/><circle cx="9" cy="11" r="1.4" fill="' + FLOOR + '"/><circle cx="15" cy="11" r="1.4" fill="' + FLOOR + '"/></g>';
    return '<g><circle cx="' + X + '" cy="' + (Y + 1.5) + '" r="' + (r + 1) + '" fill="rgba(43,36,29,.25)"/><circle cx="' + X + '" cy="' + Y + '" r="' + r + '" fill="' + MK[kind] + '" stroke="#1F1A15" stroke-width="1.6"/>' + g + '</g>';
  }
  const TOKENS = [
    { x: 16, y: 13, c: '#5B6E8C', i: 'BR', hp: .8, name: 'Brannoc', me: true },
    { x: 15.6, y: 15.8, c: '#7A5A8C', i: 'IS', hp: .45, name: 'Isolde' },
    { x: 12, y: 13, c: '#6C7A4E', i: 'TW', hp: 1, name: 'Tamsin' },
    { x: 24.2, y: 14.6, c: '#8C3B30', i: 'GH', hp: .6, name: 'Ghoul', foe: true }
  ];
  function tokens() {
    return TOKENS.map(t => {
      const X = t.x * C, Y = t.y * C, r = 14;
      return '<g><circle cx="' + X + '" cy="' + (Y + 2) + '" r="' + (r + 1.5) + '" fill="rgba(43,36,29,.3)"/><circle cx="' + X + '" cy="' + Y + '" r="' + r + '" fill="' + t.c + '" stroke="' + (t.foe ? '#C43A2F' : FLOOR) + '" stroke-width="2.5"/>' +
        '<text x="' + X + '" y="' + (Y + .5) + '" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-size="10" font-weight="600" fill="' + FLOOR + '">' + t.i + '</text>' +
        '<rect x="' + (X - 14) + '" y="' + (Y - 22) + '" width="28" height="4" rx="2" fill="rgba(43,36,29,.55)"/><rect x="' + (X - 14) + '" y="' + (Y - 22) + '" width="' + (28 * t.hp) + '" height="4" rx="2" fill="' + (t.hp < .5 ? '#C43A2F' : '#5E8C4A') + '"/>' +
        '<rect x="' + (X - 26) + '" y="' + (Y + 17) + '" width="52" height="14" rx="3" fill="rgba(31,26,21,.78)"/><text x="' + X + '" y="' + (Y + 24.5) + '" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-size="9.5" fill="' + FLOOR + '">' + t.name + '</text>' +
        (t.me ? '<circle cx="' + X + '" cy="' + Y + '" r="' + (r + 5) + '" fill="none" stroke="' + SEL + '" stroke-width="2" stroke-dasharray="4 3"/>' : '') + '</g>';
    }).join('');
  }

  class DelveMap extends HTMLElement {
    static get observedAttributes() { return ['view', 'grid', 'selected', 'ghost', 'rough', 'zoom', 'focus', 'focus-at', 'fog-opacity', 'tokens', 'storey']; }
    constructor() { super(); this.u = 'dm' + (++uid); this.v = null; this.moved = false; }
    connectedCallback() {
      this.style.display = 'block'; this.style.overflow = 'hidden'; this.style.background = PARCH; this.style.touchAction = 'none';
      if (!this.getAttribute('static')) this.style.cursor = 'grab';
      this.render();
      this.ro = new ResizeObserver(() => { if (!this.moved) this.fit(); else this.apply(); }); this.ro.observe(this);
      if (!this.hasAttribute('static')) this.bind();
      this.cmd = e => { const d = e.detail || {}; if (d.id !== this.id) return; if (d.cmd === 'in') this.zoomAt(1.25); if (d.cmd === 'out') this.zoomAt(.8); if (d.cmd === 'fit') { this.moved = false; this.fit(); } };
      window.addEventListener('delve-map-cmd', this.cmd);
    }
    disconnectedCallback() { this.ro && this.ro.disconnect(); window.removeEventListener('delve-map-cmd', this.cmd); }
    attributeChangedCallback(n) { if (!this.isConnected) return; if (n === 'zoom' || n === 'focus' || n === 'focus-at') { this.moved = false; this.fit(); } else this.render(); }
    bind() {
      this.addEventListener('wheel', e => { e.preventDefault(); const r = this.getBoundingClientRect(); this.zoomAt(Math.exp(-e.deltaY * .0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
      let drag = null;
      this.addEventListener('pointerdown', e => { if (e.button !== 0 && e.button !== 1) return; drag = { x: e.clientX, y: e.clientY, tx: this.v.tx, ty: this.v.ty }; this.setPointerCapture(e.pointerId); this.style.cursor = 'grabbing'; });
      this.addEventListener('pointermove', e => { if (!drag) return; this.v.tx = drag.tx + e.clientX - drag.x; this.v.ty = drag.ty + e.clientY - drag.y; this.moved = true; this.apply(); });
      const end = () => { drag = null; this.style.cursor = 'grab'; };
      this.addEventListener('pointerup', end); this.addEventListener('pointercancel', end);
    }
    zoomAt(f, px, py) {
      const W = this.clientWidth, H = this.clientHeight; if (px == null) { px = W / 2; py = H / 2; }
      const k = Math.min(3, Math.max(.2, this.v.k * f)), r = k / this.v.k;
      this.v.tx = px - (px - this.v.tx) * r; this.v.ty = py - (py - this.v.ty) * r; this.v.k = k; this.moved = true; this.apply();
    }
    fit() {
      const W = this.clientWidth || 800, H = this.clientHeight || 600, mw = 39.5 * C, mh = 26.5 * C;
      let k = Math.min((W - 48) / mw, (H - 48) / mh) * (parseFloat(this.getAttribute('zoom')) || 1);
      const f = (this.getAttribute('focus') || '20.25,13.6').split(',').map(Number), at = (this.getAttribute('focus-at') || '.5,.5').split(',').map(Number);
      this.v = { k, tx: W * at[0] - f[0] * C * k, ty: H * at[1] - f[1] * C * k };
      this.apply();
    }
    apply() {
      if (!this.v) return;
      const g = this.sr && this.sr.querySelector('[data-vp]'); if (g) g.setAttribute('transform', 'translate(' + this.v.tx.toFixed(1) + ' ' + this.v.ty.toFixed(1) + ') scale(' + this.v.k.toFixed(4) + ')');
      this.overlay();
      window.dispatchEvent(new CustomEvent('delve-map-zoom', { detail: { id: this.id, pct: Math.round(this.v.k * 100) } }));
    }
    overlay() {
      const o = this.sr && this.sr.querySelector('[data-ov]'); if (!o || !this.v) return;
      const { k, tx, ty } = this.v, sx = x => tx + x * C * k, sy = y => ty + y * C * k;
      let s = '';
      const sel = this.getAttribute('selected');
      if (sel === 'r3') {
        const x0 = sx(29.65), y0 = sy(8.15), x1 = sx(39.35), y1 = sy(17.85), mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        s += '<rect x="' + x0 + '" y="' + y0 + '" width="' + (x1 - x0) + '" height="' + (y1 - y0) + '" fill="rgba(79,64,166,.06)" stroke="' + SEL + '" stroke-width="1.5" stroke-dasharray="6 4"/>';
        s += '<path d="M' + mx + ' ' + y0 + 'V' + (y0 - 22) + '" stroke="' + SEL + '" stroke-width="1.5"/><circle cx="' + mx + '" cy="' + (y0 - 26) + '" r="5" fill="' + FLOOR + '" stroke="' + SEL + '" stroke-width="1.5"/>';
        [[x0, y0], [mx, y0], [x1, y0], [x1, my], [x1, y1], [mx, y1], [x0, y1], [x0, my]].forEach(p => { s += '<rect x="' + (p[0] - 4.5) + '" y="' + (p[1] - 4.5) + '" width="9" height="9" rx="1.5" fill="' + FLOOR + '" stroke="' + SEL + '" stroke-width="1.5"/>'; });
        s += '<g transform="translate(' + mx + ' ' + (y1 + 18) + ')"><rect x="-58" y="-11" width="116" height="22" rx="5" fill="' + SEL + '"/><text text-anchor="middle" dominant-baseline="central" y="1" font-family="system-ui,sans-serif" font-size="11.5" fill="' + FLOOR + '">Octagon · 9 × 9 sq</text></g>';
      }
      if (this.getAttribute('ghost') === 'room') {
        const x0 = sx(4), y0 = sy(18.5), x1 = sx(11), y1 = sy(23.5);
        s += '<rect x="' + x0 + '" y="' + y0 + '" width="' + (x1 - x0) + '" height="' + (y1 - y0) + '" fill="rgba(79,64,166,.08)" stroke="' + SEL + '" stroke-width="1.5" stroke-dasharray="6 4"/>';
        s += '<g transform="translate(' + x1 + ' ' + (y1 + 16) + ')"><rect x="-74" y="-11" width="96" height="22" rx="5" fill="' + SEL + '"/><text x="-26" text-anchor="middle" dominant-baseline="central" y="1" font-family="system-ui,sans-serif" font-size="11.5" fill="' + FLOOR + '">7 × 5 · 35 × 25 ft</text></g>';
        s += '<path d="M' + (x1 - 7) + ' ' + y1 + 'h14M' + x1 + ' ' + (y1 - 7) + 'v14" stroke="' + INK + '" stroke-width="1.5"/>';
      }
      o.innerHTML = s;
    }
    render() {
      const u = this.u, gm = this.getAttribute('view') !== 'players', grid = this.getAttribute('grid') !== 'off';
      const amp = (parseFloat(this.getAttribute('rough')) || 4) * .016, R = rng(42);
      const paths = SHAPES.map(s => ({ s, d: D(rough(poly(s), amp, R)) }));
      const all = paths.map(p => '<path d="' + p.d + '"/>').join('');
      const fogO = parseFloat(this.getAttribute('fog-opacity') || (gm ? '0' : '.9'));
      const fog = (!gm && fogO > 0) ? '<g fill="rgba(36,31,26,' + fogO + ')" stroke="rgba(36,31,26,' + fogO + ')" stroke-width="46" stroke-linejoin="round">' + paths.filter(p => UNEXPLORED.includes(p.s.id)).map(p => '<path d="' + p.d + '"/>').join('') + '</g>' : '';
      const water = (() => { const p = rough(poly({ t: 'circle', cx: 21, cy: 22.8, r: 2.55 }), .25, rng(5)); return '<path d="' + D(p) + '" fill="rgba(70,108,124,.20)"/><path d="' + D(p) + '" fill="url(#' + u + 'w)"/>'; })();
      const stairs = (() => { const x = 36.4 * C, y = 21 * C, w = 2.2 * C, h = 3.2 * C; let s = '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + FLOOR + '" stroke="' + INK + '" stroke-width="2"/>'; for (let i = 1; i < 8; i++) s += '<path d="M' + x + ' ' + (y + h * i / 8) + 'h' + w + '" stroke="' + INK + '" stroke-width="1.4"/>'; return s + '<path d="M' + (x + w / 2) + ' ' + (y + 10) + 'V' + (y + h - 10) + 'm-5 -7 5 7 5 -7" fill="none" stroke="' + INK + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'; })();
      const nums = SHAPES.filter(s => s.n).map(s => '<text x="' + s.lx * C + '" y="' + s.ly * C + '" text-anchor="middle" dominant-baseline="central" font-family="Marcellus SC, Georgia, serif" font-size="22" fill="' + INK + '">' + s.n + '</text>').join('');
      const deco = '<g font-family="IM Fell English, Georgia, serif" fill="' + INK + '"><text x="' + 2.2 * C + '' + '" y="' + 3.2 * C + '" font-size="40" font-style="italic">The Sunken Abbey</text><path d="M' + 2.3 * C + ' ' + 3.75 * C + 'H' + 11.6 * C + '" stroke="' + INK + '" stroke-width="1.2"/><text x="' + 2.3 * C + '" y="' + 4.55 * C + '" font-family="Marcellus SC, Georgia, serif" font-size="14" letter-spacing="3">' + (this.getAttribute('storey') || 'GROUND · STOREY 0') + '</text></g>' +
        '<g transform="translate(' + 36 * C + ' ' + 4 * C + ')" fill="none" stroke="' + INK + '" stroke-width="1.4"><circle r="30"/><circle r="24" stroke-width=".8"/><path d="M0 -40L7 0 0 40 -7 0Z" fill="' + FLOOR + '"/><path d="M0 -40L7 0H-7Z" fill="' + INK + '"/><path d="M-40 0H-26M26 0H40" /><text y="-46" text-anchor="middle" font-family="Marcellus SC, Georgia, serif" font-size="14" fill="' + INK + '" stroke="none">N</text></g>' +
        '<g transform="translate(' + 3 * C + ' ' + 25 * C + ')" stroke="' + INK + '" fill="' + INK + '"><path d="M0 0H' + 6 * C + 'M0 -5V5M' + 2 * C + ' -4V4M' + 4 * C + ' -4V4M' + 6 * C + ' -5V5" stroke-width="1.4"/><rect x="0" y="-2" width="' + 2 * C + '" height="4" stroke="none"/><rect x="' + 4 * C + '" y="-2" width="' + 2 * C + '" height="4" stroke="none"/><text x="0" y="20" stroke="none" font-family="Marcellus SC, Georgia, serif" font-size="12">0</text><text x="' + 6 * C + '" y="20" text-anchor="end" stroke="none" font-family="Marcellus SC, Georgia, serif" font-size="12">30 FT</text></g>';
      this.sr = this.shadowRoot || this.attachShadow({ mode: 'open' }); this.sr.innerHTML = '<svg width="100%" height="100%" style="display:block;position:absolute;inset:0" aria-label="Map: The Sunken Abbey">' +
        '<defs><pattern id="' + u + 'h" width="48" height="48" patternUnits="userSpaceOnUse"><path d="' + HATCH_D + '" stroke="' + HATCH + '" stroke-width="1.15" stroke-linecap="round" opacity=".8"/></pattern>' +
        '<pattern id="' + u + 'g" width="' + C + '" height="' + C + '" patternUnits="userSpaceOnUse"><path d="M' + C + ' 0H0V' + C + '" fill="none" stroke="rgba(74,63,51,.26)" stroke-width="1"/></pattern>' +
        '<pattern id="' + u + 'w" width="26" height="14" patternUnits="userSpaceOnUse"><path d="M2 5c2.2-2 4.4-2 6.6 0s4.4 2 6.6 0M13 12c2-1.6 4-1.6 6 0" fill="none" stroke="rgba(43,36,29,.42)" stroke-width="1"/></pattern>' +
        '<clipPath id="' + u + 'c">' + all + '</clipPath>' +
        '<filter id="' + u + 'p" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="4"/><feColorMatrix values="0 0 0 0 .32  0 0 0 0 .25  0 0 0 0 .16  0 0 0 .1 0"/></filter>' +
        '<filter id="' + u + 'm" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".006" numOctaves="3" seed="9"/><feColorMatrix values="0 0 0 0 .55  0 0 0 0 .42  0 0 0 0 .25  0 0 0 .55 -.18"/></filter>' +
        '<radialGradient id="' + u + 'v" cx="50%" cy="50%" r="75%"><stop offset="60%" stop-color="#8A6E45" stop-opacity="0"/><stop offset="100%" stop-color="#8A6E45" stop-opacity=".28"/></radialGradient></defs>' +
        '<rect width="100%" height="100%" fill="' + PARCH + '"/><rect width="100%" height="100%" filter="url(#' + u + 'm)"/><rect width="100%" height="100%" filter="url(#' + u + 'p)"/><rect width="100%" height="100%" fill="url(#' + u + 'v)"/>' +
        '<g data-vp="1">' +
        '<g fill="none" stroke="url(#' + u + 'h)" stroke-width="42" stroke-linejoin="round">' + all + '</g>' +
        '<g fill="none" stroke="' + INK + '" stroke-width="9" stroke-linejoin="round">' + all + '</g>' +
        '<g fill="' + FLOOR + '">' + all + '</g>' +
        (grid ? '<rect x="0" y="0" width="' + 42 * C + '" height="' + 28 * C + '" fill="url(#' + u + 'g)" clip-path="url(#' + u + 'c)"/>' : '') +
        water + PILLARS.map(p => prop('pillar', p[0] * C, p[1] * C, C)).join('') +
        DOORS.filter(d => gm || d[3] !== 'secret').map(d => door(d[0], d[1], d[2], d[3])).join('') +
        (gm ? '<text x="' + 25 * C + '" y="' + 6.62 * C + '" text-anchor="middle" font-family="Marcellus SC, Georgia, serif" font-size="11" fill="#FBF6EA">S</text>' : '') +
        stairs + PROPS.map(p => prop(p[0], p[1] * C, p[2] * C, C, p[3])).join('') + nums + deco +
        (gm ? MARKERS.map(m => marker(m[0], m[1], m[2])).join('') : '') + fog +
        (this.getAttribute('tokens') === 'on' ? tokens() : '') +
        '</g><g data-ov="1"></g></svg>';
      if (!this.v || !this.moved) this.fit(); else this.apply();
    }
  }
  class DelveProp extends HTMLElement {
    static get observedAttributes() { return ['kind', 'size']; }
    connectedCallback() { this.r(); }
    attributeChangedCallback() { if (this.isConnected) this.r(); }
    r() { const k = this.getAttribute('kind'), s = +this.getAttribute('size') || 44; this.style.display = 'block'; this.style.width = s + 'px'; this.style.height = s + 'px'; (this.shadowRoot || this.attachShadow({ mode: 'open' })).innerHTML = '<svg width="' + s + '" height="' + s + '" aria-hidden="true">' + prop(k, s / 2, s / 2, s / 2.3, 0) + '</svg>'; }
  }
  if (!customElements.get('delve-map')) customElements.define('delve-map', DelveMap);
  if (!customElements.get('delve-prop')) customElements.define('delve-prop', DelveProp);
  window.DelveMapData = { MARKERS, prop };
})();
