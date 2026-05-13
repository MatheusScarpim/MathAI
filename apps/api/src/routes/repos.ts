import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { isNonEmptyString } from "@auraia/shared";
import { getGithubReposCollection, type GithubRepoRecord } from "../core/mongo.js";
import { encryptToken } from "../core/repoCrypto.js";
import { parseGithubRef } from "../core/githubRef.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type CreateRepoBody = {
  url?: string;
  name?: string;
  owner?: string;
  repo?: string;
  baseBranch?: string;
  token?: string;
};

type UpdateRepoBody = Partial<CreateRepoBody>;

type RepoView = {
  id: string;
  name: string;
  owner: string;
  repo: string;
  baseBranch?: string;
  hasToken: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const toView = (doc: GithubRepoRecord): RepoView => ({
  id: doc._id!.toString(),
  name: doc.name,
  owner: doc.owner,
  repo: doc.repo,
  baseBranch: doc.baseBranch,
  hasToken: !!doc.encryptedToken,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt
});

/** Resolve owner+repo a partir de body (url, owner+repo, ou owner com URL). */
const resolveOwnerRepo = (body: { url?: string; owner?: string; repo?: string }): { owner: string; repo: string } | null => {
  // 1. Tenta url explicita
  if (body.url) {
    const parsed = parseGithubRef(body.url);
    if (parsed) return parsed;
  }
  // 2. Tenta repo (caso usuario tenha colado URL no campo repo)
  if (body.repo) {
    const parsed = parseGithubRef(body.repo);
    if (parsed) return parsed;
  }
  // 3. Tenta owner (caso usuario tenha colado URL no campo owner)
  if (body.owner && !body.repo) {
    const parsed = parseGithubRef(body.owner);
    if (parsed) return parsed;
  }
  // 4. Owner+repo separados
  if (body.owner && body.repo) return { owner: body.owner, repo: body.repo };
  return null;
};

// ── Routes ────────────────────────────────────────────────────────────────────

export default async function reposRoutes(app: FastifyInstance) {
  // GET /api/repos — lista (sem token)
  app.get(
    "/api/repos",
    {
      schema: {
        tags: ["repos"],
        summary: "Lista repositorios GitHub cadastrados (sem token)"
      }
    },
    async (request, reply) => {
      const userId = (request.user as { id?: string })?.id;
      const col = await getGithubReposCollection();
      const filter = userId ? { userId } : {};
      const repos = await col.find(filter).sort({ createdAt: -1 }).toArray();
      reply.send(repos.map(toView));
    }
  );

  // POST /api/repos — cria
  app.post<{ Body: CreateRepoBody }>(
    "/api/repos",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["repos"],
        summary: "Cadastra um repositorio GitHub com token criptografado",
        body: {
          type: "object",
          properties: {
            url: { type: "string" },
            name: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            baseBranch: { type: "string" },
            token: { type: "string" }
          },
          required: ["token"]
        }
      }
    },
    async (request, reply) => {
      const body = request.body;
      if (!isNonEmptyString(body.token)) {
        reply.status(400).send({ errorMessage: "Campo token obrigatorio." });
        return;
      }

      const ref = resolveOwnerRepo(body);
      if (!ref) {
        reply.status(400).send({ errorMessage: "Forneca url ou owner+repo validos." });
        return;
      }

      const userId = (request.user as { id?: string })?.id;
      const col = await getGithubReposCollection();

      // Evita duplicata por (userId, owner, repo)
      const existing = await col.findOne({ userId, owner: ref.owner, repo: ref.repo });
      if (existing) {
        reply.status(409).send({ errorMessage: "Repositorio ja cadastrado.", id: existing._id!.toString() });
        return;
      }

      const { encrypted, iv } = encryptToken(body.token);
      const now = new Date();
      const doc: GithubRepoRecord = {
        userId,
        name: body.name?.trim() || ref.repo,
        owner: ref.owner,
        repo: ref.repo,
        baseBranch: body.baseBranch?.trim() || undefined,
        encryptedToken: encrypted,
        iv,
        createdAt: now,
        updatedAt: now
      };
      const { insertedId } = await col.insertOne(doc);
      reply.status(201).send(toView({ ...doc, _id: insertedId }));
    }
  );

  // PATCH /api/repos/:id — atualiza
  app.patch<{ Params: { id: string }; Body: UpdateRepoBody }>(
    "/api/repos/:id",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["repos"],
        summary: "Atualiza repositorio cadastrado",
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          properties: {
            url: { type: "string" },
            name: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            baseBranch: { type: "string" },
            token: { type: "string" }
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
      const col = await getGithubReposCollection();
      const existing = await col.findOne({ _id: new ObjectId(id), ...(userId ? { userId } : {}) });
      if (!existing) {
        reply.status(404).send({ errorMessage: "Repositorio nao encontrado." });
        return;
      }

      const body = request.body;
      const update: Partial<GithubRepoRecord> = { updatedAt: new Date() };
      const unset: Record<string, ""> = {};

      // Resolve owner/repo se fornecidos
      const ref = (body.url || body.owner || body.repo) ? resolveOwnerRepo(body) : null;
      if (ref) {
        update.owner = ref.owner;
        update.repo = ref.repo;
      }
      if (body.name !== undefined) update.name = body.name.trim() || existing.repo;
      if (body.baseBranch !== undefined) {
        const trimmed = body.baseBranch.trim();
        if (trimmed) update.baseBranch = trimmed;
        else unset.baseBranch = "";
      }
      if (isNonEmptyString(body.token)) {
        const { encrypted, iv } = encryptToken(body.token);
        update.encryptedToken = encrypted;
        update.iv = iv;
      }

      const updateOps: Record<string, unknown> = { $set: update };
      if (Object.keys(unset).length > 0) updateOps.$unset = unset;
      await col.updateOne({ _id: new ObjectId(id) }, updateOps);
      const fresh = await col.findOne({ _id: new ObjectId(id) });
      reply.send(toView(fresh!));
    }
  );

  // DELETE /api/repos/:id
  app.delete<{ Params: { id: string } }>(
    "/api/repos/:id",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["repos"],
        summary: "Remove repositorio cadastrado",
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
      const col = await getGithubReposCollection();
      const result = await col.deleteOne({ _id: new ObjectId(id), ...(userId ? { userId } : {}) });
      if (result.deletedCount === 0) {
        reply.status(404).send({ errorMessage: "Repositorio nao encontrado." });
        return;
      }
      reply.send({ ok: true });
    }
  );
}
