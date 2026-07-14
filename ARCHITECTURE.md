# Architecture Design - Standalone Rate Limiter Service

This document defines the architectural decisions, constraints, and operational design patterns for the Rate Limiter Service.

---

## 1. Storage & State Management Split (PostgreSQL vs. Redis)

The rate limiter service separates static configuration state from dynamic rate-limiting state based on their durability and latency needs.

```
                  ┌───────────────────────────┐
                  │   Rate Limiter Service    │
                  └─────────────┬─────────────┘
                                │
               ┌────────────────┴────────────────┐
        (Write: Rare)                     (Write: High Vol)
        (Read: High Vol, Uncached)         (Read: High Vol)
        (Latency: ~2-5ms)                  (Latency: <1ms)
               ▼                                 ▼
   ┌───────────────────────┐         ┌───────────────────────┐
   │ PostgreSQL (Prisma)   │         │    Redis (In-Memory)  │
   │ ─── ─── ─── ─── ───   │         │    ─── ─── ─── ───    │
   │  Client Configurations│         │   Active Bucket State │
   │   (Limits, Enums)     │         │   (Tokens, Windows)   │
   └───────────────────────┘         └───────────────────────┘
```

### PostgreSQL (via Prisma)
- **Role**: Source of truth for **Client Configurations**.
- **Data Stored**: Client configurations (e.g. rate limits, burst sizes, algorithm choices, window durations).
- **Tradeoffs**:
  - *Durability & Consistency*: Relational integrity ensures configurations are safely persisted, queryable, and auditable.
  - *Latency*: Postgres read latency (typically 2–5ms in the local setup) is slower than Redis.
  - *Access Pattern*: Configs are read on every `/check` call, making PostgreSQL reads uncached. This is a known bottleneck at extreme scale (see Performance Characteristics).

### Redis
- **Role**: High-speed store for **Active Bucket/Window State**.
- **Data Stored**: Transient rate limiter state (e.g. token counts, last refresh times, window request counters).
- **Tradeoffs**:
  - *Latency*: In-memory operation provides `<1ms` execution times, ensuring the rate limiter overhead on the API path is negligible.
  - *Durability*: Relies on Redis persistence. If Redis restarts, state is recovered. We prioritize execution speed and accept that transient rate-limiting state can occasionally be slightly out-of-sync compared to absolute consistency.

---

## 2. Resilience and Failure Mode (Fail-Open vs. Fail-Closed)

When the Redis connection goes down or is unreachable, the rate limiter must decide how to handle incoming traffic evaluation.

### Decision: Fail-Open (Implemented in Phase 3)
If the rate limiting state store (Redis) is unreachable, the system will **default to ALLOW (Fail-Open)**.

#### Rationale
1. **Prevent Cascading Outages**: A rate limiter is a secondary control plane. If it degrades, blocking all legitimate incoming client traffic (Fail-Closed) translates to a total system outage for downstream consumers.
2. **Graceful Degradation**: Running without active rate limiting during an infrastructure failure is preferable to denying service to 100% of customers.
3. **Operational Implementation**:
   - The route handler catches Redis connection timeouts/errors.
   - It fires immediate alerts (logs/metrics) to notify the operations team.
   - It responds with a header/metadata signifying a degraded or bypassed state (`X-RateLimiter-Bypassed: true`). In this degraded state, standard `X-RateLimit-*` headers are omitted since the system cannot guarantee remaining counts or reset times.

---

## 3. Rate-Limiting Algorithms & Resource Mapping

Throttlr supports two distinct rate-limiting algorithms, mapped to a unified client configuration schema in the database.

### 3.1 Token Bucket Algorithm
- **Math & Behavior**: Accumulates tokens continuously over time at a fractional rate (`requestsPerSecond`), up to a maximum capacity (`burstSize`).
- **Resource Mapping**:
  - `requestsPerSecond` represents the token replenishment rate.
  - `burstSize` represents the maximum capacity of the token bucket.

### 3.2 Sliding Window Counter Algorithm
- **Math & Behavior**: Computes the request rate over a rolling window (`windowMs`) by summing the count in the current window slice and a proportional contribution from the previous window slice.
- **Resource Mapping**:
  - `burstSize` represents the maximum number of requests allowed in the window (the limit).
  - `requestsPerSecond` is validated in the schema but unused during Sliding Window checks.
  - `windowMs` defines the duration of the sliding window.
- **Tradeoff (Counter vs. Log)**: We chose **Sliding Window Counter** (an approximation algorithm) over **Sliding Window Log** (an exact timestamp array).
  - *Sliding Window Log*: Requires storing every request timestamp in Redis (an array or sorted set per client), leading to $O(N)$ memory usage where $N$ is the number of requests.
  - *Sliding Window Counter*: Stores only a few hashes in Redis (the current and previous window count), achieving $O(1)$ memory usage.
  - *Tradeoff Summary*: The counter method has an approximation error of up to 6% during sudden bursts, but the memory footprint remains constant. We prioritize memory efficiency and stability under high throughput over absolute precision.

---

## 4. Concurrency, Atomicity, and Logic Duplication

To prevent race conditions (such as double-spending tokens or exceeding capacity under intense parallel load), evaluations must be atomic.

### 4.1 Redis Lua Scripting (Happy Path)
All rate evaluation and token update steps are implemented directly inside **Redis Lua scripts** (`EVALSHA` loaded eagerly on startup).
- Redis executes Lua scripts in a single-threaded block, guaranteeing that no other command can run while the script is evaluating.
- Doing atomic updates inside Redis prevents network round-trips from the node application (e.g. read state -> check -> write state) that lead to race conditions.

### 4.2 Algorithm Logic Duplication Tradeoff
Because the system must run on two separate execution planes (Redis happy-path vs. application-level Fail-Open path), the rate limiting mathematics are duplicated:
1. **TypeScript Classes**: Implemented in pure code (`src/core/tokenBucket.ts` and `src/core/slidingWindowCounter.ts`). These are used only in-memory when Redis is offline (degraded fail-open path).
2. **Lua Scripts**: Implemented in Redis Lua (`src/services/luaScripts/tokenBucket.lua` and `src/services/luaScripts/slidingWindowCounter.lua`). These are used when Redis is healthy (happy-path).

*Tradeoff*: Any changes to the replenishment or window math must be updated in both places manually. We accept this minor maintenance cost to guarantee both concurrency safety in production and graceful local degradation when Redis is down.

### 4.3 The Write-Failure "Refund-Gap"
- **The Issue (Phase 3)**: Before Lua scripting was introduced in Phase 4, the application performed sequential read-evaluate-write commands. If a Redis write failed after token consumption succeeded, the next check read stale state, effectively "refunding" that request.
- **Happy Path Resolution**: The introduction of the Lua script collapsed the check-and-consume steps into a single transaction, making write-failures on successful evaluations impossible.
- **Fail-Open Path Security**: In degraded fail-open mode, the refund-gap is structurally impossible. Because Redis is down, the system defaults to allowing requests without writing or persisting any state. Since no state transaction is initiated, there is no split-state or "half-written" transaction that can result in an incorrect refund.

---

## 5. Protocol & Denials

### Decision: HTTP 429 for Denials (Implemented in Phase 7)
Rate limit denials return `HTTP 429 Too Many Requests` (a breaking change from early phases which returned `200 OK` with a body flag).

#### Rationale
- **Industry Standard**: Conforms with RFC 6585 and allows client gateways and proxy layers to immediately identify and handle rate limiting without parsing response JSON.
- **Headers**: Denied responses include the standard headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) along with `Retry-After` (integer seconds) indicating how long the client must wait.

---

## 6. Performance Characteristics

### 6.1 Per-Request Cost Stack
For every `/check/:clientKey` request:
1. One PostgreSQL `SELECT` query via Prisma.
2. One Redis `EVALSHA` execution containing the corresponding Lua script.

### 6.2 Benchmarked Latency Metrics
Under a sustained load of 550 requests per second (RPS):
- **Average Latency**: **3.03 ms**
- **95th Percentile (p95)**: **4.80 ms**
- **99th Percentile (p99)**: **<10 ms**
- **Server Errors**: **0.00%**

### 6.3 Anticipated Bottlenecks at Higher Scale (e.g. 5,000+ RPS)
While the service handles 500+ RPS with sub-5ms latencies, scaling to 5,000+ RPS is anticipated to expose the following limits:
1. **PostgreSQL Connection Pool Starvation**: With uncached config reads, database connection pools will saturate. If the pool waits time out, incoming requests will fail.
2. **Redis CPU Key Hot Spotting**: If an extremely active client key receives thousands of requests/sec, Redis will process all operations on a single thread targeting that specific key, limiting CPU core scaling.
3. **Node Event Loop Lag**: High request volumes will increase garbage collection overhead and event loop delay in Express.
