// Uploaded pictures: the library (magic bytes, pixel size, index), the REST
// routes, PNG exports that draw them, and the MCP tools.
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DelveMap } from '@delve/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { imageDimensions, ImageLibrary, sniffImage } from '../src/images.ts';
import { decodePng, svgToPng } from '../src/png.ts';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
let app: FastifyInstance;
let base: string;
let client: Client;
let red: Buffer; // 40 × 20 px, solid red
let blue: Buffer; // 30 × 30 px, solid blue

const solid = (w: number, h: number, fill: string) => svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`);
const le16 = (v: number) => [v & 255, v >> 8];
const le24 = (v: number) => [v & 255, (v >> 8) & 255, v >> 16];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
// just the headers: the server reads sizes from them and never decodes pictures
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const GIF = Buffer.from('R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=', 'base64');
const WEBP_LOSSLESS = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
const WEBP_EXTENDED = Buffer.from([...ascii('RIFF'), 22, 0, 0, 0, ...ascii('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(299), ...le24(199)]);
const WEBP_LOSSY = Buffer.from([...ascii('RIFF'), 30, 0, 0, 0, ...ascii('WEBPVP8 '), 10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(640), ...le16(480)]);

type Content = { type: string; text?: string };
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  return { isError: res.isError ?? false, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
}
const upload = (body: Buffer, type = 'image/png', name = 'Red table', headers: Record<string, string> = auth) =>
  app.inject({ method: 'POST', url: `/api/v1/images?name=${encodeURIComponent(name)}`, headers: { ...headers, 'content-type': type }, payload: body });
const newMap = async () => (await app.inject({ method: 'POST', url: '/api/v1/maps', headers: auth, payload: { template: 'test-dungeon', name: 'Keep' } })).json().id as string;
const ops = (id: string, list: unknown[]) => app.inject({ method: 'POST', url: `/api/v1/maps/${id}/ops`, headers: auth, payload: { ops: list } });
const getMap = async (id: string) => ((await app.inject({ url: `/api/v1/maps/${id}` })).json() as { map: DelveMap }).map;

beforeAll(async () => {
  red = await solid(40, 20, '#FF0000');
  blue = await solid(30, 30, '#0000FF');
  app = buildApp({ version: 'test', started: 'now' }, { token: TOKEN });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  client = new Client({ name: 'delve-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }));
});
afterAll(async () => {
  await client.close();
  await app.close();
});

describe('reading pictures', () => {
  it('tells the kinds apart by their first bytes and reads their size from the header', () => {
    expect(sniffImage(red)).toBe('png');
    expect(imageDimensions(red, 'png')).toEqual({ width: 40, height: 20 });
    expect(sniffImage(JPEG)).toBe('jpg');
    expect(imageDimensions(JPEG, 'jpg')).toEqual({ width: 400, height: 300 });
    expect(sniffImage(GIF)).toBe('gif');
    expect(imageDimensions(GIF, 'gif')).toEqual({ width: 1, height: 1 });
    expect(sniffImage(WEBP_LOSSLESS)).toBe('webp');
    expect(imageDimensions(WEBP_LOSSLESS, 'webp')).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(WEBP_EXTENDED, 'webp')).toEqual({ width: 300, height: 200 });
    expect(imageDimensions(WEBP_LOSSY, 'webp')).toEqual({ width: 640, height: 480 });
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(imageDimensions(red.subarray(0, 18), 'png')).toBeNull();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]), 'jpg')).toBeNull();
  });

  it('keeps an index next to the files, and rebuilds it when it is lost', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delve-images-test-'));
    try {
      const lib = new ImageLibrary(dir);
      const { info, created } = lib.add(red, 'Red\u0000 table  ');
      expect(created).toBe(true);
      expect(info).toMatchObject({ name: 'Red table', width: 40, height: 20, bytes: red.length });
      expect(lib.add(red, 'Other name')).toMatchObject({ created: false, info: { name: 'Red table' } });
      expect(() => lib.add(Buffer.from('GIF89a'))).toThrow(/damaged/);
      expect(lib.read('../index.json')).toBeNull();
      lib.close();
      const reopened = new ImageLibrary(dir);
      expect(reopened.list()).toEqual([info]);
      reopened.close();
      unlinkSync(join(dir, 'index.json'));
      const rebuilt = new ImageLibrary(dir);
      expect(rebuilt.get(info.src)).toMatchObject({ src: info.src, name: info.src, width: 40, height: 20 });
      rebuilt.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the image routes', () => {
  it('upload a picture once per content and list it', async () => {
    const res = await upload(red);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { src: string; url: string; width: number; height: number; name: string };
    expect(body.src).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(body).toEqual({ src: body.src, url: `/api/v1/images/${body.src}`, width: 40, height: 20, name: 'Red table' });
    // the same bytes again, sent as raw bytes: the same picture
    const again = await upload(red, 'application/octet-stream', 'Something else');
    expect(again.statusCode).toBe(200);
    expect(again.json().src).toBe(body.src);
    // a claim of image/jpeg changes nothing: the bytes say PNG
    expect((await upload(red, 'image/jpeg')).json().src).toBe(body.src);
    const list = (await app.inject({ url: '/api/v1/images' })).json() as { images: { src: string; url: string; name: string }[] };
    expect(list.images.filter((i) => i.src === body.src)).toEqual([expect.objectContaining({ src: body.src, url: body.url, name: 'Red table', width: 40, height: 20 })]);
  });

  it('serve pictures publicly with their real type, nosniff and a long cache', async () => {
    const { src } = (await upload(blue, 'image/png', 'Blue')).json() as { src: string };
    const res = await app.inject({ url: `/api/v1/images/${src}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.rawPayload.equals(blue)).toBe(true);
    for (const bad of [`${'0'.repeat(64)}.png`, '..%2F..%2Fetc%2Fpasswd', src.toUpperCase(), src.replace('.png', '.svg'), 'index.json']) {
      expect((await app.inject({ url: `/api/v1/images/${bad}` })).statusCode).toBe(404);
    }
  });

  it('refuse anything but real pictures, and writes without a login', async () => {
    const html = await upload(Buffer.from('<html><script>alert(1)</script></html>'));
    expect(html.statusCode).toBe(400);
    expect(html.json().error).toContain('not a PNG, JPEG, WebP or GIF');
    expect((await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).statusCode).toBe(400);
    expect((await upload(red, 'image/png', 'x', {})).statusCode).toBe(401);
    const big = Buffer.concat([red, Buffer.alloc(11 * 1024 * 1024)]);
    expect((await upload(big)).statusCode).toBe(413);
    const json = await app.inject({ method: 'POST', url: '/api/v1/images', headers: auth, payload: { picture: 'x' } });
    expect(json.statusCode).toBe(415);
    // too many pixels to draw: a PNG header claiming 20000 × 20000
    const huge = Buffer.from(red);
    huge.writeUInt32BE(20000, 16);
    huge.writeUInt32BE(20000, 20);
    expect((await upload(huge)).statusCode).toBe(413);
  });

  it('refuse to delete a picture a map still uses, and name the map', async () => {
    const { src } = (await upload(GIF, 'image/gif', 'Dot')).json() as { src: string };
    const id = await newMap();
    expect((await ops(id, [{ op: 'add', object: { id: 'img1', type: 'image', src, at: [2, 17], w: 1, h: 1 } }])).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/images/${src}` })).statusCode).toBe(401);
    const used = await app.inject({ method: 'DELETE', url: `/api/v1/images/${src}`, headers: auth });
    expect(used.statusCode).toBe(409);
    expect(used.json()).toMatchObject({ error: expect.stringContaining('"Keep"'), maps: [{ id, name: 'Keep' }] });
    await ops(id, [{ op: 'delete', ids: ['img1'] }]);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/images/${src}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/v1/images/${src}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/images/${src}`, headers: auth })).statusCode).toBe(404);
  });
});

describe('exports with pictures', () => {
  it('draw uploaded pictures into server PNGs (renders, 3D floors, the handout)', async () => {
    const r = (await upload(red)).json() as { src: string };
    const b = (await upload(blue, 'image/png', 'Blue')).json() as { src: string };
    const w = (await upload(WEBP_LOSSLESS, 'image/webp', 'Web')).json() as { src: string };
    const id = await newMap();
    await ops(id, [
      // on top, in room 3 (x 0–4, y 13–21); a floor mosaic in the crossroads (x 6–14, y 15–21); a WebP resvg can't read
      { op: 'add', object: { id: 'img1', type: 'image', src: r.src, at: [2, 14.5], w: 2, h: 1 } },
      { op: 'add', object: { id: 'img2', type: 'image', src: b.src, at: [10, 18], w: 4, h: 4, layer: 'floor' } },
      { op: 'add', object: { id: 'img3', type: 'image', src: w.src, at: [18, 17], w: 1, h: 1 } },
      { op: 'add', object: { id: 'img4', type: 'image', src: r.src, at: [18.5, 4], w: 1, h: 1, gmOnly: true } },
    ]);
    const ppg = 20;
    const png = async (q: string) => {
      const res = await app.inject({ url: `/api/v1/maps/${id}/render.png?ppg=${ppg}&${q}` });
      expect(res.statusCode).toBe(200);
      return decodePng(res.rawPayload);
    };
    // the test map's canvas is grid.bounds [0, 0, 20, 32] plus hatching and margin
    const svg = (await app.inject({ url: `/api/v1/maps/${id}/render.svg?ppg=${ppg}` })).body;
    const [x0, y0] = /viewBox="(-?[\d.]+) (-?[\d.]+)/.exec(svg)!.slice(1).map(Number) as [number, number];
    const pixel = (img: { width: number; rgba: Uint8Array }, x: number, y: number) => {
      const o = (Math.round((y - y0) * ppg) * img.width + Math.round((x - x0) * ppg)) * 4;
      return [...img.rgba.subarray(o, o + 3)];
    };
    const gm = await png('view=gm');
    expect(pixel(gm, 2.3, 14.3)).toEqual([255, 0, 0]);
    expect(pixel(gm, 8.5, 16.5)).toEqual([0, 0, 255]);
    expect(pixel(gm, 18.3, 4.2)).toEqual([255, 0, 0]);
    const players = await png('view=players');
    expect(pixel(players, 2.3, 14.3)).toEqual([255, 0, 0]);
    expect(pixel(players, 18.3, 4.2)).not.toEqual([255, 0, 0]); // GM only
    // the 3D view's transparent floor textures
    expect(pixel(await png('background=0'), 2.3, 14.3)).toEqual([255, 0, 0]);
    const handout = await app.inject({ url: `/api/v1/maps/${id}/handout.png?dpi=50` });
    expect(handout.statusCode).toBe(200);
    const sheet = decodePng(handout.rawPayload);
    let reds = 0;
    for (let i = 0; i < sheet.rgba.length; i += 4) if (sheet.rgba[i]! > 200 && sheet.rgba[i + 1]! < 60 && sheet.rgba[i + 2]! < 60) reds++;
    expect(reds).toBeGreaterThan(20);
  });
});

describe('pictures over MCP', () => {
  it('lists uploaded pictures and places one by src, sized from its proportions', async () => {
    const { src } = (await upload(red)).json() as { src: string };
    const id = await newMap();
    const list = await call('list_images');
    expect(list.text).toContain(`${src} — "Red table", 40×20 px, default 2×1 squares`);
    const added = await call('add_image', { map: id, src, at: [2, 17] });
    expect(added.text).toContain('Added image img1 "Red table", 2×1 squares, covering x 1–3, y 16.5–17.5.');
    await call('add_image', { map: id, src, at: [10, 18], w: 3, layer: 'floor', rotation: 90, gm_only: true, opacity: 0.5, name: 'Rug' });
    const map = await getMap(id);
    expect(map.objects.find((o) => o.id === 'img1')).toEqual({ id: 'img1', type: 'image', src, at: [2, 17], w: 2, h: 1, name: 'Red table' });
    expect(map.objects.find((o) => o.id === 'img2')).toEqual({ id: 'img2', type: 'image', src, at: [10, 18], w: 3, h: 1.5, rotation: 90, layer: 'floor', opacity: 0.5, gmOnly: true, name: 'Rug' });
    expect((await call('describe_map', { map: id })).text).toContain('img1 "Red table": 2×1 sq centred at 2,17 in 3 Barracks');
    const missing = await call('add_image', { map: id, src: `${'0'.repeat(64)}.png`, at: [1, 1] });
    expect(missing).toMatchObject({ isError: true, text: expect.stringContaining('no uploaded picture') });
    expect((await call('add_image', { map: id, src: '../../etc/passwd', at: [1, 1] })).isError).toBe(true);
  });
});
