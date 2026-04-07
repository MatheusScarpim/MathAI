import dotenv from "dotenv";

dotenv.config();

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`[FATAL] Variavel de ambiente obrigatoria nao definida: ${name}`);
    process.exit(1);
  }
  return value;
};

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
  },
  jwt: {
    secret: requireEnv("JWT_SECRET"),
    expiresIn: process.env.JWT_EXPIRES_IN ?? "7d"
  },
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  historyMaxRows: Number(process.env.HISTORY_MAX_ROWS ?? "20")
};
