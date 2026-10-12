import { getWindowSize, type KeyEvent as KeyEventOriginal, type TermEvent } from './native';
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
import { features } from './features';

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
  scale = 1,
) {
  const vertical = kind === 'scrollUp' || kind === 'scrollDown';
  const sign = kind === 'scrollUp' || kind === 'scrollRight' ? 1 : -1;
  // deltaY is CSS px, but the CSS viewport shrinks as display/raster scale
  // grows — divide by the same toRaster factor mouse coords use so one tick
  // always scrolls the same fraction of the visible page (06-06 Task 1).
  const delta = sign * WHEEL_DELTA / scale;
  return {
    type: 'mouseWheel' as const,
    wheelTicksY: vertical ? sign : 0,
    wheelTicksX: vertical ? 0 : sign,
    deltaX: vertical ? 0 : delta,
    deltaY: vertical ? delta : 0,
    modifiers,
    x,
    y,
    accelerationRatioY: 0.5,
    // Precise pixels: wheelTicks are sent as pixel deltas rather than lines.
    //
    // This does NOT disable smooth scrolling by itself -- that needed
    // `--disable-smooth-scrolling` in index.ts. It only makes each event
    // pixel-denominated, so combined with the switch the delta is applied once,
    // immediately, instead of being queued and eased by the compositor
    // animator (which accumulated lag and could animate a queued delta after
    // the scroll direction had already reversed). 06-06 checkpoint 2 credited
    // this flag with disabling the animation; it does not.
    hasPreciseScrollingDeltas: true,
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

/**
 * Sanitizes bracketed-paste text by stripping markers and escape sequences.
 * Pure function: no I/O, no view access.
 */
export function sanitizePaste(text: string): string {
  // Strip bracketed-paste markers: ESC[200~ and ESC[201~
  const ESC = '\u001b';
  let out = text.replace(new RegExp(`${ESC}\\[200~`, 'g'), '').replace(new RegExp(`${ESC}\\[201~`, 'g'), '');

  // Strip other CSI sequences: ESC[ ... final_byte
  out = out.replace(new RegExp(`${ESC}\\[[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]`, 'g'), '');

  // Strip OSC/DCS/APC/PM: ESC]...ST, ESCP...ST, ESC_...ST, ESC^...ST
  out = out.replace(new RegExp(`${ESC}[\\x5d\\x50\\x5f\\x5e].*?(\\x07|${ESC}\\\\)`, 'g'), '');

  // Strip bare ESC and C1 CSI (0x9b)
  out = out.replace(new RegExp(ESC, 'g'), '').replace(/\u009b/g, '');

  return out;
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

      const { code: keyCode, modifiers, down, isCharEvent } = evt.keyEvent as KeyEvent;

      // Escape returns focus from the toolbar to the page. Only while the URL bar
      // holds focus, so Esc otherwise reaches the page. (`<C-o>` focuses it via
      // the `focus-url` action in `config.toml`.)
      if (keyCode === 'escape' && down && features.toolbarFocused) {
        if (view) {
          view.content.focusOnWebView();
          view.toolbar.blurWebView();
          view.focusedContent = view.content.webContents;
          features.toolbarFocused = false;
          view.toolbar.webContents.send('toolbar:blur-url');
          return;
        }
      }

      const webContents = view.focusedContent;

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
          buildWheelEvent(kind, modifiers, adjustedX, adjustedY, toRaster),
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
    case 'paste': {
      const text = sanitizePaste(evt.paste ?? '');
      if (text.length > 0) {
        view.focusedContent.insertText(text);
      }
      break;
    }
    case 'escape':
      // no TS consumer yet — crossterm capability queries resolve in Rust
      break;
  }
}
