import type { FastifyInstance } from "fastify";
import { isNonEmptyString } from "@auraia/shared";
import { ObjectId } from "mongodb";
import { getHistoryCollection, type HistoryRecord } from "../core/mongo.js";

const mapHistoryDoc = (doc: HistoryRecord) => ({
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
});

export default async function historyRoutes(app: FastifyInstance) {
  app.get("/api/history", async (request, reply) => {
    const collection = await getHistoryCollection();
    const includeHidden = (request.query as { includeHidden?: string })?.includeHidden === "1";
    const docs = await collection
      .find(includeHidden ? {} : { deletedAt: { $exists: false } })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    reply.send(docs.map(mapHistoryDoc));
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
      query?.limit && Number.isFinite(Number(query.limit))
        ? Math.min(Number(query.limit), 500)
        : 200;

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

    reply.send(docs.map(mapHistoryDoc));
  });

  app.delete("/api/chats/:chatId", async (request, reply) => {
    const { chatId } = request.params as { chatId: string };

    if (!isNonEmptyString(chatId) || chatId.length > 64) {
      reply.status(400).send({ errorMessage: "chatId invalido." });
      return;
    }

    const collection = await getHistoryCollection();
    const normalizedChatId = chatId.trim();
    const exists = await collection.findOne(
      { chatId: normalizedChatId },
      { projection: { _id: 1 } }
    );

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
}
