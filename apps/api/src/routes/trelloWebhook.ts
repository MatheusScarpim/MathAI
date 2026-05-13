import type { FastifyInstance } from "fastify";
import { getTasksCollection } from "../core/mongo.js";

type TrelloWebhookBody = {
  action?: {
    type?: string;
    data?: {
      card?: { id?: string; name?: string };
      listAfter?: { id?: string; name?: string };
      listBefore?: { id?: string; name?: string };
    };
  };
};

export default async function trelloWebhookRoutes(app: FastifyInstance) {
  // HEAD /api/webhooks/trello — Trello health check (required for webhook registration)
  app.head("/api/webhooks/trello", async (_request, reply) => {
    reply.status(200).send();
  });

  // POST /api/webhooks/trello — receive Trello webhook events
  app.post<{ Body: TrelloWebhookBody }>(
    "/api/webhooks/trello",
    {
      schema: {
        tags: ["webhooks"],
        summary: "Recebe eventos do Trello via webhook"
      }
    },
    async (request, reply) => {
      // Verificacao opcional de webhook secret via env var
      const webhookSecret = process.env.TRELLO_WEBHOOK_SECRET;
      if (webhookSecret) {
        const headerSecret = request.headers["x-webhook-secret"];
        if (headerSecret !== webhookSecret) {
          reply.status(401).send({ errorMessage: "Invalid webhook secret" });
          return;
        }
      }

      const { action } = request.body ?? {};

      if (!action?.type || !action.data?.card?.id) {
        reply.status(200).send({ ok: true });
        return;
      }

      const cardId = action.data.card.id;
      const col = await getTasksCollection();

      // Find task that references this card
      const task = await col.findOne({ trelloCardIds: cardId });
      if (!task) {
        reply.status(200).send({ ok: true });
        return;
      }

      // Handle card moved to another list
      if (action.type === "updateCard" && action.data.listAfter) {
        const listName = action.data.listAfter.name?.toLowerCase() ?? "";

        // Heuristic: if card moved to "done"/"concluido"/"feito" list, mark subtask as completed
        const doneKeywords = ["done", "concluido", "feito", "finalizado", "completed"];
        const isDone = doneKeywords.some(kw => listName.includes(kw));

        if (isDone) {
          const subtask = task.subtasks.find(st =>
            st.type === "trello" && st.result &&
            typeof st.result === "object" &&
            (st.result as Record<string, unknown>).trelloCardId === cardId
          );

          if (subtask) {
            subtask.status = "completed";
            subtask.completedAt = new Date();
            await col.updateOne(
              { _id: task._id },
              { $set: { subtasks: task.subtasks, updatedAt: new Date() } }
            );
          }
        }
      }

      reply.status(200).send({ ok: true });
    }
  );
}
