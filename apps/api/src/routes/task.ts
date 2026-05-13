import type { FastifyInstance } from "fastify";
import { isNonEmptyString } from "@auraia/shared";
import { ObjectId } from "mongodb";
import { executeTask, type TaskExecuteOptions, type GithubRepoConfig } from "../orchestrator/index.js";
import { getTasksCollection, getGithubReposCollection, getProjectsCollection } from "../core/mongo.js";
import { config } from "../core/config.js";
import { parseGithubRef } from "../core/githubRef.js";
import { decryptToken } from "../core/repoCrypto.js";
import { getIntegrationsSettings } from "../helpers/settings.js";
import { resolveProjectOptions } from "../helpers/projectOptionsResolver.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type GithubRepoBody = {
  repoId?: string;
  name?: string;
  owner?: string;
  repo?: string;
  token?: string;
  baseBranch?: string;
};

type TaskBody = {
  description?: string;
  language?: string;
  async?: boolean;
  projectId?: string;
  github?: GithubRepoBody | GithubRepoBody[];
  trello?: { boardId?: string; listId?: string; doneListId?: string };
};

const VALID_LANGUAGES = ["pt", "en", "es"] as const;
const LANGUAGE_ENUM = [...VALID_LANGUAGES];

/**
 * Resolve a configuracao Trello a ser usada na task.
 * Prioridade: body explicito → projeto da task → settings global (DB) → env defaults.
 * Retorna undefined se Trello nao foi ativado pelo frontend.
 */
const resolveTrelloOpts = async (
  body: TaskBody,
  projectIdResolved: string | undefined
): Promise<{ boardId: string; listId?: string; doneListId?: string } | undefined> => {
  // Trello desligado pelo composer (toggle off) — body.trello nao enviado
  if (body.trello === undefined) {
    return undefined;
  }

  // Carrega projeto + settings global em paralelo pra resolver done list mesmo
  // quando o body fornece boardId explicito.
  let project: { trelloBoardId?: string; trelloListId?: string; trelloDoneListId?: string } | null = null;
  if (projectIdResolved) {
    try {
      const col = await getProjectsCollection();
      project = await col.findOne({ _id: new ObjectId(projectIdResolved) });
    } catch {
      // Falha de leitura nao bloqueia
    }
  }
  const settings = await getIntegrationsSettings();

  // doneListId: body explicito > projeto > settings global
  const doneListId =
    body.trello.doneListId ||
    project?.trelloDoneListId ||
    settings.trelloDoneListId ||
    undefined;

  // 1) Body explicito (override de uma task especifica)
  if (body.trello.boardId) {
    return { boardId: body.trello.boardId, listId: body.trello.listId, doneListId };
  }

  // 2) Projeto
  if (project?.trelloBoardId) {
    return {
      boardId: project.trelloBoardId,
      listId: body.trello.listId || project.trelloListId,
      doneListId
    };
  }

  // 3) Settings (DB) + env fallback
  const boardId = settings.trelloBoardId || config.trello.defaultBoardId;
  if (boardId) {
    return {
      boardId,
      listId: body.trello.listId || settings.trelloListId || undefined,
      doneListId
    };
  }

  return undefined;
};

/**
 * Normaliza github body (single, array, com repoId ou inline) para array de GithubRepoConfig.
 * Resolve repoIds buscando no Mongo e decriptando token.
 */
const buildGithubConfig = async (
  github?: GithubRepoBody | GithubRepoBody[]
): Promise<GithubRepoConfig[] | undefined> => {
  const items = Array.isArray(github) ? github : github ? [github] : [];
  const resolved: GithubRepoConfig[] = [];

  // Coleta repoIds em batch
  const repoIds = items.map(g => g.repoId).filter((x): x is string => !!x && ObjectId.isValid(x));
  const repoMap = new Map<string, { owner: string; repo: string; name: string; baseBranch?: string; token: string }>();
  if (repoIds.length > 0) {
    const col = await getGithubReposCollection();
    const docs = await col.find({ _id: { $in: repoIds.map(id => new ObjectId(id)) } }).toArray();
    for (const doc of docs) {
      try {
        repoMap.set(doc._id!.toString(), {
          owner: doc.owner,
          repo: doc.repo,
          name: doc.name,
          baseBranch: doc.baseBranch,
          token: decryptToken(doc.encryptedToken, doc.iv)
        });
      } catch {
        // se decrypt falhar, ignora
      }
    }
  }

  for (const g of items) {
    // 1. Se tem repoId valido, usa o cadastrado (overrides do body sobrescrevem)
    if (g.repoId) {
      const stored = repoMap.get(g.repoId);
      if (stored) {
        resolved.push({
          name: g.name || stored.name,
          owner: stored.owner,
          repo: stored.repo,
          token: g.token || stored.token,
          baseBranch: g.baseBranch || stored.baseBranch
        });
        continue;
      }
      // repoId invalido/nao encontrado e sem fallback inline → pula
      if (!g.owner && !g.repo) continue;
    }

    // 2. Inline: aceita URL/owner/repo no campo owner ou repo
    const parsedFromRepo = g.repo ? parseGithubRef(g.repo) : null;
    const parsedFromOwner = !parsedFromRepo && g.owner ? parseGithubRef(g.owner) : null;
    const parsed = parsedFromRepo ?? parsedFromOwner;
    const owner = parsed?.owner ?? g.owner;
    const repo = parsed?.repo ?? g.repo;
    if (!owner || !repo) continue;

    resolved.push({
      name: g.name || repo,
      owner,
      repo,
      token: g.token ?? config.github.token,
      baseBranch: g.baseBranch
    });
  }

  if (resolved.length > 0) return resolved;

  // Fallback para config default do .env
  if (config.github.defaultOwner && config.github.defaultRepo) {
    return [{
      name: config.github.defaultRepo,
      owner: config.github.defaultOwner,
      repo: config.github.defaultRepo,
      token: config.github.token
    }];
  }

  return undefined;
};

/**
 * Mescla defaults do projeto (repos GitHub + Trello) com o que veio explicito no body.
 * Body explicito sempre vence — projeto e fallback automatico.
 *
 * Regras:
 *   - body.github definido (mesmo array vazio []) → usa SO body.github (override total)
 *   - body.github undefined + projeto com repos → usa repos do projeto
 *   - body.github undefined + sem projeto → buildGithubConfig(undefined) (env fallback)
 *
 *   - body.trello === undefined + projeto com Trello → ativa com config do projeto
 *   - body.trello definido → cascade existente (resolveTrelloOpts)
 */
const mergeProjectDefaults = async (
  body: TaskBody,
  projectIdResolved: string | undefined
): Promise<{
  github?: GithubRepoConfig[];
  trello?: { boardId: string; listId?: string; doneListId?: string };
  previewMocksDir?: string;
}> => {
  const projectDefaults = projectIdResolved
    ? await resolveProjectOptions(projectIdResolved)
    : null;

  // ── GitHub ──
  let github: GithubRepoConfig[] | undefined;
  if (body.github !== undefined) {
    // override explicito
    github = await buildGithubConfig(body.github);
  } else if (projectDefaults?.github && projectDefaults.github.length > 0) {
    github = projectDefaults.github;
  } else {
    github = await buildGithubConfig(undefined); // env fallback
  }

  // ── Trello ──
  let trello: { boardId: string; listId?: string; doneListId?: string } | undefined;
  if (body.trello !== undefined) {
    // body presente (toggle ON ou override) — usa cascade tradicional
    trello = await resolveTrelloOpts(body, projectIdResolved);
  } else if (projectDefaults?.trello?.boardId) {
    // body ausente, projeto tem Trello → ativa automaticamente
    trello = projectDefaults.trello;
  }

  // ── Preview MSW dir ──
  const previewMocksDir = projectDefaults?.project.previewMocksDir;

  return { github, trello, previewMocksDir };
};

// ── Routes ────────────────────────────────────────────────────────────────────

export default async function taskRoutes(app: FastifyInstance) {
  // POST /api/task — create and execute a task
  app.post<{ Body: TaskBody }>(
    "/api/task",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["task"],
        summary: "Cria e executa uma tarefa via Task Orchestrator",
        body: {
          type: "object",
          properties: {
            description: { type: "string" },
            language: { type: "string", enum: LANGUAGE_ENUM },
            async: { type: "boolean" },
            projectId: { type: "string" },
            github: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    repoId: { type: "string" },
                    name: { type: "string" },
                    owner: { type: "string" },
                    repo: { type: "string" },
                    token: { type: "string" },
                    baseBranch: { type: "string" }
                  }
                },
                {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      repoId: { type: "string" },
                      name: { type: "string" },
                      owner: { type: "string" },
                      repo: { type: "string" },
                      token: { type: "string" },
                      baseBranch: { type: "string" }
                    }
                  }
                }
              ]
            },
            trello: {
              type: "object",
              properties: {
                boardId: { type: "string" },
                listId: { type: "string" },
                doneListId: { type: "string" }
              }
            }
          },
          required: ["description"]
        }
      }
    },
    async (request, reply) => {
      const body = request.body;

      if (!isNonEmptyString(body?.description)) {
        reply.status(400).send({ errorMessage: "Campo description obrigatorio." });
        return;
      }

      const language = (VALID_LANGUAGES as readonly string[]).includes(body.language ?? "")
        ? (body.language as "pt" | "en" | "es")
        : "pt";

      const projectIdResolved = body.projectId && ObjectId.isValid(body.projectId) ? body.projectId : undefined;
      const merged = await mergeProjectDefaults(body, projectIdResolved);
      const options: TaskExecuteOptions = {
        userId: (request.user as { id?: string })?.id,
        projectId: projectIdResolved,
        language,
        github: merged.github,
        trello: merged.trello,
        previewMocksDir: merged.previewMocksDir
      };

      if (body.async) {
        // Fire and forget
        void executeTask(body.description, options);
        reply.status(202).send({ status: "processing", description: body.description });
        return;
      }

      const result = await executeTask(body.description, options);

      if (!result.ok) {
        reply.status(400).send({ errorMessage: result.summary ?? "Task failed" });
        return;
      }

      reply.send(result);
    }
  );

  // POST /api/task/stream — execute task with SSE
  app.post<{ Body: TaskBody }>(
    "/api/task/stream",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["task"],
        summary: "Executa tarefa com streaming SSE de progresso",
        body: {
          type: "object",
          properties: {
            description: { type: "string" },
            language: { type: "string", enum: LANGUAGE_ENUM },
            projectId: { type: "string" },
            github: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    repoId: { type: "string" },
                    name: { type: "string" },
                    owner: { type: "string" },
                    repo: { type: "string" },
                    token: { type: "string" },
                    baseBranch: { type: "string" }
                  }
                },
                {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      repoId: { type: "string" },
                      name: { type: "string" },
                      owner: { type: "string" },
                      repo: { type: "string" },
                      token: { type: "string" },
                      baseBranch: { type: "string" }
                    }
                  }
                }
              ]
            },
            trello: {
              type: "object",
              properties: {
                boardId: { type: "string" },
                listId: { type: "string" },
                doneListId: { type: "string" }
              }
            }
          },
          required: ["description"]
        }
      }
    },
    async (request, reply) => {
      const body = request.body;

      if (!isNonEmptyString(body?.description)) {
        reply.status(400).send({ errorMessage: "Campo description obrigatorio." });
        return;
      }

      const language = (VALID_LANGUAGES as readonly string[]).includes(body.language ?? "")
        ? (body.language as "pt" | "en" | "es")
        : "pt";

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });

      const emit = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const projectIdResolved = body.projectId && ObjectId.isValid(body.projectId) ? body.projectId : undefined;
      const merged = await mergeProjectDefaults(body, projectIdResolved);
      const options: TaskExecuteOptions = {
        userId: (request.user as { id?: string })?.id,
        projectId: projectIdResolved,
        language,
        emit,
        github: merged.github,
        trello: merged.trello,
        previewMocksDir: merged.previewMocksDir
      };

      try {
        const result = await executeTask(body.description, options);
        emit("result", result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit("error", { errorMessage: msg });
      } finally {
        reply.raw.end();
      }
    }
  );

  // GET /api/task/:id — get task status
  app.get<{ Params: { id: string } }>(
    "/api/task/:id",
    {
      schema: {
        tags: ["task"],
        summary: "Consulta status de uma tarefa",
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"]
        }
      }
    },
    async (request, reply) => {
      const { id } = request.params;

      if (!ObjectId.isValid(id)) {
        reply.status(400).send({ errorMessage: "ID invalido." });
        return;
      }

      const col = await getTasksCollection();
      const task = await col.findOne({ _id: new ObjectId(id) });

      if (!task) {
        reply.status(404).send({ errorMessage: "Tarefa nao encontrada." });
        return;
      }

      reply.send({
        id: task._id!.toString(),
        description: task.description,
        status: task.status,
        currentStage: task.currentStage,
        projectId: task.projectId,
        subtasks: task.subtasks,
        trelloCardIds: task.trelloCardIds,
        githubPrUrls: task.githubPrUrls,
        summary: task.summary,
        language: task.language,
        tokenUsage: task.tokenUsage,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt
      });
    }
  );

  // GET /api/tasks — list tasks
  app.get<{ Querystring: { status?: string; limit?: string; projectId?: string } }>(
    "/api/tasks",
    {
      schema: {
        tags: ["task"],
        summary: "Lista tarefas",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string" },
            limit: { type: "string" },
            projectId: { type: "string" }
          }
        }
      }
    },
    async (request, reply) => {
      const { status, limit, projectId } = request.query;
      const col = await getTasksCollection();

      const filter: Record<string, unknown> = {};
      if (status) filter.status = status;
      if (projectId && ObjectId.isValid(projectId)) filter.projectId = projectId;

      const tasks = await col
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(Number(limit) || 50)
        .toArray();

      reply.send(
        tasks.map(t => ({
          id: t._id!.toString(),
          description: t.description,
          status: t.status,
          currentStage: t.currentStage,
          projectId: t.projectId,
          subtaskCount: t.subtasks.length,
          trelloCardIds: t.trelloCardIds,
          githubPrUrls: t.githubPrUrls,
          language: t.language,
          createdAt: t.createdAt,
          completedAt: t.completedAt
        }))
      );
    }
  );

  // DELETE /api/task/:id — cancel a task
  app.delete<{ Params: { id: string } }>(
    "/api/task/:id",
    {
      schema: {
        tags: ["task"],
        summary: "Cancela uma tarefa",
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"]
        }
      }
    },
    async (request, reply) => {
      const { id } = request.params;

      if (!ObjectId.isValid(id)) {
        reply.status(400).send({ errorMessage: "ID invalido." });
        return;
      }

      const col = await getTasksCollection();
      const result = await col.updateOne(
        { _id: new ObjectId(id), status: { $nin: ["completed", "cancelled"] } },
        { $set: { status: "cancelled", updatedAt: new Date() } }
      );

      if (result.matchedCount === 0) {
        reply.status(404).send({ errorMessage: "Tarefa nao encontrada ou ja finalizada." });
        return;
      }

      reply.send({ ok: true });
    }
  );

  // POST /api/tasks/:id/subtasks/:subId/retry
  // Re-executa uma subtask falha. Worktree recriado, contexto das outras
  // subtasks injetado no prompt, push atualiza o PR existente.
  app.post<{ Params: { id: string; subId: string } }>(
    "/api/tasks/:id/subtasks/:subId/retry",
    {
      config: { rateLimit: { max: 5, timeWindow: "5 minutes" } },
      schema: {
        tags: ["task"],
        summary: "Retry de subtask falha (re-executa, push atualiza PR)",
        params: {
          type: "object",
          properties: { id: { type: "string" }, subId: { type: "string" } },
          required: ["id", "subId"]
        }
      }
    },
    async (request, reply) => {
      const { id, subId } = request.params;
      const { retrySubtask } = await import("../services/subtaskRetry.js");
      // Fire-and-forget — retry pode demorar minutos. Cliente faz polling.
      void retrySubtask(id, subId).then(r => {
        if (!r.ok) console.warn(`[retry] task=${id.slice(-8)} sub=${subId} failed: ${r.reason}`);
      }).catch(err => {
        console.error("[retry] unexpected error:", err);
      });
      reply.status(202).send({ ok: true, message: "Retry disparado" });
    }
  );
}
