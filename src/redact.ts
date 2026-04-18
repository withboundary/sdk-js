import type { BoundaryLogEvent, RedactionOptions } from "./types.js";

const REDACTED = "[REDACTED]";

// Walk an event and apply redaction rules. Runs right before any data leaves
// the process — the layers compose so callers can stack field/pattern/custom
// safely. Cycles are tolerated via a visited set; each object is entered at
// most once.
export function redact(
  event: BoundaryLogEvent,
  options: RedactionOptions | undefined,
): BoundaryLogEvent {
  if (!options) return event;

  const fields = new Set(options.fields ?? []);
  const patterns = options.patterns ?? [];
  const custom = options.custom;

  const seen = new WeakSet<object>();

  function walk(value: unknown, path: string[]): unknown {
    // Primitives: patterns first, then custom.
    if (value === null || value === undefined) return value;

    if (typeof value === "string") {
      let out = value;
      for (const pattern of patterns) {
        out = out.replace(pattern, REDACTED);
      }
      return custom ? custom(out, path) : out;
    }

    if (typeof value !== "object") {
      return custom ? custom(value, path) : value;
    }

    // Avoid infinite recursion on cyclic objects — return a placeholder so
    // the caller sees the reference but we don't blow the stack.
    if (seen.has(value as object)) return "[CYCLE]";
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((item, i) => walk(item, [...path, String(i)]));
    }

    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      if (fields.has(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = walk(src[key], [...path, key]);
    }
    return out;
  }

  return walk(event, []) as BoundaryLogEvent;
}
