-- KEYS[1] = bucket:sw:{clientKey}
-- ARGV[1] = limit (integer)
-- ARGV[2] = windowMs (integer)
-- ARGV[3] = now (integer milliseconds)
--
-- Replicates the logic from SlidingWindowCounter.tryConsume (src/core/slidingWindowCounter.ts)
-- Explicitly handles integer/float conversions and rolling over windows.
--
-- NUMERIC ENCODING NOTE:
-- All input arguments from ARGV are passed as strings and parsed to numbers using tonumber().
-- The calculations for elapsedMs and overlapFraction are performed using floating-point math
-- (Lua uses double-precision floats for all numbers by default).
-- The weightedCount is a float, but before returning, 'remaining' is floored using math.floor
-- and clamped to 0 using math.max. All returned values are integers in Lua and safely cast to integers/JS numbers.

local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- Fetch existing state from Redis
local state = redis.call('HMGET', key, 'currentWindowStart', 'currentCount', 'previousCount')
local currentWindowStart = tonumber(state[1])
local currentCount = tonumber(state[2])
local previousCount = tonumber(state[3])

-- Calculate the window start for the current request's timestamp
local calculatedWindowStart = math.floor(now / windowMs) * windowMs

if not currentWindowStart or not currentCount or not previousCount then
  -- Fresh initialization
  currentWindowStart = calculatedWindowStart
  currentCount = 0
  previousCount = 0
elseif calculatedWindowStart > currentWindowStart then
  -- Roll window forward
  if calculatedWindowStart == currentWindowStart + windowMs then
    previousCount = currentCount
  else
    previousCount = 0
  end
  currentCount = 0
  currentWindowStart = calculatedWindowStart
end

-- Calculate elapsed time and overlap fraction
local elapsedMs = math.max(0, now - currentWindowStart)
local overlapFraction = 0.0
if windowMs > 0 then
  overlapFraction = math.max(0.0, math.min(1.0, (windowMs - elapsedMs) / windowMs))
end

-- Compute the weighted estimate before the request
local weightedCount = previousCount * overlapFraction + currentCount

local allowed = 0
if weightedCount + 1 <= limit then
  currentCount = currentCount + 1
  allowed = 1
  weightedCount = weightedCount + 1
end

-- Save updated state back to Redis
redis.call('HMSET', key, 
  'currentWindowStart', tostring(currentWindowStart), 
  'currentCount', tostring(currentCount), 
  'previousCount', tostring(previousCount)
)

-- Remaining capacity calculation (limit - final weighted count, floored and clamped to >= 0)
local remaining = math.max(0, math.floor(limit - weightedCount))
local resetAt = currentWindowStart + windowMs

-- Return allowed (1/0), remaining, resetAt
-- All returned values are integers in Lua and safely cast to integers/JS numbers.
return { allowed, remaining, resetAt }
