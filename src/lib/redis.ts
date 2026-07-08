import { createClient } from "redis";
import { env } from "../config/env";

export const redis = createClient({
  url: env.REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => {
      // log retry attempts
      console.warn(`Redis connection retry attempt #${retries}`);
      // reconnect every 2 seconds
      return 2000;
    },
  },
});

redis.on("connect", () => {
  console.log("Redis client: connection initiated.");
});

redis.on("ready", () => {
  console.log("Redis client: connection established and ready.");
});

redis.on("error", (err) => {
  console.error("Redis client error:", err);
});

redis.on("end", () => {
  console.log("Redis client: connection closed.");
});
