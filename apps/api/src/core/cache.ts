import { createClient, type RedisClientType } from "redis";
import { config } from "./config.js";
import { cosineSimilarity } from "../utils/math.js";

let client: RedisClientType | null = null;

export type SemanticCacheEntry = {
  embedding: number[];
  sql: string;
  question: string;
  createdAt: string;
};

const normalizeQuestion = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const getCacheKey = (
  question: string,
  chatId: string | undefined,
  language: string,
  schemaLanguage?: string,
  responseLanguage?: string,
  environmentId?: string
) => {
  const normalized = normalizeQuestion(question);
  const chatKey = chatId ?? "nochat";
  const schemaKey = schemaLanguage ?? "pt";
  const responseKey = responseLanguage ?? language;
  const envKey = environmentId ?? "default";
  return `ask:${envKey}:${language}:${schemaKey}:${responseKey}:${chatKey}:${normalized}`;
};

const getSemanticCacheKey = (
  chatId: string | undefined,
  language: string,
  schemaLanguage?: string,
  environmentId?: string
) => {
  const chatKey = chatId ?? "nochat";
  const schemaKey = schemaLanguage ?? "pt";
  const envKey = environmentId ?? "default";
  return `ask:semantic:${envKey}:${language}:${schemaKey}:${chatKey}`;
};

export const getRedisClient = async (): Promise<RedisClientType | null> => {
  if (!config.redis.url) return null;
  if (client) return client;

  client = createClient({ url: config.redis.url });
  client.on("error", () => undefined);
  await client.connect();
  return client;
};

export const getCachedValue = async <T>(key: string): Promise<T | null> => {
  const redis = await getRedisClient();
  if (!redis) return null;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const setCachedValue = async (key: string, value: unknown): Promise<void> => {
  const redis = await getRedisClient();
  if (!redis) return;
  const ttl = Math.max(60, config.redis.ttlSeconds || 900);
  await redis.set(key, JSON.stringify(value), { EX: ttl });
};

export const findSemanticSql = async (
  chatId: string | undefined,
  language: string,
  schemaLanguage: string,
  embedding: number[],
  threshold: number,
  environmentId?: string
): Promise<{ sql: string; similarity: number; question: string } | null> => {
  const redis = await getRedisClient();
  if (!redis) return null;
  const key = getSemanticCacheKey(chatId, language, schemaLanguage, environmentId);
  const rawEntries = await redis.lRange(key, 0, 49);
  if (!rawEntries.length) return null;
  let best: { sql: string; similarity: number; question: string } | null = null;
  for (const raw of rawEntries) {
    try {
      const entry = JSON.parse(raw) as SemanticCacheEntry;
      if (!entry?.embedding?.length || !entry?.sql) continue;
      const similarity = cosineSimilarity(embedding, entry.embedding);
      if (similarity >= threshold && (!best || similarity > best.similarity)) {
        best = { sql: entry.sql, similarity, question: entry.question ?? "" };
      }
    } catch {
      continue;
    }
  }
  return best;
};

export const setSemanticEntry = async (
  chatId: string | undefined,
  language: string,
  schemaLanguage: string,
  entry: SemanticCacheEntry,
  environmentId?: string
): Promise<void> => {
  const redis = await getRedisClient();
  if (!redis) return;
  const key = getSemanticCacheKey(chatId, language, schemaLanguage, environmentId);
  const ttl = Math.max(60, config.redis.ttlSeconds || 900);
  await redis
    .multi()
    .lPush(key, JSON.stringify(entry))
    .lTrim(key, 0, 49)
    .expire(key, ttl)
    .exec();
};

export const clearSemanticCache = async (environmentId?: string): Promise<number> => {
  const redis = await getRedisClient();
  if (!redis) return 0;
  const envKey = environmentId ?? "*";
  const pattern = `ask:semantic:${envKey}:*`;
  let cursor = 0;
  let deleted = 0;

  do {
    const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 });
    cursor =
      typeof result.cursor === "string"
        ? Number.parseInt(result.cursor, 10)
        : result.cursor;
    const keys = Array.isArray(result.keys) ? result.keys : [];
    if (keys.length) {
      deleted += await redis.del(keys);
    }
  } while (cursor !== 0);

  return deleted;
};

export const clearAskCache = async (environmentId?: string): Promise<number> => {
  const redis = await getRedisClient();
  if (!redis) return 0;
  const envKey = environmentId ?? "*";
  const pattern = `ask:${envKey}:*`;
  let cursor = 0;
  let deleted = 0;

  do {
    const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 });
    cursor =
      typeof result.cursor === "string"
        ? Number.parseInt(result.cursor, 10)
        : result.cursor;
    const keys = Array.isArray(result.keys) ? result.keys : [];
    if (keys.length) {
      deleted += await redis.del(keys);
    }
  } while (cursor !== 0);

  return deleted;
};
