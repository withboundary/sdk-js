import type { BoundaryLogEvent } from "./types.js";

// Bounded FIFO queue for log events. When the cap is hit, drop the oldest
// items: fresh events are more useful to a live dashboard than a backlog of
// stale ones. The drop count is tracked so a caller can surface "hey, you're
// over capacity" via onError.
export class EventQueue {
  private buf: BoundaryLogEvent[] = [];
  private droppedCount = 0;

  constructor(private readonly maxSize: number) {}

  push(event: BoundaryLogEvent): void {
    if (this.buf.length >= this.maxSize) {
      this.buf.shift();
      this.droppedCount += 1;
    }
    this.buf.push(event);
  }

  // Drain up to `n` events off the front, leaving the rest for later flushes.
  drain(n: number): BoundaryLogEvent[] {
    if (n <= 0 || this.buf.length === 0) return [];
    return this.buf.splice(0, n);
  }

  get length(): number {
    return this.buf.length;
  }

  // Snapshot + reset the drop counter. Returned number is how many events
  // the queue has silently discarded since the last call.
  takeDropped(): number {
    const n = this.droppedCount;
    this.droppedCount = 0;
    return n;
  }

  clear(): void {
    this.buf.length = 0;
    this.droppedCount = 0;
  }
}
