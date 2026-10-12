import { describe, expect, mock, test } from 'bun:test';
import {
  getForcedTmuxMouseCoordinateMode,
  nextTmuxMouseCoordinateMode,
  normalizeTmuxMouseCoordinates,
} from './tty/mouseCoordinates';

// Stub console for debug logging
mock.module('./console', () => ({
  console_: {
    log: () => {},
    error: () => {},
  },
}));

// inputHandler imports windows.ts (electron); stub it so the pure wheel helper is testable
mock.module('./windows', () => ({
  focusedView: { current: null },
  setTerminalIsFocused: () => {},
  updateFrameRates: () => {},
}));

// Stub features for keybinding tests
mock.module('./features', () => ({
  features: {
    current: undefined,
    searchEngine: 'https://duckduckgo.com/?q=',
    bar: { mode: 'normal', buffer: '', cursor: 0, url: '' },
  },
}));

const { buildWheelEvent, shouldSendMouseMove, sanitizePaste } = await import('./inputHandler');
const { loadKeyBindings } = await import('./keybindings');
const { actions } = await import('./actions');
const { DEFAULT_KEYBINDINGS } = await import('./config');

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

  test('normalizes cell coordinates to the cell center in cell mode', () => {
    const termSize = { cols: 100, rows: 40, width: 1000, height: 800 };
    const point = normalizeTmuxMouseCoordinates(10, 5, termSize, 'cell');
    expect(point).toEqual({ x: 105, y: 110 });
  });

  test('maps the first row to the middle of the first cell, not y=0', () => {
    const termSize = { cols: 100, rows: 40, width: 1000, height: 800 };
    const point = normalizeTmuxMouseCoordinates(0, 0, termSize, 'cell');
    expect(point).toEqual({ x: 5, y: 10 });
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
    expect(shouldSendMouseMove(base, { ...base, view: { name: 'other' } })).toBe(true);
  });

  test('different modifiers are sent', () => {
    expect(shouldSendMouseMove(base, { ...base, modifiers: ['shift'] })).toBe(true);
    expect(
      shouldSendMouseMove({ ...base, modifiers: ['shift'] }, { ...base, modifiers: [] }),
    ).toBe(true);
  });
});

describe('sanitizePaste', () => {
  test('removes bracketed-paste markers', () => {
    expect(sanitizePaste('\x1b[200~hello\x1b[201~')).toBe('hello');
  });

  test('removes embedded CSI sequences, keeps surrounding text', () => {
    expect(sanitizePaste('before\x1b[31mred\x1b[0mafter')).toBe('beforeredafter');
  });

  test('empty input and marker-only returns empty string', () => {
    expect(sanitizePaste('')).toBe('');
    expect(sanitizePaste('\x1b[200~\x1b[201~')).toBe('');
  });

  test('preserves multiline text', () => {
    expect(sanitizePaste('line1\nline2\nline3')).toBe('line1\nline2\nline3');
  });

  test('strips OSC sequences', () => {
    expect(sanitizePaste('\x1b]0;title\x07text')).toBe('text');
  });

  test('strips bare ESC and C1 CSI', () => {
    expect(sanitizePaste('\x1bescape')).toBe('escape');
    expect(sanitizePaste('\x9bCSI')).toBe('CSI');
  });

  test('preserves Unicode, tabs, newlines', () => {
    expect(sanitizePaste('hello\tworld\n🎉')).toBe('hello\tworld\n🎉');
  });
});

function makeView() {
  const webContents = {
    sendInputEvent: mock(() => {}),
    loadURL: mock(() => {}),
    findInPage: mock(() => {}),
    stopFindInPage: mock(() => {}),
    insertText: mock(() => {}),
    selectAll: mock(() => {}),
    getURL: mock(() => 'https://example.com'),
  };
  return {
    content: { webContents },
    layoutContainer: { devicePixelRatio: 1 },
  };
}

const key = (code: string, over: Partial<Record<string, unknown>> = {}) => ({
  eventType: 'key',
  keyEvent: { code, modifiers: [], down: true, isCharEvent: false, ...over },
});

describe('inputHandler bar: focus-url enters URL editing', () => {
  test('ctrl+o enters normal-editing with the current URL', async () => {
    const { focusedView } = await import('./windows');
    const { features } = await import('./features');
    const { handleInput } = await import('./inputHandler');

    const view = makeView();
    focusedView.current = view as any;
    features.bar.mode = 'normal';
    features.bar.buffer = '';
    features.bar.cursor = 0;
    loadKeyBindings({ keybindings: DEFAULT_KEYBINDINGS }, actions);

    handleInput(key('o', { modifiers: ['ctrl'] }) as any);

    expect(features.bar.mode).toBe('normal-editing');
    expect(features.bar.buffer).toBe('https://example.com');
    expect(features.bar.cursor).toBe('https://example.com'.length);
    expect(view.content.webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  test('bare o reaches the page instead of starting an edit', async () => {
    const { focusedView } = await import('./windows');
    const { features } = await import('./features');
    const { handleInput } = await import('./inputHandler');

    const view = makeView();
    focusedView.current = view as any;
    features.bar.mode = 'normal';
    loadKeyBindings({ keybindings: DEFAULT_KEYBINDINGS }, actions);

    handleInput(key('o') as any);

    expect(features.bar.mode).toBe('normal');
    expect(view.content.webContents.sendInputEvent).toHaveBeenCalled();
  });
});

describe('inputHandler bar: editing keys', () => {
  async function setup() {
    const { focusedView } = await import('./windows');
    const { features } = await import('./features');
    const { handleInput } = await import('./inputHandler');
    const view = makeView();
    focusedView.current = view as any;
    loadKeyBindings({ keybindings: DEFAULT_KEYBINDINGS }, actions);
    return { view, features, handleInput };
  }

  test('typing edits the buffer locally and never reaches the page', async () => {
    const { view, features, handleInput } = await setup();
    features.bar.mode = 'normal-editing';
    features.bar.buffer = '';
    features.bar.cursor = 0;

    handleInput(key('a', { isCharEvent: true }) as any);

    expect(features.bar.buffer).toBe('a');
    expect(features.bar.cursor).toBe(1);
    expect(view.content.webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  test('space inserts a literal space', async () => {
    const { features, handleInput } = await setup();
    features.bar.mode = 'normal-editing';
    features.bar.buffer = 'a';
    features.bar.cursor = 1;

    handleInput(key('space', { isCharEvent: true }) as any);

    expect(features.bar.buffer).toBe('a ');
  });

  test('backspace deletes before the cursor', async () => {
    const { features, handleInput } = await setup();
    features.bar.mode = 'normal-editing';
    features.bar.buffer = 'abc';
    features.bar.cursor = 2;

    handleInput(key('backspace') as any);

    expect(features.bar.buffer).toBe('ac');
    expect(features.bar.cursor).toBe(1);
  });

  test('Enter on a bare host navigates (normalized) and returns to normal', async () => {
    const { view, features, handleInput } = await setup();
    features.bar.mode = 'normal-editing';
    features.bar.buffer = 'example.com';
    features.bar.cursor = 'example.com'.length;

    handleInput(key('return', { isCharEvent: true }) as any);

    expect(view.content.webContents.loadURL).toHaveBeenCalledWith('https://example.com');
    expect(features.bar.mode).toBe('normal');
  });

  test('Enter on a phrase searches via the configured engine', async () => {
    const { view, features, handleInput } = await setup();
    features.bar.mode = 'normal-editing';
    features.bar.buffer = 'hello world';
    features.bar.cursor = 'hello world'.length;

    handleInput(key('return', { isCharEvent: true }) as any);

    expect(view.content.webContents.loadURL).toHaveBeenCalledWith(
      'https://duckduckgo.com/?q=hello%20world',
    );
    expect(features.bar.mode).toBe('normal');
  });

  test('Esc abandons the edit and returns to normal', async () => {
    const { features, handleInput } = await setup();
    features.bar.mode = 'normal-editing';
    features.bar.buffer = 'junk';
    features.bar.cursor = 4;

    handleInput(key('escape') as any);

    expect(features.bar.mode).toBe('normal');
    expect(features.bar.buffer).toBe('');
    expect(features.bar.cursor).toBe(0);
  });

  test('Enter in find-editing starts a forward find and switches to find', async () => {
    const { view, features, handleInput } = await setup();
    features.bar.mode = 'find-editing';
    features.bar.buffer = 'needle';
    features.bar.cursor = 6;
    features.bar.findCount = { index: 3, total: 9 };

    handleInput(key('return', { isCharEvent: true }) as any);

    expect(view.content.webContents.findInPage).toHaveBeenCalledWith('needle', { forward: true });
    expect(features.bar.mode).toBe('find');
    expect(features.bar.findCount).toEqual({ index: 0, total: 0 }); // cleared until found-in-page
  });

  test('Esc while finding clears the selection and the counter', async () => {
    const { view, features, handleInput } = await setup();
    features.bar.mode = 'find';
    features.bar.buffer = 'needle';
    features.bar.findCount = { index: 2, total: 5 };

    handleInput(key('escape') as any);

    expect(view.content.webContents.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(features.bar.mode).toBe('normal');
    expect(features.bar.findCount).toEqual({ index: 0, total: 0 });
  });
});
