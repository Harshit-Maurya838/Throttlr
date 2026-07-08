# Architecture Design - Standalone Token Bucket Rate Limiter Service

This document defines the architectural decisions, constraints, and operational design patterns for the Rate Limiter Service.

## 1. Storage & State Management Split (PostgreSQL vs. Redis)

The rate limiter service separates static configuration state from dynamic rate-limiting state based on their durability and latency needs.

```
                  ┌───────────────────────────┐
                  │   Rate Limiter Service    │
                  └─────────────┬─────────────┘
                                │
               ┌────────────────┴────────────────┐
        (Write: Rare)                     (Write: High Vol)
        (Read: Cached)                     (Read: High Vol)
        (Latency: ~5-10ms)                 (Latency: <1ms)
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
- **Data Stored**: Client configurations (e.g. rate limits, burst sizes, algorithm choices, timestamps).
- **Tradeoffs**:
  - *Durability & Consistency*: Relational integrity ensures configurations are safely persisted, queryable, and auditable.
  - *Latency*: Postgres read latency (typically 5–15ms) is too slow to evaluate on every single HTTP API call.
  - *Access Pattern*: Configs are read once when initializing/refreshing a client configuration cache and written only when limits change.

### Redis
- **Role**: High-speed store for **Active Bucket/Window State**.
- **Data Stored**: Transient state (e.g. token counts, last refresh times, window request counters).
- **Tradeoffs**:
  - *Latency*: In-memory operation provides `<1ms` read/write times, ensuring the rate limiter overhead on the API path is negligible.
  - *Durability*: Relies on **AOF (Append Only File) persistence** (`appendonly yes`). If Redis restarts, state is recovered. We prioritize execution speed and accept that transient rate-limiting state can occasionally be slightly out-of-sync compared to absolute consistency.

---

## 2. Resilience and Failure Mode (Fail-Open vs. Fail-Closed)

When the Redis connection goes down or is unreachable, the rate limiter must decide how to handle incoming traffic evaluation.

### Decision: Fail-Open
If the rate limiting state store (Redis) is unreachable, the system will **default to ALLOW (Fail-Open)**.

#### Rationale
1. **Prevent Cascading Outages**: A rate limiter is a secondary control plane. If it degrades, blocking all legitimate incoming client traffic (Fail-Closed) translates to a total system outage for downstream consumers. 
2. **Graceful Degradation**: Running without active rate limiting during an infrastructure failure is preferable to denying service to 100% of customers.
3. **Operational Implementation**:
   - The route handler catches Redis connection timeouts/errors.
   - It fires immediate alerts (logs/metrics/notifications) to notify the operations team.
   - It responds with a header/metadata signifying a degraded or bypassed state (e.g. `X-RateLimiter-Bypassed: true`).
   - *Future Configs*: This behavior will be configurable (per client or globally) in subsequent phases to support clients that require strict security/costs enforcement where Fail-Closed is preferred.

---

## 3. Concurrency & Atomicity (Lua Scripts Constraint)

To prevent race conditions (e.g., double spend, concurrent token updates from identical client keys at the same microsecond), operations must be atomic.

### Constraints & Strategy
- **Mechanism**: All rate evaluation and token update steps will be implemented directly inside **Redis Lua scripts** (`EVAL` / `EVALSHA`).
- **Why**: 
  - Redis executes Lua scripts in a single-threaded block, guaranteeing that no other command can run while the script is evaluating.
  - Doing atomic updates inside Redis prevents network round-trips from the node application (e.g. read tokens -> check -> update tokens) that lead to race conditions.
  - This avoids application-level distributed locks (e.g., Redlock), which add latency and complexity.
- **Architectural Directive**: No code in any phase should implement node-side locking or step-by-step read-then-write logic for updating bucket tokens.
