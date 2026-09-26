import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setPerfEnabledForTest,
  flushBucket,
  perfCount,
  perfEnd,
  perfPending,
  perfTime,
  perfValue,
} from './perf';

describe('perf', () => {
  afterEach(() => {
    flushBucket(); // drain leftovers so nothing reaches the real log file
    __setPerfEnabledForTest(false);
  });

  test('disabled: every helper is a no-op', () => {
    __setPerfEnabledForTest(false);
    perfCount('in.key');
    perfPending('paint', 1);
    perfValue('frame', '3840x2160');
    const t0 = perfTime();
    expect(t0).toBeUndefined();
    perfEnd('paint.arrive→encode', t0);
    expect(flushBucket()).toBeUndefined();
  });

  test('enabled: counts, timer avg/max/n, gauge peak in one line', () => {
    __setPerfEnabledForTest(true);
    perfCount('in.scrollUp');
    perfCount('in.scrollUp');
    perfCount('in.key');

    const t0 = perfTime();
    perfEnd('paint.arrive→encode', t0);
    perfEnd('paint.arrive→encode', t0);

    perfPending('paint', 1);
    perfPending('paint', 2); // live = 3, peak = 3
    perfPending('paint', -1); // live = 2, peak stays 3

    perfValue('frame', '3840x2160');
    perfValue('scale', 2);

    const line = flushBucket();
    expect(line).toBeDefined();
    expect(line).toContain('in.scrollUp=2');
    expect(line).toContain('in.key=1');
    expect(line).toMatch(/paint\.arrive→encode=\d+\.\d+\/\d+\.\d+ms\(n=2\)/);
    expect(line).toContain('paint.max=3');
    expect(line).toContain('frame=3840x2160');
    expect(line).toContain('scale=2');

    // bucket was folded — a second flush reports nothing (values cleared too)
    expect(flushBucket()).toBeUndefined();
  });

  test('perfEnd with undefined t0 records nothing even when enabled', () => {
    __setPerfEnabledForTest(true);
    perfEnd('paint.encode→submit', undefined);
    expect(flushBucket()).toBeUndefined();
  });

  test('pending gauge never goes below zero', () => {
    __setPerfEnabledForTest(true);
    perfPending('submit', -5);
    const line = flushBucket();
    expect(line).toBeDefined();
    expect(line as string).toContain('submit.max=0');
  });
});
