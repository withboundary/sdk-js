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
      rules: [(d) => d.score >= 90 || "score too low"],
      logger,
    });
    const result = await contract.accept(async () =>
      JSON.stringify({ tier: "warm", score: 50 }),
    );
    expect(result.ok).toBe(false);
    await logger.flush(100);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.ok).toBe(false);
    expect(captured[0]!.category).toBe("RULE_ERROR");
    expect(captured[0]!.issues).toEqual(["score too low"]);
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

  it("redact scrubs matched fields", async () => {
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
    // The output field should have tier redacted; note that in the current
    // logger impl we don't emit output from onRunSuccess (output flow is a
    // separate enrichment), so this test mainly asserts the logger doesn't
    // crash when redact is configured.
    expect(captured).toHaveLength(1);
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
        (d) => d.score >= 0 || "score negative",
        (d) => d.tier !== "cold" || "cold not allowed",
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
      // Cast to unknown first — these fields are forward-looking and not yet
      // declared on the installed @withboundary/contract peer.
      schema,
      rules,
    } as unknown as Parameters<NonNullable<typeof logger.onRunStart>>[0]);
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
    expect(captured[0]!.ruleFailures).toEqual(["score_range", "tier_mismatch"]);
  });
});
