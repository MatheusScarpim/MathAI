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

export const clearOpenAICache = (): void => {
  clientCache.clear();
};
