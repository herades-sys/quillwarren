import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromWatabou, handoutSvg, PAPERS, validateMap, type DelveMap } from '../src/index.ts';
import { testMap } from './fixtures.ts';

const withSecrets = (): DelveMap => {
  const map = testMap();
  map.objects.push({ id: 'm1', type: 'marker', kind: 'trap', at: [12.5, 5.5], text: 'Dart trap' });
  return validateMap(map);
};

describe('parchment handout', () => {
  it('fills a sheet of paper in points, turned whichever way draws the map bigger', () => {
    const h = handoutSvg(testMap());
    expect([h.width, h.height]).toEqual([PAPERS.a4.w, PAPERS.a4.h]); // the test dungeon is taller than wide
    expect(h.svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="794" height="1123" viewBox="0 0 595.28 841.89"/);
    const wide = handoutSvg(testMap(), { orientation: 'landscape', paper: 'a3' });
    expect([wide.width, wide.height, wide.landscape]).toEqual([PAPERS.a3.h, PAPERS.a3.w, true]);
    const fit = handoutSvg(testMap(), { paper: 'fit' });
    expect(fit.paper).toBe('fit');
    expect(fit.height).toBeGreaterThan(fit.width);
    expect(handoutSvg(testMap(), { dpi: 200 }).svg).toContain('width="1654" height="2339"');
  });

  it("shows only the players' view: no room numbers, secret doors shut, no GM markers", () => {
    const { svg } = handoutSvg(withSecrets());
    expect(svg).not.toContain('data-layer="room-numbers"');
    expect(svg).not.toContain('data-layer="secret-marks"');
    expect(svg).not.toContain('data-marker');
    expect(svg).not.toContain('Dart trap');
    // the parchment style: sketched walls, hatching, paper texture and a torn edge
    for (const s of ['data-layer="walls-sketch-1"', 'data-layer="hatching"', 'id="hp-mottle"', 'clip-path="url(#hp-sheet)"']) expect(svg).toContain(s);
    expect(svg).not.toContain('feDisplacementMap'); // resvg panics on it at some sizes
  });

  it('has a title, compass, scale bar and frame that can each be left out', () => {
    const map = testMap();
    const full = handoutSvg({ ...map, name: 'Crypt of <Ash>' }).svg;
    expect(full).toContain('>Crypt of &lt;Ash&gt;</text>');
    expect(full).toContain('>N</text>');
    expect(full).toMatch(/>\d+ ft<\/text>/);
    const bare = handoutSvg(map, { title: '', compass: false, scaleBar: false, frame: false, stains: false }).svg;
    expect(bare).not.toContain('>N</text>');
    expect(bare).not.toMatch(/ ft<\/text>/);
    expect(bare).not.toContain('<ellipse');
    expect(bare).not.toContain(`>${map.name}</text>`);
    expect(handoutSvg(map, { title: 'The Old Crypt' }).svg).toContain('>The Old Crypt</text>');
  });

  it('can write room names, and keep to what the players have seen', () => {
    const map = testMap();
    const named = map.objects.filter((o) => o.type === 'room' && o.name);
    expect(named.length).toBeGreaterThan(2);
    const all = handoutSvg(map, { names: true }).svg;
    for (const r of named) expect(all).toContain(`>${r.name}</text>`);
    const first = named[0]!;
    const fogged: DelveMap = { ...map, fog: { on: true, revealed: [first.id] } };
    const seen = handoutSvg(fogged, { names: true, revealedOnly: true }).svg;
    expect(seen).toContain(`>${first.name}</text>`);
    expect(seen).not.toContain(`>${named[1]!.name}</text>`);
    // without revealedOnly the whole map is drawn, fog or not
    expect(handoutSvg(fogged, { names: true }).svg).toContain(`>${named[1]!.name}</text>`);
  });

  it('leaves the hatching out on a city, where it would take seconds and look busy', () => {
    const feyvale = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/watabou/feyvale.json'), 'utf8'));
    const { map } = fromWatabou(feyvale, { id: 'map_feyvale00001', name: 'Feyvale' });
    const started = performance.now();
    const { svg, landscape } = handoutSvg(map);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(landscape).toBe(true);
    expect(svg).not.toContain('data-layer="hatching"');
    expect(svg).toContain('data-layer="walls"');
  });

  it('draws the same sheet every time', () => {
    expect(handoutSvg(testMap()).svg).toBe(handoutSvg(testMap()).svg);
  });
});
