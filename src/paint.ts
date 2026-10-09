import fs from 'node:fs';
import { getWindowSize, pinTexture, ShmGraphicBuffer, unpinTexture } from './native';
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
import { FrameCoalescer } from './tty/frameCoalescer';
import { TmuxRenderer } from './tty/tmuxRenderer';

/** Shared-texture paint path gate (06-06). Default on; config.js can disable. */
let sharedTextureEnabled = true;
export function setSharedTexture(value: unknown): void {
  const v = typeof value === 'boolean' ? value : true;
  sharedTextureEnabled = v;
}
export function getSharedTexture(): boolean {
  return sharedTextureEnabled;
}

/** Everything needed to encode and place one frame, captured at paint time. */
type PaintJob = {
  image: NativeImage;
  dirty: Rectangle;
  imageSize: { width: number; height: number };
  colsBase: number;
  rowsBase: number;
  scaleX: number;
  scaleY: number;
  baseStartCol: number;
  baseStartRow: number;
  pane: { cols: number; rows: number };
  tArrive: number | undefined;
  cells: CellRegion | null;
};

/** A fallback frame plus its arrival time, so the coalescing wait stays
 * visible in the arrive→encode segment instead of distorting it. */
type FallbackFrame = {
  image: NativeImage;
  tArrive: number | undefined;
};

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
type TmuxShmMedia = {
  nameBase64: string;
  width: number;
  height: number;
};
type TmuxPaintRenderer = {
  close(): void;
  releaseSlot(slotId: number): void;
  renderPixels(
    prepare: () => TmuxShmMedia,
    rasterBytes: number,
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

// Retired shm segments, kept referenced for the process lifetime.
//
// Dropping a `ShmGraphicBuffer` runs its napi `ObjectFinalize`, which calls
// `shm_unlink` — removing a segment the terminal may still be reading, because
// the terminal consumes the pixels asynchronously from the escape code that
// named it. Holding a reference here prevents that GC-driven unlink for
// segments a resize cycle retired. Leak is bounded: one ring per resize, and a
// resize is rare.
const keptBuffers_ = new Set<ShmGraphicBuffer>();

// Mirrors perf.ts: read once at load, so the probe below costs nothing when off.
const perfEnabled = process.env.AWRIT_PERF === '1';

/**
 * Count shm-backed fds (memfd + /dev/shm) this process holds. 06-06 starvation
 * probe: during scroll Electron emits ever fewer paint events (12/s → 5/s over
 * ~60s at constant input) while our coalescer stays idle — a *rising* count
 * means frames' shared memory is pinned awaiting GC and the capturer's buffer
 * pool starves (fixable here); *flat* means frame production itself degrades
 * inside Electron. Never throws: no /proc → 0.
 */
function countShmFds(): number {
  let n = 0;
  try {
    for (const fd of fs.readdirSync('/proc/self/fd')) {
      try {
        const link = fs.readlinkSync(`/proc/self/fd/${fd}`);
        if (link.includes('memfd') || link.startsWith('/dev/shm/')) n++;
      } catch {
        // fd closed between readdir and readlink
      }
    }
  } catch {
    // non-Linux or /proc unavailable
  }
  return n;
}

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
      perfGeometry(w, imageSize);

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

/**
 * Log the frame↔pane pixel relationship (06-04 AC-1) for every path, not just
 * tmux: frame is what we raster, pane is what the terminal can display, and
 * `raster` is the config knob relating them. Without this the non-tmux paths
 * are unmeasurable — a placement regression there is invisible in perf.log.
 */
function perfGeometry(w: BrowserWindow, imageSize: { width: number; height: number }) {
  const termSize = getWindowSize();
  const [dipW, dipH] = w.getContentSize();
  perfValue('frame', `${imageSize.width}x${imageSize.height}`);
  perfValue('pane', `${termSize.width}x${termSize.height}`);
  perfValue('dip', `${dipW}x${dipH}`);
  perfValue('scale', getDisplayScale() ?? screen.getPrimaryDisplay().scaleFactor);
  perfValue('raster', getRasterScale());
  return termSize;
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

export function registerPaintedContentTmux(
  w: BrowserWindow,
  layoutNode: LayoutNode,
): PaintedContent {
  const contents = w.webContents;
  // Two slots: base carries full frames (replacing it repaints everything);
  // overlay carries the bounding box of all crops since the last full frame,
  // so every overlay cell is rewritten each crop — the renderer replaces
  // per-slot, and a single slot would blank the pane (it deletes the old image).
  const slotBase = allocateTmuxImageId();
  const slotOverlay = allocateTmuxImageId();
  let lastFrameSize: { width: number; height: number } | undefined;
  let overlayCells: CellRegion | undefined;
  // Cells asked for but not yet delivered. A frame is dropped only when a newer
  // one replaces it, so a dropped frame's region is folded into the survivor
  // rather than lost -- otherwise the pane keeps stale cells until a full frame.
  let queued: CellRegion | undefined;
  const coalescer = new FrameCoalescer<PaintJob>((job) => deliver(job));

  // A ring of shm segments per slot, refilled on every flush.
  //
  // The terminal reads a referenced segment *asynchronously*, out of band from
  // the escape code that named it, and unlinks it when done. Two hazards, both
  // observed as black frames, black bands and tearing:
  //
  //  1. `ShmGraphicBuffer::write` re-creates the segment (O_CREAT + ftruncate)
  //     under the same name. Refilling a segment the terminal is still reading
  //     hands it a half-written bitmap.
  //  2. Dropping a `ShmGraphicBuffer` (GC) runs `shm_unlink` on its name, so a
  //     segment that is merely *no longer referenced by us* can vanish from
  //     under a read the terminal has not finished. The buffers below are held
  //     for the lifetime of the window, so this cannot fire mid-read.
  //
  // PNG never had this problem: each frame's bytes were self-contained in its
  // own escape code, so there was no moving target.
  //
  // The ring is sized to the *largest* raster this window will send and never
  // resized. A crop declares its true w/h in the control data, so it reads only
  // the leading bytes of a larger segment — that is what the protocol means by
  // s=/v=. Reallocating per crop size (which changes on nearly every dirty
  // rect) would churn the ring and reintroduce hazard 2 via GC.
  //
  // ponytail: the pool self-grows from MIN_RING and only ever grows on a
  // resize, so there is no ring constant to tune. Without acks we cannot know
  // the terminal's real backlog; O_EXCL on write is the only liveness signal
  // available, because q=2 suppresses the replies a strict scheme would need.
  // Pool floor, so a fresh window has somewhere to go before its first resize.
  const MIN_RING = 4;
  const shmBySlot = new Map<number, { buffers: ShmGraphicBuffer[]; size: number; next: number }>();
  function prepareShm(slotId: number, pixels: Buffer, width: number, height: number) {
    let entry = shmBySlot.get(slotId);
    if (entry == null) {
      // Grow-only, sized to the first (full-frame) raster we see. Later crops
      // are smaller and fit; a *larger* raster grows the ring once.
      entry = { buffers: [], size: pixels.length, next: 0 };
      shmBySlot.set(slotId, entry);
    }
    if (pixels.length > entry.size) {
      // Only a window resize gets here. Keep the old buffers alive in a fresh
      // ring: a finalize would unlink a name the terminal may still read.
      const grown: { buffers: ShmGraphicBuffer[]; size: number; next: number } = {
        buffers: [],
        size: pixels.length,
        next: entry.next,
      };
      for (const b of entry.buffers) keptBuffers_.add(b);
      entry = grown;
      shmBySlot.set(slotId, entry);
    }
    const tShm = perfTime();
    // Walk the pool from the rotation cursor. `try_write` opens with O_EXCL and
    // so fails while the terminal has not yet read that segment -- the protocol
    // has the terminal unlink a t=s segment once it has consumed it, which makes
    // the name's existence a liveness signal. Skip a busy segment instead of
    // clobbering a read in progress. Depth therefore follows the real backlog
    // rather than a guessed constant, and needs no acks: q=2 suppresses them
    // because tmux feeds the replies back as keystrokes.
    const attempts = Math.max(entry.buffers.length, MIN_RING);
    for (let i = 0; i < attempts; i++) {
      if (entry.buffers.length <= i) entry.buffers.push(new ShmGraphicBuffer(entry.size));
      const index = entry.next % entry.buffers.length;
      const buffer = entry.buffers[index];
      entry.next = (index + 1) % entry.buffers.length;
      if (buffer.tryWrite(pixels, width)) {
        perfEnd('submit.toShm', tShm);
        return { nameBase64: buffer.nameBase64, width, height };
      }
    }
    // Every segment is still in flight: the terminal is further behind than the
    // pool. Give this frame a segment of its own rather than a torn one; the
    // pool stays large until the terminal catches up.
    const spare = new ShmGraphicBuffer(entry.size);
    entry.buffers.push(spare);
    spare.write(pixels, width);
    perfEnd('submit.toShm', tShm);
    return { nameBase64: spare.nameBase64, width, height };
  }

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

    const tArrive = perfTime();
    try {
      const imageSize = image.getSize();
      const termSize = perfGeometry(w, imageSize);
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

      // Cells this event *asks* for. Unioning with what is still undelivered
      // happens at drain time, because a frame dropped in between must not take
      // its region with it.
      const cells: CellRegion | null = sizeChanged
        ? null
        : snapDirtyCells(dirty, colsBase, rowsBase, scaleX, scaleY);

      // A full frame supersedes any queued crop, so null absorbs what is pending.
      if (cells == null) {
        queued = undefined;
      } else if (queued) {
        queued = unionCells(queued, cells);
      } else {
        queued = cells;
      }

      const job: PaintJob = {
        image,
        dirty,
        imageSize,
        colsBase,
        rowsBase,
        scaleX,
        scaleY,
        baseStartCol,
        baseStartRow,
        pane,
        tArrive,
        cells: queued ?? null,
      };
      if (coalescer.offer(job) > 0) perfCount('submit.superseded');
      perfCount('submit.events');
    } catch (error) {
      console_.error('tmux renderer paint failed; retained frame queued for retry', error);
    }
  }

  /**
   * Encode and deliver one frame. Every expensive step lives here, *after* the
   * coalesce decision, so a frame that gets superseded is never encoded.
   */
  async function deliver(job: PaintJob): Promise<void> {
    const renderer = tmuxRenderer;
    if (!renderer) return;
    // This job owns whatever was queued when it was offered; those cells are
    // being delivered now, so hand the accumulator back for the ones that
    // arrive during the drain.
    queued = undefined;
    try {
      const { colsBase, rowsBase, scaleX, scaleY } = job;
      let cells = job.cells;
      if (cells && overlayCells) {
        cells = unionCells(overlayCells, cells);
        if (cells.l === 0 && cells.t === 0 && cells.r >= colsBase && cells.b >= rowsBase) {
          cells = null; // bounding box covers everything — plain full frame
        }
      }

      let startCol = job.baseStartCol;
      let startRow = job.baseStartRow;
      let cols = colsBase;
      let rows = rowsBase;
      let source = job.image;
      if (cells) {
        overlayCells = cells;
        const x = Math.round(cells.l * scaleX);
        const y = Math.round(cells.t * scaleY);
        source = job.image.crop({
          x,
          y,
          width: Math.round(cells.r * scaleX) - x,
          height: Math.round(cells.b * scaleY) - y,
        });
        cols = cells.r - cells.l;
        rows = cells.b - cells.t;
        startCol = job.baseStartCol + cells.l;
        startRow = job.baseStartRow + cells.t;
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
          pane: job.pane,
          cropped: cells != null,
        });
      }

      if (!cells) {
        // Full frame supersedes any crop overlay; drop it first so no batch
        // re-flushes a stale crop after the base has covered its cells.
        renderer.releaseSlot(slotOverlay);
      }

      // Base frames reuse their slot id as the image id. Unlike PNG, where the
      // bytes ride along inside the escape sequence, a t=s image is only a
      // filename: the terminal has to open the segment and upload it to a
      // texture before it has anything to draw. A fresh id per frame means
      // every frame's placeholders can be applied while that frame's texture is
      // still uploading, and those cells fall back to the pane background --
      // the transient partial black row. A stable id is already resident, so
      // there is no such window. Crops are rare and short-lived, and want a
      // fresh id so a stale crop cannot linger.
      const imageId = cells ? allocateTmuxImageId() : slotId;
      const tBitmap = perfTime();
      const { width, height } = source.getSize();
      const pixels = source.toBitmap();
      perfEnd('submit.toBitmap', tBitmap);
      perfEnd('submit.arrive→raster', job.tArrive);
      const tSubmit = perfTime();
      await renderer.renderPixels(
        () => prepareShm(slotId, pixels, width, height),
        pixels.length,
        imageId,
        cols,
        rows,
        startCol,
        startRow,
        job.pane,
        slotId,
      );
      perfEnd('submit.raster→submit', tSubmit);
      perfCount('submit.completed');
    } catch (error) {
      console_.error('tmux renderer paint failed; retained frame queued for retry', error);
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
  let destroyed = false;
  // 06-06 probe: when the previous frame finished. `paint.gap` is the idle time
  // between frames. Measured on the shared-texture path: gap is mostly idle
  // against the per-frame work, so the drain is not saturated. Which stage
  // bounds the rate is not settled by this timer — see the notes in .paul.
  // Yielding again before the shm write to widen the window was tried
  // and reverted: it moved throughput 4→5.3 paints/s (inside the noise) while
  // roughly doubling arrive→encode latency. `raf` alone cannot tell upstream
  // throttle from our own cost; `gap` can.
  let lastDone: number | undefined;

  const result: PaintedContent = {
    destroy() {
      destroyed = true;
      contents.off('paint', paint);
      if (rafTimer) clearInterval(rafTimer);
      this.buffer = undefined;
      paintedImage?.free();
      paintedImage = undefined;
    },
  };

  // One-slot keep-newest buffer in front of the expensive work (06-06 Task 2).
  // Every frame costs a synchronous ~35-45ms toBitmap + shm write on the main
  // thread, so during scroll the paint events used to queue up faster than
  // they drained and the session degraded — and that backlog is not per-page
  // state, so a page load never recovered it. The drain yields one macrotask
  // before doing anything: events already queued behind this one dispatch as
  // cheap offers and collapse onto the slot, so only the newest pays the cost.
  // A synchronous drain inside offer() would coalesce nothing — that is the
  // whole reason for the yield.
  const coalescer = new FrameCoalescer<FallbackFrame>((frame) => drain(frame));

  function paint(event: any, _dirty: Rectangle, image: NativeImage) {
    try {
      // GPU shared-texture frame (06-06). Electron passes an *empty* bitmap in
      // this mode, so this is the only source of pixels — but it is also 3-4x
      // faster than the shm capture, which is capped at 5-10 paints/s while the
      // renderer runs at 60 (see .paul/codebase/ARCHITECTURE.md).
      const texture = event?.texture;
      if (texture && getSharedTexture()) {
        paintTexture(texture);
        return;
      }
      // In shared-texture mode the bitmap is always empty, so a paint with a
      // real bitmap here means Electron changed its mind. Never blit an empty
      // image — that would push garbage to the terminal.
      if (image.isEmpty()) {
        perfCount('paint.emptyBitmap');
        return;
      }
      if (coalescer.offer({ image, tArrive: perfTime() }) > 0) {
        perfCount('paint.superseded');
      }
    } catch (error) {
      // A paint failure must not become an unhandled rejection (06-02 lesson).
      console_.error('fallback paint failed', error);
    }
  }

  // Textures cannot be coalesced: only a handful may exist at once, so each one
  // is pinned and handed straight back, and the pixels are read from the pin
  // afterwards. The texture is therefore not held for the ~20ms read.
  function paintTexture(texture: any) {
    // Electron's release is not documented as idempotent, so do it exactly once.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      texture.release();
    };
    try {
      if (destroyed || options['no-paint']) {
        release();
        return;
      }
      const info = texture.textureInfo;
      const plane = info?.planes?.[0];
      const imageSize = { width: info.codedSize.width, height: info.codedSize.height };
      // Guard the zero-size frame the compositor emits on resize (06-06 log).
      if (!plane || imageSize.width === 0 || imageSize.height === 0) {
        release();
        return;
      }

      perfGeometry(w, imageSize);
      const imageBufferSize = imageSize.width * imageSize.height * 4;
      const position = {
        x: coordsFromPx(cellToPxX, layoutNode.deviceLayout.x),
        y: coordsFromPx(cellToPxY, layoutNode.deviceLayout.y),
      };
      if (perfEnabled) {
        const geom = `${imageSize.width}x${imageSize.height}`;
        const layout = `${plane.stride}/${plane.offset}/${plane.size}`;
        const rect = info.contentRect;
        const dirty = rect ? `${rect.width}x${rect.height}@${rect.x},${rect.y}` : 'none';
        perfValue('tex', `${info.pixelFormat} ${geom} ${layout} ${info.modifier} ${dirty}`);
      }

      // Pin before releasing: dup'ing the fd keeps the dmabuf alive, so the
      // capturer gets its texture back after ~0.2ms instead of after the 25ms
      // read, and can run ahead while we copy. Holding the texture is what
      // throttled the frame rate, not the copy (see .paul/codebase/ARCHITECTURE.md).
      const tPin = perfTime();
      const pin = pinTexture(
        plane.fd,
        imageSize.width,
        imageSize.height,
        plane.stride,
        plane.offset,
        plane.size,
      );
      perfEnd('paint.tex.pin', tPin);
      release();

      try {
        const tWrite = perfTime();
        if (result.buffer == null || (result.size != null && imageBufferSize > result.size)) {
          // First frame, or the pane grew: a fresh shm and a fresh placement.
          paintedImage?.free();
          const fresh = new ShmGraphicBuffer(imageBufferSize);
          fresh.writeTexture(pin, info.pixelFormat === 'bgra');
          paintedImage = paintImage(fresh, imageSize, position, cellSpan(imageSize, termSize));
          result.buffer = fresh;
          result.size = imageBufferSize;
        } else {
          result.buffer.writeTexture(pin, info.pixelFormat === 'bgra');
          paintedImage?.present();
        }
        perfEnd('paint.tex.write', tWrite);
        if (perfEnabled) {
          // Split the blit: [shm open+truncate+map, convert, unmap]. The convert
          // is the GPU read; the other two are our own per-frame syscall tax.
          const [map, convert, unmap] = result.buffer.timings();
          perfValue('texmap', map.toFixed(1));
          perfValue('texconvert', convert.toFixed(1));
          perfValue('texunmap', unmap.toFixed(1));
          perfValue('shmfd', countShmFds());
        }
        perfEnd('paint.gap', lastDone);
        lastDone = perfTime();
        perfCount('paint.tex');
        perfCount('paint.completed');
      } finally {
        // The pin is consumed by write_texture, but if the blit threw before
        // reaching it, drop the mapping here — a leaked dmabuf mapping pins
        // GPU memory for the life of the process.
        unpinTexture(pin);
      }
    } finally {
      // No-op if already released above or on an early return.
      release();
    }
  }

  async function drain({ image, tArrive }: FallbackFrame): Promise<void> {
    // Yield first so already-queued paint events dispatch and collapse — see
    // the coalescer note above.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Stale or torn down: a newer frame owns the slot, or destroy() ran while
    // we were yielding. Skip the work; the pump drains what is pending.
    if (destroyed || coalescer.hasPending) return;
    perfEnd('paint.gap', lastDone);
    perfPending('paint', 1);
    try {
      const imageSize = image.getSize();
      perfGeometry(w, imageSize);
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
      if (perfEnabled) perfValue('shmfd', countShmFds());
      if (perfEnabled) perfValue('fr', contents.getFrameRate());
      perfCount('paint.completed');
      lastDone = perfTime();
    } catch (error) {
      // Same containment as the animation handler: never let a paint error
      // escape as an unhandled rejection.
      console_.error('fallback paint failed', error);
    } finally {
      perfPending('paint', -1);
    }
  }
  contents.on('paint', paint);
  // 06-06 probe: renderer-side animation ticks per second. raf≈60 while
  // paint≈10 → production is fine and the browser main thread (our drain) is
  // the cap; raf≈paint → frames aren't even being produced. beginFrameSubscription
  // was blind here (never fires for offscreen), so count rAF in the page.
  // Re-injected after navigation; all failures swallowed (perf must never
  // touch the session).
  let rafTimer: ReturnType<typeof setInterval> | undefined;
  const injectRaf = () => {
    contents
      .executeJavaScript(
        '(()=>{let n=0;const t=()=>{n++;requestAnimationFrame(t)};requestAnimationFrame(t);window.__awritRaf=()=>{const v=n;n=0;return v};return 1})()',
      )
      .catch(() => {});
  };
  if (perfEnabled) {
    injectRaf();
    rafTimer = setInterval(() => {
      contents
        .executeJavaScript('window.__awritRaf ? window.__awritRaf() : -1')
        .then((v) => {
          if (v === -1) injectRaf();
          else if (typeof v === 'number') perfValue('raf', v);
        })
        .catch(() => {});
    }, 1000);
  }

  weakPaintedContents_.set(w, result);
  return result;
}
