import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import {
  startWhatsappBot,
  stopWhatsappBot,
  logoutWhatsappBot,
  createBindToken
} from "../services/whatsappBot.js";
import {
  onQr,
  onStatusChange,
  getStatus,
  isConnected
} from "../orchestrator/integrations/whatsapp.js";
import {
  getWhatsappAuthCredsCollection,
  getChatBindingsCollection
} from "../core/mongo.js";
import { getIntegrationsSettings } from "../helpers/settings.js";
import { snapshot as metricsSnapshot, computeHealth } from "../services/whatsappMetrics.js";

export default async function whatsappRoutes(app: FastifyInstance) {
  // GET /api/whatsapp/status
  app.get(
    "/api/whatsapp/status",
    { schema: { tags: ["whatsapp"], summary: "Status do bot WhatsApp" } },
    async (_req, reply) => {
      const settings = await getIntegrationsSettings();
      const credsCol = await getWhatsappAuthCredsCollection();
      const creds = await credsCol.findOne({ _id: "creds" });
      const pairingStatus = creds?.status ?? "unpaired";
      const connected = isConnected();
      const metrics = metricsSnapshot();
      reply.send({
        enabled: settings.whatsappEnabled,
        connection: getStatus(),
        connected,
        pairingStatus,
        phoneNumber: creds?.phoneNumber,
        pairedAt: creds?.pairedAt,
        lastConnectedAt: creds?.lastConnectedAt,
        rateLimitMs: settings.whatsappRateLimitMs,
        health: computeHealth(connected, pairingStatus),
        metrics
      });
    }
  );

  // GET /api/whatsapp/qr — SSE stream de QR strings + status events
  app.get(
    "/api/whatsapp/qr",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: { tags: ["whatsapp"], summary: "Stream SSE com QR codes pra pareamento" }
    },
    async (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });

      const send = (event: string, data: unknown): void => {
        try {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          /* client may have closed */
        }
      };

      const offQr = onQr((qr) => send("qr", { qr }));
      const offStatus = onStatusChange((status, info) => send("status", { status, ...info }));

      // Boot do bot caso ainda nao tenha sido iniciado (toggle on logo antes de pedir QR)
      try {
        await startWhatsappBot();
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      }

      // Heartbeat pra manter conexao viva
      const hb = setInterval(() => send("ping", { t: Date.now() }), 25_000);

      reply.raw.on("close", () => {
        offQr();
        offStatus();
        clearInterval(hb);
      });
    }
  );

  // POST /api/whatsapp/bind-token — gera token pra usuario enviar !start <token>
  app.post<{ Body: { defaultProjectId?: string } }>(
    "/api/whatsapp/bind-token",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["whatsapp"],
        summary: "Gera token de pareamento de chat",
        body: {
          type: "object",
          properties: { defaultProjectId: { type: "string" } }
        }
      }
    },
    async (request, reply) => {
      const userId = (request.user as { id?: string } | undefined)?.id;
      const projectId = request.body?.defaultProjectId;
      const validProject = projectId && ObjectId.isValid(projectId) ? projectId : undefined;
      const { token, expiresAt } = await createBindToken(userId, validProject);
      reply.send({ token, expiresAt, command: `!start ${token}` });
    }
  );

  // POST /api/whatsapp/logout
  app.post(
    "/api/whatsapp/logout",
    { schema: { tags: ["whatsapp"], summary: "Encerra sessao WhatsApp" } },
    async (_req, reply) => {
      try {
        await logoutWhatsappBot();
        reply.send({ ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reply.status(500).send({ errorMessage: msg });
      }
    }
  );

  // POST /api/whatsapp/stop — desconecta sem revogar (mantendo creds pra reconexao)
  app.post(
    "/api/whatsapp/stop",
    { schema: { tags: ["whatsapp"], summary: "Desconecta o bot sem revogar sessao" } },
    async (_req, reply) => {
      await stopWhatsappBot();
      reply.send({ ok: true });
    }
  );

  // GET /api/whatsapp/bindings — lista chats vinculados
  app.get(
    "/api/whatsapp/bindings",
    { schema: { tags: ["whatsapp"], summary: "Lista chats vinculados" } },
    async (request, reply) => {
      const userId = (request.user as { id?: string } | undefined)?.id;
      const col = await getChatBindingsCollection();
      const filter: Record<string, unknown> = { transport: "whatsapp", active: true };
      if (userId) filter.userId = userId;
      const docs = await col.find(filter).toArray();
      reply.send(
        docs.map(d => ({
          id: d._id?.toString(),
          chatId: d.chatId,
          displayName: d.displayName,
          defaultProjectId: d.defaultProjectId,
          createdAt: d.createdAt
        }))
      );
    }
  );

  // DELETE /api/whatsapp/bindings/:id
  app.delete<{ Params: { id: string } }>(
    "/api/whatsapp/bindings/:id",
    {
      schema: {
        tags: ["whatsapp"],
        summary: "Remove chat vinculado",
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
      }
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!ObjectId.isValid(id)) {
        reply.status(400).send({ errorMessage: "ID invalido." });
        return;
      }
      const userId = (request.user as { id?: string } | undefined)?.id;
      const col = await getChatBindingsCollection();
      const filter: Record<string, unknown> = { _id: new ObjectId(id) };
      if (userId) filter.userId = userId;
      const result = await col.deleteOne(filter);
      if (result.deletedCount === 0) {
        reply.status(404).send({ errorMessage: "Vinculo nao encontrado." });
        return;
      }
      reply.send({ ok: true });
    }
  );
}
