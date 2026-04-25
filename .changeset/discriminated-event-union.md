---
"@withboundary/sdk": patch
---

Tighter wire-event types: `BoundaryLogEvent` is now a discriminated union on `ok` — `AcceptedEvent` (`ok: true`, `final: true`) and `FailedEvent` (`ok: false`, with `category` and `issues` required). Failure attribution and repair messages can only appear on failed events, enforced at the type level.

This is a small breaking change for consumers who treated `BoundaryLogEvent` as a single record with optional everything: code that reads `event.category`, `event.ruleFailures`, etc. now needs to narrow on `event.ok` first. The shape on the wire is unchanged for accepted runs (the previously-optional failure fields are simply never set), so backends that already coalesce on `ok` continue to work.

Adds a regression test covering the rule-fail-then-pass path: the terminal event for an accepted run carries no `ruleFailures` / `issues` / `category` / `repairs`.
