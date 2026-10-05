// The handout page's table: the sheet lies on a wooden table lit by a candle
// standing beside it (top right). Page display only: printing, the PNG, SVG
// and PDF downloads stay the plain sheet.
//
// - The wood is drawn once on a canvas in code (planks with grain, knots and
//   seams from a fixed seed; no image files), again only when the page's size
//   changes.
// - The candle is drawn in code too (SVG: a brass holder, the wax with drips,
//   the wick; the flame and its halo are layers of their own).
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

// The candle in a three-quarter view, 96 × 168 (the flame and halo are separate layers, see FLAME_SVG).
const CANDLE_SVG = `<svg class="candle-art" viewBox="0 0 96 168" width="96" height="168">
  <defs>
    <radialGradient id="cd-contact" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#000" stop-opacity=".55"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
    <linearGradient id="cd-brass" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#5a3c14"/><stop offset=".3" stop-color="#b8862f"/><stop offset=".55" stop-color="#f0cf7a"/><stop offset=".75" stop-color="#b8862f"/><stop offset="1" stop-color="#4a3010"/></linearGradient>
    <radialGradient id="cd-dish" cx="62%" cy="30%" r="75%"><stop offset="0" stop-color="#f6dc93"/><stop offset=".45" stop-color="#c79a42"/><stop offset="1" stop-color="#6b4818"/></radialGradient>
    <linearGradient id="cd-wax" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#b9a47c"/><stop offset=".35" stop-color="#efe3c4"/><stop offset=".62" stop-color="#fbf3dd"/><stop offset="1" stop-color="#cbb790"/></linearGradient>
    <linearGradient id="cd-glow" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ffcf7a" stop-opacity=".55"/><stop offset="1" stop-color="#ffcf7a" stop-opacity="0"/></linearGradient>
    <radialGradient id="cd-pool" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#fff2c8"/><stop offset=".7" stop-color="#f3dca3"/><stop offset="1" stop-color="#d8c08c"/></radialGradient>
  </defs>
  <ellipse cx="50" cy="152" rx="46" ry="12" fill="url(#cd-contact)"/>
  <!-- the holder: a dish with a rim and a ring handle -->
  <path d="M88 132c4 7-14 16-40 16S4 139 8 132" fill="#4a3010"/>
  <ellipse cx="48" cy="132" rx="40" ry="12" fill="url(#cd-brass)"/>
  <ellipse cx="48" cy="130.5" rx="36" ry="9.5" fill="url(#cd-dish)"/>
  <path d="M84 128c9-2 12 3 9 7s-9 4-11 2" fill="none" stroke="#7a5420" stroke-width="3.2" stroke-linecap="round"/>
  <path d="M84 128c9-2 12 3 9 7" fill="none" stroke="#f0cf7a" stroke-width="1.1" stroke-linecap="round" opacity=".8"/>
  <!-- the socket the candle stands in -->
  <path d="M30 127v-7c0-3 8-4.5 18-4.5s18 1.5 18 4.5v7c0 3-8 4.5-18 4.5s-18-1.5-18-4.5z" fill="url(#cd-brass)"/>
  <ellipse cx="48" cy="120" rx="18" ry="4.5" fill="#d8ae58"/>
  <!-- the wax, a little worn down, with drips -->
  <path d="M33 120V58c0-2.5 6.7-4.5 15-4.5S63 55.5 63 58v62c0 2.2-6.7 4-15 4s-15-1.8-15-4z" fill="url(#cd-wax)"/>
  <path d="M33 58c0 2.6 6.7 4.6 15 4.6S63 60.6 63 58v14c0 2.6-6.7 4.6-15 4.6S33 74.6 33 72z" fill="url(#cd-glow)"/>
  <ellipse cx="48" cy="58" rx="15" ry="4.4" fill="url(#cd-pool)"/>
  <path d="M34.5 59.5c-.5 6 .3 11 2.2 12.6 1.7 1.4 3.2-.4 3-4.6l-.3-6.3z" fill="#f7eed6"/>
  <path d="M44 62.3c-.4 9 .2 19.5 2.2 22.2 1.8 2.3 3.6.3 3.4-5.2-.2-6.4-.4-11.6-.5-17z" fill="#fbf4e2"/>
  <path d="M56.5 61.6c.2 5.5.9 9.3 2.6 10.3 1.6 1 2.6-1 2.2-4.4l-.5-6.7z" fill="#f4e9cf"/>
  <path d="M60.8 59.5c.6 14 1.6 33 .7 41.5-.4 3.4-2.6 3.8-3.2.6-.9-4.6-.6-17.8-.5-25" fill="#e9dcbc" opacity=".85"/>
  <path d="M35 64c.4 12-.4 24 .5 34" fill="none" stroke="#fff8e8" stroke-width="1.4" stroke-linecap="round" opacity=".45"/>
  <!-- the wick -->
  <path d="M48 58.5c0-2.6.5-4.6 1.7-6.8" fill="none" stroke="#1d130b" stroke-width="1.7" stroke-linecap="round"/>
</svg>`;

// The flame: a teardrop in warm layers with a bluish foot, drawn upright around the wick's tip.
const FLAME_SVG = `<svg viewBox="0 0 30 56" width="30" height="56">
  <defs>
    <radialGradient id="fl-outer" cx="50%" cy="72%" r="62%"><stop offset="0" stop-color="#fff6d5"/><stop offset=".35" stop-color="#ffd86e"/><stop offset=".75" stop-color="#ff9a2e" stop-opacity=".85"/><stop offset="1" stop-color="#ff7a1a" stop-opacity="0"/></radialGradient>
    <radialGradient id="fl-core" cx="50%" cy="70%" r="55%"><stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#fff3c2"/><stop offset="1" stop-color="#ffe08a" stop-opacity="0"/></radialGradient>
  </defs>
  <path d="M15 2C10 14 4.5 24 4.5 35.5 4.5 45 9 52 15 52s10.5-7 10.5-16.5C25.5 24 20 14 15 2z" fill="url(#fl-outer)"/>
  <path d="M15 17c-3 7.5-5.8 14-5.8 21 0 5.5 2.6 9.5 5.8 9.5s5.8-4 5.8-9.5c0-7-2.8-13.5-5.8-21z" fill="url(#fl-core)"/>
  <ellipse cx="15" cy="48.5" rx="3" ry="2.4" fill="#7fa6ff" opacity=".4"/>
</svg>`;

export const TABLE_CSS = `
  /* the table (handout-table.ts): wood, light and the candle behind and beside the sheet */
  .scene { position: relative; display: grid; min-height: 0; overflow: hidden; background: #2a1a0e; isolation: isolate;
    --fx: 62px; --fy: 40px; }
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
  .candle { position: absolute; z-index: 2; top: 10px; right: 16px; width: 96px; height: 168px; pointer-events: none; }
  .candle-art { position: absolute; inset: 0; display: block; }
  /* the flame stands on the wick's tip (49.7, 51.7 in the candle's drawing) */
  .candle > .flame { position: absolute; left: 34.7px; top: 2px; width: 30px; height: 56px; transform-origin: 50% 90%; will-change: transform; }
  .candle > .flame svg { display: block; }
  .candle > .halo { position: absolute; left: 4px; top: -14px; width: 92px; height: 92px; border-radius: 50%; will-change: opacity, transform;
    background: radial-gradient(circle closest-side, rgba(255, 214, 140, .62) 0, rgba(255, 190, 100, .28) 40%, rgba(255, 170, 80, 0) 100%); }
  /* the flicker: transform and opacity only, out of step with each other */
  @media (prefers-reduced-motion: no-preference) {
    .candle > .flame { animation: hd-flame 2.3s ease-in-out infinite; }
    .candle > .halo { animation: hd-halo 3.1s ease-in-out infinite; }
    .scene > .pool { animation: hd-pool 3.7s ease-in-out infinite; }
    .sheet-light > .warm { animation: hd-warm 2.9s ease-in-out infinite; }
  }
  @keyframes hd-flame {
    0%, 100% { transform: scale(1, 1) skewX(0deg); }
    14% { transform: scale(.96, 1.05) skewX(-2.5deg); }
    29% { transform: scale(1.03, .97) skewX(1.5deg); }
    47% { transform: scale(.98, 1.03) skewX(-1deg); }
    63% { transform: scale(1.02, .95) skewX(2.5deg); }
    81% { transform: scale(.97, 1.04) skewX(-1.5deg); }
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
    .scene > .table { padding: 112px 14px 20px; }
    .scene { --fx: 42px; --fy: 26px; }
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
