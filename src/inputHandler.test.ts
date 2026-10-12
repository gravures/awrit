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
    toolbarFocused: false,
    searchEngine: 'https://duckduckgo.com/?q=',
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
    expect(shouldSendMouseMove(base, { ...base, view: { name: 'toolbar' } })).toBe(true);
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

describe('inputHandler keybinding: focus-url focuses toolbar', () => {
  test('ctrl+o focuses toolbar', async () => {
    const { focusedView } = await import('./windows');
    const { features } = await import('./features');
    const { handleInput } = await import('./inputHandler');

    const mockToolbar = {
      webContents: {
        focus: mock(() => {}),
        send: mock(() => {}),
      },
      focusOnWebView: mock(() => {}),
    };
    const mockContent = {
      webContents: {
        sendInputEvent: mock(() => {}),
      },
      focusOnWebView: mock(() => {}),
      blurWebView: mock(() => {}),
    };
    const mockView = {
      toolbar: mockToolbar,
      content: mockContent,
      focusedContent: mockContent.webContents,
    };

    focusedView.current = mockView;
    features.toolbarFocused = false;
    loadKeyBindings({ keybindings: DEFAULT_KEYBINDINGS }, actions);

    // `focus-url` is bound to ctrl+o in the shipped defaults
    const evt = {
      eventType: 'key',
      keyEvent: {
        code: 'o',
        modifiers: ['ctrl'],
        down: true,
        isCharEvent: false,
      },
    } as any;

    handleInput(evt);

    expect(mockContent.blurWebView).toHaveBeenCalled();
    expect(mockToolbar.focusOnWebView).toHaveBeenCalled();
    expect(mockToolbar.webContents.send).toHaveBeenCalledWith('toolbar:focus-url');
    expect(features.toolbarFocused).toBe(true);
    expect(mockView.focusedContent).toBe(mockToolbar.webContents);
  });

  test('bare o does not focus toolbar (it reaches the page)', async () => {
    const { focusedView } = await import('./windows');
    const { features } = await import('./features');
    const { handleInput } = await import('./inputHandler');

    const mockToolbar = {
      webContents: {
        focus: mock(() => {}),
        send: mock(() => {}),
      },
    };
    const mockContent = {
      webContents: {
        sendInputEvent: mock(() => {}),
      },
      focusOnWebView: mock(() => {}),
      blurWebView: mock(() => {}),
    };
    const mockView = {
      toolbar: mockToolbar,
      content: mockContent,
      focusedContent: mockContent.webContents,
    };

    focusedView.current = mockView;
    features.toolbarFocused = false;
    loadKeyBindings({ keybindings: DEFAULT_KEYBINDINGS }, actions);

    const evt = {
      eventType: 'key',
      keyEvent: {
        code: 'o',
        modifiers: [],
        down: true,
        isCharEvent: false,
      },
    } as any;

    handleInput(evt);

    expect(mockToolbar.webContents.focus).not.toHaveBeenCalled();
    expect(features.toolbarFocused).toBe(false);
  });
});

describe('inputHandler keybinding: escape returns focus to page', () => {
  test('escape key when toolbar focused returns focus to page', async () => {
    const { focusedView } = await import('./windows');
    const { features } = await import('./features');
    const { handleInput } = await import('./inputHandler');

    const mockToolbar = {
      webContents: {
        send: mock(() => {}),
      },
      blurWebView: mock(() => {}),
    };
    const mockContent = {
      webContents: {
        sendInputEvent: mock(() => {}),
      },
      focusOnWebView: mock(() => {}),
      blurWebView: mock(() => {}),
    };
    const mockView = {
      toolbar: mockToolbar,
      content: mockContent,
      focusedContent: mockToolbar.webContents,
    };

    focusedView.current = mockView;
    features.toolbarFocused = true;

    const evt = {
      eventType: 'key',
      keyEvent: {
        code: 'escape',
        modifiers: [],
        down: true,
        isCharEvent: false,
      },
    } as any;

    handleInput(evt);

    expect(mockContent.focusOnWebView).toHaveBeenCalled();
    expect(mockToolbar.blurWebView).toHaveBeenCalled();
    expect(features.toolbarFocused).toBe(false);
    expect(mockToolbar.webContents.send).toHaveBeenCalledWith('toolbar:blur-url');
    expect(mockView.focusedContent).toBe(mockContent.webContents);
  });

  test('escape key when toolbar not focused does nothing', async () => {
    const { focusedView } = await import('./windows');
    const { features } = await import('./features');
    const { handleInput } = await import('./inputHandler');

    const mockToolbar = {
      webContents: {
        send: mock(() => {}),
      },
      blurWebView: mock(() => {}),
    };
    const mockContent = {
      webContents: {
        sendInputEvent: mock(() => {}),
      },
      focusOnWebView: mock(() => {}),
      blurWebView: mock(() => {}),
    };
    const mockView = {
      toolbar: mockToolbar,
      content: mockContent,
      focusedContent: mockContent.webContents,
    };

    focusedView.current = mockView;
    features.toolbarFocused = false;

    const evt = {
      eventType: 'key',
      keyEvent: {
        code: 'escape',
        modifiers: [],
        down: true,
        isCharEvent: false,
      },
    } as any;

    handleInput(evt);

    expect(mockContent.focusOnWebView).not.toHaveBeenCalled();
    expect(mockToolbar.blurWebView).not.toHaveBeenCalled();
  });
});
