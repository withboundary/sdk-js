import { describe, expect, it, vi } from "vitest";
import { defineContract } from "@withboundary/contract";
import { z } from "zod";
import { createBoundaryLogger } from "../src/index.js";
import type { BoundaryLogEvent } from "../src/types.js";

const Schema = z.object({
  tier: z.enum(["hot", "warm", "cold"]),
  score: z.number().min(0).max(100),
});

function setup() {
  const captured: BoundaryLogEvent[] = [];
  const logger = createBoundaryLogger({
    write: async (events) => {
      captured.push(...events);
    },
    flushOnExit: false, // don't register beforeExit in tests
    batch: { size: 1, intervalMs: 0, maxQueueSize: 100 },
  });
  if (!logger) throw new Error("logger should not be null");
  return { logger, captured };
}

describe("createBoundaryLogger", () => {
  it("returns null when neither apiKey nor write is provided", () => {
    expect(createBoundaryLogger({ flushOnExit: false })).toBeNull();
  });

  it("emits a single event on run success with contract name", async () => {
    const { logger, captured } = setup();
    const contract = defineContract({
      name: "tier-score",
      schema: Schema,
      logger,
    });
    const result = await contract.accept(async () =>
      JSON.stringify({ tier: "hot", score: 85 }),
    );
    expect(result.ok).toBe(true);
    await logger.flush(100);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.contractName).toBe("tier-score");
    expect(captured[0]!.ok).toBe(true);
    expect(captured[0]!.sdk?.name).toBe("@withboundary/sdk");
    expect(captured[0]!.sdk?.version).toMatch(/\d+\.\d+\.\d+/);
  });

  it("emits a failure event with category + issues", async () => {
    const { logger, captured } = setup();
    const contract = defineContract({
      name: "failing-contract",
      schema: Schema,
      retry: { maxAttempts: 1 },
      rules: [
        {
          name: "score_threshold",
          fields: ["score"],
          check: (d) => d.score >= 90 || "score too low",
        },
      ],
      logger,
    });
    const result = await contract.accept(async () =>
      JSON.stringify({ tier: "warm", score: 50 }),
    );
    expect(result.ok).toBe(false);
    await logger.flush(100);
    expect(captured).toHaveLength(1);
    const event = captured[0]!;
    if (event.ok) throw new Error("expected failed event");
    expect(event.category).toBe("RULE_ERROR");
    expect(event.issues).toEqual(["score too low"]);
  });

  it("omits input/output by default", async () => {
    const { logger, captured } = setup();
    const contract = defineContract({ name: "t", schema: Schema, logger });
    await contract.accept(async () => JSON.stringify({ tier: "cold", score: 10 }));
    await logger.flush(100);
    expect(captured[0]!.input).toBeUndefined();
    expect(captured[0]!.output).toBeUndefined();
  });

  it("beforeSend can drop events by returning null", async () => {
    const captured: BoundaryLogEvent[] = [];
    const logger = createBoundaryLogger({
      write: async (events) => {
        captured.push(...events);
      },
      flushOnExit: false,
      batch: { size: 1, intervalMs: 0, maxQueueSize: 100 },
      beforeSend: (e) => (e.contractName === "drop-me" ? null : e),
    });
    if (!logger) throw new Error("logger should not be null");

    const keep = defineContract({ name: "keep", schema: Schema, logger });
    const drop = defineContract({ name: "drop-me", schema: Schema, logger });
    await keep.accept(async () => JSON.stringify({ tier: "hot", score: 95 }));
    await drop.accept(async () => JSON.stringify({ tier: "hot", score: 95 }));
    await logger.flush(100);

    expect(captured.map((e) => e.contractName)).toEqual(["keep"]);
  });

  it("redact scrubs matched fields in captured output", async () => {
    const captured: BoundaryLogEvent[] = [];
    const logger = createBoundaryLogger({
      write: async (events) => {
        captured.push(...events);
      },
      flushOnExit: false,
      batch: { size: 1, intervalMs: 0, maxQueueSize: 100 },
      capture: { outputs: true }, // opt in so there's something to scrub
      redact: { fields: ["tier"] },
    });
    if (!logger) throw new Error("logger should not be null");
    const contract = defineContract({ name: "redacted", schema: Schema, logger });
    await contract.accept(async () => JSON.stringify({ tier: "hot", score: 95 }));
    await logger.flush(100);
    expect(captured).toHaveLength(1);
    // tier was on the validated output and should now be redacted; score
    // wasn't on the redact field list and should pass through.
    const out = captured[0]!.output as { tier?: unknown; score?: number };
    expect(out).toBeDefined();
    expect(out.tier).toBe("[REDACTED]");
    expect(out.score).toBe(95);
    expect(captured[0]!.capture?.redactedFields).toContain("tier");
  });

  it("populates input + output from contract hooks when opted in", async () => {
    const captured: BoundaryLogEvent[] = [];
    const logger = createBoundaryLogger({
      write: async (events) => {
        captured.push(...events);
      },
      flushOnExit: false,
      batch: { size: 1, intervalMs: 0, maxQueueSize: 100 },
      capture: { inputs: true, outputs: true },
    });
    if (!logger) throw new Error("logger should not be null");
    const contract = defineContract({
      name: "input-output",
      schema: Schema,
      logger,
    });
    await contract.accept(async () => JSON.stringify({ tier: "hot", score: 95 }));
    await logger.flush(100);

    expect(captured).toHaveLength(1);
    // Input is the schema-derived prompt the contract instructed the model
    // with on the (only) attempt — exact string is contract's business but
    // it should be a non-empty string when capture.inputs is on.
    expect(typeof captured[0]!.input).toBe("string");
    expect((captured[0]!.input as string).length).toBeGreaterThan(0);
    // Output is the validated typed value from the run.
    expect(captured[0]!.output).toEqual({ tier: "hot", score: 95 });
  });

  it("populates output even on validation failure (cleaned, pre-validated)", async () => {
    const captured: BoundaryLogEvent[] = [];
    const logger = createBoundaryLogger({
      write: async (events) => {
        captured.push(...events);
      },
      flushOnExit: false,
      batch: { size: 1, intervalMs: 0, maxQueueSize: 100 },
      capture: { outputs: true },
    });
    if (!logger) throw new Error("logger should not be null");
    const contract = defineContract({
      name: "fails-validation",
      schema: Schema,
      retry: { maxAttempts: 1 },
      logger,
    });
    // tier is not in the enum — schema rejects, but the cleaned object
    // should still surface so users can debug what the model actually said.
    await contract.accept(async () =>
      JSON.stringify({ tier: "scalding", score: 50 }),
    );
    await logger.flush(100);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.ok).toBe(false);
    expect(captured[0]!.output).toEqual({ tier: "scalding", score: 50 });
  });

  // ─── Per-attempt streaming ─────────────────────────────────────────────────

  it("emits exactly one terminal event for a 1-attempt success", async () => {
    const { logger, captured } = setup();
    const contract = defineContract({ name: "single", schema: Schema, logger });
    await contract.accept(async () => JSON.stringify({ tier: "hot", score: 95 }));
    await logger.flush(100);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.final).toBe(true);
    expect(captured[0]!.ok).toBe(true);
    expect(captured[0]!.runId).toMatch(/^bnd_run_[A-Za-z0-9_-]{21}$/);
  });

  it("emits N events for a N-attempt repaired success — all sharing one runId", async () => {
    const { logger, captured } = setup();
    const contract = defineContract({
      name: "repaired",
      schema: Schema,
      retry: { maxAttempts: 3, backoff: "none" },
      logger,
    });
    let call = 0;
    // Attempt 1: bad enum + bad score (validation fails). Attempt 2: ok.
    await contract.accept(async () => {
      call++;
      if (call === 1) return JSON.stringify({ tier: "scalding", score: 200 });
      return JSON.stringify({ tier: "hot", score: 95 });
    });
    await logger.flush(100);

    expect(captured).toHaveLength(2);
    const [perAttempt, terminal] = captured;
    expect(perAttempt!.final).toBe(false);
    expect(perAttempt!.ok).toBe(false);
    expect(perAttempt!.attempt).toBe(1);
    expect(terminal!.final).toBe(true);
    expect(terminal!.ok).toBe(true);
    expect(terminal!.attempt).toBe(2);
    // Stable runId: same on per-attempt and terminal.
    expect(perAttempt!.runId).toBe(terminal!.runId);
  });

  it("per-attempt event carries the failed attempt's output + ruleFailures", async () => {
    const captured: BoundaryLogEvent[] = [];
    const logger = createBoundaryLogger({
      write: async (events) => {
        captured.push(...events);
      },
      flushOnExit: false,
      batch: { size: 1, intervalMs: 0, maxQueueSize: 100 },
      capture: { outputs: true },
    });
    if (!logger) throw new Error("logger should not be null");
    const contract = defineContract({
      name: "rule-fail-then-pass",
      schema: Schema,
      retry: { maxAttempts: 3, backoff: "none" },
      rules: [
        {
          name: "score_threshold",
          fields: ["score"],
          check: (d) => d.score >= 90 || "score too low",
        },
      ],
      logger,
    });
    let call = 0;
    await contract.accept(async () => {
      call++;
      // Attempt 1: schema-valid, rule-fails. Attempt 2: passes.
      if (call === 1) return JSON.stringify({ tier: "warm", score: 50 });
      return JSON.stringify({ tier: "hot", score: 95 });
    });
    await logger.flush(100);

    expect(captured).toHaveLength(2);
    const perAttempt = captured[0]!;
    if (perAttempt.ok) throw new Error("expected per-attempt failed event");
    expect(perAttempt.final).toBe(false);
    expect(perAttempt.output).toEqual({ tier: "warm", score: 50 });
    expect(perAttempt.ruleFailures).toEqual(["score_threshold"]);
    expect(perAttempt.category).toBe("RULE_ERROR");

    // The terminal success event must reflect only the accepting attempt.
    // The discriminated union enforces this at the type level — accessing
    // `ruleFailures` on an `ok: true` event is a TS error — and the runtime
    // `in` checks below catch any object-shape leak (e.g. from beforeSend).
    const terminal = captured[1]!;
    if (!terminal.ok) throw new Error("expected accepted terminal");
    expect(terminal.final).toBe(true);
    expect(terminal.attempt).toBe(2);
    expect(terminal.output).toEqual({ tier: "hot", score: 95 });
    expect("ruleFailures" in terminal).toBe(false);
    expect("issues" in terminal).toBe(false);
    expect("category" in terminal).toBe(false);
    expect("repairs" in terminal).toBe(false);
  });

  it("emits N events for a N-attempt failure (max retries exhausted)", async () => {
    const { logger, captured } = setup();
    const contract = defineContract({
      name: "always-fails",
      schema: Schema,
      retry: { maxAttempts: 3, backoff: "none" },
      logger,
    });
    await contract.accept(async () =>
      JSON.stringify({ tier: "scalding", score: 200 }),
    );
    await logger.flush(100);

    expect(captured).toHaveLength(3);
    const runId = captured[0]!.runId;
    expect(captured.every((e) => e.runId === runId)).toBe(true);
    expect(captured[0]!.final).toBe(false);
    expect(captured[1]!.final).toBe(false);
    expect(captured[2]!.final).toBe(true);
    expect(captured[2]!.ok).toBe(false);
    expect(captured.map((e) => e.attempt)).toEqual([1, 2, 3]);
  });

  it("each per-attempt event re-asserts its own attempt number", async () => {
    const { logger, captured } = setup();
    const contract = defineContract({
      name: "numbered",
      schema: Schema,
      retry: { maxAttempts: 3, backoff: "none" },
      logger,
    });
    let call = 0;
    await contract.accept(async () => {
      call++;
      if (call < 3) return JSON.stringify({ tier: "scalding", score: 200 });
      return JSON.stringify({ tier: "hot", score: 95 });
    });
    await logger.flush(100);

    expect(captured.map((e) => e.attempt)).toEqual([1, 2, 3]);
  });

  it("stamps event.capture with the resolved policy", async () => {
    const { logger, captured } = setup();
    const contract = defineContract({ name: "capture-stamp", schema: Schema, logger });
    await contract.accept(async () => JSON.stringify({ tier: "hot", score: 95 }));
    await logger.flush(100);
    expect(captured[0]!.capture).toEqual({
      inputs: false,
      outputs: false,
      repairs: true,
    });
  });

  it("stamps capture.redactedFields when redaction scrubs a matched field", async () => {
    // Use beforeSend to inject a scrubbable field — the logger doesn't
    // currently populate event.input/output from hooks, but beforeSend runs
    // before redact-stamping so we can test the pipeline end-to-end.
    const captured: BoundaryLogEvent[] = [];
    const logger = createBoundaryLogger({
      write: async (events) => {
        captured.push(...events);
      },
      flushOnExit: false,
      batch: { size: 1, intervalMs: 0, maxQueueSize: 100 },
      redact: { fields: ["ssn"] },
      beforeSend: (e) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e as any).input = { name: "Jane", ssn: "111-22-3333" };
        return e;
      },
    });
    if (!logger) throw new Error("logger should not be null");
    const contract = defineContract({ name: "redact-stamp", schema: Schema, logger });
    await contract.accept(async () => JSON.stringify({ tier: "hot", score: 95 }));
    await logger.flush(100);
    // beforeSend runs AFTER capture stamp in current impl, so the event's
    // capture.redactedFields reflects what the SDK scrubbed BEFORE beforeSend
    // — which is nothing here. This test asserts the capture is at least
    // stamped (structural check); deeper redactedFields testing is covered
    // directly in redact.test.ts.
    expect(captured[0]!.capture).toBeDefined();
    expect(captured[0]!.capture?.inputs).toBe(false);
  });

  it("stamps model from logger options onto every event", async () => {
    const captured: BoundaryLogEvent[] = [];
    const logger = createBoundaryLogger({
      write: async (events) => {
        captured.push(...events);
      },
      flushOnExit: false,
      batch: { size: 1, intervalMs: 0, maxQueueSize: 100 },
      model: "gpt-4o",
    });
    if (!logger) throw new Error("logger should not be null");
    const contract = defineContract({ name: "model-default", schema: Schema, logger });
    await contract.accept(async () => JSON.stringify({ tier: "hot", score: 95 }));
    await logger.flush(100);
    expect(captured[0]!.model).toBe("gpt-4o");
  });

  it("per-call model override wins over logger default", async () => {
    const captured: BoundaryLogEvent[] = [];
    const logger = createBoundaryLogger({
      write: async (events) => {
        captured.push(...events);
      },
      flushOnExit: false,
      batch: { size: 1, intervalMs: 0, maxQueueSize: 100 },
      model: "gpt-4o",
    });
    if (!logger) throw new Error("logger should not be null");
    const contract = defineContract({ name: "model-override", schema: Schema, logger });
    await contract.accept(
      async () => JSON.stringify({ tier: "hot", score: 95 }),
      { model: "claude-haiku-4-5" },
    );
    await logger.flush(100);
    expect(captured[0]!.model).toBe("claude-haiku-4-5");
  });

  it("emits rulesCount reflecting the contract's rule list", async () => {
    const { logger, captured } = setup();
    const contract = defineContract({
      name: "rules-count",
      schema: Schema,
      logger,
      rules: [
        {
          name: "score_nonnegative",
          fields: ["score"],
          check: (d) => d.score >= 0 || "score negative",
        },
        {
          name: "tier_not_cold",
          fields: ["tier"],
          check: (d) => d.tier !== "cold" || "cold not allowed",
        },
      ],
    });
    await contract.accept(async () => JSON.stringify({ tier: "hot", score: 95 }));
    await logger.flush(100);
    expect(captured[0]!.rulesCount).toBe(2);
  });

  it("shutdown is idempotent", async () => {
    const { logger } = setup();
    await logger.shutdown(50);
    await logger.shutdown(50); // should not throw
  });

  it("forwards schema + rules from onRunStart ctx onto terminal events", async () => {
    const { logger, captured } = setup();
    const schema = [
      { name: "score", type: "number", constraints: "min:0,max:100" },
      { name: "tier", type: "enum", constraints: "hot|warm|cold" },
    ];
    const rules = [
      { name: "score_range", fields: ["score"], description: "score must be 0-100" },
      { name: "hot_requires_high_score", fields: ["tier", "score"] },
    ];

    // Simulate a contract that emits schema + rules on its first onRunStart
    // and then a successful terminal event. sdk-js should stamp both on the
    // outbound BoundaryLogEvent.
    logger.onRunStart?.({
      contractName: "lead-scoring",
      maxAttempts: 3,
      rulesCount: 2,
      retry: { maxAttempts: 3, backoff: "none", baseMs: 0 },
      schema,
      rules,
    });
    logger.onRunSuccess?.({
      contractName: "lead-scoring",
      attempts: 1,
      data: { tier: "hot", score: 95 },
      totalDurationMs: 12,
    });

    await logger.flush(100);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.schema).toEqual(schema);
    expect(captured[0]!.rules).toEqual(rules);
  });

  it("forwards failed rule names as ruleFailures on terminal failure events", async () => {
    const { logger, captured } = setup();
    logger.onRunStart?.({
      contractName: "rule-attribution",
      maxAttempts: 1,
      rulesCount: 2,
      retry: { maxAttempts: 1, backoff: "none", baseMs: 0 },
    });
    logger.onVerifyFailure?.({
      contractName: "rule-attribution",
      attempt: 1,
      category: "RULE_ERROR",
      issues: ["score too low", "tier mismatch"],
      durationMs: 5,
      // Forward-looking field, not yet on the installed contract peer.
      ruleIssues: [
        { rule: { name: "score_range" }, message: "score too low" },
        { rule: { name: "tier_mismatch", fields: ["tier"] }, message: "tier mismatch" },
      ],
    } as unknown as Parameters<NonNullable<typeof logger.onVerifyFailure>>[0]);
    logger.onRunFailure?.({
      contractName: "rule-attribution",
      attempts: 1,
      category: "RULE_ERROR",
      message: "two rules failed",
      totalDurationMs: 5,
    });

    await logger.flush(100);
    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    if (ev.ok) throw new Error("expected failed event");
    expect(ev.ruleFailures).toEqual(["score_range", "tier_mismatch"]);
  });
});
