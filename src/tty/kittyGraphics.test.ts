import { expect, test } from 'bun:test';
import type { ShmGraphicBuffer } from 'awrit-native-rs';
import { paintImage, paintInitialFrame } from './kittyGraphics';

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
