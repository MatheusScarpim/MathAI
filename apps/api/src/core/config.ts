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
  historyMaxRows: Number(process.env.HISTORY_MAX_ROWS ?? "20"),
  trello: {
    apiKey: process.env.TRELLO_API_KEY ?? "",
    apiToken: process.env.TRELLO_API_TOKEN ?? "",
    defaultBoardId: process.env.TRELLO_DEFAULT_BOARD_ID ?? ""
  },
  github: {
    token: process.env.GITHUB_TOKEN ?? "",
    defaultOwner: process.env.GITHUB_DEFAULT_OWNER ?? "",
    defaultRepo: process.env.GITHUB_DEFAULT_REPO ?? ""
  },
  workspace: {
    dir: process.env.WORKSPACE_DIR ?? "/data/auraia-workspaces",
    commandTimeoutMs: Number(process.env.WORKSPACE_CMD_TIMEOUT_MS ?? "300000")
  },
  openclaude: {
    grpcUrl: process.env.OPENCLAUDE_GRPC_URL ?? "openclaude:50051",
    defaultModel: process.env.OPENCLAUDE_MODEL ?? "",
    provider: process.env.OPENCLAUDE_PROVIDER ?? "openai",
    // Multi-provider gRPC endpoints (router uses these). Fall back to defaults
    // matching docker-compose service names + ports.
    providers: {
      anthropic: process.env.OPENCLAUDE_GRPC_URL_ANTHROPIC ?? "openclaude-anthropic:50051",
      codex: process.env.OPENCLAUDE_GRPC_URL_CODEX ?? "openclaude-codex:50051",
      deepseek: process.env.OPENCLAUDE_GRPC_URL_DEEPSEEK ?? "openclaude-deepseek:50051"
    } as Record<"anthropic" | "codex" | "deepseek", string>
  }
};
