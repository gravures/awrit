import { getWindowSize, type KeyEvent as KeyEventOriginal, type TermEvent } from 'awrit-native-rs';
import { handleEvent as handleKeyBinding } from './keybindings';
import { perfCount, perfEnd, perfTime } from './perf';
import {
  nextTmuxMouseCoordinateMode,
  normalizeTmuxMouseCoordinates,
  type MouseCoordinateMode,
} from './tty/mouseCoordinates';
import { invalidatePaneSizeCache, isTmuxSession } from './tty/tmux';
import { getRasterScale } from './raster';
import { focusedView, setTerminalIsFocused, updateFrameRates } from './windows';

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

type MouseMoveSnapshot = {
  view: unknown;
  x: number;
  y: number;
  modifiers: readonly string[];
};

let lastMouseMove: MouseMoveSnapshot | undefined;

/** Skip duplicate mouseMove events: same target view, same coords, same modifiers. */
export function shouldSendMouseMove(prev: MouseMoveSnapshot | undefined, next: MouseMoveSnapshot) {
  if (!prev) return true;
  return (
    prev.view !== next.view ||
    prev.x !== next.x ||
    prev.y !== next.y ||
    prev.modifiers.length !== next.modifiers.length ||
    prev.modifiers.some((m, i) => m !== next.modifiers[i])
  );
}

type ScrollKind = 'scrollUp' | 'scrollDown' | 'scrollLeft' | 'scrollRight';

export function buildWheelEvent(
  kind: ScrollKind,
  modifiers: ('ctrl' | 'alt' | 'shift')[],
  x: number,
  y: number,
) {
  const vertical = kind === 'scrollUp' || kind === 'scrollDown';
  const sign = kind === 'scrollUp' || kind === 'scrollRight' ? 1 : -1;
  return {
    type: 'mouseWheel' as const,
    wheelTicksY: vertical ? sign : 0,
    wheelTicksX: vertical ? 0 : sign,
    deltaX: vertical ? 0 : sign * WHEEL_DELTA,
    deltaY: vertical ? sign * WHEEL_DELTA : 0,
    modifiers,
    x,
    y,
    accelerationRatioY: 0.5,
    hasPreciseScrollingDeltas: false,
    canScroll: true,
  };
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
  perfCount(evt.eventType === 'mouse' ? `in.${evt.mouseEvent.kind}` : `in.${evt.eventType}`);
  const t0 = perfTime();
  try {
    handleInputEvent(evt);
  } finally {
    perfEnd('in.handler', t0);
  }
}

function handleInputEvent(evt: TermEvent) {
  // Focus needs no view; handle before the no-view early return.
  if (evt.eventType === 'focus') {
    // Rust sends focusGained: true on gain, focusGained: undefined on loss.
    setTerminalIsFocused(evt.focusGained === true);
    updateFrameRates();
    return;
  }

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

      // Terminal coords are pane px; webContents wants raster px, which is
      // pane px divided by the display scale *and* the raster scale. Fold both
      // into one factor so the toolbar test below compares like with like.
      const toRaster = view.layoutContainer.devicePixelRatio * getRasterScale();
      const rawX = x ?? 0;
      const rawY = y ?? 0;
      const normalized = maybeNormalizeTmuxMouseCoordinates(rawX, rawY);
      const normalizedX = normalized.x / toRaster;
      const normalizedY = normalized.y / toRaster;

      // Determine which region we're in based on layout
      const { toolbarNode, contentNode } = view;
      const isInToolbar = normalizedY < contentNode.deviceLayout.y;

      // Calculate position relative to the target component
      const adjustedX = Math.floor(normalizedX);
      const adjustedY = Math.floor(
        normalizedY - (isInToolbar ? 0 : toolbarNode.deviceLayout.height),
      );

      const focusedContent = isInToolbar ? view.toolbar.webContents : view.content.webContents;

      if (
        kind === 'scrollUp' ||
        kind === 'scrollDown' ||
        kind === 'scrollLeft' ||
        kind === 'scrollRight'
      ) {
        view.content.webContents.sendInputEvent(
          buildWheelEvent(kind, modifiers, adjustedX, adjustedY),
        );
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

      if (kind === 'mouseMove') {
        const next: MouseMoveSnapshot = {
          view: focusedContent,
          x: adjustedX,
          y: adjustedY,
          modifiers: modifiers ?? [],
        };
        if (!shouldSendMouseMove(lastMouseMove, next)) break;
        lastMouseMove = next;
      }

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

    case 'resize':
      // Only invalidate term-size + tmux pane-size caches; SIGWINCH layout lives in windows.ts
      cachedTermSize = undefined;
      invalidatePaneSizeCache();
      break;
    case 'paste':
      // paste: bracketed-paste handling lands in plan 05-02
      break;
    case 'escape':
      // no TS consumer yet — crossterm capability queries resolve in Rust
      break;
  }
}
