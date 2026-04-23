import type { BoundaryLogEvent, RedactionOptions } from "./types.js";

const REDACTED = "[REDACTED]";

export interface RedactResult {
  event: BoundaryLogEvent;
  // Leaf field names that were scrubbed on this event (deduped). The dashboard
  // uses this to render "[REDACTED]" rows authoritatively. Empty list when no
  // redaction was configured or nothing matched.
  redactedFields: string[];
}

// Walk an event and apply redaction rules. Runs right before any data leaves
// the process — the layers compose so callers can stack field/pattern/custom
// safely. Cycles are tolerated via a visited set; each object is entered at
// most once.
export function redact(
  event: BoundaryLogEvent,
  options: RedactionOptions | undefined,
): RedactResult {
  if (!options) return { event, redactedFields: [] };

  const fields = new Set(options.fields ?? []);
  const patterns = options.patterns ?? [];
  const custom = options.custom;

  const seen = new WeakSet<object>();
  const scrubbed = new Set<string>();

  function walk(value: unknown, path: string[]): unknown {
    if (value === null || value === undefined) return value;

    if (typeof value === "string") {
      let out = value;
      for (const pattern of patterns) {
        const replaced = out.replace(pattern, REDACTED);
        if (replaced !== out && path.length > 0) scrubbed.add(path[path.length - 1]!);
        out = replaced;
      }
      return custom ? custom(out, path) : out;
    }

    if (typeof value !== "object") {
      return custom ? custom(value, path) : value;
    }

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
        scrubbed.add(key);
        continue;
      }
      out[key] = walk(src[key], [...path, key]);
    }
    return out;
  }

  const redactedEvent = walk(event, []) as BoundaryLogEvent;
  return { event: redactedEvent, redactedFields: [...scrubbed].sort() };
}
