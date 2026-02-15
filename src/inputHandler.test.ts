import { describe, expect, test } from 'bun:test';
import {
  getForcedTmuxMouseCoordinateMode,
  nextTmuxMouseCoordinateMode,
  normalizeTmuxMouseCoordinates,
} from './tty/mouseCoordinates';

describe('inputHandler tmux mouse normalization', () => {
  test('parses forced tmux coordinate mode override', () => {
    expect(getForcedTmuxMouseCoordinateMode('cell')).toBe('cell');
    expect(getForcedTmuxMouseCoordinateMode('pixel')).toBe('pixel');
    expect(getForcedTmuxMouseCoordinateMode('  PIXEL  ')).toBe('pixel');
    expect(getForcedTmuxMouseCoordinateMode('auto')).toBeNull();
    expect(getForcedTmuxMouseCoordinateMode(undefined)).toBeNull();
  });

  test('normalizes cell coordinates into pixels in cell mode', () => {
    const termSize = { cols: 100, rows: 40, width: 1000, height: 800 };
    const point = normalizeTmuxMouseCoordinates(10, 5, termSize, 'cell');
    expect(point).toEqual({ x: 100, y: 100 });
  });

  test('passes coordinates through in pixel mode', () => {
    const termSize = { cols: 100, rows: 40, width: 1000, height: 800 };
    const point = normalizeTmuxMouseCoordinates(42, 17, termSize, 'pixel');
    expect(point).toEqual({ x: 42, y: 17 });
  });

  test('detects cell mode from in-bounds tmux coordinates', () => {
    const termSize = { cols: 100, rows: 40, width: 1000, height: 800 };
    const mode = nextTmuxMouseCoordinateMode(20, 10, termSize, 'unknown');
    expect(mode).toBe('cell');
  });

  test('detects pixel mode from out-of-bounds tmux coordinates', () => {
    const termSize = { cols: 100, rows: 40, width: 1000, height: 800 };
    const mode = nextTmuxMouseCoordinateMode(102, 10, termSize, 'unknown');
    expect(mode).toBe('pixel');
  });

  test('forced pixel mode overrides auto-detection', () => {
    const termSize = { cols: 100, rows: 40, width: 1000, height: 800 };
    const mode = nextTmuxMouseCoordinateMode(10, 10, termSize, 'unknown', 'pixel');
    expect(mode).toBe('pixel');
  });
});
