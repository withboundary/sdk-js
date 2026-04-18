import { describe, expect, it } from "vitest";
import { EventQueue } from "../src/queue.js";
import type { BoundaryLogEvent } from "../src/types.js";

function ev(n: number): BoundaryLogEvent {
  return {
    contractName: "t",
    timestamp: new Date(n).toISOString(),
    attempt: 1,
    maxAttempts: 3,
    ok: true,
    durationMs: n,
  };
}

describe("EventQueue", () => {
  it("drains FIFO", () => {
    const q = new EventQueue(100);
    q.push(ev(1));
    q.push(ev(2));
    q.push(ev(3));
    expect(q.length).toBe(3);
    const out = q.drain(10);
    expect(out.map((e) => e.durationMs)).toEqual([1, 2, 3]);
    expect(q.length).toBe(0);
  });

  it("caps via drop-oldest", () => {
    const q = new EventQueue(3);
    q.push(ev(1));
    q.push(ev(2));
    q.push(ev(3));
    q.push(ev(4));
    q.push(ev(5));
    expect(q.length).toBe(3);
    expect(q.takeDropped()).toBe(2);
    expect(q.takeDropped()).toBe(0); // reset after read
    const out = q.drain(10);
    expect(out.map((e) => e.durationMs)).toEqual([3, 4, 5]);
  });

  it("drains a partial chunk and leaves the rest", () => {
    const q = new EventQueue(10);
    for (let i = 1; i <= 5; i++) q.push(ev(i));
    const first = q.drain(2);
    expect(first.map((e) => e.durationMs)).toEqual([1, 2]);
    expect(q.length).toBe(3);
    const rest = q.drain(10);
    expect(rest.map((e) => e.durationMs)).toEqual([3, 4, 5]);
  });

  it("clear resets length and drop counter", () => {
    const q = new EventQueue(2);
    q.push(ev(1));
    q.push(ev(2));
    q.push(ev(3)); // drops 1
    q.clear();
    expect(q.length).toBe(0);
    expect(q.takeDropped()).toBe(0);
  });
});
