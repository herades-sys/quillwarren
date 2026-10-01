// Pictures for the 3D table view as three.js textures: the floor (a Delve page's
// background.png, or an uploaded picture) and the minis' token images. As on the
// 2D board, SVGs are rasterised big enough to stay sharp and pictures larger than
// the GPU takes are shrunk first. Same-origin, so the member's cookie goes along.
import { CanvasTexture, SRGBColorSpace, Texture } from 'three';

const SVG_PX = 512; // raster size of a prop SVG's longer side

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error(`could not load ${url}`));
    img.src = url;
  });
}

/** A texture for a picture, plus the picture's own pixel size (the texture may be smaller). */
export async function makeTexture(url: string, maxTex: number, anisotropy: number): Promise<{ tex: Texture; w: number; h: number }> {
  const img = await loadImage(url);
  await img.decode().catch(() => {});
  const svg = /\.svg(\?|$)/i.test(url);
  const nw = img.naturalWidth || SVG_PX;
  const nh = img.naturalHeight || SVG_PX;
  let tex: Texture;
  if (svg || Math.max(nw, nh) > maxTex) {
    const target = svg ? SVG_PX : maxTex;
    const k = target / Math.max(nw, nh);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(nw * k));
    c.height = Math.max(1, Math.round(nh * k));
    c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
    tex = new CanvasTexture(c);
  } else {
    tex = new Texture(img);
    tex.needsUpdate = true;
  }
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return { tex, w: nw, h: nh };
}

/** Token pictures by URL, loaded once and shared by every mini that shows them. */
export class TextureCache {
  private readonly entries = new Map<string, { tex: Texture; aspect: number } | 'loading' | 'failed'>();
  private readonly waiting = new Map<string, Set<() => void>>();
  private readonly maxTex: number;
  private readonly anisotropy: number;

  constructor(maxTex: number, anisotropy: number) {
    this.maxTex = maxTex;
    this.anisotropy = anisotropy;
  }

  /** The texture and its height/width, or null while it loads (`ready` runs when it's in) or if it failed. */
  get(url: string, ready: () => void): { tex: Texture; aspect: number } | null {
    const e = this.entries.get(url);
    if (e && typeof e === 'object') return e;
    if (e === 'failed') return null;
    const list = this.waiting.get(url) ?? new Set();
    list.add(ready);
    this.waiting.set(url, list);
    if (e === 'loading') return null;
    this.entries.set(url, 'loading');
    makeTexture(url, this.maxTex, this.anisotropy)
      .then(({ tex, w, h }) => this.entries.set(url, { tex, aspect: h / Math.max(w, 1) }))
      .catch(() => this.entries.set(url, 'failed'))
      .finally(() => {
        const cbs = this.waiting.get(url) ?? new Set();
        this.waiting.delete(url);
        cbs.forEach((f) => f());
      });
    return null;
  }
}
