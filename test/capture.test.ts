import { describe, expect, it } from "vitest";
import { applyCapture, resolveCapture } from "../src/capture.js";
import { DEFAULT_CAPTURE, type BoundaryLogEvent, type FailedEvent } from "../src/types.js";

function ev(overrides: Partial<FailedEvent> = {}): BoundaryLogEvent {
  return {
    contractName: "t",
    timestamp: "2026-04-18T00:00:00Z",
    runId: "bnd_run_FiReTjAHAfr4ihQEGG2Ys",
    ok: false,
    final: true,
    attempt: 1,
    maxAttempts: 3,
    durationMs: 5,
    category: "VALIDATION_ERROR",
    issues: ["bad value"],
    repairs: [{ role: "user", content: "try again" }],
    input: { prompt: "hello" },
    output: { answer: "world" },
    ...overrides,
  };
}

describe("resolveCapture", () => {
  it("fills with conservative defaults when nothing passed", () => {
    expect(resolveCapture(undefined)).toEqual(DEFAULT_CAPTURE);
  });

  it("overlays user flags on top of defaults", () => {
    const policy = resolveCapture({ inputs: true });
    expect(policy.inputs).toBe(true);
    expect(policy.outputs).toBe(false);
    expect(policy.repairs).toBe(true);
  });
});

describe("applyCapture", () => {
  it("keeps structural metadata and failure attribution unconditionally", () => {
    const out = applyCapture(
      ev(),
      resolveCapture({ inputs: false, outputs: false, repairs: false }),
    );
    expect(out.contractName).toBe("t");
    expect(out.attempt).toBe(1);
    expect(out.durationMs).toBe(5);
    if (out.ok) throw new Error("expected failed event");
    expect(out.category).toBe("VALIDATION_ERROR");
    expect(out.issues).toEqual(["bad value"]);
  });

  it("drops input/output by default", () => {
    const out = applyCapture(ev(), resolveCapture(undefined));
    expect(out.input).toBeUndefined();
    expect(out.output).toBeUndefined();
  });

  it("keeps input/output when opted in", () => {
    const out = applyCapture(ev(), resolveCapture({ inputs: true, outputs: true }));
    expect(out.input).toEqual({ prompt: "hello" });
    expect(out.output).toEqual({ answer: "world" });
  });

  it("drops repairs when capture.repairs = false", () => {
    const out = applyCapture(ev(), resolveCapture({ repairs: false }));
    if (out.ok) throw new Error("expected failed event");
    expect(out.repairs).toBeUndefined();
  });
});
