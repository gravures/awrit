import { GFX } from './escapeCodes';
import type { Rect, Size } from './graphics';
import { options } from '../args';
import { perfEnabled, perfEnd, perfPending, perfTime, perfValue } from '../perf';
import type { ShmGraphicBuffer } from 'awrit-native-rs';
import { placeCursor } from './output';
import { isTmuxSession } from './tmux';
const { stdout } = process;

let imageId_ = 1;

type ImageId = number & {};
function imageId(): ImageId {
  return imageId_++;
}

// `q=2` suppresses the terminal's ack. Under perf we need it: the send→ack
// round trip is how we learn whether the terminal is keeping pace, which no
// producer-side timer can tell us. Read per call, not at import, so toggling
// perf at runtime (tests, and a late AWRIT_PERF) still takes effect.
function responses() {
  return options['debug-paint'] || perfEnabled();
}

function quiet() {
  return responses() ? '' : ',q=2';
}

/**
 * Frames sent but not yet acknowledged. A counter, not a per-id map: the
 * display path reuses one image id for the whole session, so a map holds a
 * single entry and drifts upward by (sends - acks) regardless of the terminal.
 * Only meaningful when the terminal is replying, i.e. under perf/debug-paint.
 */
let inFlight = 0;

/** FIFO of send timestamps; the terminal acks in order, so shift() pairs them. */
const sentAt: number[] = [];

function trackSent(_id: ImageId) {
  const t = perfTime();
  if (t == null) return;
  sentAt.push(t);
  inFlight += 1;
  perfPending('gfx.inflight', 1);
}

/** Resolve a send→display round trip, pairing with the oldest unacked send. */
export function gfxAck() {
  const t0 = sentAt.shift();
  if (t0 == null) return;
  if (inFlight > 0) inFlight -= 1;
  perfEnd('gfx.roundtrip', t0);
  perfPending('gfx.inflight', -1);
  perfValue('gfx.inflight', inFlight);
}

/** Frames sent, awaiting the terminal's acknowledgement. */
export function gfxInFlight(): number {
  return inFlight;
}

function sv_size_(size: Size) {
  return `,s=${size.width},v=${size.height}`;
}

function rect_(rect: Rect) {
  return `,x=${rect.x},y=${rect.y},w=${rect.width},h=${rect.height}`;
}

/**
 * Cells a placement fills. c/r are the number of columns/rows the terminal
 * scales the image to fit, so this is what stretches a small raster back over
 * the pane; without it a rasterScale 2 bitmap lands in the top-left quarter.
 */
export interface CellSpan {
  cols: number;
  rows: number;
}

function span_(span: CellSpan) {
  return `,c=${span.cols},r=${span.rows}`;
}

function shmRgba_(nameBase64: string, size: Size, control: string) {
  // f=32 rgba 32-bit
  // t=s SHM name
  stdout.write(GFX`f=32,t=s${sv_size_(size)},${control};${nameBase64}`);
}

function paintBitmap(name: string, size: Size, control?: string) {
  // a=T transfer & display
  // C=1 don't move cursor
  shmRgba_(name, size, `a=T${quiet()},C=1${control == null ? '' : ',' + control}`);
  // The ack is keyed by the image id in `control`; frame uploads (a=f) are
  // tracked separately since they carry r= rather than i=.
  if (responses()) {
    const id = control?.match(/(?:^|,)i=(\d+)/)?.[1];
    if (id) trackSent(Number(id) as ImageId);
  }
}

export interface AnimationFrame {
  readonly size: Size;
  composite: (destinationRect: Rect) => void;
  delete: () => void;
}

export interface InitialFrame {
  readonly size: Size;
  paintedContent: number;
  buffer: WeakRef<ShmGraphicBuffer>;
  loadFrame: (frame: number, buffer: ShmGraphicBuffer, size: Size) => AnimationFrame;
  free: () => void;
}

export function paintInitialFrame(
  buffer: ShmGraphicBuffer,
  size: Size,
  span: CellSpan,
): InitialFrame {
  const id = imageId();
  // paint and transfer first frame
  paintBitmap(buffer.nameBase64, size, `i=${id}${span_(span)}`);
  // pause at the first frame
  stdout.write(GFX`a=a,i=${id},c=1`);

  return {
    size,
    paintedContent: 0,
    buffer: new WeakRef(buffer),
    loadFrame: (frame: number, buffer: ShmGraphicBuffer, size: Size) =>
      loadFrame(id, frame, buffer.nameBase64, size),
    free: () => freeImage(id),
  };
}

function loadFrame(id: ImageId, frame: number, nameBase64: string, size: Size): AnimationFrame {
  // a=f animation frame
  shmRgba_(nameBase64, size, `a=f${quiet()},i=${id},r=${frame},X=1`);

  return {
    size,
    composite: (destinationRect: Rect) => compositeFrame(id, frame, 1, destinationRect),
    delete: () => deleteFrame(id, frame),
  };
}

function deleteFrame(id: ImageId, frame: number) {
  // a=d,d=F delete animation frame, freeing data
  stdout.write(GFX`a=d,d=f,i=${id},r=${frame}`);
}

function compositeFrame(
  id: ImageId,
  sourceFrame: number,
  destinationFrame: number,
  destinationRect: Rect = { x: 0, y: 0, width: 0, height: 0 },
) {
  // a=c composite animation frame
  // C=1 replace pixels (src copy)
  stdout.write(
    GFX`a=c${quiet()},C=1,i=${id},r=${sourceFrame},c=${destinationFrame}${rect_(destinationRect)}`,
  );
}

export function clearPlacements() {
  // Tmux renderers delete only the image IDs owned by this process. A global
  // delete would also erase graphics belonging to other panes and programs.
  if (isTmuxSession()) return;
  const command = GFX`a=d,d=A`;
  stdout.write(command);
}

function freeImage(id: ImageId) {
  // a=d,d=I delete image
  stdout.write(GFX`a=d,d=I,i=${id}`);
}

// Ghostty and probably most other terminals only support a very small
// subset of the graphics protocol, so this just supports an initial paint,
// and then replacing under the same buffer before releasing
export interface PaintedImage {
  readonly id: ImageId;
  readonly size: Size;
  buffer: ShmGraphicBuffer;
  free: () => void;
  /** Re-emit the copy command for pixels already present in `buffer`. */
  present: () => void;
  replace: (buffer: Buffer) => void;
}

export function paintImage(
  buffer: ShmGraphicBuffer,
  size: Size,
  position: { x: { cell: number; px: number }; y: { cell: number; px: number } },
  span: CellSpan,
): PaintedImage {
  const id = imageId();
  placeCursor({ x: position.x.cell, y: position.y.cell });
  const control = `i=${id},X=${position.x.px},Y=${position.y.px}${span_(span)}`;
  paintBitmap(buffer.nameBase64, size, control);

  // Re-emit the copy command for an already-filled buffer. The GPU texture path
  // (06-06) writes the pixels straight into the shm, so it has nothing to hand
  // `replace` and needs just this half.
  const present = () => {
    const tOut = perfTime();
    placeCursor({ x: position.x.cell, y: position.y.cell });
    paintBitmap(buffer.nameBase64, size, control);
    perfEnd('paint.replace.stdout', tOut);
  };

  return {
    id,
    size,
    buffer,
    free: () => freeImage(id),
    present,
    replace: (buffer_) => {
      // Split so the next perf run says whether paint.replace is our native
      // write (bench: ~5ms/2.5MB) or the synchronous TTY escape writes.
      const tWrite = perfTime();
      buffer.write(buffer_, size.width);
      perfEnd('paint.replace.write', tWrite);
      present();
    },
  };
}
