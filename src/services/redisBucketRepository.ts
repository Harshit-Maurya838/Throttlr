import { redis } from "../lib/redis";
import * as fs from "fs";
import * as path from "path";

export interface RedisBucketState {
  tokens: number;
  lastRefillTimestamp: number;
}

export interface CheckConsumeResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

let scriptSha: string | null = null;
let scriptContent: string = "";
const scriptPath = path.join(__dirname, "luaScripts", "tokenBucket.lua");

function loadScriptContent(): string {
  if (!scriptContent) {
    scriptContent = fs.readFileSync(scriptPath, "utf-8");
  }
  return scriptContent;
}

async function getOrLoadSha(): Promise<string> {
  if (!scriptSha) {
    const content = loadScriptContent();
    scriptSha = await redis.scriptLoad(content);
  }
  return scriptSha;
}

/**
 * Executes the atomic check-and-consume Lua script on Redis.
 * Falls back to EVAL if EVALSHA returns NOSCRIPT.
 */
export async function checkAndConsume(
  clientKey: string,
  capacity: number,
  refillRatePerSecond: number,
  now: number,
  tokensRequested: number = 1
): Promise<CheckConsumeResult> {
  const key = `bucket:${clientKey}`;
  const sha = await getOrLoadSha();
  const content = loadScriptContent();

  let response: any;
  try {
    response = await redis.evalSha(sha, {
      keys: [key],
      arguments: [
        capacity.toString(),
        refillRatePerSecond.toString(),
        now.toString(),
        tokensRequested.toString(),
      ],
    });
  } catch (error: any) {
    if (error.message && error.message.includes("NOSCRIPT")) {
      response = await redis.eval(content, {
        keys: [key],
        arguments: [
          capacity.toString(),
          refillRatePerSecond.toString(),
          now.toString(),
          tokensRequested.toString(),
        ],
      });
    } else {
      throw error;
    }
  }

  if (!Array.isArray(response) || response.length < 3) {
    throw new Error(`Unexpected response structure from Redis Lua script: ${JSON.stringify(response)}`);
  }

  const allowed = response[0] === 1;
  const remaining = typeof response[1] === "number" ? response[1] : parseInt(response[1], 10);
  const resetAt = typeof response[2] === "number" ? response[2] : parseInt(response[2], 10);

  return {
    allowed,
    remaining,
    resetAt,
  };
}

/**
 * Reads the bucket state from Redis hash.
 * 
 * Redis key: `bucket:{clientKey}`
 * Fields: `tokens` (string representation of float) and `lastRefillTimestamp` (string representation of integer)
 * 
 * Returns null if the key doesn't exist (i.e. the returned object is empty).
 */
export async function getBucketState(clientKey: string): Promise<RedisBucketState | null> {
  const key = `bucket:${clientKey}`;
  const data = await redis.hGetAll(key);
  
  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  const tokens = parseFloat(data.tokens);
  const lastRefillTimestamp = parseInt(data.lastRefillTimestamp, 10);

  // If parsing fails for some reason, treat as non-existent to avoid corrupt state
  if (isNaN(tokens) || isNaN(lastRefillTimestamp)) {
    return null;
  }

  return {
    tokens,
    lastRefillTimestamp,
  };
}

/**
 * Saves the bucket state to Redis using HSET.
 * 
 * NOTE: There is no TTL/expiry on these keys for now, meaning a client's bucket state will persist indefinitely.
 * Unbounded key growth for many distinct clientKeys is an accepted tradeoff for this phase,
 * worth revisiting later (e.g. TTL + rehydrate-from-Postgres-config pattern) if it ever becomes a real concern.
 */
export async function saveBucketState(clientKey: string, state: RedisBucketState): Promise<void> {
  const key = `bucket:${clientKey}`;
  await redis.hSet(key, {
    tokens: state.tokens.toString(),
    lastRefillTimestamp: state.lastRefillTimestamp.toString(),
  });
}
