import dotenv from "dotenv";

dotenv.config();

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

export const config = {
  port: Number(process.env.PORT ?? "3001"),
  openAiApiKey: requireEnv("OPENAI_API_KEY"),
  qdrantUrl: process.env.QDRANT_URL ?? "http://localhost:6333",
  mongo: {
    url: requireEnv("MONGO_URL"),
    db: requireEnv("MONGO_DB")
  },
  redis: {
    url: process.env.REDIS_URL ?? "",
    ttlSeconds: Number(process.env.REDIS_TTL_SECONDS ?? "900")
  },
  sql: {
    server: requireEnv("SQL_SERVER_HOST"),
    port: process.env.SQL_SERVER_PORT ? Number(process.env.SQL_SERVER_PORT) : 1433,
    database: requireEnv("SQL_SERVER_DB"),
    user: requireEnv("SQL_SERVER_USER"),
    password: requireEnv("SQL_SERVER_PASSWORD")
  }
};
