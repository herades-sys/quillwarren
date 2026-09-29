// Asset files: prop and terrain SVGs (for the renderer and the editor's picker),
// plus the editor icons and the Delve logo. They come from
// delve-props-design-system/assets in development and release/assets in a
// release. Every prop and tile goes through parseAssetSvg, so only whitelisted
// shapes in the three inks ever reach a page or a PNG.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { ASSETS, assetInfo, assetSvg, CATEGORIES, parseAssetSvg } from '@delve/core';

/** release/assets next to the bundle, or the design system folder in development. DELVE_ASSETS overrides. */
export function findAssetDir(): string | null {
  const candidates = [process.env.DELVE_ASSETS, fileURLToPath(new URL('./assets/', import.meta.url)), fileURLToPath(new URL('../../../delve-props-design-system/assets/', import.meta.url))];
  for (const d of candidates) if (d && existsSync(join(d, 'furniture'))) return d;
  return null;
}

export class AssetLibrary {
  readonly dir: string | null;
  private readonly bodies = new Map<string, string | null>();

  constructor(dir: string | null) {
    this.dir = dir;
  }

  /** A prop's or tile's cleaned SVG body, or undefined if it isn't in the catalog or has no file. */
  body = (id: string): string | undefined => {
    if (!this.bodies.has(id)) {
      const info = assetInfo(id);
      let body: string | null = null;
      if (info && this.dir) {
        try {
          body = parseAssetSvg(readFileSync(join(this.dir, info.file), 'utf8')).body;
        } catch {
          body = null;
        }
      }
      this.bodies.set(id, body);
    }
    return this.bodies.get(id) ?? undefined;
  };

  /** A standalone, cleaned SVG in the original inks. */
  svg(id: string): string | undefined {
    const info = assetInfo(id);
    const body = this.body(id);
    return info && body !== undefined ? assetSvg({ w: info.w, h: info.h, body }) : undefined;
  }

  /** An editor icon or brand file, with its embedded metadata (content credentials) stripped. */
  ui(kind: 'icons' | 'brand', name: string): string | undefined {
    if (!this.dir || !/^[a-z0-9-]{1,60}$/.test(name)) return undefined;
    const file = join(this.dir, kind, `${name}.svg`);
    if (!existsSync(file)) return undefined;
    return readFileSync(file, 'utf8').replace(/<metadata\b[\s\S]*?<\/metadata>/g, '').replace(/\s+xmlns:c2pa="[^"]*"/g, '');
  }
}

/** The library the renderer uses by default. */
export const assets = new AssetLibrary(findAssetDir());

export function registerAssets(app: FastifyInstance, lib: AssetLibrary = assets): void {
  app.get('/api/v1/assets', async () => ({
    categories: CATEGORIES,
    assets: ASSETS.map(({ file: _file, ...a }) => ({ ...a, available: lib.body(a.id) !== undefined })),
  }));

  app.get('/assets/props/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    const svg = file.endsWith('.svg') ? lib.svg(file.slice(0, -4)) : undefined;
    if (!svg) return reply.code(404).type('text/plain').send('no such asset');
    return reply.type('image/svg+xml').header('cache-control', 'public, max-age=86400').send(svg);
  });

  for (const kind of ['icons', 'brand'] as const) {
    app.get(`/assets/${kind}/:file`, async (req, reply) => {
      const { file } = req.params as { file: string };
      const svg = file.endsWith('.svg') ? lib.ui(kind, file.slice(0, -4)) : undefined;
      if (!svg) return reply.code(404).type('text/plain').send('not found');
      return reply.type('image/svg+xml').header('cache-control', 'public, max-age=86400').send(svg);
    });
  }
  app.get('/favicon.svg', async (_req, reply) => {
    const svg = lib.ui('brand', 'favicon');
    if (!svg) return reply.code(404).send();
    return reply.type('image/svg+xml').header('cache-control', 'public, max-age=86400').send(svg);
  });
}
