import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";
import type { BoundaryLogEvent } from "../src/types.js";

const REDACTED = "[REDACTED]";

function baseEvent(overrides: Partial<BoundaryLogEvent> = {}): BoundaryLogEvent {
  return {
    contractName: "t",
    timestamp: "2026-04-18T00:00:00Z",
    attempt: 1,
    maxAttempts: 3,
    ok: true,
    durationMs: 5,
    ...overrides,
  };
}

describe("redact", () => {
  it("returns input unchanged when no options", () => {
    const e = baseEvent({ input: { email: "a@b.co" } });
    expect(redact(e, undefined)).toBe(e);
  });

  it("scrubs named fields deeply", () => {
    const e = baseEvent({
      input: { user: { email: "a@b.co", id: 42, nested: { ssn: "111-22-3333" } } },
      output: { email: "c@d.co" },
    });
    const out = redact(e, { fields: ["email", "ssn"] });
    expect((out.input as { user: { email: unknown } }).user.email).toBe(REDACTED);
    expect(
      (out.input as { user: { nested: { ssn: unknown } } }).user.nested.ssn,
    ).toBe(REDACTED);
    expect((out.output as { email: unknown }).email).toBe(REDACTED);
  });

  it("applies regex patterns to string values", () => {
    const e = baseEvent({
      output: "SSN is 111-22-3333 and again 111-22-3333 end",
    });
    const out = redact(e, { patterns: [/\b\d{3}-\d{2}-\d{4}\b/g] });
    expect(out.output).toBe(`SSN is ${REDACTED} and again ${REDACTED} end`);
  });

  it("invokes custom redactor with path", () => {
    const calls: { value: unknown; path: string[] }[] = [];
    const e = baseEvent({ input: { a: 1, b: { c: 2 } } });
    redact(e, {
      custom: (value, path) => {
        calls.push({ value, path });
        return value;
      },
    });
    // Leaves include contractName, timestamp, attempt, ..., input.a, input.b.c, etc.
    const inputPaths = calls.filter((c) => c.path[0] === "input").map((c) => c.path.join("."));
    expect(inputPaths).toContain("input.a");
    expect(inputPaths).toContain("input.b.c");
  });

  it("tolerates cyclic references", () => {
    type Cyclic = { self?: Cyclic };
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    const e = baseEvent({ input: cyclic });
    expect(() => redact(e, { fields: ["self"] })).not.toThrow();
  });
});
