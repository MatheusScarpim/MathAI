import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { getMongoClient } from "./mongo.js";
import { config } from "./config.js";
import type { AppMode, ApiAuthType } from "@auraia/shared";

export type DbType = "sqlserver" | "oracle" | "mysql";

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

const getCollection = async () => {
  const client = await getMongoClient();
  return client.db(config.mongo.db).collection<StoredConfig>("appConfig");
};

let cached: AppConfig | null = null;

export const getAppConfig = async (): Promise<AppConfig | null> => {
  if (cached) return cached;

  const collection = await getCollection();
  const doc = await collection.findOne({});
  if (!doc) return null;

  try {
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

    cached = {
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

    return cached;
  } catch {
    return null;
  }
};

export const saveAppConfig = async (appConfig: AppConfig): Promise<void> => {
  const iv = randomBytes(16);
  const encryptedOpenAiApiKey = encryptWithIv(appConfig.openAiApiKey, iv);

  const stored: StoredConfig = {
    mode: appConfig.mode ?? "database",
    dbType: appConfig.dbType,
    dbHost: appConfig.dbHost,
    dbPort: appConfig.dbPort,
    dbName: appConfig.dbName,
    dbUser: appConfig.dbUser,
    encryptedOpenAiApiKey,
    encryptedDbPassword: appConfig.dbPassword
      ? encryptWithIv(appConfig.dbPassword, iv)
      : undefined,
    apiBaseUrl: appConfig.apiBaseUrl,
    apiAuthType: appConfig.apiAuthType,
    encryptedApiAuthToken: appConfig.apiAuthToken
      ? encryptWithIv(appConfig.apiAuthToken, iv)
      : undefined,
    apiAuthApiKeyHeader: appConfig.apiAuthApiKeyHeader,
    encryptedApiAuthApiKeyValue: appConfig.apiAuthApiKeyValue
      ? encryptWithIv(appConfig.apiAuthApiKeyValue, iv)
      : undefined,
    apiAuthUsername: appConfig.apiAuthUsername,
    encryptedApiAuthPassword: appConfig.apiAuthPassword
      ? encryptWithIv(appConfig.apiAuthPassword, iv)
      : undefined,
    swaggerUrl: appConfig.swaggerUrl,
    swaggerContent: appConfig.swaggerContent,
    apiReadOnly: appConfig.apiReadOnly,
    iv: iv.toString("hex"),
    configuredAt: new Date()
  };

  const collection = await getCollection();
  await collection.deleteMany({});
  await collection.insertOne(stored);

  cached = {
    ...appConfig,
    configuredAt: stored.configuredAt
  };
};

export const isConfigured = async (): Promise<boolean> => {
  const appConfig = await getAppConfig();
  return appConfig !== null;
};

export const clearConfigCache = (): void => {
  cached = null;
};

export const clearAppConfig = async (): Promise<number> => {
  const collection = await getCollection();
  const result = await collection.deleteMany({});
  cached = null;
  return result.deletedCount ?? 0;
};
