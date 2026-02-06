import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT ?? "3001"),
  qdrantUrl: process.env.QDRANT_URL ?? "http://localhost:6333",
  mongo: {
    url: process.env.MONGO_URL ?? "mongodb://localhost:27017",
    db: process.env.MONGO_DB ?? "auraia"
  },
  redis: {
    url: process.env.REDIS_URL ?? "",
    ttlSeconds: Number(process.env.REDIS_TTL_SECONDS ?? "900")
  }
};
