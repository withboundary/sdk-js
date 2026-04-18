import type { BoundaryLogEvent } from "../types.js";

// Lowest-level transport contract. The batcher calls `send(batch)` and the
// transport is responsible for moving the batch to its destination. It may
// retry internally; it must throw if delivery ultimately failed so the
// caller can route to `onError`.
export interface Transport {
  send(events: BoundaryLogEvent[]): Promise<void>;
}

// Thrown by HttpTransport when the backend replies 401. The batcher treats
// this as terminal — no amount of retry will fix a bad API key, and retrying
// just spams the endpoint. The logger disables itself after catching this
// once and logs a single warning.
export class AuthError extends Error {
  readonly status = 401;
  constructor(message = "Unauthorized — API key was rejected") {
    super(message);
    this.name = "AuthError";
  }
}
