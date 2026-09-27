import { describe, expect, test } from 'bun:test';
import { FrameCoalescer } from './frameCoalescer';

/** A drain that can be held open, standing in for a slow encode+write. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((r) => {
    release = r;
  });
  return { opened, release };
}

describe('FrameCoalescer', () => {
  test('a frame at rest is always encoded and delivered', async () => {
    const seen: number[] = [];
    const c = new FrameCoalescer<number>((n) => {
      seen.push(n);
    });
    c.offer(1);
    await c.idle();
    expect(seen).toEqual([1]);
  });

  test('a frame offered while idle is delivered, not stranded', async () => {
    const seen: number[] = [];
    const c = new FrameCoalescer<number>((n) => {
      seen.push(n);
    });
    for (const n of [1, 2, 3]) {
      c.offer(n);
      await c.idle();
    }
    // Each frame got its own encode because each was awaited at rest.
    expect(seen).toEqual([1, 2, 3]);
    expect(c.droppedCount).toBe(0);
  });

  test('frames arriving during one in-flight drain collapse to the newest', async () => {
    const seen: number[] = [];
    const first = gate();
    let call = 0;
    const c = new FrameCoalescer<number>(async (n) => {
      seen.push(n);
      if (call++ === 0) await first.opened;
    });

    c.offer(1); // starts draining, blocks on the gate
    // Three more arrive while frame 1 is still in flight.
    c.offer(2);
    c.offer(3);
    c.offer(4);

    first.release();
    await c.idle();

    // 1 was already in flight so it completes; 2 and 3 are superseded by 4.
    expect(seen).toEqual([1, 4]);
    expect(c.droppedCount).toBe(2);
  });

  test('a burst collapses to one encode', async () => {
    let encodes = 0;
    const g = gate();
    const c = new FrameCoalescer<number>(async () => {
      encodes++;
      await g.opened;
    });
    for (let i = 0; i < 50; i++) c.offer(i);
    expect(encodes).toBe(1); // only the first started before the gate
    g.release();
    await c.idle();
    expect(encodes).toBe(2); // ...plus the newest survivor
    expect(c.droppedCount).toBe(48);
  });

  test('a throwing drain does not wedge the queue', async () => {
    const seen: number[] = [];
    const c = new FrameCoalescer<number>((n) => {
      if (n === 1) throw new Error('encode failed');
      seen.push(n);
    });
    c.offer(1);
    await c.idle();
    c.offer(2);
    await c.idle();
    // The next frame still goes through after a failure.
    expect(seen).toEqual([2]);
  });

  test('converges on the last frame offered during a long stall', async () => {
    const seen: number[] = [];
    const g = gate();
    let first = true;
    const c = new FrameCoalescer<number>(async (n) => {
      seen.push(n);
      if (first) {
        first = false;
        await g.opened;
      }
    });
    c.offer(0);
    for (let i = 1; i <= 20; i++) c.offer(i);
    g.release();
    await c.idle();
    // Whatever happened mid-stall, the final state is the newest frame.
    expect(seen[seen.length - 1]).toBe(20);
  });
});
