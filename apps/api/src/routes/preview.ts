/**
 * Endpoints de Preview Deploy.
 *   POST   /api/tasks/:id/preview   — inicia preview (idempotente)
 *   DELETE /api/tasks/:id/preview   — encerra
 *   GET    /api/tasks/:id/preview   — status do preview ativo da task
 *   GET    /api/previews            — lista ativos
 */

import type { FastifyInstance } from "fastify";
import {
  startPreview,
  stopPreview,
  listActivePreviews,
  getActivePreview
} from "../services/previewManager.js";

export default async function previewRoutes(app: FastifyInstance) {
  // POST /api/tasks/:id/preview
  app.post<{ Params: { id: string }; Body?: { useMsw?: boolean } }>(
    "/api/tasks/:id/preview",
    {
      schema: {
        tags: ["preview"],
        summary: "Inicia preview deploy efemero pra task",
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          properties: {
            useMsw: {
              type: "boolean",
              description: "Override do MSW pra este preview. Omitido = usa default do projeto (ligado)."
            }
          }
        }
      }
    },
    async (request, reply) => {
      const { id } = request.params;
      const userId = (request.user as { id?: string } | undefined)?.id;
      const useMsw = request.body?.useMsw;
      const result = await startPreview(id, userId, useMsw === undefined ? undefined : { useMsw });
      if (!result.ok) {
        reply.status(400).send({ errorMessage: result.reason });
        return;
      }
      const p = result.preview;
      reply.send({
        taskId: p.taskId,
        tunnelUrl: p.tunnelUrl,
        status: p.status,
        startedAt: p.startedAt,
        expiresAt: p.expiresAt
      });
    }
  );

  // DELETE /api/tasks/:id/preview
  app.delete<{ Params: { id: string } }>(
    "/api/tasks/:id/preview",
    {
      schema: {
        tags: ["preview"],
        summary: "Encerra preview deploy da task",
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
      }
    },
    async (request, reply) => {
      const { id } = request.params;
      await stopPreview(id);
      reply.send({ ok: true });
    }
  );

  // GET /api/tasks/:id/preview
  app.get<{ Params: { id: string } }>(
    "/api/tasks/:id/preview",
    {
      schema: {
        tags: ["preview"],
        summary: "Estado do preview ativo da task",
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
      }
    },
    async (request, reply) => {
      const { id } = request.params;
      const p = await getActivePreview(id);
      if (!p) {
        reply.status(404).send({ errorMessage: "sem preview ativo" });
        return;
      }
      reply.send({
        taskId: p.taskId,
        tunnelUrl: p.tunnelUrl,
        status: p.status,
        startedAt: p.startedAt,
        expiresAt: p.expiresAt,
        errorMessage: p.errorMessage
      });
    }
  );

  // GET /api/previews
  app.get(
    "/api/previews",
    { schema: { tags: ["preview"], summary: "Lista previews ativos" } },
    async (request, reply) => {
      const userId = (request.user as { id?: string } | undefined)?.id;
      const list = await listActivePreviews(userId);
      reply.send(
        list.map(p => ({
          taskId: p.taskId,
          tunnelUrl: p.tunnelUrl,
          status: p.status,
          startedAt: p.startedAt,
          expiresAt: p.expiresAt
        }))
      );
    }
  );
}
