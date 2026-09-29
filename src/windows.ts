import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type WebContents,
  ipcMain,
  screen,
} from 'electron';
import path from 'node:path';
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
  type WindowSize,
} from 'awrit-native-rs';
import { loadZoomState, getZoomFactor, setZoomFactor, saveZoomState } from './zoom-state';

export function getWindowSize() {
  try {
    return rawGetWindowSize();
  } catch (e) {
    console_.error('Failed to get window size:', e);
    return { width: 0, height: 0, cols: 0, rows: 0 };
  }
}
import { options } from './args';
import { console_ } from './console';
import { TOOLBAR_PORT } from './runner/ports';
import {
  layout,
  row,
  px,
  auto,
  calculateLayout,
  type LayoutContainer,
  type LayoutNode,
} from './layout';
import { getDisplayScale } from './dpi';
import { cellSpan, getRasterScale, setPaneToBitmap } from './raster';
import { features } from './features';
import { updateCursor } from './tty/cursor';
import { debounce } from './debounce';
import { isTmuxSession } from './tty/tmux';

export type Actions = {
  back: () => void;
  forward: () => void;
  refresh: () => void;
};

export type WindowView = {
  toolbar: BrowserWindow;
  content: BrowserWindow;
  focusedContent: WebContents;
  layoutContainer: LayoutContainer;
  toolbarNode: LayoutNode;
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

const TOOLBAR_HEIGHT = 40;

/**
 * Toolbar height in DIP, snapped to one terminal cell so the terminal stretches
 * the toolbar by the same factor it stretches the content. 1.5px on a 42px
 * cell — cheap to keep aligned, and it keeps toolbar and page text the same
 * size. Falls back to the flat 40 when the pane reports no rows.
 */
function toolbarHeight(rows: number | undefined, paneHeight: number, raster: number) {
  if (!rows || rows <= 0) return TOOLBAR_HEIGHT;
  const cellInRasterPx = paneHeight / rows / raster;
  if (!Number.isFinite(cellInRasterPx) || cellInRasterPx <= 0) return TOOLBAR_HEIGHT;
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
    view.toolbar.webContents.setFrameRate(active ? 30 : 1); // Toolbar is mostly static
  }
}
/**
 * Creates a new window with a toolbar and main content area
 * @param size Window size
 * @param initialUrl URL to load in the main content area
 * @returns The created window
 */
export async function createWindowWithToolbar(
  size: { width: number; height: number; rows?: number },
  initialUrl = 'https://github.com/chase/awrit',
): Promise<WindowView> {
  const raster = getRasterScale();
  const layoutContainer = layoutForPane(size);

  // Create layout nodes for toolbar and content
  const toolbarNode = row({ height: px(toolbarHeight(size.rows, size.height, raster)), tag: 'toolbar' });
  const contentNode = row({ height: auto(), tag: 'content' });

  const hasAnimation = features.current?.loadFrame && features.current.compositeFrame;
  const useTmuxRenderer = isTmuxSession();

  // Calculate layout
  calculateLayout(layoutContainer, [toolbarNode, contentNode]);

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

  const toolbar = new BrowserWindow({
    ...sharedConstructorOptions,
    ...toolbarNode.computedLayout,

    webPreferences: {
      zoomFactor: 1,
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      // Windows stay show:false forever, so without this the renderer runs as
      // a backgrounded page: idle frames throttle to ~1Hz and the first scroll
      // after rest waits up to a second for a frame (06-06 checkpoint: "1sec
      // nothing, then a jump"). ODR must never background-throttle.
      backgroundThrottling: false,

      preload: path.resolve(__dirname, '../dist/preload.js'),
    },
  });

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
      // See toolbar: show:false windows would otherwise idle-throttle frames
      // to ~1Hz and delay the first scroll frame by up to a second.
      backgroundThrottling: false,
      disableDialogs: true,
    },
  });

  const destructors: Array<() => void> = [];

  let suppressionTimeout: NodeJS.Timeout | null = null;

  const startSuppression = () => {
    // @ts-expect-error
    content.isSuppressingPaint = true;
    // We do NOT suppress the toolbar anymore, so the progress bar stays visible
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

  let popupActive = false;

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
      destructors.push(
        registerPaintedContentTmux(toolbar, toolbarNode).destroy,
        registerPaintedContentTmux(content, contentNode).destroy,
      );
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
        registerPaintedContent(containerFrame, toolbar, toolbarNode).destroy,
        registerPaintedContent(containerFrame, content, contentNode).destroy,
      );

      // function registerPaints(size: WindowDimensions) {
      //   lastPaintSize = size;
      //   destructors.forEach((d) => { d(); });
      //   destructors.length = 0;
      //   refreshers.length = 0;

      //   if (hasAnimation) {
      //     // Content layer (z=0)
      //     const contentBuffer = new ShmGraphicBuffer(size.width * size.height * 4);
      //     const opaqueBlack = Buffer.alloc(size.width * size.height * 4).fill(Uint8Array.from([0, 0, 0, 255]));
      //     contentBuffer.write(opaqueBlack, size.width);
      //     out.placeCursor({ x: 0, y: 0 });
      //     const contentFrame = paintInitialFrame(contentBuffer, size, { z: 0 });
      //     const cRef = registerPaintedContent(contentFrame, content, contentNode);

      //     // Toolbar layer (z=1)
      //     const toolbarBuffer = new ShmGraphicBuffer(size.width * size.height * 4);
      //     const transparentBlack = Buffer.alloc(size.width * size.height * 4).fill(Uint8Array.from([0, 0, 0, 0]));
      //     toolbarBuffer.write(transparentBlack, size.width);
      //     out.placeCursor({ x: 0, y: 0 });
      //     const toolbarFrame = paintInitialFrame(toolbarBuffer, size, { z: 1 });
      //     const tRef = registerPaintedContent(toolbarFrame, toolbar, toolbarNode);

      //     destructors.push(contentFrame.free, toolbarFrame.free, cRef.destroy, tRef.destroy);
      //     refreshers.push(cRef.refresh, tRef.refresh);
    } else {
      destructors.push(
        registerPaintedContentFallback(toolbar, toolbarNode).destroy,
        registerPaintedContentFallback(content, contentNode).destroy,
      );
    }
  }

  registerPaints(layoutContainer.root.deviceLayout);

  // Add to extensions
  extensionsPromise.then((extensions) => {
    extensions.addTab(content.webContents, content);
  });
  await installedExtensionsPromise;

  if (options.dev) {
    toolbar.webContents.once('did-finish-load', () => {
      console_.error('toolbar loaded');
    });
    toolbar.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
      console_.error('toolbar failed to load', {
        errorCode,
        errorDescription,
      });
    });
    toolbar.webContents.loadURL(`http://localhost:${TOOLBAR_PORT}`);
    toolbar.webContents.openDevTools({
      mode: 'detach',
      title: 'Toolbar Dev Tools',
      activate: false,
    });
  } else {
    toolbar.webContents.loadFile('../dist/toolbar/index.html');
  }
  // The toolbar's UI is sized in absolute px for a ~40px bar (h-6 inputs,
  // text-sm, border-b-2). Its window is one raster cell tall, so at rasterScale 2
  // that content no longer fits and Chromium clips it — the terminal then
  // stretches the clipped bitmap 2x, which is what a squashed toolbar is. Laying
  // it out at the full cell height and letting zoom shrink it into the raster
  // reproduces the rasterScale 1 bar exactly, softer.
  resetForFrameQuirk(toolbar.webContents, 1 / raster);
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

  toolbar.webContents.on('cursor-changed', updateCursor);
  content.webContents.on('cursor-changed', updateCursor);

  const view: WindowView = {
    toolbar,
    content,
    focusedContent: content.webContents,
    layoutContainer,
    toolbarNode,
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

  // Set up IPC for toolbar interactions
  setupToolbarIPC(toolbar.webContents, content.webContents);

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
    }),
  );

  return view;
}

function updateViewSizes(view: WindowView, { width, height, rows }: Size) {
  const { toolbar, content, toolbarNode, contentNode } = view;
  const raster = getRasterScale();
  view.layoutContainer = layoutForPane({ width, height });

  // The cell the toolbar snaps to changed with the pane; recompute before layout.
  toolbarNode.height = px(toolbarHeight(rows, height, raster));
  calculateLayout(view.layoutContainer, [toolbarNode, contentNode]);

  // Update window sizes based on layout
  toolbar.setContentSize(toolbarNode.computedLayout.width, toolbarNode.computedLayout.height);
  content.setContentSize(contentNode.computedLayout.width, contentNode.computedLayout.height);
}

function setupToolbarIPC(
  toolbarContents: Electron.WebContents,
  contentContents: Electron.WebContents,
) {
  ipcMain.on('toolbar:navigate-back', () => {
    if (contentContents.navigationHistory.canGoBack()) {
      contentContents.navigationHistory.goBack();
    }
  });

  ipcMain.on('toolbar:navigate-forward', () => {
    if (contentContents.navigationHistory.canGoForward()) {
      contentContents.navigationHistory.goForward();
    }
  });

  ipcMain.on('toolbar:navigate-refresh', () => {
    contentContents.reload();
  });

  ipcMain.on('toolbar:navigate-to', (_event, url: string) => {
    contentContents.loadURL(url);
  });

  contentContents.on('did-start-loading', () => {
    toolbarContents.send('content:loading-started');
  });

  contentContents.on('did-stop-loading', () => {
    toolbarContents.send('content:loading-stopped');
  });

  contentContents.on('did-navigate', (_event, url) => {
    toolbarContents.send('content:url-changed', url);
  });

  contentContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) {
      toolbarContents.send('content:url-changed', url);
    }
  });

  contentContents.on('did-navigate', () => {
    const navigationState = {
      canGoBack: contentContents.navigationHistory.canGoBack(),
      canGoForward: contentContents.navigationHistory.canGoForward(),
    };
    toolbarContents.send('content:navigation-state-changed', navigationState);
  });
}
