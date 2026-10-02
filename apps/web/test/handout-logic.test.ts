// The handout page's Notes tool: sheet points and map squares, the pen, and the ops a change becomes.
import { applyOps, FORMAT, FORMAT_VERSION, type DelveMap, type Inscription } from '@delve/core';
import { describe, expect, it } from 'vitest';
import { cleanText, defaultPen, newNote, noteUpdate, parseFrame, pointsToSize, sheetToSquares, sizeInPoints, slightTilt, squaresToSheet, withUpdate } from '../src/handout-logic.ts';

const frame = { w: 595.28, h: 841.89, x: 75.32, y: 105.56, k: 18.5, x0: -2, y0: -2 };
const map = (objects: DelveMap['objects'] = []): DelveMap => ({ format: FORMAT, version: FORMAT_VERSION, id: 'map_x', name: 'X', grid: { type: 'square' }, objects });

describe('handout notes tool', () => {
  it('reads the frame header, and refuses a broken one', () => {
    expect(parseFrame(JSON.stringify(frame))).toEqual(frame);
    expect(parseFrame(null)).toBeNull();
    expect(parseFrame('{"w":1}')).toBeNull();
    expect(parseFrame(JSON.stringify({ ...frame, k: 0 }))).toBeNull();
    expect(parseFrame('not json')).toBeNull();
  });

  it('turns a point on the sheet into map squares and back', () => {
    expect(sheetToSquares(frame, frame.x, frame.y)).toEqual([-2, -2]);
    expect(sheetToSquares(frame, frame.x + 18.5 * 10, frame.y + 18.5 * 4.5)).toEqual([8, 2.5]);
    const [X, Y] = squaresToSheet(frame, [8, 2.5]);
    expect(X).toBeCloseTo(frame.x + 185);
    expect(Y).toBeCloseTo(frame.y + 83.25);
    // the margin is fine too: notes may sit outside the map
    expect(sheetToSquares(frame, 10, 10)[0]).toBeLessThan(-2);
  });

  it('sizes notes in points on the sheet and stores squares', () => {
    expect(sizeInPoints(frame, undefined)).toBe(15); // 0.8 squares
    expect(pointsToSize(frame, 37)).toBe(2);
    expect(pointsToSize(frame, 0)).toBe(0.05);
    expect(defaultPen(frame)).toEqual({ size: 0.8, ink: 'brown', onMap: false }); // 15 pt: fine as it is
    expect(defaultPen({ ...frame, k: 3 }).size).toBe(4.67); // a city: 0.8 squares would be 2.4 pt
    expect(defaultPen({ ...frame, k: 60 }).size).toBe(0.23); // one small room: 48 pt
    expect(defaultPen(null).size).toBe(0.8);
  });

  it('tidies the typed text', () => {
    expect(cleanText('\n\n  Here be\r\ndragons   \n\n')).toBe('  Here be\ndragons');
    expect(cleanText('   ')).toBe('');
    expect(cleanText('x'.repeat(400))).toHaveLength(300);
  });

  it('makes new notes with the next free w id, leaving defaults out', () => {
    const m = map([{ id: 'w1', type: 'inscription', text: 'a', at: [0, 0] }]);
    const note = newNote(m, 'Here be dragons', [3, 4], { size: 0.8, ink: 'brown', onMap: false }, 0);
    expect(note).toEqual({ id: 'w2', type: 'inscription', text: 'Here be dragons', at: [3, 4] });
    expect(newNote(m, 'b', [0, 0], { size: 1.2, ink: 'red', onMap: true }, -2, ['w2'])).toEqual({ id: 'w3', type: 'inscription', text: 'b', at: [0, 0], size: 1.2, rotation: -2, ink: 'red', onMap: true });
    expect(() => applyOps(m, [{ op: 'add', object: note }])).not.toThrow();
    for (let i = 0; i < 20; i++) expect(Math.abs(slightTilt(i / 20))).toBeLessThanOrEqual(3);
    expect(slightTilt(0.999)).toBe(3);
  });

  it('changes notes with update ops that unset the defaults', () => {
    const o: Inscription = { id: 'w1', type: 'inscription', text: 'a', at: [0, 0], ink: 'red', size: 1.5 };
    expect(noteUpdate(o, { ink: 'brown', size: 0.8, onMap: true })).toEqual({ op: 'update', id: 'w1', set: { onMap: true }, unset: ['ink', 'size'] });
    expect(noteUpdate(o, { ink: 'red' })).toBeNull();
    expect(noteUpdate(o, { at: [1, 2] })).toEqual({ op: 'update', id: 'w1', set: { at: [1, 2] } });
    expect(noteUpdate(o, { rotation: 0 })).toBeNull();
    const op = noteUpdate(o, { text: 'b', ink: 'black' })!;
    expect(withUpdate(o, op)).toEqual({ ...o, text: 'b', ink: 'black' });
    expect(applyOps(map([o]), [op]).map.objects[0]).toEqual(withUpdate(o, op));
  });
});
