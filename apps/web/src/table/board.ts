// The table itself: a full-size PixiJS 8 canvas with the page background,
// tokens on their layers, grid lines, selection, bars, name plates and pings.
// World units are cells. Tokens and the background live in scaled containers;
// grid, outlines, bars, names and pings are drawn in screen pixels each frame,
// so they stay crisp at any zoom. Rendering happens on demand, not every frame.
// Input is plain pointer events on the canvas (mouse, pen, touch, pinch).
// Dynamic vision: a darkness mask over the background (black where the party
// has never looked, dimmed where it looked before; for the GM a faint hint),
// drawn on a small canvas from the server's vision messages; the GM also sees
// the doors (click one to open or shut it) and the lights' radii.
import { Application, CanvasSource, Container, Graphics, ImageSource, Sprite, Text, Texture } from 'pixi.js';
import type { Layer, Member, Page, Token, VisionPolygon } from '@delve/table';
import { doorAt, doorLook, fogAlphas, fogResolution, hasFog, overlayLights, type BoardVision } from './vision-view.ts';
import {
  BAR_COLORS,
  backgroundBox,
  backgroundUrl,
  barFraction,
  canMove,
  dragTargets,
  drawOrder,
  fitCamera,
  gridLines,
  gridStep,
  pageBox,
  panBy,
  selectable,
  toScreen,
  toWorld,
  tokenAt,
  visibleBox,
  zoomAt,
  type Box,
  type Camera,
  type DragStart,
} from './logic.ts';

export interface BoardHost {
  me(): Member;
  page(): Page | null;
  /** Tokens on the page, optimistic moves included. */
  tokens(): Token[];
  selection(): ReadonlySet<string>;
  setSelection(ids: string[]): void;
  activeLayer(): Layer;
  /** A drag ended: send these moves. */
  move(moves: { id: string; x: number; y: number }[]): void;
  /** Double-click or double-tap on a token. */
  open(id: string): void;
  /** The pointer was held still: ping here (world cells). */
  ping(x: number, y: number): void;
  /** Which picture of a Delve page to draw: the GM's (everything, fog dimmed) or the players'. */
  backgroundView?(): 'gm' | 'players';
  /** The game, so Delve page pictures come through it (membership checked). */
  gameId?(): string;
  /** Dynamic vision: what the party sees (the last vision message), or null. */
  vision?(): BoardVision | null;
  /** The GM clicked a door of a dynamic-vision page. */
  toggleDoor?(id: string): void;
}

export interface Board {
  /** Redraw after any change to tokens, selection or the page. */
  update(): void;
  /** Show a page; `reload` fetches its background again (it changed on the server). */
  setPage(page: Page | null, reload: boolean): void;
  showPing(x: number, y: number, color: string): void;
  fit(): void;
  zoom(factor: number): void;
  /** The world point at the middle of the view. */
  centre(): [number, number];
  /** Pan so a world point is in the middle. */
  focus(x: number, y: number): void;
  /** Page coordinates (cells) under a point on the screen, and back (for the GM markers' note box). */
  toWorld(clientX: number, clientY: number): [number, number];
  toClient(x: number, y: number): [number, number];
  pxPerCell(): number;
  /** Called after every redraw: the view may have moved. */
  onView(cb: () => void): void;
  /** The theme changed: re-read the colours. */
  retheme(): void;
  /** A vision message came, or the GM switched between their view and the players': redraw the darkness. */
  visionChanged(): void;
  /** Fetch the page picture again (the explored fog grew), keeping the old one until the new one is in. */
  reloadBackground(): void;
}

interface TokenGfx {
  root: Container;
  sprite: Sprite;
  placeholder: Graphics;
  url: string;
}

interface Ping {
  x: number;
  y: number;
  color: string;
  start: number;
}

type Gesture =
  | { kind: 'press'; pointer: number; sx: number; sy: number; wx: number; wy: number; hit: string | null; toggled: boolean; touch: boolean; door?: string }
  | { kind: 'drag'; pointer: number; wx: number; wy: number; lead: string; starts: DragStart[] }
  | { kind: 'pan'; pointer: number; lastX: number; lastY: number }
  | { kind: 'pinch'; a: number; b: number; cam: Camera; dist: number; mx: number; my: number }
  | { kind: 'done' };

const PING_MS = 1600;
const HOLD_MS = 600;
const SVG_PX = 512; // raster size of a prop SVG's longer side

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error(`could not load ${url}`));
    img.src = url;
  });
}

export async function createBoard(stage: HTMLElement, host: BoardHost): Promise<Board> {
  const app = new Application();
  await app.init({
    width: Math.max(1, stage.clientWidth),
    height: Math.max(1, stage.clientHeight),
    background: cssVar('--table-bg', '#20252c'),
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    autoStart: false,
    preference: 'webgl',
    // our own pointer handling does the hit-testing
    eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
  });
  const canvas = app.canvas;
  canvas.id = 'board';
  stage.prepend(canvas);

  const gl = (app.renderer as unknown as { gl?: WebGLRenderingContext }).gl;
  const maxTex = Math.min(16384, (gl?.getParameter(gl.MAX_TEXTURE_SIZE) as number | undefined) ?? 4096);

  // ---------- scene graph (draw order: background, map tokens, grid, tokens, gm, overlay, pings) ----------

  const low = new Container();
  const pageFill = new Graphics();
  const bgSprite = new Sprite(Texture.EMPTY);
  bgSprite.visible = false;
  const mapLayer = new Container();
  low.addChild(pageFill, bgSprite, mapLayer);
  const gridG = new Graphics();
  const high = new Container();
  const tokenLayer = new Container();
  const gmLayer = new Container();
  gmLayer.alpha = 0.5;
  high.addChild(tokenLayer, gmLayer);
  const overlay = new Graphics();
  const names = new Container();
  const pingsG = new Graphics();
  // dynamic vision: the darkness (world space, over the background and grid, under the tokens), then the GM's doors and lights (screen space)
  const fogLayer = new Container();
  const fogSprite = new Sprite(Texture.EMPTY);
  fogSprite.visible = false;
  fogLayer.addChild(fogSprite);
  const visionG = new Graphics();
  app.stage.addChild(low, gridG, fogLayer, visionG, high, overlay, names, pingsG);
  app.stage.eventMode = 'none';
  const layerOf: Record<Layer, Container> = { map: mapLayer, tokens: tokenLayer, gm: gmLayer };

  let colors = { page: '#EFEAE2', grid: '#1B1F24', empty: '#8A8F96' };
  const readColors = () => {
    colors = { page: cssVar('--page-bg', '#EFEAE2'), grid: cssVar('--grid-ink', '#1B1F24'), empty: cssVar('--muted', '#8A8F96') };
    app.renderer.background.color = cssVar('--table-bg', '#20252c');
  };
  readColors();

  let cam: Camera = { x: 0, y: 0, scale: 40 };
  let page: Page | null = null;
  // where each page was left, keyed by id and shape: ids can come back for a new page after a delete
  const cams = new Map<string, Camera>();
  const camKey = (p: Page): string => JSON.stringify([p.id, p.width, p.height, p.origin, p.background]);
  let hovered: string | null = null;
  const dragPos = new Map<string, { x: number; y: number }>();
  const pings: Ping[] = [];
  const gfx = new Map<string, TokenGfx>();
  const plates = new Map<string, { box: Container; plate: Graphics; text: Text; name: string }>();

  // ---------- textures ----------

  const textures = new Map<string, Texture | 'loading' | 'failed'>();
  const waiting = new Map<string, Set<() => void>>();

  /** A texture for a picture URL, plus the picture's own pixel size (the texture may be smaller). */
  async function makeTexture(url: string): Promise<{ tex: Texture; w: number; h: number }> {
    const img = await loadImage(url);
    await img.decode().catch(() => {});
    const svg = /\.svg(\?|$)/i.test(url);
    const nw = img.naturalWidth || SVG_PX;
    const nh = img.naturalHeight || SVG_PX;
    let w = nw;
    let h = nh;
    if (svg || Math.max(w, h) > maxTex) {
      // SVGs are rasterised big enough to stay sharp; huge pictures shrink to what the GPU takes
      const target = svg ? SVG_PX : maxTex;
      const k = target / Math.max(w, h);
      w = Math.max(1, Math.round(w * k));
      h = Math.max(1, Math.round(h * k));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d')?.drawImage(img, 0, 0, w, h);
      return { tex: new Texture({ source: new CanvasSource({ resource: c, autoGenerateMipmaps: true, scaleMode: 'linear' }) }), w: nw, h: nh };
    }
    return { tex: new Texture({ source: new ImageSource({ resource: img, autoGenerateMipmaps: true, scaleMode: 'linear' }) }), w: nw, h: nh };
  }

  /** The texture for a URL, or null while it loads (then `ready` runs) or if it failed. */
  function texture(url: string, ready: () => void): Texture | null {
    const t = textures.get(url);
    if (t instanceof Texture) return t;
    if (t === 'failed') return null;
    const list = waiting.get(url) ?? new Set();
    list.add(ready);
    waiting.set(url, list);
    if (t === 'loading') return null;
    textures.set(url, 'loading');
    makeTexture(url)
      .then(({ tex }) => textures.set(url, tex))
      .catch(() => textures.set(url, 'failed'))
      .finally(() => {
        const cbs = waiting.get(url) ?? new Set();
        waiting.delete(url);
        cbs.forEach((f) => f());
      });
    return null;
  }

  // ---------- background ----------

  let bgSerial = 0;
  let bgTexture: Texture | null = null;
  function loadBackground(reload: boolean): void {
    const serial = ++bgSerial;
    const url = page ? backgroundUrl(page, reload ? Date.now() : 0, host.backgroundView?.() ?? 'players', host.gameId?.()) : null;
    // another picture: drop the old one now; the same one again: keep it until the new copy is in
    if (!reload) bgSprite.visible = false;
    drawPageFill();
    if (!url || !page) {
      bgSprite.visible = false;
      requestRender();
      return;
    }
    const p = page;
    makeTexture(url)
      .then(({ tex, w, h }) => {
        if (serial !== bgSerial) return tex.destroy(true);
        bgTexture?.destroy(true);
        bgTexture = tex;
        const bgBox = backgroundBox(p, w, h);
        bgSprite.texture = tex;
        bgSprite.position.set(bgBox.x0, bgBox.y0);
        bgSprite.width = bgBox.x1 - bgBox.x0;
        bgSprite.height = bgBox.y1 - bgBox.y0;
        bgSprite.visible = true;
        drawPageFill();
        requestRender();
      })
      .catch(() => {
        if (serial === bgSerial) requestRender();
      });
  }

  function drawPageFill(): void {
    pageFill.clear();
    if (!page) return;
    const b = pageBox(page);
    // a blank page gets paper; a picture page a quiet frame until the picture is in
    const blank = page.background.kind === 'none';
    pageFill.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0).fill({ color: blank ? colors.page : colors.empty, alpha: blank ? 1 : bgSprite.visible ? 0 : 0.25 });
  }

  // ---------- tokens ----------

  const displayTokens = (): Token[] => host.tokens().map((t) => {
    const d = dragPos.get(t.id);
    return d ? { ...t, x: d.x, y: d.y } : t;
  });

  function drawPlaceholder(g: Graphics, t: Token): void {
    const r = Math.min(t.w, t.h) * 0.18;
    g.clear()
      .roundRect(-t.w / 2 + 0.04, -t.h / 2 + 0.04, t.w - 0.08, t.h - 0.08, r)
      .fill({ color: colors.empty, alpha: 0.55 })
      .stroke({ width: 0.04, color: '#FFFFFF', alpha: 0.7 });
  }

  function syncTokens(list: Token[]): void {
    const seen = new Set<string>();
    for (const c of Object.values(layerOf)) c.removeChildren();
    for (const t of drawOrder(list)) {
      seen.add(t.id);
      let g = gfx.get(t.id);
      if (!g) {
        const root = new Container();
        const sprite = new Sprite(Texture.EMPTY);
        sprite.anchor.set(0.5);
        const placeholder = new Graphics();
        root.addChild(placeholder, sprite);
        g = { root, sprite, placeholder, url: '' };
        gfx.set(t.id, g);
      }
      layerOf[t.layer].addChild(g.root);
      g.root.position.set(t.x + t.w / 2, t.y + t.h / 2);
      g.root.rotation = ((t.rotation ?? 0) * Math.PI) / 180;
      const tex = t.image ? texture(t.image, requestRender) : null;
      g.url = t.image;
      if (tex) {
        g.sprite.texture = tex;
        g.sprite.visible = true;
        g.sprite.width = t.w;
        g.sprite.height = t.h;
        g.placeholder.visible = false;
      } else {
        g.sprite.visible = false;
        g.placeholder.visible = true;
        drawPlaceholder(g.placeholder, t);
      }
    }
    for (const [id, g] of gfx) {
      if (seen.has(id)) continue;
      g.root.destroy({ children: true });
      gfx.delete(id);
    }
  }

  // ---------- screen-space overlay ----------

  const vw = () => app.renderer.width / app.renderer.resolution;
  const vh = () => app.renderer.height / app.renderer.resolution;

  function drawGrid(): void {
    gridG.clear();
    if (!page?.showGrid) return;
    const step = gridStep(cam.scale);
    const { xs, ys } = gridLines(pageBox(page), visibleBox(cam, vw(), vh()), step);
    const b = pageBox(page);
    const [px0, py0] = toScreen(cam, b.x0, b.y0);
    const [px1, py1] = toScreen(cam, b.x1, b.y1);
    for (const x of xs) {
      const sx = Math.round(toScreen(cam, x, 0)[0]) + 0.5;
      gridG.moveTo(sx, Math.max(py0, 0)).lineTo(sx, Math.min(py1, vh()));
    }
    for (const y of ys) {
      const sy = Math.round(toScreen(cam, 0, y)[1]) + 0.5;
      gridG.moveTo(Math.max(px0, 0), sy).lineTo(Math.min(px1, vw()), sy);
    }
    // pictures (Delve maps are parchment) get dark ink; a blank page follows the theme
    const blank = page.background.kind === 'none';
    gridG.stroke({ width: 1, color: blank ? colors.grid : '#1B1F24', alpha: (step === 1 ? 0.18 : 0.28) * (blank ? 1.2 : 1) });
  }

  /** The token's four corners on screen, turned with it. */
  function corners(t: Token, grow = 0): number[] {
    const [cx, cy] = toScreen(cam, t.x + t.w / 2, t.y + t.h / 2);
    const hw = (t.w * cam.scale) / 2 + grow;
    const hh = (t.h * cam.scale) / 2 + grow;
    const a = ((t.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].flatMap(([x, y]) => [cx + x! * cos - y! * sin, cy + x! * sin + y! * cos]);
  }

  function screenBox(t: Token): Box {
    const c = corners(t);
    const xs = c.filter((_v, i) => i % 2 === 0);
    const ys = c.filter((_v, i) => i % 2 === 1);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }

  function drawOverlay(list: Token[]): void {
    overlay.clear();
    const sel = host.selection();
    const me = host.me();
    const shown = new Set<string>();
    for (const t of list) {
      const b = screenBox(t);
      if (b.x1 < -50 || b.y1 < -50 || b.x0 > vw() + 50 || b.y0 > vh() + 50) continue;
      if (sel.has(t.id)) {
        overlay.poly(corners(t, 3)).stroke({ width: 4, color: '#000000', alpha: 0.35 });
        overlay.poly(corners(t, 3)).stroke({ width: 2, color: me.color });
      } else if (t.id === hovered) {
        overlay.poly(corners(t, 2)).stroke({ width: 1.5, color: '#FFFFFF', alpha: 0.75 });
      }
      const w = b.x1 - b.x0;
      if (w < 14) continue;
      // bars: thin strips stacked above the token
      const bars = (t.bars ?? []).slice(0, 3);
      const bw = Math.max(w, 26);
      const bx = (b.x0 + b.x1) / 2 - bw / 2;
      bars.forEach((bar, i) => {
        const y = b.y0 - 4 - (bars.length - i) * 6;
        const f = barFraction(bar);
        overlay.roundRect(bx - 1, y - 1, bw + 2, 6, 2).fill({ color: '#000000', alpha: 0.55 });
        overlay.roundRect(bx, y, bw * (f ?? 1), 4, 1.5).fill({ color: BAR_COLORS[i] ?? '#888888', alpha: f === null ? 0.6 : 1 });
      });
      if (t.name && (t.showName || t.id === hovered || sel.has(t.id))) {
        shown.add(t.id);
        plateFor(t, (b.x0 + b.x1) / 2, b.y1 + 3);
      }
    }
    for (const [id, p] of plates) {
      if (shown.has(id)) continue;
      p.box.destroy({ children: true });
      plates.delete(id);
    }
  }

  function plateFor(t: Token, cx: number, top: number): void {
    let p = plates.get(t.id);
    if (!p || p.name !== t.name) {
      p?.box.destroy({ children: true });
      const box = new Container();
      const plate = new Graphics();
      const text = new Text({ text: t.name ?? '', style: { fontFamily: 'system-ui, "Segoe UI", sans-serif', fontSize: 12, fill: '#FFFFFF' } });
      box.addChild(plate, text);
      plate.roundRect(-5, -1, text.width + 10, text.height + 2, 5).fill({ color: '#101418', alpha: 0.78 });
      p = { box, plate, text, name: t.name ?? '' };
      plates.set(t.id, p);
      names.addChild(box);
    }
    p.box.position.set(Math.round(cx - p.text.width / 2), Math.round(top));
  }

  function drawPings(now: number): boolean {
    pingsG.clear();
    for (let i = pings.length - 1; i >= 0; i--) if (now - pings[i]!.start > PING_MS) pings.splice(i, 1);
    for (const p of pings) {
      const t = (now - p.start) / PING_MS;
      const [sx, sy] = toScreen(cam, p.x, p.y);
      for (const lag of [0, 0.25]) {
        const k = Math.min(1, Math.max(0, (t - lag) / (1 - lag)));
        if (k <= 0 || k >= 1) continue;
        pingsG.circle(sx, sy, 6 + k * 54).stroke({ width: 3, color: p.color, alpha: 1 - k });
      }
      pingsG.circle(sx, sy, 5).fill({ color: p.color, alpha: Math.max(0, 1 - t) });
    }
    return pings.length > 0;
  }

  // ---------- dynamic vision ----------

  let fogCanvas: HTMLCanvasElement | null = null;
  let fogTexture: Texture | null = null;
  const fogWork = document.createElement('canvas');
  let hoveredDoor: string | null = null;
  const isGmMe = () => host.me().role === 'gm';

  function polyPath(polys: readonly VisionPolygon[]): Path2D {
    const path = new Path2D();
    for (const p of polys) {
      for (const ring of [p.outer, ...p.holes]) {
        if (ring.length < 3) continue;
        path.moveTo(ring[0]![0], ring[0]![1]);
        for (let i = 1; i < ring.length; i++) path.lineTo(ring[i]![0], ring[i]![1]);
        path.closePath();
      }
    }
    return path;
  }

  /**
   * The darkness mask, painted on a small canvas at a few pixels per cell and
   * stretched over the page (bilinear filtering and a slight blur soften its
   * edges): black never seen, dimmed seen before, a light veil where only dim
   * light (or darkvision) reaches. Players with no vision message yet get all black.
   */
  function drawFog(): void {
    const p = page;
    if (!p || !hasFog(p)) {
      fogSprite.visible = false;
      requestRender();
      return;
    }
    const a = fogAlphas(isGmMe(), host.backgroundView?.() ?? 'players');
    const got = host.vision?.() ?? null;
    const v = got && got.pageId === p.id ? got : null;
    const b = pageBox(p);
    const x0 = b.x0 - 1;
    const y0 = b.y0 - 1;
    const w = b.x1 - b.x0 + 2;
    const h = b.y1 - b.y0 + 2;
    const k = fogResolution(w, h);
    const W = Math.ceil(w * k);
    const H = Math.ceil(h * k);
    fogWork.width = W;
    fogWork.height = H;
    const ctx = fogWork.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
    ctx.fillStyle = `rgba(0,0,0,${a.unexplored})`;
    ctx.fillRect(x0, y0, w, h);
    if (v) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = `rgba(0,0,0,${1 - a.explored / a.unexplored})`;
      if (v.explored === 'all') ctx.fillRect(x0, y0, w, h);
      else ctx.fill(polyPath(v.explored), 'evenodd');
      const visible = polyPath(v.visible);
      ctx.fillStyle = '#000';
      ctx.fill(visible, 'evenodd');
      if (a.dim > 0) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = `rgba(0,0,0,${a.dim})`;
        ctx.fill(visible, 'evenodd');
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = '#000';
        ctx.fill(polyPath(v.bright), 'evenodd');
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    if (!fogCanvas || fogCanvas.width !== W || fogCanvas.height !== H) {
      fogTexture?.destroy(true);
      fogCanvas = document.createElement('canvas');
      fogCanvas.width = W;
      fogCanvas.height = H;
      fogTexture = null;
    }
    const out = fogCanvas.getContext('2d');
    if (!out) return;
    out.clearRect(0, 0, W, H);
    out.filter = `blur(${Math.max(0.5, k * 0.07).toFixed(2)}px)`;
    out.drawImage(fogWork, 0, 0);
    out.filter = 'none';
    if (!fogTexture) {
      fogTexture = new Texture({ source: new CanvasSource({ resource: fogCanvas, scaleMode: 'linear' }) });
      fogSprite.texture = fogTexture;
    } else fogTexture.source.update();
    fogSprite.position.set(x0, y0);
    fogSprite.width = w;
    fogSprite.height = h;
    fogSprite.visible = true;
    requestRender();
  }

  /** The GM's overlay on a dynamic page: lights with their bright and dim radii, and the doors (green open, orange shut, purple secret). */
  function drawVisionOverlay(list: Token[]): void {
    visionG.clear();
    const p = page;
    if (!p || !hasFog(p) || !isGmMe() || host.backgroundView?.() === 'players') return;
    const W = vw();
    const H = vh();
    for (const l of overlayLights(p, list)) {
      const [sx, sy] = toScreen(cam, l.x, l.y);
      const rd = (l.bright + l.dim) * cam.scale;
      const rb = l.bright * cam.scale;
      if (sx + rd < 0 || sy + rd < 0 || sx - rd > W || sy - rd > H) continue;
      if (rd > rb) visionG.circle(sx, sy, rd).stroke({ width: 1, color: '#F2C14E', alpha: 0.5 });
      if (rb > 0) visionG.circle(sx, sy, rb).fill({ color: '#F2C14E', alpha: 0.06 }).stroke({ width: 1.2, color: '#F2C14E', alpha: 0.75 });
      visionG.circle(sx, sy, 3.5).fill({ color: '#F2C14E', alpha: 0.95 }).stroke({ width: 1, color: '#000000', alpha: 0.5 });
    }
    for (const d of p.doors ?? []) {
      if (d.style === 'archway') continue;
      const look = doorLook(p, d);
      const [ax, ay] = toScreen(cam, d.a[0], d.a[1]);
      const [bx, by] = toScreen(cam, d.b[0], d.b[1]);
      if (Math.max(ax, bx) < -20 || Math.max(ay, by) < -20 || Math.min(ax, bx) > W + 20 || Math.min(ay, by) > H + 20) continue;
      const hot = d.id === hoveredDoor;
      const color = look.state === 'open' ? '#3FA34D' : look.state === 'secret' ? '#9B59D0' : '#D9822B';
      visionG.moveTo(ax, ay).lineTo(bx, by).stroke({ width: hot ? 8 : 6, color: '#000000', alpha: 0.4, cap: 'round' });
      visionG.moveTo(ax, ay).lineTo(bx, by).stroke({ width: hot ? 5 : 3.5, color, alpha: 0.95, cap: 'round' });
    }
  }

  /** The door under a screen point, for the GM on a dynamic page. */
  function doorUnder(wx: number, wy: number): string | null {
    const p = page;
    if (!p || !hasFog(p) || !isGmMe() || !host.toggleDoor || host.backgroundView?.() === 'players') return null;
    return doorAt(p.doors, wx, wy, Math.max(0.25, 9 / cam.scale))?.id ?? null;
  }

  // ---------- frames ----------

  let queued = false;
  function requestRender(): void {
    if (queued) return;
    queued = true;
    requestAnimationFrame(frame);
  }

  const viewListeners: (() => void)[] = [];

  function frame(now: number): void {
    queued = false;
    for (const c of [low, fogLayer, high]) {
      c.position.set(cam.x, cam.y);
      c.scale.set(cam.scale);
    }
    for (const f of viewListeners) f();
    const list = displayTokens();
    syncTokens(list);
    drawGrid();
    drawVisionOverlay(list);
    drawOverlay(list);
    const more = drawPings(now);
    app.render();
    if (more || anim) requestRender();
  }

  // ---------- camera ----------

  let anim: { from: Camera; to: Camera; start: number; ms: number } | null = null;
  const setCam = (c: Camera) => {
    anim = null;
    cam = c;
    if (page) cams.set(camKey(page), cam);
    requestRender();
  };
  function animateTo(to: Camera, ms = 300): void {
    anim = { from: cam, to, start: performance.now(), ms };
    const step = (now: number) => {
      if (!anim) return;
      const t = Math.min(1, (now - anim.start) / anim.ms);
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      cam = { x: anim.from.x + (anim.to.x - anim.from.x) * e, y: anim.from.y + (anim.to.y - anim.from.y) * e, scale: anim.from.scale + (anim.to.scale - anim.from.scale) * e };
      if (t >= 1) anim = null;
      if (page) cams.set(camKey(page), cam);
      requestRender();
      if (anim) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function fitBox(): Box | null {
    if (page) return pageBox(page);
    const ts = host.tokens();
    if (!ts.length) return null;
    return { x0: Math.min(...ts.map((t) => t.x)), y0: Math.min(...ts.map((t) => t.y)), x1: Math.max(...ts.map((t) => t.x + t.w)), y1: Math.max(...ts.map((t) => t.y + t.h)) };
  }

  const fit = () => {
    const b = fitBox();
    if (b) animateTo(fitCamera(b, vw(), vh()));
  };

  new ResizeObserver(() => {
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    const ow = vw();
    const oh = vh();
    if (w === ow && h === oh) return;
    app.renderer.resize(w, h);
    // keep the middle of the view where it was (the sidebar opening, a phone turning)
    cam = { ...cam, x: cam.x + (w - ow) / 2, y: cam.y + (h - oh) / 2 };
    requestRender();
  }).observe(stage);

  // ---------- input ----------

  const pos = (e: PointerEvent | WheelEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const pointers = new Map<number, { x: number; y: number; type: string }>();
  let gesture: Gesture | null = null;
  let holdTimer: number | undefined;
  let lastClick: { id: string; at: number } | null = null;

  const accept = () => selectable(host.me(), host.activeLayer());

  function startPinch(): void {
    const [a, b] = [...pointers.entries()];
    if (!a || !b) return;
    clearTimeout(holdTimer);
    if (gesture?.kind === 'drag') dragPos.clear();
    gesture = {
      kind: 'pinch',
      a: a[0],
      b: b[0],
      cam,
      dist: Math.hypot(a[1].x - b[1].x, a[1].y - b[1].y) || 1,
      mx: (a[1].x + b[1].x) / 2,
      my: (a[1].y + b[1].y) / 2,
    };
  }

  canvas.addEventListener('pointerdown', (e) => {
    const [sx, sy] = pos(e);
    pointers.set(e.pointerId, { x: sx, y: sy, type: e.pointerType });
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer the browser no longer tracks: carry on without capture */
    }
    if (pointers.size === 2) return startPinch();
    if (pointers.size > 2) return;
    anim = null;
    if (e.button === 1) {
      e.preventDefault();
      gesture = { kind: 'pan', pointer: e.pointerId, lastX: sx, lastY: sy };
      canvas.classList.add('panning');
      return;
    }
    if (e.button !== 0) return;
    const [wx, wy] = toWorld(cam, sx, sy);
    const hit = tokenAt(displayTokens(), wx, wy, accept());
    let toggled = false;
    const sel = host.selection();
    if (hit) {
      if (e.shiftKey) {
        const next = new Set(sel);
        if (next.has(hit.id)) next.delete(hit.id);
        else next.add(hit.id);
        host.setSelection([...next]);
        toggled = true;
      } else if (!sel.has(hit.id)) host.setSelection([hit.id]);
    }
    const door = hit ? null : doorUnder(wx, wy);
    gesture = { kind: 'press', pointer: e.pointerId, sx, sy, wx, wy, hit: hit?.id ?? null, toggled, touch: e.pointerType === 'touch', ...(door ? { door } : {}) };
    clearTimeout(holdTimer);
    holdTimer = window.setTimeout(() => {
      if (gesture?.kind !== 'press') return;
      host.ping(wx, wy);
      gesture = { kind: 'done' };
    }, HOLD_MS);
  });

  canvas.addEventListener('pointermove', (e) => {
    const [sx, sy] = pos(e);
    const p = pointers.get(e.pointerId);
    if (p) {
      p.x = sx;
      p.y = sy;
    }
    const g = gesture;
    if (!g) {
      if (e.pointerType !== 'mouse') return;
      const [wx, wy] = toWorld(cam, sx, sy);
      const list = displayTokens();
      const over = tokenAt(list, wx, wy);
      const id = over?.id ?? null;
      const door = over ? null : doorUnder(wx, wy);
      canvas.style.cursor = (over && accept()(over)) || door ? 'pointer' : '';
      if (id !== hovered || door !== hoveredDoor) {
        hovered = id;
        hoveredDoor = door;
        requestRender();
      }
      return;
    }
    if (g.kind === 'pinch') {
      const a = pointers.get(g.a);
      const b = pointers.get(g.b);
      if (!a || !b) return;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const f = Math.hypot(a.x - b.x, a.y - b.y) / g.dist;
      setCam(panBy(zoomAt(g.cam, g.mx, g.my, f), mx - g.mx, my - g.my));
      return;
    }
    if (g.kind === 'press' && e.pointerId === g.pointer) {
      if (Math.hypot(sx - g.sx, sy - g.sy) < (g.touch ? 8 : 4)) return;
      clearTimeout(holdTimer);
      const me = host.me();
      const list = displayTokens();
      const lead = g.hit ? list.find((t) => t.id === g.hit) : undefined;
      if (lead && host.selection().has(lead.id) && canMove(me, lead)) {
        const sel = host.selection();
        const starts = list.filter((t) => sel.has(t.id) && canMove(me, t)).map((t) => ({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h }));
        gesture = { kind: 'drag', pointer: g.pointer, wx: g.wx, wy: g.wy, lead: lead.id, starts };
        canvas.classList.add('dragging');
      } else {
        gesture = { kind: 'pan', pointer: g.pointer, lastX: g.sx, lastY: g.sy };
        canvas.classList.add('panning');
      }
    }
    const cur = gesture;
    if (cur?.kind === 'drag' && e.pointerId === cur.pointer) {
      const [wx, wy] = toWorld(cam, sx, sy);
      for (const m of dragTargets(cur.starts, cur.lead, wx - cur.wx, wy - cur.wy, e.altKey)) dragPos.set(m.id, { x: m.x, y: m.y });
      requestRender();
    } else if (cur?.kind === 'pan' && e.pointerId === cur.pointer) {
      setCam(panBy(cam, sx - cur.lastX, sy - cur.lastY));
      cur.lastX = sx;
      cur.lastY = sy;
    }
  });

  function endPointer(e: PointerEvent, cancelled: boolean): void {
    pointers.delete(e.pointerId);
    const g = gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      // the finger left behind does nothing until it lifts too
      gesture = pointers.size ? { kind: 'done' } : null;
      return;
    }
    if (g.kind !== 'done' && 'pointer' in g && g.pointer !== e.pointerId) return;
    clearTimeout(holdTimer);
    canvas.classList.remove('dragging', 'panning');
    gesture = pointers.size ? { kind: 'done' } : null;
    if (cancelled) {
      dragPos.clear();
      requestRender();
      return;
    }
    if (g.kind === 'drag') {
      const starts = new Map(g.starts.map((s) => [s.id, s]));
      const moves = [...dragPos].map(([id, p]) => ({ id, ...p })).filter((m) => {
        const s = starts.get(m.id);
        return s && (s.x !== m.x || s.y !== m.y);
      });
      dragPos.clear();
      if (moves.length) host.move(moves);
      requestRender();
    } else if (g.kind === 'press') {
      if (!g.hit) {
        if (g.door) {
          host.toggleDoor?.(g.door);
          lastClick = null;
          return;
        }
        if (!e.shiftKey) host.setSelection([]);
        lastClick = null;
        return;
      }
      if (!g.toggled) host.setSelection([g.hit]);
      const now = performance.now();
      if (lastClick && lastClick.id === g.hit && now - lastClick.at < 400) {
        lastClick = null;
        host.open(g.hit);
      } else lastClick = { id: g.hit, at: now };
    }
  }
  canvas.addEventListener('pointerup', (e) => endPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !gesture && hovered) {
      hovered = null;
      canvas.style.cursor = '';
      requestRender();
    }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const [sx, sy] = pos(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      setCam(zoomAt(cam, sx, sy, Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.0022)));
    },
    { passive: false },
  );

  // ---------- the board's API ----------

  return {
    update: requestRender,
    setPage(p, reload) {
      const changedPage = p?.id !== page?.id;
      const bgChanged = JSON.stringify(p?.background) !== JSON.stringify(page?.background) || p?.cellPx !== page?.cellPx;
      const fogBefore = JSON.stringify([page?.id, page?.vision, page?.origin, page?.width, page?.height]);
      page = p;
      if (changedPage || bgChanged || reload) loadBackground(reload && !changedPage);
      else drawPageFill();
      if (fogBefore !== JSON.stringify([p?.id, p?.vision, p?.origin, p?.width, p?.height])) drawFog();
      if (changedPage && p) {
        const saved = cams.get(camKey(p));
        cam = saved ?? fitCamera(pageBox(p), vw(), vh());
        cams.set(camKey(p), cam);
      }
      requestRender();
    },
    showPing(x, y, color) {
      pings.push({ x, y, color, start: performance.now() });
      requestRender();
    },
    fit,
    zoom(f) {
      animateTo(zoomAt(cam, vw() / 2, vh() / 2, f), 160);
    },
    centre: () => toWorld(cam, vw() / 2, vh() / 2),
    toWorld(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      return toWorld(cam, clientX - r.left, clientY - r.top);
    },
    toClient(x, y) {
      const r = canvas.getBoundingClientRect();
      const [sx, sy] = toScreen(cam, x, y);
      return [sx + r.left, sy + r.top];
    },
    pxPerCell: () => cam.scale,
    onView(cb) {
      viewListeners.push(cb);
    },
    focus(x, y) {
      animateTo({ ...cam, x: vw() / 2 - x * cam.scale, y: vh() / 2 - y * cam.scale });
    },
    retheme() {
      readColors();
      drawPageFill();
      for (const t of host.tokens()) {
        const g = gfx.get(t.id);
        if (g?.placeholder.visible) drawPlaceholder(g.placeholder, t);
      }
      requestRender();
    },
    visionChanged: drawFog,
    reloadBackground() {
      if (page) loadBackground(true);
    },
  };
}
