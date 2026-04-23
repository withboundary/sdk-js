---
"@withboundary/sdk": minor
---

Per-attempt streaming with stable `runId`.

`createBoundaryLogger` now emits **one event per attempt** within a single `contract.accept()` call instead of summarising the run into a single terminal event. Every event carries:

- `runId: bnd_run_<nanoid(21)>` — generated client-side in `onRunStart`, stamped on every event for the run so the backend can coalesce them into a single row.
- `final: boolean` — `true` on the terminal event (`onRunSuccess` / `onRunFailure`), `false` on per-attempt failure events emitted from `onRetryScheduled` between attempts.

For a 1-attempt success: still one event (`final: true`). For an N-attempt repaired success: N events sharing one `runId` — N-1 per-attempt failures (`final: false ok: false`) + one terminal success (`final: true ok: true`). The per-attempt events carry the failed attempt's `output`, `category`, `ruleFailures`, and the repair message about to be sent to the model.

Both `runId` and `final` are required fields on `BoundaryLogEvent`. Anything pinning the wire shape (e.g., a custom `write` sink validating event structure) needs to accept them.

Receiving sinks that group events by `runId` see one row per run with N attempt entries. Per-attempt events also flow naturally with `capture.inputs` / `capture.outputs` flags — each attempt's input (the prompt sent that round) and output (what the model produced that round) ships when capture is on.
