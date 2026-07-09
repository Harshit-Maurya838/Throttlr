import { describe, it, expect, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { prisma } from "../../lib/prisma";
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

describe("Phase 2 Integration & Unit Tests", () => {
  // Clear database and in-memory bucket store before each test to ensure isolation
  beforeEach(async () => {
    clearBuckets();
    await prisma.clientConfig.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
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

    it("should throw NotImplementedError if client is configured with SLIDING_WINDOW", async () => {
      await upsertClientConfig("sliding-client", {
        algorithm: Algorithm.SLIDING_WINDOW,
        requestsPerSecond: 2.0,
        burstSize: 5,
        windowMs: 60000,
      });

      await expect(getOrCreateBucket("sliding-client")).rejects.toThrow(
        NotImplementedError
      );
    });

    it("should create and cache a TokenBucket with correct limits if configured with TOKEN_BUCKET", async () => {
      await upsertClientConfig("token-client", {
        algorithm: Algorithm.TOKEN_BUCKET,
        requestsPerSecond: 3.5,
        burstSize: 7,
      });

      const bucket = await getOrCreateBucket("token-client");
      expect(bucket.capacity).toBe(7);
      expect(bucket.refillRatePerSecond).toBe(3.5);

      // Verify caching: modify database config, but ensure the cached instance is still returned
      await upsertClientConfig("token-client", {
        algorithm: Algorithm.TOKEN_BUCKET,
        requestsPerSecond: 100,
        burstSize: 200,
      });

      const cachedBucket = await getOrCreateBucket("token-client");
      expect(cachedBucket.capacity).toBe(7); // unchanged due to in-memory caching
      expect(cachedBucket.refillRatePerSecond).toBe(3.5);
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

    it("POST /check/:clientKey should return 501 if client is configured with SLIDING_WINDOW", async () => {
      // Add sliding window config
      await request(testApp)
        .post("/admin/clients/sliding-key")
        .send({
          algorithm: "SLIDING_WINDOW",
          requestsPerSecond: 2.0,
          burstSize: 5,
          windowMs: 1000,
        });

      const res = await request(testApp).post("/check/sliding-key");
      expect(res.status).toBe(501);
      expect(res.body.error).toContain("SLIDING_WINDOW algorithm is not implemented yet");
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
  });
});
