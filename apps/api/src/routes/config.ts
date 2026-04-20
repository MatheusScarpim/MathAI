import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { isNonEmptyString, sanitizeErrorMessage } from "@auraia/shared";
import { closeAdapter, testConnection } from "../core/db.js";
import { clearSchemaCache } from "../pipeline/schema.js";
import { clearEndpointCache } from "../pipeline/swagger.js";
import {
  clearConfigCache,
  getAppConfig,
  listEnvironments,
  saveAppConfig,
  type AppConfig,
  type DbType
} from "../core/appConfig.js";
import { clearOpenAICache } from "../core/openai.js";

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

export default async function configRoutes(app: FastifyInstance) {
  app.get("/api/config/status", async (_request, reply) => {
    const environments = await listEnvironments();
    reply.send({
      configured: environments.length > 0,
      environmentCount: environments.length,
      environments: environments.map(e => ({ environmentId: e.environmentId, name: e.name }))
    });
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
    if (
      !isNonEmptyString(body.dbHost) ||
      !isNonEmptyString(body.dbName) ||
      !isNonEmptyString(body.dbUser) ||
      !isNonEmptyString(body.dbPassword)
    ) {
      reply
        .status(400)
        .send({ errorMessage: "Campos de conexao obrigatorios: dbHost, dbName, dbUser, dbPassword." });
      return;
    }
    const dbPort = parsePort(body.dbPort);
    if (!dbPort) {
      reply.status(400).send({ errorMessage: "dbPort invalido." });
      return;
    }

    const result = await testConnection(
      body.dbType,
      body.dbHost!.trim(),
      dbPort,
      body.dbName!.trim(),
      body.dbUser!.trim(),
      body.dbPassword!
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
      const client = new OpenAI({ apiKey: body.openAiApiKey!.trim() });
      await client.models.list();
      reply.send({ ok: true });
    } catch (error) {
      reply
        .status(400)
        .send({
          errorMessage: sanitizeErrorMessage(
            (error as { message?: string })?.message ?? "OpenAI key invalida."
          )
        });
    }
  });

  app.post("/api/config", async (request, reply) => {
    const body = request.body as SaveConfigBody;
    if (!isNonEmptyString(body.openAiApiKey)) {
      reply.status(400).send({ errorMessage: "openAiApiKey obrigatoria." });
      return;
    }

    const mode = body.mode === "api" ? ("api" as const) : ("database" as const);

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
        openAiApiKey: body.openAiApiKey!.trim(),
        mode: "api",
        apiBaseUrl: body.apiBaseUrl!.trim(),
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
    if (
      !isNonEmptyString(body.dbHost) ||
      !isNonEmptyString(body.dbName) ||
      !isNonEmptyString(body.dbUser) ||
      !isNonEmptyString(body.dbPassword)
    ) {
      reply
        .status(400)
        .send({ errorMessage: "Campos de conexao obrigatorios: dbHost, dbName, dbUser, dbPassword." });
      return;
    }
    const dbPort = parsePort(body.dbPort);
    if (!dbPort) {
      reply.status(400).send({ errorMessage: "dbPort invalido." });
      return;
    }

    const nextConfig: AppConfig = {
      openAiApiKey: body.openAiApiKey!.trim(),
      mode: "database",
      dbType: body.dbType,
      dbHost: body.dbHost!.trim(),
      dbPort,
      dbName: body.dbName!.trim(),
      dbUser: body.dbUser!.trim(),
      dbPassword: body.dbPassword!,
      configuredAt: new Date()
    };

    await saveAppConfig(nextConfig);
    await closeAdapter();
    clearConfigCache();
    clearOpenAICache();
    clearSchemaCache();
    reply.send({ ok: true });
  });

  app.post("/api/config/test-api", async (request, reply) => {
    const body = request.body as {
      apiBaseUrl?: string;
      apiAuthType?: string;
      apiAuthToken?: string;
      apiAuthApiKeyHeader?: string;
      apiAuthApiKeyValue?: string;
      apiAuthUsername?: string;
      apiAuthPassword?: string;
    };
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
        headers.Authorization = `Basic ${Buffer.from(
          `${body.apiAuthUsername}:${body.apiAuthPassword ?? ""}`
        ).toString("base64")}`;
      }
      const response = await fetch(body.apiBaseUrl!.trim(), { method: "GET", headers });
      if (!response.ok && response.status >= 500) {
        reply.status(400).send({ errorMessage: `API retornou HTTP ${response.status}.` });
        return;
      }
      reply.send({ ok: true });
    } catch (error) {
      reply.status(400).send({
        errorMessage: sanitizeErrorMessage(
          (error as { message?: string })?.message ?? "Erro ao conectar na API."
        )
      });
    }
  });

  app.get("/api/config/mode", async (_request, reply) => {
    const appConfig = await getAppConfig();
    reply.send({ mode: appConfig?.mode ?? "database" });
  });
}
