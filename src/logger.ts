import type { ContractLogger, Message } from "@withboundary/contract";
import { Batcher } from "./batcher.js";
import { applyCapture, resolveCapture } from "./capture.js";
import { defaultOnError } from "./errors.js";
import { redact } from "./redact.js";
import { registerShutdown } from "./shutdown.js";
import { CircuitBreakerTransport } from "./transport/breaker.js";
import { CustomTransport, MultiTransport } from "./transport/custom.js";
import { HttpTransport } from "./transport/http.js";
import type { Transport } from "./transport/types.js";
import type {
  AcceptedEvent,
  BoundaryLogEvent,
  BoundaryLogEventBase,
  BoundaryLoggerOptions,
  FailedEvent,
  RuleDefinition,
  SchemaField,
} from "./types.js";
import { SDK_NAME, SDK_VERSION } from "./version.js";

// Extension of ContractLogger with drain controls. Hooks stay synchronous
// from the contract loop's POV (push-and-return); users call flush/shutdown
// explicitly when they need to drain before the process goes away —
// especially on Edge/Workers/Lambda where there's no reliable lifecycle hook.
export type BoundaryLogger<T = unknown> = ContractLogger<T> & {
  // Drain the queue and wait for in-flight writes. If `timeoutMs` is
  // provided, returns once the deadline is hit even if some events are
  // still buffered — callers get back control in bounded time.
  flush: (timeoutMs?: number) => Promise<void>;
  // Like flush, but also stops the periodic timer and disables the logger.
  // Idempotent. Use this from your own SIGTERM handler.
  shutdown: (timeoutMs?: number) => Promise<void>;
};

const DEFAULT_ENDPOINT = "https://api.withboundary.com";
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_BATCH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_QUEUE_SIZE = 1_000;

// Creates a ContractLogger that batches every run into a BoundaryLogEvent
// and ships it to Boundary's cloud (or a custom sink, or both).
//
// Returns `null` when neither `apiKey` nor `write` is configured — the
// idiomatic dev-safe call site:
//
//   const logger = createBoundaryLogger({ apiKey: process.env.BOUNDARY_API_KEY });
//   defineContract({ name: "sample", schema, logger });
//
// ...works in production with the key set, and no-ops locally when it isn't.
export function createBoundaryLogger<T = unknown>(
  options: BoundaryLoggerOptions = {},
): BoundaryLogger<T> | null {
  const apiKey = options.apiKey ?? getEnv("BOUNDARY_API_KEY");
  const hasWrite = typeof options.write === "function";

  if (!apiKey && !hasWrite) {
    // No destination — safe no-op. Lets developers leave the logger wired
    // up without throwing in environments where the key isn't configured.
    return null;
  }

  const capture = resolveCapture(options.capture);
  const environment = options.environment;
  const defaultModel = options.model;
  const onError = options.onError ?? defaultOnError;
  const beforeSend = options.beforeSend;
  const sdkMeta = {
    name: SDK_NAME,
    version: SDK_VERSION,
    runtime: detectRuntime(),
  };

  const transport = buildTransport({ apiKey, options });

  const batcher = new Batcher(transport, {
    size: options.batch?.size ?? DEFAULT_BATCH_SIZE,
    intervalMs: options.batch?.intervalMs ?? DEFAULT_BATCH_INTERVAL_MS,
    maxQueueSize: options.batch?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
    onError,
  });

  const shouldRegisterExit = options.flushOnExit !== false;
  const disposeShutdown = shouldRegisterExit
    ? registerShutdown(() => batcher.shutdown())
    : () => undefined;

  // Build an event from a run result (success or failure) and push to the
  // batcher. The Omit-on-union is distributed by TypeScript, so the call
  // site narrows naturally on the `ok` literal — the compiler refuses an
  // accepted partial that carries failure metadata or vice versa.
  type EmitPartial =
    | Omit<AcceptedEvent, "timestamp" | "sdk">
    | Omit<FailedEvent, "timestamp" | "sdk">;
  const emit = (partial: EmitPartial): void => {
    const base = {
      timestamp: new Date().toISOString(),
      environment,
      sdk: sdkMeta,
    };
    const event: BoundaryLogEvent = partial.ok ? { ...base, ...partial } : { ...base, ...partial };
    const gated = applyCapture(event, capture);
    const { event: scrubbed, redactedFields } = redact(gated, options.redact);

    // Stamp the resolved capture policy + any scrubbed leaf field names onto
    // the event. Done after redact so the dashboard can distinguish "off by
    // config" from "captured but empty" and render [REDACTED] rows
    // authoritatively instead of inferring.
    scrubbed.capture = {
      ...capture,
      ...(redactedFields.length > 0 && { redactedFields }),
    };

    // User's last-chance hook. A null return drops the event. Exceptions
    // in beforeSend route through onError so a bad user fn never breaks
    // the contract flow.
    let final: BoundaryLogEvent | null = scrubbed;
    if (beforeSend) {
      try {
        final = beforeSend(scrubbed);
      } catch (err) {
        onError(err);
        return;
      }
    }
    if (final === null) return;

    batcher.enqueue(final);
  };

  // Per-run scratch space keyed by a per-`accept()` handle — `ctx.runHandle`
  // when paired with `@withboundary/contract@^1.5.0`, falling back to
  // `ctx.contractName` against older engines that don't emit a handle.
  // Keying by handle (not contractName) means concurrent calls of the
  // same contract each get isolated state, which matters whenever a
  // single contract instance is shared across parallel requests; the
  // contractName fallback preserves prior single-call-at-a-time behavior
  // for consumers still on contract 1.4.x.
  const runState = new Map<string, RunState>();

  // Read the per-call key off any hook ctx. Typed permissively so this
  // file compiles against contract 1.4.x (no runHandle on the type) while
  // still picking up the field at runtime under 1.5.x.
  const stateKey = (ctx: { contractName: string }): string => {
    const handle = (ctx as { runHandle?: unknown }).runHandle;
    return typeof handle === "string" && handle.length > 0 ? handle : ctx.contractName;
  };

  // Build the constant fields every wire event carries — identity, model,
  // contract shape — so per-hook emit calls only have to specify what's
  // attempt-specific. Centralizing prevents drift between accepted and
  // failed event paths.
  const commonEvent = (
    state: RunState | undefined,
    contractName: string,
  ): Pick<
    BoundaryLogEventBase,
    "runId" | "contractName" | "model" | "rulesCount" | "schema" | "rules"
  > => ({
    runId: state?.runId ?? createRunId(),
    contractName,
    model: state?.model ?? defaultModel,
    rulesCount: state?.rulesCount,
    schema: state?.schema,
    rules: state?.rules,
  });

  const freshAttempt = (input: unknown): AttemptScratch => ({
    startedAt: nowMs(),
    input,
    output: undefined,
    failure: undefined,
    repair: undefined,
  });

  return {
    onRunStart(ctx) {
      runState.set(stateKey(ctx), {
        runId: createRunId(),
        startedAt: nowMs(),
        maxAttempts: ctx.maxAttempts,
        rulesCount: ctx.rulesCount,
        model: ctx.model ?? defaultModel,
        schema: ctx.schema,
        rules: ctx.rules,
        attempt: freshAttempt(undefined),
      });
    },
    onAttemptStart(ctx) {
      // Allocate a fresh attempt scratch — never mutate the previous
      // attempt's slot. This is the single point where per-attempt data
      // is bound; nothing else in the logger can carry forward state from
      // a prior attempt into a subsequent emit.
      const state = runState.get(stateKey(ctx));
      if (state) {
        state.attempt = freshAttempt(ctx.instructions);
      }
    },
    onCleanedOutput(ctx) {
      // First viable snapshot of the model's output: parsed JSON (or coerced
      // value), pre-validation. Cheaper to keep than the raw string and
      // matches what users typically want to inspect on validation failures.
      // Overridden by onVerifySuccess below when the run succeeds.
      const state = runState.get(stateKey(ctx));
      if (state) {
        state.attempt.output = ctx.cleaned;
      }
    },
    onVerifySuccess(ctx) {
      // Prefer the typed/validated payload over the raw cleaned value when
      // the run accepts — same data, but post-coercion. This is what the
      // user's app would actually consume.
      const state = runState.get(stateKey(ctx));
      if (state) {
        state.attempt.output = ctx.data;
      }
    },
    onVerifyFailure(ctx) {
      const state = runState.get(stateKey(ctx));
      if (state) {
        state.attempt.failure = {
          category: ctx.category,
          issues: ctx.issues,
          ruleFailures: ctx.ruleIssues ? ctx.ruleIssues.map((issue) => issue.rule.name) : undefined,
        };
      }
    },
    onRepairGenerated(ctx) {
      // The repair is the message that will be sent to the model BEFORE
      // the next attempt. It belongs to the failed attempt that triggered
      // it — that's how the dashboard renders "REPAIR (for attempt N+1)"
      // under attempt N's card.
      const state = runState.get(stateKey(ctx));
      if (state) {
        state.attempt.repair = [{ role: "user", content: ctx.repairMessage }];
      }
    },
    onRetryScheduled(ctx) {
      // Mid-run failure that's about to be retried. Emit a per-attempt
      // event from this attempt's scratch — never mutated, so there's no
      // post-emit reset to remember.
      const state = runState.get(stateKey(ctx));
      if (!state) return;
      const att = state.attempt;
      const failure = att.failure;
      // VerifyFailure must have populated `failure` before retryScheduled
      // fires — this is a contract-engine invariant. Fall back to the ctx
      // category if the SDK is paired with an engine that diverges.
      emit({
        ...commonEvent(state, ctx.contractName),
        ok: false,
        final: false,
        attempt: ctx.attempt,
        maxAttempts: state.maxAttempts,
        durationMs: nowMs() - att.startedAt,
        input: att.input,
        output: att.output,
        category: failure?.category ?? ctx.category,
        issues: failure?.issues ?? [],
        ruleFailures: failure?.ruleFailures,
        repairs: att.repair,
      });
    },
    onRunSuccess(ctx) {
      const state = runState.get(stateKey(ctx));
      const att = state?.attempt;
      // AcceptedEvent shape — type system prevents leaking failure metadata
      // here. `final: true` is structural: an accepted attempt always
      // terminates the run.
      emit({
        ...commonEvent(state, ctx.contractName),
        ok: true,
        final: true,
        attempt: ctx.attempts,
        maxAttempts: state?.maxAttempts ?? ctx.attempts,
        durationMs: ctx.totalDurationMs,
        input: att?.input,
        output: att?.output ?? ctx.data,
      });
      runState.delete(stateKey(ctx));
    },
    onRunFailure(ctx) {
      const state = runState.get(stateKey(ctx));
      const att = state?.attempt;
      const failure = att?.failure;
      // Terminal failure ships the last attempt's failure attribution and
      // its output for forensic value. No `repairs` — there is no next
      // attempt to repair toward; the FailedEvent shape allows omitting it.
      emit({
        ...commonEvent(state, ctx.contractName),
        ok: false,
        final: true,
        attempt: ctx.attempts,
        maxAttempts: state?.maxAttempts ?? ctx.attempts,
        durationMs: ctx.totalDurationMs,
        input: att?.input,
        output: att?.output,
        category: failure?.category ?? ctx.category ?? "UNKNOWN",
        issues: failure?.issues ?? [],
        ruleFailures: failure?.ruleFailures,
      });
      runState.delete(stateKey(ctx));
    },

    async flush(timeoutMs?: number) {
      await batcher.flush(timeoutMs);
    },
    async shutdown(timeoutMs?: number) {
      disposeShutdown();
      await batcher.shutdown(timeoutMs);
    },
  };
}

// Per-attempt scratch. Reallocated whole on every onAttemptStart, never
// mutated across attempt boundaries — so a successful attempt's emit can
// only ever read its own data, regardless of which contract-engine hooks
// fired and in what order.
interface AttemptScratch {
  startedAt: number;
  // Prompt the contract sent to the model on this attempt (schema- and
  // repair-augmented). Gated by capture.inputs at emit time.
  input: unknown;
  // Latest cleaned/typed model output for this attempt. Set by
  // onCleanedOutput and upgraded to the validated payload on
  // onVerifySuccess. Gated by capture.outputs at emit time.
  output: unknown;
  // Populated when verify rejects this attempt. Absent on accepted attempts.
  failure: AttemptFailure | undefined;
  // The repair message generated for the *next* attempt. Stays undefined
  // when there is no next attempt (accepted, or terminal failure).
  repair: Message[] | undefined;
}

interface AttemptFailure {
  category: string;
  issues: string[];
  ruleFailures: string[] | undefined;
}

interface RunState {
  // Stable id for this run. Generated in onRunStart and stamped on every
  // event we emit for the run (per-attempt + terminal) so the backend can
  // coalesce them into one run row.
  runId: string;
  // Wall-clock start for the run, used to compute totalDurationMs on the
  // terminal event when the contract context doesn't supply one.
  startedAt: number;
  maxAttempts: number;
  rulesCount: number;
  // Effective model for this run — per-call override (ctx.model from
  // contract.accept({ model })) or the logger's default. Undefined means
  // neither was set, in which case we omit the field from the event.
  model: string | undefined;
  // Contract shape metadata — populated once per contract per process on the
  // first onRunStart that carries it; the sdk then forwards it on every
  // subsequent terminal event until the state is cleared at run end.
  schema: SchemaField[] | undefined;
  rules: RuleDefinition[] | undefined;
  // Current attempt's scratch. Replaced (not mutated) on every
  // onAttemptStart so per-attempt data has a hard boundary.
  attempt: AttemptScratch;
}

interface BuildTransportArgs {
  apiKey: string | undefined;
  options: BoundaryLoggerOptions;
}

// Compose the actual Transport. The HTTP path is wrapped in a circuit
// breaker so an outage doesn't turn into a retry storm; the custom sink
// isn't breaker-wrapped because it's the user's code and they own its
// failure semantics.
function buildTransport({ apiKey, options }: BuildTransportArgs): Transport {
  const transports: Transport[] = [];

  if (apiKey) {
    const http = new HttpTransport({
      endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
      apiKey,
      fetch: options.fetch,
    });
    transports.push(new CircuitBreakerTransport(http));
  }
  if (typeof options.write === "function") {
    transports.push(new CustomTransport(options.write));
  }

  if (transports.length === 1) return transports[0]!;
  return new MultiTransport(transports);
}

function getEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

// Stable id stamped on every event emitted for a single `accept()` call.
// Used by the receiving backend purely as an idempotency / grouping key —
// it is not an auth credential. Authentication and tenant isolation belong
// to whatever transport layer carries the events (an API key on the HTTP
// transport, the host process on a custom `write` sink), never to the
// runId itself.
function createRunId(): string {
  return `bnd_run_${randomBase62(21)}`;
}

const NANOID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

function randomBase62(len: number): string {
  // Use crypto.getRandomValues when available (browser, Node ≥18 globally).
  // Bytes mod alphabet length is biased for non-power-of-two alphabets, but
  // for 64 chars we're fine — alphabet length divides 256 evenly. For other
  // lengths the bias is negligible at this id size.
  const bytes = new Uint8Array(len);
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
    .crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    // Last-resort fallback for ancient runtimes. Quality is enough for an
    // idempotency key; the runId is not a security boundary.
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < len; i++) out += NANOID_ALPHABET[bytes[i]! & 63];
  return out;
}

function nowMs(): number {
  return Date.now();
}

function detectRuntime(): string | undefined {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (proc?.versions?.node) return `node/${proc.versions.node}`;
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  if (nav?.userAgent) return `browser`;
  return undefined;
}
