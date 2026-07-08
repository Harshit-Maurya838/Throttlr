import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required but missing.`);
  }
  return value;
};

export const env = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  DATABASE_URL: requiredEnv("DATABASE_URL"),
  REDIS_URL: requiredEnv("REDIS_URL"),
  NODE_ENV: process.env.NODE_ENV || "development",
} as const;

export type Env = typeof env;
