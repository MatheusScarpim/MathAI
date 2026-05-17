/**
 * Queue inspection + control — plan #7.
 *
 *   GET    /api/queue           — snapshot (running + pending)
 *   DELETE /api/queue/:id       — cancela item PENDING (running nao cancelavel aqui)
 */

import type { FastifyInstance } from "fastify";
import { queueSnapshot, cancelQueueItem } from "../orchestrator/queue/taskQueue.js";

export default async function queueRoutes(app: FastifyInstance) {
  app.get(
    "/api/queue",
    {
      schema: {
        tags: ["queue"],
        summary: "Snapshot do queue de tasks (running + pending)."
      }
    },
    async (_request, reply) => {
      reply.send(queueSnapshot());
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/queue/:id",
    {
      schema: {
        tags: ["queue"],
        summary: "Cancela item pendente no queue. Items running nao sao afetados (use DELETE /api/task/:id).",
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"]
        }
      }
    },
    async (request, reply) => {
      const ok = cancelQueueItem(request.params.id);
      if (!ok) {
        reply.status(404).send({ errorMessage: "Item nao encontrado ou ja em execucao." });
        return;
      }
      reply.send({ ok: true });
    }
  );
}
