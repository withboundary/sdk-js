import type { BoundaryLogEvent } from "../types.js";
import type { Transport } from "./types.js";

// Wraps a user-supplied `write(events)` function as a Transport so the
// batcher doesn't need to know about custom sinks vs. HTTP — both flow
// through the same pipeline. Errors bubble up to the caller's onError.
export class CustomTransport implements Transport {
  constructor(
    private readonly write: (events: BoundaryLogEvent[]) => void | Promise<void>,
  ) {}

  async send(events: BoundaryLogEvent[]): Promise<void> {
    await this.write(events);
  }
}

// A composed transport that fans out to multiple sinks concurrently. Used
// when both `apiKey` and `write` are configured — we fire them in parallel
// and surface the first failure (but still await both, so no silent drops).
export class MultiTransport implements Transport {
  constructor(private readonly children: Transport[]) {}

  async send(events: BoundaryLogEvent[]): Promise<void> {
    const results = await Promise.allSettled(
      this.children.map((t) => t.send(events)),
    );
    const rejected = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (rejected) throw rejected.reason;
  }
}
