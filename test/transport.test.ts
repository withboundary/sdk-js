import { describe, expect, it, vi } from "vitest";
import { HttpTransport } from "../src/transport/http.js";
import { AuthError } from "../src/transport/types.js";
import { CircuitBreakerTransport, BreakerOpenError } from "../src/transport/breaker.js";
import type { Transport } from "../src/transport/types.js";
import type { BoundaryLogEvent } from "../src/types.js";

function ev(n = 1): BoundaryLogEvent {
  return {
    contractName: "t",
    timestamp: new Date().toISOString(),
    runId: `bnd_run_${n.toString().padStart(21, "0")}`,
    final: true,
    attempt: 1,
    maxAttempts: 3,
    ok: true,
    durationMs: n,
  };
}

function mockResponse(status: number, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: async () => "",
  } as unknown as Response;
}

describe("HttpTransport", () => {
  it("sends a single POST on 2xx and stops", async () => {
    const fetchMock = vi.fn(async () => mockResponse(202));
    const t = new HttpTransport({
      endpoint: "https://api.example.com",
      apiKey: "bnd_test",
      maxAttempts: 3,
      backoffBaseMs: 1,
      jitter: false,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await t.send([ev()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Asserts on headers we stamp.
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = (call[1].headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer bnd_test");
    expect(headers["User-Agent"]).toMatch(/@withboundary\/sdk\/\d/);
  });

  it("retries on 5xx with exponential backoff", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call < 3) return mockResponse(500);
      return mockResponse(202);
    });
    const t = new HttpTransport({
      endpoint: "https://api.example.com",
      apiKey: "bnd_test",
      maxAttempts: 5,
      backoffBaseMs: 1,
      jitter: false,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await t.send([ev()]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws AuthError on 401 without retrying", async () => {
    const fetchMock = vi.fn(async () => mockResponse(401));
    const t = new HttpTransport({
      endpoint: "https://api.example.com",
      apiKey: "bnd_bad",
      maxAttempts: 5,
      backoffBaseMs: 1,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(t.send([ev()])).rejects.toBeInstanceOf(AuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops non-retryable 4xx (e.g. 400)", async () => {
    const fetchMock = vi.fn(async () => mockResponse(400));
    const t = new HttpTransport({
      endpoint: "https://api.example.com",
      apiKey: "bnd_test",
      maxAttempts: 5,
      backoffBaseMs: 1,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(t.send([ev()])).rejects.toThrow(/non-retryable/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After (seconds) on 429", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) return mockResponse(429, { "retry-after": "0.02" });
      return mockResponse(202);
    });
    const t = new HttpTransport({
      endpoint: "https://api.example.com",
      apiKey: "bnd_test",
      maxAttempts: 3,
      backoffBaseMs: 500, // big to prove we used Retry-After instead
      jitter: false,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const started = Date.now();
    await t.send([ev()]);
    const elapsed = Date.now() - started;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Should wait ~20ms (Retry-After), not 500ms.
    expect(elapsed).toBeLessThan(300);
  });
});

describe("CircuitBreakerTransport", () => {
  class Flaky implements Transport {
    failures = 0;
    async send(): Promise<void> {
      this.failures++;
      throw new Error("down");
    }
  }

  it("closes → open after threshold failures", async () => {
    const inner = new Flaky();
    const b = new CircuitBreakerTransport(inner, { threshold: 3, cooldownMs: 10_000 });
    for (let i = 0; i < 3; i++) {
      await expect(b.send([ev()])).rejects.toThrow();
    }
    // 4th call should short-circuit without touching inner.
    await expect(b.send([ev()])).rejects.toBeInstanceOf(BreakerOpenError);
    expect(inner.failures).toBe(3);
  });

  it("moves open → half-open after cooldown and recovers on success", async () => {
    let mode: "fail" | "ok" = "fail";
    const inner: Transport = {
      async send() {
        if (mode === "fail") throw new Error("down");
      },
    };
    const b = new CircuitBreakerTransport(inner, { threshold: 2, cooldownMs: 20 });
    await expect(b.send([ev()])).rejects.toThrow();
    await expect(b.send([ev()])).rejects.toThrow();
    expect(b.currentState).toBe("open");
    await new Promise((r) => setTimeout(r, 30));
    mode = "ok";
    await b.send([ev()]); // probe succeeds
    expect(b.currentState).toBe("closed");
  });

  it("AuthError from inner does not count against breaker", async () => {
    const inner: Transport = {
      async send() {
        throw new AuthError();
      },
    };
    const b = new CircuitBreakerTransport(inner, { threshold: 2, cooldownMs: 10_000 });
    await expect(b.send([ev()])).rejects.toBeInstanceOf(AuthError);
    await expect(b.send([ev()])).rejects.toBeInstanceOf(AuthError);
    expect(b.currentState).toBe("closed");
  });
});
