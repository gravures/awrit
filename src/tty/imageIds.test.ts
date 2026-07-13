import { describe, expect, test } from 'bun:test';
import { createImageIdAllocator } from './imageIds';

describe('createImageIdAllocator', () => {
  test('allocates an increasing sequence from an injected process seed', () => {
    const allocate = createImageIdAllocator(0x12345678);

    expect(allocate()).toBe(0x12345678);
    expect(allocate()).toBe(0x12345679);
  });

  test('keeps independently seeded process sequences separate', () => {
    const allocateFirst = createImageIdAllocator(0x10000000);
    const allocateSecond = createImageIdAllocator(0x90000000);

    const firstIds = new Set([allocateFirst(), allocateFirst(), allocateFirst()]);
    const secondIds = [allocateSecond(), allocateSecond(), allocateSecond()];

    expect(secondIds.every((id) => !firstIds.has(id))).toBe(true);
  });

  test('wraps at the unsigned 32-bit limit without returning zero', () => {
    const allocate = createImageIdAllocator(0xffffffff);

    expect(allocate()).toBe(0xffffffff);
    expect(allocate()).toBe(1);
  });
});
