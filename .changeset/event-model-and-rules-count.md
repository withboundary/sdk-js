---
"@withboundary/sdk": minor
---

Stamp `model` and `rulesCount` onto every BoundaryLogEvent.

- `BoundaryLoggerOptions.model` sets a default LLM model label on every event. Useful for single-model apps.
- Per-call override flows through from `contract.accept(run, { model })` in `@withboundary/contract@^1.2.0`.
- `rulesCount` is populated from the contract's `rules` array at runtime.

Bumps the peer dependency on `@withboundary/contract` to `^1.2.0` to pick up the updated `onRunStart` hook contract (`rulesCount` + `model`).
