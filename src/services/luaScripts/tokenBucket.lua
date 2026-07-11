-- KEYS[1] = bucket:{clientKey}
-- ARGV[1] = capacity (number)
-- ARGV[2] = refillRatePerSecond (number)
-- ARGV[3] = now (milliseconds)
-- ARGV[4] = requested tokens (number, default: 1)
--
-- Replicates the logic from TokenBucket.tryConsume (src/core/tokenBucket.ts)
-- Explicitly cross-referenced: if the refill formula or consumption logic
-- changes in tokenBucket.ts, it must be synchronized here as well.

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4]) or 1

-- Fetch existing state from Redis
local state = redis.call('HMGET', key, 'tokens', 'lastRefillTimestamp')
local tokens = tonumber(state[1])
local lastRefillTimestamp = tonumber(state[2])

if not tokens or not lastRefillTimestamp then
  -- Fresh initialization
  tokens = capacity
  lastRefillTimestamp = now
else
  -- Calculate elapsed time and refill
  local elapsedMs = math.max(0, now - lastRefillTimestamp)
  local elapsedSeconds = elapsedMs / 1000.0
  tokens = math.min(capacity, tokens + (elapsedSeconds * refillRate))
  lastRefillTimestamp = now
end

local allowed = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
end

-- Save updated state back to Redis
redis.call('HMSET', key, 'tokens', tostring(tokens), 'lastRefillTimestamp', tostring(lastRefillTimestamp))

-- Calculate resetAt (when the bucket will be completely full again)
local missingTokens = capacity - tokens
local secondsToRefill = missingTokens / refillRate
local resetAt = math.ceil(now + (secondsToRefill * 1000.0))

-- Return allowed (1/0), remaining (floored tokens), resetAt
-- All returned values are integers in Lua and safely cast to integers/JS numbers.
return { allowed, math.floor(tokens), resetAt }
