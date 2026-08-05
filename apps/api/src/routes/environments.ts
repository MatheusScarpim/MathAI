import type { FastifyInstance } from "fastify";
import { isNonEmptyString } from "@auraia/shared";
import { closeAdapter, testConnection } from "../core/db.js";
import { clearSchemaCache } from "../pipeline/schema.js";
import { clearSchemaCollection } from "../core/qdrant.js";
import { normalizeIngestMethods } from "../pipeline/httpValidation.js";
import {
  listEnvironments,
  getEnvironment,
  createEnvironment,
  updateEnvironment,
  deleteEnvironment,
  clearEnvironmentCache,
  type AppConfig,
  type DbType,
  type EnvironmentConfig
} from "../core/appConfig.js";

type EnvironmentBody = {
  name?: string;
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
  apiIngestMethods?: string[];
  swaggerUrl?: string;
  swaggerContent?: string;
};

const sanitizeEnvironment = (env: EnvironmentConfig) => ({
  environmentId: env.environmentId,
  name: env.name,
  mode: env.mode,
  dbType: env.dbType,
  dbHost: env.dbHost,
  dbPort: env.dbPort,
  dbName: env.dbName,
  dbUser: env.dbUser,
  apiBaseUrl: env.apiBaseUrl,
  apiAuthType: env.apiAuthType,
  apiReadOnly: env.apiReadOnly,
  apiIngestMethods: env.apiIngestMethods,
  swaggerUrl: env.swaggerUrl,
  configuredAt: env.configuredAt
});

export default async function environmentsRoutes(app: FastifyInstance) {
  app.get("/api/environments", async (_request, reply) => {
    const environments = await listEnvironments();
    reply.send({ environments: environments.map(sanitizeEnvironment) });
  });

  app.get("/api/environments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const env = await getEnvironment(id);
    if (!env) {
      reply.status(404).send({ errorMessage: "Ambiente nao encontrado." });
      return;
    }
    reply.send(sanitizeEnvironment(env));
  });

  app.post("/api/environments", async (request, reply) => {
    const body = request.body as EnvironmentBody;
    if (!isNonEmptyString(body.name)) {
      reply.status(400).send({ errorMessage: "name obrigatorio." });
      return;
    }
    if (!isNonEmptyString(body.openAiApiKey)) {
      reply.status(400).send({ errorMessage: "openAiApiKey obrigatoria." });
      return;
    }

    const mode = body.mode === "api" ? "api" : "database";
    const env = await createEnvironment({
      name: body.name!.trim(),
      openAiApiKey: body.openAiApiKey!.trim(),
      mode: mode as AppConfig["mode"],
      dbType: body.dbType,
      dbHost: body.dbHost?.trim(),
      dbPort:
        typeof body.dbPort === "string" ? Number.parseInt(body.dbPort, 10) : body.dbPort,
      dbName: body.dbName?.trim(),
      dbUser: body.dbUser?.trim(),
      dbPassword: body.dbPassword,
      apiBaseUrl: body.apiBaseUrl?.trim(),
      apiAuthType: body.apiAuthType as AppConfig["apiAuthType"],
      apiAuthToken: body.apiAuthToken,
      apiAuthApiKeyHeader: body.apiAuthApiKeyHeader,
      apiAuthApiKeyValue: body.apiAuthApiKeyValue,
      apiAuthUsername: body.apiAuthUsername,
      apiAuthPassword: body.apiAuthPassword,
      apiReadOnly: body.apiReadOnly,
      apiIngestMethods: normalizeIngestMethods(body.apiIngestMethods),
      swaggerUrl: body.swaggerUrl?.trim(),
      swaggerContent: body.swaggerContent,
      configuredAt: new Date()
    });

    reply.status(201).send(sanitizeEnvironment(env));
  });

  app.put("/api/environments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as EnvironmentBody;

    const updates: Partial<EnvironmentConfig> = {};
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.openAiApiKey !== undefined) updates.openAiApiKey = body.openAiApiKey.trim();
    if (body.mode !== undefined)
      updates.mode = (body.mode === "api" ? "api" : "database") as AppConfig["mode"];
    if (body.dbType !== undefined) updates.dbType = body.dbType;
    if (body.dbHost !== undefined) updates.dbHost = body.dbHost.trim();
    if (body.dbPort !== undefined)
      updates.dbPort =
        typeof body.dbPort === "string" ? Number.parseInt(body.dbPort, 10) : body.dbPort;
    if (body.dbName !== undefined) updates.dbName = body.dbName.trim();
    if (body.dbUser !== undefined) updates.dbUser = body.dbUser.trim();
    if (body.dbPassword !== undefined) updates.dbPassword = body.dbPassword;
    if (body.apiBaseUrl !== undefined) updates.apiBaseUrl = body.apiBaseUrl.trim();
    if (body.apiAuthType !== undefined)
      updates.apiAuthType = body.apiAuthType as AppConfig["apiAuthType"];
    if (body.apiAuthToken !== undefined) updates.apiAuthToken = body.apiAuthToken;
    if (body.apiAuthApiKeyHeader !== undefined)
      updates.apiAuthApiKeyHeader = body.apiAuthApiKeyHeader;
    if (body.apiAuthApiKeyValue !== undefined)
      updates.apiAuthApiKeyValue = body.apiAuthApiKeyValue;
    if (body.apiAuthUsername !== undefined) updates.apiAuthUsername = body.apiAuthUsername;
    if (body.apiAuthPassword !== undefined) updates.apiAuthPassword = body.apiAuthPassword;
    if (body.apiReadOnly !== undefined) updates.apiReadOnly = body.apiReadOnly;
    if (body.apiIngestMethods !== undefined)
      updates.apiIngestMethods = normalizeIngestMethods(body.apiIngestMethods);
    if (body.swaggerUrl !== undefined) updates.swaggerUrl = body.swaggerUrl.trim();
    if (body.swaggerContent !== undefined) updates.swaggerContent = body.swaggerContent;

    const env = await updateEnvironment(id, updates);
    if (!env) {
      reply.status(404).send({ errorMessage: "Ambiente nao encontrado." });
      return;
    }

    await closeAdapter(id);
    clearEnvironmentCache();
    reply.send(sanitizeEnvironment(env));
  });

  app.delete("/api/environments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await deleteEnvironment(id);
    if (!deleted) {
      reply.status(404).send({ errorMessage: "Ambiente nao encontrado." });
      return;
    }

    await closeAdapter(id);
    await clearSchemaCollection(id);
    clearSchemaCache(id);
    reply.send({ ok: true });
  });

  app.post("/api/environments/:id/test-db", async (request, reply) => {
    const { id } = request.params as { id: string };
    const env = await getEnvironment(id);
    if (!env) {
      reply.status(404).send({ errorMessage: "Ambiente nao encontrado." });
      return;
    }

    if (!env.dbType || !env.dbHost || !env.dbName || !env.dbUser) {
      reply.status(400).send({ errorMessage: "Configuracao de banco incompleta." });
      return;
    }

    const result = await testConnection(
      env.dbType,
      env.dbHost,
      typeof env.dbPort === "number" ? env.dbPort : 1433,
      env.dbName,
      env.dbUser,
      env.dbPassword ?? ""
    );

    reply.send(result);
  });
}
