import { expect, test } from 'bun:test';
import type { ShmGraphicBuffer } from '../native';
import { gfxAck, gfxInFlight, paintImage, paintInitialFrame } from './kittyGraphics';
import { flushBucket, __setPerfEnabledForTest } from '../perf';

function buffer(): ShmGraphicBuffer {
  return { nameBase64: 'AAAA', write: () => {}, writeEmpty: () => {} } as unknown as ShmGraphicBuffer;
}

function capture(fn: () => void) {
  const write = process.stdout.write;
  let out = '';
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

// At rasterScale 2 the pane is 1957x1134 but the bitmap is 978x546. Without c/r
// the terminal places it 1:1 and it lands in the top-left quarter of the pane.
test('a raster smaller than the pane is placed over the cells it fills', () => {
  const out = capture(() =>
    paintImage(
      buffer(),
      { width: 978, height: 546 },
      { x: { cell: 0, px: 0 }, y: { cell: 0, px: 0 } },
      { cols: 103, rows: 26 },
    ),
  );
  expect(out).toContain('a=T');
  expect(out).toContain('s=978,v=546');
  expect(out).toContain('c=103,r=26');
});

test('the animation container is placed over the pane too', () => {
  const out = capture(() => paintInitialFrame(buffer(), { width: 981, height: 570 }, { cols: 103, rows: 27 }));
  expect(out).toContain('a=T');
  expect(out).toContain('c=103,r=27');
});

// CUP is 1-based while every cell coordinate here is 0-based. A missing shift
// puts the image a whole row down and a column right.
test('the cursor is moved with 1-based CUP rows and columns', () => {
  const out = capture(() =>
    paintImage(
      buffer(),
      { width: 978, height: 546 },
      { x: { cell: 3, px: 0 }, y: { cell: 5, px: 0 } },
      { cols: 103, rows: 26 },
    ),
  );
  expect(out).toContain('[6;4H');
});

// The send→ack gauge is what distinguishes "we render slowly" from "the
// terminal is behind us". If unacked frames do not accumulate, the terminal is
// keeping pace and the lag lives in our own pipeline; if they do, no amount of
// producer tuning will drain the backlog.
//
// Regression guard: the display path reuses one image id forever, so an earlier
// per-id map could only ever hold one entry and its count drifted upward by
// (sends - acks) even when the terminal answered every frame on time.
test('unacked frames accumulate, then drain as the terminal acknowledges', () => {
  __setPerfEnabledForTest(true);
  try {
    const place = () =>
      capture(() =>
        paintImage(
          buffer(),
          { width: 978, height: 546 },
          { x: { cell: 0, px: 0 }, y: { cell: 0, px: 0 } },
          { cols: 103, rows: 26 },
        ),
      );
    const before = gfxInFlight();
    for (let i = 0; i < 5; i++) place();
    expect(gfxInFlight()).toBe(before + 5);

    // Five acks, five drains — the gauge must land back on its starting value.
    for (let i = 0; i < 5; i++) gfxAck();
    expect(gfxInFlight()).toBe(before);
    expect(flushBucket()).toContain('gfx.roundtrip');
  } finally {
    __setPerfEnabledForTest(false);
  }
});

// An ack with nothing outstanding must not invent a drain or a negative gauge.
test('an unmatched ack does not fabricate a drain', () => {
  __setPerfEnabledForTest(true);
  try {
    const before = gfxInFlight();
    gfxAck();
    gfxAck();
    expect(gfxInFlight()).toBe(before);
  } finally {
    __setPerfEnabledForTest(false);
  }
});
