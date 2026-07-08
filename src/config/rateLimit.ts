/**
 * Global Rate Limit Configuration for Phase 1.
 * NOTE: This will be replaced by dynamic, per-client database configuration
 * stored in PostgreSQL (via Prisma) in Phase 2.
 */
export const GLOBAL_RATE_LIMIT_CONFIG = {
  capacity: 10, // Burst size (maximum tokens)
  refillRatePerSecond: 2, // How many tokens are added per second
} as const;

export type RateLimitConfig = typeof GLOBAL_RATE_LIMIT_CONFIG;
