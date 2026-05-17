import OpenAI from "openai";
import { getAppConfig, getEnvironment } from "./appConfig.js";
import { getAgentsConfig } from "./agentConfig.js";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const SQL_MODEL = "gpt-5";
export const SQL_MODEL_MINI = "gpt-5-mini";
export const SUMMARY_MODEL = "gpt-4o-mini";

// Dynamic model getters — read from agentConfig (MongoDB)
export const getSqlModel = async (): Promise<string> =>
  (await getAgentsConfig()).sql.model;

export const getSqlModelMini = async (): Promise<string> =>
  (await getAgentsConfig()).sql.modelMini;

export const getSummaryModel = async (): Promise<string> =>
  (await getAgentsConfig()).summary.model;

export const getTranslationModel = async (): Promise<string> =>
  (await getAgentsConfig()).translation.model;

export const getChartModel = async (): Promise<string> =>
  (await getAgentsConfig()).chart.model;

export const getEmbeddingModel = async (): Promise<string> =>
  (await getAgentsConfig()).embedding.model;

export const getPlannerModel = async (): Promise<string> =>
  (await getAgentsConfig()).planner?.model ?? SQL_MODEL_MINI;

const clientCache = new Map<string, OpenAI>();

export const getOpenAI = async (environmentId?: string): Promise<OpenAI> => {
  let apiKey: string | undefined;

  if (environmentId) {
    const env = await getEnvironment(environmentId);
    apiKey = env?.openAiApiKey;
  }

  if (!apiKey) {
    const appConfig = await getAppConfig();
    apiKey = appConfig?.openAiApiKey;
  }

  // Env var sobrescreve key do MongoDB (permite trocar provider sem ir no settings)
  apiKey = process.env.OPENAI_API_KEY || apiKey;

  if (!apiKey) {
    throw new Error("App not configured. Please complete setup first.");
  }

  const existing = clientCache.get(apiKey);
  if (existing) return existing;

  const client = new OpenAI({ apiKey });
  clientCache.set(apiKey, client);
  return client;
};

/**
 * Per-provider OpenAI-compatible client factory. Routes planner/reviewer/reporter
 * calls to the right baseURL+apiKey based on the routing rule's provider.
 *
 * Note: This uses HTTP API keys (ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY),
 * NOT the OAuth tokens stored in OpenClaude containers. OAuth = OpenClaude gRPC only.
 */
export type ProviderClient = "anthropic" | "codex" | "deepseek" | "openai";

const providerCache = new Map<ProviderClient, OpenAI>();

const buildProviderClient = (provider: ProviderClient): OpenAI => {
  switch (provider) {
    case "anthropic": {
      // Anthropic OpenAI-compatible endpoint (limited; works for /v1/messages-style calls
      // via OpenAI SDK in some configs). If users have issues, they should set
      // OPENAI_BASE_URL_ANTHROPIC explicitly.
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set — required for anthropic provider via SDK.");
      return new OpenAI({
        apiKey,
        baseURL: process.env.OPENAI_BASE_URL_ANTHROPIC ?? "https://api.anthropic.com/v1/"
      });
    }
    case "codex": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY not set — required for codex/openai provider via SDK.");
      return new OpenAI({
        apiKey,
        ...(process.env.OPENAI_BASE_URL_CODEX ? { baseURL: process.env.OPENAI_BASE_URL_CODEX } : {})
      });
    }
    case "deepseek": {
      const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("DEEPSEEK_API_KEY (or OPENAI_API_KEY fallback) not set — required for deepseek provider.");
      return new OpenAI({
        apiKey,
        baseURL: process.env.OPENAI_BASE_URL_DEEPSEEK ?? "https://api.deepseek.com"
      });
    }
    case "openai":
    default: {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY not set.");
      return new OpenAI({ apiKey });
    }
  }
};

/** Returns a cached OpenAI-SDK client configured for the given provider. */
export const getClient = (provider: ProviderClient): OpenAI => {
  const cached = providerCache.get(provider);
  if (cached) return cached;
  const client = buildProviderClient(provider);
  providerCache.set(provider, client);
  return client;
};

export const clearOpenAICache = (): void => {
  clientCache.clear();
  providerCache.clear();
};
