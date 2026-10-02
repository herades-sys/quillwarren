// The editor's doors at any angle: the Door tool's drag, the Prop picker's
// door snapping onto walls, turning with Q / E and stretching by an end.
import { computeFloor, computeWalls, doorAngle, doorSegment, shapeFromBox, type DelveMap, type Door, type MapObject, type Point } from '@delve/core';
import { describe, expect, it } from 'vitest';
import { doorDrag, doorEndAt, doorUpdate, pickerDoor, stretchDoor, turnDoor } from '../src/edit-logic.ts';
import { doorTileSvg } from '../src/door-tiles.ts';

const mapOf = (objects: MapObject[]): DelveMap => ({ format: 'delve.map', version: 1, id: 'm', name: 'm', grid: { type: 'square' }, objects });
const rect = mapOf([{ id: 'r1', type: 'room', shape: { rect: [0, 0, 8, 6] } }]);
const octagon = mapOf([{ id: 'r1', type: 'room', shape: shapeFromBox('octagon', [0, 0, 10, 10]) }]);
const circle = mapOf([{ id: 'r1', type: 'room', shape: { circle: [10, 10, 4] } }]);
const door = (f: Partial<Door>): Door => ({ id: 'd1', type: 'door', at: [0, 0], along: 'x', width: 1, ...f });

describe('the Door tool’s drag', () => {
  it('makes the old door along x or y when the drag is near an axis', () => {
    const floor = computeFloor(rect);
    expect(doorDrag(floor, [2, 0], [4, 0.1])).toEqual({ at: [2, 0], along: 'x', width: 2 });
    expect(doorDrag(floor, [8, 4], [8, 2])).toEqual({ at: [8, 2], along: 'y', width: 2 });
    expect(doorDrag(floor, [2, 0], [2.2, 0])).toBeNull();
  });

  it('makes a turned door along a slanted wall, its ends put onto the wall', () => {
    const floor = computeFloor(octagon);
    // the octagon's north-west wall runs from about (0, 2.93) to (2.93, 0)
    const d = doorDrag(floor, [0, 3], [2, 1], 0.5, [0.4, 2.7], [2.1, 1.1])!;
    expect(d.angle).toBeCloseTo(135, 1);
    const map = mapOf([...octagon.objects, { id: 'd1', type: 'door', ...d }]);
    expect(computeWalls(map).length).toBeGreaterThan(computeWalls(octagon).length);
  });

  it('turns a near-axis door that couldn’t open the curve it lies on', () => {
    const d = doorDrag(computeFloor(circle), [9.5, 6], [10.5, 6])!;
    expect(d).toMatchObject({ along: 'x', angle: 0, width: 1 });
  });
});

describe('the Prop picker’s doors', () => {
  it('snap onto a plain wall, ends on grid lines, without an angle', () => {
    const { door: d, onWall } = pickerDoor(computeFloor(rect), [3.3, 0.4], 1, 0, 1);
    expect(onWall).toBe(true);
    expect(d).toEqual({ at: [3, 0], along: 'x', width: 1 });
    expect(pickerDoor(computeFloor(rect), [7.8, 3.1], 2, 45, 1).door).toEqual({ at: [8, 2], along: 'y', width: 2 });
  });

  it('snap onto slanted and curved walls, turned to the wall there', () => {
    const slanted = pickerDoor(computeFloor(octagon), [1.3, 1.3], 2, 0, 1);
    expect(slanted.onWall).toBe(true);
    expect(doorAngle({ ...slanted.door })).toBeCloseTo(135, 1);
    const curved = pickerDoor(computeFloor(circle), [12.9, 7.3], 1, 0, 1).door;
    for (const end of doorSegment(curved)) expect(Math.hypot(end[0] - 10, end[1] - 10)).toBeCloseTo(4, 2);
  });

  it('use the current turn away from walls', () => {
    const { door: d, onWall } = pickerDoor(computeFloor(rect), [4, 3], 1, 30, 1);
    expect(onWall).toBe(false);
    expect(d.angle).toBe(30);
    expect(pickerDoor(computeFloor(rect), [4, 3], 2, 90, 1).door).toEqual({ at: [4, 2], along: 'y', width: 2 });
  });
});

describe('editing a placed door', () => {
  it('turns about its middle with Q / E, back to the old form on a quarter turn', () => {
    const floor = computeFloor(rect);
    const d = door({ at: [2, 0], width: 2 });
    const t = turnDoor(floor, d, 15);
    expect(t.angle).toBe(15);
    const mid = (f: Pick<Door, 'at' | 'along' | 'angle' | 'width'>): Point => {
      const [a, b] = doorSegment(f);
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    };
    expect(mid(t)[0]).toBeCloseTo(3, 6);
    expect(mid(t)[1]).toBeCloseTo(0, 6);
    expect(turnDoor(floor, { ...d, ...t }, 90)).toEqual({ at: [3, -1], along: 'y', width: 2 });
    expect(doorUpdate({ ...d, ...t }, turnDoor(floor, { ...d, ...t }, 90))).toEqual({ op: 'update', id: 'd1', set: { at: [3, -1], along: 'y' }, unset: ['angle'] });
    expect(doorUpdate(d, { at: [2, 0], along: 'x', width: 2 })).toBeNull();
  });

  it('gets wider or narrower by an end, keeping its line', () => {
    const floor = computeFloor(rect);
    const d = door({ at: [2, 0], width: 2 });
    expect(doorEndAt(d, [4.1, 0.1], 0.3)).toBe(1);
    expect(doorEndAt(d, [1.9, 0], 0.3)).toBe(0);
    expect(doorEndAt(d, [3, 0], 0.3)).toBeNull();
    expect(stretchDoor(floor, d, 1, [5.2, 0.4], 0.5)).toEqual({ at: [2, 0], along: 'x', width: 3 });
    expect(stretchDoor(floor, d, 0, [3.6, 0], 0.5)).toEqual({ at: [3.5, 0], along: 'x', width: 0.5 });
    // a turned door in a curve: the dragged end follows the wall
    const ofCircle = computeFloor(circle);
    const c = { ...door({}), ...pickerDoor(ofCircle, [10, 6], 1, 0, 1).door };
    const wider = stretchDoor(ofCircle, c, 1, [11.6, 6.4], 0.5);
    for (const end of doorSegment(wider)) expect(Math.hypot(end[0] - 10, end[1] - 10)).toBeCloseTo(4, 2);
    expect(wider.width).toBeGreaterThan(1.4);
  });
});

describe('door tiles', () => {
  it('are drawn by the map renderer, in the map’s style', () => {
    const svg = doorTileSvg('portcullis', { style: { preset: 'parchment' } });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('door-marks');
    expect(doorTileSvg('secret', {})).toContain('>S<');
  });
});
