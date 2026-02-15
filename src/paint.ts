import { getWindowSize, ShmGraphicBuffer } from 'awrit-native-rs';
import type { BrowserWindow, NativeImage, Rectangle } from 'electron';
import { abort } from './abort';
import { options } from './args';
import { console_ } from './console';
import { features } from './features';
import type { LayoutNode } from './layout';
import {
  type AnimationFrame,
  type InitialFrame,
  type PaintedImage,
  paintImage,
} from './tty/kittyGraphics';
import { getPaneSize, isTmuxSession } from './tty/tmux';
import { TmuxRenderer } from './tty/tmuxRenderer';
import { TimgRenderer } from './tty/timgRenderer';

type PaintedContent = {
  frame?: AnimationFrame;
  buffer?: ShmGraphicBuffer;
  size?: number;
  expectedWinSize?: {
    width: number;
    height: number;
  };
  destroy(): void;
};

const weakPaintedContents_ = new WeakMap<BrowserWindow, PaintedContent>();
type TmuxPaintRenderer = {
  close(): void;
  releaseSlot(slotId: number): void;
  renderPng(
    pngBuffer: Buffer,
    imageId: number,
    cols: number,
    rows: number,
    startCol: number,
    startRow: number,
    pane: { cols: number; rows: number },
    slotId: number,
  ): Promise<void>;
};

function createTmuxRenderer(): TmuxPaintRenderer | null {
  if (!isTmuxSession()) return null;

  const requestedRenderer = options['tmux-renderer'];
  if (requestedRenderer && requestedRenderer !== 'native' && requestedRenderer !== 'timg') {
    console_.error(
      `Unknown tmux renderer "${requestedRenderer}". Falling back to "native". Valid values: native|timg`,
    );
  }

  const renderer = requestedRenderer === 'timg' ? 'timg' : 'native';
  if (renderer === 'timg') {
    console_.error('Using tmux renderer backend: timg');
    return new TimgRenderer();
  }
  return new TmuxRenderer();
}

const tmuxRenderer = createTmuxRenderer();
let nextTmuxImageId = 1;
const TMUX_RENDER_RETRY_BASE_MS = 250;
const TMUX_RENDER_RETRY_MAX_MS = 5_000;
let tmuxRendererFailures = 0;
let tmuxRendererRetryAfter = 0;

function allocateTmuxImageId() {
  nextTmuxImageId = (nextTmuxImageId + 1) & 0xffffff;
  if (nextTmuxImageId === 0) nextTmuxImageId = 1;
  return nextTmuxImageId;
}

function canRenderWithTmux(now = Date.now()) {
  return now >= tmuxRendererRetryAfter;
}

function noteTmuxRendererSuccess() {
  if (tmuxRendererFailures > 0 && options['debug-paint']) {
    console_.error('tmux renderer recovered');
  }
  tmuxRendererFailures = 0;
  tmuxRendererRetryAfter = 0;
}

function handleTmuxRendererFailure(error: unknown) {
  tmuxRendererFailures += 1;
  const delayMs = Math.min(
    TMUX_RENDER_RETRY_BASE_MS * 2 ** (tmuxRendererFailures - 1),
    TMUX_RENDER_RETRY_MAX_MS,
  );
  tmuxRendererRetryAfter = Date.now() + delayMs;
  console_.error(`tmux renderer paint failed; retrying in ${delayMs}ms`, error);
}

export function closeTmuxRenderer() {
  tmuxRendererFailures = 0;
  tmuxRendererRetryAfter = 0;
  tmuxRenderer?.close();
}

// assumes animation is supported
export function registerPaintedContent(
  containerFrame: InitialFrame,
  w: BrowserWindow,
  layoutNode: LayoutNode,
): PaintedContent {
  const contents = w.webContents;
  const frameNumber = 2 + containerFrame.paintedContent++;

  w.on('resize', () => {
    // result.frame?.delete();
    // result.frame = containerFrame.loadFrame(2, compositeName, bounds);
    // console_.error('bounds-changed', id, bounds);
  });

  if (!features.current) {
    console_.error('No features available');
    abort();
  }

  const result: PaintedContent = {
    destroy() {
      contents.off('paint', paint);
      this.buffer = undefined;
      this.frame?.delete();
      this.frame = undefined;
    },
  };

  async function paint(_: any, _dirty: Rectangle, image: NativeImage) {
    const imageSize = image.getSize();

    const imageBufferSize = imageSize.width * imageSize.height * 4;
    if (result.buffer == null) {
      result.buffer = new ShmGraphicBuffer(imageBufferSize);
    }
    if (options['debug-paint']) {
      console_.error('paint', result.buffer.nameBase64, image.getSize());
    }
    if (options['no-paint']) {
      return;
    }

    if (result.size != null && imageBufferSize > result.size) {
      if (options['debug-paint']) {
        console_.error('replace buffer', result.buffer.nameBase64, result.size, imageBufferSize);
      }
      result.buffer = new ShmGraphicBuffer(imageBufferSize);
      result.size = imageBufferSize;
    }

    const buffer = image.toBitmap();
    result.buffer.write(buffer, imageSize.width);
    containerFrame
      .loadFrame(frameNumber, result.buffer, imageSize)
      .composite(layoutNode.deviceLayout);
  }

  contents.on('paint', paint);

  weakPaintedContents_.set(w, result);
  return result;
}

function coordsFromPx(cellToPx: number, px: number) {
  return {
    cell: Math.ceil(px / cellToPx),
    px: Math.ceil(px % cellToPx),
  };
}

function safeCellToPx(size: { cols: number; rows: number; width: number; height: number }) {
  let x = size.width / size.cols;
  let y = size.height / size.rows;
  if (!Number.isFinite(x) || x <= 0) x = 1;
  if (!Number.isFinite(y) || y <= 0) y = 1;
  return { x, y };
}

function startCellFromPx(px: number, cellToPx: number) {
  return Math.max(0, Math.floor(px / cellToPx));
}

function colsRowsFromPx(size: { width: number; height: number }, cellToPxX: number, cellToPxY: number) {
  return {
    cols: Math.max(1, Math.ceil(size.width / cellToPxX)),
    rows: Math.max(1, Math.ceil(size.height / cellToPxY)),
  };
}

export function registerPaintedContentTmux(w: BrowserWindow, layoutNode: LayoutNode): PaintedContent {
  const contents = w.webContents;
  const slotId = allocateTmuxImageId();

  const result: PaintedContent = {
    destroy() {
      contents.off('paint', paint);
      tmuxRenderer?.releaseSlot(slotId);
      this.buffer = undefined;
    },
  };

  async function paint(_: any, _dirty: Rectangle, image: NativeImage) {
    if (!tmuxRenderer) return;
    if (!canRenderWithTmux()) return;
    if (options['no-paint']) return;

    try {
      const imageSize = image.getSize();
      const imageBufferSize = imageSize.width * imageSize.height * 4;

      if (result.buffer == null || (result.size != null && imageBufferSize > result.size)) {
        // Use existing lifecycle to keep memory use consistent with other renderers.
        result.buffer = new ShmGraphicBuffer(imageBufferSize);
        result.size = imageBufferSize;
      }

      const termSize = getWindowSize();
      const cellToPx = safeCellToPx(termSize);
      const { cols, rows } = colsRowsFromPx(imageSize, cellToPx.x, cellToPx.y);
      const startCol = startCellFromPx(layoutNode.deviceLayout.x, cellToPx.x);
      const startRow = startCellFromPx(layoutNode.deviceLayout.y, cellToPx.y);
      const pane = getPaneSize();

      if (options['debug-paint']) {
        console_.error('tmux paint', { slotId, cols, rows, startCol, startRow, pane });
      }

      const imageId = allocateTmuxImageId();
      await tmuxRenderer.renderPng(image.toPNG(), imageId, cols, rows, startCol, startRow, pane, slotId);
      noteTmuxRendererSuccess();
    } catch (error) {
      handleTmuxRendererFailure(error);
    }
  }

  contents.on('paint', paint);
  weakPaintedContents_.set(w, result);
  return result;
}

export function registerPaintedContentFallback(
  w: BrowserWindow,
  layoutNode: LayoutNode,
): PaintedContent {
  const contents = w.webContents;
  const termSize = getWindowSize();
  const cellToPxX = termSize.width / termSize.cols;
  const cellToPxY = termSize.height / termSize.rows;
  let paintedImage: PaintedImage | undefined;

  const result: PaintedContent = {
    destroy() {
      contents.off('paint', paint);
      this.buffer = undefined;
      paintedImage?.free();
      paintedImage = undefined;
    },
  };

  async function paint(_: any, _dirty: Rectangle, image: NativeImage) {
    const imageSize = image.getSize();
    const imageBufferSize = imageSize.width * imageSize.height * 4;

    const position = {
      x: coordsFromPx(cellToPxX, layoutNode.deviceLayout.x),
      y: coordsFromPx(cellToPxY, layoutNode.deviceLayout.y),
    };

    let replace = true;
    if (result.buffer == null || (result.size != null && imageBufferSize > result.size)) {
      replace = false;
      const buffer = new ShmGraphicBuffer(imageBufferSize);
      paintedImage?.free();
      buffer.write(image.toBitmap(), imageSize.width);
      paintedImage = paintImage(buffer, imageSize, position);

      result.buffer = buffer;
      result.size = imageBufferSize;
    }
    if (options['debug-paint']) {
      console_.error('paint', result.buffer.nameBase64, image.getSize());
    }
    if (options['no-paint']) {
      return;
    }

    if (replace && paintedImage) {
      paintedImage.replace(image.toBitmap());
    }
  }
  contents.on('paint', paint);

  weakPaintedContents_.set(w, result);
  return result;
}
