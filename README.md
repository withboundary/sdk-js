# @withboundary/sdk

[![npm version](https://img.shields.io/npm/v/@withboundary/sdk.svg)](https://www.npmjs.com/package/@withboundary/sdk)
[![license](https://img.shields.io/npm/l/@withboundary/sdk.svg)](https://github.com/withboundary/sdk-js/blob/main/LICENSE)

See your acceptance rate, top failing rules, and repair patterns across every
contract run without building a separate observability pipeline.

`@withboundary/contract` is the local acceptance engine: it validates LLM output
in your process and never sends traffic to Boundary. `@withboundary/sdk` is the
separate telemetry layer you add when you want run history, failing rules,
repair loops, and model quality signals in Boundary Cloud or a custom sink.

## Install

```bash
npm install @withboundary/contract @withboundary/sdk zod
```

```bash
pnpm add @withboundary/contract @withboundary/sdk zod
```

## Quickstart

```ts
import { defineContract } from "@withboundary/contract";
import { createBoundaryLogger } from "@withboundary/sdk";
import { z } from "zod";

const logger = createBoundaryLogger({
  apiKey: process.env.BOUNDARY_API_KEY,
  environment: "production",
  model: "gpt-4.1-mini",
});

const LeadScore = z.object({
  tier: z.enum(["hot", "warm", "cold"]),
  score: z.number().min(0).max(100),
  reason: z.string(),
});

const contract = defineContract({
  name: "lead-scoring",
  schema: LeadScore,
  logger,
  rules: [
    {
      name: "hot_requires_high_score",
      description: "Hot leads must have a score of at least 70",
      fields: ["tier", "score"],
      check: (lead) =>
        lead.tier !== "hot" ||
        lead.score >= 70 ||
        `tier is "hot" but score is ${lead.score} (minimum 70)`,
    },
  ],
});

const result = await contract.accept(async (attempt) => {
  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: attempt.instructions },
      { role: "user", content: "Score this lead: ACME, 500 employees..." },
      ...attempt.repairs,
    ],
  });

  return response.output_text;
});
```

If neither `apiKey` nor `write` is configured, `createBoundaryLogger()` returns
`null`. Passing `null` as the contract logger is safe, so local development can
keep the same wiring without shipping telemetry.

## What Gets Sent

The SDK emits Boundary log events from contract lifecycle hooks. Every event
includes structural metadata Boundary needs to group and render a run:

```ts
type BoundaryLogEvent =
  | {
      ok: true;
      final: true;
      runId: string;
      contractName: string;
      attempt: number;
      maxAttempts: number;
      durationMs: number;
    }
  | {
      ok: false;
      final: boolean;
      runId: string;
      contractName: string;
      attempt: number;
      maxAttempts: number;
      durationMs: number;
      category: string;
      issues: string[];
      repairs?: Array<{ role: string; content: string }>;
      ruleFailures?: string[];
    };
```

Accepted events are terminal: `ok: true`, `final: true`. Failed events include
`category` and `issues`; `final: false` means the contract is retrying, and
`final: true` means the run exhausted its attempts.

When paired with `@withboundary/contract` versions that emit `runHandle`, the
SDK keys state by that per-call handle. Concurrent `accept()` calls on the same
contract instance get isolated run state. Older contract versions fall back to
the previous contract-name key so existing integrations keep working.

## Capture Policy

Conservative by default: raw prompts and completions stay off unless you opt in.

```ts
createBoundaryLogger({
  apiKey,
  capture: {
    inputs: false, // prompt/instructions sent to the model, default off
    outputs: false, // cleaned or accepted model output, default off
    repairs: true, // retry repair messages, default on
  },
});
```

Run metadata, failure categories, issue text, rule names, schema shape, and SDK
metadata are always sent because Boundary cannot render a useful run without
them. Use redaction or `beforeSend` if those fields need additional policy.

## Redaction

Redaction runs after capture and before batching.

```ts
createBoundaryLogger({
  apiKey,
  redact: {
    fields: ["email", "ssn", "apiKey"],
    patterns: [/\b\d{3}-\d{2}-\d{4}\b/],
    custom(value, path) {
      if (path.join(".") === "input.customerId") return hashCustomerId(value);
      return value;
    },
  },
});
```

The SDK also stamps the resolved capture policy and any redacted field names on
each event so the dashboard can distinguish "not captured" from "captured and
scrubbed."

## `beforeSend`

Use `beforeSend` for final policy checks, enrichment, or dropping events.

```ts
createBoundaryLogger({
  apiKey,
  beforeSend(event) {
    if (event.contractName === "local-debug") return null;

    if (!event.ok && event.category === "RULE_ERROR") {
      return { ...event, model: "policy-reviewed" };
    }

    return event;
  },
});
```

Exceptions thrown from `beforeSend` are routed to `onError` and do not break the
contract run.

## Batching And Flush

Events are queued and flushed on size or time, whichever comes first.

```ts
const logger = createBoundaryLogger({
  apiKey,
  batch: {
    size: 20,
    intervalMs: 5000,
    maxQueueSize: 1000,
  },
});

await logger?.flush(1000);
```

`flush(timeoutMs)` drains queued events and returns after the optional deadline.
`shutdown(timeoutMs)` drains, stops the timer, and disables future sends.

## Runtime Lifecycle

Node registers a `beforeExit` drain by default. It does not attach `SIGTERM` or
`SIGINT` handlers; call `shutdown()` from your own application lifecycle code.

```ts
process.once("SIGTERM", async () => {
  await logger?.shutdown(2000);
  process.exit(0);
});
```

Browser lifecycle hooks are best effort. Edge, Worker, and serverless runtimes
should call `await logger?.flush(timeoutMs)` before returning each request.

Do not bundle a Boundary API key into browser code. For client-side telemetry,
send events to your own trusted endpoint with `write`, or proxy them through
your server.

## Custom Sink

Use `write` to mirror events to a file, test harness, or another observability
system. When `apiKey` and `write` are both present, both destinations receive
every flushed batch.

```ts
const logger = createBoundaryLogger({
  write(events) {
    for (const event of events) {
      console.log(JSON.stringify(event));
    }
  },
});
```

## Transport Resilience

The built-in HTTP transport is intentionally small and predictable:

- Retries 5xx and network errors with jittered exponential backoff.
- Honors `429 Retry-After`, capped at 60 seconds.
- Opens a circuit after repeated failures to avoid retry storms.
- Disables itself on 401/403 and reports the auth failure once.
- Times out each attempt with `AbortController`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

## Links

- [Boundary](https://withboundary.com)
- [@withboundary/contract](https://github.com/withboundary/contract-js)
- [Issues](https://github.com/withboundary/sdk-js/issues)

MIT
