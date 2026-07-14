import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { prisma } from "../../lib/prisma";
import { redis } from "../../lib/redis";
import * as redisRepository from "../redisBucketRepository";
import {
  getClientConfig,
  upsertClientConfig,
} from "../clientConfigService";
import {
  getOrCreateBucket,
  clearBuckets,
  ClientNotConfiguredError,
  NotImplementedError,
} from "../bucketStore";
import adminRouter from "../../routes/admin";
import checkRouter from "../../routes/check";
import { Algorithm } from "@prisma/client";

// Set up a clean Express application for integration tests
const testApp = express();
testApp.use(express.json());
testApp.use(adminRouter);
testApp.use(checkRouter);

describe("Phase 3 Integration & Unit Tests", () => {
  beforeAll(async () => {
    if (!redis.isOpen) {
      await redis.connect();
    }
    await redisRepository.initializeScripts();
  });

  // Clear database and in-memory bucket store before each test to ensure isolation
  beforeEach(async () => {
    await clearBuckets();
    await prisma.clientConfig.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    if (redis.isOpen) {
      await redis.quit();
    }
  });

  describe("clientConfigService Unit Tests", () => {
    it("should return null if no configuration exists for a clientKey", async () => {
      const config = await getClientConfig("non-existent-client");
      expect(config).toBeNull();
    });

    it("should upsert and retrieve client configuration successfully", async () => {
      const created = await upsertClientConfig("client-1", {
        algorithm: Algorithm.TOKEN_BUCKET,
        requestsPerSecond: 5.5,
        burstSize: 10,
      });

      expect(created.clientKey).toBe("client-1");
      expect(created.algorithm).toBe(Algorithm.TOKEN_BUCKET);
      expect(created.requestsPerSecond).toBe(5.5);
      expect(created.burstSize).toBe(10);
      expect(created.windowMs).toBeNull();

      const retrieved = await getClientConfig("client-1");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.requestsPerSecond).toBe(5.5);
      expect(retrieved?.burstSize).toBe(10);
    });
  });

  describe("bucketStore Service Unit Tests", () => {
    it("should throw ClientNotConfiguredError if client has no configuration", async () => {
      await expect(getOrCreateBucket("unconfigured-client")).rejects.toThrow(
        ClientNotConfiguredError
      );
    });

    it("should successfully evaluate SLIDING_WINDOW client using getOrCreateBucket", async () => {
      await upsertClientConfig("sliding-client", {
        algorithm: Algorithm.SLIDING_WINDOW,
        requestsPerSecond: 2.0,
        burstSize: 5,
        windowMs: 60000,
      });

      const result = await getOrCreateBucket("sliding-client");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
      expect(result.limit).toBe(5);
      expect(result.degraded).toBe(false);
    });

    it("should create bucket state in Redis and immediately propagate config changes", async () => {
      await upsertClientConfig("token-client", {
        algorithm: Algorithm.TOKEN_BUCKET,
        requestsPerSecond: 3.5,
        burstSize: 7,
      });

      const res = await getOrCreateBucket("token-client");
      expect(res.limit).toBe(7);
      expect(res.allowed).toBe(true);

      // Verify Redis state directly
      const redisState = await redis.hGetAll("bucket:token-client");
      expect(redisState).not.toBeNull();
      expect(parseFloat(redisState.tokens)).toBeCloseTo(6.0, 2);

      // Verify immediate config change: modify database config and ensure the new limits apply on the next check
      await upsertClientConfig("token-client", {
        algorithm: Algorithm.TOKEN_BUCKET,
        requestsPerSecond: 100,
        burstSize: 200,
      });

      const resAfterConfigChange = await getOrCreateBucket("token-client");
      expect(resAfterConfigChange.limit).toBe(200); // changed immediately due to no in-memory cache
    });

    it("should simulate a server restart by showing state survives when no in-memory cache exists", async () => {
      await upsertClientConfig("restart-client", {
        algorithm: Algorithm.TOKEN_BUCKET,
        requestsPerSecond: 1.0,
        burstSize: 5,
      });

      // Consume 1 token
      const res1 = await getOrCreateBucket("restart-client");
      expect(res1.allowed).toBe(true);
      expect(res1.remaining).toBe(4);

      // Verify that state exists in Redis
      const stateBefore = await redis.hGetAll("bucket:restart-client");
      expect(parseFloat(stateBefore.tokens)).toBeCloseTo(4, 2);

      // Call getOrCreateBucket again (with no map, this is equivalent to restart)
      const res2 = await getOrCreateBucket("restart-client");
      expect(res2.allowed).toBe(true);
      expect(res2.remaining).toBe(3);
    });

    it("should correctly resume refill math from lastRefillTimestamp on rehydration", async () => {
      await upsertClientConfig("rehydrate-client", {
        algorithm: Algorithm.TOKEN_BUCKET,
        requestsPerSecond: 1.0, // 1 token/sec
        burstSize: 5,
      });

      const now = Date.now();

      // Seed Redis state: 1 token, refilled 3 seconds ago
      await redis.hSet("bucket:rehydrate-client", {
        tokens: "1.0",
        lastRefillTimestamp: (now - 3000).toString(),
      });

      // Rehydrate:
      // - base tokens = 1.0
      // - refilled = 3.0 (3s * 1/s)
      // - pre-consume = 4.0
      // - remaining = 3.0
      const res = await getOrCreateBucket("rehydrate-client", now);
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(3);
    });

    it("should fail-open and return degraded status if Redis is unavailable", async () => {
      await upsertClientConfig("fail-open-client", {
        algorithm: Algorithm.TOKEN_BUCKET,
        requestsPerSecond: 1.0,
        burstSize: 5,
      });

      // Disconnect Redis client physically to trigger isOpen/isReady = false
      if (redis.isOpen) {
        await redis.disconnect();
      }

      try {
        const res = await request(testApp).post("/check/fail-open-client");
        expect(res.status).toBe(200);
        expect(res.headers["x-ratelimiter-bypassed"]).toBe("true");
        expect(res.body.allowed).toBe(true);
        expect(res.body.remaining).toBe(4); // fresh in-memory-only bucket allows it
      } finally {
        // Reconnect Redis so subsequent tests can run
        if (!redis.isOpen) {
          await redis.connect();
        }
      }
    });

    it("should fail-open and return degraded status if a Redis operation throws", async () => {
      await upsertClientConfig("fail-throw-client", {
        algorithm: Algorithm.TOKEN_BUCKET,
        requestsPerSecond: 1.0,
        burstSize: 5,
      });

      // Spy on redisRepository.checkAndConsume to throw an error
      const checkAndConsumeSpy = vi.spyOn(redisRepository, "checkAndConsume").mockRejectedValue(new Error("Redis connection timeout"));

      try {
        const res = await request(testApp).post("/check/fail-throw-client");
        expect(res.status).toBe(200);
        expect(res.headers["x-ratelimiter-bypassed"]).toBe("true");
        expect(res.body.allowed).toBe(true);
        expect(res.body.remaining).toBe(4);
      } finally {
        checkAndConsumeSpy.mockRestore();
      }
    });
  });

  describe("Admin Routes Integration Tests", () => {
    it("GET /admin/clients/:clientKey should return 404 if not found", async () => {
      const res = await request(testApp).get("/admin/clients/unknown");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Configuration not found");
    });

    it("POST /admin/clients/:clientKey should validate algorithm correctness", async () => {
      const res = await request(testApp)
        .post("/admin/clients/test-client")
        .send({
          algorithm: "INVALID_ALGORITHM",
          requestsPerSecond: 1.0,
          burstSize: 5,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid algorithm");
    });

    it("POST /admin/clients/:clientKey should validate positive numbers for requestsPerSecond", async () => {
      const res = await request(testApp)
        .post("/admin/clients/test-client")
        .send({
          algorithm: "TOKEN_BUCKET",
          requestsPerSecond: -1.5,
          burstSize: 5,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("requestsPerSecond must be a positive number");
    });

    it("POST /admin/clients/:clientKey should validate positive integer for burstSize", async () => {
      const res = await request(testApp)
        .post("/admin/clients/test-client")
        .send({
          algorithm: "TOKEN_BUCKET",
          requestsPerSecond: 1.5,
          burstSize: 5.5, // float is invalid
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("burstSize must be a positive integer");
    });

    it("POST /admin/clients/:clientKey should validate positive integer for windowMs if SLIDING_WINDOW", async () => {
      const res = await request(testApp)
        .post("/admin/clients/test-client")
        .send({
          algorithm: "SLIDING_WINDOW",
          requestsPerSecond: 1.5,
          burstSize: 5,
          windowMs: -10,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("windowMs must be a positive integer");
    });

    it("POST /admin/clients/:clientKey should save configuration and return 201 Created and then 200 OK on update", async () => {
      // First POST (Creation)
      const res1 = await request(testApp)
        .post("/admin/clients/test-client")
        .send({
          algorithm: "TOKEN_BUCKET",
          requestsPerSecond: 2.5,
          burstSize: 10,
        });

      expect(res1.status).toBe(201);
      expect(res1.body.clientKey).toBe("test-client");
      expect(res1.body.requestsPerSecond).toBe(2.5);
      expect(res1.body.burstSize).toBe(10);

      // Second POST (Update)
      const res2 = await request(testApp)
        .post("/admin/clients/test-client")
        .send({
          algorithm: "TOKEN_BUCKET",
          requestsPerSecond: 5.0,
          burstSize: 15,
        });

      expect(res2.status).toBe(200);
      expect(res2.body.requestsPerSecond).toBe(5.0);
      expect(res2.body.burstSize).toBe(15);
    });
  });

  describe("Check Route Integration Tests", () => {
    it("POST /check/:clientKey should return 404 if client has no configuration", async () => {
      const res = await request(testApp).post("/check/unconfigured-key");
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Client not configured");
    });

    it("POST /check/:clientKey should allow and enforce rate limits for configured SLIDING_WINDOW client", async () => {
      // Add sliding window config with limit 3 (using burstSize as limit) and windowMs 1000
      await request(testApp)
        .post("/admin/clients/sliding-key")
        .send({
          algorithm: "SLIDING_WINDOW",
          requestsPerSecond: 1.0, // required by schema but unused
          burstSize: 3,
          windowMs: 1000,
        });

      // 1st request - allowed
      const res1 = await request(testApp).post("/check/sliding-key");
      expect(res1.status).toBe(200);
      expect(res1.body.allowed).toBe(true);
      expect(res1.body.remaining).toBe(2);

      // 2nd request - allowed
      const res2 = await request(testApp).post("/check/sliding-key");
      expect(res2.status).toBe(200);
      expect(res2.body.allowed).toBe(true);
      expect(res2.body.remaining).toBe(1);

      // 3rd request - allowed
      const res3 = await request(testApp).post("/check/sliding-key");
      expect(res3.status).toBe(200);
      expect(res3.body.allowed).toBe(true);
      expect(res3.body.remaining).toBe(0);

      // 4th request - rejected
      const res4 = await request(testApp).post("/check/sliding-key");
      expect(res4.status).toBe(200);
      expect(res4.body.allowed).toBe(false);
      expect(res4.body.remaining).toBe(0);
    });

    it("POST /check/:clientKey should allow and enforce rate limits for configured TOKEN_BUCKET client", async () => {
      // Add token bucket config with burst size 3
      await request(testApp)
        .post("/admin/clients/rate-client")
        .send({
          algorithm: "TOKEN_BUCKET",
          requestsPerSecond: 0.5, // Refill 1 token every 2 seconds
          burstSize: 3,
        });

      // 1st request - allowed
      const res1 = await request(testApp).post("/check/rate-client");
      expect(res1.status).toBe(200);
      expect(res1.body.allowed).toBe(true);
      expect(res1.body.remaining).toBe(2);

      // 2nd request - allowed
      const res2 = await request(testApp).post("/check/rate-client");
      expect(res2.status).toBe(200);
      expect(res2.body.allowed).toBe(true);
      expect(res2.body.remaining).toBe(1);

      // 3rd request - allowed
      const res3 = await request(testApp).post("/check/rate-client");
      expect(res3.status).toBe(200);
      expect(res3.body.allowed).toBe(true);
      expect(res3.body.remaining).toBe(0);

      // 4th request - rejected
      const res4 = await request(testApp).post("/check/rate-client");
      expect(res4.status).toBe(200);
      expect(res4.body.allowed).toBe(false);
      expect(res4.body.remaining).toBe(0);
    });

    it("should process concurrent requests without race conditions (exactly capacity requests allowed)", async () => {
      const clientKey = "concurrency-client";
      const burstSize = 20;

      await upsertClientConfig(clientKey, {
        algorithm: Algorithm.TOKEN_BUCKET,
        requestsPerSecond: 1.0,
        burstSize,
      });

      // Run the concurrency execution 10 times to ensure safety against intermittent race conditions
      for (let iteration = 1; iteration <= 10; iteration++) {
        // Clear Redis state for this client before each iteration
        await redis.del(`bucket:${clientKey}`);

        const numRequests = 50;
        const promises = Array.from({ length: numRequests }, () =>
          request(testApp).post(`/check/${clientKey}`)
        );

        const responses = await Promise.all(promises);

        const allowedCount = responses.filter((res) => res.body.allowed === true).length;
        const deniedCount = responses.filter((res) => res.body.allowed === false).length;

        // Log iteration results to satisfy "show me actual pass/fail output across all iterations"
        console.log(`[CONCURRENCY TEST] Iteration ${iteration}: allowed=${allowedCount}, denied=${deniedCount}`);

        expect(allowedCount).toBe(burstSize);
        expect(deniedCount).toBe(numRequests - burstSize);
      }
    });

    it("should process concurrent requests for SLIDING_WINDOW without race conditions (exactly limit requests allowed)", async () => {
      const clientKey = "concurrency-sliding-client";
      const limit = 20;

      await upsertClientConfig(clientKey, {
        algorithm: Algorithm.SLIDING_WINDOW,
        requestsPerSecond: 1.0, // unused
        burstSize: limit, // limit
        windowMs: 1000,
      });

      // Run the concurrency execution 10 times to ensure safety against intermittent race conditions
      for (let iteration = 1; iteration <= 10; iteration++) {
        // Clear Redis state for this client before each iteration
        await redis.del(`bucket:sw:${clientKey}`);

        const numRequests = 50;
        const promises = Array.from({ length: numRequests }, () =>
          request(testApp).post(`/check/${clientKey}`)
        );

        const responses = await Promise.all(promises);

        const allowedCount = responses.filter((res) => res.body.allowed === true).length;
        const deniedCount = responses.filter((res) => res.body.allowed === false).length;

        // Log iteration results
        console.log(`[SLIDING WINDOW CONCURRENCY TEST] Iteration ${iteration}: allowed=${allowedCount}, denied=${deniedCount}`);

        expect(allowedCount).toBe(limit);
        expect(deniedCount).toBe(numRequests - limit);
      }
    });
  });

  describe("Rate Limit HTTP Headers Integration Tests", () => {
    it("should set correct X-RateLimit headers for TOKEN_BUCKET client on ALLOW and ensure Retry-After is absent", async () => {
      await request(testApp)
        .post("/admin/clients/tb-header-client")
        .send({
          algorithm: "TOKEN_BUCKET",
          requestsPerSecond: 1.0,
          burstSize: 5,
        });

      const res = await request(testApp).post("/check/tb-header-client");
      expect(res.status).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBe("5");
      expect(res.headers["x-ratelimit-remaining"]).toBe("4");
      expect(res.headers["x-ratelimit-reset"]).toBeDefined();
      
      // Assert X-RateLimit-Reset is in Unix seconds (e.g. 10 digits long, not 13 ms digits)
      const resetHeader = res.headers["x-ratelimit-reset"];
      expect(resetHeader.length).toBeLessThanOrEqual(10);
      expect(Number(resetHeader)).toBeGreaterThan(0);
      
      // Assert Retry-After is absent on ALLOW response
      expect(res.headers["retry-after"]).toBeUndefined();
    });

    it("should set Retry-After on DENY for TOKEN_BUCKET and verify remaining is 0", async () => {
      await request(testApp)
        .post("/admin/clients/tb-deny-client")
        .send({
          algorithm: "TOKEN_BUCKET",
          requestsPerSecond: 0.5,
          burstSize: 2,
        });

      // Consume 2 tokens (capacity is 2)
      await request(testApp).post("/check/tb-deny-client");
      await request(testApp).post("/check/tb-deny-client");

      // 3rd request should be denied
      const res = await request(testApp).post("/check/tb-deny-client");
      expect(res.status).toBe(200);
      expect(res.body.allowed).toBe(false);
      expect(res.headers["x-ratelimit-remaining"]).toBe("0");
      expect(res.headers["x-ratelimit-limit"]).toBe("2");
      expect(res.headers["x-ratelimit-reset"]).toBeDefined();
      
      // Assert Retry-After is present, positive integer, and matches resetAt diff
      expect(res.headers["retry-after"]).toBeDefined();
      const retryAfter = Number(res.headers["retry-after"]);
      expect(retryAfter).toBeGreaterThan(0);
      
      // Math check:
      const resetAtMs = res.body.resetAt;
      const expectedRetryAfter = Math.max(0, Math.ceil((resetAtMs - Date.now()) / 1000));
      expect(retryAfter).toBeGreaterThanOrEqual(expectedRetryAfter - 1);
      expect(retryAfter).toBeLessThanOrEqual(expectedRetryAfter + 1);
    });

    it("should set correct headers for SLIDING_WINDOW client on both ALLOW and DENY", async () => {
      await request(testApp)
        .post("/admin/clients/sw-header-client")
        .send({
          algorithm: "SLIDING_WINDOW",
          requestsPerSecond: 1.0,
          burstSize: 2,
          windowMs: 5000,
        });

      // 1st request (ALLOW)
      const res1 = await request(testApp).post("/check/sw-header-client");
      expect(res1.status).toBe(200);
      expect(res1.headers["x-ratelimit-limit"]).toBe("2");
      expect(res1.headers["x-ratelimit-remaining"]).toBe("1");
      expect(res1.headers["x-ratelimit-reset"]).toBeDefined();
      expect(res1.headers["retry-after"]).toBeUndefined();

      // 2nd request (ALLOW)
      const res2 = await request(testApp).post("/check/sw-header-client");
      expect(res2.status).toBe(200);
      expect(res2.headers["x-ratelimit-remaining"]).toBe("0");

      // 3rd request (DENY)
      const res3 = await request(testApp).post("/check/sw-header-client");
      expect(res3.status).toBe(200);
      expect(res3.body.allowed).toBe(false);
      expect(res3.headers["x-ratelimit-limit"]).toBe("2");
      expect(res3.headers["x-ratelimit-remaining"]).toBe("0");
      expect(res3.headers["x-ratelimit-reset"]).toBeDefined();
      expect(res3.headers["retry-after"]).toBeDefined();
      
      const retryAfter = Number(res3.headers["retry-after"]);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(5); // window is 5s
    });

    it("should omit X-RateLimit headers and Retry-After but keep X-RateLimiter-Bypassed in degraded/fail-open mode", async () => {
      await upsertClientConfig("fail-header-client", {
        algorithm: Algorithm.TOKEN_BUCKET,
        requestsPerSecond: 1.0,
        burstSize: 5,
      });

      // Spy on redisRepository.checkAndConsume to throw an error
      const checkAndConsumeSpy = vi.spyOn(redisRepository, "checkAndConsume").mockRejectedValue(new Error("Redis connection timeout"));

      try {
        const res = await request(testApp).post("/check/fail-header-client");
        expect(res.status).toBe(200);
        expect(res.headers["x-ratelimiter-bypassed"]).toBe("true");
        
        // Verify Option A: all standard rate-limit headers are omitted
        expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
        expect(res.headers["x-ratelimit-remaining"]).toBeUndefined();
        expect(res.headers["x-ratelimit-reset"]).toBeUndefined();
        expect(res.headers["retry-after"]).toBeUndefined();
      } finally {
        checkAndConsumeSpy.mockRestore();
      }
    });

    it("should verify the X-RateLimit-Reset unit conversion explicitly (milliseconds to Unix seconds)", async () => {
      await request(testApp)
        .post("/admin/clients/tb-unit-client")
        .send({
          algorithm: "TOKEN_BUCKET",
          requestsPerSecond: 1.0,
          burstSize: 5,
        });

      const res = await request(testApp).post("/check/tb-unit-client");
      expect(res.status).toBe(200);
      
      const resetAtMs = res.body.resetAt; // Internal ms
      const resetHeader = Number(res.headers["x-ratelimit-reset"]); // Unix seconds
      
      expect(resetHeader).toBe(Math.ceil(resetAtMs / 1000));
    });
  });
});
