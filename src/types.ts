// Public types for @withboundary/sdk.

// The canonical environment labels the product recognises today. Typed as a
// union so common typos (`"prod"`, `"stage"`, `"stg"`) can't silently fragment
// the dashboard into mystery buckets. Widen this when custom environments
// become a real product feature — the wire format (BoundaryLogEvent below)
// stays `string` so the server can accept future names without an SDK bump.
export type BoundaryEnvironment = "production" | "staging" | "development";

// Flat description of a contract's output schema. Emitted once per contract
// so the backend can populate `contracts.schema_json`. Mirrors the identical
// type in @withboundary/contract — kept local so this package can stand on
// its own when contract-js isn't installed (the peer dep is optional).
export interface SchemaField {
  name: string;
  type: string;
  constraints?: string;
}

// Wire shape for a rule. Emitted once per contract so the backend can
// upsert the `rules` table by (contract_id, name). Mirrored from
// @withboundary/contract; see the note above for why it's duplicated.
export interface RuleDefinition {
  name: string;
  expression?: string;
  description?: string;
  fields?: string[];
}

// Common shape every wire event carries — identity, run metadata, capture
// policy, and the data buckets that ride along regardless of outcome.
// Specialized below into AcceptedEvent and FailedEvent so failure attribution
// can only exist on events where it's meaningful.
export interface BoundaryLogEventBase {
  // identity
  contractName: string;
  environment?: string;
  timestamp: string; // ISO 8601

  // Stable per-run id — `bnd_run_<nanoid>`. Generated once per `accept()`
  // call and stamped on every event for that run (per-attempt + terminal),
  // so the backend coalesces them into a single run row keyed by
  // (organizationId, runId). Required: a run without an id can't survive
  // multi-event streaming on the backend.
  runId: string;

  // run metadata — always sent. Boundary can't represent a run without these.
  // `attempt` is the attempt this event reflects:
  //   - per-attempt event (final=false): the attempt that just failed
  //   - terminal event (final=true): the final attempt count for the run
  attempt: number;
  maxAttempts: number;
  // Per-attempt event: duration of just this attempt.
  // Terminal event: total duration across all attempts.
  durationMs: number;

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

  // Contract shape metadata. Emitted on the first event per contract per
  // process; backend COALESCEs into contracts.schema_json and upserts rules
  // by (contract_id, name). Safe to re-send but wasteful.
  schema?: SchemaField[];
  rules?: RuleDefinition[];

  // SDK metadata — stamped by @withboundary/sdk so the backend can attribute
  // events to a specific SDK version and runtime when debugging issues.
  sdk?: {
    name: string;
    version: string;
    runtime?: string;
  };

  // Resolved capture policy stamped on every event so the dashboard can
  // distinguish "off by config" from "captured but empty" — very different
  // failure modes. `redactedFields` lists leaf field names the SDK scrubbed
  // before send (from the redact.fields config); the dashboard uses it to
  // render "[REDACTED]" rows authoritatively instead of inferring.
  capture?: CapturePolicy & { redactedFields?: string[] };
}

// An attempt that satisfied schema and every rule. Always terminal — once an
// attempt is accepted the contract returns and no further events fire for
// the run. By construction there is no failure attribution and no repair
// (a repair is the message sent before the *next* attempt; an accepted
// attempt has none).
export interface AcceptedEvent extends BoundaryLogEventBase {
  ok: true;
  final: true;
}

// An attempt that didn't pass. `final=false` is a mid-run event sent before
// the next retry; `final=true` is the terminal event after max retries are
// exhausted. Failure attribution is always populated; `repairs` lists the
// message about to be sent before the next attempt and is therefore present
// only on non-terminal failures.
export interface FailedEvent extends BoundaryLogEventBase {
  ok: false;
  final: boolean;
  category: string;
  issues: string[];
  ruleFailures?: string[];
  repairs?: Array<{ role: string; content: string }>;
}

// Tagged union on `ok`. The backend's Zod schema mirrors this shape, so any
// runtime drift (e.g. a hand-rolled emitter that paired ok=true with a stray
// ruleFailures field) is rejected at /v1/ingest with a 400.
export type BoundaryLogEvent = AcceptedEvent | FailedEvent;

// Which optional data the SDK is allowed to ship. Structural run metadata
// (contract name, attempt, duration, ok, category, issues, rule failures) is
// sent unconditionally — it's the minimum Boundary needs to show a run at
// all. The flags here govern the three data buckets that can contain
// user/LLM content and therefore deserve opt-in.
export interface CapturePolicy {
  inputs: boolean; // user → model data              (default OFF)
  outputs: boolean; // model → boundary data           (default OFF)
  repairs: boolean; // boundary → model retry messages (default ON)
}

export const DEFAULT_CAPTURE: CapturePolicy = {
  inputs: false,
  outputs: false,
  repairs: true,
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

  // Register lifecycle hooks to drain the queue. Default true. Feature-
  // detected per runtime: Node uses beforeExit only, browsers use
  // visibility/pagehide hooks, edge/workers no-op.
  flushOnExit?: boolean;

  // Called when the transport drops events permanently (after retries / circuit
  // break / 4xx). Default: a one-time console.warn.
  onError?: (err: unknown) => void;

  // Injected fetch — primarily for tests. Defaults to globalThis.fetch.
  fetch?: typeof fetch;
}
