# @withboundary/sdk

Observability SDK for [Boundary](https://withboundary.com) — ships LLM contract runs to the Boundary cloud dashboard with batching, retries, and redaction.

Pairs with [`@withboundary/contract`](https://github.com/withboundary/contract-js) — the correctness engine.

## Install

```bash
npm install @withboundary/contract @withboundary/sdk
```

## Quick start

```ts
import { defineContract } from "@withboundary/contract";
import { createBoundaryLogger } from "@withboundary/sdk";
import { z } from "zod";

const logger = createBoundaryLogger({
  apiKey: process.env.BOUNDARY_API_KEY,  // falls back to this env var
  environment: "production",
});

const Schema = z.object({
  tier: z.enum(["hot", "warm", "cold"]),
  score: z.number().min(0).max(100),
});

const contract = defineContract({
  name: "lead-scoring",  // appears in every trace event
  schema: Schema,
  rules: [(d) => d.tier !== "hot" || d.score > 70],
  logger,
});

const result = await contract.accept(async () => callYourLLM());
```

Missing `apiKey` + no custom `write`? The logger returns `null` and the contract runs with no observability — safe for dev.

## Capture policy

Conservative by default: raw LLM input/output stays off. Only metadata, repair messages, and failure details leave the process.

```ts
createBoundaryLogger({
  apiKey,
  capture: {
    inputs: false,    // raw prompts (default: off)
    outputs: false,   // raw completions (default: off)
    repairs: true,    // repair instructions (default: on)
    errors: true,     // category + issues (default: on)
    metadata: true,   // name, attempts, duration (default: on)
  },
});
```

## Redaction

Three composable layers, applied before any event leaves the process:

```ts
createBoundaryLogger({
  apiKey,
  redact: {
    fields: ["ssn", "email"],                        // exact key names
    patterns: [/\b\d{3}-\d{2}-\d{4}\b/],              // regex over strings
    custom: (value, path) => scrub(value, path),     // last chance
  },
});
```

## `beforeSend`

Last-chance hook after capture + redaction. Return `null` to drop:

```ts
createBoundaryLogger({
  apiKey,
  beforeSend(event) {
    if (event.contractName === "internal-debug") return null;
    return { ...event, input: hash(event.input) };
  },
});
```

## Batching

Events are queued and flushed on size or time, whichever comes first. Concurrent flushes coalesce into one network round-trip.

```ts
createBoundaryLogger({
  apiKey,
  batch: {
    size: 20,           // flush when queue hits this
    intervalMs: 5000,   // and/or every 5s
    maxQueueSize: 1000, // drop-oldest when exceeded
  },
});
```

## Shutdown

The SDK registers a Node `beforeExit` handler by default. **It does not attach to `SIGTERM` / `SIGINT`** — those belong to your app's lifecycle handlers so they don't race or delay Ctrl+C.

For graceful shutdown in your own signal handler or serverless runtime:

```ts
process.once("SIGTERM", async () => {
  await logger.shutdown(2000);  // flush with a 2s cap
  process.exit(0);
});
```

Serverless / Edge / Workers have no reliable lifecycle hook. Call `await logger.flush(timeoutMs)` at the end of each request:

```ts
export default {
  async fetch(request, env) {
    const result = await handle(request);
    await logger.flush(1000);
    return result;
  },
};
```

## Custom sink

Send to a non-Boundary destination (local log, other observability tool) via `write`:

```ts
createBoundaryLogger({
  write(events) {
    for (const e of events) console.log(JSON.stringify(e));
  },
});
```

You can combine `apiKey` + `write` — both fire on every flush.

## Resilience

Built in, intentionally simple:

- **Retry w/ jitter** — 3 attempts, exponential backoff (100ms, 400ms, 1600ms +/- 50% jitter) on 5xx / network errors.
- **`429 + Retry-After`** — honored when the backend rate-limits, capped at 60s per wait.
- **Circuit breaker** — 5 consecutive failures → open for 30s, then one probe, then closed or reopened. Stops retry storms during backend outages.
- **Auth failures (401/403)** — logged once, logger disabled. No retry.
- **Timeout per attempt** — 10s via `AbortController`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## License

[MIT](./LICENSE)
