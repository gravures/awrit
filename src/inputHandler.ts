import { getWindowSize, type KeyEvent as KeyEventOriginal, type TermEvent } from 'awrit-native-rs';
import { handleEvent as handleKeyBinding } from './keybindings';
import {
  nextTmuxMouseCoordinateMode,
  normalizeTmuxMouseCoordinates,
  type MouseCoordinateMode,
} from './tty/mouseCoordinates';
import { isTmuxSession } from './tty/tmux';
import { focusedView } from './windows';

const WHEEL_DELTA = 100;

const mouseEventTypes = ['mouseDown', 'mouseUp', 'mouseMove'] as const;
const TERM_SIZE_CACHE_TTL_MS = 100;

let mouseCoordinateMode: MouseCoordinateMode = 'unknown';
let cachedTermSize:
  | {
      size: ReturnType<typeof getWindowSize>;
      at: number;
    }
  | undefined;
// this is a fix for Electron going back and forth on what's supported for modifiers, despite being case insensitive;
type KeyEventModifiers = Lowercase<KeyEventOriginal['modifiers'][number]>[];
type KeyEvent = Omit<KeyEventOriginal, 'modifiers'> & {
  modifiers: KeyEventModifiers;
};

function isSimpleMouseEvent(kind: unknown): kind is (typeof mouseEventTypes)[number] {
  return mouseEventTypes.includes(kind as (typeof mouseEventTypes)[number]);
}

function getCachedTermSize(now = Date.now()) {
  if (cachedTermSize && now - cachedTermSize.at < TERM_SIZE_CACHE_TTL_MS) {
    return cachedTermSize.size;
  }
  const size = getWindowSize();
  cachedTermSize = { size, at: now };
  return size;
}

function maybeNormalizeTmuxMouseCoordinates(rawX: number, rawY: number) {
  if (!isTmuxSession()) return { x: rawX, y: rawY };

  const termSize = getCachedTermSize();
  mouseCoordinateMode = nextTmuxMouseCoordinateMode(rawX, rawY, termSize, mouseCoordinateMode);
  return normalizeTmuxMouseCoordinates(rawX, rawY, termSize, mouseCoordinateMode);
}

export function handleInput(evt: TermEvent) {
  const view = focusedView.current;
  if (!view) {
    handleKeyBinding(evt);
    return;
  }

  switch (evt.eventType) {
    case 'key': {
      // First check if this is a keybinding
      if (handleKeyBinding(evt, view)) {
        return;
      }

      const webContents = view.focusedContent;
      const { code: keyCode, modifiers, down, isCharEvent } = evt.keyEvent as KeyEvent;

      if (isCharEvent && down) {
        webContents.sendInputEvent({
          type: 'rawKeyDown',
          keyCode,
          modifiers,
        });
        webContents.sendInputEvent({
          type: 'char',
          keyCode,
          modifiers,
        });
      } else {
        webContents.sendInputEvent({
          type: down ? 'keyDown' : 'keyUp',
          keyCode,
          modifiers,
        });
      }
      break;
    }

    case 'mouse': {
      const { kind, button, x, y, modifiers } = evt.mouseEvent;
      if (
        (kind === 'mouseUp' || kind === 'mouseDown') &&
        button &&
        ['fourth', 'fifth'].includes(button ?? '')
      ) {
        handleKeyBinding(evt, view);
        return;
      }

      const DPI_SCALE = view.layoutContainer.devicePixelRatio;
      const rawX = x ?? 0;
      const rawY = y ?? 0;
      const normalized = maybeNormalizeTmuxMouseCoordinates(rawX, rawY);
      const normalizedX = normalized.x;
      const normalizedY = normalized.y;

      // Determine which region we're in based on layout
      const { toolbarNode, contentNode } = view;
      const isInToolbar = normalizedY < contentNode.deviceLayout.y;

      // Calculate position relative to the target component
      const adjustedX = Math.floor(normalizedX / DPI_SCALE);
      const adjustedY = Math.floor(
        (normalizedY - (isInToolbar ? 0 : toolbarNode.deviceLayout.height)) / DPI_SCALE,
      );

      const focusedContent = isInToolbar ? view.toolbar.webContents : view.content.webContents;

      if (kind === 'scrollUp' || kind === 'scrollDown') {
        view.content.webContents.sendInputEvent({
          type: 'mouseWheel',
          wheelTicksY: kind === 'scrollUp' ? 1 : -1,
          wheelTicksX: 0,
          deltaX: 0,
          deltaY: kind === 'scrollUp' ? WHEEL_DELTA : -WHEEL_DELTA,
          modifiers,
          x: adjustedX,
          y: adjustedY,
          accelerationRatioY: 0.5,
          hasPreciseScrollingDeltas: false,
          canScroll: true,
        });
        break;
      }

      if (!isSimpleMouseEvent(kind)) {
        break;
      }
      if (!button && kind !== 'mouseMove') {
        break;
      }

      const electronButton =
        button === 'fourth' || button === 'fifth' || button == null ? undefined : button;

      focusedContent.sendInputEvent({
        type: kind,
        x: adjustedX,
        y: adjustedY,
        button: electronButton,
        modifiers,
        clickCount: kind === 'mouseDown' ? 1 : 0,
      });

      if (kind === 'mouseDown' && button === 'left') {
        if (focusedContent !== view.focusedContent) {
          if (focusedContent === view.content.webContents) {
            view.toolbar.blurWebView();
            view.content.focusOnWebView();
          } else {
            view.content.blurWebView();
            view.toolbar.focusOnWebView();
          }
          view.focusedContent = focusedContent;
        }
      }
      break;
    }
  }
}
