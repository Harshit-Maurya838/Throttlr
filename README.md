# Throttlr

A standalone, networked rate-limiting service exposing token bucket and sliding window algorithms over HTTP.

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node Version](https://img.shields.io/badge/node-%3E%3D20.0.0-blue)](#)

## Why This Exists

Throttlr is deliberately designed and implemented as a standalone networked service rather than an importable library. While rate-limiting libraries are common, executing rate limiting as a shared network utility presents more interesting and complex engineering challenges:

- **Shared State**: Scaling API instances horizontally requires rate-limiting state to be shared consistently without local memory silos.
- **Race Conditions**: Concurrent requests targeting the same client key can trigger race conditions (e.g., double-spend, over-allocation of tokens) at high volumes.
- **Persistence across Restarts**: Dynamic state must survive service restarts and infrastructure updates without interrupting active traffic windows.

## Architecture Overview

Throttlr runs as a centralized shared infrastructure. Consuming APIs and services check client limits by making HTTP POST requests to Throttlr. Rate-limit limits and algorithm selection rules are stored durably in PostgreSQL and queried via Prisma, while active token allocations and window states are evaluated at sub-millisecond speeds in Redis.

```
           ┌───────────┐
           │  Client   │
           └─────┬─────┘
                 │ (HTTP POST /check/:clientKey)
                 ▼
          ┌─────────────┐
          │  Throttlr   │
          │     API     │
          └──────┬──────┘
                 │
         ┌───────┴───────┐
         ▼               ▼
  ┌─────────────┐ ┌─────────────┐
  │    Redis    │ │ PostgreSQL  │
  │ (Live State │ │ (Client     │
  │  & Buckets) │ │ Configs)    │
  └─────────────┘ └─────────────┘
```

### Known Limitations

- **Unprotected Admin Endpoints**: Admin routes currently have no authentication or API-key protection.
- **Uncached Database Configuration**: For every check request, the service queries PostgreSQL to read the client's rate-limiting config. This introduces a read bottleneck at extremely high scale.
- **No TTL on Redis Bucket Keys**: Rate limit state keys in Redis do not have an expiration (TTL), meaning inactive or deprecated client keys are never automatically evicted.

## Features

### Implemented

- **Token Bucket Algorithm**: Mathematical token bucket limiter supporting fractional token accumulation and temporal refill.
- **Sliding Window Counter Algorithm**: Memory-efficient sliding window counter approximation that prevents boundary-reset bursts with O(1) space complexity.
- **Per-Client Dynamic Configurations**: Dynamically configures rate limit capacities, refill rates, and window parameters per client key via PostgreSQL database records.
- **Redis-Backed Persistence**: Transient rate-limiter states are stored in Redis, ensuring state survives service restarts. Configuration changes made to active limits take effect immediately.
- **Concurrency & Atomicity**: All rate-limit evaluations and writes are executed inside atomic Redis Lua scripts to eliminate race conditions under concurrent requests.
- **Standard Rate Limit Headers**: Returns standard HTTP headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`) on all checks. Denied requests return an `HTTP 429 Too Many Requests` status code along with a `Retry-After` header.
- **Fail-Open Resilience**: Gracefully falls back to ALLOW (fail-open) if Redis is unavailable, returning `X-RateLimiter-Bypassed: true`.
- **Client Configuration APIs**: `POST /admin/clients/:clientKey` and `GET /admin/clients/:clientKey` endpoints to manage rate limiter parameters.
- **Health Check Endpoint**: `/health` API for checking DB and Redis client connectivity status.

## Load Testing & Performance

Throttlr has been load-tested under sustained high-throughput conditions utilizing k6. The service successfully sustained a peak throughput of 550 RPS with zero HTTP 5xx errors and a p95 latency under 4.8ms. A 1,000 VU concurrent correctness suite run 5 sequential times verified that the rate-limiter is completely race-condition-safe, allowing exactly 100 requests and denying exactly 900. For full methodology and findings, see the [LOAD_TEST_REPORT.md](LOAD_TEST_REPORT.md).

## Tech Stack

- **Runtime**: Node.js
- **Language**: TypeScript
- **Web Framework**: Express
- **Database**: PostgreSQL (via Prisma ORM)
- **Caching & State**: Redis
- **Containerization**: Docker Compose
- **Testing**: Vitest

## Getting Started

### Prerequisites

- Docker & Docker Compose
- Node.js >= 20.0.0

### Setup

1. **Clone the Repository**

   ```bash
   git clone https://github.com/Harshit-Maurya838/Throttlr
   cd rate-limiter-service
   ```

2. **Configure Environment Variables**

   ```bash
   cp .env.example .env
   ```

3. **Start Infrastructure Containers**

   ```bash
   docker compose up -d
   ```

4. **Install Dependencies**

   ```bash
   npm install
   ```

5. **Run Migrations**

   ```bash
   npx prisma migrate dev
   ```

6. **Run Development Server**
   ```bash
   npm run dev
   ```

### Verifying Service

- **Health Check**:

  ```bash
  curl http://localhost:3000/health
  ```

- **Rate Limit Check Flow**:
  1. Register or update the client configuration via the admin endpoint:
     ```bash
     curl -i -X POST -H "Content-Type: application/json" \
       -d '{"algorithm": "TOKEN_BUCKET", "requestsPerSecond": 2.0, "burstSize": 5}' \
       http://localhost:3000/admin/clients/my-service
     ```
  2. Perform rate limit checks (Allowed):
     ```bash
     curl -i -X POST http://localhost:3000/check/my-service
     ```

     Example allowed response:
     ```http
     HTTP/1.1 200 OK
     X-RateLimit-Limit: 5
     X-RateLimit-Remaining: 4
     X-RateLimit-Reset: 1783987910
     Content-Type: application/json

     {
       "allowed": true,
       "remaining": 4,
       "limit": 5,
       "resetAt": 1783987909789
     }
     ```

  3. Perform check when rate limit is exceeded (Denied):
     ```bash
     curl -i -X POST http://localhost:3000/check/my-service
     ```

     Example denied response:
     ```http
     HTTP/1.1 429 Too Many Requests
     X-RateLimit-Limit: 5
     X-RateLimit-Remaining: 0
     X-RateLimit-Reset: 1783987910
     Retry-After: 3
     Content-Type: application/json

     {
       "allowed": false,
       "remaining": 0,
       "limit": 5,
       "resetAt": 1783987909789
     }
     ```

     > [!NOTE]
     > During Redis outages or write failures, the service operates in a **fail-open** mode. The response includes an `X-RateLimiter-Bypassed: true` HTTP header, signaling a degraded state while allowing the request by default.
     >
     > Example degraded response:
     > ```http
     > HTTP/1.1 200 OK
     > Content-Type: application/json
     > X-RateLimiter-Bypassed: true
     > 
     > {
     >   "allowed": true,
     >   "remaining": 5,
     >   "limit": 5,
     >   "resetAt": 1783987909789
     > }
     > ```

## Usage & Integration Guide

Throttlr is designed to run as shared infrastructure rather than an application-level library. Consuming backend services call Throttlr before processing a request, similar to querying a database or a cache. It acts as a gatekeeper: it does not serve the end-user traffic directly but informs the consuming service whether a given client key has exceeded its limits.

### 1. One-Time Client Registration

Before a client key can be checked, its rate-limiting configuration must be registered. This is typically a one-time setup step executed during service provisioning or deployment, rather than dynamically on a per-request basis.

To register a client named `public-signup-api` using the `TOKEN_BUCKET` algorithm with a capacity of 100 and a refill rate of 10 tokens per second:

```bash
curl -i -X POST -H "Content-Type: application/json" \
  -d '{"algorithm": "TOKEN_BUCKET", "requestsPerSecond": 10.0, "burstSize": 100}' \
  http://localhost:3000/admin/clients/public-signup-api
```

> [!WARNING]
> Admin routes are currently unauthenticated (see [Known Limitations](#known-limitations)). Do not expose the `/admin` endpoints to the public internet.

### 2. Checking Limits Before Gated Requests

For each incoming request, the consuming backend service makes a POST request to `/check/:clientKey` to verify if the request should proceed.

```bash
curl -i -X POST http://localhost:3000/check/public-signup-api
```

#### Allowed Response (HTTP 200 OK)
Returned when the client has remaining quota.

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1783987910

{
  "allowed": true,
  "remaining": 99,
  "limit": 100,
  "resetAt": 1783987909789
}
```

#### Denied Response (HTTP 429 Too Many Requests)
Returned when the client has exhausted their quota. The `Retry-After` header indicates the minimum number of seconds to wait before retrying.

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1783987910
Retry-After: 5

{
  "allowed": false,
  "remaining": 0,
  "limit": 100,
  "resetAt": 1783987909789
}
```

### 3. Example Middleware Integration

Consuming backend services written in Node.js/TypeScript can protect endpoints by wrapping the rate-limit check in a custom Express middleware:

```typescript
import { Request, Response, NextFunction } from 'express';

const THROTTLR_URL = process.env.THROTTLR_URL || 'http://localhost:3000';

export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  // Derive a unique client key (e.g., from an API key header or client IP)
  const clientKey = req.header('x-api-key') || req.ip || 'anonymous';

  try {
    const response = await fetch(`${THROTTLR_URL}/check/${clientKey}`, {
      method: 'POST'
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) {
        res.setHeader('Retry-After', retryAfter);
      }
      res.status(429).json({ error: 'Too Many Requests' });
      return; // Short-circuit the request pipeline
    }

    // For 200 OK (or other non-429 status codes), allow the request to proceed
    next();
  } catch (error) {
    // FAIL-OPEN: If Throttlr is down/unreachable, fail open to prevent
    // cascading failures in the primary service, matching Throttlr's internal philosophy.
    console.error('Throttlr rate-limiter unreachable, failing open:', error);
    next();
  }
}
```

## Running Tests

To run the Vitest unit tests:

```bash
npm test
```

## Project Structure

```
rate-limiter-service/
├── prisma/             # Prisma database schema definition and migration files
└── src/
    ├── config/         # Configuration loaders and environment validations
    ├── core/           # Core rate-limiting algorithm definitions and unit tests
    ├── lib/            # External database and cache connection singletons
    ├── routes/         # Express API endpoint route definitions
    └── services/       # Core business logic orchestrators
```

## Roadmap

- [x] Phase 0: Project Setup & Architecture
- [x] Phase 1: Core Token Bucket Algorithm (In-Memory)
- [x] Phase 2: PostgreSQL Dynamic Configuration Integration
- [x] Phase 3: Redis-Backed State Store
- [x] Phase 4: Concurrency Safety via Lua Scripts
- [x] Phase 5: Sliding Window Log Algorithm
- [x] Phase 6: Standard Rate Limit Headers
- [x] Phase 7: Load Testing & Performance Benchmarks
- [ ] Stretch Goal: Distributed clustering & synchronization
- [ ] Stretch Goal: Real-time traffic dashboard

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
