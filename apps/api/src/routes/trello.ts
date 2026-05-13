import type { FastifyInstance } from "fastify";
import { getBoards, getBoardLists, getTrelloCredentials } from "../orchestrator/integrations/trello.js";

const isTrelloConfigured = async (): Promise<boolean> => {
  const { apiKey, apiToken } = await getTrelloCredentials();
  return Boolean(apiKey) && Boolean(apiToken);
};

export default async function trelloRoutes(app: FastifyInstance) {
  // Lista boards do usuario Trello (credencial global)
  app.get(
    "/api/trello/boards",
    {
      schema: {
        tags: ["trello"],
        summary: "Lista boards do usuario Trello"
      }
    },
    async (_req, reply) => {
      if (!(await isTrelloConfigured())) {
        reply.status(400).send({ errorMessage: "Trello nao configurado (apiKey/apiToken ausentes)." });
        return;
      }
      try {
        const boards = await getBoards();
        reply.send(boards.map(b => ({ id: b.id, name: b.name, url: b.url })));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Falha ao consultar Trello.";
        reply.status(502).send({ errorMessage: msg });
      }
    }
  );

  // Lista colunas (lists) de um board
  app.get<{ Params: { id: string } }>(
    "/api/trello/boards/:id/lists",
    {
      schema: {
        tags: ["trello"],
        summary: "Lista colunas (lists) de um board",
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"]
        }
      }
    },
    async (request, reply) => {
      if (!(await isTrelloConfigured())) {
        reply.status(400).send({ errorMessage: "Trello nao configurado." });
        return;
      }
      try {
        const lists = await getBoardLists(request.params.id);
        reply.send(lists.map(l => ({ id: l.id, name: l.name })));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Falha ao consultar Trello.";
        reply.status(502).send({ errorMessage: msg });
      }
    }
  );
}
