import { redis } from "../lib/redis";

export interface RedisBucketState {
  tokens: number;
  lastRefillTimestamp: number;
}

/**
 * Reads the bucket state from Redis hash.
 * 
 * Redis key: `bucket:{clientKey}`
 * Fields: `tokens` (string representation of float) and `lastRefillTimestamp` (string representation of integer)
 * 
 * Returns null if the key doesn't exist (i.e. the returned object is empty).
 */
export async function getBucketState(clientKey: string): Promise<RedisBucketState | null> {
  const key = `bucket:${clientKey}`;
  const data = await redis.hGetAll(key);
  
  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  const tokens = parseFloat(data.tokens);
  const lastRefillTimestamp = parseInt(data.lastRefillTimestamp, 10);

  // If parsing fails for some reason, treat as non-existent to avoid corrupt state
  if (isNaN(tokens) || isNaN(lastRefillTimestamp)) {
    return null;
  }

  return {
    tokens,
    lastRefillTimestamp,
  };
}

/**
 * Saves the bucket state to Redis using HSET.
 * 
 * NOTE: There is no TTL/expiry on these keys for now, meaning a client's bucket state will persist indefinitely.
 * Unbounded key growth for many distinct clientKeys is an accepted tradeoff for this phase,
 * worth revisiting later (e.g. TTL + rehydrate-from-Postgres-config pattern) if it ever becomes a real concern.
 */
export async function saveBucketState(clientKey: string, state: RedisBucketState): Promise<void> {
  const key = `bucket:${clientKey}`;
  await redis.hSet(key, {
    tokens: state.tokens.toString(),
    lastRefillTimestamp: state.lastRefillTimestamp.toString(),
  });
}
