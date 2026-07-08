import { Router, Request, Response } from 'express';
import { getOrCreateBucket } from '../services/bucketStore';

const router = Router();

/**
 * POST /check/:clientKey
 * Evaluates whether a request for the specified clientKey should be allowed or denied.
 * Returns JSON metadata including remaining capacity and reset time.
 */
router.post('/check/:clientKey', (req: Request, res: Response) => {
  const { clientKey } = req.params;
  
  if (!clientKey) {
    res.status(400).json({ error: 'Client key is required.' });
    return;
  }

  const bucket = getOrCreateBucket(clientKey);
  const result = bucket.tryConsume(Date.now());

  res.status(200).json({
    allowed: result.allowed,
    remaining: result.remaining,
    limit: bucket.capacity,
    resetAt: result.resetAt,
  });
});

export default router;
