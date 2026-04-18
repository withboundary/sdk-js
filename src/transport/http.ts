import type { BoundaryLogEvent } from "../types.js";
import { SDK_NAME, SDK_VERSION } from "../version.js";
import { AuthError, type Transport } from "./types.js";

export interface HttpTransportOptions {
  endpoint: string;
  apiKey: string;
  // Per-attempt timeout. Cancels via AbortController.
  timeoutMs?: number;
  // Number of total attempts (including the first). Default 3.
  maxAttempts?: number;
  // Base delay for exponential backoff (ms). Default 100 → 100, 400, 1600.
  backoffBaseMs?: number;
  // Up to 50% random jitter applied to each backoff.
  jitter?: boolean;
  // Injected fetch for tests.
  fetch?: typeof fetch;
}

// HTTP transport with retry + timeout + auth-error shortcut + rate-limit
// back-pressure.
//
// Retry policy: exponential backoff (baseMs, 4×baseMs, 16×baseMs …) with up
// to 50% jitter. 5xx and network errors retry; 2xx returns; 401/403 throws
// AuthError immediately (no point retrying a bad key); 429 honors the
// `Retry-After` header (seconds or HTTP date) before the next attempt;
// other 4xx throw and the caller drops the batch.
//
// Keep-alive: native fetch in Node 18+ and every runtime we target reuses
// TCP connections automatically — no Agent configuration needed.
export class HttpTransport implements Transport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly jitter: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(opts: HttpTransportOptions) {
    this.endpoint = opts.endpoint.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 100;
    this.jitter = opts.jitter ?? true;
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) {
      throw new Error(
        "@withboundary/sdk: no fetch implementation available. Upgrade to Node 18+ or pass `fetch` via options.",
      );
    }
    this.fetchImpl = f;
    this.userAgent = buildUserAgent();
  }

  async send(events: BoundaryLogEvent[]): Promise<void> {
    if (events.length === 0) return;

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.once(events);
        return;
      } catch (err) {
        lastError = err;
        if (err instanceof AuthError) throw err;
        if (err instanceof NonRetryableStatusError) throw err;
        if (attempt >= this.maxAttempts) break;

        // 429 overrides our default backoff with whatever the server told us.
        // Cap at 60s so a bad header can't stall us forever.
        const delay =
          err instanceof RateLimitError && err.retryAfterMs !== null
            ? Math.min(err.retryAfterMs, 60_000)
            : this.computeDelay(attempt);
        await sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async once(events: BoundaryLogEvent[]): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.endpoint}/v1/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": this.userAgent,
        },
        body: JSON.stringify(events),
        signal: controller.signal,
      });

      if (res.status === 401 || res.status === 403) {
        throw new AuthError();
      }
      if (res.status === 429) {
        throw new RateLimitError(parseRetryAfter(res.headers.get("retry-after")));
      }
      if (res.status >= 400 && res.status < 500) {
        throw new NonRetryableStatusError(res.status);
      }
      if (!res.ok) {
        throw new Error(`Ingest returned ${res.status}`);
      }
      // Drain the body so the socket can be returned to the pool.
      await res.text().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  private computeDelay(attempt: number): number {
    // attempt is 1-indexed; first retry sits at attempt=2.
    const base = this.backoffBaseMs * Math.pow(4, attempt - 1);
    if (!this.jitter) return base;
    return base + Math.random() * base * 0.5;
  }
}

// Retry-After is either an integer seconds or an HTTP-date. Returns ms, or
// null when the header is missing/unparseable (caller falls back to its
// default backoff).
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return null;
}

function buildUserAgent(): string {
  const runtime = detectRuntime();
  return runtime
    ? `${SDK_NAME}/${SDK_VERSION} ${runtime}`
    : `${SDK_NAME}/${SDK_VERSION}`;
}

function detectRuntime(): string {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (proc?.versions?.node) return `node/${proc.versions.node}`;
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  if (nav?.userAgent) return `browser`;
  return "";
}

class RateLimitError extends Error {
  readonly status = 429;
  constructor(public readonly retryAfterMs: number | null) {
    super(`Ingest returned 429 (rate limited)`);
    this.name = "RateLimitError";
  }
}

class NonRetryableStatusError extends Error {
  constructor(public readonly status: number) {
    super(`Ingest returned non-retryable status ${status}`);
    this.name = "NonRetryableStatusError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
