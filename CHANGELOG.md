# @withboundary/sdk

## 0.3.2

### Patch Changes

- b2343f5: Update logger test expectation from `"INVARIANT_ERROR"` to `"RULE_ERROR"` to match the rename in `@withboundary/contract`. Requires `@withboundary/contract@^1.3.0`.

## 0.3.1

### Patch Changes

- 435e2a3: Publish with [npm provenance attestations](https://docs.npmjs.com/generating-provenance-statements) via GitHub Actions OIDC trusted publishing.

  Every release now ships with a signed attestation linking the tarball back to the exact commit and workflow that built it in [`withboundary/sdk-js`](https://github.com/withboundary/sdk-js). Consumers can verify the supply chain themselves with:

  ```bash
  npm audit signatures
  ```

  No API or behavior changes.

## 0.3.0

### Minor Changes

- f8e1d5f: Stamp `model` and `rulesCount` onto every BoundaryLogEvent.

  - `BoundaryLoggerOptions.model` sets a default LLM model label on every event. Useful for single-model apps.
  - Per-call override flows through from `contract.accept(run, { model })` in `@withboundary/contract@^1.2.0`.
  - `rulesCount` is populated from the contract's `rules` array at runtime.

  Bumps the peer dependency on `@withboundary/contract` to `^1.2.0` to pick up the updated `onRunStart` hook contract (`rulesCount` + `model`).

- e46bd6f: Narrow `BoundaryLoggerOptions.environment` from `string` to a `BoundaryEnvironment` union of the canonical labels: `"production" | "staging" | "development"`. Stops silent dashboard fragmentation from typos like `"prod"`, `"stage"`, or `"stg"`, and gives callers autocomplete.

  The wire format (`BoundaryLogEvent.environment`) stays `string` so the server can accept future labels without an SDK bump. Widening `BoundaryEnvironment` later, when custom environments land as a real product feature, is also a minor bump.

  Breaking for TypeScript users that were passing arbitrary strings; runtime behavior is unchanged.

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
