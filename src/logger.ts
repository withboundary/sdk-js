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
    const scrubbed = redact(gated, options.redact);

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
  // onRunSuccess/Failure), so a single mutable slot per contract is enough —
  // we track the latest category/issues/repairs before the terminal event.
  const runState = new Map<string, RunState>();

  return {
    onRunStart(ctx) {
      runState.set(ctx.contractName, {
        maxAttempts: ctx.maxAttempts,
        latestRepairs: [],
        latestCategory: undefined,
        latestIssues: undefined,
        rulesCount: ctx.rulesCount,
        model: ctx.model ?? defaultModel,
      });
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
      }
    },
    onRunSuccess(ctx) {
      const state = runState.get(ctx.contractName);
      emit({
        contractName: ctx.contractName,
        attempt: ctx.attempts,
        maxAttempts: state?.maxAttempts ?? ctx.attempts,
        ok: true,
        durationMs: ctx.totalDurationMs,
        repairs:
          state?.latestRepairs && state.latestRepairs.length > 0
            ? state.latestRepairs
            : undefined,
        model: state?.model ?? defaultModel,
        rulesCount: state?.rulesCount,
      });
      runState.delete(ctx.contractName);
    },
    onRunFailure(ctx) {
      const state = runState.get(ctx.contractName);
      emit({
        contractName: ctx.contractName,
        attempt: ctx.attempts,
        maxAttempts: state?.maxAttempts ?? ctx.attempts,
        ok: false,
        durationMs: ctx.totalDurationMs,
        category: ctx.category ?? state?.latestCategory,
        issues: state?.latestIssues,
        repairs:
          state?.latestRepairs && state.latestRepairs.length > 0
            ? state.latestRepairs
            : undefined,
        model: state?.model ?? defaultModel,
        rulesCount: state?.rulesCount,
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
  maxAttempts: number;
  latestRepairs: Message[];
  latestCategory: string | undefined;
  latestIssues: string[] | undefined;
  rulesCount: number;
  // Effective model for this run — per-call override (ctx.model from
  // contract.accept({ model })) or the logger's default. Undefined means
  // neither was set, in which case we omit the field from the event.
  model: string | undefined;
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

function detectRuntime(): string | undefined {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (proc?.versions?.node) return `node/${proc.versions.node}`;
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  if (nav?.userAgent) return `browser`;
  return undefined;
}
