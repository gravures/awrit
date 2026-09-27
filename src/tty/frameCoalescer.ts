/**
 * One-slot frame buffer that keeps only the newest frame.
 *
 * The tmux paint path used to encode inside the paint event, so every event paid
 * a full encode even when the renderer was still busy delivering the previous
 * one and would throw it away. The write to tmux is the bound, but the encode is
 * the expensive step, so the coalesce decision has to sit in front of the encode.
 *
 * The correctness floor, which is the whole point of this class:
 * - a frame is dropped ONLY when a newer frame replaces it;
 * - at rest, every offered frame is drained, so the image always converges on
 *   the latest state and never freezes.
 *
 * `drain` is awaited, so a slow encode naturally coalesces everything that
 * arrives behind it without any extra bookkeeping.
 */
export class FrameCoalescer<T> {
  private pending: T | undefined;
  private draining = false;
  private dropped = 0;

  constructor(private readonly drain: (frame: T) => Promise<void> | void) {}

  /**
   * Queue a frame, superseding any not-yet-drained one.
   * Returns how many frames that displaced (0 or 1), for instrumentation.
   */
  offer(frame: T): number {
    let dropped = 0;
    if (this.pending !== undefined) {
      dropped = 1;
      this.dropped++;
    }
    this.pending = frame;
    void this.pump();
    return dropped;
  }

  /** Frames superseded before they were drained. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Resolves once the queue is empty and no drain is in flight. */
  async idle(): Promise<void> {
    // `pump` is a no-op once nothing is pending, so awaiting it settles the
    // in-flight drain that is already running.
    await this.pump();
  }

  private async pump(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending !== undefined) {
        const next = this.pending;
        this.pending = undefined;
        try {
          await this.drain(next);
        } catch {
          // `offer` fires and forgets, so a throwing drain would surface as an
          // unhandled rejection and stall the loop below. One bad frame must not
          // freeze rendering; the drain owns its own error reporting.
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
