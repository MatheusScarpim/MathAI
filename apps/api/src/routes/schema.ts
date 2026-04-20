import type { FastifyInstance } from "fastify";
import { isNonEmptyString } from "@auraia/shared";
import { getAdapter } from "../core/db.js";
import {
  ingestSchemaToQdrant,
  loadSchema,
  loadSchemaGraph,
  clearSchemaCache,
  deleteTableFromQdrant
} from "../pipeline/schema.js";
import { clearSchemaCollection, clearEndpointCollection } from "../core/qdrant.js";
import {
  fetchSwaggerSpec,
  parseSwaggerSpec,
  ingestEndpointsToQdrant,
  loadEndpointGraph,
  clearEndpointCache
} from "../pipeline/swagger.js";

export default async function schemaRoutes(app: FastifyInstance) {
  app.post("/api/ingest/schema", async (request, reply) => {
    const body = request.body as { environmentId?: string } | null;
    const envId = body?.environmentId;
    const adapter = await getAdapter(envId);
    const tables = await loadSchema(adapter);
    const tablesIndexed = await ingestSchemaToQdrant(tables, envId);
    clearSchemaCache(envId);
    reply.send({ tablesIndexed });
  });

  app.get("/api/schema/tables", async (request) => {
    const query = request.query as { environmentId?: string };
    const tables = await loadSchemaGraph(query.environmentId);
    return { tables };
  });

  app.post("/api/schema/clear", async (request, reply) => {
    const body = request.body as { environmentId?: string } | null;
    await clearSchemaCollection(body?.environmentId);
    clearSchemaCache(body?.environmentId);
    reply.send({ ok: true });
  });

  app.delete("/api/schema/tables/:tableFullName", async (request, reply) => {
    const { tableFullName } = request.params as { tableFullName: string };
    const query = request.query as { environmentId?: string };
    await deleteTableFromQdrant(decodeURIComponent(tableFullName), query.environmentId);
    reply.send({ ok: true });
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
    const endpoints = allEndpoints.filter((e) => e.method.toUpperCase() === "GET");
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
}
