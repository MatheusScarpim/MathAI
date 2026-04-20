import type { FastifyInstance } from "fastify";
import { isNonEmptyString, sanitizeErrorMessage } from "@auraia/shared";
import { ObjectId } from "mongodb";
import { answerQuestion } from "../pipeline/ask.js";
import { getAdapter } from "../core/db.js";
import { validateSql } from "../core/validation.js";
import { getProcessingJobsCollection } from "../core/mongo.js";
import { isValidLanguage } from "../helpers/settings.js";
import {
  type AskBody,
  type NormalizedAskPayload,
  normalizeAskPayload,
  isValidWebhookUrl
} from "../helpers/normalize.js";
import { sendWebhookNotification } from "../helpers/webhook.js";

// ── Shared constants ─────────────────────────────────────────────────────────

const VALID_LANGUAGES = ["pt", "en", "es"] as const;
const LANGUAGE_ENUM = [...VALID_LANGUAGES];
const RESPONSE_POLL_INTERVAL_MS = 500;
const RESPONSE_MAX_WAIT_MS = 55_000;
const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Schemas ───────────────────────────────────────────────────────────────────

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
    rows: { type: "array", items: { type: "object", additionalProperties: true } },
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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
      payload.responseLanguage,
      undefined,
      payload.environmentId
    );
    if (!result.ok) {
      await collection.updateOne(
        { _id: new ObjectId(processingId) },
        { $set: { status: "failed", error: result.error, updatedAt: new Date() } }
      );
      await sendWebhookNotification(processingId, { status: "failed", error: result.error });
      return;
    }
    await collection.updateOne(
      { _id: new ObjectId(processingId) },
      { $set: { status: "completed", result: result.data, updatedAt: new Date() } }
    );
    await sendWebhookNotification(processingId, { status: "completed", result: result.data });
  } catch (error) {
    const failure = {
      errorMessage: sanitizeErrorMessage(
        (error as { message?: string })?.message ?? "Erro interno no processamento."
      )
    };
    await collection.updateOne(
      { _id: new ObjectId(processingId) },
      { $set: { status: "failed", error: failure, updatedAt: new Date() } }
    );
    await sendWebhookNotification(processingId, { status: "failed", error: failure });
  }
};

// ── Plugin ────────────────────────────────────────────────────────────────────

export default async function askRoutes(app: FastifyInstance) {
  // POST /api/ask
  app.post<{ Body: AskBody }>(
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
            webhookUrl: { type: "string", format: "uri" },
            environmentId: { type: "string", description: "ID do ambiente a ser usado" }
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
      const body = request.body;

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

        reply.status(202).send({ processingId, status: "processing" });
        return;
      }

      const result = await answerQuestion(
        payload.question,
        payload.chatId,
        payload.questionLanguage,
        payload.schemaLanguage,
        payload.responseLanguage,
        undefined,
        payload.environmentId
      );

      if (!result.ok) {
        reply.status(400).send(result.error);
        return;
      }

      reply.send(result.data);
    }
  );

  // POST /api/ask/stream
  app.post<{ Body: AskBody }>(
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
            responseLanguage: { type: "string", enum: LANGUAGE_ENUM },
            environmentId: { type: "string", description: "ID do ambiente a ser usado" }
          },
          required: ["question"]
        }
      }
    },
    async (request, reply) => {
      const body = request.body;

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
          emit,
          payload.environmentId
        );

        if (result.ok) {
          emit("done", result.data);
        } else {
          emit("error", result.error);
        }
      } catch (error) {
        emit("error", { errorMessage: extractErrorMessage(error) });
      }

      reply.raw.end();
    }
  );

  // GET /api/response/:processingId
  app.get<{ Params: { processingId: string }; Querystring: { wait?: string; timeoutMs?: string } }>(
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
      const { processingId } = request.params;
      const query = request.query;

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
        reply.status(202).send({ processingId, status: "processing" });
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
        reply.status(500).send({ errorMessage: "Processamento concluido sem resultado." });
        return;
      }

      reply.send({ processingId, status: "completed", data: job.result });
    }
  );

  // POST /api/run
  app.post<{ Body: { sql?: string } }>(
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
                items: { type: "object", additionalProperties: true }
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
      const body = request.body;

      if (!isNonEmptyString(body?.sql)) {
        reply.status(400).send({ errorMessage: "Campo sql obrigatorio." });
        return;
      }

      const adapter = await getAdapter();
      const validation = validateSql(body.sql!, adapter.getDbType());
      if (!validation.ok) {
        reply.status(400).send(validation.error);
        return;
      }

      const start = Date.now();
      const result = await adapter.query(body.sql!);
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
}
