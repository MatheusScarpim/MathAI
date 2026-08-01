import { ObjectId } from "mongodb";
import {
  getTasksCollection,
  getTaskExecutionsCollection,
  type TaskRecord
} from "../../core/mongo.js";
import { config } from "../../core/config.js";

// Agents
import { planTask, type PlannedSubTask } from "../agents/planner.js";
import { validatePlan } from "../agents/planValidator.js";
import { generateCodeChanges } from "../agents/code.js";
import { reviewCodeChanges, type ReviewComment } from "../agents/reviewer.js";
import { runStaticChecks } from "../agents/staticChecks.js";
import { runSecretScan } from "../agents/secretScan.js";
import { criticizeUI } from "../agents/uxCritic.js";
import { verifyRuntime, type RuntimeEvidence, type RuntimeVerdict } from "../agents/runtimeVerifier.js";
import { startPreview, getActivePreview } from "../../services/previewManager.js";
import { getProjectContext } from "../context/projectContext.js";
import { detectStack, type DetectedStack } from "../context/stackDetector.js";
import { generateReport, type ExecutedSubtask } from "../agents/reporter.js";
import { runTrelloAgent } from "../agents/trelloAgent.js";

// Integrations
import {
  ensureBaseRepo,
  createWorktree,
  removeWorktree,
  getRepoTree,
  branchHasCommits,
  commitAllIfDirty,
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
  updateCard,
  addComment
} from "../integrations/trello.js";
import { execShell } from "../integrations/shell.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// PR body builder
import { buildPrBody, derivePrTitle, type ChangeRow } from "./prBody.js";
import { buildTrelloCompletionComment } from "./trelloDesc.js";
import { notifyTaskStart, notifyTaskDone, notifyStageChange } from "../../services/whatsappNotifier.js";

// Router
import { selectRoute, markProviderDown } from "../routing/router.js";

// Telemetria (plan W1 #3)
import { recordAgentCall } from "./telemetry.js";
import { computeCost } from "../routing/pricing.js";
import type { ProviderName } from "../routing/types.js";

// Queue / concurrency (plan W3 #7)
import { acquireSlot, setSlotTaskId, awaitProviderSlot } from "../queue/taskQueue.js";
// PR conflict detection (plan W3 #8)
import { detectPRConflicts } from "../queue/conflictDetect.js";

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

/** Max retries padrao para subtarefas (2 = ate 3 tentativas totais).
 * Numero >= 2 e necessario pra markProviderDown ter efeito: o 1o attempt marca
 * o provider down, o 2o pula pra proxima rule (ex: anthropic->deepseek). */
const DEFAULT_MAX_RETRIES = 2;

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

  // 1. Create task record (status=pending — vira planning so quando slot eh adquirido)
  // G6: se existingTaskId vier (approve-plan reusa), pula insert e usa o doc atual.
  let taskId: ObjectId;
  if (options.existingTaskId && ObjectId.isValid(options.existingTaskId)) {
    taskId = new ObjectId(options.existingTaskId);
    const existing = await tasksCol.findOne({ _id: taskId });
    if (!existing) {
      throw new Error(`existingTaskId ${options.existingTaskId} not found in DB`);
    }
    // Reseta para pending (queue gate vai mover para planning quando dispatchar).
    // Limpa pendingPlanApproval caso ainda esteja la.
    await tasksCol.updateOne(
      { _id: taskId },
      {
        $set: {
          status: "pending",
          currentStage: "planning",
          heartbeatAt: new Date(),
          updatedAt: new Date()
        },
        $unset: { pendingPlanApproval: "" }
      }
    );
  } else {
    const taskDoc: TaskRecord = {
      userId: options.userId,
      projectId: options.projectId,
      description,
      status: "pending",
      currentStage: "planning",
      subtasks: [],
      trelloCardIds: [],
      githubPrUrls: [],
      language,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const res = await tasksCol.insertOne(taskDoc);
    taskId = res.insertedId;
  }

  emit?.("step", { step: "task_created", taskId: taskId.toString() });

  // ============= QUEUE GATE (#7 plan W3) =============
  // Aguarda slot livre antes de iniciar o trabalho real. Task ja existe em
  // Mongo como "pending" — visivel via /api/tasks e /api/queue. Quando o
  // slot abre, marcamos status=planning e seguimos.
  emit?.("step", { step: "queue_wait", priority: options.priority ?? "normal" });
  const slot = await acquireSlot({
    description,
    priority: options.priority,
    taskId: taskId.toString()
  });
  setSlotTaskId(slot.queueId, taskId.toString());
  emit?.("step", { step: "queue_dispatch", queueId: slot.queueId });

  // Marca como planning agora que o slot foi adquirido
  await tasksCol.updateOne(
    { _id: taskId },
    { $set: { status: "planning", heartbeatAt: new Date(), updatedAt: new Date() } }
  );

  // Wrapper para liberar o slot no fim — chamado em todos os caminhos de saida
  // (success, throw, awaiting_approval return). try/finally cobre throw; os
  // returns explicitos chamam slot.release() manualmente.
  // ============= END QUEUE GATE =============

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

  // Promises dos agentes Trello (fire-and-forget). Aguardadas antes do
  // move-to-done pra evitar race: sem isso o move re-le o Mongo antes dos
  // $addToSet dos agentes aterrissarem e cards ficam parados na coluna inicial.
  const pendingTrelloAgents: Promise<unknown>[] = [];

  // Helper: persiste stage atual + emite SSE + reage na msg WhatsApp.
  // Tambem bate heartbeatAt (#6) — orphan-watchdog usa pra detectar tasks
  // mortas em reload mid-pipeline.
  const setStage = async (stage: TaskStage): Promise<void> => {
    await tasksCol.updateOne(
      { _id: taskId },
      { $set: { currentStage: stage, heartbeatAt: new Date(), updatedAt: new Date() } }
    );
    emit?.("step", { step: "stage", stage });
    if (whatsappJid) {
      void notifyStageChange(whatsappJid, taskId.toString(), stage);
    }
    // Agente Trello: LLM ve colunas + estado do card e decide mover/comentar/label.
    // Fire-and-forget — nao bloqueia o pipeline; erros ficam no proprio agente.
    const taskCardId = trelloCardIds[0];
    if (options.trello?.boardId && taskCardId && options.trello.agentEnabled !== false) {
      const agentPromise = runTrelloAgent({
        taskId,
        stage,
        taskDescription: description,
        boardId: options.trello.boardId,
        cardId: taskCardId,
        allowCreateCards: options.trello.agentCreateCards === true,
        language
      }).catch(err => {
        console.warn(`[pipeline] Trello agent (${stage}) falhou:`, err instanceof Error ? err.message : err);
      });
      pendingTrelloAgents.push(agentPromise);
    }
  };

  // Heartbeat tick — atualizado em emits frequentes (executando_subtask, etc).
  // Mantemos separado do setStage pra ser non-blocking (best-effort).
  const heartbeat = async (): Promise<void> => {
    try {
      await tasksCol.updateOne(
        { _id: taskId },
        { $set: { heartbeatAt: new Date() } }
      );
    } catch {/* swallow — heartbeat best-effort */}
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
        { $addToSet: { trelloCardIds: card.id }, $set: { updatedAt: new Date() } }
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

    // Context do projeto compartilhado entre planner/code/reviewer/reporter.
    // Populado lazy quando temos um repo resolvido (na planner ou na 1a github subtask).
    // Cached pelo proprio getProjectContext (5min TTL).
    let taskProjectContextText = "";

    // Hoisted pro escopo externo pra que o replan-loop (#1 plan W2) possa
    // re-chamar planTask com previousAttempt. Null quando preset path (sem replan).
    let replanPlannerContext: Parameters<typeof planTask>[1] | null = null;
    let replanPlannerRoute: Awaited<ReturnType<typeof selectRoute>> | undefined;

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
      // Tambem captura o basePath do primeiro repo pra alimentar o
      // ProjectContext (CLAUDE.md + package.json) que vai pro planner.
      let primaryBasePath: string | undefined;
      let primaryRepoKey: string | undefined;
      if (repos.length > 0) {
        availableTypes.push("github");
        const repoContexts: { name: string; owner: string; repo: string; tree?: string }[] = [];
        for (const r of repos) {
          const basePath = await ensureBaseRepo(r.owner, r.repo, r.token);
          if (!primaryBasePath) {
            primaryBasePath = basePath;
            primaryRepoKey = `${r.owner}/${r.repo}`;
          }
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

      // Fetch project context (cacheado 5min) — alimenta planner + agents
      // downstream. Sem repo configurado, retorna text="" e planner roda como antes.
      // Query = task description -> RAG injeta licoes relevantes pra esta tarefa.
      const projectCtx = await getProjectContext({
        worktreePath: primaryBasePath,
        repoKey: primaryRepoKey,
        query: description
      });
      taskProjectContextText = projectCtx.text;
      if (projectCtx.sources.length > 0) {
        emit?.("step", { step: "project_context_loaded", sources: projectCtx.sources, chars: projectCtx.text.length });
      }

      // Resolve route apenas pra telemetria (planner usa getClient direto, mas
      // queremos saber qual provider as rules apontam pra metricas)
      const plannerRoute = await selectRoute("taskPlanner", {}).catch(() => undefined);
      // G2 fix — agora que sabemos o provider, BLOQUEAMOS se o cap do
      // provider esta excedido (ex: ja existem 2 tasks anthropic rodando
      // com cap=2). awaitProviderSlot espera ate um slot do mesmo
      // provider dar release. Sem isto, o slot global ja foi adquirido
      // mas o code agent atropelaria o rate-limit.
      if (plannerRoute?.provider) {
        emit?.("step", { step: "queue_provider_wait", provider: plannerRoute.provider });
        await awaitProviderSlot(slot.queueId, plannerRoute.provider);
        emit?.("step", { step: "queue_provider_granted", provider: plannerRoute.provider });
      }
      // Persist pro escopo externo (replan-loop precisa re-chamar planTask)
      replanPlannerContext = plannerContext;
      replanPlannerRoute = plannerRoute;
      const planStart = Date.now();
      const planResult = await planTask(description, plannerContext, language, projectCtx.text);
      const planElapsed = Date.now() - planStart;
      totalUsage.planner = toTokenUsage(planResult.usage);

      await recordAgentCall({
        taskId,
        subtaskId: "_plan",
        agent: "planner",
        provider: plannerRoute?.provider,
        model: plannerRoute?.model,
        usage: totalUsage.planner,
        durationMs: planElapsed,
        success: true,
        input: { description },
        output: planResult.subtasks
      });

      // Filter out subtasks for integrations that are not configured
      filteredSubtasks = planResult.subtasks.filter(st => {
        if (st.type === "trello" && !hasTrello) return false;
        if (st.type === "github" && repos.length === 0) return false;
        return true;
      });

      // 2b. Plan Validator — OpenClaude le o repo real (read-only) e refina
      // o plano. Falhas/skips caem no draft sem bloquear. So roda quando ha
      // pelo menos uma subtask github e repo configurado (caso contrario
      // exploration nao tem valor agregado).
      const hasGithubSubtask = filteredSubtasks.some(st => st.type === "github");
      if (hasGithubSubtask && primaryBasePath) {
        emit?.("step", { step: "plan_validation_started", subtaskCount: filteredSubtasks.length });
        const valStart = Date.now();
        const validation = await validatePlan({
          taskDescription: description,
          draftSubtasks: filteredSubtasks,
          worktreePath: primaryBasePath,
          language,
          projectContextText: taskProjectContextText
        });
        const valElapsed = Date.now() - valStart;

        // Acumula tokens (validator = exploration OpenClaude + refine LLM)
        // Soma no balde "planner" pra unificar com o draft cheap.
        if (validation.usage.totalTokens > 0) {
          totalUsage.planner = addTokenUsage(totalUsage.planner, validation.usage);
        }

        emit?.("step", {
          step: "plan_validation_done",
          skipped: validation.skipped,
          changed: validation.changed,
          reason: validation.reason,
          beforeCount: filteredSubtasks.length,
          afterCount: validation.refinedSubtasks.length,
          elapsedMs: valElapsed
        });

        // Persist telemetria do validator mesmo quando o plano nao muda.
        // Assim custo/tokens por provider refletem todo call real do agente.
        await recordAgentCall({
          taskId,
          subtaskId: "_plan_validation",
          agent: "planValidator",
          provider: plannerRoute?.provider,
          model: plannerRoute?.model,
          usage: validation.usage,
          durationMs: valElapsed,
          success: !validation.skipped,
          error: validation.skipped ? validation.reason : undefined,
          input: { draft: planResult.subtasks },
          output: {
            skipped: validation.skipped,
            changed: validation.changed,
            beforeCount: filteredSubtasks.length,
            afterCount: validation.refinedSubtasks.length
          }
        });

        if (!validation.skipped && validation.changed) {
          filteredSubtasks = validation.refinedSubtasks;
        }
      }
    }

    if (filteredSubtasks.length === 0) {
      throw new Error(
        `Nenhuma subtask viavel apos aplicar filtros. Verifique as integracoes: ${!hasTrello ? "Trello nao configurado. " : ""}${repos.length === 0 ? "GitHub nao configurado." : ""}`
      );
    }

    // ============= PLAN APPROVAL GATE (#10 plan W2) =============
    // Pausa a task em awaiting_approval quando:
    //  - options.requiresPlanApproval === true (override manual via API/UI), OU
    //  - subtaskCount > PLAN_APPROVAL_SUBTASK_THRESHOLD (auto-gate em planos grandes).
    // Skip total quando presetSubtasks foi fornecido (bot ja aprovou).
    const PLAN_APPROVAL_SUBTASK_THRESHOLD = 5;
    const PLAN_APPROVAL_COST_THRESHOLD_USD = Number(process.env.PLAN_APPROVAL_COST_THRESHOLD_USD ?? 0.5);
    const PLAN_APPROVAL_TTL_MS = 24 * 60 * 60_000; // 24h
    const isPreset = !!(options.presetSubtasks && options.presetSubtasks.length > 0);
    let approvalReason: "manual" | "subtask_count" | "estimated_cost" | null = null;
    let approvalDetail: string | undefined;
    let estimatedCostUsd = 0;
    if (!isPreset) {
      if (options.requiresPlanApproval) {
        approvalReason = "manual";
        approvalDetail = "Flag requiresPlanApproval=true";
      } else if (filteredSubtasks.length > PLAN_APPROVAL_SUBTASK_THRESHOLD) {
        approvalReason = "subtask_count";
        approvalDetail = `${filteredSubtasks.length} subtasks > threshold ${PLAN_APPROVAL_SUBTASK_THRESHOLD}`;
      } else {
        // G9 — cost-based gate. Calcula avg costUsd por subtask (agent=code)
        // dos ultimos 50 task_executions do mesmo provider e projeta para o
        // numero de subtasks deste plano. Sem historico -> fallback heuristico
        // por provider. So gate quando passa do threshold.
        try {
          const provider = replanPlannerRoute?.provider;
          const recentExecs = await execCol
            .find(
              provider
                ? { agent: "code", provider, costUsd: { $exists: true, $gt: 0 } }
                : { agent: "code", costUsd: { $exists: true, $gt: 0 } }
            )
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();
          let avgCostPerSubtask = 0;
          if (recentExecs.length > 0) {
            const totalCost = recentExecs.reduce((acc, r) => acc + (r.costUsd ?? 0), 0);
            avgCostPerSubtask = totalCost / recentExecs.length;
          } else {
            // Fallbacks heuristicos por provider (USD por subtask).
            const fallback: Record<string, number> = { anthropic: 0.10, deepseek: 0.01, codex: 0.05 };
            avgCostPerSubtask = provider && fallback[provider] !== undefined ? fallback[provider] : 0.05;
          }
          estimatedCostUsd = avgCostPerSubtask * filteredSubtasks.length;
          if (estimatedCostUsd > PLAN_APPROVAL_COST_THRESHOLD_USD) {
            approvalReason = "estimated_cost";
            approvalDetail = `estimativa $${estimatedCostUsd.toFixed(2)} > threshold $${PLAN_APPROVAL_COST_THRESHOLD_USD.toFixed(2)} (provider=${provider ?? "n/a"}, avg=$${avgCostPerSubtask.toFixed(3)}/subtask × ${filteredSubtasks.length} subtasks, n=${recentExecs.length})`;
          }
        } catch (err) {
          // Falha aqui nao bloqueia — segue sem o cost gate.
          console.warn("[pipeline] G9 cost-gate estimation failed:", err);
        }
      }
    }
    if (approvalReason) {
      const expiresAt = new Date(Date.now() + PLAN_APPROVAL_TTL_MS);
      await tasksCol.updateOne(
        { _id: taskId },
        {
          $set: {
            status: "awaiting_approval",
            currentStage: "planning",
            heartbeatAt: new Date(),
            updatedAt: new Date(),
            pendingPlanApproval: {
              subtasks: filteredSubtasks,
              reason: approvalReason,
              detail: approvalDetail,
              expiresAt,
              createdAt: new Date()
            }
          }
        }
      );
      emit?.("step", {
        step: "plan_pending_approval",
        reason: approvalReason,
        detail: approvalDetail,
        subtaskCount: filteredSubtasks.length,
        estimatedCostUsd: estimatedCostUsd > 0 ? Number(estimatedCostUsd.toFixed(4)) : undefined,
        expiresAt: expiresAt.toISOString()
      });
      // Retorna result "em pausa" — UI/bot devem chamar approve/reject
      const totalUsageZero = Object.values(totalUsage).reduce((acc, u) => addTokenUsage(acc, u), ZERO_USAGE);
      return {
        ok: false,
        taskId: taskId.toString(),
        status: "awaiting_approval",
        summary: undefined,
        trelloCardIds,
        githubPrUrls: [],
        report: `Plano aguardando aprovacao (${approvalDetail ?? approvalReason}).`,
        tokenUsage: { ...totalUsage, total: totalUsageZero }
      };
    }
    // ============= END PLAN APPROVAL GATE =============

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

    // ============= REPLAN-ON-FAILURE OUTER LOOP (#1 plan W2) =============
    // Hard cap: 1 replan por task. Trigger: ao final do inner-while, se houver
    // qualquer subtask com status="failed" E o planner rodou (nao foi preset),
    // pedimos um novo plano com previousAttempt e re-executamos somente as
    // subtasks novas. Subtasks ja completadas sao preservadas intactas.
    const MAX_REPLANS = 1;
    let replanCount = 0;

    let executable = getExecutable();
    // Outer loop: roda 1x normalmente, +1x apos replan.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      while (executable.length > 0) {
      // Check if task was cancelled
      if (await checkCancelled(taskId)) {
        emit?.("step", { step: "cancelled" });
        throw new Error("Tarefa cancelada pelo usuario");
      }

      for (const subtask of executable) {
        emit?.("step", { step: "executing_subtask", subtaskId: subtask.id, type: subtask.type, description: subtask.description });
        void heartbeat();

        subtask.status = "executing" as TaskStatus;
        subtask.startedAt = new Date();

        const stStart = Date.now();
        // Sibling context: subtasks completadas ate agora (exclui a corrente)
        const siblings = buildSiblingContext(subtasks.filter(s => s.id !== subtask.id));
        try {
          const result = await executeSubtask(subtask, options, taskId.toString(), taskWorktrees, siblings);
          subtask.status = "completed";
          subtask.completedAt = new Date();
          subtask.result = result;
          completedIds.add(subtask.id);

          // Collect integration IDs (prUrl agora e preenchido na fase de consolidacao)
          if (result && typeof result === "object") {
            const r = result as Record<string, unknown>;
            if (r.trelloCardId) trelloCardIds.push(r.trelloCardId as string);
          }

          // Track code + reviewer token usage (review loop agora roda dentro
          // de executeGithubSubtask; tokens vem agregados no result).
          if (result && typeof result === "object") {
            const r = result as Record<string, unknown>;
            if (r.codeUsage) totalUsage.code = addTokenUsage(totalUsage.code, r.codeUsage as TokenUsage);
            if (r.reviewUsage) totalUsage.reviewer = addTokenUsage(totalUsage.reviewer, r.reviewUsage as TokenUsage);
            // Telemetria por subtask (#3 plan W1): propaga provider/model/cost
            if (typeof r.provider === "string") subtask.provider = r.provider;
            if (typeof r.model === "string") subtask.model = r.model;
            const codeU = r.codeUsage as TokenUsage | undefined;
            const reviewU = r.reviewUsage as TokenUsage | undefined;
            const tIn = (codeU?.inputTokens ?? 0) + (reviewU?.inputTokens ?? 0);
            const tOut = (codeU?.outputTokens ?? 0) + (reviewU?.outputTokens ?? 0);
            if (tIn > 0 || tOut > 0) {
              subtask.tokensIn = tIn;
              subtask.tokensOut = tOut;
            }
            if (typeof r.costUsd === "number") subtask.costUsd = r.costUsd;
            if (subtask.startedAt && subtask.completedAt) {
              subtask.durationMs = subtask.completedAt.getTime() - subtask.startedAt.getTime();
            }
          }

          // Stage emit pra UI: review ja rodou dentro do subtask
          if (subtask.type === "github") {
            await setStage("reviewing");
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

          // Record attempt history (#1 plan W2) — alimenta previousAttempt do replan.
          if (!Array.isArray(subtask.attemptHistory)) subtask.attemptHistory = [];
          subtask.attemptHistory.push({
            round: subtask.attemptHistory.length + 1,
            provider: subtask.provider,
            model: subtask.model,
            errorSummary: errorMsg.slice(0, 500),
            emptyStream: /empty|EMPTY_STREAM|stream ended without result/i.test(errorMsg),
            timestamp: new Date()
          });

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

      // Update task in DB. trelloCardIds via $addToSet (nao $set) — preserva
      // cards adicionados pelo agente Trello fire-and-forget (senao clobber).
      await tasksCol.updateOne(
        { _id: taskId },
        {
          $set: { subtasks, githubPrUrls, updatedAt: new Date() },
          ...(trelloCardIds.length > 0
            ? { $addToSet: { trelloCardIds: { $each: trelloCardIds } } }
            : {})
        }
      );

      executable = getExecutable();
      }
      // End of inner-while — todas as subtasks executaveis foram processadas.

      // Avalia trigger do replan
      const anyFailed = subtasks.some(s => s.status === "failed");
      const canReplan =
        anyFailed &&
        replanCount < MAX_REPLANS &&
        replanPlannerContext !== null &&    // preset path nao pode replanejar
        !options.presetSubtasks?.length;
      if (!canReplan) break;

      // Constroi snapshot da tentativa anterior
      const failedSubs = subtasks.filter(s => s.status === "failed");
      const succeededIds = subtasks.filter(s => s.status === "completed").map(s => s.id);
      const downedProviders = Array.from(new Set(
        failedSubs.map(s => s.provider).filter((p): p is string => !!p)
      ));
      const previousAttempt = {
        succeededSubtaskIds: succeededIds,
        failedSubtasks: failedSubs.map(s => ({
          id: s.id,
          type: s.type,
          description: s.description.slice(0, 800),
          errorSummary: (s.error ?? "").slice(0, 500) || "no explicit error",
          provider: s.provider,
          repo: s.resolvedRepoKey ?? s.repo
        })),
        downedProviders
      };

      emit?.("step", {
        step: "replan_triggered",
        replanCount: replanCount + 1,
        failedCount: failedSubs.length,
        succeededCount: succeededIds.length
      });

      // Re-roda planner com guidance
      let replanResult: Awaited<ReturnType<typeof planTask>>;
      const replanStart = Date.now();
      try {
        replanResult = await planTask(
          description,
          replanPlannerContext!,
          language,
          taskProjectContextText,
          previousAttempt
        );
      } catch (err) {
        emit?.("step", {
          step: "replan_failed",
          error: err instanceof Error ? err.message : String(err)
        });
        break;
      }
      const replanElapsed = Date.now() - replanStart;
      totalUsage.planner = addTokenUsage(totalUsage.planner, toTokenUsage(replanResult.usage));
      await recordAgentCall({
        taskId,
        subtaskId: "_replan",
        agent: "planner",
        provider: replanPlannerRoute?.provider,
        model: replanPlannerRoute?.model,
        usage: toTokenUsage(replanResult.usage),
        durationMs: replanElapsed,
        success: replanResult.subtasks.length > 0,
        input: { description, previousAttempt },
        output: replanResult.subtasks
      });

      // Diff: descarta subtasks com id que ja foi succeeded (planner foi
      // instruido a reusar, mas se reescrever a gente confia no original);
      // mantem subtasks failed (vamos marcar obsoleted) e adiciona as novas.
      const succeededSet = new Set(succeededIds);
      const newSubtasksRaw = replanResult.subtasks.filter(st => !succeededSet.has(st.id));

      // Filtra novas pelo conjunto de tipos disponiveis (mesma lógica do plano inicial)
      const newSubtasksFiltered = newSubtasksRaw.filter(st => {
        if (st.type === "trello" && !hasTrello) return false;
        if (st.type === "github" && repos.length === 0) return false;
        return true;
      });

      if (newSubtasksFiltered.length === 0) {
        emit?.("step", { step: "replan_empty", reason: "planner_returned_no_new_subtasks" });
        break;
      }

      // Obsoleta failed pra que dependentes nao tentem rerodar elas
      for (const s of subtasks) {
        if (s.status === "failed") {
          s.status = "cancelled" as TaskStatus;
          s.error = (s.error ? s.error + " | " : "") + "obsoleted by replan";
          // Mantemos em completedIds (ja estava la) pra nao bloquear dependents
        }
      }

      // Adiciona novas marcadas com fromReplan e fresh retry budget
      for (const st of newSubtasksFiltered) {
        const sub: SubTask = {
          id: st.id,
          type: st.type,
          description: st.description,
          status: "pending" as TaskStatus,
          priority: st.priority,
          dependsOn: st.dependsOn,
          repo: st.repo,
          maxRetries: DEFAULT_MAX_RETRIES,
          retryCount: 0,
          fromReplan: true
        };
        subtasks.push(sub);
      }

      replanCount++;
      await tasksCol.updateOne(
        { _id: taskId },
        { $set: { subtasks, replanCount, updatedAt: new Date() } }
      );

      emit?.("step", {
        step: "replan_done",
        replanCount,
        addedCount: newSubtasksFiltered.length
      });

      executable = getExecutable();
      // Inner-while sobe de novo e processa as novas subtasks.
    }
    // ============= END REPLAN-ON-FAILURE OUTER LOOP =============

    // 4. Generate report (LLM ou fallback deterministico — nunca throw)
    await setStage("reporting");
    emit?.("step", { step: "generating_report" });
    // Se planner foi pulado (preset path) e ja temos worktree, busca context
    // do primeiro worktree pra alimentar o reporter tambem. Cache evita re-IO.
    if (!taskProjectContextText && taskWorktrees.size > 0) {
      const first = taskWorktrees.values().next().value;
      if (first) {
        const ctx = await getProjectContext({
          worktreePath: first.ws.worktreePath,
          repoKey: `${first.repoConfig.owner}/${first.repoConfig.repo}`
        });
        taskProjectContextText = ctx.text;
      }
    }
    const reporterRoute = await selectRoute("taskReporter", {}).catch(() => undefined);
    const reportStart = Date.now();
    const reportResult = await generateReport(description, executedSubtasks, language, taskProjectContextText);
    totalUsage.reporter = toTokenUsage(reportResult.usage);

    await recordAgentCall({
      taskId,
      subtaskId: "_report",
      agent: "reporter",
      provider: reporterRoute?.provider,
      model: reporterRoute?.model,
      usage: totalUsage.reporter,
      durationMs: Date.now() - reportStart,
      success: true,
      input: { executedSubtasks },
      output: reportResult.report
    });

    // 5. Consolidar PRs: push branch + abrir 1 PR por (task, repo)
    console.info(`[pipeline][DBG] consolidation start: taskWorktrees=${taskWorktrees.size} keys=${JSON.stringify([...taskWorktrees.keys()])}`);
    for (const [repoKey, entry] of taskWorktrees) {
      const branch = entry.ws.branchName;
      branchByRepo[repoKey] = branch;
      const base = entry.ws.baseBranch || entry.repoConfig.baseBranch || "main";
      const token = entry.repoConfig.token;
      console.info(`[pipeline][DBG] repo=${repoKey} branch=${branch} base=${base} wt=${entry.ws.worktreePath} hasToken=${!!token}`);
      if (!token) {
        emit?.("step", { step: "pr_skipped", repoKey, reason: "no token" });
        continue;
      }

      try {
        // Commit deterministico: garante que qualquer arquivo que o code agent
        // escreveu no worktree entre num commit, mesmo que o LLM tenha esquecido
        // (ou falhado ao) rodar `git commit`. Sem isso a branch fica vazia e o
        // guard "no commits" abaixo aborta o PR indevidamente.
        try {
          const committed = await commitAllIfDirty(
            entry.ws.worktreePath,
            derivePrTitle(description)
          );
          console.info(`[pipeline][DBG] commitAllIfDirty repo=${repoKey} committed=${committed}`);
          if (committed) {
            emit?.("step", { step: "auto_committed", repoKey, branch });
          }
        } catch (commitErr) {
          console.warn(
            `[pipeline] auto-commit failed for ${repoKey}:`,
            commitErr instanceof Error ? commitErr.message : commitErr
          );
        }

        const hasCommits = await branchHasCommits(entry.ws.worktreePath, base, branch);
        console.info(`[pipeline][DBG] branchHasCommits repo=${repoKey} hasCommits=${hasCommits}`);
        if (!hasCommits) {
          // Empty PR guard — nao abre PR sem mudancas. Como subtasks github
          // mandam "criar/editar arquivos", branch sem commits significa que
          // o code agent nao concretizou nada apesar de ter sido marcado
          // completed. Rebaixamos pra failed pra que finalStatus reflita
          // realidade e allCompleted vire false.
          const ghSubsThisRepo = subtasks.filter(
            s => s.type === "github" && s.resolvedRepoKey === repoKey && s.status === "completed"
          );
          for (const s of ghSubsThisRepo) {
            s.status = "failed";
            s.error = (s.error ? s.error + " | " : "") + "Branch sem commits apos execucao do code agent";
            const idx = executedSubtasks.findIndex(es => es.id === s.id);
            if (idx >= 0) {
              executedSubtasks[idx] = {
                ...executedSubtasks[idx]!,
                status: "failed",
                error: s.error
              };
            }
          }
          emit?.("step", {
            step: "pr_skipped",
            repoKey,
            reason: "no commits",
            downgradedSubtasks: ghSubsThisRepo.map(s => s.id)
          });
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

        // G11: post-merge/post-open inference de decisoes (fire-and-forget).
        // Roda na worktree atual (que ja tem o codigo recem-mudado) — atualiza
        // project_decisions sem bloquear o fluxo da pipeline.
        void (async () => {
          try {
            const { inferDecisionsFromWorktree } = await import("../memory/projectDecisions.js");
            const result = await inferDecisionsFromWorktree(entry.ws.worktreePath, repoKey);
            if (result.inferred > 0) {
              console.log(`[pipeline] post-PR inference for ${repoKey}: ${result.inferred} decisions updated`);
            }
          } catch (infErr) {
            console.warn(`[pipeline] post-PR inferDecisions failed for ${repoKey}:`, infErr);
          }
        })();
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
          githubPrUrls,
          summary: reportResult.report,
          tokenUsage: { ...totalUsage, total },
          branchByRepo,
          updatedAt: new Date(),
          completedAt: new Date()
        },
        // $addToSet (nao $set) preserva cards do agente Trello fire-and-forget.
        ...(trelloCardIds.length > 0
          ? { $addToSet: { trelloCardIds: { $each: trelloCardIds } } }
          : {})
      }
    );

    // Move all Trello cards to done list (task card + subtask cards). Posta o
    // resumo do que foi feito como COMENTARIO (nao sobrescreve a descricao —
    // preserva desc original + marker de dedup).
    if (options.trello?.doneListId && trelloCardIds.length > 0) {
      try {
        const taskCardId = trelloCardIds[0]!; // task card foi o primeiro pushado
        const trelloComment = buildTrelloCompletionComment({
          finalStatus,
          summary: reportResult.report,
          prUrls: githubPrUrls
        });
        await addComment(taskCardId, trelloComment);
        // Aguarda os agentes Trello fire-and-forget terminarem — garante que os
        // cards que eles criaram ja estao persistidos antes de re-ler o Mongo.
        await Promise.allSettled(pendingTrelloAgents);
        // Re-le do Mongo pra incluir cards criados pelo agente Trello (fire-and-forget,
        // fora do array em memoria). Uniao dedup.
        const freshDoc = await tasksCol.findOne({ _id: taskId }, { projection: { trelloCardIds: 1 } });
        const allCardIds = Array.from(new Set([...trelloCardIds, ...(freshDoc?.trelloCardIds ?? [])]));
        for (const cardId of allCardIds) {
          await moveCard(cardId, options.trello.doneListId);
        }
        emit?.("step", { step: "trello_moved_done", count: allCardIds.length });
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
        const trelloComment = buildTrelloCompletionComment({
          finalStatus: "failed",
          summary: errorMsg,
          prUrls: []
        });
        await addComment(taskCardId, trelloComment);
        // Aguarda os agentes Trello fire-and-forget antes de re-ler (evita race).
        await Promise.allSettled(pendingTrelloAgents);
        // Re-le do Mongo pra incluir cards criados pelo agente Trello. Uniao dedup.
        const freshDoc = await tasksCol.findOne({ _id: taskId }, { projection: { trelloCardIds: 1 } });
        const allCardIds = Array.from(new Set([...trelloCardIds, ...(freshDoc?.trelloCardIds ?? [])]));
        for (const cardId of allCardIds) {
          await moveCard(cardId, options.trello.doneListId);
        }
        emit?.("step", { step: "trello_moved_done", count: allCardIds.length });
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
    // Libera o slot do queue (#7) — todos os returns + throws caem aqui.
    slot.release();
  }
};

// ============== SUBTASK EXECUTORS ==============

/**
 * Constroi bloco de contexto das subtasks ja completadas. Lista as ultimas 5,
 * com descricao + arquivos modificados (pra subtasks github). Caps em 30 arquivos
 * total pra nao explodir o prompt.
 *
 * Retorna "" se nenhuma sibling completada — caller pula injecao.
 */
const buildSiblingContext = (prev: SubTask[]): string => {
  const completed = prev.filter(st => st.status === "completed");
  if (completed.length === 0) return "";

  const recent = completed.slice(-5);
  let fileBudget = 30;

  const items = recent.map(st => {
    const tag = `[${st.type}${st.id ? ` ${st.id}` : ""}]`;
    const desc = (st.description ?? "").split("\n")[0]?.slice(0, 200) ?? "";
    let filesLine = "";
    if (st.type === "github" && st.result && typeof st.result === "object") {
      const r = st.result as { changes?: { file: string }[] };
      const files = (r.changes ?? []).map(c => c.file);
      if (files.length > 0 && fileBudget > 0) {
        const take = Math.min(files.length, fileBudget);
        fileBudget -= take;
        const shown = files.slice(0, take);
        const suffix = files.length > take ? ` (+${files.length - take} mais)` : "";
        filesLine = `\n  Arquivos: ${shown.join(", ")}${suffix}`;
      }
    }
    return `- ${tag} ${desc}${filesLine}`;
  }).join("\n");

  const omittedNote = completed.length > recent.length
    ? `\n(${completed.length - recent.length} subtask(s) anteriores omitidas pra economizar contexto.)`
    : "";

  return [
    "[CONTEXTO DE SUBTAREFAS ANTERIORES NESTA TASK]",
    "Subtasks ja completadas (mais recentes):",
    items,
    omittedNote,
    "",
    "INSTRUCAO: nao reimplemente o que ja foi feito. Leia os arquivos mencionados se precisar entender o estado atual antes de modificar."
  ].filter(Boolean).join("\n");
};

const executeSubtask = async (
  subtask: SubTask,
  options: TaskExecuteOptions,
  taskId: string,
  taskWorktrees: Map<string, TaskWorktree>,
  /** Bloco de contexto das subtasks ja completadas. Opcional. */
  siblingContext?: string
): Promise<unknown> => {
  switch (subtask.type) {
    case "trello":
      return executeTrelloSubtask(subtask, options, taskId);
    case "github":
      return executeGithubSubtask(subtask, options, taskId, taskWorktrees, siblingContext);
    case "api":
      return executeApiSubtask(subtask, taskId, options);
    case "custom":
      return executeCustomSubtask(subtask, taskId, options);
    default:
      // Defesa: tipo desconhecido (ex: planner alucinou "edit"/"write") NAO deve
      // derrubar a task inteira. O planner ja normaliza na origem (normalizeSubtasks);
      // isto e a segunda camada caso algo escape (replan, injecao manual).
      // Se ha repo referenciado, roteia pra github (escreve no WORKTREE) — NUNCA
      // pra custom, que roda no cwd do container (/openclaude) e polui o repo dele.
      if (subtask.repo || subtask.resolvedRepoKey) {
        console.warn(`[pipeline] unknown subtask type "${subtask.type}" (id=${subtask.id}) with repo — routing to github`);
        return executeGithubSubtask(subtask, options, taskId, taskWorktrees, siblingContext);
      }
      console.warn(`[pipeline] unknown subtask type "${subtask.type}" (id=${subtask.id}) — treating as custom`);
      return executeCustomSubtask(subtask, taskId, options);
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

/** Numero maximo de rounds reviewer→code de auto-correcao por subtask. */
const MAX_REVIEW_ROUNDS = 2;

const executeGithubSubtask = async (
  subtask: SubTask,
  options: TaskExecuteOptions,
  taskId: string,
  taskWorktrees: Map<string, TaskWorktree>,
  /** Resumo das subtasks ja concluidas nesta task. Vazio na primeira. */
  siblingContext?: string
): Promise<{
  codeUsage?: TokenUsage;
  reviewUsage?: TokenUsage;
  changes?: import("../agents/code.js").CodeChange[];
  reviewApproved?: boolean;
  reviewRounds?: number;
  provider?: string;
  model?: string;
  costUsd?: number;
  /** Veredicto do runtime verifier — alimenta SubTask.result.runtimeVerification pro UI. */
  runtimeVerification?: {
    verdict: RuntimeVerdict;
    evidence: RuntimeEvidence[];
    iterations: number;
    reason?: string;
  };
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

  // 2. Resolve route (provider + model + grpcUrl) for this subtask
  const route = await selectRoute("taskCode", {
    type: subtask.type,
    description: subtask.description,
    repo: repoKey,
    preferProvider: options.execProvider
  });
  options.emit?.("step", { step: "route_selected", subtaskId: subtask.id, provider: route.provider, model: route.model, reason: route.reason });

  // 2b. Project context (cacheado 5min) — alimenta code agent + reviewer.
  // Stack/convencoes/CLAUDE.md ficam no prompt antes do agente explorar o repo.
  // Query = subtask description -> licoes RAG vem afinadas ao escopo da subtarefa.
  const projectCtx = await getProjectContext({
    worktreePath: entry.ws.worktreePath,
    repoKey,
    query: subtask.description
  });
  if (projectCtx.sources.length > 0) {
    options.emit?.("step", {
      step: "project_context_loaded",
      subtaskId: subtask.id,
      sources: projectCtx.sources,
      chars: projectCtx.text.length
    });
  }

  // Merge project context + sibling context num bloco unico passado ao agent.
  // Ordem: project context (estavel) primeiro, depois siblings (volatil).
  const agentContextText = [projectCtx.text, siblingContext]
    .filter(s => s && s.length > 0)
    .join("\n\n");
  if (siblingContext && siblingContext.length > 0) {
    options.emit?.("step", {
      step: "sibling_context_injected",
      subtaskId: subtask.id,
      chars: siblingContext.length
    });
  }

  // Stack detection (#12 plan W4) — 1x por subtask. Usado pra:
  //  - skip uxCritic em stacks sem UI (Go CLI, lib Python)
  //  - injetar contexto de stack no runtimeVerifier
  //  - log/audit no SSE
  // Falha silenciosa: stack=unknown nao bloqueia nada.
  const detectedStack: DetectedStack = await detectStack(entry.ws.worktreePath).catch(() => ({
    primary: "unknown" as const, frameworks: [], hasUI: false, reason: "detect_failed"
  }));
  options.emit?.("step", {
    step: "stack_detected",
    subtaskId: subtask.id,
    primary: detectedStack.primary,
    frameworks: detectedStack.frameworks,
    hasUI: detectedStack.hasUI
  });

  // 3. Run code agent no worktree compartilhado — apenas commit local.
  // Helper para invocar generateCodeChanges (re-chamavel no loop de revisao).
  // Tracks telemetria por chamada — recordAgentCall persiste row + bump byProvider.
  const taskOid = new ObjectId(taskId);
  const runCode = async (desc: string) => {
    const t0 = Date.now();
    try {
      const r = await generateCodeChanges(
        desc,
        entry!.ws.worktreePath,
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
          baseBranch: entry!.ws.baseBranch,
          taskDescription: desc,
          previewMocksDir: options.previewMocksDir
        },
        route,
        agentContextText
      );
      await recordAgentCall({
        taskId: taskOid,
        subtaskId: subtask.id,
        agent: "code",
        provider: route.provider,
        model: route.model,
        usage: toTokenUsage(r.usage),
        durationMs: Date.now() - t0,
        success: true,
        input: { description: desc.slice(0, 500) },
        output: { changeCount: r.changes?.length ?? 0 }
      });
      return r;
    } catch (err) {
      await recordAgentCall({
        taskId: taskOid,
        subtaskId: subtask.id,
        agent: "code",
        provider: route.provider,
        model: route.model,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        durationMs: Date.now() - t0,
        success: false,
        error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        input: { description: desc.slice(0, 500) }
      });
      throw err;
    }
  };

  let codeResult: Awaited<ReturnType<typeof generateCodeChanges>>;
  try {
    codeResult = await runCode(subtask.description);
  } catch (err) {
    // App-level provider failure (EMPTY_STREAM, gRPC truncado, etc.) → marca
    // o grpcUrl como down por 60s pra que o retry pule esse provider e
    // caia na proxima rule de menor prioridade. TCP ping nao detecta esse
    // tipo de falha (provider responde no socket mas devolve stream vazio).
    const msg = err instanceof Error ? err.message : String(err);
    if (/empty|EMPTY_STREAM|stream ended without result|truncated|rate-limit|auth/i.test(msg)) {
      markProviderDown(route.grpcUrl, 60_000);
      options.emit?.("step", {
        step: "provider_marked_down",
        subtaskId: subtask.id,
        provider: route.provider,
        grpcUrl: route.grpcUrl,
        reason: msg.slice(0, 200)
      });
    }

    // Drift detection (#5 plan W3) — quando agent reporta path/simbolo nao
    // encontrado, injeta hint corretivo no description pro proximo retry.
    // Eh um mini-replan deterministico: instruimos o agent a usar
    // find/grep ANTES de escrever, em vez de assumir paths.
    const driftPattern = /(file|module|cannot find|no such file|ENOENT).*\b(not found|nao encontrado|inexistente)\b|ENOENT|MODULE_NOT_FOUND/i;
    if (driftPattern.test(msg) && !subtask.description.includes("[DRIFT DETECTED]")) {
      // Extrai paths/simbolos suspeitos da mensagem (heuristica: tokens entre quotes ou backticks)
      const suspects = Array.from(msg.matchAll(/[`"']([^`"']{3,80})[`"']/g))
        .map(m => m[1])
        .filter((s): s is string => !!s && /[./\w]/.test(s))
        .slice(0, 3);
      const suspectBlock = suspects.length > 0
        ? `\nAlvos suspeitos da falha anterior: ${suspects.map(s => `\`${s}\``).join(", ")}.`
        : "";
      const driftHint = [
        "",
        "[DRIFT DETECTED — RETRY COM EXPLORE]",
        "Tentativa anterior falhou porque um path/arquivo/modulo nao existe mais com o nome esperado.",
        suspectBlock,
        "INSTRUCAO: ANTES de editar qualquer arquivo, execute:",
        "  1. `find . -type f -name '<nome>*' -not -path '*/node_modules/*'` pra localizar o arquivo real",
        "  2. `grep -rn '<simbolo>' src/ apps/ --include='*.ts' --include='*.tsx' --include='*.vue'` pra confirmar a localizacao",
        "Use o resultado real para decidir o path. NUNCA assuma estrutura — confirme com a tool."
      ].join("\n");
      subtask.description = subtask.description + driftHint;
      options.emit?.("step", {
        step: "drift_detected",
        subtaskId: subtask.id,
        suspects,
        errorSnippet: msg.slice(0, 200)
      });
    }
    throw err;
  }

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

  // Defesa: subtask github com mandato de editar arquivos NAO pode terminar
  // com zero changes. Se o agent retornou vazio (stream curto, rate-limit,
  // alucinacao silenciosa), throw -> retry path do executeTask. Apos esgotar
  // retries, a subtask vira "failed" e allCompleted flipa pra false.
  const realChanges = codeResult.changes ?? [];
  if (realChanges.length === 0) {
    const emptyHint = [
      "",
      "[RETRY APOS RESPOSTA VAZIA]",
      `Tentativa anterior retornou ZERO arquivos modificados em ${codeResult.fullText.length} chars de texto.`,
      `INSTRUCAO: voce DEVE usar as tools Write/Edit/MultiEdit para criar ou modificar arquivos reais.`,
      `Apenas descrever a solucao em texto NAO conta como execucao. Faca o commit local apos editar.`,
      `Comece com \`pwd\` + \`ls\` pra confirmar o workspace, depois edite os arquivos necessarios.`
    ].join("\n");
    if (!subtask.description.includes("[RETRY APOS RESPOSTA VAZIA]")) {
      subtask.description = subtask.description + emptyHint;
    }
    // Mesmo tratamento do catch acima: marca provider down pra o retry
    // tentar uma rule diferente (anthropic/deepseek em vez de codex).
    markProviderDown(route.grpcUrl, 60_000);
    options.emit?.("step", {
      step: "subtask_empty_changes",
      subtaskId: subtask.id,
      provider: route.provider,
      grpcUrl: route.grpcUrl,
      promptTokens: codeUsage.inputTokens,
      completionTokens: codeUsage.outputTokens
    });
    throw new Error(
      `Code agent retornou zero changes (in=${codeUsage.inputTokens} out=${codeUsage.outputTokens}). ` +
      `Subtask github sem arquivos modificados = falha. Veja feedback_subtask_empty_changes_is_failure.md.`
    );
  }

  // PR conflict detection (#8 plan W3) — warn only, nao bloqueia. So roda
  // 1x (round 0 implicito; estamos antes do review-loop).
  try {
    const conflicts = await detectPRConflicts(
      realChanges.map(c => c.file),
      taskId,
      repoKey
    );
    if (conflicts.length > 0) {
      options.emit?.("step", {
        step: "conflict_detected",
        subtaskId: subtask.id,
        conflictCount: conflicts.length,
        details: conflicts.slice(0, 5).map(c => ({
          taskId: c.conflictingTaskId,
          status: c.conflictingStatus,
          files: c.overlappingFiles,
          ratio: Math.round(c.ratio * 100) / 100
        }))
      });
    }
  } catch (cErr) {
    // best-effort — nunca bloqueia
    void cErr;
  }

  // 4. Review loop com auto-correcao.
  // Diferente do antigo review one-shot (que so logava warnings), aqui se o
  // reviewer retornar errors o code agent e re-invocado no MESMO worktree
  // com os comments injetados no description. Loop ate MAX_REVIEW_ROUNDS ou
  // ate aprovacao. Worktree acumula commits naturalmente entre rounds.
  let cumulativeCode = codeUsage;
  let cumulativeReview: TokenUsage = ZERO_USAGE;
  let accumulatedChanges = realChanges;
  let approved = true;
  let roundsUsed = 0;
  // UX critic so roda 1x por subtask (round 0 com frontend changes). Round 1
  // de correcao trabalha com feedback do critic mas nao re-roda critic.
  let criticAlreadyRan = false;
  // Runtime verifier roda 1x por subtask (round 0). Veredicto entra no
  // prompt corretivo do round 1 (junto com static/llm/critic feedback).
  let verifierAlreadyRan = false;
  // Estes precisam viver fora do for-loop pra alimentar o return final
  // (runtimeVerification → SubTask.result no pipeline).
  let runtimeVerdictFinal: RuntimeVerdict | "SKIPPED" = "SKIPPED";
  let runtimeEvidenceFinal: RuntimeEvidence[] = [];
  let runtimeReasonFinal: string | undefined;
  let runtimeIterationsFinal = 0;
  const FRONTEND_RE = /\.(vue|tsx|jsx|svelte|html|css|scss|sass)$/i;

  for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
    // 4a-pre. Commit deterministico do que o code agent escreveu nesta rodada.
    // O comentario acima assumia que o worktree "acumula commits naturalmente",
    // mas o code agent (LLM) nem sempre roda `git commit` — deixando a branch
    // vazia. Isso quebra o preview deploy (previewManager diff = 0 arquivos ->
    // uxCritic/runtimeVerifier travam) E a consolidacao do PR ("no commits").
    // Committar no topo de cada round garante que preview, critic, verifier e
    // push sempre vejam o codigo real. Nao depende do LLM.
    try {
      const committed = await commitAllIfDirty(
        entry.ws.worktreePath,
        derivePrTitle(subtask.description)
      );
      if (committed) {
        options.emit?.("step", { step: "auto_committed", subtaskId: subtask.id, round });
      }
    } catch (commitErr) {
      console.warn(
        `[pipeline] auto-commit (round ${round}) failed for ${subtask.id}:`,
        commitErr instanceof Error ? commitErr.message : commitErr
      );
    }

    // 4a. Static checks (tsc + lint) rodam SEMPRE — mesmo se LLM reviewer
    // falhar. Erros deterministicos pegam o que o LLM nao ve.
    let staticResult: Awaited<ReturnType<typeof runStaticChecks>> | null = null;
    try {
      staticResult = await runStaticChecks(entry.ws.worktreePath, detectedStack);
      await recordAgentCall({
        taskId: taskOid,
        subtaskId: subtask.id,
        agent: "reviewer",
        provider: "static-checks",
        model: staticResult.ran.length > 0 ? staticResult.ran.join(",") : "none",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        durationMs: staticResult.durationMs,
        success: staticResult.comments.length === 0,
        output: {
          commentCount: staticResult.comments.length,
          ran: staticResult.ran,
          skipped: staticResult.skipped,
          errored: staticResult.errored
        }
      });
      options.emit?.("step", {
        step: "static_checks_done",
        subtaskId: subtask.id,
        round: round + 1,
        ran: staticResult.ran,
        skipped: staticResult.skipped.map(s => s.tool),
        errored: staticResult.errored.map(e => `${e.tool}:${e.error}`),
        commentCount: staticResult.comments.length,
        durationMs: staticResult.durationMs
      });
    } catch (staticErr) {
      const sm = staticErr instanceof Error ? staticErr.message : String(staticErr);
      options.emit?.("step", { step: "static_checks_failed", subtaskId: subtask.id, error: sm });
    }

    // 4a-bis. Secret scan deterministico (#13). Cheap (regex + IO).
    // Roda contra os arquivos modificados acumulados; hits viram blocking.
    let secretResult: Awaited<ReturnType<typeof runSecretScan>> | null = null;
    try {
      const filesForScan = accumulatedChanges.map(c => c.file);
      secretResult = await runSecretScan(entry.ws.worktreePath, filesForScan);
      if (secretResult.comments.length > 0) {
        await recordAgentCall({
          taskId: taskOid,
          subtaskId: subtask.id,
          agent: "reviewer",
          provider: "secret-scan",
          model: "regex-v1",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          durationMs: secretResult.durationMs,
          success: false,
          output: { hits: secretResult.comments.length, files: secretResult.scannedFiles }
        });
      }
      options.emit?.("step", {
        step: "secret_scan_done",
        subtaskId: subtask.id,
        round: round + 1,
        scannedFiles: secretResult.scannedFiles,
        hits: secretResult.comments.length,
        durationMs: secretResult.durationMs
      });
    } catch (secErr) {
      const sm = secErr instanceof Error ? secErr.message : String(secErr);
      options.emit?.("step", { step: "secret_scan_failed", subtaskId: subtask.id, error: sm });
    }

    // 4b. LLM reviewer (semantic checks)
    let reviewResult: Awaited<ReturnType<typeof reviewCodeChanges>> | null = null;
    const reviewerRoute = await selectRoute("taskReviewer", { type: subtask.type, description: subtask.description, repo: repoKey }).catch(() => undefined);
    const reviewT0 = Date.now();
    try {
      reviewResult = await reviewCodeChanges(
        subtask.description,
        accumulatedChanges,
        [], // originalFiles indisponivel (worktree ja modificado in-place)
        language,
        agentContextText
      );
      await recordAgentCall({
        taskId: taskOid,
        subtaskId: subtask.id,
        agent: "reviewer",
        provider: reviewerRoute?.provider,
        model: reviewerRoute?.model,
        usage: toTokenUsage(reviewResult.usage),
        durationMs: Date.now() - reviewT0,
        success: true,
        output: { approved: reviewResult.approved, commentCount: reviewResult.comments.length }
      });
    } catch (reviewErr) {
      // Reviewer indisponivel: continua com static checks apenas
      const reviewMsg = reviewErr instanceof Error ? reviewErr.message : String(reviewErr);
      options.emit?.("step", { step: "review_error", subtaskId: subtask.id, error: reviewMsg });
      await recordAgentCall({
        taskId: taskOid,
        subtaskId: subtask.id,
        agent: "reviewer",
        provider: reviewerRoute?.provider,
        model: reviewerRoute?.model,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        durationMs: Date.now() - reviewT0,
        success: false,
        error: reviewMsg.slice(0, 500)
      });
    }

    if (reviewResult?.usage) {
      cumulativeReview = addTokenUsage(cumulativeReview, toTokenUsage(reviewResult.usage));
    }

    // Merge: static comments + LLM comments
    const staticComments = staticResult?.comments ?? [];
    const llmComments = reviewResult?.comments ?? [];

    // 4c. UX Critic — agente autonomo com Playwright contra preview.
    // Roda 1x por subtask, no round que tiver frontend changes E preview disp.
    // Custo alto (browser + LLM tool-use loop) — por isso o gate restrito.
    let criticComments: ReviewComment[] = [];
    const hasFrontendChange = accumulatedChanges.some(c => FRONTEND_RE.test(c.file));
    // Gate adicional (#12 plan W4): stack sem UI -> skip critic (CLI/lib).
    // Mantemos roda quando primary=unknown pra nao ser muito agressivo.
    const stackBlocksCritic = detectedStack.primary !== "unknown" && !detectedStack.hasUI;
    if (stackBlocksCritic && !criticAlreadyRan && hasFrontendChange) {
      options.emit?.("step", {
        step: "ux_critic_skipped",
        subtaskId: subtask.id,
        round: round + 1,
        reason: `stack_no_ui (${detectedStack.primary})`
      });
      criticAlreadyRan = true;
    }
    if (!stackBlocksCritic && !criticAlreadyRan && hasFrontendChange) {
      try {
        // Reusa preview ativo OU dispara start (idempotente — retorna o ja-rodando)
        let preview = await getActivePreview(taskId);
        if (!preview) {
          const started = await startPreview(taskId);
          if (started.ok) preview = started.preview;
        }
        if (preview?.tunnelUrl && preview.status !== "failed") {
          options.emit?.("step", {
            step: "ux_critic_started",
            subtaskId: subtask.id,
            round: round + 1,
            previewUrl: preview.tunnelUrl
          });
          const criticRoute = await selectRoute("taskReviewer", { type: subtask.type, description: subtask.description, repo: repoKey }).catch(() => undefined);
          const criticT0 = Date.now();
          const critic = await criticizeUI({
            previewUrl: preview.tunnelUrl,
            taskDescription: subtask.description,
            changedFiles: accumulatedChanges.map(c => c.file),
            language,
            projectContextText: agentContextText
          });
          await recordAgentCall({
            taskId: taskOid,
            subtaskId: subtask.id,
            agent: "uxCritic",
            provider: criticRoute?.provider,
            model: criticRoute?.model,
            usage: critic.usage,
            durationMs: Date.now() - criticT0,
            success: !critic.skipped,
            error: critic.skipped ? critic.reason : undefined,
            output: { commentCount: critic.comments.length, iterations: critic.iterations }
          });
          if (critic.usage.totalTokens > 0) {
            cumulativeReview = addTokenUsage(cumulativeReview, critic.usage);
          }
          criticComments = critic.comments;
          options.emit?.("step", {
            step: "ux_critic_done",
            subtaskId: subtask.id,
            round: round + 1,
            skipped: critic.skipped,
            reason: critic.reason,
            commentCount: critic.comments.length,
            iterations: critic.iterations,
            errorCount: critic.comments.filter(c => c.severity === "error").length
          });
        } else {
          options.emit?.("step", {
            step: "ux_critic_skipped",
            subtaskId: subtask.id,
            round: round + 1,
            reason: preview ? `preview_${preview.status}` : "no_preview"
          });
        }
      } catch (criticErr) {
        const cm = criticErr instanceof Error ? criticErr.message : String(criticErr);
        options.emit?.("step", { step: "ux_critic_error", subtaskId: subtask.id, error: cm });
      }
      criticAlreadyRan = true;
    }

    // 4d. Runtime Verifier — smoke functional contra o preview (HTTP + shell).
    // Roda 1x por subtask github no round 0 quando ha preview ativo. Custo:
    // 1 LLM tool-use loop (3-5 chamadas tipico). Veredicto FAIL bloqueia
    // aprovacao com severity:"error"; PARTIAL vira warning; PASS silencioso.
    let verifierComments: ReviewComment[] = [];
    let verifierVerdict: RuntimeVerdict | "SKIPPED" = "SKIPPED";
    let verifierEvidence: RuntimeEvidence[] = [];
    if (!verifierAlreadyRan && round === 0) {
      try {
        let previewForVerify = await getActivePreview(taskId);
        if (!previewForVerify) {
          const started = await startPreview(taskId);
          if (started.ok) previewForVerify = started.preview;
        }
        if (previewForVerify?.tunnelUrl && previewForVerify.status !== "failed") {
          options.emit?.("step", {
            step: "runtime_verifier_start",
            subtaskId: subtask.id,
            round: round + 1,
            previewUrl: previewForVerify.tunnelUrl
          });
          const verifierRoute = await selectRoute("taskReviewer", {
            type: subtask.type,
            description: subtask.description,
            repo: repoKey
          }).catch(() => undefined);
          const verifierT0 = Date.now();
          const verifier = await verifyRuntime({
            previewUrl: previewForVerify.tunnelUrl,
            taskDescription: subtask.description,
            changedFiles: accumulatedChanges.map(c => c.file),
            worktreePath: entry.ws.worktreePath,
            language,
            projectContextText: agentContextText,
            stack: detectedStack
          });
          await recordAgentCall({
            taskId: taskOid,
            subtaskId: subtask.id,
            agent: "runtimeVerifier",
            provider: verifierRoute?.provider,
            model: verifierRoute?.model,
            usage: verifier.usage,
            durationMs: Date.now() - verifierT0,
            success: !verifier.skipped && verifier.verdict !== "FAIL",
            error: verifier.skipped ? verifier.reason : undefined,
            output: {
              verdict: verifier.verdict,
              evidenceCount: verifier.evidence.length,
              iterations: verifier.iterations
            }
          });
          if (verifier.usage.totalTokens > 0) {
            cumulativeReview = addTokenUsage(cumulativeReview, verifier.usage);
          }
          verifierComments = verifier.comments;
          verifierVerdict = verifier.skipped ? "SKIPPED" : verifier.verdict;
          verifierEvidence = verifier.evidence;
          runtimeVerdictFinal = verifierVerdict;
          runtimeEvidenceFinal = verifier.evidence;
          runtimeReasonFinal = verifier.reason;
          runtimeIterationsFinal = verifier.iterations;
          options.emit?.("step", {
            step: "runtime_verifier_done",
            subtaskId: subtask.id,
            round: round + 1,
            verdict: verifierVerdict,
            evidenceCount: verifier.evidence.length,
            iterations: verifier.iterations,
            skipped: verifier.skipped,
            reason: verifier.reason
          });
        } else {
          options.emit?.("step", {
            step: "runtime_verifier_skipped",
            subtaskId: subtask.id,
            round: round + 1,
            reason: previewForVerify ? `preview_${previewForVerify.status}` : "no_preview"
          });
        }
      } catch (vErr) {
        const vm = vErr instanceof Error ? vErr.message : String(vErr);
        options.emit?.("step", { step: "runtime_verifier_error", subtaskId: subtask.id, error: vm });
      }
      verifierAlreadyRan = true;
    }

    const secretComments = secretResult?.comments ?? [];
    const mergedComments = [...staticComments, ...llmComments, ...criticComments, ...verifierComments, ...secretComments];

    const errors = mergedComments.filter(c => c.severity === "error");
    const warnings = mergedComments.filter(c => c.severity === "warning");

    // Gating: static/LLM so bloqueiam aprovacao se tem severity:"error".
    // CRITIC e diferente — QUALQUER comment dele entra no gate, mesmo info.
    // Motivo: critic existe pra puxar melhoria visual, nao so caca-bug. Se ele
    // sugeriu polish, queremos que vire correction round (max 1 round extra
    // por causa de MAX_REVIEW_ROUNDS=2 + criticAlreadyRan flag).
    const blockingComments = [
      ...staticComments.filter(c => c.severity === "error"),
      ...llmComments.filter(c => c.severity === "error"),
      ...criticComments, // todos
      // Runtime verifier: FAIL (severity:error) bloqueia; PARTIAL (warning) NAO.
      ...verifierComments.filter(c => c.severity === "error"),
      // Secret scan: TODOS hits bloqueiam (zero tolerancia).
      ...secretComments
    ];

    options.emit?.("step", {
      step: "review_round",
      subtaskId: subtask.id,
      round: round + 1,
      approved: reviewResult?.approved ?? true,
      errorCount: errors.length,
      warningCount: warnings.length,
      staticErrors: staticComments.filter(c => c.severity === "error").length,
      llmErrors: llmComments.filter(c => c.severity === "error").length,
      criticErrors: criticComments.filter(c => c.severity === "error").length,
      criticWarnings: criticComments.filter(c => c.severity === "warning").length,
      criticInfos: criticComments.filter(c => c.severity === "info").length,
      runtimeVerdict: verifierVerdict,
      runtimeEvidence: verifierEvidence.length,
      blocking: blockingComments.length
    });

    // Aprovado = sem comment blocante de NENHUMA fonte. Critic conta TODOS.
    const llmOk = reviewResult ? reviewResult.approved : true;
    approved = llmOk && blockingComments.length === 0;

    if (approved) {
      options.emit?.("step", { step: "review_approved", subtaskId: subtask.id, round: round + 1 });
      break;
    }

    // Nao aprovado — verifica se ainda ha rounds disponiveis
    if (round + 1 >= MAX_REVIEW_ROUNDS) {
      options.emit?.("step", {
        step: "review_max_rounds_reached",
        subtaskId: subtask.id,
        errors: errors.map(c => `${c.file}: ${c.message}`)
      });
      break;
    }

    // Monta prompt corretivo com 3 blocos distintos: erros tecnicos (tsc/lint
    // + LLM errors), polish visual (critic — qualquer severity), e sugestao
    // geral do LLM reviewer. Agente deve aplicar TUDO.
    const technicalErrors = [
      ...staticComments.filter(c => c.severity === "error"),
      ...llmComments.filter(c => c.severity === "error")
    ];
    const technicalWarnings = [
      ...staticComments.filter(c => c.severity === "warning"),
      ...llmComments.filter(c => c.severity === "warning")
    ];
    const fmt = (c: typeof staticComments[number]) =>
      `- [${c.file}${c.line ? `:${c.line}` : ""}] ${c.message}`;

    const technicalErrorsBlock = technicalErrors.length > 0
      ? "Erros tecnicos bloqueantes:\n" + technicalErrors.map(fmt).join("\n")
      : "";
    const technicalWarningsBlock = technicalWarnings.length > 0
      ? "\nAvisos tecnicos:\n" + technicalWarnings.map(fmt).join("\n")
      : "";

    // Bloco de polish visual: critic comments separados por severity, todos
    // marcados como ACAO requerida (nao opcional).
    const criticErrors = criticComments.filter(c => c.severity === "error");
    const criticWarnings2 = criticComments.filter(c => c.severity === "warning");
    const criticInfos = criticComments.filter(c => c.severity === "info");
    const criticBlock = criticComments.length > 0
      ? [
        "\nMELHORIAS VISUAIS / UX (sugeridas pelo critic apos navegar a UI no browser):",
        criticErrors.length > 0 ? "Quebras visuais (corrigir obrigatoriamente):\n" + criticErrors.map(fmt).join("\n") : "",
        criticWarnings2.length > 0 ? "Polish importante (aplicar):\n" + criticWarnings2.map(fmt).join("\n") : "",
        criticInfos.length > 0 ? "Refinamentos (aplicar):\n" + criticInfos.map(fmt).join("\n") : ""
      ].filter(Boolean).join("\n")
      : "";

    const suggestionBlock = reviewResult?.suggestion ? `\nSugestao geral: ${reviewResult.suggestion}` : "";

    // Bloco secret scan (#13) — listar todos os hits, sao bloqueantes obrigatorios.
    const secretBlock = secretComments.length > 0
      ? "\n[SECRET SCAN] Credenciais detectadas — REMOVA antes de continuar:\n" +
        secretComments.map(c => `- [${c.file}${c.line ? `:${c.line}` : ""}] ${c.message}`).join("\n")
      : "";

    // Bloco runtime verifier: lista evidencia + veredicto. So entra quando ha
    // FAIL ou PARTIAL — PASS / SKIPPED nao precisa de correcao.
    const runtimeBlock = (verifierVerdict === "FAIL" || verifierVerdict === "PARTIAL") && verifierEvidence.length > 0
      ? [
        `\nRUNTIME VERIFIER veredicto=${verifierVerdict} (smoke contra preview):`,
        ...verifierEvidence.slice(0, 10).map(ev => `- [${ev.kind}] ${ev.summary}`),
        verifierVerdict === "FAIL"
          ? "Corrija o comportamento de runtime acima — sao falhas reais observadas no preview."
          : "Verificacao parcial — confirme manualmente os pontos acima."
      ].join("\n")
      : "";

    const reviewerFeedback = [
      "",
      `[REVIEWER FEEDBACK round=${round + 1}]`,
      "Verificacao automatica apontou os pontos abaixo na sua tentativa anterior. APLIQUE TODOS sem reverter o trabalho ja feito.",
      "",
      technicalErrorsBlock,
      technicalWarningsBlock,
      criticBlock,
      runtimeBlock,
      secretBlock,
      suggestionBlock,
      "",
      "INSTRUCAO: leia os arquivos mencionados, aplique as correcoes via Write/Edit/MultiEdit, e commit. Erros [tsc]/[lint] sao deterministicos (file:line exato). Sugestoes [ux-critic] sao do agente que navegou a UI no browser — implemente literalmente (cores, paddings, classes utility, labels especificos). Evidencias [runtime-verifier] sao bugs observados no preview deployado — corrija o caminho real."
    ].filter(s => s !== "").join("\n");

    const correctedDesc = subtask.description + reviewerFeedback;

    options.emit?.("step", {
      step: "review_correction_started",
      subtaskId: subtask.id,
      round: round + 1,
      errorCount: errors.length
    });

    try {
      const correctionResult = await runCode(correctedDesc);
      cumulativeCode = addTokenUsage(cumulativeCode, toTokenUsage(correctionResult.usage));

      // Filtra escape tambem no resultado da correcao
      const correctionEscapes = (correctionResult.changes ?? []).filter(c => isEscape(c.file));
      if (correctionEscapes.length > 0) {
        options.emit?.("step", { step: "agent_escape_detected", subtaskId: subtask.id, files: correctionEscapes.map(c => c.file) });
        // Mantem accumulatedChanges; aborta loop e segue com warning
        break;
      }
      const correctionChanges = correctionResult.changes ?? [];

      // Merge: dedup por file (ultima versao vence) + preserva ordem
      const byFile = new Map<string, import("../agents/code.js").CodeChange>();
      for (const c of accumulatedChanges) byFile.set(c.file, c);
      for (const c of correctionChanges) byFile.set(c.file, c);
      accumulatedChanges = Array.from(byFile.values());
      roundsUsed = round + 1;
    } catch (correctionErr) {
      // Falha durante correcao — nao throw, encerra loop com !approved
      const cm = correctionErr instanceof Error ? correctionErr.message : String(correctionErr);
      options.emit?.("step", { step: "review_correction_failed", subtaskId: subtask.id, round: round + 1, error: cm });
      if (/empty|EMPTY_STREAM|stream ended without result|truncated/i.test(cm)) {
        markProviderDown(route.grpcUrl, 60_000);
      }
      break;
    }
  }

  // Custo total da subtask = code (provider do route) + review (provider do
  // reviewerRoute do ultimo round). Aproximacao razoavel: agrega tudo no
  // provider do code. ByProvider ja foi $inc separadamente em recordAgentCall.
  const subtaskCostUsd =
    computeCost(route.provider as ProviderName, route.model, cumulativeCode);

  return {
    codeUsage: cumulativeCode,
    reviewUsage: cumulativeReview,
    changes: accumulatedChanges,
    reviewApproved: approved,
    reviewRounds: roundsUsed,
    provider: route.provider,
    model: route.model,
    costUsd: subtaskCostUsd,
    // Runtime verifier — alimenta SubTask.result.runtimeVerification pro UI.
    runtimeVerification: runtimeVerdictFinal === "SKIPPED" ? undefined : {
      verdict: runtimeVerdictFinal,
      evidence: runtimeEvidenceFinal,
      iterations: runtimeIterationsFinal,
      reason: runtimeReasonFinal
    }
  };
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

  const route = await selectRoute("taskCode", { type: subtask.type, description: subtask.description, preferProvider: options.execProvider });
  options.emit?.("step", { step: "route_selected", subtaskId: subtask.id, provider: route.provider, model: route.model, reason: route.reason });

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
    },
    route
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
