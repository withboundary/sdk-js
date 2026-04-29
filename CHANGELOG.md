# @withboundary/sdk

## 0.5.1

### Patch Changes

- 0b4f51c: Tighter wire-event types: `BoundaryLogEvent` is now a discriminated union on `ok` — `AcceptedEvent` (`ok: true`, `final: true`) and `FailedEvent` (`ok: false`, with `category` and `issues` required). Failure attribution and repair messages can only appear on failed events, enforced at the type level.

  This is a small breaking change for consumers who treated `BoundaryLogEvent` as a single record with optional everything: code that reads `event.category`, `event.ruleFailures`, etc. now needs to narrow on `event.ok` first. The shape on the wire is unchanged for accepted runs (the previously-optional failure fields are simply never set), so backends that already coalesce on `ok` continue to work.

  Adds a regression test covering the rule-fail-then-pass path: the terminal event for an accepted run carries no `ruleFailures` / `issues` / `category` / `repairs`.

- 0b4f51c: Drop Node 18 support. Bump minimum `engines.node` to `>=20` and update the CI matrix to Node 20/22/24.

  Node 18 LTS ended on 2025-04-30. Several dev-only deps (vitest 4+, rolldown) already use Node-20-only APIs (`node:util.styleText`), so Node 18 was effectively unsupported at the dev/tooling level — this just formalizes it for consumers.

  No runtime behavior change; no API change. Users on Node 20+ are unaffected. Mirrors the same drop in `@withboundary/contract@1.4.1`.

- 0b4f51c: Per-call state isolation in the logger. The per-run scratch is now keyed by `ctx.runHandle` (a per-`accept()` id added in `@withboundary/contract@1.5.0`) when present, falling back to `ctx.contractName` against older engines. Concurrent `accept()` calls on the same contract instance — common when a single shared contract serves many parallel requests — each get their own state by construction once paired with `@withboundary/contract@^1.5.0`. Older contract versions retain the prior single-call-at-a-time behavior.

  Per-attempt scratch is also reallocated whole on every `onAttemptStart` so no slot can carry forward across attempts.

## 0.5.0

### Minor Changes

- 2567e8f: Per-attempt streaming with stable `runId`.

  `createBoundaryLogger` now emits **one event per attempt** within a single `contract.accept()` call instead of summarising the run into a single terminal event. Every event carries:
  - `runId: bnd_run_<nanoid(21)>` — generated client-side in `onRunStart`, stamped on every event for the run so the backend can coalesce them into a single row.
  - `final: boolean` — `true` on the terminal event (`onRunSuccess` / `onRunFailure`), `false` on per-attempt failure events emitted from `onRetryScheduled` between attempts.

  For a 1-attempt success: still one event (`final: true`). For an N-attempt repaired success: N events sharing one `runId` — N-1 per-attempt failures (`final: false ok: false`) + one terminal success (`final: true ok: true`). The per-attempt events carry the failed attempt's `output`, `category`, `ruleFailures`, and the repair message about to be sent to the model.

  Both `runId` and `final` are required fields on `BoundaryLogEvent`. Anything pinning the wire shape (e.g., a custom `write` sink validating event structure) needs to accept them.

  Receiving sinks that group events by `runId` see one row per run with N attempt entries. Per-attempt events also flow naturally with `capture.inputs` / `capture.outputs` flags — each attempt's input (the prompt sent that round) and output (what the model produced that round) ships when capture is on.

## 0.3.3

### Patch Changes

- b159948: Bump `@withboundary/contract` peer dep to `^1.4.0` and move the test suite to `zod@^4`.

  Contract 1.4.0 accepts both zod v3 and v4 schemas via an internal adapter, so consumers on either zod major are supported transparently. The SDK itself has no direct zod coupling — all schema typing flows through `@withboundary/contract`'s `ContractSchema<T>`.

- 99f6818: Upgrade to TypeScript 6.
  - `devDependencies.typescript`: `^5.5.0` → `^6.0.3`
  - `tsconfig.json`: add `"ignoreDeprecations": "6.0"` to silence `TS5101` for the implicit `baseUrl` that tsup's dts builder emits internally. Will revisit before TS 7.

  Supersedes dependabot PR #19, which couldn't land cleanly without the tsconfig mitigation. No runtime or API changes.

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
