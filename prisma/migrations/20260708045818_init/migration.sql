-- CreateEnum
CREATE TYPE "Algorithm" AS ENUM ('TOKEN_BUCKET', 'SLIDING_WINDOW');

-- CreateTable
CREATE TABLE "client_configs" (
    "clientKey" TEXT NOT NULL,
    "algorithm" "Algorithm" NOT NULL,
    "requestsPerSecond" DOUBLE PRECISION NOT NULL,
    "burstSize" INTEGER NOT NULL,
    "windowMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_configs_pkey" PRIMARY KEY ("clientKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_configs_clientKey_key" ON "client_configs"("clientKey");
