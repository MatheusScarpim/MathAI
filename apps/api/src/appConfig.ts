import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { getMongoClient } from "./mongo.js";
import { config } from "./config.js";

export type DbType = "sqlserver" | "oracle" | "mysql";

export type AppConfig = {
  openAiApiKey: string;
  dbType: DbType;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  configuredAt: Date;
};

type StoredConfig = Omit<AppConfig, "openAiApiKey" | "dbPassword"> & {
  encryptedOpenAiApiKey: string;
  encryptedDbPassword: string;
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
    const dbPassword = decrypt(doc.encryptedDbPassword, doc.iv);

    cached = {
      openAiApiKey,
      dbType: doc.dbType,
      dbHost: doc.dbHost,
      dbPort: doc.dbPort,
      dbName: doc.dbName,
      dbUser: doc.dbUser,
      dbPassword,
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
  const encryptedDbPassword = encryptWithIv(appConfig.dbPassword, iv);

  const stored: StoredConfig = {
    dbType: appConfig.dbType,
    dbHost: appConfig.dbHost,
    dbPort: appConfig.dbPort,
    dbName: appConfig.dbName,
    dbUser: appConfig.dbUser,
    encryptedOpenAiApiKey,
    encryptedDbPassword,
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
