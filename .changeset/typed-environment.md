---
"@withboundary/sdk": minor
---

Narrow `BoundaryLoggerOptions.environment` from `string` to a `BoundaryEnvironment` union of the canonical labels: `"production" | "staging" | "development"`. Stops silent dashboard fragmentation from typos like `"prod"`, `"stage"`, or `"stg"`, and gives callers autocomplete.

The wire format (`BoundaryLogEvent.environment`) stays `string` so the server can accept future labels without an SDK bump. Widening `BoundaryEnvironment` later, when custom environments land as a real product feature, is also a minor bump.

Breaking for TypeScript users that were passing arbitrary strings; runtime behavior is unchanged.
