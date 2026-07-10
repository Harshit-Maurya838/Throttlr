import { Router, Request, Response } from "express";
import { getOrCreateBucket, ClientNotConfiguredError, NotImplementedError } from "../services/bucketStore";

const router = Router();

/**
 * POST /check/:clientKey
 * Evaluates whether a request for the specified clientKey should be allowed or denied.
 * Returns JSON metadata including remaining capacity and reset time.
 */
router.post("/check/:clientKey", async (req: Request, res: Response) => {
  const { clientKey } = req.params;
  
  try {
    const result = await getOrCreateBucket(clientKey);
    
    if (result.degraded) {
      res.setHeader("X-RateLimiter-Bypassed", "true");
    }

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
