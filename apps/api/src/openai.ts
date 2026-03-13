import OpenAI from "openai";
import { getAppConfig } from "./appConfig.js";
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

let cachedClient: OpenAI | null = null;
let cachedKey: string | null = null;

export const getOpenAI = async (): Promise<OpenAI> => {
  const appConfig = await getAppConfig();
  if (!appConfig) {
    throw new Error("App not configured. Please complete setup first.");
  }

  if (cachedClient && cachedKey === appConfig.openAiApiKey) {
    return cachedClient;
  }

  cachedClient = new OpenAI({ apiKey: appConfig.openAiApiKey });
  cachedKey = appConfig.openAiApiKey;
  return cachedClient;
};

export const clearOpenAICache = (): void => {
  cachedClient = null;
  cachedKey = null;
};
