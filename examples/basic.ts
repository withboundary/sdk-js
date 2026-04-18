// Minimal @withboundary/sdk example.
//
// Run with: `tsx examples/basic.ts` after installing @withboundary/contract
// and zod. Set BOUNDARY_API_KEY in the environment to ship real traces; leave
// it unset to use the `write` sink (logs events to stdout).

import { defineContract } from "@withboundary/contract";
import { z } from "zod";
import { createBoundaryLogger } from "../src/index.js";

const Schema = z.object({
  tier: z.enum(["hot", "warm", "cold"]),
  score: z.number().min(0).max(100),
  reason: z.string(),
});

const logger = createBoundaryLogger({
  apiKey: process.env.BOUNDARY_API_KEY,
  environment: "production",
  // Log to stdout in parallel so you can see what's flowing. Safe to leave
  // in place alongside apiKey — both sinks fire.
  write: (events) => {
    for (const e of events) {
      console.log(JSON.stringify(e, null, 2));
    }
  },
});

if (!logger) {
  console.error("createBoundaryLogger returned null — wire an apiKey or write");
  process.exit(1);
}

const contract = defineContract({
  name: "lead-scoring",
  schema: Schema,
  rules: [
    (d) => d.tier !== "hot" || d.score > 70 || "hot leads need score > 70",
    (d) => d.reason.length > 10 || "reason must be substantive",
  ],
  logger,
});

async function main() {
  const result = await contract.accept(async () => {
    // Stand-in for a real LLM call. Returns the JSON string your model
    // produces; in production you'd call OpenAI/Anthropic/etc here.
    return JSON.stringify({
      tier: "hot",
      score: 85,
      reason: "Fortune 500 account opened pricing page 4 times this week",
    });
  });

  if (result.ok) {
    console.log("accepted:", result.data);
  } else {
    console.error("rejected after", result.error.attempts.length, "attempts");
  }

  // Give the batcher a bounded chance to drain before exit. In long-running
  // servers the beforeExit hook handles this automatically.
  await logger.flush(2000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
