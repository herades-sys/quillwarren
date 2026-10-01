// describeMap: a short plain-text summary of a map, for people and for Claude.
import { corridorBounds, corridorPath, pathLength, roomsById } from './geometry/corridors.ts';
import { computeFloor } from './geometry/floor.ts';
import { containsPoint, shapeArea, shapeBounds } from './geometry/shapes.ts';
import { boundarySegments, collinearOverlap, doorSegment } from './geometry/walls.ts';
import { assetInfo } from './assets/catalog.ts';
import { fogSummary } from './fog.ts';
import { floorText, isConnector } from './floors.ts';
import { MARKERS } from './markers.ts';
import { areaTitle, hasNotes, isNoteArea } from './notes.ts';
import type { Corridor, Cutout, DelveMap, Door, MapImage, Marker, Point, Prop, Room, Terrain } from './schema.ts';

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

function unitOf(map: DelveMap): { size: number; name: string } {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]+)\s*$/.exec(map.grid.unit ?? '');
  return m ? { size: Number(m[1]), name: m[2]! } : { size: 5, name: 'ft' };
}

const roomName = (r: Room): string => [r.label, r.name ?? '(unnamed)'].filter(Boolean).join(' ');

export interface DescribeOptions {
  /** Cut each GM note to this many characters (default: whole notes). */
  notesMax?: number;
}

export function describeMap(map: DelveMap, opts: DescribeOptions = {}): string {
  const unit = unitOf(map);
  const ft = (sq: number): string => `${fmt(sq * unit.size)} ${unit.name}`;
  const rooms = map.objects.filter((o): o is Room => o.type === 'room');
  const corridors = map.objects.filter((o): o is Corridor => o.type === 'corridor');
  const doors = map.objects.filter((o): o is Door => o.type === 'door');
  const cutouts = map.objects.filter((o): o is Cutout => o.type === 'cutout');
  const others = map.objects.filter((o) => !['room', 'corridor', 'door', 'cutout', 'prop', 'terrain', 'marker', 'image'].includes(o.type));
  const images = map.objects.filter((o): o is MapImage => o.type === 'image');
  const markers = map.objects.filter((o): o is Marker => o.type === 'marker');
  const props = map.objects.filter((o): o is Prop => o.type === 'prop');
  const terrain = map.objects.filter((o): o is Terrain => o.type === 'terrain');
  const byId = roomsById(map);

  const lines: string[] = [];
  lines.push(
    `${map.name} (${map.id}): ${rooms.length} rooms, ${corridors.length} corridors, ${doors.length} doors, ` +
      `${cutouts.length} cutouts. 1 square = ${unit.size} ${unit.name}.`,
  );
  if (map.level) lines.push(`Floor ${floorText(map.level.order)} (${map.level.name}) of ${map.level.group}.`);

  if (map.roughness) lines.push(`Walls: roughness ${map.roughness} of 10${map.roughness >= 8 ? ' (cave-like)' : map.roughness === 1 ? ' (smooth)' : ''}.`);
  lines.push('Rooms:');
  for (const r of rooms) {
    const b = shapeBounds(r.shape);
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    const size =
      'rect' in r.shape
        ? `${fmt(w)}×${fmt(h)} sq (${ft(w)} × ${ft(h)})`
        : 'circle' in r.shape
          ? `circle, radius ${fmt(r.shape.circle[2])} sq`
          : `polygon, ${fmt(shapeArea(r.shape))} sq²`;
    lines.push(`  ${roomName(r)} [${r.id}]: ${size} at ${fmt(b.x0)},${fmt(b.y0)}${r.roughness ? `, walls roughness ${r.roughness}` : ''}`);
  }

  // Which room or corridor areas a door's midpoint touches.
  const corridorArea = new Map(
    corridors.map((c) => {
      const path = corridorPath(c, byId);
      return [c.id, path ? corridorBounds(path, c.width) : null] as const;
    }),
  );
  const doorMid = (d: Door): Point =>
    d.along === 'x' ? [d.at[0] + d.width / 2, d.at[1]] : [d.at[0], d.at[1] + d.width / 2];
  const doorText = (d: Door): string => `${d.id} (${d.style ?? 'normal'}${d.open ? ', open' : ''})`;
  const usedDoors = new Set<string>();

  if (corridors.length) lines.push('Connections:');
  for (const c of corridors) {
    const path = corridorPath(c, byId);
    const ends = [c.from, c.to].map((id) => (id && byId.get(id) ? roomName(byId.get(id)!) : '(open end)'));
    const area = corridorArea.get(c.id);
    const its = area ? doors.filter((d) => containsPoint(area, doorMid(d))) : [];
    its.forEach((d) => usedDoors.add(d.id));
    const len = path ? pathLength(path) : 0;
    lines.push(
      `  ${c.id}: ${ends[0]} ↔ ${ends[1]}, ${fmt(c.width)} sq wide, ${fmt(len)} sq (${ft(len)}) long` +
        `${c.path ? '' : ', auto-routed'}${path ? '' : ', NOT CONNECTED'}` +
        `${its.length ? `; doors ${its.map(doorText).join(', ')}` : ''}`,
    );
  }

  const rest = doors.filter((d) => !usedDoors.has(d.id));
  if (rest.length) {
    const edge = boundarySegments(computeFloor(map));
    lines.push('Other doors:');
    for (const d of rest) {
      const touching = rooms.filter((r) => containsPoint(shapeBounds(r.shape), doorMid(d))).map(roomName);
      const outside = edge.some((s) => collinearOverlap(s, doorSegment(d)) > 1e-6);
      const where = touching.length ? touching.join(' ↔ ') : 'no room';
      lines.push(`  ${doorText(d)}: ${where}${outside ? ', leads outside' : ''}`);
    }
  }

  if (cutouts.length) {
    const groups = new Map<string, string[]>();
    for (const c of cutouts) {
      const b = shapeBounds(c.shape);
      const mid: Point = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
      const inRoom = rooms.find((r) => containsPoint(shapeBounds(r.shape), mid));
      const key = inRoom ? `in ${roomName(inRoom)}` : 'outside rooms';
      groups.set(key, [...(groups.get(key) ?? []), `${c.id}${c.name ? ` ${c.name.toLowerCase()}` : ''}${c.fill === 'solid' ? ' (solid)' : ''}`]);
    }
    lines.push(`Cutouts: ${[...groups].map(([k, ids]) => `${ids.join(', ')} ${k}`).join('; ')}`);
  }
  const roomAt = (p: Point): string => {
    const r = rooms.find((room) => containsPoint(shapeBounds(room.shape), p));
    return r ? `in ${roomName(r)}` : 'outside rooms';
  };
  if (props.length) {
    const groups = new Map<string, Map<string, string[]>>();
    for (const p of props) {
      const where = roomAt(p.at);
      const byAsset = groups.get(where) ?? new Map<string, string[]>();
      byAsset.set(p.asset, [...(byAsset.get(p.asset) ?? []), p.id]);
      groups.set(where, byAsset);
    }
    lines.push('Props:');
    for (const [where, byAsset] of groups) {
      lines.push(`  ${where}: ${[...byAsset].map(([asset, ids]) => `${assetInfo(asset)?.name ?? asset} (${ids.join(', ')})`).join(', ')}`);
    }
  }
  if (terrain.length) {
    lines.push(
      `Terrain: ${terrain
        .map((t) => {
          const b = shapeBounds(t.shape);
          const info = assetInfo(t.asset);
          return `${t.id} ${info?.name ?? t.asset}${info?.difficult ? ' (difficult)' : ''} ${fmt(b.x1 - b.x0)}×${fmt(b.y1 - b.y0)} ${t.holes?.length ? `at ${fmt(b.x0)},${fmt(b.y0)} with ${t.holes.length} hole${t.holes.length === 1 ? '' : 's'} (the floor inside it stays clear)` : roomAt([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2])}`;
        })
        .join('; ')}`,
    );
  }
  if (images.length) {
    lines.push('Images (uploaded pictures):');
    for (const i of images) {
      const how = [i.layer === 'floor' ? 'on the floor' : '', i.rotation ? `turned ${fmt(i.rotation)}°` : '', i.opacity !== undefined && i.opacity !== 1 ? `opacity ${fmt(i.opacity)}` : '', i.gmOnly ? 'GM only' : ''].filter(Boolean);
      lines.push(`  ${i.id}${i.name ? ` "${i.name}"` : ''}: ${fmt(i.w)}×${fmt(i.h)} sq centred at ${fmt(i.at[0])},${fmt(i.at[1])} ${roomAt(i.at)}${how.length ? `, ${how.join(', ')}` : ''} (src ${i.src})`);
    }
  }
  if (markers.length) {
    lines.push('GM markers (GM view only):');
    for (const m of markers) {
      lines.push(`  ${MARKERS[m.kind].symbol} ${m.id} at ${fmt(m.at[0])},${fmt(m.at[1])} ${roomAt(m.at)}${m.done ? ' (done)' : ''}: ${m.text ? JSON.stringify(m.text) : '(no text)'}`);
    }
  }
  const connectors = map.objects.filter(isConnector);
  if (connectors.some((o) => 'label' in o && o.label)) {
    lines.push(`Stair labels (GM view): ${connectors.map((o) => `${o.id} ${('label' in o && o.label) || '(none)'}`).join(', ')}`);
  }
  if (others.length) {
    const counts = new Map<string, number>();
    for (const o of others) counts.set(o.type, (counts.get(o.type) ?? 0) + 1);
    lines.push(`Also: ${[...counts].map(([t, n]) => `${n} ${t}`).join(', ')}`);
  }
  // the GM's prep (descriptions, monsters, loot): for the GM and Claude, never drawn
  const noted = map.objects.filter(hasNotes);
  if (noted.length) {
    const max = opts.notesMax ?? Infinity;
    const cut = (s: string): string => (s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s);
    lines.push('GM notes (GM only, never drawn):');
    for (const o of noted) {
      const title = isNoteArea(o) ? areaTitle(map, o) : `${o.type}${o.name ? ` ${o.name}` : ''}`;
      lines.push(`  ${title} [${o.id}]: ${JSON.stringify(cut(o.notes!.trim()))}`);
    }
  }
  const fog = fogSummary(map);
  if (fog) lines.push(fog);
  return lines.join('\n');
}
