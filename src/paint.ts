import { getWindowSize, ShmGraphicBuffer } from 'awrit-native-rs';
import type { BrowserWindow, NativeImage, Rectangle } from 'electron';
import { screen } from 'electron';
import { abort } from './abort';
import { options } from './args';
import { console_ } from './console';
import { getDisplayScale } from './dpi';
import { features } from './features';
import type { LayoutNode } from './layout';
import { perfCount, perfEnd, perfPending, perfTime, perfValue } from './perf';
import { cellSpan, getRasterScale, rasterCellToPx } from './raster';
import { createImageIdAllocator } from './tty/imageIds';
import {
  type AnimationFrame,
  type InitialFrame,
  type PaintedImage,
  paintImage,
} from './tty/kittyGraphics';
import { getPaneSize, isTmuxSession } from './tty/tmux';
import { TmuxRenderer } from './tty/tmuxRenderer';

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
  return new TmuxRenderer();
}

const tmuxRenderer = createTmuxRenderer();
const allocateTmuxImageId = createImageIdAllocator();

export function closeTmuxRenderer() {
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
    perfPending('paint', 1);
    const tArrive = perfTime();
    try {
      const imageSize = image.getSize();

      const imageBufferSize = imageSize.width * imageSize.height * 4;
      if (result.buffer == null) {
        result.buffer = new ShmGraphicBuffer(imageBufferSize);
        result.size = imageBufferSize;
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
      perfEnd('paint.arrive→encode', tArrive);
      const tSubmit = perfTime();
      containerFrame
        .loadFrame(frameNumber, result.buffer, imageSize)
        .composite(layoutNode.deviceLayout);
      perfEnd('paint.encode→submit', tSubmit);
      perfCount('paint.completed');
    } catch (error) {
      // A paint failure must not become an unhandled rejection: it would kill
      // the process mid-escape-stream and wedge the terminal.
      console_.error('paint failed', error);
    } finally {
      perfPending('paint', -1);
    }
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

function startCellFromPx(px: number, cellToPx: number) {
  return Math.max(0, Math.floor(px / cellToPx));
}

// Overlay crop tracked in base-image cell indices. The bounding rect is
// rewritten in full on every crop so no cell ever points at a deleted image.
type CellRegion = { l: number; t: number; r: number; b: number };

// Snap a dirty rect outward to whole cells of the BASE image mapping
// (scale = imageSize / cols, NOT nominal cellToPx — the terminal stretches
// the image over cols cells, and the two differ when the cell size is
// fractional). Returns null for full-frame or unusable rects.
function snapDirtyCells(
  dirty: Rectangle,
  colsBase: number,
  rowsBase: number,
  scaleX: number,
  scaleY: number,
): CellRegion | null {
  const l = Math.max(0, Math.floor(dirty.x / scaleX));
  const t = Math.max(0, Math.floor(dirty.y / scaleY));
  const r = Math.min(colsBase, Math.ceil((dirty.x + dirty.width) / scaleX));
  const b = Math.min(rowsBase, Math.ceil((dirty.y + dirty.height) / scaleY));
  if (r <= l || b <= t) return null;
  if (l === 0 && t === 0 && r >= colsBase && b >= rowsBase) return null;
  return { l, t, r, b };
}

function unionCells(a: CellRegion, b: CellRegion): CellRegion {
  return {
    l: Math.min(a.l, b.l),
    t: Math.min(a.t, b.t),
    r: Math.max(a.r, b.r),
    b: Math.max(a.b, b.b),
  };
}

export function registerPaintedContentTmux(w: BrowserWindow, layoutNode: LayoutNode): PaintedContent {
  const contents = w.webContents;
  // Two slots: base carries full frames (replacing it repaints everything);
  // overlay carries the bounding box of all crops since the last full frame,
  // so every overlay cell is rewritten each crop — the renderer replaces
  // per-slot, and a single slot would blank the pane (it deletes the old image).
  const slotBase = allocateTmuxImageId();
  const slotOverlay = allocateTmuxImageId();
  let lastFrameSize: { width: number; height: number } | undefined;
  let overlayCells: CellRegion | undefined;

  const result: PaintedContent = {
    destroy() {
      contents.off('paint', paint);
      tmuxRenderer?.releaseSlot(slotBase);
      tmuxRenderer?.releaseSlot(slotOverlay);
      this.buffer = undefined;
    },
  };

  async function paint(_: any, dirty: Rectangle, image: NativeImage) {
    if (!tmuxRenderer) return;
    if (options['no-paint']) return;

    perfPending('submit', 1);
    const tArrive = perfTime();
    try {
      const imageSize = image.getSize();
      const termSize = getWindowSize();
      // Frame↔pane pixel relationship (06-04 AC-1): frame is what we raster,
      // pane is what the terminal can display. R = frame.width / termSize.width
      // decides the readability fix; nothing here depends on it yet.
      const [dipW, dipH] = w.getContentSize();
      perfValue('frame', `${imageSize.width}x${imageSize.height}`);
      perfValue('pane', `${termSize.width}x${termSize.height}`);
      perfValue('dip', `${dipW}x${dipH}`);
      perfValue('scale', getDisplayScale() ?? screen.getPrimaryDisplay().scaleFactor);
      perfValue('raster', getRasterScale());
      const cellToPx = rasterCellToPx(termSize);
      const baseStartCol = startCellFromPx(layoutNode.deviceLayout.x, cellToPx.x);
      const baseStartRow = startCellFromPx(layoutNode.deviceLayout.y, cellToPx.y);
      const pane = getPaneSize();

      // Base mapping: same math the full-frame path has always used.
      const colsBase = Math.max(1, Math.ceil(imageSize.width / cellToPx.x));
      const rowsBase = Math.max(1, Math.ceil(imageSize.height / cellToPx.y));
      const scaleX = imageSize.width / colsBase;
      const scaleY = imageSize.height / rowsBase;

      const sizeChanged =
        lastFrameSize == null ||
        lastFrameSize.width !== imageSize.width ||
        lastFrameSize.height !== imageSize.height;

      let cells: CellRegion | null = sizeChanged
        ? null
        : snapDirtyCells(dirty, colsBase, rowsBase, scaleX, scaleY);
      if (cells && overlayCells) {
        cells = unionCells(overlayCells, cells);
        if (cells.l === 0 && cells.t === 0 && cells.r >= colsBase && cells.b >= rowsBase) {
          cells = null; // bounding box covers everything — plain full frame
        }
      }

      let startCol = baseStartCol;
      let startRow = baseStartRow;
      let cols = colsBase;
      let rows = rowsBase;
      let source = image;
      if (cells) {
        overlayCells = cells;
        const x = Math.round(cells.l * scaleX);
        const y = Math.round(cells.t * scaleY);
        source = image.crop({
          x,
          y,
          width: Math.round(cells.r * scaleX) - x,
          height: Math.round(cells.b * scaleY) - y,
        });
        cols = cells.r - cells.l;
        rows = cells.b - cells.t;
        startCol = baseStartCol + cells.l;
        startRow = baseStartRow + cells.t;
      } else {
        overlayCells = undefined;
      }

      const slotId = cells ? slotOverlay : slotBase;
      if (options['debug-paint']) {
        console_.error('tmux paint', {
          slotId,
          cols,
          rows,
          startCol,
          startRow,
          pane,
          cropped: cells != null,
        });
      }

      if (!cells) {
        // Full frame supersedes any crop overlay; drop it first so no batch
        // re-flushes a stale crop after the base has covered its cells.
        tmuxRenderer.releaseSlot(slotOverlay);
      }

      const imageId = allocateTmuxImageId();
      const tPng = perfTime();
      const png = source.toPNG();
      perfEnd('submit.toPNG', tPng);
      perfEnd('submit.arrive→encode', tArrive);
      const tSubmit = perfTime();
      await tmuxRenderer.renderPng(
        png,
        imageId,
        cols,
        rows,
        startCol,
        startRow,
        pane,
        slotId,
      );
      perfEnd('submit.encode→submit', tSubmit);
      perfCount('submit.completed');
    } catch (error) {
      console_.error('tmux renderer paint failed; retained frame queued for retry', error);
    } finally {
      perfPending('submit', -1);
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
  const { x: cellToPxX, y: cellToPxY } = rasterCellToPx(termSize);
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
    perfPending('paint', 1);
    const tArrive = perfTime();
    try {
      const imageSize = image.getSize();
      const imageBufferSize = imageSize.width * imageSize.height * 4;

      const position = {
        x: coordsFromPx(cellToPxX, layoutNode.deviceLayout.x),
        y: coordsFromPx(cellToPxY, layoutNode.deviceLayout.y),
      };

      const tBitmap = perfTime();
      const bmp = image.toBitmap();
      perfEnd('paint.toBitmap', tBitmap);

      let replace = true;
      if (result.buffer == null || (result.size != null && imageBufferSize > result.size)) {
        replace = false;
        const tAlloc = perfTime();
        const buffer = new ShmGraphicBuffer(imageBufferSize);
        paintedImage?.free();
        buffer.write(bmp, imageSize.width);
        paintedImage = paintImage(buffer, imageSize, position, cellSpan(imageSize, termSize));
        perfEnd('paint.alloc', tAlloc);

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
        const tReplace = perfTime();
        paintedImage.replace(bmp);
        perfEnd('paint.replace', tReplace);
      }
      perfEnd('paint.arrive→encode', tArrive);
      perfCount('paint.completed');
    } catch (error) {
      // Same containment as the animation handler: never let a paint error
      // escape as an unhandled rejection.
      console_.error('fallback paint failed', error);
    } finally {
      perfPending('paint', -1);
    }
  }
  contents.on('paint', paint);

  weakPaintedContents_.set(w, result);
  return result;
}
