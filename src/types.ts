// Public types for @withboundary/sdk.

// The canonical environment labels the product recognises today. Typed as a
// union so common typos (`"prod"`, `"stage"`, `"stg"`) can't silently fragment
// the dashboard into mystery buckets. Widen this when custom environments
// become a real product feature — the wire format (BoundaryLogEvent below)
// stays `string` so the server can accept future names without an SDK bump.
export type BoundaryEnvironment = "production" | "staging" | "development";
//
// `BoundaryLogEvent` is re-exported from @withboundary/contract so the two
// packages share one definition; we import it as a type-only import and fall
// back to an identical local definition when the peer isn't installed.

export interface BoundaryLogEvent {
  // identity
  contractName: string;
  environment?: string;
  timestamp: string; // ISO 8601

  // run metadata (capture.metadata, default ON)
  attempt: number;
  maxAttempts: number;
  ok: boolean;
  durationMs: number;

  // failure details (capture.errors, default ON)
  category?: string;
  issues?: string[];

  // repair context (capture.repairs, default ON)
  repairs?: Array<{ role: string; content: string }>;

  // raw data (both default OFF — opt-in only)
  input?: unknown;
  output?: unknown;

  // Name of the LLM that produced the output, e.g. "gpt-4o", "claude-haiku".
  // Stamped from the logger default or a per-call override passed via
  // `contract.accept(run, { model })`.
  model?: string;

  // Number of rules defined on the contract at runtime. Latest-seen — the
  // backend can use the most recent event's value as the canonical count.
  rulesCount?: number;

  // SDK metadata — stamped by @withboundary/sdk so the backend can attribute
  // events to a specific SDK version and runtime when debugging issues.
  sdk?: {
    name: string;
    version: string;
    runtime?: string;
  };
}

// Which buckets of data the SDK is allowed to ship. Conservative defaults
// intentionally leave raw LLM inputs/outputs off — they're the most sensitive
// payloads and shouldn't leave the process without an explicit opt-in.
export interface CapturePolicy {
  inputs: boolean;
  outputs: boolean;
  repairs: boolean;
  errors: boolean;
  metadata: boolean;
}

export const DEFAULT_CAPTURE: CapturePolicy = {
  inputs: false,
  outputs: false,
  repairs: true,
  errors: true,
  metadata: true,
};

// Redaction runs right before events leave the process. All three layers are
// optional and compose: fields match by key, patterns match substrings in
// string values, custom runs last and sees every leaf.
export interface RedactionOptions {
  // Field names to scrub (case-sensitive, deep). Replaces value with "[REDACTED]".
  fields?: string[];
  // Regex patterns applied to string values anywhere in the event.
  patterns?: RegExp[];
  // Custom redactor — runs for every leaf after fields/patterns. Returns the
  // value to keep (can be the same value, a scrubbed version, or undefined
  // to drop the field entirely).
  custom?: (value: unknown, path: string[]) => unknown;
}

// Transport is the lowest-level abstraction — given a batch, ship it. The
// built-in HTTP transport wraps fetch; tests and advanced users can pass a
// custom sink via `write`.
export interface Transport {
  send(events: BoundaryLogEvent[]): Promise<void>;
}

export interface BoundaryLoggerOptions {
  // Connection — at least one of apiKey or write must be present, or the
  // logger returns null (a no-op for safe dev use).
  apiKey?: string;
  environment?: BoundaryEnvironment;
  endpoint?: string; // Default: "https://api.withboundary.com"

  // Default LLM model label stamped onto every event as `event.model`.
  // Override per-call via `contract.accept(run, { model })` when a single
  // logger is shared across multiple models.
  model?: string;

  capture?: Partial<CapturePolicy>;
  redact?: RedactionOptions;

  batch?: {
    // Flush when queue >= this. Default 20.
    size?: number;
    // Periodic flush in ms. Default 5000. 0 disables the timer.
    intervalMs?: number;
    // Drop-oldest when exceeded. Default 1000.
    maxQueueSize?: number;
  };

  // Last-chance transform/filter for each event, applied after capture +
  // redaction and before batching. Return the event (possibly mutated) to
  // send it, or `null` to drop it entirely. Use this for fields our built-in
  // redactor can't express — e.g., hashing a customer ID, dropping events
  // for a specific contract, or enriching with a trace ID you control.
  beforeSend?: (event: BoundaryLogEvent) => BoundaryLogEvent | null;

  // Custom sink — called with the batch each flush. When provided alongside
  // apiKey, both fire (useful for mirroring to local logs). When provided
  // alone, apiKey is not required.
  write?: (events: BoundaryLogEvent[]) => void | Promise<void>;

  // Register process exit hooks to drain the queue. Default true. Feature-
  // detected per runtime — Node uses beforeExit + SIGTERM, browsers use
  // beforeunload, edge/workers no-op.
  flushOnExit?: boolean;

  // Called when the transport drops events permanently (after retries / circuit
  // break / 4xx). Default: a one-time console.warn.
  onError?: (err: unknown) => void;

  // Injected fetch — primarily for tests. Defaults to globalThis.fetch.
  fetch?: typeof fetch;
}
