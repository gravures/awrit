import { describe, expect, mock, test } from 'bun:test';
import {
  getForcedTmuxMouseCoordinateMode,
  nextTmuxMouseCoordinateMode,
  normalizeTmuxMouseCoordinates,
} from './tty/mouseCoordinates';

// inputHandler imports windows.ts (electron); stub it so the pure wheel helper is testable
mock.module('./windows', () => ({
  focusedView: { current: null },
  setTerminalIsFocused: () => {},
  updateFrameRates: () => {},
}));
const { buildWheelEvent, shouldSendMouseMove } = await import('./inputHandler');

describe('buildWheelEvent', () => {
  test('scrollUp/scrollDown produce Y-only wheel deltas', () => {
    expect(buildWheelEvent('scrollUp', [], 0, 0)).toMatchObject({
      wheelTicksY: 1,
      wheelTicksX: 0,
      deltaX: 0,
      deltaY: 100,
    });
    expect(buildWheelEvent('scrollDown', [], 0, 0)).toMatchObject({
      wheelTicksY: -1,
      wheelTicksX: 0,
      deltaX: 0,
      deltaY: -100,
    });
  });

  test('scrollRight/scrollLeft produce X-only wheel deltas', () => {
    expect(buildWheelEvent('scrollRight', ['shift'], 5, 6)).toMatchObject({
      wheelTicksX: 1,
      wheelTicksY: 0,
      deltaX: 100,
      deltaY: 0,
      x: 5,
      y: 6,
    });
    expect(buildWheelEvent('scrollLeft', ['shift'], 5, 6)).toMatchObject({
      wheelTicksX: -1,
      wheelTicksY: 0,
      deltaX: -100,
      deltaY: 0,
    });
  });

  test('scale halves deltas (constant page fraction per tick) but not wheel ticks', () => {
    expect(buildWheelEvent('scrollDown', [], 0, 0, 2)).toMatchObject({
      deltaY: -50,
      deltaX: 0,
      wheelTicksY: -1,
      wheelTicksX: 0,
    });
    expect(buildWheelEvent('scrollRight', ['shift'], 5, 6, 2)).toMatchObject({
      deltaX: 50,
      deltaY: 0,
      wheelTicksX: 1,
      x: 5,
      y: 6,
    });
    // fractional scales (displayScale × rasterScale need not be integer)
    expect(buildWheelEvent('scrollDown', [], 0, 0, 1.5).deltaY).toBeCloseTo(-200 / 3);
  });
});

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

describe('shouldSendMouseMove', () => {
  const base = { view: { name: 'content' }, x: 10, y: 20, modifiers: [] };

  test('first move (no previous state) is always sent', () => {
    expect(shouldSendMouseMove(undefined, base)).toBe(true);
  });

  test('identical move is skipped', () => {
    expect(shouldSendMouseMove({ ...base }, { ...base })).toBe(false);
  });

  test('different coordinates are sent', () => {
    expect(shouldSendMouseMove(base, { ...base, x: 11 })).toBe(true);
    expect(shouldSendMouseMove(base, { ...base, y: 21 })).toBe(true);
  });

  test('different target view is sent', () => {
    expect(shouldSendMouseMove(base, { ...base, view: { name: 'toolbar' } })).toBe(true);
  });

  test('different modifiers are sent', () => {
    expect(shouldSendMouseMove(base, { ...base, modifiers: ['shift'] })).toBe(true);
    expect(
      shouldSendMouseMove({ ...base, modifiers: ['shift'] }, { ...base, modifiers: [] }),
    ).toBe(true);
  });
});
