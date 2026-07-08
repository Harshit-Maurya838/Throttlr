import { TokenBucket } from '../core/tokenBucket';
import { GLOBAL_RATE_LIMIT_CONFIG } from '../config/rateLimit';

// Local storage mapping client key to their token bucket instance
const buckets = new Map<string, TokenBucket>();

/**
 * Retrieves the existing rate-limiting bucket for a given client key,
 * or creates a new one using the default global rate limits if none exists.
 * 
 * @param clientKey Unique key identifier for the client service.
 */
export function getOrCreateBucket(clientKey: string): TokenBucket {
  let bucket = buckets.get(clientKey);
  
  if (!bucket) {
    bucket = new TokenBucket({
      capacity: GLOBAL_RATE_LIMIT_CONFIG.capacity,
      refillRatePerSecond: GLOBAL_RATE_LIMIT_CONFIG.refillRatePerSecond,
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
