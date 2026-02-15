import { afterEach, describe, expect, test } from 'bun:test';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
});
