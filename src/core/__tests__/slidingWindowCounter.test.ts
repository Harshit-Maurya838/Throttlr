import { describe, it, expect } from "vitest";
import { SlidingWindowCounter } from "../slidingWindowCounter";

describe("SlidingWindowCounter Class", () => {
  it("should initialize with provided parameters or defaults", () => {
    const counter = new SlidingWindowCounter({ limit: 5, windowMs: 1000 });
    expect(counter.limit).toBe(5);
    expect(counter.windowMs).toBe(1000);
    expect(counter.currentWindowStart).toBe(0);
    expect(counter.currentCount).toBe(0);
    expect(counter.previousCount).toBe(0);
  });

  it("should allow requests on a fresh window up to the limit", () => {
    const counter = new SlidingWindowCounter({ limit: 3, windowMs: 1000 });
    const now = 1000;

    let res = counter.tryConsume(now);
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(2);
    expect(res.resetAt).toBe(2000);

    res = counter.tryConsume(now + 100);
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(1);

    res = counter.tryConsume(now + 200);
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(0);

    // 4th request exceeds limit
    res = counter.tryConsume(now + 300);
    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0);
  });

  it("should calculate weighted overlap correctly when rolling into next window", () => {
    const counter = new SlidingWindowCounter({ limit: 4, windowMs: 1000 });

    // First window [1000, 2000) - consume 4 requests
    const firstWindowStart = 1000;
    for (let i = 0; i < 4; i++) {
      expect(counter.tryConsume(firstWindowStart).allowed).toBe(true);
    }
    expect(counter.currentCount).toBe(4);
    expect(counter.previousCount).toBe(0);

    // Second window [2000, 3000) - check halfway through at 2500ms.
    // Overlap fraction of previous window = (1000 - 500) / 1000 = 0.5.
    // Weighted count before request = 4 * 0.5 + 0 = 2.
    // First request in second window at 2500ms should be allowed: weightedCount + 1 = 3 <= 4.
    const res1 = counter.tryConsume(2500);
    expect(res1.allowed).toBe(true);
    expect(counter.previousCount).toBe(4);
    expect(counter.currentCount).toBe(1);
    // After request: weightedCount = 4 * 0.5 + 1 = 3. remaining = floor(4 - 3) = 1.
    expect(res1.remaining).toBe(1);

    // Second request in second window at 2500ms: weightedCount before = 4 * 0.5 + 1 = 3.
    // weightedCount + 1 = 4 <= 4 -> Allowed.
    const res2 = counter.tryConsume(2500);
    expect(res2.allowed).toBe(true);
    expect(counter.currentCount).toBe(2);
    // After request: weightedCount = 4 * 0.5 + 2 = 4. remaining = floor(4 - 4) = 0.
    expect(res2.remaining).toBe(0);

    // Third request in second window at 2500ms: weightedCount before = 4.
    // weightedCount + 1 = 5 > 4 -> Denied.
    const res3 = counter.tryConsume(2500);
    expect(res3.allowed).toBe(false);
    expect(res3.remaining).toBe(0);
  });

  it("should correctly decay previous window influence to zero", () => {
    const counter = new SlidingWindowCounter({ limit: 5, windowMs: 1000 });

    // First window [1000, 2000) - consume 5 requests
    const firstWindowStart = 1000;
    for (let i = 0; i < 5; i++) {
      counter.tryConsume(firstWindowStart);
    }

    // Roll to a window far in the future [5000, 6000) at 5500ms
    // Since 5000 > 1000 + 1000, previousCount should roll to 0.
    const res = counter.tryConsume(5500);
    expect(res.allowed).toBe(true);
    expect(counter.previousCount).toBe(0);
    expect(counter.currentCount).toBe(1);
    expect(res.remaining).toBe(4);
  });

  it("should compute weighted overlap at exactly window boundary, halfway, and just before boundary", () => {
    const counter = new SlidingWindowCounter({ limit: 10, windowMs: 1000 });

    // Populate first window [1000, 2000) with 10 requests
    for (let i = 0; i < 10; i++) {
      counter.tryConsume(1000);
    }

    // Check exactly at next window boundary (now = 2000).
    // Elapse = 0, overlap fraction = 1.0.
    // Weighted count before request = 10 * 1.0 + 0 = 10.
    // Adding 1 would make 11 > 10, so it should be denied.
    const resBoundary = counter.tryConsume(2000);
    expect(resBoundary.allowed).toBe(false);

    // Let's create a new counter and try at 2999ms (just before boundary of the second window).
    const counter2 = new SlidingWindowCounter({ limit: 10, windowMs: 1000 });
    for (let i = 0; i < 10; i++) {
      counter2.tryConsume(1000);
    }

    // At 2999ms, elapsed = 999ms.
    // Overlap fraction = (1000 - 999) / 1000 = 0.001.
    // Weighted count before request = 10 * 0.001 + 0 = 0.01.
    // Request should be allowed.
    const resAlmostDecayed = counter2.tryConsume(2999);
    expect(resAlmostDecayed.allowed).toBe(true);
    expect(resAlmostDecayed.remaining).toBe(8); // limit 10 - floor(0.01 + 1) = 8
  });
});
