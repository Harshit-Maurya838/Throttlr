# Throttlr Load Testing & Correctness Report

This report presents the findings, methodology, and results of the **test of Performance and Correctness Proofing** for the Throttlr rate-limiting service.

---

## 1. Concurrency Correctness Proof (Atomic Isolation)

### 1.1 Methodology

To verify that the Token Bucket rate-limiting algorithm is immune to concurrency race conditions (such as double-spending tokens or exceeding capacity under intense parallel load), we set up a dedicated test scenario:

- **Client Configuration**: A client named `client-hot-tb` with a capacity of `100` tokens and a negligible refill rate of `0.00001` tokens/second. The tiny refill rate mathematically ensures that no additional tokens are accumulated during the test window.
- **Executor Pattern**: k6's `per-vu-iterations` executor with **1,000 Virtual Users (VUs)**, each executing exactly **1 iteration** concurrently (totaling exactly 1,000 requests sent simultaneously).
- **Multi-run Rigor**: The test was executed for **5 sequential iterations**, clearing the active Redis state (`bucket:client-hot-tb`) before each run.

### 1.2 Mathematical Expectation

$$\text{Expected Allowed} = 100$$
$$\text{Expected Denied (HTTP 429)} = 900$$

Any deviation (e.g., >100 allowed) would indicate a race condition (read-modify-write hazard) in the rate limiter logic.

### 1.3 Results

The correctness proof suite ran 5 iterations with the following results:

| Run #     | Redis Cleared | VUs / Requests | HTTP 200 (Allowed) | HTTP 429 (Denied) | Status     |
| --------- | ------------- | -------------- | ------------------ | ----------------- | ---------- |
| **Run 1** | Yes           | 1,000          | 100                | 900               | **PASSED** |
| **Run 2** | Yes           | 1,000          | 100                | 900               | **PASSED** |
| **Run 3** | Yes           | 1,000          | 100                | 900               | **PASSED** |
| **Run 4** | Yes           | 1,000          | 100                | 900               | **PASSED** |
| **Run 5** | Yes           | 1,000          | 100                | 900               | **PASSED** |

**Conclusion**: The system achieved **100% correctness** across all runs, proving that the Redis Lua script executes atomically and prevents any token over-allocation or double-spending under high concurrency.

---

## 2. Sustained High-Throughput Load Test

### 2.1 Methodology

To evaluate the service's stability and performance under a sustained load of 500+ requests per second, we executed a 45-second ramping arrival rate test:

- **Executor**: `ramping-arrival-rate` targeting a steady throughput of 500–550 RPS.
- **Load Distribution**: Distributed across 20 distinct clients (10 Token Bucket and 10 Sliding Window clients) to simulate multi-tenant production traffic.
- **Validation**: Every response was validated for:
  - Valid HTTP status (200 OK or 429 Too Many Requests).
  - Presence of Rate-Limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`).
  - Presence of the `Retry-After` header on all HTTP 429 responses.
  - Latency within a 200ms ceiling.

### 2.2 Metrics & Results

- **Total Requests Sent**: 19,874
- **Overall Throughput**: 441.63 RPS (including ramp-up/ramp-down), peaking at **550 RPS** during the sustained phase.
- **Response Validation Checks**: 119,244 checks executed / **100% Success Rate** (all headers were present and formatted correctly).
- **System Failure Rate (HTTP 5xx)**: **0.00%** (zero failed requests).
- **Rate-Limiter Denials (HTTP 429)**: 207 requests (1.04% of total traffic).

#### Latency Profile:

- **Average Latency**: **3.03 ms**
- **Median Latency (p50)**: **2.77 ms**
- **p90 Latency**: **4.23 ms**
- **p95 Latency**: **4.80 ms**
- **Maximum Latency**: **30.56 ms**

The service performed exceptionally well, with a 95th percentile latency of **under 5 milliseconds**, vastly exceeding the 200ms target threshold.

---

## 3. Anticipated Bottlenecks at Higher Scale (Not Observed in This Test)

The test successfully completed with 0% system errors and a p95 latency under 5ms. However, based on the current architecture, scaling the service to 5,000+ RPS is anticipated to expose the following limitations:

### 3.1 Uncached PostgreSQL Reads

- **Problem**: For every incoming request to `/check/:clientKey`, the service performs a PostgreSQL query to retrieve the client configuration:
  ```typescript
  const config = await prisma.clientConfig.findUnique({ ... })
  ```
  At 5,000+ RPS, this would issue 5,000+ read operations per second directly to the database.
- **Impact**: While PostgreSQL can handle this load easily, it does not scale well to tens of thousands of requests per second. Database connection pooling and query execution times will eventually degrade and increase latency.

### 3.2 PostgreSQL Connection Pool Saturation
- **Database Connection Pool Details**: The test ran using Prisma's default connection pool size (minimum 10 connections, dynamically sized based on CPU cores).
- **Monitoring Status**: Connection pool wait times and database saturation were *not* actively monitored during this test. However, the low overall latency (<5ms p95) suggests no significant pool starvation occurred at 550 RPS. Under higher scales, pool size must be tuned, and pool wait times must be monitored to prevent starvation.

### 3.3 Single-Key Redis Hot Spot

- **Problem**: In a production environment, if a single client is extremely active, all rate-limiting checks for that client target a single Redis key (e.g. `bucket:client-hot-tb`).
- **Impact**: Redis is single-threaded per command. Routing a massive volume of concurrent operations to a single key limits horizontal scaling, as Redis cannot distribute operations on the same key across multiple cores or cluster nodes.

---

## 4. Recommended Future Optimizations

To scale Throttlr to 10,000+ RPS, we recommend implementing the following optimizations:

1. **In-Memory Caching (LRU)**:
   - Introduce an in-memory cache (e.g., `lru-cache`) in the application layer to cache client configurations from PostgreSQL.
   - Cache configurations for 30–60 seconds, or use database triggers/webhooks to invalidate the cache when a configuration is updated. This will reduce PostgreSQL reads by over 99% without carrying correctness tradeoffs.
2. **Redis Connection Pooling**:
   - Ensure the Redis client uses connection pooling or handles reconnections gracefully under maximum load.
3. **Local State Buffering (Batching)**:
   - For ultra-high throughput environments, allow application nodes to buffer token consumption locally for a few milliseconds before flushing updates atomically to Redis.
   - *Note: Unlike caching and pooling, local state buffering reintroduces a bounded window for token over-allocation (similar to the pre-Lua behavior in Phase 3) and is only appropriate if the target use case tolerates approximate rate limiting at extreme scale.*
