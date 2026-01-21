import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { getPool } from "./db.js";
import {
  ingestSchemaToQdrant,
  loadSchemaFromSqlServer,
  loadSchemaGraph,
  clearSchemaCache
} from "./schema.js";
import { clearSchemaCollection } from "./qdrant.js";
import { answerQuestion } from "./ask.js";
import { isNonEmptyString, sanitizeErrorMessage } from "@auraia/shared";
import { validateSql } from "./validation.js";
import { getHistoryCollection, getInstructionsCollection, getSettingsCollection } from "./mongo.js";
import { ObjectId } from "mongodb";

const app = Fastify({
  logger: true,
  bodyLimit: 1_000_000
});

await app.register(cors, { origin: true });
await app.register(rateLimit, { global: false });

const VALID_LANGUAGES = ["pt", "en", "es"] as const;

const isValidLanguage = (value: string | undefined): value is (typeof VALID_LANGUAGES)[number] =>
  Boolean(value && VALID_LANGUAGES.includes(value as (typeof VALID_LANGUAGES)[number]));

const getSchemaLanguageSetting = async (): Promise<(typeof VALID_LANGUAGES)[number]> => {
  const collection = await getSettingsCollection();
  const doc = await collection.findOne({ key: "schemaLanguage" });
  if (doc && isValidLanguage(doc.value)) return doc.value;
  return "pt";
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

app.post("/api/ingest/schema", async (_request, reply) => {
  const pool = await getPool();
  const tables = await loadSchemaFromSqlServer(pool);
  const tablesIndexed = await ingestSchemaToQdrant(tables);
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

app.get("/api/history", async (_request, reply) => {
  const collection = await getHistoryCollection();
  const docs = await collection
    .find({})
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();

  reply.send(
    docs.map((doc) => ({
      id: doc._id?.toString() ?? "",
      chatId: doc.chatId,
      question: doc.question,
      sql: doc.sql,
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
  { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
  async (request, reply) => {
    const body = request.body as {
      question?: string;
      chatId?: string;
      language?: string;
      schemaLanguage?: string;
      responseLanguage?: string;
    };
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

    const resolvedSchemaLanguage = isValidLanguage(body.schemaLanguage)
      ? body.schemaLanguage
      : await getSchemaLanguageSetting();
    const resolvedQuestionLanguage = isValidLanguage(body.language) ? body.language : "pt";
    const resolvedResponseLanguage = isValidLanguage(body.responseLanguage)
      ? body.responseLanguage
      : resolvedQuestionLanguage;
    const result = await answerQuestion(
      body.question.trim(),
      body.chatId?.trim(),
      resolvedQuestionLanguage,
      resolvedSchemaLanguage,
      resolvedResponseLanguage
    );
    if (!result.ok) {
      reply.status(400).send(result.error);
      return;
    }

    reply.send(result.data);
  }
);

app.post("/api/run", async (request, reply) => {
  const body = request.body as { sql?: string };
  if (!isNonEmptyString(body?.sql)) {
    reply.status(400).send({ errorMessage: "Campo sql obrigatorio." });
    return;
  }

  const validation = validateSql(body.sql);
  if (!validation.ok) {
    reply.status(400).send(validation.error);
    return;
  }

  const pool = await getPool();
  const start = Date.now();
  const result = await pool.request().query(body.sql);
  const elapsedMs = Date.now() - start;
  const columns = result.recordset?.columns
    ? Object.keys(result.recordset.columns)
    : result.recordset?.[0]
      ? Object.keys(result.recordset[0])
      : [];
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
});

app.listen({ port: config.port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
