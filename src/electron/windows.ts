import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type WebContents,
  screen,
} from 'electron';
import {
  registerPaintedContent,
  registerPaintedContentFallback,
  registerPaintedContentTmux,
} from './paint';
import { sessionPromise } from './session';
import { extensionsPromise, installedExtensionsPromise } from './extensions';
import { paintInitialFrame } from './tty/kittyGraphics';
import {
  getWindowSize as rawGetWindowSize,
  ShmGraphicBuffer,
} from '../native';
import { getZoomFactor } from './zoom-state';

export function getWindowSize() {
  try {
    return rawGetWindowSize();
  } catch (e) {
    console_.error('Failed to get window size:', e);
    return { width: 0, height: 0, cols: 0, rows: 0 };
  }
}
import { options } from '../shared/args';
import { console_ } from './console';
import {
  layout,
  row,
  px,
  auto,
  calculateLayout,
  type LayoutContainer,
  type LayoutNode,
} from './layout';
import { getDisplayScale } from '../shared/dpi';
import { cellSpan, getRasterScale, setPaneToBitmap } from './raster';
import { features } from './features';
import { updateCursor } from './tty/cursor';
import { debounce } from './debounce';
import { isTmuxSession } from './tty/tmux';
import { lockForUrl, redrawBar } from './urlbar';

export type Actions = {
  back: () => void;
  forward: () => void;
  refresh: () => void;
};

export type WindowView = {
  content: BrowserWindow;
  layoutContainer: LayoutContainer;
  barNode: LayoutNode;
  contentNode: LayoutNode;
} & Actions;

export const focusedView: {
  current: WindowView | null;
  previous: WindowView | null;
} = {
  current: null,
  previous: null,
};

export const windowViews = new WeakMap<BrowserWindow, WindowView>();

const BAR_HEIGHT = 40;

/**
 * Bar row height in DIP, snapped to one terminal cell so the terminal stretches
 * the page by the same factor it stretches the bar. 1.5px on a 42px cell —
 * cheap to keep aligned, and it keeps the one-row bar exactly one cell tall.
 * Falls back to the flat 40 when the pane reports no rows.
 */
function barHeight(rows: number | undefined, paneHeight: number, raster: number) {
  if (!rows || rows <= 0) return BAR_HEIGHT;
  const cellInRasterPx = paneHeight / rows / raster;
  if (!Number.isFinite(cellInRasterPx) || cellInRasterPx <= 0) return BAR_HEIGHT;
  return Math.max(1, Math.round(cellInRasterPx));
}

/**
 * Layout for a pane of `size` physical px. `size` arrives from TIOCGWINSZ and
 * Electron reads it as DIP, so dividing by the raster scale is what produces the
 * smaller bitmap. Records the bitmap:pane ratio too: the paint handlers measure
 * in bitmap px and need the terminal cell size in those same units.
 */
function layoutForPane(size: { width: number; height: number }) {
  const raster = getRasterScale();
  const displayScale = getDisplayScale() ?? screen.getPrimaryDisplay().scaleFactor;
  const container = layout(size.width / raster, size.height / raster, displayScale);
  setPaneToBitmap(displayScale / raster);
  return container;
}

/**
 * NOTE: the happens before load but after frame navigate
 * this is necessary because zoom can only be set when a URL is associated with the webContents
 *
 * This also prevents users from persisting zoom level which is bad, so we probably want
 * to store that somewhere if the user changes zoom and restore that number instead
 *
 * @param zoom zoom to (re)apply on every navigation, default 1
 */
function resetForFrameQuirk(webContents: WebContents, zoom = 1) {
  webContents.once('did-frame-navigate', () => {
    webContents.setZoomFactor(zoom);
  });
}

type Size = { width: number; height: number; rows?: number };
// this deals with the DPI scale rounding error causing the buffer to be too small
function padSize(size: Size): Size {
  return {
    width: size.width + 3,
    height: size.height + 3,
  };
}

export const managedViews: WindowView[] = [];

// Terminal focus (mode 1004) drives frame rates: unfocused = 1fps floor.
let terminalIsFocused = true;

export function setTerminalIsFocused(focused: boolean) {
  terminalIsFocused = focused;
}

export function updateFrameRates() {
  for (const view of managedViews) {
    const active = terminalIsFocused && view === focusedView.current;
    view.content.webContents.setFrameRate(active ? 60 : 1);
  }
}
/**
 * Creates a new window with a terminal-native one-row bar and a page area.
 * @param size Window size
 * @param initialUrl URL to load in the page
 * @returns The created window
 */
export async function createWindow(
  size: { width: number; height: number; rows?: number },
  initialUrl = 'https://duckduckgo.com',
): Promise<WindowView> {
  const raster = getRasterScale();
  const layoutContainer = layoutForPane(size);

  // The bar is not a window: this row only reserves exactly one cell at the top
  // so `contentNode.y` stays one cell and the page spans rows 1..N-1 (07-03).
  const barNode = row({ height: px(barHeight(size.rows, size.height, raster)), tag: 'bar' });
  const contentNode = row({ height: auto(), tag: 'content' });

  const hasAnimation = features.current?.loadFrame && features.current.compositeFrame;
  const useTmuxRenderer = isTmuxSession();

  // Calculate layout: content first (top), bar last (bottom)
  calculateLayout(layoutContainer, [contentNode, barNode]);

  const transparentWindowSettings = {
    transparent: true,
    backgroundColor: '#00000000',
  };

  const sharedConstructorOptions: BrowserWindowConstructorOptions = {
    useContentSize: true,
    show: false,
    frame: false,
    paintWhenInitiallyHidden: true,
    hiddenInMissionControl: true,
    acceptFirstMouse: true,
    skipTaskbar: true,
    fullscreenable: false,
    resizable: false,
  };

  const content = new BrowserWindow({
    ...sharedConstructorOptions,
    ...contentNode.computedLayout,

    ...(options.transparent ? transparentWindowSettings : {}),

    webPreferences: {
      zoomFactor: 1,
      session: await sessionPromise,

      sandbox: true,
      // Take the frame as a GPU dmabuf instead of a CPU bitmap, so the pixels
      // are not copied into a NativeImage before the shm write. The read is
      // still ~20ms, so this is not automatically faster (see .paul for the
      // measured numbers). Only here: the tmux and Kitty-animation renderers
      // both need the CPU bitmap, and in this mode the paint event carries an
      // *empty* bitmap, so those two are unaffected.
      offscreen: !useTmuxRenderer && !hasAnimation ? { useSharedTexture: true } : true,
      nodeIntegration: false,
      contextIsolation: true,
      // show:false windows would otherwise idle-throttle frames to ~1Hz and
      // delay the first scroll frame by up to a second.
      backgroundThrottling: false,
      disableDialogs: true,
    },
  });

  const destructors: Array<() => void> = [];

  let suppressionTimeout: NodeJS.Timeout | null = null;

  const _startSuppression = () => {
    // @ts-expect-error
    content.isSuppressingPaint = true;
    // @ts-expect-error
    content.paintCount = 0;

    if (!options.transparent) {
      content.setBackgroundColor('#000000');
    }

    // Safety timeout: never suppress for more than 200ms (fast reveal, dark mode eliminates flash)
    if (suppressionTimeout) clearTimeout(suppressionTimeout);
    suppressionTimeout = setTimeout(() => {
      if (popupActive) return;
      // @ts-expect-error
      content.isSuppressingPaint = false;
      content.webContents.invalidate();
      suppressionTimeout = null;
    }, 200);
  };

  const popupActive = false;

  const stopSuppression = (delay = 300, force = false) => {
    if (popupActive) return; // Never unsuppress while popup is displayed
    if (suppressionTimeout) clearTimeout(suppressionTimeout);

    const execute = () => {
      // @ts-expect-error
      content.isSuppressingPaint = false;
      content.webContents.invalidate();
      suppressionTimeout = null;
    };

    if (force) {
      execute();
      return;
    }

    suppressionTimeout = setTimeout(() => {
      if (!content.webContents.isLoading() || delay === 0) {
        execute();
      } else {
        // Still loading, extend suppression
        stopSuppression(delay);
      }
    }, delay);
  };

  content.on('content-ready' as any, () => {
    if (popupActive) return;
    console_.log('[Navigation] Content-ready detected (45 frames), reveal starting...');
    stopSuppression(0, true);
  });

  content.webContents.on('did-navigate', () => {
    if (!options.transparent) {
      // Inject white background as a user stylesheet.
      // This ensures sites without explicit backgrounds are legible,
      // but allows site-defined backgrounds to take precedence.
      // Because the window background is PERMANENTLY black, there is no flash.
      content.webContents.insertCSS('html { background-color: #1C1B22; }', { cssOrigin: 'user' });
    }

    // Load and apply saved zoom for navigated origin
    try {
      const url = view.content.webContents.getURL();
      const origin = new URL(url).origin;
      const savedZoom = getZoomFactor(origin);
      if (savedZoom !== 1.0) {
        view.content.webContents.setZoomFactor(savedZoom);
      }
    } catch {}
  });

  content.webContents.on('dom-ready', () => {
    // Site has parsed its HTML, likely has content/loader to show.
    stopSuppression(100);
  });

  // let lastPaintSize: WindowDimensions = padSize(size);

  function registerPaints(bitmapSize: Size) {
    if (useTmuxRenderer) {
      destructors.push(registerPaintedContentTmux(content, contentNode).destroy);
    } else if (hasAnimation) {
      // Padded because composites are pixel rects and kitty answers EINVAL when
      // one lands outside the image; the c/r span comes from the unpadded
      // bitmap so the placement isn't a column wider than the pane.
      const size = padSize(bitmapSize);
      const containerBuffer = new ShmGraphicBuffer(size.width * size.height * 4);
      containerBuffer.writeEmpty();
      const containerFrame = paintInitialFrame(
        containerBuffer,
        size,
        cellSpan(bitmapSize, getWindowSize()),
      );
      destructors.push(
        containerFrame.free,
        registerPaintedContent(containerFrame, content, contentNode).destroy,
      );
    } else {
      destructors.push(registerPaintedContentFallback(content, contentNode).destroy);
    }
  }

  registerPaints(layoutContainer.root.deviceLayout);

  // Add to extensions
  extensionsPromise.then((extensions) => {
    extensions.addTab(content.webContents, content);
  });
  await installedExtensionsPromise;

  resetForFrameQuirk(content.webContents);
  content.webContents.loadURL(initialUrl);

  // Apply saved zoom for initial URL
  try {
    const origin = new URL(initialUrl).origin;
    const savedZoom = getZoomFactor(origin);
    if (savedZoom !== 1.0) {
      content.webContents.setZoomFactor(savedZoom);
    }
  } catch {}

  content.webContents.invalidate();

  content.webContents.on('cursor-changed', updateCursor);

  const view: WindowView = {
    content,
    layoutContainer,
    barNode,
    contentNode,
    back: () => {
      content.webContents.goBack();
    },
    forward: () => {
      content.webContents.goForward();
    },
    refresh: () => {
      content.webContents.reload();
    },
  };

  // Add to managed windows
  managedViews.push(view);
  focusedView.current = view;
  // Terminals can't display faster than ~60fps anyway; caps apply here.
  updateFrameRates();

  // Keep the bar's URL and lock indicator in sync while it is showing (not editing/finding).
  const syncBarUrl = (url: string) => {
    if (!url) return;
    features.bar.url = url;
    features.bar.lock = lockForUrl(url);
    if (features.bar.mode === 'normal') redrawBar(view);
  };
  content.webContents.on('did-navigate', (_event, url) => syncBarUrl(url));
  content.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) syncBarUrl(url);
  });

  // Live find match position for the bar's [i/n] counter.
  content.webContents.on('found-in-page', (_event, result) => {
    features.bar.findCount = { index: result.activeMatchOrdinal, total: result.matches };
    redrawBar(view);
  });

  process.on(
    'SIGWINCH',
    debounce(100, () => {
      for (const destructor of destructors) {
        destructor();
      }
      destructors.length = 0;

      const size = getWindowSize();
      updateViewSizes(view, size);
      registerPaints(view.layoutContainer.root.deviceLayout);
      // Re-pad the bar to the new pane width.
      redrawBar(view);
    }),
  );

  return view;
}

function updateViewSizes(view: WindowView, { width, height, rows }: Size) {
  const { content, barNode, contentNode } = view;
  const raster = getRasterScale();
  view.layoutContainer = layoutForPane({ width, height });

  // The cell the bar snaps to changed with the pane; recompute before layout.
  barNode.height = px(barHeight(rows, height, raster));
  calculateLayout(view.layoutContainer, [contentNode, barNode]);

  content.setContentSize(contentNode.computedLayout.width, contentNode.computedLayout.height);
}
