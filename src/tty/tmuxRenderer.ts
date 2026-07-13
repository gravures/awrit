import fs from 'node:fs';
import { options } from '../args';
import {
  buildTmuxDeleteImageCommand,
  buildTmuxPlaceholderLines,
  buildTmuxUploadCommands,
} from './tmuxProtocol';
import { getPaneStatus, type TmuxPaneStatus } from './tmux';

type PaneBounds = {
  cols: number;
  rows: number;
};

type RenderRequest = {
  slotId: number;
  pngBuffer: Buffer;
  imageId: number;
  cols: number;
  rows: number;
  startCol: number;
  startRow: number;
  pane: PaneBounds;
};

function writeAll(fd: number, data: string | Buffer) {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset);
    if (written <= 0) break;
    offset += written;
  }
}

export class TmuxRenderer {
  private outputFd: number;
  private dumpPlaceholdersPath: string | null;
  private dumpGfxPath: string | null;
  private pendingBySlot: Map<number, RenderRequest>;
  private latestBySlot: Map<number, RenderRequest>;
  private displayedImageBySlot: Map<number, number>;
  private flushInProgress: boolean;
  private flushPromise: Promise<void>;
  private paneStatus: () => TmuxPaneStatus;
  private currentPaneStatus: TmuxPaneStatus | null;
  private visibilityTimer: ReturnType<typeof setTimeout> | null;
  private closed: boolean;

  constructor(paneStatus: () => TmuxPaneStatus = getPaneStatus) {
    this.outputFd = process.stdout.fd;
    this.dumpPlaceholdersPath = options['tmux-dump']
      ? '/tmp/awrit-tmux-placeholders.log'
      : null;
    this.dumpGfxPath = options['tmux-dump'] ? '/tmp/awrit-tmux-gfx.log' : null;
    this.pendingBySlot = new Map();
    this.latestBySlot = new Map();
    this.displayedImageBySlot = new Map();
    this.flushInProgress = false;
    this.flushPromise = Promise.resolve();
    this.paneStatus = paneStatus;
    this.currentPaneStatus = null;
    this.visibilityTimer = null;
    this.closed = false;
  }

  close() {
    this.closed = true;
    if (this.visibilityTimer) clearTimeout(this.visibilityTimer);
    this.visibilityTimer = null;
    this.pendingBySlot.clear();
    this.latestBySlot.clear();
    const displayedImageIds = new Set(this.displayedImageBySlot.values());
    this.displayedImageBySlot.clear();
    for (const imageId of displayedImageIds) {
      this.deleteImage(imageId);
    }
  }

  releaseSlot(slotId: number) {
    this.pendingBySlot.delete(slotId);
    this.latestBySlot.delete(slotId);
    const displayedImageId = this.displayedImageBySlot.get(slotId);
    if (displayedImageId == null) return;
    this.displayedImageBySlot.delete(slotId);

    this.deleteImage(displayedImageId);
  }

  private deleteImage(imageId: number) {
    const deleteCommand = buildTmuxDeleteImageCommand(imageId);
    writeAll(this.outputFd, deleteCommand);
    if (this.dumpGfxPath) fs.appendFileSync(this.dumpGfxPath, `${deleteCommand}\n`);
  }

  private scheduleFlush() {
    if (this.closed || this.pendingBySlot.size === 0) return Promise.resolve();
    if (this.currentPaneStatus === 'invisible') return Promise.resolve();
    if (this.flushInProgress) return this.flushPromise;
    this.flushInProgress = true;
    this.flushPromise = Promise.resolve()
      .then(() => this.flushPending())
      .finally(() => {
        this.flushInProgress = false;
      });
    return this.flushPromise;
  }

  private scheduleVisibilityCheck() {
    if (this.closed || this.visibilityTimer) return;
    this.visibilityTimer = setTimeout(() => this.checkVisibilityAndFlush(), 250);
    this.visibilityTimer.unref();
  }

  private async checkVisibilityAndFlush() {
    if (this.visibilityTimer) clearTimeout(this.visibilityTimer);
    this.visibilityTimer = null;
    if (this.closed) return;

    try {
      const previousStatus = this.currentPaneStatus;
      this.currentPaneStatus = this.paneStatus();
      if (previousStatus === 'invisible' && this.currentPaneStatus !== 'invisible') {
        for (const [slotId, request] of this.latestBySlot) {
          this.pendingBySlot.set(slotId, request);
        }
        await this.scheduleFlush();
      }
    } catch {
      // Force the next successful visible poll to replay the retained images.
      this.currentPaneStatus = 'invisible';
    } finally {
      // Visible panes need only a one-shot check after each repaint. Hidden
      // panes keep polling so their retained frame is replayed on return.
      if (this.currentPaneStatus === 'invisible') this.scheduleVisibilityCheck();
    }
  }

  private flushPending() {
    const SYNC_BEGIN = '\x1b[?2026h';
    const SYNC_END = '\x1b[?2026l';

    while (this.pendingBySlot.size > 0) {
      const batch = [...this.pendingBySlot.values()];
      this.pendingBySlot.clear();

      let output = SYNC_BEGIN;
      for (const request of batch) {
        const uploadCommands = buildTmuxUploadCommands(
          request.pngBuffer,
          request.imageId,
          request.cols,
          request.rows,
        );
        const placeholderLines = buildTmuxPlaceholderLines(
          request.imageId,
          request.startCol,
          request.startRow,
          request.cols,
          request.rows,
          request.pane,
        );

        for (const wrapped of uploadCommands) {
          output += wrapped;
          if (this.dumpGfxPath) {
            fs.appendFileSync(this.dumpGfxPath, `${wrapped}\n`);
          }
        }

        for (const line of placeholderLines) {
          output += line;
          if (this.dumpPlaceholdersPath) {
            fs.appendFileSync(this.dumpPlaceholdersPath, `${line}\n`);
          }
        }

        const previousImageId = this.displayedImageBySlot.get(request.slotId);
        if (previousImageId != null && previousImageId !== request.imageId) {
          const deleteCommand = buildTmuxDeleteImageCommand(previousImageId);
          output += deleteCommand;
          if (this.dumpGfxPath) {
            fs.appendFileSync(this.dumpGfxPath, `${deleteCommand}\n`);
          }
        }
        this.displayedImageBySlot.set(request.slotId, request.imageId);
      }
      output += SYNC_END;
      writeAll(this.outputFd, output);
    }
  }

  renderPng(
    pngBuffer: Buffer,
    imageId: number,
    cols: number,
    rows: number,
    startCol: number,
    startRow: number,
    pane: PaneBounds,
    slotId: number,
  ) {
    if (this.closed) return Promise.resolve();
    const request = {
      slotId,
      pngBuffer,
      imageId,
      cols,
      rows,
      startCol,
      startRow,
      pane,
    };
    this.latestBySlot.set(slotId, request);
    this.pendingBySlot.set(slotId, request);
    if (this.currentPaneStatus == null) this.currentPaneStatus = this.paneStatus();
    this.scheduleVisibilityCheck();
    return this.scheduleFlush();
  }
}
