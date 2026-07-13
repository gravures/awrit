import { afterEach, describe, expect, test } from 'bun:test';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TmuxPaneStatus } from './tmux';
import { TmuxRenderer } from './tmuxRenderer';

describe('TmuxRenderer', () => {
  const openedFds: number[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    while (openedFds.length > 0) {
      const fd = openedFds.pop();
      if (fd != null) closeSync(fd);
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test('releaseSlot removes pending and displayed state for the slot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awrit-tmux-renderer-'));
    tempDirs.push(dir);
    const outputPath = join(dir, 'out.txt');
    const fd = openSync(outputPath, 'w');
    openedFds.push(fd);

    const renderer = new TmuxRenderer() as any;
    renderer.outputFd = fd;
    renderer.pendingBySlot.set(7, { slotId: 7 });
    renderer.displayedImageBySlot.set(7, 99);

    renderer.releaseSlot(7);

    expect(renderer.pendingBySlot.has(7)).toBe(false);
    expect(renderer.displayedImageBySlot.has(7)).toBe(false);

    closeSync(fd);
    openedFds.pop();

    const output = readFileSync(outputPath, 'utf8');
    expect(output.includes('a=d,d=I,i=99')).toBe(true);
  });

  test('close deletes each owned image once without using a global delete', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awrit-tmux-renderer-'));
    tempDirs.push(dir);
    const outputPath = join(dir, 'out.txt');
    const fd = openSync(outputPath, 'w');
    openedFds.push(fd);

    const renderer = new TmuxRenderer() as any;
    renderer.outputFd = fd;
    renderer.pendingBySlot.set(7, { slotId: 7 });
    renderer.displayedImageBySlot.set(7, 99);
    renderer.displayedImageBySlot.set(8, 100);
    renderer.displayedImageBySlot.set(9, 99);

    renderer.close();

    expect(renderer.pendingBySlot.size).toBe(0);
    expect(renderer.displayedImageBySlot.size).toBe(0);

    closeSync(fd);
    openedFds.pop();

    const output = readFileSync(outputPath, 'utf8');
    expect(output.match(/a=d,d=I,i=99/g)?.length).toBe(1);
    expect(output.match(/a=d,d=I,i=100/g)?.length).toBe(1);
    expect(output.includes('d=A')).toBe(false);
  });

  test('retains a hidden repaint and flushes it when the pane becomes visible', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awrit-tmux-renderer-'));
    tempDirs.push(dir);
    const outputPath = join(dir, 'out.txt');
    const fd = openSync(outputPath, 'w');
    openedFds.push(fd);
    let status: TmuxPaneStatus = 'invisible';

    const renderer = new TmuxRenderer(() => status) as any;
    renderer.outputFd = fd;

    await renderer.renderPng(Buffer.from([1]), 77, 1, 1, 0, 0, { cols: 10, rows: 10 }, 7);

    expect(readFileSync(outputPath, 'utf8')).toBe('');
    expect(renderer.pendingBySlot.get(7)?.imageId).toBe(77);

    status = 'active';
    await renderer.checkVisibilityAndFlush();

    const output = readFileSync(outputPath, 'utf8');
    expect(output.includes('a=T,i=77')).toBe(true);
    expect(renderer.pendingBySlot.size).toBe(0);

    renderer.close();
  });

  test('replays the latest owned image after a visible-to-hidden race', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awrit-tmux-renderer-'));
    tempDirs.push(dir);
    const outputPath = join(dir, 'out.txt');
    const fd = openSync(outputPath, 'w');
    openedFds.push(fd);
    let status: TmuxPaneStatus = 'active';

    const renderer = new TmuxRenderer(() => status) as any;
    renderer.outputFd = fd;
    await renderer.renderPng(Buffer.from([1]), 77, 1, 1, 0, 0, { cols: 10, rows: 10 }, 7);

    status = 'invisible';
    await renderer.checkVisibilityAndFlush();
    status = 'active';
    await renderer.checkVisibilityAndFlush();

    const output = readFileSync(outputPath, 'utf8');
    expect(output.match(/a=T,i=77/g)?.length).toBe(2);

    renderer.close();
  });

  test('confirms a retained repaint even when visibility changes between polls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awrit-tmux-renderer-'));
    tempDirs.push(dir);
    const outputPath = join(dir, 'out.txt');
    const fd = openSync(outputPath, 'w');
    openedFds.push(fd);

    const renderer = new TmuxRenderer(() => 'active') as any;
    renderer.outputFd = fd;
    await renderer.renderPng(Buffer.from([1]), 77, 1, 1, 0, 0, { cols: 10, rows: 10 }, 7);

    // The pane may have become hidden and visible again before this poll. A
    // retained replay makes that active -> active race lossless.
    await renderer.checkVisibilityAndFlush();

    const output = readFileSync(outputPath, 'utf8');
    expect(output.match(/a=T,i=77/g)?.length).toBe(2);
    renderer.close();
  });

  test('does not strand a repaint when the initial pane status query fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awrit-tmux-renderer-'));
    tempDirs.push(dir);
    const outputPath = join(dir, 'out.txt');
    const fd = openSync(outputPath, 'w');
    openedFds.push(fd);
    let calls = 0;

    const renderer = new TmuxRenderer(() => {
      calls += 1;
      if (calls === 1) throw new Error('temporary tmux failure');
      return 'active';
    }) as any;
    renderer.outputFd = fd;

    await renderer.renderPng(Buffer.from([1]), 77, 1, 1, 0, 0, { cols: 10, rows: 10 }, 7);
    await renderer.checkVisibilityAndFlush();

    const output = readFileSync(outputPath, 'utf8');
    expect(output.match(/a=T,i=77/g)?.length).toBe(2);
    renderer.close();
  });

  test('retains and retries a repaint after an output failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awrit-tmux-renderer-'));
    tempDirs.push(dir);
    const outputPath = join(dir, 'out.txt');
    const fd = openSync(outputPath, 'w');
    openedFds.push(fd);

    const renderer = new TmuxRenderer(() => 'active') as any;
    renderer.outputFd = -1;

    await expect(
      renderer.renderPng(Buffer.from([1]), 77, 1, 1, 0, 0, { cols: 10, rows: 10 }, 7),
    ).rejects.toThrow();
    expect(renderer.pendingBySlot.get(7)?.imageId).toBe(77);
    expect(renderer.displayedImageBySlot.has(7)).toBe(false);

    renderer.outputFd = fd;
    await renderer.checkVisibilityAndFlush();

    expect(readFileSync(outputPath, 'utf8').includes('a=T,i=77')).toBe(true);
    expect(renderer.displayedImageBySlot.get(7)).toBe(77);
    renderer.close();
  });

  test('preserves and deletes the previous image after a replacement write failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awrit-tmux-renderer-'));
    tempDirs.push(dir);
    const outputPath = join(dir, 'out.txt');
    const fd = openSync(outputPath, 'w');
    openedFds.push(fd);

    const renderer = new TmuxRenderer(() => 'active') as any;
    renderer.outputFd = fd;
    await renderer.renderPng(Buffer.from([1]), 50, 1, 1, 0, 0, { cols: 10, rows: 10 }, 7);

    renderer.outputFd = -1;
    await expect(
      renderer.renderPng(Buffer.from([2]), 77, 1, 1, 0, 0, { cols: 10, rows: 10 }, 7),
    ).rejects.toThrow();
    expect(renderer.displayedImageBySlot.get(7)).toBe(50);
    expect(renderer.pendingBySlot.get(7)?.imageId).toBe(77);

    renderer.outputFd = fd;
    await renderer.checkVisibilityAndFlush();

    const output = readFileSync(outputPath, 'utf8');
    expect(output.includes('a=d,d=I,i=50')).toBe(true);
    expect(renderer.displayedImageBySlot.get(7)).toBe(77);
    renderer.close();
  });
});
