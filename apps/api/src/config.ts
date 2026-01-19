import dotenv from "dotenv";

dotenv.config();

export type SqlDialect = "sqlserver" | "mysql";

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

const normalizeDialect = (value: string | undefined): SqlDialect => {
  const lowered = value?.trim().toLowerCase();
  return lowered === "mysql" ? "mysql" : "sqlserver";
};

const sqlDialect = normalizeDialect(process.env.SQL_DIALECT);

const sqlConfig =
  sqlDialect === "mysql"
    ? {
        host: requireEnv("MYSQL_HOST"),
        port: process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : 3306,
        database: requireEnv("MYSQL_DB"),
        user: requireEnv("MYSQL_USER"),
        password: requireEnv("MYSQL_PASSWORD")
      }
    : {
        host: requireEnv("SQL_SERVER_HOST"),
        port: process.env.SQL_SERVER_PORT ? Number(process.env.SQL_SERVER_PORT) : 1433,
        database: requireEnv("SQL_SERVER_DB"),
        user: requireEnv("SQL_SERVER_USER"),
        password: requireEnv("SQL_SERVER_PASSWORD")
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
    dialect: sqlDialect,
    ...sqlConfig
  }
};
