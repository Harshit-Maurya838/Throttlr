import { TokenBucket } from "../core/tokenBucket";
import { getClientConfig } from "./clientConfigService";
import { Algorithm } from "@prisma/client";

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

// Local storage mapping client key to their token bucket instance
const buckets = new Map<string, TokenBucket>();

/**
 * Retrieves the existing rate-limiting bucket for a given client key,
 * or queries PostgreSQL to create one if it is configured.
 * 
 * NOTE: Bucket instances live in the in-memory Map. Postgres is only
 * consulted on first creation per clientKey, not on every request.
 * Consequently, config changes via /admin won't take effect for an active
 * clientKey until its in-memory bucket is evicted/restarted. This is a known
 * phase limitation to be revisited when Redis-backed state is implemented in Phase 3.
 * 
 * @param clientKey Unique key identifier for the client service.
 */
export async function getOrCreateBucket(clientKey: string): Promise<TokenBucket> {
  let bucket = buckets.get(clientKey);
  
  if (!bucket) {
    const config = await getClientConfig(clientKey);
    
    // Policy Choice: Explicit configuration required.
    // Silently defaulting unconfigured clients could mask a real integration bug for whoever's calling this service.
    if (!config) {
      throw new ClientNotConfiguredError(clientKey);
    }

    // Only TOKEN_BUCKET algorithm is supported in this phase.
    if (config.algorithm === Algorithm.SLIDING_WINDOW) {
      throw new NotImplementedError("SLIDING_WINDOW algorithm is not implemented yet.");
    }

    bucket = new TokenBucket({
      capacity: config.burstSize,
      refillRatePerSecond: config.requestsPerSecond,
    });
    buckets.set(clientKey, bucket);
  }
  
  return bucket;
}

/**
 * Helper function for clearing all buckets (useful during unit testing/resets).
 */
export function clearBuckets(): void {
  buckets.clear();
}
