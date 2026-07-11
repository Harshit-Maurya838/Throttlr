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

### Known Limitations (Phase 3)

- **Unprotected Admin Endpoints**: Admin routes currently have no authentication or API-key protection.
- **Refund-Gap on Redis Write Failure**: A failed Redis write after a successful token consumption causes the next check to re-read stale state, effectively refunding that request. Resolved in Phase 4 via atomic Lua script execution.
- **No TTL on Redis Bucket Keys**: Bucket keys in Redis have no TTL — an accepted tradeoff for now, meaning unbounded growth across many distinct clients is not yet addressed.
- **Unsupported Sliding Window Enforcement**: While `SLIDING_WINDOW` client configurations are accepted and stored, the check API will return `501 Not Implemented` if evaluated.

## Features

### Currently Implemented

- **Token Bucket Algorithm**: Mathematical token bucket limiter supporting fractional token accumulation and temporal refill.
- **Per-Client Dynamic Configurations**: Dynamically configures rate limit capacities and refill rates per client key via PostgreSQL database records.
- **Redis-Backed Persistence (State Survives Restart)**: Transient token bucket states are stored in Redis, ensuring state survives service restarts. Configuration changes made to active buckets take effect immediately (no restart or manual eviction needed) since bucket state is no longer cached in-memory.
- **Client Configuration APIs**: `POST /admin/clients/:clientKey` and `GET /admin/clients/:clientKey` endpoints to manage rate limiter parameters.
- **In-Memory Bucket Store**: Non-persistent in-memory store caching active client buckets (used as a testing/development seam).
- **Rate Limit Check API**: POST `/check/:clientKey` route for evaluating request admissibility.
- **Docker Infrastructure**: Multi-container setup orchestrating local PostgreSQL 16 and Redis 7 instances.
- **Health Check Endpoint**: `/health` API for checking DB and Redis client connectivity status.

### Planned / Roadmap

- **Sliding Window Log Algorithm**: Sliding window counter-based rate-limiting mode. _(Note: client configurations are accepted, but checks on `SLIDING_WINDOW` clients return `501 Not Implemented` until Phase 5)_.
- **Atomic Lua Scripting**: Atomic check-and-consume operations executed directly in Redis to avoid concurrency race conditions.
- **Rate Limit Headers**: Return RFC-compliant headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) on checks.
- **Load Testing & Benchmarking Suite**: Complete benchmarking suites for validating performance under load.

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
  2. Perform rate limit checks:
     ```bash
     curl -i -X POST http://localhost:3000/check/my-service
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
     >   "remaining": 4,
     >   "limit": 5,
     >   "resetAt": 1720743501000
     > }
     > ```

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
- [ ] Phase 4: Concurrency Safety via Lua Scripts
- [ ] Phase 5: Sliding Window Log Algorithm
- [ ] Phase 6: Standard Rate Limit Headers
- [ ] Phase 7: Load Testing & Performance Benchmarks

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
