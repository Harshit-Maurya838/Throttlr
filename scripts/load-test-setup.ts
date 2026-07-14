import { prisma } from "../src/lib/prisma";
import { Algorithm } from "@prisma/client";

async function main() {
  console.log("Setting up load test client configurations in PostgreSQL...");

  // Delete existing test clients if any to avoid conflicts
  const testKeys = [
    "client-hot-tb",
    ...Array.from({ length: 10 }, (_, i) => `client-tb-${i + 1}`),
    ...Array.from({ length: 10 }, (_, i) => `client-sw-${i + 1}`),
  ];

  await prisma.clientConfig.deleteMany({
    where: {
      clientKey: {
        in: testKeys,
      },
    },
  });

  // Create dedicated hot client with negligible refill for exact correctness assertion
  await prisma.clientConfig.create({
    data: {
      clientKey: "client-hot-tb",
      algorithm: Algorithm.TOKEN_BUCKET,
      requestsPerSecond: 0.00001, // Refills 1 token every 100,000s (negligible)
      burstSize: 100,
    },
  });
  console.log("Provisioned dedicated hot client: client-hot-tb (capacity: 100, refillRate: 0.00001/sec)");

  // Create 10 TOKEN_BUCKET clients
  for (let i = 1; i <= 10; i++) {
    const key = `client-tb-${i}`;
    await prisma.clientConfig.create({
      data: {
        clientKey: key,
        algorithm: Algorithm.TOKEN_BUCKET,
        requestsPerSecond: 10 + i * 5,
        burstSize: 100 + i * 50,
      },
    });
    console.log(`Provisioned token-bucket client: ${key}`);
  }

  // Create 10 SLIDING_WINDOW clients
  for (let i = 1; i <= 10; i++) {
    const key = `client-sw-${i}`;
    await prisma.clientConfig.create({
      data: {
        clientKey: key,
        algorithm: Algorithm.SLIDING_WINDOW,
        requestsPerSecond: 10 + i * 5, // required by schema but unused by SW
        burstSize: 100 + i * 50, // limit
        windowMs: i * 1000,
      },
    });
    console.log(`Provisioned sliding-window client: ${key}`);
  }

  console.log("Load test data setup completed successfully.");
}

main()
  .catch((e) => {
    console.error("Error setting up load test data:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
