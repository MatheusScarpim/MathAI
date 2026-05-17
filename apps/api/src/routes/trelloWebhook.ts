import type { FastifyInstance } from "fastify";
import { getTasksCollection, getTrelloWebhookEventsCollection } from "../core/mongo.js";

type TrelloWebhookBody = {
  action?: {
    type?: string;
    memberCreator?: { username?: string; fullName?: string };
    data?: {
      card?: { id?: string; name?: string };
      listAfter?: { id?: string; name?: string };
      listBefore?: { id?: string; name?: string };
      text?: string; // commentCard
      label?: { id?: string; name?: string; color?: string }; // addLabelToCard
    };
  };
};

const CANCEL_KEYWORDS = ["cancel", "cancelled", "cancelado", "arquivado", "archived"];
const DONE_KEYWORDS = ["done", "concluido", "feito", "finalizado", "completed"];
const URGENT_LABEL_KEYWORDS = ["urgent", "urgente", "high-priority", "alta prioridade"];

const matchesKeyword = (name: string, kws: string[]): boolean => {
  const n = name.toLowerCase();
  return kws.some(kw => n.includes(kw));
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
      const eventsCol = await getTrelloWebhookEventsCollection();

      // Find task that references this card
      const task = await col.findOne({ trelloCardIds: cardId });

      let appliedAction = "noop";

      if (task) {
        // Handle card moved to another list
        if (action.type === "updateCard" && action.data.listAfter) {
          const listName = action.data.listAfter.name ?? "";

          // (#14) Cancelled list → cancela a task inteira
          if (matchesKeyword(listName, CANCEL_KEYWORDS) && task.status !== "completed" && task.status !== "cancelled") {
            await col.updateOne(
              { _id: task._id },
              {
                $set: {
                  status: "cancelled",
                  error: `trello_moved_to_${listName.toLowerCase()}`,
                  completedAt: new Date(),
                  updatedAt: new Date()
                }
              }
            );
            appliedAction = "cancelled";
          }
          // Done list → marca a subtask trello como completed (backward-compat)
          else if (matchesKeyword(listName, DONE_KEYWORDS)) {
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
              appliedAction = "subtask_done";
            }
          }
        }

        // (#14) commentCard → adiciona ao task.comments[]
        else if (action.type === "commentCard" && typeof action.data.text === "string" && action.data.text.length > 0) {
          const text = action.data.text.slice(0, 2000);
          const author = action.memberCreator?.fullName ?? action.memberCreator?.username;
          const updateDoc: Record<string, unknown> = {
            $push: {
              comments: {
                source: "trello",
                text,
                author,
                at: new Date()
              }
            },
            $set: { updatedAt: new Date() }
          };
          // Cast pra evitar friction com tipos estritos do mongo $push
          await col.updateOne({ _id: task._id }, updateDoc as Parameters<typeof col.updateOne>[1]);
          appliedAction = "comment_added";
        }

        // (#14) addLabelToCard "urgent" -> priority=high (alimenta queue #7)
        else if (action.type === "addLabelToCard" && action.data.label?.name) {
          if (matchesKeyword(action.data.label.name, URGENT_LABEL_KEYWORDS)) {
            await col.updateOne(
              { _id: task._id },
              { $set: { priority: "high", updatedAt: new Date() } }
            );
            appliedAction = "priority_set";
          }
        }
      }

      // Persist audit row (com TTL 30d) — independe de match com task
      try {
        await eventsCol.insertOne({
          actionType: action.type,
          cardId,
          taskId: task?._id?.toString(),
          raw: { type: action.type, data: action.data },
          appliedAction,
          receivedAt: new Date()
        });
      } catch (err) {
        console.warn("[trello-webhook] audit insert failed:", err);
      }

      reply.status(200).send({ ok: true, appliedAction });
    }
  );
}
