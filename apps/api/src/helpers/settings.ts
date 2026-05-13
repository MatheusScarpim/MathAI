import { getSettingsCollection } from "../core/mongo.js";
import {
  getAgentsConfig,
  saveAgentsConfig,
  DEFAULT_AGENTS_CONFIG
} from "../core/agentConfig.js";

const VALID_LANGUAGES = ["pt", "en", "es"] as const;
export type ValidLanguage = (typeof VALID_LANGUAGES)[number];

const DEFAULT_SCHEMA_LANGUAGE: ValidLanguage = "pt";
const DEFAULT_TABLE_REFERENCE_COUNT = 8;

export const isValidLanguage = (value: string | undefined): value is ValidLanguage =>
  Boolean(value && VALID_LANGUAGES.includes(value as ValidLanguage));

export const getSchemaLanguageSetting = async (): Promise<ValidLanguage> => {
  const collection = await getSettingsCollection();
  const doc = await collection.findOne({ key: "schemaLanguage" });
  if (doc && typeof doc.value === "string" && isValidLanguage(doc.value)) return doc.value;
  return DEFAULT_SCHEMA_LANGUAGE;
};

export const setSchemaLanguageSetting = async (value: ValidLanguage): Promise<void> => {
  const collection = await getSettingsCollection();
  await collection.updateOne(
    { key: "schemaLanguage" },
    { $set: { value, updatedAt: new Date() } },
    { upsert: true }
  );
};

export const getTableReferenceCountSetting = async (): Promise<number> => {
  const collection = await getSettingsCollection();
  const doc = await collection.findOne({ key: "tableReferenceCount" });
  const value =
    typeof doc?.value === "number"
      ? doc.value
      : Number.parseInt(String(doc?.value ?? ""), 10);
  if (!Number.isFinite(value)) return DEFAULT_TABLE_REFERENCE_COUNT;
  return Math.max(1, Math.min(30, Math.floor(value)));
};

export const setTableReferenceCountSetting = async (value: number): Promise<void> => {
  const collection = await getSettingsCollection();
  await collection.updateOne(
    { key: "tableReferenceCount" },
    { $set: { value, updatedAt: new Date() } },
    { upsert: true }
  );
};

export const ensureDefaultSettings = async (): Promise<void> => {
  const collection = await getSettingsCollection();
  const now = new Date();

  await Promise.all([
    collection.updateOne(
      { key: "schemaLanguage" },
      { $setOnInsert: { value: DEFAULT_SCHEMA_LANGUAGE, updatedAt: now } },
      { upsert: true }
    ),
    collection.updateOne(
      { key: "tableReferenceCount" },
      { $setOnInsert: { value: DEFAULT_TABLE_REFERENCE_COUNT, updatedAt: now } },
      { upsert: true }
    ),
    collection.updateOne(
      { key: "agentsConfig" },
      { $setOnInsert: { value: DEFAULT_AGENTS_CONFIG, updatedAt: now } },
      { upsert: true }
    )
  ]);
};

/* ── Integrations Settings (Task Orchestrator) ──────────────────── */

export type IntegrationsSettings = {
  trelloApiKey: string;
  trelloApiToken: string;
  trelloBoardId: string;
  trelloListId: string;
  trelloDoneListId: string;
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  openclaudeModel: string;
  openclaudeProvider: string;
  /* WhatsApp (motor proprio via Baileys) */
  whatsappEnabled: boolean;
  whatsappPhoneNumber: string;        // display only — auth real fica em whatsapp_auth_creds
  whatsappAllowedJids: string[];      // whitelist EXTRA alem de chat_bindings (anti-ban)
  whatsappRateLimitMs: number;        // gap minimo entre msgs pro mesmo chat (default 2500)
};

export const getIntegrationsSettings = async (): Promise<Partial<IntegrationsSettings>> => {
  const collection = await getSettingsCollection();
  const doc = await collection.findOne({ key: "integrations" });
  const value = doc?.value as Record<string, unknown> | undefined;
  return {
    trelloApiKey: typeof value?.trelloApiKey === "string" ? value.trelloApiKey : "",
    trelloApiToken: typeof value?.trelloApiToken === "string" ? value.trelloApiToken : "",
    trelloBoardId: typeof value?.trelloBoardId === "string" ? value.trelloBoardId : "",
    trelloListId: typeof value?.trelloListId === "string" ? value.trelloListId : "",
    trelloDoneListId: typeof value?.trelloDoneListId === "string" ? value.trelloDoneListId : "",
    githubToken: typeof value?.githubToken === "string" ? value.githubToken : "",
    githubOwner: typeof value?.githubOwner === "string" ? value.githubOwner : "",
    githubRepo: typeof value?.githubRepo === "string" ? value.githubRepo : "",
    openclaudeModel: typeof value?.openclaudeModel === "string" ? value.openclaudeModel : "",
    openclaudeProvider: typeof value?.openclaudeProvider === "string" ? value.openclaudeProvider : "",
    whatsappEnabled: typeof value?.whatsappEnabled === "boolean" ? value.whatsappEnabled : false,
    whatsappPhoneNumber: typeof value?.whatsappPhoneNumber === "string" ? value.whatsappPhoneNumber : "",
    whatsappAllowedJids: Array.isArray(value?.whatsappAllowedJids)
      ? (value.whatsappAllowedJids as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    whatsappRateLimitMs: typeof value?.whatsappRateLimitMs === "number" && value.whatsappRateLimitMs > 0
      ? value.whatsappRateLimitMs
      : 2500
  };
};

export const saveIntegrationsSettings = async (value: Partial<IntegrationsSettings>): Promise<void> => {
  const collection = await getSettingsCollection();
  await collection.updateOne(
    { key: "integrations" },
    { $set: { value, updatedAt: new Date() } },
    { upsert: true }
  );
};

export { VALID_LANGUAGES };
