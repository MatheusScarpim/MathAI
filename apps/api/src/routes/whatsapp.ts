import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import {
  startWhatsappBot,
  stopWhatsappBot,
  logoutWhatsappBot,
  createBindToken,
  listGroupMembers
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
          isGroup: d.isGroup ?? false,
          groupSubject: d.groupSubject,
          admins: d.admins ?? [],
          commandPermissions: d.commandPermissions ?? {},
          createdAt: d.createdAt
        }))
      );
    }
  );

  // GET /api/whatsapp/bindings/:id — detalhe (projeto, admins, permissoes)
  app.get<{ Params: { id: string } }>(
    "/api/whatsapp/bindings/:id",
    {
      schema: {
        tags: ["whatsapp"],
        summary: "Detalhe de um chat vinculado",
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
      const d = await col.findOne(filter);
      if (!d) {
        reply.status(404).send({ errorMessage: "Vinculo nao encontrado." });
        return;
      }
      reply.send({
        id: d._id?.toString(),
        chatId: d.chatId,
        displayName: d.displayName,
        defaultProjectId: d.defaultProjectId,
        requirePlanApproval: d.requirePlanApproval,
        isGroup: d.isGroup ?? false,
        groupSubject: d.groupSubject,
        admins: d.admins ?? [],
        commandPermissions: d.commandPermissions ?? {},
        createdAt: d.createdAt
      });
    }
  );

  // GET /api/whatsapp/bindings/:id/members — lista membros do grupo (pra seletor UI)
  app.get<{ Params: { id: string } }>(
    "/api/whatsapp/bindings/:id/members",
    {
      schema: {
        tags: ["whatsapp"],
        summary: "Lista membros de um grupo vinculado (pra selecionar admins/permissoes)",
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
      const d = await col.findOne(filter);
      if (!d) {
        reply.status(404).send({ errorMessage: "Vinculo nao encontrado." });
        return;
      }
      if (!d.isGroup || !d.chatId) {
        reply.send({ members: [] });
        return;
      }
      try {
        const members = await listGroupMembers(d.chatId);
        reply.send({ members });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reply.status(502).send({ errorMessage: `Nao foi possivel obter membros: ${msg}` });
      }
    }
  );

  // PATCH /api/whatsapp/bindings/:id — atualiza projeto, admins e permissoes
  app.patch<{
    Params: { id: string };
    Body: {
      defaultProjectId?: string | null;
      admins?: string[];
      commandPermissions?: Record<string, string[]>;
    };
  }>(
    "/api/whatsapp/bindings/:id",
    {
      schema: {
        tags: ["whatsapp"],
        summary: "Atualiza projeto/admins/permissoes de um chat vinculado",
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          properties: {
            defaultProjectId: { type: ["string", "null"] },
            admins: { type: "array", items: { type: "string" } },
            commandPermissions: {
              type: "object",
              additionalProperties: { type: "array", items: { type: "string" } }
            }
          }
        }
      }
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!ObjectId.isValid(id)) {
        reply.status(400).send({ errorMessage: "ID invalido." });
        return;
      }
      const body = request.body ?? {};
      const set: Record<string, unknown> = {};
      const unset: Record<string, unknown> = {};

      if ("defaultProjectId" in body) {
        const pid = body.defaultProjectId;
        if (pid === null || pid === "") {
          unset.defaultProjectId = "";
        } else if (typeof pid === "string" && ObjectId.isValid(pid)) {
          set.defaultProjectId = pid;
        } else {
          reply.status(400).send({ errorMessage: "defaultProjectId invalido." });
          return;
        }
      }
      if (Array.isArray(body.admins)) {
        set.admins = body.admins.filter(j => typeof j === "string" && j.length > 0);
      }
      if (body.commandPermissions && typeof body.commandPermissions === "object") {
        const clean: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(body.commandPermissions)) {
          if (Array.isArray(v)) clean[k] = v.filter(j => typeof j === "string" && j.length > 0);
        }
        set.commandPermissions = clean;
      }

      if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
        reply.status(400).send({ errorMessage: "Nada para atualizar." });
        return;
      }

      const userId = (request.user as { id?: string } | undefined)?.id;
      const col = await getChatBindingsCollection();
      const filter: Record<string, unknown> = { _id: new ObjectId(id) };
      if (userId) filter.userId = userId;

      const update: Record<string, unknown> = {};
      if (Object.keys(set).length) update.$set = set;
      if (Object.keys(unset).length) update.$unset = unset;

      const result = await col.updateOne(filter, update);
      if (result.matchedCount === 0) {
        reply.status(404).send({ errorMessage: "Vinculo nao encontrado." });
        return;
      }
      reply.send({ ok: true });
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
