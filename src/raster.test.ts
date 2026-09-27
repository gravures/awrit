import { describe, expect, test } from 'bun:test';
import { cellSpan, getRasterScale, rasterCellToPx, setPaneToBitmap, setRasterScale } from './raster';

// The pane this was measured on: 103x27 cells of 19x42 device px.
const PANE = { cols: 103, rows: 27, width: 1957, height: 1134 };

// What windows.ts records: bitmap px per pane px, at display scale 1.
const at = (raster: number) => setPaneToBitmap(1 / raster);

describe('raster scale', () => {
  test('rejects anything that is not a positive finite number', () => {
    setRasterScale(undefined);
    expect(getRasterScale()).toBe(1);
    setRasterScale(0);
    expect(getRasterScale()).toBe(1);
    setRasterScale(-2);
    expect(getRasterScale()).toBe(1);
    setRasterScale(Number.NaN);
    expect(getRasterScale()).toBe(1);
    setRasterScale('2');
    expect(getRasterScale()).toBe(1);
    setRasterScale(1);
  });

  test('fractional scales are allowed', () => {
    setRasterScale(1.5);
    expect(getRasterScale()).toBe(1.5);
    setRasterScale(1);
  });

  test('raster cells stay under the bitmap so cols/rows are not halved', () => {
    // At 1 the bitmap is the pane: 103 cols of 19px fills 1957px exactly.
    at(1);
    expect(rasterCellToPx(PANE).x).toBeCloseTo(19);

    // At 2 the bitmap is 978px, so a cell must be 9.5px for 103 cols to fit —
    // pane-space cells (19px) would say the bitmap holds 52 columns.
    at(2);
    const half = rasterCellToPx(PANE);
    expect(half.x).toBeCloseTo(9.5);
    expect(Math.ceil(978 / half.x)).toBe(103);
  });

  test('display scale 2 with rasterScale 2 is 1:1, not a second halving', () => {
    // bitmap = contentDIP x displayScale, so the two factors are one ratio.
    setRasterScale(2);
    setPaneToBitmap(1); // displayScale 2 / rasterScale 2
    expect(rasterCellToPx(PANE).x).toBeCloseTo(19);
  });

  test('degenerate pane falls back to 1px cells instead of dividing by zero', () => {
    at(2);
    expect(rasterCellToPx({ cols: 0, rows: 0, width: 0, height: 0 })).toEqual({ x: 0.5, y: 0.5 });
    at(1);
  });
});

describe('cell span', () => {
  test('a halved bitmap still claims the full pane', () => {
    at(2);
    // Content is the pane minus a whole-cell toolbar, so it is 103x26 cells:
    // 978px of bitmap over 103 cols, 546px over 26 rows.
    expect(cellSpan({ width: 978, height: 546 }, PANE)).toEqual({ cols: 103, rows: 26 });
  });

  test('aspect stays within a pixel of the cell rect or the terminal letterboxes', () => {
    at(2);
    const bitmap = { width: 978, height: 546 };
    const { cols, rows } = cellSpan(bitmap, PANE);
    const cellW = 19;
    const cellH = 42;
    const stretch = (cols * cellW) / bitmap.width / ((rows * cellH) / bitmap.height);
    expect(Math.abs(stretch - 1)).toBeLessThan(0.002);
  });

  test('a bitmap of zero is at least one cell', () => {
    at(2);
    expect(cellSpan({ width: 0, height: 0 }, PANE)).toEqual({ cols: 1, rows: 1 });
  });
});
