import type { FastifyInstance } from "fastify";
import { isNonEmptyString } from "@auraia/shared";
import type { AgentsConfig } from "@auraia/shared";
import { closeAdapter } from "../core/db.js";
import { clearSchemaCache } from "../pipeline/schema.js";
import { clearSchemaCollection, clearEndpointCollection } from "../core/qdrant.js";
import { clearEndpointCache } from "../pipeline/swagger.js";
import { clearConfigCache, clearAppConfig } from "../core/appConfig.js";
import { clearOpenAICache } from "../core/openai.js";
import { clearAskCache } from "../core/cache.js";
import { getAgentsConfig, saveAgentsConfig, clearAgentsConfigCache } from "../core/agentConfig.js";
import { getMongoClient } from "../core/mongo.js";
import { config } from "../core/config.js";
import {
  isValidLanguage,
  getSchemaLanguageSetting,
  setSchemaLanguageSetting,
  getTableReferenceCountSetting,
  setTableReferenceCountSetting
} from "../helpers/settings.js";

export default async function settingsRoutes(app: FastifyInstance) {
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
    ] = await Promise.all([
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
}
