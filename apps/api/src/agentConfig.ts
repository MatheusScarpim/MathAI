import type { AgentsConfig } from "@auraia/shared";
import { getSettingsCollection } from "./mongo.js";

export const DEFAULT_AGENTS_CONFIG: AgentsConfig = {
  sql: {
    model: "gpt-5",
    modelMini: "gpt-5-mini",
    temperature: undefined,
    maxRetries: 3,
    enabled: true
  },
  summary: {
    model: "gpt-4o-mini",
    temperature: 0.2,
    enabled: true
  },
  translation: {
    model: "gpt-4o-mini",
    temperature: 0,
    enabled: true
  },
  chart: {
    model: "gpt-4o-mini",
    temperature: 0.2,
    enabled: true
  },
  embedding: {
    model: "text-embedding-3-small"
  }
};

let cachedConfig: AgentsConfig | null = null;

export const clearAgentsConfigCache = (): void => {
  cachedConfig = null;
};

export const getAgentsConfig = async (): Promise<AgentsConfig> => {
  if (cachedConfig) return cachedConfig;

  try {
    const collection = await getSettingsCollection();
    const doc = await collection.findOne({ key: "agentsConfig" });

    if (doc && typeof doc.value === "object" && doc.value !== null) {
      const stored = doc.value as Partial<AgentsConfig>;
      cachedConfig = {
        sql: { ...DEFAULT_AGENTS_CONFIG.sql, ...stored.sql },
        summary: { ...DEFAULT_AGENTS_CONFIG.summary, ...stored.summary },
        translation: { ...DEFAULT_AGENTS_CONFIG.translation, ...stored.translation },
        chart: { ...DEFAULT_AGENTS_CONFIG.chart, ...stored.chart },
        embedding: { ...DEFAULT_AGENTS_CONFIG.embedding, ...stored.embedding }
      };
    } else {
      cachedConfig = { ...DEFAULT_AGENTS_CONFIG };
    }
  } catch {
    cachedConfig = { ...DEFAULT_AGENTS_CONFIG };
  }

  return cachedConfig;
};

export const saveAgentsConfig = async (config: AgentsConfig): Promise<void> => {
  const collection = await getSettingsCollection();
  await collection.updateOne(
    { key: "agentsConfig" },
    { $set: { value: config, updatedAt: new Date() } },
    { upsert: true }
  );
  cachedConfig = config;
};
