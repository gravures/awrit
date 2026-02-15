import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';

type PaneBounds = {
  cols: number;
  rows: number;
};

function writeAll(fd: number, data: string | Buffer) {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset);
    if (written <= 0) break;
    offset += written;
  }
}

function visibleCellCount(total: number, start: number, pane: number) {
  return Math.max(0, Math.min(total, pane - start));
}

export class TimgRenderer {
  private outputFd: number;
  private writeQueue: Promise<void>;

  constructor() {
    this.outputFd = process.stdout.fd;
    this.writeQueue = Promise.resolve();
  }

  close() {
    // No persistent resources. Kept for lifecycle symmetry.
  }

  releaseSlot(_slotId: number) {
    // No tracked slot state for the timg backend.
  }

  private enqueueWrite(writeFn: () => Promise<void>) {
    this.writeQueue = this.writeQueue.then(
      () => writeFn(),
      () => writeFn(),
    );
    return this.writeQueue;
  }

  private renderWithTimg(
    pngBuffer: Buffer,
    startCol: number,
    startRow: number,
    cols: number,
    rows: number,
  ) {
    return new Promise<void>((resolve, reject) => {
      // Position first, then let timg emit kitty-in-tmux placeholders at the cursor.
      writeAll(this.outputFd, `\x1b[${startRow + 1};${startCol + 1}H`);

      const args = ['-pk', '--frames=1', '--loops=1', '-g', `${cols}x${rows}`, '-'];
      const child = spawn('timg', args, {
        stdio: ['pipe', 'inherit', 'pipe'],
      });

      let stderr = '';
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString('utf8');
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`timg exited with code ${code}: ${stderr.trim()}`));
      });

      child.stdin?.end(pngBuffer);
    });
  }

  renderPng(
    pngBuffer: Buffer,
    _imageId: number,
    cols: number,
    rows: number,
    startCol: number,
    startRow: number,
    pane: PaneBounds,
    _slotId: number,
  ) {
    const visibleCols = visibleCellCount(cols, startCol, pane.cols);
    const visibleRows = visibleCellCount(rows, startRow, pane.rows);
    if (visibleCols === 0 || visibleRows === 0) return Promise.resolve();

    return this.enqueueWrite(() =>
      this.renderWithTimg(pngBuffer, startCol, startRow, visibleCols, visibleRows),
    );
  }
}
