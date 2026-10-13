import type { KeyEvent, TermEvent } from '../native';
import type { WindowView } from './windows';

const isMac = process.platform === 'darwin';

export type KeyBindingEvent = {
  isMac: boolean;
  view?: WindowView;
  /** Optional arguments for actions that take parameters (reserved for growth). */
  args?: Record<string, unknown>;
};

export type KeyBindingAction = (event: KeyBindingEvent) => void;

/** name → action: the built-in vocabulary a config file names. */
export type ActionRegistry = Record<string, KeyBindingAction>;

type KeyBinding = {
  keys: string[];
  action: KeyBindingAction;
};

type KeyBindingMap = Map<string, KeyBinding[]>;

const TIMEOUT_MS = 500; // Increased timeout for better UX

// State
const bindings: KeyBindingMap = new Map();
let currentSequence: string[] = [];
let timeoutId: NodeJS.Timeout | null = null;
let pendingAction: KeyBindingAction | null = null;

/**
 * Parse a Neovim-style keybinding string into an array of key codes
 * Example: "<C-w>l" -> ["ctrl+w", "l"]
 */
function parseKeyBinding(binding: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSpecial = false;
  let modifiers: string[] = [];

  for (let i = 0; i < binding.length; i++) {
    const char = binding[i];

    if (char === '<' && !inSpecial) {
      inSpecial = true;
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    if (char === '>' && inSpecial) {
      inSpecial = false;
      if (current) {
        // Handle special keys
        const special = current.toLowerCase();
        const mods = special.split('-');
        let lastPart = mods[mods.length - 1].toLowerCase();

        // Normalize special key names to what the native addon emits
        // (awrit-native-rs/src/input.rs translate_key_code). Every name not
        // listed here is already emitted verbatim by the native side.
        switch (lastPart) {
          case 'cr':
          case 'enter':
            lastPart = 'return';
            break;
          case 'esc':
            lastPart = 'escape';
            break;
          case 'bs':
            lastPart = 'backspace';
            break;
          case 'plus':
            lastPart = '+';
            break;
          case 'minus':
            lastPart = '-';
            break;
        }

        for (const mod of mods.slice(0, -1)) {
          switch (mod) {
            case 'c':
              modifiers.push('ctrl');
              break;
            case 'a':
              modifiers.push('alt');
              break;
            case 's':
              modifiers.push('shift');
              break;
            case 'm':
              modifiers.push('meta');
              break;
            case 'cmd':
            case 'command':
              // The platform's primary combo: Command on macOS, Ctrl elsewhere,
              // so one binding in one file expresses the same intent on both.
              modifiers.push(isMac ? 'super' : 'ctrl');
              break;
            case 'super':
            case 'win':
              modifiers.push('super');
              break;
          }
        }
        current = lastPart;

        if (modifiers.length > 0) {
          parts.push([...modifiers.sort(), current].join('+'));
          modifiers = [];
        } else {
          parts.push(current);
        }
        current = '';
      }
      continue;
    }

    if (inSpecial) {
      current += char;
    } else {
      parts.push(char);
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

/**
 * Load keybindings from a config object.
 *
 * Each value is either an action function (legacy/JS config) or the *name* of
 * a built-in action, resolved through `registry`. Names that do not resolve are
 * skipped and returned in `unknown` so the caller can report them — a bad name
 * must not be dropped silently.
 */
export function loadKeyBindings(
  config: { keybindings: Record<string, string | KeyBindingAction> },
  registry?: ActionRegistry,
): { unknown: string[] } {
  // Clear existing bindings
  bindings.clear();
  currentSequence = [];
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
  pendingAction = null;

  const unknown: string[] = [];

  // Add new bindings
  for (const [binding, entry] of Object.entries(config.keybindings)) {
    const action = typeof entry === 'function' ? entry : registry?.[entry];
    if (!action) {
      // A name that isn't in the registry — report it rather than fail silently.
      if (typeof entry === 'string') unknown.push(entry);
      continue;
    }

    const keys = parseKeyBinding(binding);
    const firstKey = keys[0];

    if (!bindings.has(firstKey)) {
      bindings.set(firstKey, []);
    }

    const keyBindings = bindings.get(firstKey);
    if (keyBindings) {
      keyBindings.push({
        keys,
        action,
      });
    }
  }

  return { unknown };
}

/**
 * Check if a TermEvent matches any keybinding
 */
export function handleEvent(event: TermEvent, view?: WindowView): boolean {
  let keyEvent: KeyEvent | undefined;
  if (
    event.eventType === 'mouse' &&
    event.mouseEvent.kind === 'mouseUp' &&
    event.mouseEvent.button &&
    ['fourth', 'fifth'].includes(event.mouseEvent.button)
  ) {
    keyEvent = {
      code: 'mouse' + (event.mouseEvent.button === 'fourth' ? '4' : '5'),
      modifiers: event.mouseEvent.modifiers,
      down: true,
      isCharEvent: false,
    };
  }

  if (event.eventType === 'key' && event.keyEvent.down) {
    keyEvent = event.keyEvent;
  }

  if (!keyEvent) {
    return false;
  }

  const { code, modifiers } = keyEvent;
  const sortedModifiers = [...modifiers].sort();
  const key = sortedModifiers.length > 0 ? [...sortedModifiers, code].join('+') : code;

  // Clear any existing timeout
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }

  // Check if this key starts a new sequence
  const startsNewSequence = bindings.has(key);
  if (startsNewSequence) {
    currentSequence = [];
  }

  // Add to current sequence
  currentSequence.push(key);

  // Check for matches
  const keyBindings = bindings.get(currentSequence[0]);
  if (keyBindings) {
    // Check for partial matches first
    const hasLongerBindings = keyBindings.some(
      (b) =>
        b.keys.length > currentSequence.length &&
        b.keys.every((k, i) => i >= currentSequence.length || k === currentSequence[i]),
    );

    // Find single-key binding if it exists
    const singleBinding = keyBindings.find((b) => b.keys.length === 1);

    if (hasLongerBindings) {
      // Store the single-key binding action if it exists
      pendingAction = singleBinding?.action || null;

      // Set timeout to execute the single-key binding if no more keys are pressed
      timeoutId = setTimeout(() => {
        if (pendingAction) {
          pendingAction({ isMac, view });
        }
        currentSequence = [];
        pendingAction = null;
      }, TIMEOUT_MS);

      return false;
    }

    // Look for exact matches if no longer bindings are possible
    for (const binding of keyBindings) {
      if (
        currentSequence.length === binding.keys.length &&
        currentSequence.every((k, i) => k === binding.keys[i])
      ) {
        // Execute exact match immediately
        binding.action({ isMac, view });
        currentSequence = [];
        pendingAction = null;
        return true;
      }
    }
  }

  // No matches found, reset sequence
  currentSequence = [];
  pendingAction = null;
  return false;
}
