import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import OpenAI from "openai";
import { config } from "./config.js";
import { closeAdapter, getAdapter, testConnection } from "./db.js";
import {
  ingestSchemaToQdrant,
  loadSchema,
  loadSchemaGraph,
  clearSchemaCache
} from "./schema.js";
import { clearSchemaCollection, clearEndpointCollection } from "./qdrant.js";
import { answerQuestion } from "./ask.js";
import { isNonEmptyString, sanitizeErrorMessage } from "@auraia/shared";
import {
  fetchSwaggerSpec,
  parseSwaggerSpec,
  ingestEndpointsToQdrant,
  loadEndpointGraph,
  clearEndpointCache
} from "./swagger.js";
import { validateSql } from "./validation.js";
import {
  getHistoryCollection,
  getInstructionsCollection,
  getMongoClient,
  getProcessingJobsCollection,
  getSettingsCollection
} from "./mongo.js";
import { ObjectId } from "mongodb";
import {
  clearAppConfig,
  clearConfigCache,
  getAppConfig,
  isConfigured,
  saveAppConfig,
  type AppConfig,
  type DbType
} from "./appConfig.js";
import { clearOpenAICache } from "./openai.js";
import { clearAskCache } from "./cache.js";
import {
  getAgentsConfig,
  saveAgentsConfig,
  clearAgentsConfigCache,
  DEFAULT_AGENTS_CONFIG
} from "./agentConfig.js";
import type { AgentsConfig } from "@auraia/shared";

const app = Fastify({
  logger: true,
  bodyLimit: 1_000_000
});

await app.register(cors, { origin: true });
await app.register(rateLimit, { global: false });
await app.register(swagger, {
  openapi: {
    info: {
      title: "MathAI API",
      description: "Documentacao da API do MathAI",
      version: "1.0.0"
    }
  }
});
await app.register(swaggerUi, {
  routePrefix: "/docs",
  uiConfig: {
    docExpansion: "list",
    deepLinking: false
  },
  staticCSP: true
});

const VALID_LANGUAGES = ["pt", "en", "es"] as const;
const RESPONSE_POLL_INTERVAL_MS = 500;
const RESPONSE_MAX_WAIT_MS = 55_000;
const LANGUAGE_ENUM = [...VALID_LANGUAGES];
const DEFAULT_SCHEMA_LANGUAGE = "pt" as const;
const DEFAULT_TABLE_REFERENCE_COUNT = 8;

const errorResponseSchema = {
  type: "object",
  properties: {
    errorMessage: { type: "string" },
    hint: { type: "string" },
    sql: { type: "string" }
  },
  required: ["errorMessage"]
} as const;

const askSuccessResponseSchema = {
  type: "object",
  properties: {
    sql: { type: "string" },
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true
      }
    },
    columns: { type: "array", items: { type: "string" } },
    elapsedMs: { type: "number" },
    chatId: { type: "string" },
    historyId: { type: "string" },
    summary: { type: "string" },
    translatedQuestion: { type: "string" },
    cacheHit: { type: "boolean" },
    responseLanguage: { type: "string", enum: LANGUAGE_ENUM },
    chart: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["bar", "line"] },
        data: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: { anyOf: [{ type: "string" }, { type: "number" }] },
              value: { anyOf: [{ type: "number" }, { type: "null" }] }
            },
            required: ["category", "value"]
          }
        },
        title: { type: "string" },
        xKey: { type: "string" },
        yKey: { type: "string" }
      },
      required: ["type", "data"]
    },
    tokenUsage: {
      type: "object",
      properties: {
        sql: {
          type: "object",
          properties: {
            inputTokens: { type: "number" },
            outputTokens: { type: "number" },
            totalTokens: { type: "number" }
          },
          required: ["inputTokens", "outputTokens", "totalTokens"]
        },
        summary: {
          type: "object",
          properties: {
            inputTokens: { type: "number" },
            outputTokens: { type: "number" },
            totalTokens: { type: "number" }
          },
          required: ["inputTokens", "outputTokens", "totalTokens"]
        },
        total: {
          type: "object",
          properties: {
            inputTokens: { type: "number" },
            outputTokens: { type: "number" },
            totalTokens: { type: "number" }
          },
          required: ["inputTokens", "outputTokens", "totalTokens"]
        }
      },
      required: ["sql", "total"]
    }
  },
  required: ["sql", "rows", "columns", "elapsedMs"]
} as const;

type AskBody = {
  question?: string;
  chatId?: string;
  language?: string;
  schemaLanguage?: string;
  responseLanguage?: string;
  async?: boolean;
  webhookUrl?: string;
};

type NormalizedAskPayload = {
  question: string;
  chatId?: string;
  questionLanguage: (typeof VALID_LANGUAGES)[number];
  schemaLanguage: (typeof VALID_LANGUAGES)[number];
  responseLanguage: (typeof VALID_LANGUAGES)[number];
  webhookUrl?: string;
};

const isValidLanguage = (value: string | undefined): value is (typeof VALID_LANGUAGES)[number] =>
  Boolean(value && VALID_LANGUAGES.includes(value as (typeof VALID_LANGUAGES)[number]));

const sleep = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isValidWebhookUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const normalizeAskPayload = async (body: AskBody): Promise<NormalizedAskPayload> => {
  const schemaLanguage = isValidLanguage(body.schemaLanguage)
    ? body.schemaLanguage
    : await getSchemaLanguageSetting();
  const questionLanguage = isValidLanguage(body.language) ? body.language : "pt";
  const responseLanguage = isValidLanguage(body.responseLanguage)
    ? body.responseLanguage
    : questionLanguage;

  return {
    question: body.question!.trim(),
    chatId: body.chatId?.trim(),
    questionLanguage,
    schemaLanguage,
    responseLanguage,
    webhookUrl: body.webhookUrl?.trim()
  };
};

const sendWebhookNotification = async (
  processingId: string,
  payload: {
    status: "completed" | "failed";
    result?: unknown;
    error?: unknown;
  }
): Promise<string | null> => {
  const collection = await getProcessingJobsCollection();
  const job = await collection.findOne({ _id: new ObjectId(processingId) });
  const webhookUrl = job?.webhookUrl?.trim();
  if (!webhookUrl) return null;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "ask.processing.finished",
        processingId,
        status: payload.status,
        finishedAt: new Date().toISOString(),
        result: payload.result,
        error: payload.error
      })
    });

    if (!response.ok) {
      const message = `Webhook HTTP ${response.status}`;
      await collection.updateOne(
        { _id: new ObjectId(processingId) },
        { $set: { webhookError: message, updatedAt: new Date() } }
      );
      return message;
    }

    await collection.updateOne(
      { _id: new ObjectId(processingId) },
      {
        $set: {
          webhookNotifiedAt: new Date(),
          webhookError: "",
          updatedAt: new Date()
        }
      }
    );
    return null;
  } catch (error) {
    const message = sanitizeErrorMessage(
      (error as { message?: string })?.message ?? "Erro ao enviar webhook."
    );
    await collection.updateOne(
      { _id: new ObjectId(processingId) },
      { $set: { webhookError: message, updatedAt: new Date() } }
    );
    return message;
  }
};

const processAskJob = async (
  processingId: string,
  payload: NormalizedAskPayload
): Promise<void> => {
  const collection = await getProcessingJobsCollection();

  try {
    const result = await answerQuestion(
      payload.question,
      payload.chatId,
      payload.questionLanguage,
      payload.schemaLanguage,
      payload.responseLanguage
    );

    if (!result.ok) {
      await collection.updateOne(
        { _id: new ObjectId(processingId) },
        {
          $set: {
            status: "failed",
            error: result.error,
            updatedAt: new Date()
          }
        }
      );
      await sendWebhookNotification(processingId, {
        status: "failed",
        error: result.error
      });
      return;
    }

    await collection.updateOne(
      { _id: new ObjectId(processingId) },
      {
        $set: {
          status: "completed",
          result: result.data,
          updatedAt: new Date()
        }
      }
    );
    await sendWebhookNotification(processingId, {
      status: "completed",
      result: result.data
    });
  } catch (error) {
    const failure = {
      errorMessage: sanitizeErrorMessage(
        (error as { message?: string })?.message ?? "Erro interno no processamento."
      )
    };
    await collection.updateOne(
      { _id: new ObjectId(processingId) },
      {
        $set: {
          status: "failed",
          error: failure,
          updatedAt: new Date()
        }
      }
    );
    await sendWebhookNotification(processingId, {
      status: "failed",
      error: failure
    });
  }
};

const getSchemaLanguageSetting = async (): Promise<(typeof VALID_LANGUAGES)[number]> => {
  const collection = await getSettingsCollection();
  const doc = await collection.findOne({ key: "schemaLanguage" });
  if (doc && typeof doc.value === "string" && isValidLanguage(doc.value)) return doc.value;
  return "pt";
};

const getTableReferenceCountSetting = async (): Promise<number> => {
  const collection = await getSettingsCollection();
  const doc = await collection.findOne({ key: "tableReferenceCount" });
  const value =
    typeof doc?.value === "number"
      ? doc.value
      : Number.parseInt(String(doc?.value ?? ""), 10);
  if (!Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(30, Math.floor(value)));
};

const setTableReferenceCountSetting = async (value: number): Promise<void> => {
  const collection = await getSettingsCollection();
  await collection.updateOne(
    { key: "tableReferenceCount" },
    { $set: { value, updatedAt: new Date() } },
    { upsert: true }
  );
};

const setSchemaLanguageSetting = async (
  value: (typeof VALID_LANGUAGES)[number]
): Promise<void> => {
  const collection = await getSettingsCollection();
  await collection.updateOne(
    { key: "schemaLanguage" },
    { $set: { value, updatedAt: new Date() } },
    { upsert: true }
  );
};

const ensureDefaultSettings = async (): Promise<void> => {
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

const extractErrorMessage = (error: unknown): string => {
  const fallback = "Erro interno.";
  if (!error || typeof error !== "object") return fallback;

  const message =
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : fallback;

  const nestedMessage =
    typeof (error as { error?: { message?: unknown } }).error?.message === "string"
      ? (error as { error: { message: string } }).error.message
      : message;

  return sanitizeErrorMessage(nestedMessage);
};

app.setErrorHandler((error, _request, reply) => {
  app.log.error({ err: error }, "request failed");
  const message = extractErrorMessage(error);
  reply.status(500).send({ errorMessage: message });
});

type SaveConfigBody = {
  openAiApiKey?: string;
  mode?: string;
  dbType?: DbType;
  dbHost?: string;
  dbPort?: number | string;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  apiBaseUrl?: string;
  apiAuthType?: string;
  apiAuthToken?: string;
  apiAuthApiKeyHeader?: string;
  apiAuthApiKeyValue?: string;
  apiAuthUsername?: string;
  apiAuthPassword?: string;
  apiReadOnly?: boolean;
  swaggerUrl?: string;
  swaggerContent?: string;
};

const parsePort = (value: number | string | undefined): number | null => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
};

app.get("/api/config/status", async (_request, reply) => {
  reply.send({ configured: await isConfigured() });
});

app.get("/api/config", async (_request, reply) => {
  const appConfig = await getAppConfig();
  if (!appConfig) {
    reply.status(404).send({ errorMessage: "Aplicacao nao configurada." });
    return;
  }

  reply.send({
    mode: appConfig.mode ?? "database",
    dbType: appConfig.dbType,
    dbHost: appConfig.dbHost,
    dbPort: appConfig.dbPort,
    dbName: appConfig.dbName,
    dbUser: appConfig.dbUser,
    openAiKeySet: appConfig.openAiApiKey.length > 0,
    apiBaseUrl: appConfig.apiBaseUrl,
    apiAuthType: appConfig.apiAuthType,
    apiReadOnly: appConfig.apiReadOnly,
    swaggerUrl: appConfig.swaggerUrl
  });
});

app.post("/api/config/test-db", async (request, reply) => {
  const body = request.body as SaveConfigBody;
  if (body.dbType !== "sqlserver" && body.dbType !== "oracle" && body.dbType !== "mysql") {
    reply.status(400).send({ errorMessage: "dbType invalido." });
    return;
  }
  if (!isNonEmptyString(body.dbHost) || !isNonEmptyString(body.dbName) || !isNonEmptyString(body.dbUser) || !isNonEmptyString(body.dbPassword)) {
    reply.status(400).send({ errorMessage: "Campos de conexao obrigatorios: dbHost, dbName, dbUser, dbPassword." });
    return;
  }
  const dbPort = parsePort(body.dbPort);
  if (!dbPort) {
    reply.status(400).send({ errorMessage: "dbPort invalido." });
    return;
  }

  const result = await testConnection(
    body.dbType,
    body.dbHost.trim(),
    dbPort,
    body.dbName.trim(),
    body.dbUser.trim(),
    body.dbPassword
  );
  if (!result.ok) {
    reply.status(400).send({ errorMessage: sanitizeErrorMessage(result.error) });
    return;
  }
  reply.send({ ok: true });
});

app.post("/api/config/test-openai", async (request, reply) => {
  const body = request.body as { openAiApiKey?: string };
  if (!isNonEmptyString(body.openAiApiKey)) {
    reply.status(400).send({ errorMessage: "openAiApiKey obrigatoria." });
    return;
  }

  try {
    const client = new OpenAI({ apiKey: body.openAiApiKey.trim() });
    await client.models.list();
    reply.send({ ok: true });
  } catch (error) {
    reply.status(400).send({ errorMessage: sanitizeErrorMessage((error as { message?: string })?.message ?? "OpenAI key invalida.") });
  }
});

app.post("/api/config", async (request, reply) => {
  const body = request.body as SaveConfigBody;
  if (!isNonEmptyString(body.openAiApiKey)) {
    reply.status(400).send({ errorMessage: "openAiApiKey obrigatoria." });
    return;
  }

  const mode = body.mode === "api" ? "api" as const : "database" as const;

  if (mode === "api") {
    if (!isNonEmptyString(body.apiBaseUrl)) {
      reply.status(400).send({ errorMessage: "apiBaseUrl obrigatoria para modo API." });
      return;
    }

    const validAuthTypes = ["none", "bearer", "apikey", "basic"];
    const authType = validAuthTypes.includes(body.apiAuthType ?? "")
      ? (body.apiAuthType as "none" | "bearer" | "apikey" | "basic")
      : "none";

    const nextConfig: AppConfig = {
      openAiApiKey: body.openAiApiKey.trim(),
      mode: "api",
      apiBaseUrl: body.apiBaseUrl.trim(),
      apiAuthType: authType,
      apiAuthToken: body.apiAuthToken,
      apiAuthApiKeyHeader: body.apiAuthApiKeyHeader,
      apiAuthApiKeyValue: body.apiAuthApiKeyValue,
      apiAuthUsername: body.apiAuthUsername,
      apiAuthPassword: body.apiAuthPassword,
      apiReadOnly: body.apiReadOnly ?? true,
      swaggerUrl: body.swaggerUrl,
      swaggerContent: body.swaggerContent,
      configuredAt: new Date()
    };

    await saveAppConfig(nextConfig);
    clearConfigCache();
    clearOpenAICache();
    clearEndpointCache();
    reply.send({ ok: true });
    return;
  }

  // Database mode
  if (body.dbType !== "sqlserver" && body.dbType !== "oracle" && body.dbType !== "mysql") {
    reply.status(400).send({ errorMessage: "dbType invalido." });
    return;
  }
  if (!isNonEmptyString(body.dbHost) || !isNonEmptyString(body.dbName) || !isNonEmptyString(body.dbUser) || !isNonEmptyString(body.dbPassword)) {
    reply.status(400).send({ errorMessage: "Campos de conexao obrigatorios: dbHost, dbName, dbUser, dbPassword." });
    return;
  }
  const dbPort = parsePort(body.dbPort);
  if (!dbPort) {
    reply.status(400).send({ errorMessage: "dbPort invalido." });
    return;
  }

  const nextConfig: AppConfig = {
    openAiApiKey: body.openAiApiKey.trim(),
    mode: "database",
    dbType: body.dbType,
    dbHost: body.dbHost.trim(),
    dbPort,
    dbName: body.dbName.trim(),
    dbUser: body.dbUser.trim(),
    dbPassword: body.dbPassword,
    configuredAt: new Date()
  };

  await saveAppConfig(nextConfig);
  await closeAdapter();
  clearConfigCache();
  clearOpenAICache();
  clearSchemaCache();
  reply.send({ ok: true });
});

app.post("/api/ingest/schema", async (_request, reply) => {
  const adapter = await getAdapter();
  const tables = await loadSchema(adapter);
  const tablesIndexed = await ingestSchemaToQdrant(tables);
  clearSchemaCache();
  reply.send({ tablesIndexed });
});

app.get("/api/schema/tables", async () => {
  const tables = await loadSchemaGraph();
  return { tables };
});

app.post("/api/schema/clear", async (_request, reply) => {
  await clearSchemaCollection();
  clearSchemaCache();
  reply.send({ ok: true });
});

// ================== Swagger / API Mode Routes ==================

app.post("/api/config/test-api", async (request, reply) => {
  const body = request.body as { apiBaseUrl?: string; apiAuthType?: string; apiAuthToken?: string; apiAuthApiKeyHeader?: string; apiAuthApiKeyValue?: string; apiAuthUsername?: string; apiAuthPassword?: string };
  if (!isNonEmptyString(body.apiBaseUrl)) {
    reply.status(400).send({ errorMessage: "apiBaseUrl obrigatoria." });
    return;
  }
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body.apiAuthType === "bearer" && body.apiAuthToken) {
      headers.Authorization = `Bearer ${body.apiAuthToken}`;
    } else if (body.apiAuthType === "apikey" && body.apiAuthApiKeyValue) {
      headers[body.apiAuthApiKeyHeader ?? "X-API-Key"] = body.apiAuthApiKeyValue;
    } else if (body.apiAuthType === "basic" && body.apiAuthUsername) {
      headers.Authorization = `Basic ${Buffer.from(`${body.apiAuthUsername}:${body.apiAuthPassword ?? ""}`).toString("base64")}`;
    }
    const response = await fetch(body.apiBaseUrl.trim(), { method: "GET", headers });
    if (!response.ok && response.status >= 500) {
      reply.status(400).send({ errorMessage: `API retornou HTTP ${response.status}.` });
      return;
    }
    reply.send({ ok: true });
  } catch (error) {
    reply.status(400).send({ errorMessage: sanitizeErrorMessage((error as { message?: string })?.message ?? "Erro ao conectar na API.") });
  }
});

app.post("/api/ingest/swagger", async (request, reply) => {
  const body = request.body as { url?: string; content?: string };
  let specContent: string;

  if (isNonEmptyString(body.content)) {
    specContent = body.content!;
  } else if (isNonEmptyString(body.url)) {
    specContent = await fetchSwaggerSpec(body.url!.trim());
  } else {
    reply.status(400).send({ errorMessage: "Informe url ou content do swagger spec." });
    return;
  }

  const allEndpoints = parseSwaggerSpec(specContent);
  const endpoints = allEndpoints.filter(e => e.method.toUpperCase() === "GET");
  if (endpoints.length === 0) {
    reply.status(400).send({ errorMessage: "Nenhum endpoint GET encontrado no swagger spec." });
    return;
  }

  const endpointsIndexed = await ingestEndpointsToQdrant(endpoints);
  clearEndpointCache();
  reply.send({ endpointsIndexed });
});

app.get("/api/schema/endpoints", async (_request, reply) => {
  const endpoints = await loadEndpointGraph();
  reply.send({ endpoints });
});

app.post("/api/schema/endpoints/clear", async (_request, reply) => {
  await clearEndpointCollection();
  clearEndpointCache();
  reply.send({ ok: true });
});

app.get("/api/config/mode", async (_request, reply) => {
  const appConfig = await getAppConfig();
  reply.send({ mode: appConfig?.mode ?? "database" });
});

app.post("/api/instructions", async (request, reply) => {
  const body = request.body as { text?: string; tableFullName?: string };
  if (!isNonEmptyString(body?.text)) {
    reply.status(400).send({ errorMessage: "Campo text obrigatorio." });
    return;
  }
  const trimmed = body.text!.trim();
  if (trimmed.length > 2000) {
    reply.status(400).send({ errorMessage: "Instrucao muito longa (max 2000)." });
    return;
  }

  const collection = await getInstructionsCollection();
  const createdAt = new Date();
  const tableFullName = body.tableFullName?.trim() || undefined;

  const result = await collection.insertOne({
    text: trimmed,
    tableFullName,
    createdAt
  });

  reply.send({
    id: result.insertedId.toString(),
    text: trimmed,
    tableFullName,
    createdAt: createdAt.toISOString()
  });
});

app.get("/api/instructions", async (_request, reply) => {
  const collection = await getInstructionsCollection();
  const docs = await collection
    .find({})
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();

  reply.send(
    docs.map((doc) => ({
      id: doc._id?.toString() ?? "",
      text: doc.text,
      tableFullName: doc.tableFullName,
      createdAt: doc.createdAt.toISOString()
    }))
  );
});

app.delete("/api/instructions/:id", async (request, reply) => {
  const { id } = request.params as { id: string };

  if (!id || !ObjectId.isValid(id)) {
    reply.status(400).send({ errorMessage: "Id invalido." });
    return;
  }

  const collection = await getInstructionsCollection();
  const result = await collection.deleteOne({ _id: new ObjectId(id) });

  if (result.deletedCount === 0) {
    reply.status(404).send({ errorMessage: "Instrucao nao encontrada." });
    return;
  }

  reply.send({ ok: true });
});

app.get("/api/settings/schema-language", async (_request, reply) => {
  const schemaLanguage = await getSchemaLanguageSetting();
  reply.send({ schemaLanguage });
});

app.put("/api/settings/schema-language", async (request, reply) => {
  const body = request.body as { schemaLanguage?: string };
  if (!isValidLanguage(body?.schemaLanguage)) {
    reply.status(400).send({ errorMessage: "schemaLanguage invalido." });
    return;
  }

  await setSchemaLanguageSetting(body.schemaLanguage);
  reply.send({ ok: true, schemaLanguage: body.schemaLanguage });
});

app.get("/api/settings/table-reference-count", async (_request, reply) => {
  const tableReferenceCount = await getTableReferenceCountSetting();
  reply.send({ tableReferenceCount });
});

app.put("/api/settings/table-reference-count", async (request, reply) => {
  const body = request.body as { tableReferenceCount?: number };
  const raw = body?.tableReferenceCount;
  if (!Number.isFinite(raw)) {
    reply.status(400).send({ errorMessage: "tableReferenceCount invalido." });
    return;
  }

  const tableReferenceCount = Math.max(1, Math.min(30, Math.floor(raw!)));
  await setTableReferenceCountSetting(tableReferenceCount);
  reply.send({ ok: true, tableReferenceCount });
});

app.get("/api/settings/agents", async (_request, reply) => {
  const agentsConfig = await getAgentsConfig();
  reply.send(agentsConfig);
});

app.put("/api/settings/agents", async (request, reply) => {
  const body = request.body as Partial<AgentsConfig>;
  if (!body || typeof body !== "object") {
    reply.status(400).send({ errorMessage: "Body invalido." });
    return;
  }

  const current = await getAgentsConfig();

  const next: AgentsConfig = {
    sql: {
      model: isNonEmptyString(body.sql?.model) ? body.sql!.model : current.sql.model,
      modelMini: isNonEmptyString(body.sql?.modelMini) ? body.sql!.modelMini : current.sql.modelMini,
      temperature: body.sql?.temperature !== undefined ? body.sql.temperature : current.sql.temperature,
      maxRetries: Number.isFinite(body.sql?.maxRetries)
        ? Math.max(1, Math.min(10, Math.floor(body.sql!.maxRetries)))
        : current.sql.maxRetries,
      enabled: typeof body.sql?.enabled === "boolean" ? body.sql.enabled : current.sql.enabled
    },
    http: {
      model: isNonEmptyString(body.http?.model) ? body.http!.model : current.http.model,
      temperature: body.http?.temperature !== undefined ? body.http.temperature : current.http.temperature,
      maxRetries: Number.isFinite(body.http?.maxRetries)
        ? Math.max(1, Math.min(10, Math.floor(body.http!.maxRetries)))
        : current.http.maxRetries,
      enabled: typeof body.http?.enabled === "boolean" ? body.http.enabled : current.http.enabled
    },
    summary: {
      model: isNonEmptyString(body.summary?.model) ? body.summary!.model : current.summary.model,
      temperature: body.summary?.temperature !== undefined ? body.summary.temperature : current.summary.temperature,
      enabled: typeof body.summary?.enabled === "boolean" ? body.summary.enabled : current.summary.enabled
    },
    translation: {
      model: isNonEmptyString(body.translation?.model) ? body.translation!.model : current.translation.model,
      temperature: body.translation?.temperature !== undefined ? body.translation.temperature : current.translation.temperature,
      enabled: typeof body.translation?.enabled === "boolean" ? body.translation.enabled : current.translation.enabled
    },
    chart: {
      model: isNonEmptyString(body.chart?.model) ? body.chart!.model : current.chart.model,
      temperature: body.chart?.temperature !== undefined ? body.chart.temperature : current.chart.temperature,
      enabled: typeof body.chart?.enabled === "boolean" ? body.chart.enabled : current.chart.enabled
    },
    embedding: {
      model: isNonEmptyString(body.embedding?.model) ? body.embedding!.model : current.embedding.model
    }
  };

  await saveAgentsConfig(next);
  reply.send(next);
});

app.post("/api/settings/reset-environment", async (_request, reply) => {
  await closeAdapter();
  clearOpenAICache();
  clearConfigCache();
  clearSchemaCache();
  clearAgentsConfigCache();
  clearEndpointCache();

  await clearSchemaCollection();
  await clearEndpointCollection();

  const mongo = await getMongoClient();
  const db = mongo.db(config.mongo.db);
  const [
    historyResult,
    instructionsResult,
    settingsResult,
    processingJobsResult,
    appConfigDeleted,
    redisDeleted
  ] =
    await Promise.all([
      db.collection("history").deleteMany({}),
      db.collection("instructions").deleteMany({}),
      db.collection("settings").deleteMany({}),
      db.collection("processing_jobs").deleteMany({}),
      clearAppConfig(),
      clearAskCache()
    ]);

  reply.send({
    ok: true,
    cleared: {
      history: historyResult.deletedCount ?? 0,
      instructions: instructionsResult.deletedCount ?? 0,
      settings: settingsResult.deletedCount ?? 0,
      processingJobs: processingJobsResult.deletedCount ?? 0,
      appConfig: appConfigDeleted,
      redisKeys: redisDeleted
    }
  });
});

app.get("/api/history", async (request, reply) => {
  const collection = await getHistoryCollection();
  const includeHidden = (request.query as { includeHidden?: string })?.includeHidden === "1";
  const docs = await collection
    .find(includeHidden ? {} : { deletedAt: { $exists: false } })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();

  reply.send(
    docs.map((doc) => ({
      id: doc._id?.toString() ?? "",
      chatId: doc.chatId,
      question: doc.question,
      sql: doc.sql,
      httpRequest: doc.httpRequest,
      mode: doc.mode,
      rows: doc.rows ?? [],
      columns: doc.columns ?? [],
      chart: doc.chart,
      summary: doc.summary,
      createdAt: doc.createdAt.toISOString(),
      favorite: doc.favorite,
      tags: doc.tags,
      language: doc.language,
      responseLanguage: doc.responseLanguage,
      success: doc.success,
      errorMessage: doc.errorMessage,
      elapsedMs: doc.elapsedMs,
      rowCount: doc.rowCount
    }))
  );
});

app.get("/api/chats", async (request, reply) => {
  const collection = await getHistoryCollection();
  const limitParam = (request.query as { limit?: string })?.limit;
  const includeHidden = (request.query as { includeHidden?: string })?.includeHidden === "1";
  const limit =
    limitParam && Number.isFinite(Number(limitParam)) ? Math.min(Number(limitParam), 200) : 50;

  const docs = await collection
    .aggregate<{
      _id: string;
      lastCreatedAt: Date;
      lastQuestion?: string;
      lastSummary?: string;
      lastSql?: string;
      lastSuccess?: boolean;
      lastErrorMessage?: string;
      lastLanguage?: string;
      lastResponseLanguage?: string;
      count: number;
    }>([
      {
        $match: {
          chatId: { $type: "string", $ne: "" },
          ...(includeHidden ? {} : { deletedAt: { $exists: false } })
        }
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$chatId",
          lastCreatedAt: { $first: "$createdAt" },
          lastQuestion: { $first: "$question" },
          lastSummary: { $first: "$summary" },
          lastSql: { $first: "$sql" },
          lastSuccess: { $first: "$success" },
          lastErrorMessage: { $first: "$errorMessage" },
          lastLanguage: { $first: "$language" },
          lastResponseLanguage: { $first: "$responseLanguage" },
          count: { $sum: 1 }
        }
      },
      { $sort: { lastCreatedAt: -1 } },
      { $limit: limit }
    ])
    .toArray();

  reply.send(
    docs.map((doc) => ({
      chatId: doc._id,
      lastCreatedAt: doc.lastCreatedAt.toISOString(),
      lastQuestion: doc.lastQuestion,
      lastSummary: doc.lastSummary,
      lastSql: doc.lastSql,
      lastSuccess: doc.lastSuccess,
      lastErrorMessage: doc.lastErrorMessage,
      lastLanguage: doc.lastLanguage,
      lastResponseLanguage: doc.lastResponseLanguage,
      messageCount: doc.count
    }))
  );
});

app.get("/api/chats/:chatId/messages", async (request, reply) => {
  const { chatId } = request.params as { chatId: string };
  const query = request.query as { limit?: string; includeHidden?: string };

  if (!isNonEmptyString(chatId) || chatId.length > 64) {
    reply.status(400).send({ errorMessage: "chatId invalido." });
    return;
  }

  const includeHidden = query?.includeHidden === "1";
  const limit =
    query?.limit && Number.isFinite(Number(query.limit)) ? Math.min(Number(query.limit), 500) : 200;

  const collection = await getHistoryCollection();
  const docs = await collection
    .find(
      includeHidden
        ? { chatId: chatId.trim() }
        : { chatId: chatId.trim(), deletedAt: { $exists: false } }
    )
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();

  reply.send(
    docs.map((doc) => ({
      id: doc._id?.toString() ?? "",
      chatId: doc.chatId,
      question: doc.question,
      sql: doc.sql,
      httpRequest: doc.httpRequest,
      mode: doc.mode,
      rows: doc.rows ?? [],
      columns: doc.columns ?? [],
      chart: doc.chart,
      summary: doc.summary,
      createdAt: doc.createdAt.toISOString(),
      favorite: doc.favorite,
      tags: doc.tags,
      language: doc.language,
      responseLanguage: doc.responseLanguage,
      success: doc.success,
      errorMessage: doc.errorMessage,
      elapsedMs: doc.elapsedMs,
      rowCount: doc.rowCount
    }))
  );
});

app.delete("/api/chats/:chatId", async (request, reply) => {
  const { chatId } = request.params as { chatId: string };

  if (!isNonEmptyString(chatId) || chatId.length > 64) {
    reply.status(400).send({ errorMessage: "chatId invalido." });
    return;
  }

  const collection = await getHistoryCollection();
  const normalizedChatId = chatId.trim();
  const exists = await collection.findOne({ chatId: normalizedChatId }, { projection: { _id: 1 } });

  if (!exists) {
    reply.status(404).send({ errorMessage: "Chat nao encontrado." });
    return;
  }

  const result = await collection.updateMany(
    { chatId: normalizedChatId, deletedAt: { $exists: false } },
    { $set: { deletedAt: new Date() } }
  );

  reply.send({ ok: true, hidden: result.modifiedCount });
});

app.patch("/api/history/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { favorite?: boolean; tags?: string[] };

  if (!id || !ObjectId.isValid(id)) {
    reply.status(400).send({ errorMessage: "Id invalido." });
    return;
  }

  const update: { favorite?: boolean; tags?: string[] } = {};
  if (typeof body.favorite === "boolean") update.favorite = body.favorite;
  if (Array.isArray(body.tags)) {
    update.tags = body.tags.filter((tag) => typeof tag === "string").slice(0, 10);
  }

  if (!Object.keys(update).length) {
    reply.status(400).send({ errorMessage: "Nada para atualizar." });
    return;
  }

  const collection = await getHistoryCollection();
  await collection.updateOne({ _id: new ObjectId(id) }, { $set: update });

  reply.send({ ok: true });
});

app.post(
  "/api/ask",
  {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: {
      tags: ["ask"],
      summary: "Processa pergunta via IA",
      body: {
        type: "object",
        properties: {
          question: { type: "string" },
          chatId: { type: "string", maxLength: 64 },
          language: { type: "string", enum: LANGUAGE_ENUM },
          schemaLanguage: { type: "string", enum: LANGUAGE_ENUM },
          responseLanguage: { type: "string", enum: LANGUAGE_ENUM },
          async: { type: "boolean" },
          webhookUrl: { type: "string", format: "uri" }
        },
        required: ["question"]
      },
      response: {
        200: askSuccessResponseSchema,
        202: {
          type: "object",
          properties: {
            processingId: { type: "string" },
            status: { type: "string", enum: ["processing"] }
          },
          required: ["processingId", "status"]
        },
        400: errorResponseSchema
      }
    }
  },
  async (request, reply) => {
    const body = request.body as AskBody;
    if (!isNonEmptyString(body?.question)) {
      reply.status(400).send({ errorMessage: "Campo question obrigatorio." });
      return;
    }
    if (typeof body.async !== "undefined" && typeof body.async !== "boolean") {
      reply.status(400).send({ errorMessage: "async invalido." });
      return;
    }
    if (body.webhookUrl && !isValidWebhookUrl(body.webhookUrl)) {
      reply.status(400).send({ errorMessage: "webhookUrl invalido." });
      return;
    }
    if (body.chatId && (!isNonEmptyString(body.chatId) || body.chatId.length > 64)) {
      reply.status(400).send({ errorMessage: "chatId invalido." });
      return;
    }
    if (body.language && !isValidLanguage(body.language)) {
      reply.status(400).send({ errorMessage: "language invalido." });
      return;
    }
    if (body.schemaLanguage && !isValidLanguage(body.schemaLanguage)) {
      reply.status(400).send({ errorMessage: "schemaLanguage invalido." });
      return;
    }
    if (body.responseLanguage && !isValidLanguage(body.responseLanguage)) {
      reply.status(400).send({ errorMessage: "responseLanguage invalido." });
      return;
    }

    const payload = await normalizeAskPayload(body);

    if (body.async) {
      const jobsCollection = await getProcessingJobsCollection();
      const now = new Date();
      const insertResult = await jobsCollection.insertOne({
        status: "processing",
        question: payload.question,
        chatId: payload.chatId,
        webhookUrl: payload.webhookUrl,
        language: payload.questionLanguage,
        schemaLanguage: payload.schemaLanguage,
        responseLanguage: payload.responseLanguage,
        createdAt: now,
        updatedAt: now
      });

      const processingId = insertResult.insertedId.toString();
      void processAskJob(processingId, payload);

      reply.status(202).send({
        processingId,
        status: "processing"
      });
      return;
    }

    const result = await answerQuestion(
      payload.question,
      payload.chatId,
      payload.questionLanguage,
      payload.schemaLanguage,
      payload.responseLanguage
    );
    if (!result.ok) {
      reply.status(400).send(result.error);
      return;
    }

    reply.send(result.data);
  }
);

app.post(
  "/api/ask/stream",
  {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: {
      tags: ["ask"],
      summary: "Processa pergunta via IA com streaming SSE",
      body: {
        type: "object",
        properties: {
          question: { type: "string" },
          chatId: { type: "string", maxLength: 64 },
          language: { type: "string", enum: LANGUAGE_ENUM },
          schemaLanguage: { type: "string", enum: LANGUAGE_ENUM },
          responseLanguage: { type: "string", enum: LANGUAGE_ENUM }
        },
        required: ["question"]
      }
    }
  },
  async (request, reply) => {
    const body = request.body as AskBody;
    if (!isNonEmptyString(body?.question)) {
      reply.status(400).send({ errorMessage: "Campo question obrigatorio." });
      return;
    }
    if (body.chatId && (!isNonEmptyString(body.chatId) || body.chatId.length > 64)) {
      reply.status(400).send({ errorMessage: "chatId invalido." });
      return;
    }
    if (body.language && !isValidLanguage(body.language)) {
      reply.status(400).send({ errorMessage: "language invalido." });
      return;
    }
    if (body.schemaLanguage && !isValidLanguage(body.schemaLanguage)) {
      reply.status(400).send({ errorMessage: "schemaLanguage invalido." });
      return;
    }
    if (body.responseLanguage && !isValidLanguage(body.responseLanguage)) {
      reply.status(400).send({ errorMessage: "responseLanguage invalido." });
      return;
    }

    const payload = await normalizeAskPayload(body);

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    const emit = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result = await answerQuestion(
        payload.question,
        payload.chatId,
        payload.questionLanguage,
        payload.schemaLanguage,
        payload.responseLanguage,
        emit
      );

      if (result.ok) {
        emit("done", result.data);
      } else {
        emit("error", result.error);
      }
    } catch (error) {
      emit("error", {
        errorMessage: extractErrorMessage(error)
      });
    }

    reply.raw.end();
  }
);

app.get(
  "/api/response/:processingId",
  {
    schema: {
      tags: ["ask"],
      summary: "Consulta status/resultado do processamento assíncrono",
      params: {
        type: "object",
        properties: {
          processingId: { type: "string" }
        },
        required: ["processingId"]
      },
      querystring: {
        type: "object",
        properties: {
          wait: { type: "string", description: "Use 0 para não aguardar" },
          timeoutMs: { type: "string", description: "Tempo máximo de espera em ms (0-55000)" }
        }
      },
      response: {
        200: {
          oneOf: [
            {
              type: "object",
              properties: {
                processingId: { type: "string" },
                status: { type: "string", enum: ["completed"] },
                data: askSuccessResponseSchema
              },
              required: ["processingId", "status", "data"]
            },
            {
              type: "object",
              properties: {
                processingId: { type: "string" },
                status: { type: "string", enum: ["failed"] },
                error: errorResponseSchema
              },
              required: ["processingId", "status", "error"]
            }
          ]
        },
        202: {
          type: "object",
          properties: {
            processingId: { type: "string" },
            status: { type: "string", enum: ["processing"] }
          },
          required: ["processingId", "status"]
        },
        400: errorResponseSchema,
        404: errorResponseSchema
      }
    }
  },
  async (request, reply) => {
    const { processingId } = request.params as { processingId: string };
    const query = request.query as { wait?: string; timeoutMs?: string };

    if (!processingId || !ObjectId.isValid(processingId)) {
      reply.status(400).send({ errorMessage: "processingId invalido." });
      return;
    }

    const shouldWait = query.wait !== "0";
    let timeoutMs = 30_000;
    if (typeof query.timeoutMs === "string" && query.timeoutMs.trim()) {
      const parsed = Number.parseInt(query.timeoutMs, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        reply.status(400).send({ errorMessage: "timeoutMs invalido." });
        return;
      }
      timeoutMs = parsed;
    }
    timeoutMs = Math.min(timeoutMs, RESPONSE_MAX_WAIT_MS);

    const jobsCollection = await getProcessingJobsCollection();
    const id = new ObjectId(processingId);
    let job = await jobsCollection.findOne({ _id: id });

    if (!job) {
      reply.status(404).send({ errorMessage: "Processamento nao encontrado." });
      return;
    }

    if (shouldWait && job.status === "processing" && timeoutMs > 0) {
      const deadline = Date.now() + timeoutMs;
      while (job.status === "processing" && Date.now() < deadline) {
        await sleep(RESPONSE_POLL_INTERVAL_MS);
        const next = await jobsCollection.findOne({ _id: id });
        if (!next) break;
        job = next;
      }
    }

    if (job.status === "processing") {
      reply.status(202).send({
        processingId,
        status: "processing"
      });
      return;
    }

    if (job.status === "failed") {
      reply.send({
        processingId,
        status: "failed",
        error: job.error ?? { errorMessage: "Falha no processamento." }
      });
      return;
    }

    if (!job.result) {
      reply.status(500).send({
        errorMessage: "Processamento concluido sem resultado."
      });
      return;
    }

    reply.send({
      processingId,
      status: "completed",
      data: job.result
    });
  }
);

app.post(
  "/api/run",
  {
    schema: {
      tags: ["sql"],
      summary: "Executa SQL validado",
      body: {
        type: "object",
        properties: {
          sql: { type: "string" }
        },
        required: ["sql"]
      },
      response: {
        200: {
          type: "object",
          properties: {
            sql: { type: "string" },
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true
              }
            },
            columns: { type: "array", items: { type: "string" } },
            elapsedMs: { type: "number" },
            chart: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["bar", "line"] },
                data: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      category: { type: "string" },
                      value: { anyOf: [{ type: "number" }, { type: "null" }] }
                    },
                    required: ["category", "value"]
                  }
                },
                title: { type: "string" },
                xKey: { type: "string" },
                yKey: { type: "string" }
              },
              required: ["type", "data"]
            }
          },
          required: ["sql", "rows", "columns", "elapsedMs"]
        },
        400: errorResponseSchema
      }
    }
  },
  async (request, reply) => {
    const body = request.body as { sql?: string };
    if (!isNonEmptyString(body?.sql)) {
      reply.status(400).send({ errorMessage: "Campo sql obrigatorio." });
      return;
    }

    const adapter = await getAdapter();
    const validation = validateSql(body.sql, adapter.getDbType());
    if (!validation.ok) {
      reply.status(400).send(validation.error);
      return;
    }

    const start = Date.now();
    const result = await adapter.query(body.sql);
    const elapsedMs = Date.now() - start;
    const columns = result.columns;
    const [first, second] = columns;
    const xKey = first && first !== second ? first : undefined;
    const yKey = second ?? first;
    const chart =
      xKey && yKey && xKey !== yKey
        ? {
            type: "bar" as const,
            data:
              result.recordset?.map((row) => ({
                category: String(row[xKey] ?? ""),
                value:
                  typeof row[yKey] === "number" && Number.isFinite(row[yKey])
                    ? (row[yKey] as number)
                    : null
              })) ?? [],
            title: "Resultados",
            xKey,
            yKey
          }
        : undefined;

    reply.send({
      sql: body.sql,
      rows: result.recordset ?? [],
      columns,
      elapsedMs,
      chart
    });
  }
);

await ensureDefaultSettings();

app.listen({ port: config.port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
