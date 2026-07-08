export interface TokenBucketOptions {
  capacity: number;
  refillRatePerSecond: number;
  initialTokens?: number;
  lastRefillTimestamp?: number;
}

export class TokenBucket {
  public readonly capacity: number;
  public readonly refillRatePerSecond: number;
  public tokens: number;
  public lastRefillTimestamp: number;

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillRatePerSecond = options.refillRatePerSecond;
    this.tokens = options.initialTokens !== undefined ? options.initialTokens : options.capacity;
    this.lastRefillTimestamp = options.lastRefillTimestamp !== undefined ? options.lastRefillTimestamp : 0;
  }

  /**
   * Attempts to consume 1 token from the bucket.
   * @param now The current timestamp in milliseconds.
   */
  public tryConsume(now: number): { allowed: boolean; remaining: number; resetAt: number } {
    // Lazy initialize the lastRefillTimestamp if it was not provided in construction
    if (this.lastRefillTimestamp === 0) {
      this.lastRefillTimestamp = now;
    }

    const elapsedMs = Math.max(0, now - this.lastRefillTimestamp);
    const elapsedSeconds = elapsedMs / 1000;

    // Refill the bucket based on elapsed wall-clock time
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsedSeconds * this.refillRatePerSecond
    );
    this.lastRefillTimestamp = now;

    let allowed = false;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      allowed = true;
    }

    // Return the floored count of remaining tokens
    const remaining = Math.floor(this.tokens);

    // Calculate when the bucket will be completely full again (at capacity)
    const missingTokens = this.capacity - this.tokens;
    const secondsToRefill = missingTokens / this.refillRatePerSecond;
    const resetAt = Math.ceil(now + secondsToRefill * 1000);

    return {
      allowed,
      remaining,
      resetAt,
    };
  }
}
