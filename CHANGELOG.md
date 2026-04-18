# @withboundary/sdk

## 0.2.0

### Minor Changes

- fdccc46: Initial release of `@withboundary/sdk` — the observability SDK for Boundary contract runs.

  - `createBoundaryLogger(options)` returns a `ContractLogger` that plugs into `defineContract({ logger })`.
  - Batched HTTP transport: size + time flush triggers, concurrent-flush coalescing, bounded queue with drop-oldest overflow.
  - Resilient transport: 3 retries with exponential backoff + jitter, `Retry-After` handling on 429, circuit breaker to prevent retry storms during outages, 10s per-attempt timeout.
  - Conservative capture policy (raw LLM inputs/outputs off by default) + three-layer redaction (fields, patterns, custom).
  - `beforeSend(event) => event | null` last-chance hook for users who need extra filtering or enrichment.
  - Bounded `flush(timeoutMs)` and `shutdown(timeoutMs)` for serverless / edge runtimes where there's no reliable lifecycle hook.
  - `User-Agent` and SDK-version metadata stamped on every request for backend debugging.
  - Custom sinks via `write(events)` — combine with `apiKey` or use alone.
  - Peer-depends on `@withboundary/contract@^1.1.0` (for the new `contractName` hook ctx).
