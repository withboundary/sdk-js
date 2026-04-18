import { DEFAULT_CAPTURE, type BoundaryLogEvent, type CapturePolicy } from "./types.js";

// Resolve a partial user-supplied capture policy against the safe defaults.
// Callers always get a fully-populated policy so downstream code doesn't
// need to defend against undefined flags.
export function resolveCapture(
  input: Partial<CapturePolicy> | undefined,
): CapturePolicy {
  return { ...DEFAULT_CAPTURE, ...(input ?? {}) };
}

// Strip fields the capture policy disallows. We model this as a separate
// pass (rather than guarding each assignment in the logger) so every event
// funnels through one place that decides what leaves the process.
//
// `capture.metadata` is treated as always-on — the base identity/run stats
// are the minimum useful payload. If even those should be hidden, don't wire
// a logger at all instead of disabling every flag.
export function applyCapture(
  event: BoundaryLogEvent,
  capture: CapturePolicy,
): BoundaryLogEvent {
  const out: BoundaryLogEvent = { ...event };
  if (!capture.errors) {
    delete out.category;
    delete out.issues;
  }
  if (!capture.repairs) {
    delete out.repairs;
  }
  if (!capture.inputs) {
    delete out.input;
  }
  if (!capture.outputs) {
    delete out.output;
  }
  return out;
}
