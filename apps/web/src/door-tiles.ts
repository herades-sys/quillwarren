// The Prop picker's Doors group: a tile per door style, each drawn by the map
// renderer itself (core buildScene) on a short stretch of wall in the map's own
// style, so a tile looks exactly like the door it places.
import { buildScene, DOOR_STYLES, sceneToSvg, type DelveMap } from '@delve/core';

export type DoorStyle = (typeof DOOR_STYLES)[number];

export const DOOR_TILE_NAME: Record<DoorStyle, string> = { normal: 'Door', double: 'Double door', locked: 'Locked door', secret: 'Secret door', portcullis: 'Portcullis', archway: 'Archway' };

/** The width a door from the picker starts with: double doors and portcullises span a 10 ft corridor. */
export const doorTileWidth = (s: DoorStyle): number => (s === 'double' || s === 'portcullis' ? 2 : 1);

/** A door of this style in the north wall of a small room, framed close, as the GM sees it (a secret door shows its S). */
export function doorTileSvg(style: DoorStyle, map: Pick<DelveMap, 'style'>): string {
  // a little narrower than placed, so the door fills the tile
  const w = doorTileWidth(style) > 1 ? 1.4 : 1;
  const sample: DelveMap = {
    format: 'delve.map',
    version: 1,
    id: 'door-tile',
    name: 'Door',
    grid: { type: 'square' },
    ...(map.style ? { style: map.style } : {}),
    seed: 3,
    objects: [
      { id: 'r1', type: 'room', shape: { rect: [0, 1, 4, 3] } },
      { id: 'd1', type: 'door', at: [2 - w / 2, 1], along: 'x', width: w, style },
    ],
  };
  const half = w / 2 + 0.32;
  const scene = buildScene(sample, { view: 'gm', grid: false, floorNumber: false, frame: { x0: 2 - half, y0: 1 - half * 0.65, x1: 2 + half, y1: 1 + half * 0.9 } });
  return sceneToSvg(scene, { ppg: 40, idPrefix: `door-tile-${style}-` });
}

const cache = new Map<string, string>();

/** The tile as an image URL, cached per style and map style. */
export function doorTileUrl(style: DoorStyle, map: Pick<DelveMap, 'style'>): string {
  const key = `${style}|${JSON.stringify(map.style ?? null)}`;
  let url = cache.get(key);
  if (!url) {
    url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(doorTileSvg(style, map))}`;
    cache.set(key, url);
  }
  return url;
}
