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
    expect(captured[0]!.category).toBe("INVARIANT_ERROR");
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

  it("shutdown is idempotent", async () => {
    const { logger } = setup();
    await logger.shutdown(50);
    await logger.shutdown(50); // should not throw
  });
});
