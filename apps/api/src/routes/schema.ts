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
  upsertInferredColumns,
  upsertTableFacts,
  getSeed,
  getVocabulary,
  saveSeed,
  parseSeed,
  SeedError
} from "../schema/dictionary.js";
import { getAppConfig, getEnvironment } from "../core/appConfig.js";
import { resolveAllowedMethods } from "../pipeline/httpValidation.js";
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

    // Classificacao lexica do dicionario. Roda depois do Qdrant de proposito:
    // a busca vetorial e o caminho critico do ingest e nao pode ficar refem
    // do Mongo. Um erro aqui degrada a assertividade, nao derruba o indice.
    //
    // O vocabulario e resolvido UMA vez: sao centenas de colunas e ele nao
    // muda no meio do ingest. Se o Mongo estiver fora, cai nas convencoes
    // PT-BR embutidas — pior classificacao, nao ingest quebrado.
    let vocabulary;
    let seedName = "none";
    try {
      vocabulary = await getVocabulary(envId);
      seedName = (await getSeed(envId)).name;
    } catch (err) {
      app.log.warn({ err }, "dicionario: seed indisponivel, usando so convencoes PT-BR");
    }

    let columnsClassified = 0;
    for (const table of tables) {
      try {
        columnsClassified += await upsertInferredColumns(
          table.fullName,
          table.columns,
          envId,
          vocabulary
        );
      } catch (err) {
        app.log.warn({ err, table: table.fullName }, "dicionario: falha ao classificar colunas");
      }
    }

    // Grao e coluna de data do evento (E2). Mesma politica: falhar aqui
    // degrada assertividade, nao derruba o ingest.
    let tableFactsWritten = 0;
    try {
      tableFactsWritten = await upsertTableFacts(tables, envId);
    } catch (err) {
      app.log.warn({ err }, "dicionario: falha ao gravar grao/data das tabelas");
    }

    clearSchemaCache(envId);
    reply.send({ tablesIndexed, columnsClassified, tableFactsWritten, seed: seedName });
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

  app.get("/api/schema/seed", async (request) => {
    const query = request.query as { environmentId?: string };
    return { seed: await getSeed(query.environmentId) };
  });

  /**
   * Instala o vocabulario de dominio do ambiente.
   *
   * NAO reclassifica sozinho: o dicionario ja gravado continua como esta ate
   * o proximo `POST /api/ingest/schema`. Isso e deliberado — reclassificar
   * centenas de colunas dentro de um PUT transformaria uma edicao de
   * configuracao numa operacao longa e parcialmente aplicavel se falhasse no
   * meio. A resposta diz o que falta fazer.
   */
  app.put("/api/schema/seed", async (request, reply) => {
    const body = request.body as { environmentId?: string; seed?: unknown } | null;
    if (body?.seed === undefined) {
      reply.status(400).send({ errorMessage: "Informe o campo seed." });
      return;
    }

    let seed;
    try {
      seed = parseSeed(body.seed);
    } catch (err) {
      // Erro de seed e erro do usuario, nao 500: a mensagem diz qual campo.
      if (err instanceof SeedError) {
        reply.status(400).send({ errorMessage: err.message });
        return;
      }
      throw err;
    }

    await saveSeed(seed, body.environmentId);
    reply.send({
      ok: true,
      name: seed.name,
      curatedTables: Object.keys(seed.tableFacts).length,
      reingestRequired: true
    });
  });

  app.delete("/api/schema/tables/:tableFullName", async (request, reply) => {
    const { tableFullName } = request.params as { tableFullName: string };
    const query = request.query as { environmentId?: string };
    await deleteTableFromQdrant(decodeURIComponent(tableFullName), query.environmentId);
    reply.send({ ok: true });
  });

  app.post("/api/ingest/swagger", async (request, reply) => {
    const body = request.body as { url?: string; content?: string; environmentId?: string };
    const envId = body.environmentId;
    let specContent: string;

    if (isNonEmptyString(body.content)) {
      specContent = body.content!;
    } else if (isNonEmptyString(body.url)) {
      specContent = await fetchSwaggerSpec(body.url!.trim());
    } else {
      reply.status(400).send({ errorMessage: "Informe url ou content do swagger spec." });
      return;
    }

    // Which methods this environment indexes is its own decision; a spec whose
    // query endpoints are POST used to be rejected wholesale.
    const envConfig = envId ? await getEnvironment(envId) : await getAppConfig();
    const allowedMethods = resolveAllowedMethods(
      envConfig?.apiIngestMethods,
      envConfig?.apiReadOnly ?? true
    );

    const allEndpoints = parseSwaggerSpec(specContent);
    const endpoints = allEndpoints.filter((e) =>
      allowedMethods.includes(e.method.toUpperCase())
    );
    if (endpoints.length === 0) {
      reply.status(400).send({
        errorMessage:
          `Nenhum endpoint com metodo habilitado (${allowedMethods.join(", ")}) ` +
          `encontrado no swagger spec.`
      });
      return;
    }

    const endpointsIndexed = await ingestEndpointsToQdrant(endpoints, envId);
    clearEndpointCache(envId);
    reply.send({ endpointsIndexed });
  });

  app.get("/api/schema/endpoints", async (request, reply) => {
    const query = request.query as { environmentId?: string };
    const endpoints = await loadEndpointGraph(query.environmentId);
    reply.send({ endpoints });
  });

  app.post("/api/schema/endpoints/clear", async (request, reply) => {
    const body = request.body as { environmentId?: string } | null;
    await clearEndpointCollection(body?.environmentId);
    clearEndpointCache(body?.environmentId);
    reply.send({ ok: true });
  });
}
