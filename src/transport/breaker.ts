import type { BoundaryLogEvent } from "../types.js";
import { AuthError, type Transport } from "./types.js";

export interface BreakerOptions {
  // Trip after this many consecutive failures.
  threshold?: number;
  // How long to stay open (tripped) before letting one probe through.
  cooldownMs?: number;
}

// Minimal closed/open/half-open breaker. Kept intentionally small — the goal
// isn't a general-purpose resilience framework, it's a guard against retry
// storms when the backend is down:
//
//   CLOSED: all sends pass through. Each failure increments a counter; a
//           success resets it.
//   OPEN:   sends are short-circuited (no network, no retry). The breaker
//           flips to HALF_OPEN after cooldownMs elapses.
//   HALF_OPEN: the next send is a probe. Success → CLOSED. Failure → OPEN
//              again for another cooldown.
//
// Under OPEN, we drop the batch by throwing BreakerOpenError. The batcher
// routes that through onError so the app knows events are being dropped.
// AuthError bypasses the breaker entirely — bad credentials aren't a
// transient failure and should surface immediately.
export class CircuitBreakerTransport implements Transport {
  private state: "closed" | "open" | "half-open" = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly inner: Transport,
    opts: BreakerOptions = {},
  ) {
    this.threshold = opts.threshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
  }

  async send(events: BoundaryLogEvent[]): Promise<void> {
    if (this.state === "open") {
      if (Date.now() - this.openedAt < this.cooldownMs) {
        throw new BreakerOpenError();
      }
      this.state = "half-open";
    }

    try {
      await this.inner.send(events);
      this.onSuccess();
    } catch (err) {
      // Auth errors are terminal/credential — don't count them against the
      // breaker since retrying won't help regardless of breaker state.
      if (err instanceof AuthError) throw err;
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === "half-open" || this.consecutiveFailures >= this.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  // Visible for tests.
  get currentState(): "closed" | "open" | "half-open" {
    return this.state;
  }
}

export class BreakerOpenError extends Error {
  constructor() {
    super(
      "@withboundary/sdk: transport circuit breaker is open — dropping batch until cooldown expires",
    );
    this.name = "BreakerOpenError";
  }
}
