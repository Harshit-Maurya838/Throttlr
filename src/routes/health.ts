import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';

const router = Router();

router.get('/health', async (_req: Request, res: Response) => {
  let dbStatus = 'disconnected';
  let redisStatus = 'disconnected';
  let isHealthy = true;

  // Check database connectivity
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = 'connected';
  } catch (error) {
    console.error('Health Check - Database error:', error);
    dbStatus = 'disconnected';
    isHealthy = false;
  }

  // Check Redis connectivity
  try {
    if (redis.isReady) {
      const pingResult = await redis.ping();
      if (pingResult === 'PONG') {
        redisStatus = 'connected';
      } else {
        redisStatus = 'degraded';
        isHealthy = false;
      }
    } else {
      redisStatus = 'disconnected';
      isHealthy = false;
    }
  } catch (error) {
    console.error('Health Check - Redis error:', error);
    redisStatus = 'disconnected';
    isHealthy = false;
  }

  const statusCode = isHealthy ? 200 : 503;
  res.status(statusCode).json({
    status: isHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    services: {
      database: dbStatus,
      redis: redisStatus,
    },
  });
});

export default router;
