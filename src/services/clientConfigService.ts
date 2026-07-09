import { prisma } from "../lib/prisma";
import { Algorithm, ClientConfig } from "@prisma/client";

export interface UpsertClientConfigInput {
  algorithm: Algorithm;
  requestsPerSecond: number;
  burstSize: number;
  windowMs?: number | null;
}

/**
 * Fetches the rate limit configuration for a specific client from the database.
 * Returns null if no configuration exists for the client.
 */
export async function getClientConfig(clientKey: string): Promise<ClientConfig | null> {
  return prisma.clientConfig.findUnique({
    where: { clientKey },
  });
}

/**
 * Creates or updates the rate limit configuration for a specific client.
 */
export async function upsertClientConfig(
  clientKey: string,
  config: UpsertClientConfigInput,
): Promise<ClientConfig> {
  return prisma.clientConfig.upsert({
    where: { clientKey },
    update: {
      algorithm: config.algorithm,
      requestsPerSecond: config.requestsPerSecond,
      burstSize: config.burstSize,
      windowMs: config.windowMs ?? null,
    },
    create: {
      clientKey,
      algorithm: config.algorithm,
      requestsPerSecond: config.requestsPerSecond,
      burstSize: config.burstSize,
      windowMs: config.windowMs ?? null,
    },
  });
}
