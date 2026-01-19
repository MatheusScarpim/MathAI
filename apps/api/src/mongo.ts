import { MongoClient, type Collection, type ObjectId } from "mongodb";
import { config } from "./config.js";

export type InstructionRecord = {
  _id?: string;
  text: string;
  createdAt: Date;
};

export type HistoryRecord = {
  _id?: ObjectId;
  chatId?: string;
  question: string;
  sql: string;
  summary?: string;
  language?: "pt" | "en" | "es";
  createdAt: Date;
  favorite: boolean;
  tags: string[];
  success?: boolean;
  errorMessage?: string;
  elapsedMs?: number;
  rowCount?: number;
  embedding?: number[];
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
