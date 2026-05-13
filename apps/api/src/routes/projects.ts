import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { isNonEmptyString } from "@auraia/shared";
import {
  getProjectsCollection,
  getTasksCollection,
  type ProjectRecord
} from "../core/mongo.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type CreateProjectBody = {
  name?: string;
  description?: string;
  repoIds?: string[];
  trelloBoardId?: string;
  trelloListId?: string;
  trelloDoneListId?: string;
  previewBuildCmd?: string;
  previewMocksDir?: string;
  previewDistDir?: string;
};

type UpdateProjectBody = Partial<CreateProjectBody>;

type ProjectView = {
  id: string;
  name: string;
  description?: string;
  repoIds: string[];
  trelloBoardId?: string;
  trelloListId?: string;
  trelloDoneListId?: string;
  previewBuildCmd?: string;
  previewMocksDir?: string;
  previewDistDir?: string;
  isInbox: boolean;
  taskCount?: number;
  openTaskCount?: number;
  createdAt: Date;
  updatedAt: Date;
};

const toView = (doc: ProjectRecord, counts?: { total: number; open: number }): ProjectView => ({
  id: doc._id!.toString(),
  name: doc.name,
  description: doc.description,
  repoIds: doc.repoIds ?? [],
  trelloBoardId: doc.trelloBoardId,
  trelloListId: doc.trelloListId,
  trelloDoneListId: doc.trelloDoneListId,
  previewBuildCmd: doc.previewBuildCmd,
  previewMocksDir: doc.previewMocksDir,
  previewDistDir: doc.previewDistDir,
  isInbox: !!doc.isInbox,
  taskCount: counts?.total,
  openTaskCount: counts?.open,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt
});

const sanitizeRepoIds = (repoIds?: string[]): string[] => {
  if (!Array.isArray(repoIds)) return [];
  return repoIds.filter(id => typeof id === "string" && ObjectId.isValid(id));
};

/** Garante que existe um projeto Inbox para o user e retorna o ID */
const ensureInboxId = async (userId?: string): Promise<string> => {
  const col = await getProjectsCollection();
  const filter = userId ? { isInbox: true, userId } : { isInbox: true };
  const existing = await col.findOne(filter);
  if (existing) return existing._id!.toString();
  const now = new Date();
  const { insertedId } = await col.insertOne({
    userId,
    name: "Inbox",
    description: "Tarefas sem projeto especifico",
    repoIds: [],
    isInbox: true,
    createdAt: now,
    updatedAt: now
  });
  return insertedId.toString();
};

// ── Routes ────────────────────────────────────────────────────────────────────

export default async function projectsRoutes(app: FastifyInstance) {
  // GET /api/projects — lista
  app.get(
    "/api/projects",
    {
      schema: { tags: ["projects"], summary: "Lista projetos do usuario" }
    },
    async (request, reply) => {
      const userId = (request.user as { id?: string })?.id;
      const projectsCol = await getProjectsCollection();
      const tasksCol = await getTasksCollection();

      // Garantir Inbox antes de listar
      await ensureInboxId(userId);

      const filter = userId ? { userId } : {};
      const projects = await projectsCol.find(filter).sort({ isInbox: -1, createdAt: 1 }).toArray();

      const result: ProjectView[] = [];
      for (const p of projects) {
        const projectIdStr = p._id!.toString();
        const baseFilter: Record<string, unknown> = { projectId: projectIdStr };
        if (userId) baseFilter.userId = userId;
        const total = await tasksCol.countDocuments(baseFilter);
        const open = await tasksCol.countDocuments({
          ...baseFilter,
          status: { $in: ["planning", "executing", "pending"] }
        });
        result.push(toView(p, { total, open }));
      }
      reply.send(result);
    }
  );

  // GET /api/projects/:id
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id",
    {
      schema: {
        tags: ["projects"],
        summary: "Detalhe de um projeto",
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
      }
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!ObjectId.isValid(id)) {
        reply.status(400).send({ errorMessage: "ID invalido." });
        return;
      }
      const userId = (request.user as { id?: string })?.id;
      const col = await getProjectsCollection();
      const doc = await col.findOne({ _id: new ObjectId(id), ...(userId ? { userId } : {}) });
      if (!doc) {
        reply.status(404).send({ errorMessage: "Projeto nao encontrado." });
        return;
      }
      reply.send(toView(doc));
    }
  );

  // POST /api/projects
  app.post<{ Body: CreateProjectBody }>(
    "/api/projects",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["projects"],
        summary: "Cria novo projeto",
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            repoIds: { type: "array", items: { type: "string" } },
            trelloBoardId: { type: "string" },
            trelloListId: { type: "string" },
            trelloDoneListId: { type: "string" },
            previewBuildCmd: { type: "string" },
            previewMocksDir: { type: "string" },
            previewDistDir: { type: "string" }
          },
          required: ["name"]
        }
      }
    },
    async (request, reply) => {
      const body = request.body;
      if (!isNonEmptyString(body.name)) {
        reply.status(400).send({ errorMessage: "Campo name obrigatorio." });
        return;
      }
      const userId = (request.user as { id?: string })?.id;
      const col = await getProjectsCollection();
      const now = new Date();
      const trelloBoardId = body.trelloBoardId?.trim();
      const trelloListId = body.trelloListId?.trim();
      const trelloDoneListId = body.trelloDoneListId?.trim();
      const previewBuildCmd = body.previewBuildCmd?.trim();
      const previewMocksDir = body.previewMocksDir?.trim();
      const previewDistDir = body.previewDistDir?.trim();
      const doc: ProjectRecord = {
        userId,
        name: body.name.trim(),
        description: body.description?.trim() || undefined,
        repoIds: sanitizeRepoIds(body.repoIds),
        trelloBoardId: trelloBoardId || undefined,
        trelloListId: trelloListId || undefined,
        trelloDoneListId: trelloDoneListId || undefined,
        previewBuildCmd: previewBuildCmd || undefined,
        previewMocksDir: previewMocksDir || undefined,
        previewDistDir: previewDistDir || undefined,
        createdAt: now,
        updatedAt: now
      };
      const { insertedId } = await col.insertOne(doc);
      reply.status(201).send(toView({ ...doc, _id: insertedId }));
    }
  );

  // PATCH /api/projects/:id
  app.patch<{ Params: { id: string }; Body: UpdateProjectBody }>(
    "/api/projects/:id",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["projects"],
        summary: "Atualiza projeto",
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            repoIds: { type: "array", items: { type: "string" } },
            trelloBoardId: { type: "string" },
            trelloListId: { type: "string" },
            trelloDoneListId: { type: "string" },
            previewBuildCmd: { type: "string" },
            previewMocksDir: { type: "string" },
            previewDistDir: { type: "string" }
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
      const userId = (request.user as { id?: string })?.id;
      const col = await getProjectsCollection();
      const existing = await col.findOne({ _id: new ObjectId(id), ...(userId ? { userId } : {}) });
      if (!existing) {
        reply.status(404).send({ errorMessage: "Projeto nao encontrado." });
        return;
      }
      const body = request.body;
      const update: Partial<ProjectRecord> = { updatedAt: new Date() };
      const unset: Record<string, ""> = {};

      if (body.name !== undefined) {
        if (!isNonEmptyString(body.name)) {
          reply.status(400).send({ errorMessage: "name nao pode ser vazio." });
          return;
        }
        update.name = body.name.trim();
      }
      if (body.description !== undefined) {
        const trimmed = body.description.trim();
        if (trimmed) update.description = trimmed;
        else unset.description = "";
      }
      if (body.repoIds !== undefined) {
        update.repoIds = sanitizeRepoIds(body.repoIds);
      }
      if (body.trelloBoardId !== undefined) {
        const trimmed = body.trelloBoardId.trim();
        if (trimmed) update.trelloBoardId = trimmed;
        else unset.trelloBoardId = "";
      }
      if (body.trelloListId !== undefined) {
        const trimmed = body.trelloListId.trim();
        if (trimmed) update.trelloListId = trimmed;
        else unset.trelloListId = "";
      }
      if (body.trelloDoneListId !== undefined) {
        const trimmed = body.trelloDoneListId.trim();
        if (trimmed) update.trelloDoneListId = trimmed;
        else unset.trelloDoneListId = "";
      }
      if (body.previewBuildCmd !== undefined) {
        const trimmed = body.previewBuildCmd.trim();
        if (trimmed) update.previewBuildCmd = trimmed;
        else unset.previewBuildCmd = "";
      }
      if (body.previewMocksDir !== undefined) {
        const trimmed = body.previewMocksDir.trim();
        if (trimmed) update.previewMocksDir = trimmed;
        else unset.previewMocksDir = "";
      }
      if (body.previewDistDir !== undefined) {
        const trimmed = body.previewDistDir.trim();
        if (trimmed) update.previewDistDir = trimmed;
        else unset.previewDistDir = "";
      }

      const updateOps: Record<string, unknown> = { $set: update };
      if (Object.keys(unset).length > 0) updateOps.$unset = unset;
      await col.updateOne({ _id: new ObjectId(id) }, updateOps);
      const fresh = await col.findOne({ _id: new ObjectId(id) });
      reply.send(toView(fresh!));
    }
  );

  // DELETE /api/projects/:id — bloqueia Inbox; migra tasks pra Inbox
  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["projects"],
        summary: "Remove projeto (tasks migram para Inbox)",
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
      }
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!ObjectId.isValid(id)) {
        reply.status(400).send({ errorMessage: "ID invalido." });
        return;
      }
      const userId = (request.user as { id?: string })?.id;
      const col = await getProjectsCollection();
      const tasksCol = await getTasksCollection();
      const existing = await col.findOne({ _id: new ObjectId(id), ...(userId ? { userId } : {}) });
      if (!existing) {
        reply.status(404).send({ errorMessage: "Projeto nao encontrado." });
        return;
      }
      if (existing.isInbox) {
        reply.status(400).send({ errorMessage: "Inbox nao pode ser removido." });
        return;
      }
      const inboxId = await ensureInboxId(userId);
      // Migra tasks deste projeto para o Inbox
      await tasksCol.updateMany(
        { projectId: id },
        { $set: { projectId: inboxId, updatedAt: new Date() } }
      );
      await col.deleteOne({ _id: new ObjectId(id) });
      reply.send({ ok: true, migratedTo: inboxId });
    }
  );

  // POST /api/projects/:id/setup-preview — dispara task que bootstrap MSW no projeto.
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/setup-preview",
    {
      config: { rateLimit: { max: 5, timeWindow: "5 minutes" } },
      schema: {
        tags: ["projects"],
        summary: "Dispara task pra configurar MSW + build:preview no projeto",
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
      }
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!ObjectId.isValid(id)) {
        reply.status(400).send({ errorMessage: "ID invalido." });
        return;
      }
      const userId = (request.user as { id?: string })?.id;
      const col = await getProjectsCollection();
      const project = await col.findOne({ _id: new ObjectId(id), ...(userId ? { userId } : {}) });
      if (!project) {
        reply.status(404).send({ errorMessage: "Projeto nao encontrado." });
        return;
      }
      // Permite re-execucao mesmo com config existente — usuario pode querer
      // refazer o scaffold (ex: setup anterior escapou do worktree).
      // Agent recebe contexto do que ja existe via prompt da subtask.

      // Resolve repos+trello a partir do projeto (igual fluxo do bot).
      const { resolveProjectOptions } = await import("../helpers/projectOptionsResolver.js");
      const opts = await resolveProjectOptions(id);
      if (!opts?.github || opts.github.length === 0) {
        reply.status(400).send({
          errorMessage: "Projeto sem repos GitHub configurados — adicione antes de configurar preview."
        });
        return;
      }

      // Caminho deterministico — escreve direto no worktree sem agent LLM.
      // (O agent OpenClaude escapava do worktree pra /openclaude/... e produzia
      // commits vazios; conteudo aqui e 100% literal, agente e overkill.)
      const { runSetupPreviewDirect } = await import("../helpers/setupPreviewDirect.js");
      try {
        const setup = await runSetupPreviewDirect(opts.github);
        const succeeded = setup.results.filter(r => r.status === "pr-opened" || r.status === "pr-updated");
        const failed = setup.results.filter(r => r.status === "error");
        reply.send({
          ok: failed.length === 0,
          message: succeeded.length > 0
            ? `Preview configurado em ${succeeded.length} repo(s). PR aberto pra merge.`
            : "Nada mudou — provavelmente ja estava configurado.",
          results: setup.results
        });
      } catch (err) {
        console.error("[setup-preview] direct setup failed:", err);
        reply.status(500).send({
          errorMessage: err instanceof Error ? err.message : "Falha desconhecida no setup-preview."
        });
      }
    }
  );
}
