import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { getMongoClient } from "./mongo.js";
import { config } from "./config.js";
import type { AppMode, ApiAuthType } from "@auraia/shared";

export type DbType = "sqlserver" | "oracle" | "mysql" | "postgresql";

export type AppConfig = {
  openAiApiKey: string;
  mode: AppMode;
  /* Database mode fields */
  dbType?: DbType;
  dbHost?: string;
  dbPort?: number;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  /* API mode fields */
  apiBaseUrl?: string;
  apiAuthType?: ApiAuthType;
  apiAuthToken?: string;
  apiAuthApiKeyHeader?: string;
  apiAuthApiKeyValue?: string;
  apiAuthUsername?: string;
  apiAuthPassword?: string;
  swaggerUrl?: string;
  swaggerContent?: string;
  apiReadOnly?: boolean;
  configuredAt: Date;
};

// ================== Environment Types ==================

export type EnvironmentConfig = AppConfig & {
  environmentId: string;
  name: string;
};

type StoredEnvironment = Omit<
  EnvironmentConfig,
  "openAiApiKey" | "dbPassword" | "apiAuthToken" | "apiAuthApiKeyValue" | "apiAuthPassword"
> & {
  encryptedOpenAiApiKey: string;
  encryptedDbPassword?: string;
  encryptedApiAuthToken?: string;
  encryptedApiAuthApiKeyValue?: string;
  encryptedApiAuthPassword?: string;
  iv: string;
};

// ================== Legacy StoredConfig (for migration) ==================

type StoredConfig = Omit<
  AppConfig,
  "openAiApiKey" | "dbPassword" | "apiAuthToken" | "apiAuthApiKeyValue" | "apiAuthPassword"
> & {
  encryptedOpenAiApiKey: string;
  encryptedDbPassword?: string;
  encryptedApiAuthToken?: string;
  encryptedApiAuthApiKeyValue?: string;
  encryptedApiAuthPassword?: string;
  iv: string;
};

// ================== Encryption ==================

const ENCRYPTION_KEY = scryptSync(
  process.env.CONFIG_SECRET ?? "auraia-default-secret-key-2024",
  "auraia-salt",
  32
);
const ALGORITHM = "aes-256-cbc";

const encryptWithIv = (text: string, iv: Buffer): string => {
  const cipher = createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return encrypted;
};

const decrypt = (encrypted: string, ivHex: string): string => {
  const iv = Buffer.from(ivHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
};

// ================== Collections ==================

const getEnvironmentsCollection = async () => {
  const client = await getMongoClient();
  return client.db(config.mongo.db).collection<StoredEnvironment>("environments");
};

const getLegacyCollection = async () => {
  const client = await getMongoClient();
  return client.db(config.mongo.db).collection<StoredConfig>("appConfig");
};

// ================== Helpers ==================

const generateEnvironmentId = (): string =>
  `env_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;

const decryptEnvironment = (doc: StoredEnvironment): EnvironmentConfig => {
  const openAiApiKey = decrypt(doc.encryptedOpenAiApiKey, doc.iv);
  const dbPassword = doc.encryptedDbPassword
    ? decrypt(doc.encryptedDbPassword, doc.iv)
    : "";
  const apiAuthToken = doc.encryptedApiAuthToken
    ? decrypt(doc.encryptedApiAuthToken, doc.iv)
    : undefined;
  const apiAuthApiKeyValue = doc.encryptedApiAuthApiKeyValue
    ? decrypt(doc.encryptedApiAuthApiKeyValue, doc.iv)
    : undefined;
  const apiAuthPassword = doc.encryptedApiAuthPassword
    ? decrypt(doc.encryptedApiAuthPassword, doc.iv)
    : undefined;

  return {
    environmentId: doc.environmentId,
    name: doc.name,
    openAiApiKey,
    mode: doc.mode ?? "database",
    dbType: doc.dbType,
    dbHost: doc.dbHost,
    dbPort: doc.dbPort,
    dbName: doc.dbName,
    dbUser: doc.dbUser,
    dbPassword,
    apiBaseUrl: doc.apiBaseUrl,
    apiAuthType: doc.apiAuthType,
    apiAuthToken,
    apiAuthApiKeyHeader: doc.apiAuthApiKeyHeader,
    apiAuthApiKeyValue,
    apiAuthUsername: doc.apiAuthUsername,
    apiAuthPassword,
    swaggerUrl: doc.swaggerUrl,
    swaggerContent: doc.swaggerContent,
    apiReadOnly: doc.apiReadOnly,
    configuredAt: doc.configuredAt
  };
};

const encryptEnvironment = (env: EnvironmentConfig): StoredEnvironment => {
  const iv = randomBytes(16);
  return {
    environmentId: env.environmentId,
    name: env.name,
    mode: env.mode ?? "database",
    dbType: env.dbType,
    dbHost: env.dbHost,
    dbPort: env.dbPort,
    dbName: env.dbName,
    dbUser: env.dbUser,
    encryptedOpenAiApiKey: encryptWithIv(env.openAiApiKey, iv),
    encryptedDbPassword: env.dbPassword
      ? encryptWithIv(env.dbPassword, iv)
      : undefined,
    apiBaseUrl: env.apiBaseUrl,
    apiAuthType: env.apiAuthType,
    encryptedApiAuthToken: env.apiAuthToken
      ? encryptWithIv(env.apiAuthToken, iv)
      : undefined,
    apiAuthApiKeyHeader: env.apiAuthApiKeyHeader,
    encryptedApiAuthApiKeyValue: env.apiAuthApiKeyValue
      ? encryptWithIv(env.apiAuthApiKeyValue, iv)
      : undefined,
    apiAuthUsername: env.apiAuthUsername,
    encryptedApiAuthPassword: env.apiAuthPassword
      ? encryptWithIv(env.apiAuthPassword, iv)
      : undefined,
    swaggerUrl: env.swaggerUrl,
    swaggerContent: env.swaggerContent,
    apiReadOnly: env.apiReadOnly,
    iv: iv.toString("hex"),
    configuredAt: env.configuredAt ?? new Date()
  };
};

// ================== Migration from legacy appConfig ==================

let migrationDone = false;

const migrateLegacyConfig = async (): Promise<void> => {
  if (migrationDone) return;
  migrationDone = true;

  const envCollection = await getEnvironmentsCollection();
  const envCount = await envCollection.countDocuments();
  if (envCount > 0) return; // Already has environments, skip migration

  const legacyCollection = await getLegacyCollection();
  const legacyDoc = await legacyCollection.findOne({});
  if (!legacyDoc) return; // No legacy config either

  // Migrate legacy config to first environment
  const environmentId = generateEnvironmentId();
  const stored: StoredEnvironment = {
    ...legacyDoc,
    environmentId,
    name: "Default"
  };

  await envCollection.insertOne(stored);
};

// ================== Environment CRUD ==================

const envCache = new Map<string, EnvironmentConfig>();

export const listEnvironments = async (): Promise<EnvironmentConfig[]> => {
  await migrateLegacyConfig();
  const collection = await getEnvironmentsCollection();
  const docs = await collection.find({}).sort({ configuredAt: 1 }).toArray();
  const environments: EnvironmentConfig[] = [];
  for (const doc of docs) {
    try {
      const env = decryptEnvironment(doc);
      envCache.set(env.environmentId, env);
      environments.push(env);
    } catch {
      // Skip corrupted entries
    }
  }
  return environments;
};

export const getEnvironment = async (environmentId: string): Promise<EnvironmentConfig | null> => {
  const cached = envCache.get(environmentId);
  if (cached) return cached;

  await migrateLegacyConfig();
  const collection = await getEnvironmentsCollection();
  const doc = await collection.findOne({ environmentId });
  if (!doc) return null;

  try {
    const env = decryptEnvironment(doc);
    envCache.set(env.environmentId, env);
    return env;
  } catch {
    return null;
  }
};

export const createEnvironment = async (
  input: Omit<EnvironmentConfig, "environmentId">
): Promise<EnvironmentConfig> => {
  const environmentId = generateEnvironmentId();
  const env: EnvironmentConfig = {
    ...input,
    environmentId,
    configuredAt: new Date()
  };

  const stored = encryptEnvironment(env);
  const collection = await getEnvironmentsCollection();
  await collection.insertOne(stored);

  envCache.set(environmentId, env);
  return env;
};

export const updateEnvironment = async (
  environmentId: string,
  input: Partial<Omit<EnvironmentConfig, "environmentId" | "configuredAt">>
): Promise<EnvironmentConfig | null> => {
  const existing = await getEnvironment(environmentId);
  if (!existing) return null;

  const updated: EnvironmentConfig = {
    ...existing,
    ...input,
    environmentId,
    configuredAt: new Date()
  };

  const stored = encryptEnvironment(updated);
  const collection = await getEnvironmentsCollection();
  await collection.replaceOne({ environmentId }, stored);

  envCache.set(environmentId, updated);
  return updated;
};

export const deleteEnvironment = async (environmentId: string): Promise<boolean> => {
  const collection = await getEnvironmentsCollection();
  const result = await collection.deleteOne({ environmentId });
  envCache.delete(environmentId);
  return (result.deletedCount ?? 0) > 0;
};

export const clearEnvironmentCache = (): void => {
  envCache.clear();
};

// ================== Legacy compatibility layer ==================
// These functions are used by existing code and map to the first environment

let cached: AppConfig | null = null;

export const getAppConfig = async (): Promise<AppConfig | null> => {
  if (cached) return cached;

  const environments = await listEnvironments();
  if (environments.length === 0) return null;

  cached = environments[0]!;
  return cached;
};

export const saveAppConfig = async (appConfig: AppConfig): Promise<void> => {
  const environments = await listEnvironments();

  if (environments.length > 0) {
    const first = environments[0]!;
    await updateEnvironment(first.environmentId, appConfig);
  } else {
    await createEnvironment({ ...appConfig, name: "Default" });
  }

  cached = { ...appConfig, configuredAt: new Date() };
};

export const isConfigured = async (): Promise<boolean> => {
  const environments = await listEnvironments();
  return environments.length > 0;
};

export const clearConfigCache = (): void => {
  cached = null;
  envCache.clear();
};

export const clearAppConfig = async (): Promise<number> => {
  const collection = await getEnvironmentsCollection();
  const result = await collection.deleteMany({});
  cached = null;
  envCache.clear();
  return result.deletedCount ?? 0;
};
