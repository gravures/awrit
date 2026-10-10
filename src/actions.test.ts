import { describe, expect, test } from 'bun:test';
import { actions } from './actions';
import { handleEvent, loadKeyBindings } from './keybindings';
import type { TermEvent } from './native';

// The names the shipped config.toml default binds.
const DEFAULT_ACTIONS = [
  'back',
  'forward',
  'refresh',
  'find',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'select-all',
  'quit',
];

describe('action registry', () => {
  test('every shipped action is callable', () => {
    for (const action of Object.values(actions)) {
      expect(typeof action).toBe('function');
    }
  });

  test('covers the default keybinding vocabulary by name', () => {
    const missing = DEFAULT_ACTIONS.filter((name) => typeof actions[name] !== 'function');
    expect(missing).toEqual([]);
  });

  test('a name binding resolves and fires the action', () => {
    let fired = 0;
    const registry = {
      ...actions,
      refresh: () => {
        fired++;
      },
    };
    const { unknown } = loadKeyBindings({ keybindings: { '<C-r>': 'refresh' } }, registry);
    expect(unknown).toEqual([]);

    const event: TermEvent = {
      eventType: 'key',
      keyEvent: { code: 'r', modifiers: ['ctrl'], down: true, isCharEvent: false },
    };
    expect(handleEvent(event)).toBe(true);
    expect(fired).toBe(1);
  });

  test('an unknown name is reported, not silently dropped', () => {
    const { unknown } = loadKeyBindings({ keybindings: { '<C-r>': 'nope' } }, actions);
    expect(unknown).toEqual(['nope']);
  });
});
