import { MongoClient, type Collection, type ObjectId } from "mongodb";
import { config } from "./config.js";
import type { AskErrorResponse, AskSuccessResponse, AppMode } from "@auraia/shared";

export type InstructionRecord = {
  _id?: ObjectId;
  text: string;
  tableFullName?: string; // null/undefined = global instruction
  createdAt: Date;
};

export type HistoryRecord = {
  _id?: ObjectId;
  environmentId?: string;
  chatId?: string;
  question: string;
  embeddingQuestion?: string;
  sql: string;
  httpRequest?: string;
  mode?: AppMode;
  rows?: Record<string, unknown>[];
  columns?: string[];
  chart?: {
    type: "bar" | "line";
    data: Array<{ category: string | number; value: number | null }>;
    title?: string;
    xKey?: string;
    yKey?: string;
  };
  summary?: string;
  language?: "pt" | "en" | "es";
  responseLanguage?: "pt" | "en" | "es";
  createdAt: Date;
  deletedAt?: Date;
  favorite: boolean;
  tags: string[];
  success?: boolean;
  errorMessage?: string;
  elapsedMs?: number;
  rowCount?: number;
  embedding?: number[];
  tokenUsage?: {
    planner?: { inputTokens: number; outputTokens: number; totalTokens: number };
    sqlMini?: { inputTokens: number; outputTokens: number; totalTokens: number };
    sqlLarge?: { inputTokens: number; outputTokens: number; totalTokens: number };
    summary?: { inputTokens: number; outputTokens: number; totalTokens: number };
    total: { inputTokens: number; outputTokens: number; totalTokens: number };
  };
};

export type SettingRecord = {
  _id?: ObjectId;
  key: string;
  value: unknown;
  updatedAt: Date;
};

export type ProcessingJobRecord = {
  _id?: ObjectId;
  status: "processing" | "completed" | "failed";
  question: string;
  chatId?: string;
  webhookUrl?: string;
  language: "pt" | "en" | "es";
  schemaLanguage: "pt" | "en" | "es";
  responseLanguage: "pt" | "en" | "es";
  result?: AskSuccessResponse;
  error?: AskErrorResponse;
  webhookNotifiedAt?: Date;
  webhookError?: string;
  createdAt: Date;
  updatedAt: Date;
};

let client: MongoClient | null = null;

export const getMongoClient = async (): Promise<MongoClient> => {
  if (client) return client;
  client = new MongoClient(config.mongo.url, {
    serverSelectionTimeoutMS: 5000
  });
  await client.connect();
  return client;
};

export const getInstructionsCollection = async (): Promise<
  Collection<InstructionRecord>
> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<InstructionRecord>("instructions");
};

export const getHistoryCollection = async (): Promise<Collection<HistoryRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<HistoryRecord>("history");
};

export const getSettingsCollection = async (): Promise<Collection<SettingRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<SettingRecord>("settings");
};

export const getProcessingJobsCollection = async (): Promise<Collection<ProcessingJobRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<ProcessingJobRecord>("processing_jobs");
};
