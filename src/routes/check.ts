import { Router, Request, Response } from "express";
import { getOrCreateBucket, ClientNotConfiguredError, NotImplementedError } from "../services/bucketStore";

const router = Router();

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
  degraded: boolean;
}

/**
 * Sets standard rate-limit HTTP headers on the Express Response object.
 *
 * Design Decisions:
 * 1. X-RateLimit-Limit: Directly reflects the client's configured limit.
 * 2. X-RateLimit-Remaining: Reflects the tokens/requests remaining. Always non-negative.
 * 3. X-RateLimit-Reset: Converted from internal milliseconds to Unix seconds (integer, e.g. Math.ceil(resetAt / 1000)),
 *    matching GitHub's convention. This is standard in real-world rate-limited APIs.
 * 4. Retry-After: Only added if allowed is false (DENY). Calculated in seconds as (resetAt - now), floored at 0.
 *    We use Math.ceil to avoid premature retries.
 * 5. Degraded/Fail-open (Option A): If degraded is true, we omit all X-RateLimit-* headers
 *    since no actual accounting took place against shared Redis state. We keep only
 *    X-RateLimiter-Bypassed: true.
 */
export function setRateLimitHeaders(res: Response, result: RateLimitResult): void {
  if (result.degraded) {
    res.setHeader("X-RateLimiter-Bypassed", "true");
    return;
  }

  // Convert resetAt (ms) to Unix seconds (integer)
  const resetSeconds = Math.ceil(result.resetAt / 1000);

  res.set({
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(resetSeconds),
  });

  if (!result.allowed) {
    const now = Date.now();
    const retryAfter = Math.max(0, Math.ceil((result.resetAt - now) / 1000));
    res.set("Retry-After", String(retryAfter));
  }
}

/**
 * POST /check/:clientKey
 * Evaluates whether a request for the specified clientKey should be allowed or denied.
 * Returns JSON metadata including remaining capacity and reset time.
 */
router.post("/check/:clientKey", async (req: Request, res: Response) => {
  const { clientKey } = req.params;
  
  try {
    const result = await getOrCreateBucket(clientKey);
    
    // Set headers using helper function
    setRateLimitHeaders(res, result);

    res.status(200).json({
      allowed: result.allowed,
      remaining: result.remaining,
      limit: result.limit,
      resetAt: result.resetAt,
    });
  } catch (error) {
    if (error instanceof ClientNotConfiguredError) {
      res.status(404).json({ error: error.message });
    } else if (error instanceof NotImplementedError) {
      res.status(501).json({ error: error.message });
    } else {
      console.error("Unexpected error in check route:", error);
      res.status(500).json({ error: "Internal server error." });
    }
  }
});

export default router;
