import { describe, expect, test, beforeEach } from 'bun:test';
import { loadKeyBindings, handleEvent } from './keybindings';
import type { TermEvent } from './native';
import { fakeTimers } from './fake-timers.test';

describe('Keybindings System', () => {
  const clock = fakeTimers();

  beforeEach(() => {
    // Clear bindings before each test
    loadKeyBindings({ keybindings: {} });
  });

  test('parse simple keybinding', () => {
    const config = {
      keybindings: {
        '<C-s>': () => {},
      },
    };
    loadKeyBindings(config);

    const event: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 's',
        modifiers: ['ctrl'],
        down: true,
        isCharEvent: false,
      },
    };

    expect(handleEvent(event)).toBe(true);
  });

  test('parse multi-key binding', () => {
    const config = {
      keybindings: {
        '<C-w>l': () => {},
      },
    };
    loadKeyBindings(config);

    // First key press
    const event1: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 'w',
        modifiers: ['ctrl'],
        down: true,
        isCharEvent: false,
      },
    };
    expect(handleEvent(event1)).toBe(false);

    // Second key press
    const event2: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 'l',
        modifiers: [],
        down: true,
        isCharEvent: false,
      },
    };
    expect(handleEvent(event2)).toBe(true);
  });

  test('handle modifier order consistently', () => {
    const config = {
      keybindings: {
        '<C-A-s>': () => {},
      },
    };
    loadKeyBindings(config);

    // Test with different modifier orders
    const event1: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 's',
        modifiers: ['alt', 'ctrl'],
        down: true,
        isCharEvent: false,
      },
    };
    expect(handleEvent(event1)).toBe(true);

    const event2: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 's',
        modifiers: ['ctrl', 'alt'],
        down: true,
        isCharEvent: false,
      },
    };
    expect(handleEvent(event2)).toBe(true);
  });

  test('handle partial matches with timeout', async () => {
    let triggered = '';
    const config = {
      keybindings: {
        '<C-w>': () => {
          triggered = 'menu';
        },
        '<C-w>l': () => {
          triggered = 'next';
        },
      },
    };
    loadKeyBindings(config);

    // First key press
    const event1: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 'w',
        modifiers: ['ctrl'],
        down: true,
        isCharEvent: false,
      },
    };
    expect(handleEvent(event1)).toBe(false);
    expect(triggered).toBe('');

    // Advance timers - should trigger the menu
    await clock.tickAsync(500);
    expect(triggered).toBe('menu');
  });

  test('handle multi-key sequence within timeout', async () => {
    let triggered = '';
    const config = {
      keybindings: {
        '<C-w>': () => {
          triggered = 'menu';
        },
        '<C-w>l': () => {
          triggered = 'next';
        },
      },
    };
    loadKeyBindings(config);

    // First key press
    const event1: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 'w',
        modifiers: ['ctrl'],
        down: true,
        isCharEvent: false,
      },
    };
    expect(handleEvent(event1)).toBe(false);
    expect(triggered).toBe('');

    // Second key press before timeout
    const event2: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 'l',
        modifiers: [],
        down: true,
        isCharEvent: false,
      },
    };
    expect(handleEvent(event2)).toBe(true);
    expect(triggered).toBe('next');

    // Advance timers - should not trigger the menu since sequence was completed
    await clock.tickAsync(500);
    expect(triggered).toBe('next');
  });

  test('handle multiple bindings with same prefix', async () => {
    let triggered = '';
    const config = {
      keybindings: {
        '<C-w>': () => {
          triggered = 'base';
        },
        '<C-w>l': () => {
          triggered = 'l';
        },
        '<C-w>h': () => {
          triggered = 'h';
        },
      },
    };
    loadKeyBindings(config);

    // First key press
    const event1: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 'w',
        modifiers: ['ctrl'],
        down: true,
        isCharEvent: false,
      },
    };
    expect(handleEvent(event1)).toBe(false);
    expect(triggered).toBe('');

    // Wait for timeout
    await clock.tickAsync(500);
    expect(triggered).toBe('base');
  });

  test('ignore keyup events', () => {
    const config = {
      keybindings: {
        '<C-s>': () => {},
      },
    };
    loadKeyBindings(config);

    const event: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 's',
        modifiers: ['ctrl'],
        down: false,
        isCharEvent: false,
      },
    };

    expect(handleEvent(event)).toBe(false);
  });

  test('handle non-key events', () => {
    const config = {
      keybindings: {
        '<C-s>': () => {},
      },
    };
    loadKeyBindings(config);

    const event: TermEvent = {
      eventType: 'mouse',
      mouseEvent: {
        kind: 'mouseDown',
        button: 'left',
        x: 0,
        y: 0,
        modifiers: [],
      },
    };

    expect(handleEvent(event)).toBe(false);
  });

  test('handle empty bindings', () => {
    const config = {
      keybindings: {},
    };
    loadKeyBindings(config);

    const event: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 's',
        modifiers: ['ctrl'],
        down: true,
        isCharEvent: false,
      },
    };

    expect(handleEvent(event)).toBe(false);
  });

  test('clear timeout on new key sequence', async () => {
    let triggered = '';
    const config = {
      keybindings: {
        '<C-w>': () => {
          triggered = 'menu';
        },
        '<C-w>l': () => {
          triggered = 'next';
        },
        '<C-s>': () => {
          triggered = 'save';
        },
      },
    };
    loadKeyBindings(config);

    // Start C-w sequence
    const event1: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 'w',
        modifiers: ['ctrl'],
        down: true,
        isCharEvent: false,
      },
    };
    expect(handleEvent(event1)).toBe(false);
    expect(triggered).toBe('');

    // Press C-s before timeout (should execute immediately since it has no longer matches)
    const event2: TermEvent = {
      eventType: 'key',
      keyEvent: {
        code: 's',
        modifiers: ['ctrl'],
        down: true,
        isCharEvent: false,
      },
    };
    expect(handleEvent(event2)).toBe(true);
    expect(triggered).toBe('save');

    // Advance timers - should not trigger the menu since we started a new sequence
    await clock.tickAsync(500);
    expect(triggered).toBe('save');
  });
});

describe('key normalization and cross-platform modifiers', () => {
  beforeEach(() => {
    loadKeyBindings({ keybindings: {} });
  });

  function press(code: string, modifiers: string[] = []): boolean {
    return handleEvent({
      eventType: 'key',
      keyEvent: {
        code,
        modifiers: modifiers as never,
        down: true,
        isCharEvent: false,
      },
    } as TermEvent);
  }

  test('<A-minus> matches what the native addon emits: alt+-', () => {
    loadKeyBindings({ keybindings: { '<A-minus>': () => {} } });
    expect(press('-', ['alt'])).toBe(true);
    // the un-normalized spelling must not match anything
    expect(press('minus', ['alt'])).toBe(false);
  });

  test('named keys keep the names the native addon emits', () => {
    loadKeyBindings({
      keybindings: { '<Enter>': () => {}, '<Esc>': () => {}, '<Tab>': () => {} },
    });
    expect(press('return')).toBe(true);
    expect(press('escape')).toBe(true);
    expect(press('tab')).toBe(true);
    // regression: these used to be mangled to '+' by the normalizer
    expect(press('+')).toBe(false);
  });

  test('<Cmd-key> is the platform primary combo (Cmd on macOS, Ctrl elsewhere)', () => {
    loadKeyBindings({ keybindings: { '<Cmd-r>': () => {} } });
    const primary = process.platform === 'darwin' ? ['super'] : ['ctrl'];
    expect(press('r', primary)).toBe(true);
    const other = process.platform === 'darwin' ? ['ctrl'] : ['super'];
    expect(press('r', other)).toBe(false);
  });

  test('<Super-key> is the literal super/Windows key', () => {
    loadKeyBindings({ keybindings: { '<Super-1>': () => {} } });
    expect(press('1', ['super'])).toBe(true);
    expect(press('1', ['ctrl'])).toBe(false);
  });
});
