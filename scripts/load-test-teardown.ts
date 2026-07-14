import { prisma } from "../src/lib/prisma";
import { redis } from "../src/lib/redis";

async function main() {
  console.log("Starting load test cleanup...");

  const testKeys = [
    "client-hot-tb",
    ...Array.from({ length: 10 }, (_, i) => `client-tb-${i + 1}`),
    ...Array.from({ length: 10 }, (_, i) => `client-sw-${i + 1}`),
  ];

  // Delete from PostgreSQL
  const dbResult = await prisma.clientConfig.deleteMany({
    where: {
      clientKey: {
        in: testKeys,
      },
    },
  });
  console.log(`Cleaned up ${dbResult.count} client configurations from PostgreSQL.`);

  // Connect to Redis and clean up keys
  if (!redis.isOpen) {
    await redis.connect();
  }

  let deletedRedisKeys = 0;
  for (const clientKey of testKeys) {
    const tbKey = `bucket:${clientKey}`;
    const swKey = `bucket:sw:${clientKey}`;
    
    const count1 = await redis.del(tbKey);
    const count2 = await redis.del(swKey);
    deletedRedisKeys += (count1 + count2);
  }
  console.log(`Cleaned up ${deletedRedisKeys} rate-limiter bucket states from Redis.`);

  console.log("Teardown completed successfully.");
}

main()
  .catch((e) => {
    console.error("Error running load test teardown:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (redis.isOpen) {
      await redis.quit();
    }
  });
