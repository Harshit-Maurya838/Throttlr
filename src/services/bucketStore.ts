import { TokenBucket } from "../core/tokenBucket";
import { SlidingWindowCounter } from "../core/slidingWindowCounter";
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
 * Logs an alert and evaluates rate limiting using a transient in-memory rate limiter,
 * guaranteeing the request is allowed (fail-open) while returning degraded status.
 *
 * NOTE: Sliding Window Counter uses burstSize as the limit during in-memory fallback.
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

  let result;
  let limit;

  if (config.algorithm === Algorithm.SLIDING_WINDOW) {
    const windowMs = config.windowMs || 1000;
    const transientCounter = new SlidingWindowCounter({
      limit: config.burstSize,
      windowMs: windowMs,
    });
    result = transientCounter.tryConsume(now);
    limit = config.burstSize;
  } else {
    const transientBucket = new TokenBucket({
      capacity: config.burstSize,
      refillRatePerSecond: config.requestsPerSecond,
    });
    result = transientBucket.tryConsume(now);
    limit = config.burstSize;
  }

  return {
    allowed: true, // Fail-open: always allow
    remaining: result.remaining,
    resetAt: result.resetAt,
    limit,
    degraded: true,
  };
}

/**
 * Retrieves/rehydrates the rate-limiting bucket for a given client key,
 * queries PostgreSQL for config, executes the consumption check atomically using
 * a Redis Lua script, and supports fail-open resiliency.
 * 
 * NOTE: This design incurs a per-request cost:
 * 1. Postgres READ (fetch client config)
 * 2. One atomic Redis EVAL / EVALSHA (checks and consumes tokens)
 * This is an optimized design to ensure concurrency safety. The exact
 * latency characteristics will be measured in Phase 7's load test.
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

  // Pre-check Redis readiness
  if (!redis.isOpen || !redis.isReady) {
    return handleRedisUnavailable(config, now);
  }

  try {
    if (config.algorithm === Algorithm.SLIDING_WINDOW) {
      const windowMs = config.windowMs || 1000;
      const result = await redisRepository.checkAndConsumeSlidingWindow(
        clientKey,
        config.burstSize,
        windowMs,
        now
      );
      return {
        allowed: result.allowed,
        remaining: result.remaining,
        resetAt: result.resetAt,
        limit: config.burstSize,
        degraded: false,
      };
    } else {
      const result = await redisRepository.checkAndConsume(
        clientKey,
        config.burstSize,
        config.requestsPerSecond,
        now,
        1
      );
      return {
        allowed: result.allowed,
        remaining: result.remaining,
        resetAt: result.resetAt,
        limit: config.burstSize,
        degraded: false,
      };
    }
  } catch (error) {
    // If Redis operation fails, trigger fail-open path
    return handleRedisUnavailable(config, now, error);
  }
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
