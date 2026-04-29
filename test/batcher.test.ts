import { describe, expect, it, vi } from "vitest";
import { Batcher } from "../src/batcher.js";
import type { Transport } from "../src/transport/types.js";
import type { BoundaryLogEvent } from "../src/types.js";

function ev(n: number): BoundaryLogEvent {
  return {
    contractName: "t",
    timestamp: new Date(n).toISOString(),
    runId: `bnd_run_${n.toString().padStart(21, "0")}`,
    final: true,
    attempt: 1,
    maxAttempts: 3,
    ok: true,
    durationMs: n,
  };
}

class RecordingTransport implements Transport {
  batches: BoundaryLogEvent[][] = [];
  delayMs = 0;
  async send(events: BoundaryLogEvent[]): Promise<void> {
    this.batches.push(events);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
  }
}

describe("Batcher", () => {
  it("flushes automatically when queue hits size trigger", async () => {
    const t = new RecordingTransport();
    const onError = vi.fn();
    const b = new Batcher(t, { size: 3, intervalMs: 0, maxQueueSize: 100, onError });
    b.enqueue(ev(1));
    b.enqueue(ev(2));
    b.enqueue(ev(3));
    await b.flush();
    expect(t.batches.length).toBe(1);
    expect(t.batches[0]!.length).toBe(3);
    await b.shutdown();
  });

  it("coalesces concurrent flushes", async () => {
    const t = new RecordingTransport();
    t.delayMs = 30; // simulate slow network
    const onError = vi.fn();
    const b = new Batcher(t, { size: 50, intervalMs: 0, maxQueueSize: 100, onError });
    b.enqueue(ev(1));
    b.enqueue(ev(2));
    // Kick off three flushes simultaneously; they should all resolve off the
    // same underlying round-trip.
    await Promise.all([b.flush(), b.flush(), b.flush()]);
    expect(t.batches.length).toBe(1);
    await b.shutdown();
  });

  it("respects flush(timeoutMs) and returns even if transport is slow", async () => {
    const t = new RecordingTransport();
    t.delayMs = 1000; // longer than our timeout
    const onError = vi.fn();
    const b = new Batcher(t, { size: 1, intervalMs: 0, maxQueueSize: 100, onError });
    b.enqueue(ev(1));
    const started = Date.now();
    await b.flush(50);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(400); // never waited for the 1s transport
    await b.shutdown();
  });

  it("routes transport errors through onError and drops the batch", async () => {
    const onError = vi.fn();
    const t: Transport = {
      async send() {
        throw new Error("boom");
      },
    };
    const b = new Batcher(t, { size: 1, intervalMs: 0, maxQueueSize: 100, onError });
    b.enqueue(ev(1));
    await b.flush();
    expect(onError).toHaveBeenCalled();
    await b.shutdown();
  });

  it("surfaces dropped-event counts via onError when queue overflows", async () => {
    const t = new RecordingTransport();
    const onError = vi.fn();
    const b = new Batcher(t, { size: 100, intervalMs: 0, maxQueueSize: 3, onError });
    // Push 5 — first two get dropped. Size trigger never fires because the
    // queue cap is below size; we must flush manually.
    b.enqueue(ev(1));
    b.enqueue(ev(2));
    b.enqueue(ev(3));
    b.enqueue(ev(4));
    b.enqueue(ev(5));
    await b.flush();
    const dropWarning = onError.mock.calls.find(
      (c) => c[0] instanceof Error && /dropped 2 events/.test((c[0] as Error).message),
    );
    expect(dropWarning).toBeTruthy();
    await b.shutdown();
  });
});
