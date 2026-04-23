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
  BoundaryLogEvent,
  BoundaryLoggerOptions,
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
  // batcher. Centralized here so onRunSuccess / onRunFailure agree on shape.
  const emit = (partial: Omit<BoundaryLogEvent, "timestamp" | "sdk">): void => {
    const event: BoundaryLogEvent = {
      timestamp: new Date().toISOString(),
      environment,
      sdk: sdkMeta,
      ...partial,
    };
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

  // Per-run scratch space keyed by contractName. The contract library
  // interleaves hooks in order (onAttemptStart → onRawOutput → onVerify* →
  // onRetryScheduled → … → onRunSuccess/Failure), all serial within one
  // run. A single mutable slot per contract is enough — we track the
  // latest category/issues/repairs/output and emit a per-attempt event in
  // onRetryScheduled (non-terminal failures) plus a terminal event in
  // onRunSuccess/Failure.
  const runState = new Map<string, RunState>();

  return {
    onRunStart(ctx) {
      runState.set(ctx.contractName, {
        runId: createRunId(),
        startedAt: nowMs(),
        attemptStartedAt: nowMs(),
        maxAttempts: ctx.maxAttempts,
        latestRepairs: [],
        latestCategory: undefined,
        latestIssues: undefined,
        latestRuleFailures: undefined,
        latestInput: undefined,
        latestOutput: undefined,
        rulesCount: ctx.rulesCount,
        model: ctx.model ?? defaultModel,
        schema: ctx.schema,
        rules: ctx.rules,
      });
    },
    onAttemptStart(ctx) {
      // The schema-derived (and repair-augmented) prompt the contract sends
      // to the model on this attempt. This is the closest single artifact to
      // "what was sent in" that the SDK can observe without intercepting
      // the user's RunFn — store it as the candidate `input` and let
      // applyCapture decide whether it ships.
      const state = runState.get(ctx.contractName);
      if (state) {
        state.latestInput = ctx.instructions;
        state.attemptStartedAt = nowMs();
      }
    },
    onCleanedOutput(ctx) {
      // First viable snapshot of the model's output: parsed JSON (or coerced
      // value), pre-validation. Cheaper to keep than the raw string and
      // matches what users typically want to inspect on validation failures.
      // Overridden by onVerifySuccess below when the run succeeds.
      const state = runState.get(ctx.contractName);
      if (state) {
        state.latestOutput = ctx.cleaned;
      }
    },
    onVerifySuccess(ctx) {
      // Prefer the typed/validated payload over the raw cleaned value when
      // the run accepts — same data, but post-coercion. This is what the
      // user's app would actually consume.
      const state = runState.get(ctx.contractName);
      if (state) {
        state.latestOutput = ctx.data;
      }
    },
    onRepairGenerated(ctx) {
      const state = runState.get(ctx.contractName);
      if (state) {
        state.latestRepairs = [
          { role: "user", content: ctx.repairMessage },
        ];
        state.latestCategory = ctx.category;
      }
    },
    onVerifyFailure(ctx) {
      const state = runState.get(ctx.contractName);
      if (state) {
        state.latestCategory = ctx.category;
        state.latestIssues = ctx.issues;
        state.latestRuleFailures = ctx.ruleIssues
          ? ctx.ruleIssues.map((issue) => issue.rule.name)
          : undefined;
      }
    },
    onRetryScheduled(ctx) {
      // Non-terminal failure that's about to be retried. Emit a per-attempt
      // event with all the data we accumulated for this attempt: failed
      // output, failed rules, and the repair message we're about to send to
      // the model. Then reset per-attempt scratch so the next attempt's
      // snapshot starts clean.
      const state = runState.get(ctx.contractName);
      if (!state) return;
      emit({
        runId: state.runId,
        final: false,
        contractName: ctx.contractName,
        attempt: ctx.attempt,
        maxAttempts: state.maxAttempts,
        ok: false,
        durationMs: nowMs() - state.attemptStartedAt,
        input: state.latestInput,
        output: state.latestOutput,
        category: ctx.category ?? state.latestCategory,
        issues: state.latestIssues,
        ruleFailures: state.latestRuleFailures,
        repairs:
          state.latestRepairs && state.latestRepairs.length > 0
            ? state.latestRepairs
            : undefined,
        model: state.model ?? defaultModel,
        rulesCount: state.rulesCount,
        schema: state.schema,
        rules: state.rules,
      });
      // Reset per-attempt accumulators so the next attempt's data doesn't
      // leak into either subsequent per-attempt events or the terminal one.
      // Schema/rules/runId/model persist for the run's lifetime.
      state.latestOutput = undefined;
      state.latestIssues = undefined;
      state.latestRuleFailures = undefined;
      state.latestCategory = undefined;
      state.latestRepairs = [];
      // latestInput resets when the next onAttemptStart fires.
    },
    onRunSuccess(ctx) {
      const state = runState.get(ctx.contractName);
      emit({
        runId: state?.runId ?? createRunId(),
        final: true,
        contractName: ctx.contractName,
        attempt: ctx.attempts,
        maxAttempts: state?.maxAttempts ?? ctx.attempts,
        ok: true,
        durationMs: ctx.totalDurationMs,
        input: state?.latestInput,
        output: state?.latestOutput ?? ctx.data,
        repairs:
          state?.latestRepairs && state.latestRepairs.length > 0
            ? state.latestRepairs
            : undefined,
        model: state?.model ?? defaultModel,
        rulesCount: state?.rulesCount,
        schema: state?.schema,
        rules: state?.rules,
      });
      runState.delete(ctx.contractName);
    },
    onRunFailure(ctx) {
      const state = runState.get(ctx.contractName);
      emit({
        runId: state?.runId ?? createRunId(),
        final: true,
        contractName: ctx.contractName,
        attempt: ctx.attempts,
        maxAttempts: state?.maxAttempts ?? ctx.attempts,
        ok: false,
        durationMs: ctx.totalDurationMs,
        input: state?.latestInput,
        // On failure we ship the last cleaned output we saw — usually from
        // the final attempt that triggered this terminal failure. Helps the
        // user see *what* the model produced on the way to giving up.
        output: state?.latestOutput,
        category: ctx.category ?? state?.latestCategory,
        issues: state?.latestIssues,
        ruleFailures: state?.latestRuleFailures,
        repairs:
          state?.latestRepairs && state.latestRepairs.length > 0
            ? state.latestRepairs
            : undefined,
        model: state?.model ?? defaultModel,
        rulesCount: state?.rulesCount,
        schema: state?.schema,
        rules: state?.rules,
      });
      runState.delete(ctx.contractName);
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

interface RunState {
  // Stable id for this run. Generated in onRunStart and stamped on every
  // event we emit for the run (per-attempt + terminal) so the backend can
  // coalesce them into one run row.
  runId: string;
  // Wall-clock starts for per-attempt durationMs. attemptStartedAt is reset
  // each onAttemptStart and consumed by onRetryScheduled.
  startedAt: number;
  attemptStartedAt: number;
  maxAttempts: number;
  latestRepairs: Message[];
  latestCategory: string | undefined;
  latestIssues: string[] | undefined;
  // Rule names that failed on the most recent attempt, extracted from the
  // structured ruleIssues on onVerifyFailure. Forwarded as `ruleFailures`
  // so the backend can join on rule_failure_counts.rule_key.
  latestRuleFailures: string[] | undefined;
  // Latest prompt the SDK saw the contract send to the model. Captured on
  // onAttemptStart from ctx.instructions — the schema- (and repair-)
  // augmented system prompt. Gated by capture.inputs at emit time.
  latestInput: unknown;
  // Latest cleaned/typed model output: ctx.cleaned from onCleanedOutput,
  // upgraded to the validated ctx.data on onVerifySuccess. Gated by
  // capture.outputs at emit time.
  latestOutput: unknown;
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

const NANOID_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

function randomBase62(len: number): string {
  // Use crypto.getRandomValues when available (browser, Node ≥18 globally).
  // Bytes mod alphabet length is biased for non-power-of-two alphabets, but
  // for 64 chars we're fine — alphabet length divides 256 evenly. For other
  // lengths the bias is negligible at this id size.
  const bytes = new Uint8Array(len);
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
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
