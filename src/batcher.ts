import { EventQueue } from "./queue.js";
import type { BoundaryLogEvent } from "./types.js";
import type { Transport } from "./transport/types.js";
import { AuthError } from "./transport/types.js";

export interface BatcherOptions {
  size: number;
  intervalMs: number;
  maxQueueSize: number;
  onError: (err: unknown) => void;
}

// Coordinates the queue, timer, and transport. Three ways to flush:
//
//  1. Size trigger — queue hits `size` events → flush fires automatically.
//  2. Time trigger — every `intervalMs` the timer calls flush.
//  3. Explicit — caller invokes `logger.flush()`.
//
// Concurrent flushes coalesce into one network round-trip: while a flush is
// in flight, any further flush() call waits on the same promise instead of
// racing a second request. This matches how Sentry/Datadog clients avoid
// hammering the backend under load.
export class Batcher {
  private readonly queue: EventQueue;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private disabled = false;

  constructor(
    private readonly transport: Transport,
    private readonly opts: BatcherOptions,
  ) {
    this.queue = new EventQueue(opts.maxQueueSize);
    if (opts.intervalMs > 0) {
      this.timer = setInterval(() => {
        void this.flush().catch(() => undefined);
      }, opts.intervalMs);
      // On Node, don't keep the process alive just for this timer — it
      // lets short-lived scripts exit cleanly. Other runtimes either
      // ignore .unref or don't need it.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  enqueue(event: BoundaryLogEvent): void {
    if (this.disabled) return;
    this.queue.push(event);
    if (this.queue.length >= this.opts.size) {
      void this.flush().catch(() => undefined);
    }
  }

  // Drain the queue. If `timeoutMs` is provided, returns as soon as the
  // deadline is hit, even if the queue isn't empty — critical in serverless
  // (`await logger.flush(2000)` before returning) so one slow backend call
  // can't hold the runtime past its budget. No timeoutMs = unbounded wait.
  flush(timeoutMs?: number): Promise<void> {
    if (this.disabled) return Promise.resolve();
    if (this.flushing) return maybeBound(this.flushing, timeoutMs);

    this.flushing = this.drainQueue().finally(() => {
      this.flushing = null;
    });
    return maybeBound(this.flushing, timeoutMs);
  }

  private async drainQueue(): Promise<void> {
    // Keep draining until the queue is empty. Each iteration takes a
    // `size`-chunk so a big backlog doesn't sit on one oversized HTTP call.
    while (this.queue.length > 0 && !this.disabled) {
      const batch = this.queue.drain(this.opts.size);
      if (batch.length === 0) break;
      try {
        await this.transport.send(batch);
      } catch (err) {
        if (err instanceof AuthError) {
          // Bad API key — don't retry, don't keep the queue around.
          this.disabled = true;
          this.queue.clear();
          this.opts.onError(err);
          return;
        }
        this.opts.onError(err);
        // Intentionally do not re-enqueue: the HttpTransport already
        // handled retry internally. Re-queueing risks duplicate delivery
        // when the backend did accept the batch but the response was lost.
      }
    }

    const dropped = this.queue.takeDropped();
    if (dropped > 0) {
      this.opts.onError(
        new Error(`@withboundary/sdk: dropped ${dropped} events — queue exceeded maxQueueSize`),
      );
    }
  }

  async shutdown(timeoutMs?: number): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush(timeoutMs);
    this.disabled = true;
  }

  get size(): number {
    return this.queue.length;
  }

  get isDisabled(): boolean {
    return this.disabled;
  }
}

// Race a promise against a timeout. Resolves when the inner promise resolves
// OR when the timer fires first. The inner promise keeps running in the
// background — we just stop waiting for it so the caller isn't blocked.
function maybeBound(p: Promise<void>, timeoutMs: number | undefined): Promise<void> {
  if (timeoutMs === undefined || timeoutMs <= 0) return p;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    p.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
