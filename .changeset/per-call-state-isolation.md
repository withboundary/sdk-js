---
"@withboundary/sdk": patch
---

Per-call state isolation in the logger. The per-run scratch is now keyed by `ctx.runHandle` (a per-`accept()` id added in `@withboundary/contract@1.5.0`) when present, falling back to `ctx.contractName` against older engines. Concurrent `accept()` calls on the same contract instance — common when a single shared contract serves many parallel requests — each get their own state by construction once paired with `@withboundary/contract@^1.5.0`. Older contract versions retain the prior single-call-at-a-time behavior.

Per-attempt scratch is also reallocated whole on every `onAttemptStart` so no slot can carry forward across attempts.
