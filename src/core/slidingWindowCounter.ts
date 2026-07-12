export interface SlidingWindowCounterOptions {
  limit: number;
  windowMs: number;
  currentWindowStart?: number;
  currentCount?: number;
  previousCount?: number;
}

/**
 * SlidingWindowCounter implements the sliding window counter rate limiting algorithm.
 * It is a pure logic class (no I/O, no internal timers/dates) and accepts the current time 'now' explicitly.
 *
 * TRADEOFF DECISION:
 * We use the Sliding Window Counter approximation algorithm (keeping track of current and previous window counts)
 * rather than a Sliding Window Log (which stores every request's timestamp in Redis).
 * - Advantage: Bounded storage (only a single Hash with 3 integer fields per client, not growing with request volume).
 * - Advantage: High performance (O(1) updates and checks, key to supporting 500+ req/s).
 * - Tradeoff: It is an approximation. However, the maximum error rate is bounded and negligible in practice.
 */
export class SlidingWindowCounter {
  public readonly limit: number;
  public readonly windowMs: number;
  public currentWindowStart: number;
  public currentCount: number;
  public previousCount: number;

  constructor(options: SlidingWindowCounterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.currentWindowStart = options.currentWindowStart !== undefined ? options.currentWindowStart : 0;
    this.currentCount = options.currentCount !== undefined ? options.currentCount : 0;
    this.previousCount = options.previousCount !== undefined ? options.previousCount : 0;
  }

  /**
   * Attempts to consume 1 request from the sliding window.
   * @param now The current timestamp in milliseconds.
   */
  public tryConsume(now: number): { allowed: boolean; remaining: number; resetAt: number } {
    const calculatedWindowStart = Math.floor(now / this.windowMs) * this.windowMs;

    if (this.currentWindowStart === 0) {
      // Lazy initialize state on first request
      this.currentWindowStart = calculatedWindowStart;
      this.currentCount = 0;
      this.previousCount = 0;
    } else if (calculatedWindowStart > this.currentWindowStart) {
      // Roll forward the window boundaries
      if (calculatedWindowStart === this.currentWindowStart + this.windowMs) {
        // Roll current window count to previous window count
        this.previousCount = this.currentCount;
      } else {
        // More than one window size has elapsed, previous counts are completely decayed to 0
        this.previousCount = 0;
      }
      this.currentCount = 0;
      this.currentWindowStart = calculatedWindowStart;
    }

    const elapsedMs = Math.max(0, now - this.currentWindowStart);
    const overlapFraction = this.windowMs > 0
      ? Math.max(0, Math.min(1, (this.windowMs - elapsedMs) / this.windowMs))
      : 0;

    const weightedCount = this.previousCount * overlapFraction + this.currentCount;

    let allowed = false;
    if (weightedCount + 1 <= this.limit) {
      this.currentCount += 1;
      allowed = true;
    }

    // Compute remaining capacity and next window reset time.
    // NOTE: Unlike Token Bucket where resetAt denotes when full capacity is restored,
    // in Sliding Window Counter resetAt indicates the start of the next window boundary,
    // which is the point at which the current window's requests roll over into the
    // previous window (starting their decay process).
    const finalWeightedCount = this.previousCount * overlapFraction + this.currentCount;
    const remaining = Math.max(0, Math.floor(this.limit - finalWeightedCount));
    const resetAt = this.currentWindowStart + this.windowMs;

    return {
      allowed,
      remaining,
      resetAt,
    };
  }
}
