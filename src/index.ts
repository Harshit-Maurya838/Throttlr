import express from "express";
import { env } from "./config/env";
import { redis } from "./lib/redis";
import { prisma } from "./lib/prisma";
import healthRouter from "./routes/health";
import checkRouter from "./routes/check";
import adminRouter from "./routes/admin";

const app = express();

app.use(express.json());

// routers
app.use(healthRouter);
app.use(checkRouter);
app.use(adminRouter);

// bootstrap dependencies and start server
async function startServer() {
  try {
    // connection to Redis
    console.log("Connecting to Redis server...");
    await redis.connect();

    // verify database connectivity
    console.log("Connecting to PostgreSQL database...");
    await prisma.$connect();
    console.log("PostgreSQL connection verified.");

    app.listen(env.PORT, () => {
      console.log(
        `Rate Limiter Service successfully listening on port ${env.PORT} in ${env.NODE_ENV} mode.`,
      );
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// handle clean resource shutdown
async function gracefulShutdown(signal: string) {
  console.log(`Received ${signal}. Starting graceful shutdown...`);

  try {
    if (redis.isOpen) {
      console.log("Closing Redis connection...");
      await redis.quit();
    }

    console.log("Disconnecting Prisma Client...");
    await prisma.$disconnect();

    console.log("Graceful shutdown completed.");
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

startServer();
