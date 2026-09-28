import { describe, expect, mock, test } from 'bun:test';
import { console_ } from './console';

// paint.ts pulls electron (`screen`) and the native module. Fake both so the
// fallback paint path can be driven without a window, a tty, or shm segments.
// Load the REAL native module first: bun's module mocks persist across test
// files, so tmuxProtocol.test (which wraps with the real passthrough) may run
// against this mock — spreading real exports keeps it correct.
const native = await import('awrit-native-rs');

class FakeShmBuffer {
  static instances: FakeShmBuffer[] = [];
  nameBase64 = 'AAAA';
  writes: Buffer[] = [];
  constructor(public size: number) {
    FakeShmBuffer.instances.push(this);
  }
  write(bmp: Buffer, _width: number) {
    this.writes.push(Buffer.from(bmp));
  }
}

mock.module('awrit-native-rs', () => ({
  ...native,
  isTmux: () => false,
  getWindowSize: () => ({ cols: 100, rows: 30, width: 800, height: 600 }),
  ShmGraphicBuffer: FakeShmBuffer,
}));
mock.module('electron', () => ({
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
}));

const { registerPaintedContentFallback } = await import('./paint');

const dirty = { x: 0, y: 0, width: 200, height: 100 };
const layoutNode = { deviceLayout: { x: 0, y: 0, width: 800, height: 600 } } as any;

/** Enough macrotask turns for yield → stale-check → work to settle. */
async function flush(turns = 3) {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** The fallback path writes escape codes via paintImage; keep them out of the reporter. */
async function muted(fn: () => Promise<void>) {
  const saved = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = saved;
  }
}

function fakeWindow() {
  let handler: ((...args: unknown[]) => void) | undefined;
  const w = {
    webContents: {
      on: (_ev: string, fn: (...args: unknown[]) => void) => {
        handler = fn;
      },
      off: (_ev: string) => {
        handler = undefined;
      },
    },
    getContentSize: () => [800, 600] as [number, number],
  };
  return {
    w: w as any,
    /** Fire a paint event the way Electron would. */
    fire: (image: unknown) => handler?.({}, dirty, image),
    /** The listener itself, for racing destroy() against an in-flight event. */
    listener: () => handler,
  };
}

function fakeImage(throwOnBitmap = false) {
  const bitmap = Buffer.alloc(200 * 100 * 4, 7);
  let calls = 0;
  const image = {
    getSize: () => ({ width: 200, height: 100 }),
    toBitmap: () => {
      calls++;
      if (throwOnBitmap) throw new Error('boom');
      return bitmap;
    },
  };
  return { image, bitmap, get calls() { return calls; } };
}

describe('fallback paint coalescing', () => {
  test('two paints during one in-flight drain: only the newest is rasterised', async () => {
    await muted(async () => {
      FakeShmBuffer.instances.length = 0;
      const { w, fire } = fakeWindow();
      const old = fakeImage();
      const fresh = fakeImage();
      const result = registerPaintedContentFallback(w, layoutNode);
      try {
        fire(old.image); // drain yields...
        fire(fresh.image); // ...and this one supersedes it during the yield
        await flush();

        expect(old.calls).toBe(0); // stale frame never paid toBitmap
        expect(fresh.calls).toBe(1); // newest did, exactly once
        expect(FakeShmBuffer.instances[0].writes).toHaveLength(1);
        expect(FakeShmBuffer.instances[0].writes[0].equals(fresh.bitmap)).toBe(true);
      } finally {
        result.destroy();
      }
    });
  });

  test('a single paint at rest is always processed', async () => {
    await muted(async () => {
      FakeShmBuffer.instances.length = 0;
      const { w, fire } = fakeWindow();
      const img = fakeImage();
      const result = registerPaintedContentFallback(w, layoutNode);
      try {
        fire(img.image);
        await flush();

        expect(img.calls).toBe(1);
        expect(FakeShmBuffer.instances[0].writes).toHaveLength(1);
      } finally {
        result.destroy();
      }
    });
  });

  test('a drain pending across destroy() does nothing harmful', async () => {
    await muted(async () => {
      FakeShmBuffer.instances.length = 0;
      const { w, fire, listener } = fakeWindow();
      const img = fakeImage();
      const result = registerPaintedContentFallback(w, layoutNode);
      fire(img.image); // drain now suspended on its yield
      const raced = listener();
      result.destroy();
      // An event that raced destroy reaches the listener before off() lands.
      raced?.({}, dirty, img.image);
      await flush();

      expect(img.calls).toBe(0);
      expect(FakeShmBuffer.instances).toHaveLength(0);
      expect(result.buffer).toBeUndefined();
    });
  });

  test('a throwing toBitmap does not wedge the queue or reject', async () => {
    await muted(async () => {
      FakeShmBuffer.instances.length = 0;
      const { w, fire } = fakeWindow();
      const bad = fakeImage(true);
      const good = fakeImage();
      const errors: unknown[] = [];
      const savedError = console_.error;
      console_.error = ((...args: unknown[]) => {
        errors.push(args[0]);
      }) as typeof console_.error;
      const result = registerPaintedContentFallback(w, layoutNode);
      try {
        fire(bad.image);
        await flush();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBe('fallback paint failed');

        // The queue keeps working after the failure (FrameCoalescer contract,
        // asserted here at the paint wiring level).
        fire(good.image);
        await flush();
        expect(good.calls).toBe(1);
        expect(FakeShmBuffer.instances[0].writes).toHaveLength(1);
      } finally {
        console_.error = savedError;
        result.destroy();
      }
    });
  });
});
