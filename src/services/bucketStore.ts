import { TokenBucket } from "../core/tokenBucket";
import { getClientConfig } from "./clientConfigService";
import { Algorithm, ClientConfig } from "@prisma/client";
import { redis } from "../lib/redis";
import * as redisRepository from "./redisBucketRepository";

export class ClientNotConfiguredError extends Error {
  constructor(clientKey: string) {
    super(`Client not configured: ${clientKey}`);
    this.name = "ClientNotConfiguredError";
  }
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

/**
 * Fallback fail-open handler when Redis is unreachable or throws an error.
 * Logs an alert and evaluates rate limiting using a transient in-memory TokenBucket,
 * guaranteeing the request is allowed (fail-open) while returning degraded status.
 */
function handleRedisUnavailable(
  config: ClientConfig,
  now: number,
  error?: any
): { allowed: boolean; remaining: number; resetAt: number; limit: number; degraded: boolean } {
  console.error(
    `[ALERT] Redis is unreachable or threw an error for client ${config.clientKey}. Falling back to fail-open (ALLOW degraded). Error:`,
    error || "Redis connection not ready/open"
  );

  const transientBucket = new TokenBucket({
    capacity: config.burstSize,
    refillRatePerSecond: config.requestsPerSecond,
  });

  const result = transientBucket.tryConsume(now);

  return {
    allowed: true, // Fail-open: always allow
    remaining: result.remaining,
    resetAt: result.resetAt,
    limit: config.burstSize,
    degraded: true,
  };
}

/**
 * Retrieves/rehydrates the rate-limiting bucket for a given client key,
 * queries PostgreSQL for config, reads/writes state from/to Redis,
 * and performs the consumption check with fail-open resiliency.
 * 
 * NOTE: This design incurs a stacked per-request cost:
 * 1. Postgres READ (fetch client config)
 * 2. Redis READ (fetch bucket state)
 * 3. Redis WRITE (save updated bucket state)
 * This is a known performance tradeoff for Phase 3, to be optimized in future phases.
 * 
 * @param clientKey Unique key identifier for the client service.
 * @param now Optional timestamp override for testing.
 */
export async function getOrCreateBucket(
  clientKey: string,
  now: number = Date.now()
): Promise<{ allowed: boolean; remaining: number; resetAt: number; limit: number; degraded: boolean }> {
  const config = await getClientConfig(clientKey);
  
  if (!config) {
    throw new ClientNotConfiguredError(clientKey);
  }

  if (config.algorithm === Algorithm.SLIDING_WINDOW) {
    throw new NotImplementedError("SLIDING_WINDOW algorithm is not implemented yet.");
  }

  // Pre-check Redis readiness
  if (!redis.isOpen || !redis.isReady) {
    return handleRedisUnavailable(config, now);
  }

  let bucketState: redisRepository.RedisBucketState | null = null;
  try {
    // Fetch bucket state from Redis
    bucketState = await redisRepository.getBucketState(clientKey);
  } catch (error) {
    // Fail-open if read operation throws
    return handleRedisUnavailable(config, now, error);
  }

  let bucket: TokenBucket;
  if (!bucketState) {
    // First-ever check: construct fresh
    bucket = new TokenBucket({
      capacity: config.burstSize,
      refillRatePerSecond: config.requestsPerSecond,
    });
  } else {
    // Rehydrate using saved tokens and timestamp
    bucket = new TokenBucket({
      capacity: config.burstSize,
      refillRatePerSecond: config.requestsPerSecond,
      initialTokens: bucketState.tokens,
      lastRefillTimestamp: bucketState.lastRefillTimestamp,
    });
  }

  // Consume 1 token
  const result = bucket.tryConsume(now);

  try {
    // Save the updated state back to Redis
    await redisRepository.saveBucketState(clientKey, {
      tokens: bucket.tokens,
      lastRefillTimestamp: bucket.lastRefillTimestamp,
    });
  } catch (error) {
    // Log the write failure, but return the result to the caller (fail-open/degraded)
    // NOTE: A failed write here means the next check() will re-read stale state,
    // effectively "refunding" whatever was consumed this request.
    console.error(
      `[ALERT] Failed to save bucket state to Redis for client ${clientKey}. Next check will re-read stale state (refund gap). Error:`,
      error
    );
    return {
      allowed: result.allowed,
      remaining: result.remaining,
      resetAt: result.resetAt,
      limit: config.burstSize,
      degraded: true,
    };
  }

  return {
    allowed: result.allowed,
    remaining: result.remaining,
    resetAt: result.resetAt,
    limit: config.burstSize,
    degraded: false,
  };
}

/**
 * Prefix-scoped helper to clear all bucket keys (useful during unit testing/resets).
 */
export async function clearBuckets(): Promise<void> {
  if (!redis.isOpen || !redis.isReady) {
    return;
  }
  const keys = await redis.keys("bucket:*");
  if (keys.length > 0) {
    await redis.del(keys);
  }
}
