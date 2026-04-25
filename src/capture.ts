import { DEFAULT_CAPTURE, type BoundaryLogEvent, type CapturePolicy } from "./types.js";

// Resolve a partial user-supplied capture policy against the safe defaults.
// Callers always get a fully-populated policy so downstream code doesn't
// need to defend against undefined flags.
export function resolveCapture(
  input: Partial<CapturePolicy> | undefined,
): CapturePolicy {
  return { ...DEFAULT_CAPTURE, ...(input ?? {}) };
}

// Strip optional fields the capture policy disallows. Structural metadata
// (contractName, attempt, durationMs, category, issues, ruleFailures, …) is
// always kept — it's the minimum Boundary needs to show a run. The three
// flags only govern the buckets that can contain user/LLM content:
// inputs, outputs, repairs.
export function applyCapture(
  event: BoundaryLogEvent,
  capture: CapturePolicy,
): BoundaryLogEvent {
  // `repairs` only exists on FailedEvent — narrow on `ok` so the type
  // system guides this rather than relying on duck-typed deletes.
  if (event.ok) {
    const out: BoundaryLogEvent = { ...event };
    if (!capture.inputs) delete out.input;
    if (!capture.outputs) delete out.output;
    return out;
  }
  const out: BoundaryLogEvent = { ...event };
  if (!capture.repairs) delete out.repairs;
  if (!capture.inputs) delete out.input;
  if (!capture.outputs) delete out.output;
  return out;
}
