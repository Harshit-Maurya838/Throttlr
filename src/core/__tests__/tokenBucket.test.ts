import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../tokenBucket';

describe('TokenBucket Class', () => {
  it('should initialize with initial tokens at capacity by default', () => {
    const bucket = new TokenBucket({ capacity: 5, refillRatePerSecond: 1 });
    expect(bucket.capacity).toBe(5);
    expect(bucket.refillRatePerSecond).toBe(1);
    expect(bucket.tokens).toBe(5);
  });

  it('should allow initial tokens parameter override', () => {
    const bucket = new TokenBucket({ capacity: 5, refillRatePerSecond: 1, initialTokens: 3 });
    expect(bucket.tokens).toBe(3);
  });

  it('should allow a request on a fresh bucket (at capacity)', () => {
    const bucket = new TokenBucket({ capacity: 10, refillRatePerSecond: 2 });
    const now = 1000000;
    
    const result = bucket.tryConsume(now);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    // Since capacity is 10 and we have 9 tokens, we need 1 token.
    // At a refill rate of 2 per second, refilling 1 token takes 0.5s = 500ms.
    expect(result.resetAt).toBe(now + 500);
  });

  it('should drain a bucket of capacity N and deny the (N+1)th request', () => {
    const capacity = 5;
    const bucket = new TokenBucket({ capacity, refillRatePerSecond: 1 });
    const now = 1000000;

    // First N requests are allowed
    for (let i = 0; i < capacity; i++) {
      const result = bucket.tryConsume(now);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(capacity - 1 - i);
    }

    // (N+1)th request is denied
    const deniedResult = bucket.tryConsume(now);
    expect(deniedResult.allowed).toBe(false);
    expect(deniedResult.remaining).toBe(0);
    // 5 tokens missing, 1 token/sec, needs 5 seconds (5000ms) to refill to full capacity
    expect(deniedResult.resetAt).toBe(now + 5000);
  });

  it('should correctly handle partial refill with fractional tokens', () => {
    // Capacity 5, Refill rate 2 tokens/sec (i.e. 1 token per 500ms)
    const bucket = new TokenBucket({ capacity: 5, refillRatePerSecond: 2 });
    const startTime = 1000000;

    // Drain the bucket completely at startTime
    for (let i = 0; i < 5; i++) {
      bucket.tryConsume(startTime);
    }
    expect(bucket.tokens).toBe(0);

    // Advance clock by 250ms. Since rate is 2/s, 250ms should yield 0.5 tokens.
    // 0.5 tokens < 1, so consume should be denied
    let result = bucket.tryConsume(startTime + 250);
    expect(result.allowed).toBe(false);
    expect(bucket.tokens).toBe(0.5); // Still accumulated

    // Advance clock another 250ms (total 500ms from start).
    // This adds another 0.5 tokens, totaling 1.0 tokens.
    // This request should be allowed and consume 1.0 tokens, leaving 0 tokens.
    result = bucket.tryConsume(startTime + 500);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
    expect(bucket.tokens).toBe(0);
  });

  it('should cap tokens at max capacity and not overflow', () => {
    const bucket = new TokenBucket({ capacity: 5, refillRatePerSecond: 2 });
    const startTime = 1000000;

    // Initialize/lazy-load the start timestamp
    bucket.tryConsume(startTime);
    expect(bucket.tokens).toBe(4);

    // Advance clock by a long duration (10 seconds)
    // 10s * 2 tokens/sec = 20 tokens refilled.
    // But tokens must be capped at capacity (5).
    // We consume 1 token, leaving 4.
    const result = bucket.tryConsume(startTime + 10000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(bucket.tokens).toBe(4);
  });

  it('should accumulate fractional tokens over multiple small time intervals', () => {
    // Capacity 5, Refill rate 1 token/sec (1 token per 1000ms)
    const bucket = new TokenBucket({ capacity: 5, refillRatePerSecond: 1 });
    const startTime = 1000000;

    // Drain the bucket
    for (let i = 0; i < 5; i++) {
      bucket.tryConsume(startTime);
    }
    expect(bucket.tokens).toBe(0);

    // 5 intervals of 200ms = 1000ms total. Each interval refills 0.2 tokens.
    // Confirm no individual consume is allowed until the final one.
    let now = startTime;
    for (let i = 1; i <= 4; i++) {
      now += 200;
      const result = bucket.tryConsume(now);
      expect(result.allowed).toBe(false);
      expect(bucket.tokens).toBeCloseTo(i * 0.2, 5);
    }

    // 5th interval crossing 1.0 token
    now += 200;
    const finalResult = bucket.tryConsume(now);
    expect(finalResult.allowed).toBe(true);
    expect(finalResult.remaining).toBe(0);
    expect(bucket.tokens).toBeCloseTo(0.0, 5);
  });

  it('should calculate resetAt correctly based on current capacity state', () => {
    const bucket = new TokenBucket({ capacity: 10, refillRatePerSecond: 2 });
    const startTime = 1000000;

    // Check resetAt on first consume (leaves 9 tokens)
    // Refill time = 1 / 2 = 0.5s = 500ms
    const result1 = bucket.tryConsume(startTime);
    expect(result1.resetAt).toBe(startTime + 500);

    // Consume more to lower the token count to 7
    bucket.tryConsume(startTime); // leaves 8
    const result2 = bucket.tryConsume(startTime); // leaves 7
    
    // Now we have 7 tokens. Missing = 3 tokens.
    // Refill time = 3 / 2 = 1.5s = 1500ms
    expect(result2.resetAt).toBe(startTime + 1500);
  });

  it('should guarantee that remaining is exactly 0 (not negative) on a denied request', () => {
    const bucket = new TokenBucket({ capacity: 5, refillRatePerSecond: 1, initialTokens: 0.5 });
    // First attempt tries to consume 1 token. Since initialTokens = 0.5 < 1, it should be denied.
    const res = bucket.tryConsume(1000);
    expect(res.allowed).toBe(false);
    expect(res.remaining).toBe(0);
  });
});
