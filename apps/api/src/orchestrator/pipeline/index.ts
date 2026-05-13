import { ObjectId } from "mongodb";
import {
  getTasksCollection,
  getTaskExecutionsCollection,
  type TaskRecord
} from "../../core/mongo.js";
import { config } from "../../core/config.js";

// Agents
import { planTask, type PlannedSubTask } from "../agents/planner.js";
import { generateCodeChanges } from "../agents/code.js";
import { reviewCodeChanges } from "../agents/reviewer.js";
import { generateReport, type ExecutedSubtask } from "../agents/reporter.js";

// Integrations
import {
  ensureBaseRepo,
  createWorktree,
  removeWorktree,
  getRepoTree,
  branchHasCommits,
  pushBranch,
  createOrGetPullRequest,
  type WorkspaceInfo
} from "../integrations/github.js";
import {
  createCard,
  getBoardLists,
  buildCardMarker,
  findCardByMarker,
  ensureTaskCard,
  moveCard,
  updateCard
} from "../integrations/trello.js";
import { execShell } from "../integrations/shell.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// PR body builder
import { buildPrBody, derivePrTitle, type ChangeRow } from "./prBody.js";
import { buildTrelloCompletionDesc } from "./trelloDesc.js";
import { notifyTaskStart, notifyTaskDone, notifyStageChange } from "../../services/whatsappNotifier.js";

// Types
import {
  type StepEmitter,
  type TaskStatus,
  type TaskStage,
  type SubTask,
  type TokenUsage,
  type TaskExecuteOptions,
  type TaskResult,
  type GithubRepoConfig,
  type SubTaskType,
  ZERO_USAGE,
  toTokenUsage,
  addTokenUsage
} from "../types.js";

/** Max retries padrao para subtarefas */
const DEFAULT_MAX_RETRIES = 1;

/** Worktree compartilhado por todas as github subtasks de uma (task, repo). */
type TaskWorktree = {
  ws: WorkspaceInfo;
  repoConfig: GithubRepoConfig;
};

/** Branch name unica por task (1 PR por task por repo). */
const resolveTaskBranch = (taskId: string): string => `mathai/task-${taskId}`;

/** Verifica no MongoDB se a tarefa foi cancelada */
const checkCancelled = async (taskId: ObjectId): Promise<boolean> => {
  try {
    const col = await getTasksCollection();
    const task = await col.findOne({ _id: taskId }, { projection: { status: 1 } });
    return task?.status === "cancelled";
  } catch {
    return false;
  }
};

/** Normaliza github config para sempre ser array */
const normalizeRepos = (github?: GithubRepoConfig | GithubRepoConfig[]): GithubRepoConfig[] => {
  if (!github) return [];
  if (Array.isArray(github)) return github;
  return [{ ...github, name: github.name || github.repo }];
};

/** Resolve qual repo usar para uma subtarefa github */
const resolveRepo = (repos: GithubRepoConfig[], subtaskRepo?: string): GithubRepoConfig => {
  if (repos.length === 0) throw new Error("Nenhum repositorio GitHub configurado");
  if (repos.length === 1) return repos[0]!;
  if (subtaskRepo) {
    const match = repos.find(r =>
      r.name === subtaskRepo || r.repo === subtaskRepo || `${r.owner}/${r.repo}` === subtaskRepo
    );
    if (match) return match;
  }
  return repos[0]!;
};


// ============== MAIN ORCHESTRATOR ==============

export const executeTask = async (
  description: string,
  options: TaskExecuteOptions = {}
): Promise<TaskResult> => {
  const language = options.language ?? "pt";
  const emit = options.emit;
  const tasksCol = await getTasksCollection();
  const execCol = await getTaskExecutionsCollection();

  const totalUsage = { planner: ZERO_USAGE, code: ZERO_USAGE, reviewer: ZERO_USAGE, reporter: ZERO_USAGE };

  // 1. Create task record
  const taskDoc: TaskRecord = {
    userId: options.userId,
    projectId: options.projectId,
    description,
    status: "planning",
    currentStage: "planning",
    subtasks: [],
    trelloCardIds: [],
    githubPrUrls: [],
    language,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const { insertedId: taskId } = await tasksCol.insertOne(taskDoc);

  emit?.("step", { step: "task_created", taskId: taskId.toString() });

  // Notifica WhatsApp de inicio. Espera a key da msg pra reagir nela
  // em stage transitions. Falha aqui nao quebra a task (try/catch).
  const whatsappJid = options.whatsapp?.jid;
  if (whatsappJid) {
    try {
      const startKey = await notifyTaskStart(whatsappJid, description);
      if (startKey) {
        await tasksCol.updateOne(
          { _id: taskId },
          { $set: { whatsappStartMsgKey: startKey, updatedAt: new Date() } }
        );
      }
    } catch (err) {
      console.warn("[pipeline] notifyTaskStart/save key failed:", err);
    }
  }

  // Helper: persiste stage atual + emite SSE + reage na msg WhatsApp.
  const setStage = async (stage: TaskStage): Promise<void> => {
    await tasksCol.updateOne(
      { _id: taskId },
      { $set: { currentStage: stage, updatedAt: new Date() } }
    );
    emit?.("step", { step: "stage", stage });
    if (whatsappJid) {
      void notifyStageChange(whatsappJid, taskId.toString(), stage);
    }
  };

  // Reage com 🧠 na msg de start — o task ja foi criado com currentStage:"planning",
  // mas precisamos do setStage pra disparar a reacao WhatsApp.
  if (whatsappJid) {
    void notifyStageChange(whatsappJid, taskId.toString(), "planning");
  }

  // Worktrees compartilhados: 1 por (task, repo). Declarado fora do try
  // pra que o finally consiga limpar mesmo em caso de erro precoce.
  const taskWorktrees = new Map<string, TaskWorktree>();
  const branchByRepo: Record<string, string> = {};

  // Cria card representando a task no Trello (idempotente via marker).
  // Toggle "Trello" no composer = options.trello.boardId resolvido em routes/task.ts.
  // Falha aqui nao quebra a task — apenas emite warning.
  const trelloCardIds: string[] = [];
  if (options.trello?.boardId) {
    try {
      const card = await ensureTaskCard({
        boardId: options.trello.boardId,
        listId: options.trello.listId,
        taskId: taskId.toString(),
        name: description.split(/\r?\n/)[0]?.slice(0, 100) || description.slice(0, 100),
        desc: description
      });
      trelloCardIds.push(card.id);
      await tasksCol.updateOne(
        { _id: taskId },
        { $set: { trelloCardIds, updatedAt: new Date() } }
      );
      emit?.("step", { step: "trello_card_ready", cardUrl: card.url });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[pipeline] Trello card creation failed: ${msg}`);
      emit?.("step", { step: "trello_card_error", error: msg });
    }
  }

  try {
    const repos = normalizeRepos(options.github);
    const hasTrello = !!(options.trello?.boardId || config.trello.defaultBoardId);

    // 2. Plan task — pula se presetSubtasks foi fornecido (gate de aprovacao do bot)
    let filteredSubtasks: PlannedSubTask[];

    if (options.presetSubtasks && options.presetSubtasks.length > 0) {
      // Plano ja aprovado pelo user — usa direto sem chamar LLM
      filteredSubtasks = options.presetSubtasks;
      emit?.("step", { step: "planning", description, source: "preset" });
      emit?.("step", { step: "planned", subtaskCount: filteredSubtasks.length, source: "preset" });
    } else {
      emit?.("step", { step: "planning", description });

      const plannerContext: Parameters<typeof planTask>[1] = {};
      const availableTypes: SubTaskType[] = ["api", "custom"];

      // Get repo trees for all configured repos
      if (repos.length > 0) {
        availableTypes.push("github");
        const repoContexts: { name: string; owner: string; repo: string; tree?: string }[] = [];
        for (const r of repos) {
          const basePath = await ensureBaseRepo(r.owner, r.repo, r.token);
          const tree = await getRepoTree(basePath);
          repoContexts.push({ name: r.name || r.repo, owner: r.owner, repo: r.repo, tree });
        }
        plannerContext.repos = repoContexts;
      }

      // Get Trello board lists if trello config is provided
      if (hasTrello) {
        availableTypes.push("trello");
        const boardId = options.trello?.boardId || config.trello.defaultBoardId;
        const lists = await getBoardLists(boardId!);
        plannerContext.trelloBoardLists = lists.map(l => ({ id: l.id, name: l.name }));
      }

      // Inform planner which integration types are available
      plannerContext.availableTypes = availableTypes;

      const planStart = Date.now();
      const planResult = await planTask(description, plannerContext, language);
      const planElapsed = Date.now() - planStart;
      totalUsage.planner = toTokenUsage(planResult.usage);

      await execCol.insertOne({
        taskId,
        subtaskId: "_plan",
        agent: "taskPlanner",
        input: { description },
        output: planResult.subtasks,
        success: true,
        tokenUsage: totalUsage.planner,
        elapsedMs: planElapsed,
        createdAt: new Date()
      });

      // Filter out subtasks for integrations that are not configured
      filteredSubtasks = planResult.subtasks.filter(st => {
        if (st.type === "trello" && !hasTrello) return false;
        if (st.type === "github" && repos.length === 0) return false;
        return true;
      });
    }

    if (filteredSubtasks.length === 0) {
      throw new Error(
        `Nenhuma subtask viavel apos aplicar filtros. Verifique as integracoes: ${!hasTrello ? "Trello nao configurado. " : ""}${repos.length === 0 ? "GitHub nao configurado." : ""}`
      );
    }

    // Convert planned subtasks to task subtasks
    const subtasks: SubTask[] = filteredSubtasks.map(st => ({
      id: st.id,
      type: st.type,
      description: st.description,
      status: "pending" as TaskStatus,
      priority: st.priority,
      dependsOn: st.dependsOn,
      repo: st.repo,
      maxRetries: DEFAULT_MAX_RETRIES,
      retryCount: 0
    }));

    await tasksCol.updateOne(
      { _id: taskId },
      { $set: { status: "executing", subtasks, updatedAt: new Date() } }
    );

    emit?.("step", { step: "planned", subtaskCount: subtasks.length });
    await setStage("coding");

    // 3. Execute subtasks in dependency order
    const executedSubtasks: ExecutedSubtask[] = [];
    const completedIds = new Set<string>();
    const githubPrUrls: string[] = [];
    // trelloCardIds ja foi declarado acima (escopo externo) e populado com o card da task

    const getExecutable = (): SubTask[] =>
      subtasks.filter(
        st => st.status === "pending" && st.dependsOn.every(dep => completedIds.has(dep))
      );

    let executable = getExecutable();
    while (executable.length > 0) {
      // Check if task was cancelled
      if (await checkCancelled(taskId)) {
        emit?.("step", { step: "cancelled" });
        throw new Error("Tarefa cancelada pelo usuario");
      }

      for (const subtask of executable) {
        emit?.("step", { step: "executing_subtask", subtaskId: subtask.id, type: subtask.type, description: subtask.description });

        subtask.status = "executing" as TaskStatus;
        subtask.startedAt = new Date();

        const stStart = Date.now();
        try {
          const result = await executeSubtask(subtask, options, taskId.toString(), taskWorktrees);
          subtask.status = "completed";
          subtask.completedAt = new Date();
          subtask.result = result;
          completedIds.add(subtask.id);

          // Collect integration IDs (prUrl agora e preenchido na fase de consolidacao)
          if (result && typeof result === "object") {
            const r = result as Record<string, unknown>;
            if (r.trelloCardId) trelloCardIds.push(r.trelloCardId as string);
          }

          // Track code token usage
          if (result && typeof result === "object") {
            const r = result as Record<string, unknown>;
            if (r.codeUsage) totalUsage.code = addTokenUsage(totalUsage.code, r.codeUsage as TokenUsage);
          }

          // Review: after github subtask, run independent code review
          if (subtask.type === "github" && result && typeof result === "object") {
            const r = result as { changes?: import("../agents/code.js").CodeChange[] };
            const changes = r.changes ?? [];
            try {
              await setStage("reviewing");
              const reviewResult = await reviewCodeChanges(
                subtask.description,
                changes,
                [], // originalFiles nao disponivel apos modificacao
                language
              );
              if (reviewResult.usage) {
                totalUsage.reviewer = addTokenUsage(totalUsage.reviewer, toTokenUsage(reviewResult.usage));
              }
              if (!reviewResult.approved && reviewResult.comments.length > 0) {
                const warnings = reviewResult.comments
                  .filter(c => c.severity === "error" || c.severity === "warning")
                  .map(c => `[${c.severity}] ${c.file}: ${c.message}`);
                if (warnings.length > 0) {
                  emit?.("step", { step: "review_warnings", subtaskId: subtask.id, warnings });
                }
              }
            } catch (reviewErr) {
              // Não falha a subtask se o review falhar — apenas log
              const reviewMsg = reviewErr instanceof Error ? reviewErr.message : String(reviewErr);
              emit?.("step", { step: "review_error", subtaskId: subtask.id, error: reviewMsg });
            }
          }

          executedSubtasks.push({
            id: subtask.id,
            type: subtask.type,
            description: subtask.description,
            status: "completed",
            result
          });

          emit?.("step", { step: "subtask_completed", subtaskId: subtask.id });

        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          subtask.retryCount = (subtask.retryCount ?? 0) + 1;

          if (subtask.retryCount < (subtask.maxRetries ?? DEFAULT_MAX_RETRIES)) {
            // Retry — volta pra pending e tenta de novo no proximo ciclo
            subtask.status = "pending" as TaskStatus;
            subtask.startedAt = undefined;
            subtask.error = errorMsg;
            emit?.("step", { step: "subtask_retry", subtaskId: subtask.id, retryCount: subtask.retryCount, error: errorMsg });
          } else {
            // Max retries atingido — falha permanente
            subtask.status = "failed";
            subtask.completedAt = new Date();
            subtask.error = errorMsg;
            completedIds.add(subtask.id); // unblock dependents

            executedSubtasks.push({
              id: subtask.id,
              type: subtask.type,
              description: subtask.description,
              status: "failed",
              error: errorMsg
            });

            emit?.("step", { step: "subtask_failed", subtaskId: subtask.id, error: errorMsg });
          }
        }

        await execCol.insertOne({
          taskId,
          subtaskId: subtask.id,
          agent: subtask.type,
          input: { description: subtask.description },
          output: subtask.result ?? null,
          success: subtask.status === "completed",
          error: subtask.error,
          elapsedMs: Date.now() - stStart,
          createdAt: new Date()
        });
      }

      // Update task in DB
      await tasksCol.updateOne(
        { _id: taskId },
        { $set: { subtasks, trelloCardIds, githubPrUrls, updatedAt: new Date() } }
      );

      executable = getExecutable();
    }

    // 4. Generate report (LLM ou fallback deterministico — nunca throw)
    await setStage("reporting");
    emit?.("step", { step: "generating_report" });
    const reportStart = Date.now();
    const reportResult = await generateReport(description, executedSubtasks, language);
    totalUsage.reporter = toTokenUsage(reportResult.usage);

    await execCol.insertOne({
      taskId,
      subtaskId: "_report",
      agent: "reporter",
      input: { executedSubtasks },
      output: reportResult.report,
      success: true,
      tokenUsage: totalUsage.reporter,
      elapsedMs: Date.now() - reportStart,
      createdAt: new Date()
    });

    // 5. Consolidar PRs: push branch + abrir 1 PR por (task, repo)
    for (const [repoKey, entry] of taskWorktrees) {
      const branch = entry.ws.branchName;
      branchByRepo[repoKey] = branch;
      const base = entry.ws.baseBranch || entry.repoConfig.baseBranch || "main";
      const token = entry.repoConfig.token;
      if (!token) {
        emit?.("step", { step: "pr_skipped", repoKey, reason: "no token" });
        continue;
      }

      try {
        const hasCommits = await branchHasCommits(entry.ws.worktreePath, base, branch);
        if (!hasCommits) {
          // Empty PR guard — nao abre PR sem mudancas
          emit?.("step", { step: "pr_skipped", repoKey, reason: "no commits" });
          continue;
        }

        await pushBranch(entry.ws.worktreePath, entry.ws.owner, entry.ws.repo, branch, token);

        // Coletar github subtasks deste repo + outras subtasks da mesma task
        const githubSubsForRepo = subtasks.filter(s =>
          s.type === "github" && s.resolvedRepoKey === repoKey
        );
        const otherSubs = subtasks.filter(s =>
          !(s.type === "github" && s.resolvedRepoKey === repoKey)
        );

        // Aggregar arquivos modificados (do result.changes de cada subtask)
        const changes: ChangeRow[] = [];
        for (const s of githubSubsForRepo) {
          const r = s.result as { changes?: import("../agents/code.js").CodeChange[] } | undefined;
          if (r?.changes) {
            for (const c of r.changes) {
              changes.push({ file: c.file, action: c.action, subtaskId: s.id });
            }
          }
        }

        const body = buildPrBody({
          taskDescription: description,
          repoKey,
          githubSubs: githubSubsForRepo,
          otherSubs,
          changes,
          reporterMarkdown: reportResult.report
        });
        const title = derivePrTitle(description);

        const pr = await createOrGetPullRequest({
          token,
          owner: entry.ws.owner,
          repo: entry.ws.repo,
          head: branch,
          base,
          title,
          body
        });

        githubPrUrls.push(pr.url);

        // Distribuir o prUrl pra cada github subtask deste repo (post-hoc)
        for (const s of githubSubsForRepo) {
          if (s.result && typeof s.result === "object") {
            (s.result as Record<string, unknown>).prUrl = pr.url;
          } else {
            s.result = { prUrl: pr.url };
          }
        }

        emit?.("step", { step: "pr_opened", repoKey, prUrl: pr.url, created: pr.created });
      } catch (prErr) {
        const msg = prErr instanceof Error ? prErr.message : String(prErr);
        emit?.("step", { step: "pr_error", repoKey, error: msg });
        console.warn(`[pipeline] PR consolidation failed for ${repoKey}: ${msg}`);
      }
    }

    const allCompleted = subtasks.every(st => st.status === "completed");
    const finalStatus: TaskStatus = allCompleted ? "completed" : "failed";

    // Reage com ✅ na msg WhatsApp (e atualiza currentStage no DB).
    await setStage("done");

    const total = Object.values(totalUsage).reduce((acc, u) => addTokenUsage(acc, u), ZERO_USAGE);

    await tasksCol.updateOne(
      { _id: taskId },
      {
        $set: {
          status: finalStatus,
          currentStage: "done",
          subtasks,
          trelloCardIds,
          githubPrUrls,
          summary: reportResult.report,
          tokenUsage: { ...totalUsage, total },
          branchByRepo,
          updatedAt: new Date(),
          completedAt: new Date()
        }
      }
    );

    // Move all Trello cards to done list (task card + subtask cards). Update task card desc first.
    if (options.trello?.doneListId && trelloCardIds.length > 0) {
      try {
        const taskCardId = trelloCardIds[0]!; // task card foi o primeiro pushado
        const trelloDesc = buildTrelloCompletionDesc({
          description,
          finalStatus,
          summary: reportResult.report,
          prUrls: githubPrUrls,
          taskId: taskId.toString()
        });
        await updateCard(taskCardId, { desc: trelloDesc });
        for (const cardId of trelloCardIds) {
          await moveCard(cardId, options.trello.doneListId);
        }
        emit?.("step", { step: "trello_moved_done", count: trelloCardIds.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[pipeline] Trello move-to-done failed: ${msg}`);
        emit?.("step", { step: "trello_move_error", error: msg });
      }
    }

    emit?.("step", { step: "completed", status: finalStatus });

    // Setup preview: se a task foi marcada como setup-preview e completou com sucesso,
    // configura os campos default do Project automaticamente.
    if (allCompleted && options.setupPreviewForProjectId) {
      try {
        const { getProjectsCollection } = await import("../../core/mongo.js");
        const projectsCol = await getProjectsCollection();
        const { ObjectId: OID } = await import("mongodb");
        if (OID.isValid(options.setupPreviewForProjectId)) {
          await projectsCol.updateOne(
            { _id: new OID(options.setupPreviewForProjectId) },
            {
              $set: {
                previewBuildCmd: "npm run build:preview",
                previewMocksDir: "src/mocks/preview",
                updatedAt: new Date()
              }
            }
          );
          emit?.("step", { step: "preview_setup_applied", projectId: options.setupPreviewForProjectId });
        }
      } catch (err) {
        console.warn("[pipeline] setupPreview project update failed:", err);
      }
    }

    // Notifica WhatsApp de fim (fire-and-forget)
    if (options.whatsapp?.jid) {
      void notifyTaskDone(
        options.whatsapp.jid,
        taskId.toString(),
        finalStatus,
        githubPrUrls,
        reportResult.report
      );
    }

    return {
      ok: allCompleted,
      taskId: taskId.toString(),
      status: finalStatus,
      summary: reportResult.report,
      trelloCardIds,
      githubPrUrls,
      report: reportResult.report,
      tokenUsage: { ...totalUsage, total }
    };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Reage com ✅ no msg WhatsApp tambem no caminho de erro (sinaliza fim do pipeline).
    try { await setStage("done"); } catch { /* ignore — proximo update sobrescreve */ }
    await tasksCol.updateOne(
      { _id: taskId },
      { $set: { status: "failed", currentStage: "done", updatedAt: new Date() } }
    );
    emit?.("step", { step: "error", error: errorMsg });

    // Tambem move pra done list em caso de falha (mesma coluna que completed, por design).
    if (options.trello?.doneListId && trelloCardIds.length > 0) {
      try {
        const taskCardId = trelloCardIds[0]!;
        const trelloDesc = buildTrelloCompletionDesc({
          description,
          finalStatus: "failed",
          summary: errorMsg,
          prUrls: [],
          taskId: taskId.toString()
        });
        await updateCard(taskCardId, { desc: trelloDesc });
        for (const cardId of trelloCardIds) {
          await moveCard(cardId, options.trello.doneListId);
        }
        emit?.("step", { step: "trello_moved_done", count: trelloCardIds.length });
      } catch (moveErr) {
        const msg = moveErr instanceof Error ? moveErr.message : String(moveErr);
        console.warn(`[pipeline] Trello move-to-done (failure path) failed: ${msg}`);
        emit?.("step", { step: "trello_move_error", error: msg });
      }
    }

    // Notifica WhatsApp de fim por falha
    if (options.whatsapp?.jid) {
      void notifyTaskDone(
        options.whatsapp.jid,
        taskId.toString(),
        "failed",
        [],
        errorMsg
      );
    }

    const total = Object.values(totalUsage).reduce((acc, u) => addTokenUsage(acc, u), ZERO_USAGE);
    return {
      ok: false,
      taskId: taskId.toString(),
      status: "failed",
      summary: errorMsg,
      trelloCardIds,
      githubPrUrls: [],
      tokenUsage: { ...totalUsage, total }
    };
  } finally {
    // Cleanup de worktrees (apos PR ja consolidado, ou em caso de erro)
    for (const [, entry] of taskWorktrees) {
      const wid = entry.ws.worktreePath.split(/[\\/]/).pop()?.split("--")[1] ?? "";
      await removeWorktree(entry.ws.owner, entry.ws.repo, wid).catch(() => {});
    }
  }
};

// ============== SUBTASK EXECUTORS ==============

const executeSubtask = async (
  subtask: SubTask,
  options: TaskExecuteOptions,
  taskId: string,
  taskWorktrees: Map<string, TaskWorktree>
): Promise<unknown> => {
  switch (subtask.type) {
    case "trello":
      return executeTrelloSubtask(subtask, options, taskId);
    case "github":
      return executeGithubSubtask(subtask, options, taskId, taskWorktrees);
    case "api":
      return executeApiSubtask(subtask, taskId, options);
    case "custom":
      return executeCustomSubtask(subtask, taskId, options);
    default:
      throw new Error(`Unknown subtask type: ${subtask.type}`);
  }
};

const executeTrelloSubtask = async (
  subtask: SubTask,
  options: TaskExecuteOptions,
  taskId: string
): Promise<{ trelloCardId: string; cardUrl: string }> => {
  const boardId = options.trello?.boardId ?? config.trello.defaultBoardId;
  const listId = options.trello?.listId;

  if (!boardId) throw new Error("Trello board ID nao configurado");

  // If no listId, get the first list of the board
  let targetListId = listId;
  if (!targetListId) {
    const lists = await getBoardLists(boardId);
    targetListId = lists[0]?.id;
    if (!targetListId) throw new Error("Board sem listas");
  }

  // Dedup: busca card existente com marker (task, subtask) em qualquer coluna do board
  const marker = buildCardMarker(taskId, subtask.id);
  const existing = await findCardByMarker(boardId, marker).catch(() => null);
  if (existing) {
    return { trelloCardId: existing.id, cardUrl: existing.url };
  }

  // Cria novo card com marker discreto no final do desc
  const desc = [
    subtask.description,
    "",
    "---",
    `🤖 ${marker}`
  ].join("\n");
  const card = await createCard(targetListId, subtask.description, desc);

  return { trelloCardId: card.id, cardUrl: card.url };
};

const executeGithubSubtask = async (
  subtask: SubTask,
  options: TaskExecuteOptions,
  taskId: string,
  taskWorktrees: Map<string, TaskWorktree>
): Promise<{
  codeUsage?: TokenUsage;
  changes?: import("../agents/code.js").CodeChange[];
}> => {
  const repos = normalizeRepos(options.github);
  if (repos.length === 0) throw new Error("GitHub nao configurado");

  const repoConfig = resolveRepo(repos, subtask.repo);
  const { owner, repo, token, baseBranch } = repoConfig;
  const repoKey = `${owner}/${repo}`;
  const language = options.language ?? "pt";
  const branchName = resolveTaskBranch(taskId);
  const worktreeId = taskId; // 1 worktree por (task, repo) — sem suffix de subtask

  // 1. Reutilizar worktree do repo se ja existir (criado por subtask github anterior)
  let entry = taskWorktrees.get(repoKey);
  if (!entry) {
    const ws = await createWorktree(owner, repo, branchName, worktreeId, token, baseBranch);
    entry = { ws, repoConfig };
    taskWorktrees.set(repoKey, entry);
  }

  // Marcar resolvedBranch/repoKey na subtask pra agregacao posterior
  subtask.resolvedBranch = branchName;
  subtask.resolvedRepoKey = repoKey;

  // 2. Run code agent no worktree compartilhado — apenas commit local
  const codeResult = await generateCodeChanges(
    subtask.description,
    entry.ws.worktreePath,
    language,
    options.emit ? (event) => {
      if (event.type === "text") {
        options.emit?.("step", { step: "openclaude_text", text: event.text, subtaskId: subtask.id });
      }
      if (event.type === "tool_start") {
        options.emit?.("step", { step: "openclaude_tool", tool: event.toolName, subtaskId: subtask.id });
      }
    } : undefined,
    {
      branchName,
      baseBranch: entry.ws.baseBranch,
      taskDescription: subtask.description,
      previewMocksDir: options.previewMocksDir
    }
  );

  // Defesa: rejeita changes fora do worktree (agent escape).
  // Camada (a): blocklist explicita de prefixos que NUNCA devem ser
  // tocados, mesmo que parecam absolutos legitimos.
  // Camada (b): qualquer absoluto fora do worktreePath e escape.
  const wtPath = entry.ws.worktreePath;
  const FORBIDDEN_PREFIXES = [
    "/openclaude",
    "/app",
    "/etc",
    "/root",
    "/home",
    "/usr",
    "/bin",
    "/sbin",
    "/var",
    "/proc",
    "/sys",
    "/tmp/openclaude"
  ];

  const isEscape = (file: string): boolean => {
    if (!file) return false;
    if (FORBIDDEN_PREFIXES.some(p => file === p || file.startsWith(p + "/"))) return true;
    if (!file.startsWith("/")) return false; // relativo — ok
    return !file.startsWith(wtPath);
  };

  const escapedChanges = (codeResult.changes ?? []).filter(c => isEscape(c.file));
  if (escapedChanges.length > 0) {
    const allFiles = escapedChanges.map(c => c.file);
    const sample = allFiles.slice(0, 5).join(", ");
    options.emit?.("step", { step: "agent_escape_detected", subtaskId: subtask.id, files: allFiles });

    // Camada (d): injeta feedback corretivo no description para o proximo retry.
    // O loop de retry em executeTask reusa subtask.description sem mudar nada,
    // entao patchamos aqui pra o agente receber instrucao direta.
    const hint = [
      "",
      "[RETRY APOS ESCAPE DE WORKTREE]",
      `Tentativa anterior tentou modificar ${allFiles.length} arquivo(s) FORA do worktree.`,
      `Paths bloqueados: ${sample}${allFiles.length > 5 ? ` (+${allFiles.length - 5} mais)` : ""}.`,
      `Worktree correto: ${wtPath}`,
      `INSTRUCAO: comece com \`pwd\` + \`ls\`. Use SOMENTE caminhos relativos ao worktree.`,
      `NUNCA toque em /openclaude, /app, /etc, /root, /home, /usr, /tmp/openclaude.`
    ].join("\n");
    // Evita duplicar o hint em retries sucessivos
    if (!subtask.description.includes("[RETRY APOS ESCAPE DE WORKTREE]")) {
      subtask.description = subtask.description + hint;
    }

    throw new Error(
      `Agent escapou do worktree e tentou modificar ${allFiles.length} arquivo(s) fora: ${sample}. ` +
      `Worktree esperado: ${wtPath}. Subtask rejeitada — use caminhos relativos.`
    );
  }

  const codeUsage = toTokenUsage(codeResult.usage);

  return { codeUsage, changes: codeResult.changes };
  // Nao limpa worktree aqui: cleanup acontece no finally do executeTask,
  // depois que o orchestrator consolida o PR.
};

const executeScratchSubtask = async (
  subtask: SubTask,
  taskId: string,
  options: TaskExecuteOptions
): Promise<{ message: string; result?: string }> => {
  const scratchDir = join(config.workspace.dir, "scratch", taskId, subtask.id);
  await mkdir(scratchDir, { recursive: true });

  // Inicializa git repo para que o OpenClaude possa fazer add/commit
  await execShell("git", ["init"], scratchDir, 10000);
  await execShell("git", ["add", "-A"], scratchDir, 10000);
  await execShell("git", ["commit", "-m", "initial"], scratchDir, 10000).catch(() => {});

  const result = await generateCodeChanges(
    subtask.description,
    scratchDir,
    options.language ?? "pt",
    (event) => {
      if (event.type === "text") {
        options.emit?.("step", { step: "openclaude_text", text: event.text, subtaskId: subtask.id });
      }
      if (event.type === "tool_start") {
        options.emit?.("step", { step: "openclaude_tool", tool: event.toolName, subtaskId: subtask.id });
      }
    },
    {
      branchName: `mathai/scratch-${taskId}-${subtask.id}`,
      taskDescription: subtask.description,
      previewMocksDir: options.previewMocksDir
    }
  );

  return {
    message: `${subtask.type === "api" ? "API" : "Custom"} subtask completed: ${subtask.description}`,
    result: result.fullText
  };
};

const executeApiSubtask = (subtask: SubTask, taskId: string, options: TaskExecuteOptions) =>
  executeScratchSubtask(subtask, taskId, options);

const executeCustomSubtask = (subtask: SubTask, taskId: string, options: TaskExecuteOptions) =>
  executeScratchSubtask(subtask, taskId, options);
