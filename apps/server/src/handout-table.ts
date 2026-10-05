// The handout page's table: the sheet lies on a wooden table lit by a candle
// standing beside it (top right). Page display only: printing, the PNG, SVG
// and PDF downloads stay the plain sheet.
//
// - The wood is drawn once on a canvas in code (planks with grain, knots and
//   seams from a fixed seed; no image files), again only when the page's size
//   changes.
// - The candle is drawn in code too, seen from straight above like the map (SVG:
//   a brass dish, the candle's top with drips, the wick; the flame and its halo
//   are layers of their own).
// - The light: a warm pool on the table around the flame, the table dark
//   towards its edges, and a light overlay on the sheet itself (warmer and
//   brighter on the candle's side, darker on the far side), cut to the
//   sheet's torn outline by using the sheet picture as its mask. The sheet
//   throws its shadow away from the candle.
// - The flicker is CSS animation of transform and opacity only (no layout,
//   nothing per frame in script), and stands still with prefers-reduced-motion.
// - "Candle light" in the page's options (localStorage delve-handout-candle)
//   turns the light off for neutral colours: the candle is snuffed and the
//   table evenly lit.
// Every layer is pointer-events: none, so the Notes tool's clicks reach it.

/** The table, its light and the candle, around the page's `.table` (which holds the sheet). */
export function tableScene(table: string): string {
  return `<div class="scene" id="scene">
    <canvas class="wood" id="wood" aria-hidden="true"></canvas>
    <div class="vignette" aria-hidden="true"></div>
    <div class="pool" aria-hidden="true"></div>
    ${table}
    <div class="candle" aria-hidden="true">${CANDLE_SVG}<div class="halo"></div><div class="flame">${FLAME_SVG}</div></div>
  </div>`;
}

/** The light on the sheet: placed over the picture by the script, cut to its outline. */
export const SHEET_LIGHT = '<div class="sheet-light" id="sheet-light" aria-hidden="true"><div class="warm"></div><div class="shade"></div></div>';

/** The option that turns the light off. */
export const CANDLE_OPTION = `<label class="candle-option" for="candle"><span><span class="candle-option-name">Candle light</span><span class="candle-option-hint">Only on this page: prints and downloads are the plain sheet. Off for true colours.</span></span><button class="switch" type="button" role="switch" id="candle" aria-checked="true"></button></label>`;

// The candle seen from straight above, like the map on the table, 120 × 120:
// a brass dish with a ring handle, the socket, the candle's top with its
// melt pool and drips over the rim, and the wick in the middle (60, 60).
// The flame and its halo are separate layers, see FLAME_SVG.
const CANDLE_SVG = `<svg class="candle-art" viewBox="0 0 120 120" width="120" height="120">
  <defs>
    <radialGradient id="cd-contact" cx="50%" cy="50%" r="50%"><stop offset=".72" stop-color="#000" stop-opacity=".5"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
    <radialGradient id="cd-dish" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#8a6224"/><stop offset=".55" stop-color="#c99b45"/><stop offset=".8" stop-color="#f0cf7a"/><stop offset=".9" stop-color="#b8862f"/><stop offset="1" stop-color="#5a3c14"/></radialGradient>
    <radialGradient id="cd-socket" cx="50%" cy="50%" r="50%"><stop offset=".7" stop-color="#d8ae58"/><stop offset=".86" stop-color="#f3d68a"/><stop offset="1" stop-color="#7a5420"/></radialGradient>
    <radialGradient id="cd-wax" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff9e8"/><stop offset=".55" stop-color="#f6ecd2"/><stop offset=".9" stop-color="#e2d2ab"/><stop offset="1" stop-color="#c9b58a"/></radialGradient>
    <radialGradient id="cd-pool" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff4cf"/><stop offset=".6" stop-color="#f8e2a4"/><stop offset="1" stop-color="#e8c97e"/></radialGradient>
  </defs>
  <circle cx="60" cy="61" r="57" fill="url(#cd-contact)"/>
  <!-- the ring handle, then the dish with its rim -->
  <circle cx="14" cy="98" r="9" fill="none" stroke="#5a3c14" stroke-width="5"/>
  <circle cx="14" cy="98" r="9" fill="none" stroke="#e4bd66" stroke-width="2"/>
  <path d="M22 92l10-8" stroke="#8a6224" stroke-width="5" stroke-linecap="round"/>
  <circle cx="60" cy="60" r="44" fill="url(#cd-dish)"/>
  <circle cx="60" cy="60" r="44" fill="none" stroke="#4a3010" stroke-width="1.4"/>
  <circle cx="60" cy="60" r="36" fill="none" stroke="#7a5420" stroke-width="1" opacity=".6"/>
  <!-- the socket the candle stands in -->
  <circle cx="60" cy="60" r="24" fill="url(#cd-socket)"/>
  <!-- wax that ran down onto the dish -->
  <path d="M77 74c5 3 9 4 10 7s-2 4-5 3-5-4-7-7z" fill="#efe2c2"/>
  <path d="M43 76c-3 4-5 8-3 10s4-1 5-4 1-5 0-7z" fill="#f2e7cb"/>
  <!-- the candle's top: wax, the drips over the rim, the melt pool -->
  <circle cx="60" cy="60" r="19" fill="url(#cd-wax)"/>
  <path d="M74 70c3 3 6 6 5 8s-4 1-6-2-2-5-1-6z" fill="#f4e9cd"/>
  <path d="M47 72c-1 4-3 7-1 8s3-2 3-5z" fill="#f7eedb"/>
  <path d="M41 55c-4-1-7 0-7 2s3 3 7 1z" fill="#f2e6c8"/>
  <circle cx="60" cy="60" r="19" fill="none" stroke="#bfa877" stroke-width="1"/>
  <circle cx="60" cy="60" r="12.5" fill="url(#cd-pool)"/>
  <ellipse cx="56" cy="56" rx="5" ry="2.6" fill="#fffdf4" opacity=".7" transform="rotate(-35 56 56)"/>
  <!-- the wick -->
  <circle cx="60" cy="60" r="1.8" fill="#1d130b"/>
</svg>`;

// The flame from above: a bright core in warm layers around the wick, 30 × 30, centred on it.
const FLAME_SVG = `<svg viewBox="0 0 30 30" width="30" height="30">
  <defs>
    <radialGradient id="fl-outer" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffe9a8"/><stop offset=".4" stop-color="#ffc85a" stop-opacity=".9"/><stop offset=".75" stop-color="#ff8f2a" stop-opacity=".45"/><stop offset="1" stop-color="#ff7a1a" stop-opacity="0"/></radialGradient>
    <radialGradient id="fl-core" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#fff6d6"/><stop offset="1" stop-color="#ffe08a" stop-opacity="0"/></radialGradient>
  </defs>
  <circle cx="15" cy="15" r="14" fill="url(#fl-outer)"/>
  <ellipse cx="14.4" cy="14.2" rx="5.6" ry="6.8" fill="url(#fl-core)" transform="rotate(-30 14.4 14.2)"/>
  <circle cx="15" cy="15" r="1.3" fill="#2a1a0e" opacity=".55"/>
</svg>`;

export const TABLE_CSS = `
  /* the table (handout-table.ts): wood, light and the candle behind and beside the sheet */
  .scene { position: relative; display: grid; min-height: 0; overflow: hidden; background: #2a1a0e; isolation: isolate;
    --fx: 76px; --fy: 70px; }
  .scene > .wood, .scene > .vignette, .scene > .pool { position: absolute; pointer-events: none; }
  .scene > .wood { inset: 0; width: 100%; height: 100%; display: block; z-index: 0; }
  /* the light falls off from the flame (top right): dark at the far edges */
  .scene > .vignette { inset: 0; z-index: 0;
    background: radial-gradient(circle farthest-corner at calc(100% - var(--fx)) var(--fy), rgba(20, 8, 0, 0) 0, rgba(16, 7, 1, .12) 22%, rgba(12, 5, 1, .5) 58%, rgba(6, 2, 0, .82) 100%); }
  /* the warm pool around the flame, on the table */
  .scene > .pool { z-index: 0; width: 1500px; height: 1500px; top: calc(var(--fy) - 750px); right: calc(var(--fx) - 750px); border-radius: 50%;
    background: radial-gradient(circle closest-side, rgba(255, 178, 92, .42) 0, rgba(255, 160, 74, .24) 12%, rgba(240, 130, 50, .1) 32%, rgba(220, 110, 40, .03) 55%, rgba(220, 110, 40, 0) 75%);
    mix-blend-mode: screen; will-change: opacity, transform; }
  .scene > .table { position: relative; z-index: 1; background: none; padding: 28px 136px 28px 28px; }
  /* the sheet: its shadow falls away from the candle (to the bottom left) */
  .scene #sheet { filter: drop-shadow(-12px 16px 14px rgba(8, 3, 0, .62)) drop-shadow(-2px 3px 3px rgba(8, 3, 0, .4)); }
  .sheet-light { position: absolute; z-index: 1; pointer-events: none; left: 0; top: 0; width: 0; height: 0;
    -webkit-mask-size: 100% 100%; mask-size: 100% 100%; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; transition: opacity .2s; }
  .sheet-light:not(.is-ready) { display: none; }
  #sheet.loading + .sheet-light { opacity: .55; }
  .sheet-light > div { position: absolute; inset: 0; }
  .sheet-light > .warm { background: radial-gradient(circle farthest-side at 100% 0, rgba(255, 200, 120, .34) 0, rgba(255, 186, 104, .16) 45%, rgba(255, 180, 100, 0) 100%); will-change: opacity; }
  .sheet-light > .shade { background: linear-gradient(225deg, rgba(40, 18, 0, 0) 35%, rgba(30, 12, 0, .2) 75%, rgba(20, 8, 0, .34) 100%); }
  .candle { position: absolute; z-index: 2; top: 10px; right: 16px; width: 120px; height: 120px; pointer-events: none; }
  .candle-art { position: absolute; inset: 0; display: block; }
  /* seen from above, the flame sits on the wick in the candle's middle (60, 60) */
  .candle > .flame { position: absolute; left: 45px; top: 45px; width: 30px; height: 30px; transform-origin: 50% 50%; will-change: transform; }
  .candle > .flame svg { display: block; }
  .candle > .halo { position: absolute; left: 10px; top: 10px; width: 100px; height: 100px; border-radius: 50%; will-change: opacity, transform;
    background: radial-gradient(circle closest-side, rgba(255, 214, 140, .62) 0, rgba(255, 190, 100, .28) 40%, rgba(255, 170, 80, 0) 100%); }
  /* the flicker: transform and opacity only, out of step with each other */
  @media (prefers-reduced-motion: no-preference) {
    .candle > .flame { animation: hd-flame 2.3s ease-in-out infinite; }
    .candle > .halo { animation: hd-halo 3.1s ease-in-out infinite; }
    .scene > .pool { animation: hd-pool 3.7s ease-in-out infinite; }
    .sheet-light > .warm { animation: hd-warm 2.9s ease-in-out infinite; }
  }
  /* from above a flame doesn't sway sideways: it trembles and breathes around the wick */
  @keyframes hd-flame {
    0%, 100% { transform: translate(0, 0) scale(1); }
    17% { transform: translate(.6px, -.8px) scale(1.06, .96); }
    34% { transform: translate(-.5px, .4px) scale(.95, 1.04); }
    52% { transform: translate(.3px, .6px) scale(1.04); }
    69% { transform: translate(-.7px, -.3px) scale(.96); }
    86% { transform: translate(.4px, -.5px) scale(1.03, .97); }
  }
  @keyframes hd-halo { 0%, 100% { opacity: .9; transform: scale(1); } 23% { opacity: 1; transform: scale(1.05); } 51% { opacity: .8; transform: scale(.97); } 76% { opacity: .95; transform: scale(1.02); } }
  @keyframes hd-pool { 0%, 100% { opacity: .92; transform: scale(1); } 19% { opacity: 1; transform: scale(1.015); } 44% { opacity: .84; transform: scale(.99); } 71% { opacity: .97; transform: scale(1.01); } }
  @keyframes hd-warm { 0%, 100% { opacity: .94; } 31% { opacity: 1; } 58% { opacity: .86; } 82% { opacity: .97; } }
  /* candle light off: the candle snuffed, the table evenly lit, the sheet's own colours */
  .scene.is-unlit > .pool, .scene.is-unlit .sheet-light, .scene.is-unlit .candle > .flame, .scene.is-unlit .candle > .halo { display: none; }
  .scene.is-unlit > .vignette { background: radial-gradient(ellipse at 50% 45%, rgba(0, 0, 0, 0) 0, rgba(0, 0, 0, .12) 60%, rgba(0, 0, 0, .38) 100%); }
  .scene.is-unlit #sheet { filter: drop-shadow(0 10px 18px rgba(0, 0, 0, .5)); }
  .candle-option { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; cursor: pointer; }
  .candle-option > span { display: flex; flex-direction: column; gap: 2px; }
  .candle-option-name { font-size: var(--text-md); }
  .candle-option-hint { color: var(--color-text-muted); font-size: var(--text-sm); line-height: 1.45; }
  .candle-option .switch { margin-top: 2px; }
  @media (max-width: 820px) {
    .scene > .table { padding: 100px 14px 20px; }
    .scene { --fx: 51px; --fy: 45px; }
    .candle { top: 4px; right: 10px; transform: scale(.68); transform-origin: 100% 0; }
  }
`;

/** The page script: draws the wood, lays the light over the sheet, and the Candle light switch. */
export const TABLE_SCRIPT = `
(function () {
  var scene = document.getElementById('scene'), wood = document.getElementById('wood');
  var sheet = document.getElementById('sheet'), light = document.getElementById('sheet-light');
  var KEY = 'delve-handout-candle', sw = document.getElementById('candle');
  var lit = true;
  try { lit = localStorage.getItem(KEY) !== 'off'; } catch (e) {}
  function setLit(on) {
    lit = on;
    scene.classList.toggle('is-unlit', !on);
    if (sw) sw.setAttribute('aria-checked', String(on));
  }
  setLit(lit);
  if (sw) sw.addEventListener('click', function () {
    setLit(!lit);
    try { localStorage.setItem(KEY, lit ? 'on' : 'off'); } catch (e) {}
  });

  // the light on the sheet: over the picture, cut to its torn outline (the picture is its mask);
  // placed like the Notes tool's layer, in the table's own (scrolling) box, to the fraction of a pixel
  var table = sheet.parentElement;
  function place() {
    if (!sheet.naturalWidth) return;
    var s = sheet.getBoundingClientRect(), t = table.getBoundingClientRect();
    light.style.left = (s.left - t.left - table.clientLeft + table.scrollLeft) + 'px';
    light.style.top = (s.top - t.top - table.clientTop + table.scrollTop) + 'px';
    light.style.width = s.width + 'px';
    light.style.height = s.height + 'px';
  }
  function masked() {
    if (!sheet.naturalWidth) return;
    var url = 'url("' + sheet.currentSrc + '")';
    light.style.webkitMaskImage = url;
    light.style.maskImage = url;
    light.classList.add('is-ready');
    place();
  }
  sheet.addEventListener('load', masked);
  if (sheet.complete) masked();
  // the sheet moves when the table changes size even where the sheet itself doesn't
  if (window.ResizeObserver) { var ro = new ResizeObserver(place); ro.observe(sheet); ro.observe(table); }
  window.addEventListener('resize', place);

  // ---------- the wood, drawn once per size ----------
  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var drawnAt = '';
  function drawWood() {
    var w = wood.clientWidth, h = wood.clientHeight;
    if (!w || !h) return;
    var k = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(3.2e6 / (w * h)));
    var W = Math.round(w * k), H = Math.round(h * k);
    var key = W + 'x' + H;
    if (key === drawnAt) return;
    drawnAt = key;
    wood.width = W; wood.height = H;
    var g = wood.getContext('2d');
    if (!g) return;
    var r = rng(0x5EED1E);
    var u = k; // canvas pixels per CSS pixel
    var planks = [], y = -r() * 70 * u;
    while (y < H) { var ph = (118 + r() * 46) * u; planks.push({ y: y, h: ph }); y += ph; }
    planks.forEach(function (p) {
      var hue = 22 + r() * 9, sat = 40 + r() * 14, lum = 23 + r() * 8;
      g.fillStyle = 'hsl(' + hue.toFixed(1) + ',' + sat.toFixed(1) + '%,' + lum.toFixed(1) + '%)';
      g.fillRect(0, p.y, W, p.h);
      g.save();
      g.beginPath(); g.rect(0, p.y, W, p.h); g.clip();
      // a broad streak of lighter or darker heartwood along the board
      var streak = g.createLinearGradient(0, p.y, 0, p.y + p.h);
      var at = .2 + r() * .6, tone = r() < .5 ? 'rgba(255,200,140,' : 'rgba(30,12,2,';
      streak.addColorStop(0, tone + '0)'); streak.addColorStop(at, tone + (.06 + r() * .08).toFixed(3) + ')'); streak.addColorStop(1, tone + '0)');
      g.fillStyle = streak; g.fillRect(0, p.y, W, p.h);
      var knots = [], nk = r() < .6 ? (r() < .35 ? 2 : 1) : 0;
      for (var i = 0; i < nk; i++) knots.push({ x: r() * W, y: p.y + p.h * (.28 + r() * .44), r: (7 + r() * 9) * u });
      var lines = Math.round(p.h / (2.4 * u));
      for (var l = 0; l < lines; l++) {
        var base = p.y + (l + r() * .7) * p.h / lines;
        var dark = r() < .64;
        g.strokeStyle = dark ? 'rgba(38,17,5,' + (.07 + r() * .24).toFixed(3) + ')' : 'rgba(255,212,160,' + (.025 + r() * .07).toFixed(3) + ')';
        g.lineWidth = (.45 + r() * (r() < .12 ? 2.6 : 1.3)) * u;
        var f1 = (.0016 + r() * .0035) / u, f2 = (.009 + r() * .012) / u, a1 = (2.5 + r() * 6) * u, a2 = (.3 + r() * 1.1) * u;
        var p1 = r() * 6.283, p2 = r() * 6.283, step = 7 * u;
        g.beginPath();
        for (var x = -step; x <= W + step; x += step) {
          var yy = base + Math.sin(x * f1 + p1) * a1 + Math.sin(x * f2 + p2) * a2;
          for (var q = 0; q < knots.length; q++) {
            var kn = knots[q], dx = (x - kn.x) / (kn.r * 3.4), dy = yy - kn.y;
            var push = kn.r * 2.3 * Math.exp(-dx * dx) * Math.exp(-(dy * dy) / (kn.r * kn.r * 10));
            yy += dy >= 0 ? push : -push;
          }
          if (x === -step) g.moveTo(x, yy); else g.lineTo(x, yy);
        }
        g.stroke();
      }
      knots.forEach(function (kn) {
        var grad = g.createRadialGradient(kn.x, kn.y, 0, kn.x, kn.y, kn.r * 1.8);
        grad.addColorStop(0, 'rgba(26,11,3,.9)'); grad.addColorStop(.4, 'rgba(48,22,7,.55)'); grad.addColorStop(1, 'rgba(48,22,7,0)');
        g.fillStyle = grad;
        g.beginPath(); g.ellipse(kn.x, kn.y, kn.r * 2, kn.r * 1.15, 0, 0, 6.2832); g.fill();
        for (var ring = 1; ring <= 4; ring++) {
          g.strokeStyle = 'rgba(28,12,3,' + (.42 - ring * .08).toFixed(2) + ')';
          g.lineWidth = .9 * u;
          g.beginPath(); g.ellipse(kn.x, kn.y, kn.r * (.45 + ring * .42) * 1.8, kn.r * (.45 + ring * .42), 0, 0, 6.2832); g.stroke();
        }
      });
      // rounded boards: darker at their edges, a soft highlight under the top edge
      var sh = g.createLinearGradient(0, p.y, 0, p.y + p.h);
      sh.addColorStop(0, 'rgba(0,0,0,.42)'); sh.addColorStop(.05, 'rgba(255,214,160,.07)'); sh.addColorStop(.5, 'rgba(0,0,0,0)'); sh.addColorStop(.92, 'rgba(0,0,0,.1)'); sh.addColorStop(1, 'rgba(0,0,0,.45)');
      g.fillStyle = sh; g.fillRect(0, p.y, W, p.h);
      g.restore();
      // the seam to the board above, and a butt joint where two boards meet end to end
      g.fillStyle = 'rgba(10,4,1,.9)'; g.fillRect(0, p.y - 1.2 * u, W, 2.4 * u);
      g.fillStyle = 'rgba(255,214,160,.08)'; g.fillRect(0, p.y + 1.2 * u, W, u);
      if (r() < .75) {
        var jx = r() * W;
        g.fillStyle = 'rgba(10,4,1,.85)'; g.fillRect(jx, p.y, 2.2 * u, p.h);
        g.fillStyle = 'rgba(255,214,160,.07)'; g.fillRect(jx + 2.2 * u, p.y, u, p.h);
        g.fillStyle = 'rgba(14,6,2,.8)';
        [[-7, .18], [-7, .82], [9, .18], [9, .82]].forEach(function (n) { g.beginPath(); g.arc(jx + n[0] * u, p.y + p.h * n[1], 1.8 * u, 0, 6.2832); g.fill(); });
      }
    });
    // fibre: noise stretched along the boards, laid over softly
    var n = document.createElement('canvas'); n.width = 128; n.height = 128;
    var ng = n.getContext('2d');
    if (ng) {
      var img = ng.createImageData(128, 128);
      for (var i2 = 0; i2 < img.data.length; i2 += 4) { var v = r() * 255; img.data[i2] = v; img.data[i2 + 1] = v; img.data[i2 + 2] = v; img.data[i2 + 3] = 255; }
      ng.putImageData(img, 0, 0);
      g.save();
      g.globalCompositeOperation = 'overlay';
      g.globalAlpha = .14;
      var tw = 128 * 9 * u, th = 128 * .75 * u;
      for (var ty = 0; ty < H; ty += th) for (var tx = -(r() * tw); tx < W; tx += tw) g.drawImage(n, tx, ty, tw, th);
      g.restore();
    }
  }
  var timer = 0;
  function redraw() { clearTimeout(timer); timer = setTimeout(drawWood, 120); }
  drawWood();
  if (window.ResizeObserver) new ResizeObserver(redraw).observe(scene); else window.addEventListener('resize', redraw);
})();
`;
