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
  /** Set by a test to observe the pinned read. */
  static onTextureWrite: ((id: number) => void) | undefined;
  nameBase64 = 'AAAA';
  writes: Buffer[] = [];
  textureWrites: number[] = [];
  timings(): [number, number, number] {
    return [0, 0, 0];
  }
  constructor(public size: number) {
    FakeShmBuffer.instances.push(this);
  }
  write(bmp: Buffer, _width: number) {
    this.writes.push(Buffer.from(bmp));
  }
  writeTexture(id: number, _swap: boolean) {
    this.textureWrites.push(id);
    FakeShmBuffer.onTextureWrite?.(id);
  }
}

// The real pin/unpin would touch a dmabuf; here they just hand out ids and
// record the order, so the test can assert the texture was released *before*
// the slow read consumed the pin.
const pins = { next: 1, live: new Set<number>(), releasedBeforeWrite: [] as number[] };

mock.module('awrit-native-rs', () => ({
  ...native,
  isTmux: () => false,
  getWindowSize: () => ({ cols: 100, rows: 30, width: 800, height: 600 }),
  ShmGraphicBuffer: FakeShmBuffer,
  pinTexture: (fd: number, _w: number, _h: number, _s: number, _o: number, _sz: number) => {
    if (fd !== 3) throw new Error('bad fd');
    const id = pins.next++;
    pins.live.add(id);
    return id;
  },
  unpinTexture: (id: number) => {
    pins.live.delete(id);
  },
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
    fire: (image: unknown, event?: unknown) => handler?.(event ?? {}, dirty, image),
    /** The listener itself, for racing destroy() against an in-flight event. */
    listener: () => handler,
  };
}

function fakeImage(throwOnBitmap = false, empty = false) {
  const bitmap = Buffer.alloc(200 * 100 * 4, 7);
  let calls = 0;
  const image = {
    getSize: () => ({ width: 200, height: 100 }),
    isEmpty: () => empty,
    toBitmap: () => {
      calls++;
      if (throwOnBitmap) throw new Error('boom');
      return bitmap;
    },
  };
  return {
    image,
    bitmap,
    get calls() {
      return calls;
    },
  };
}

/** A shared-texture paint event, as Electron delivers it in texture mode. */
function fakeTexture(onRelease: () => void, fd = 3) {
  return {
    texture: {
      textureInfo: {
        pixelFormat: 'bgra',
        codedSize: { width: 200, height: 100 },
        contentRect: { x: 0, y: 0, width: 200, height: 100 },
        modifier: 0,
        planes: [{ fd, stride: 800, offset: 0, size: 80_000 }],
      },
      release: onRelease,
    },
  };
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

  // 06-06: a shared-texture window always delivers an empty bitmap. Blitting it
  // would push garbage to the terminal, so such a paint must be dropped whole.
  test('an empty bitmap is dropped instead of rasterised', async () => {
    await muted(async () => {
      FakeShmBuffer.instances.length = 0;
      const { w, fire } = fakeWindow();
      const empty = fakeImage(false, true);
      const result = registerPaintedContentFallback(w, layoutNode);
      try {
        fire(empty.image);
        await flush();

        expect(empty.calls).toBe(0);
        expect(FakeShmBuffer.instances).toHaveLength(0);
        expect(result.buffer).toBeUndefined();
      } finally {
        result.destroy();
      }
    });
  });

  // Every texture must be handed back, including one whose blit threw: a
  // retained texture back-pressures the capturer for good.
  test('a failing shared-texture blit still releases the texture', async () => {
    await muted(async () => {
      FakeShmBuffer.instances.length = 0;
      pins.live.clear();
      const { w, fire } = fakeWindow();
      let released = 0;
      const errors: unknown[] = [];
      const savedError = console_.error;
      console_.error = ((...args: unknown[]) => {
        errors.push(args[0]);
      }) as typeof console_.error;
      const result = registerPaintedContentFallback(w, layoutNode);
      try {
        // pinTexture rejects a bad fd, so the blit never runs.
        const bad = fakeTexture(() => released++, 99);
        fire(undefined, bad);
        await flush();

        expect(released).toBe(1);
        expect(errors).toContain('fallback paint failed');
        expect(FakeShmBuffer.instances).toHaveLength(0);
      } finally {
        console_.error = savedError;
        result.destroy();
      }
    });
  });

  // The whole point of pinning: the capturer must get the texture back before
  // the 25ms read starts, not after it.
  test('a shared texture is released before the pinned read', async () => {
    await muted(async () => {
      FakeShmBuffer.instances.length = 0;
      pins.live.clear();
      const { w, fire } = fakeWindow();
      const order: string[] = [];
      const result = registerPaintedContentFallback(w, layoutNode);
      try {
        FakeShmBuffer.onTextureWrite = () => order.push('read');
        const tex = fakeTexture(() => order.push('release'), 3);
        fire(undefined, tex);
        await flush();
        FakeShmBuffer.onTextureWrite = undefined;

        expect(order).toEqual(['release', 'read']);
        // The pin was consumed by the read, not left mapped.
        expect(pins.live.size).toBe(0);
        expect(FakeShmBuffer.instances[0].textureWrites).toHaveLength(1);
      } finally {
        result.destroy();
      }
    });
  });

  // A panicking blit must not strand a dmabuf mapping: it pins GPU memory for
  // the life of the process.
  test('a throwing blit unpins its texture', async () => {
    await muted(async () => {
      FakeShmBuffer.instances.length = 0;
      pins.live.clear();
      const { w, fire } = fakeWindow();
      const savedError = console_.error;
      console_.error = (() => {}) as typeof console_.error;
      const result = registerPaintedContentFallback(w, layoutNode);
      const proto = FakeShmBuffer.prototype;
      const real = proto.writeTexture;
      proto.writeTexture = () => {
        throw new Error('boom');
      };
      try {
        const ok = fakeTexture(() => {}, 3);
        fire(undefined, ok);
        await flush();

        expect(pins.live.size).toBe(0);
      } finally {
        proto.writeTexture = real;
        console_.error = savedError;
        result.destroy();
      }
    });
  });
});
