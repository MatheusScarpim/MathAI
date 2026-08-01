import { MongoClient, type Collection, type ObjectId } from "mongodb";
import { config } from "./config.js";
import type { AskErrorResponse, AskSuccessResponse, AppMode } from "@auraia/shared";

export type InstructionRecord = {
  _id?: ObjectId;
  text: string;
  tableFullName?: string; // null/undefined = global instruction
  createdAt: Date;
};

export type HistoryRecord = {
  _id?: ObjectId;
  environmentId?: string;
  chatId?: string;
  question: string;
  embeddingQuestion?: string;
  sql: string;
  httpRequest?: string;
  mode?: AppMode;
  rows?: Record<string, unknown>[];
  columns?: string[];
  chart?: {
    type: "bar" | "line";
    data: Array<{ category: string | number; value: number | null }>;
    title?: string;
    xKey?: string;
    yKey?: string;
  };
  summary?: string;
  language?: "pt" | "en" | "es";
  responseLanguage?: "pt" | "en" | "es";
  createdAt: Date;
  deletedAt?: Date;
  favorite: boolean;
  tags: string[];
  success?: boolean;
  errorMessage?: string;
  elapsedMs?: number;
  rowCount?: number;
  embedding?: number[];
  tokenUsage?: {
    planner?: { inputTokens: number; outputTokens: number; totalTokens: number };
    sqlMini?: { inputTokens: number; outputTokens: number; totalTokens: number };
    sqlLarge?: { inputTokens: number; outputTokens: number; totalTokens: number };
    summary?: { inputTokens: number; outputTokens: number; totalTokens: number };
    total: { inputTokens: number; outputTokens: number; totalTokens: number };
  };
};

export type SettingRecord = {
  _id?: ObjectId;
  key: string;
  value: unknown;
  updatedAt: Date;
};

export type ProcessingJobRecord = {
  _id?: ObjectId;
  status: "processing" | "completed" | "failed";
  question: string;
  chatId?: string;
  webhookUrl?: string;
  language: "pt" | "en" | "es";
  schemaLanguage: "pt" | "en" | "es";
  responseLanguage: "pt" | "en" | "es";
  result?: AskSuccessResponse;
  error?: AskErrorResponse;
  webhookNotifiedAt?: Date;
  webhookError?: string;
  createdAt: Date;
  updatedAt: Date;
};

let client: MongoClient | null = null;

export const getMongoClient = async (): Promise<MongoClient> => {
  if (client) return client;
  client = new MongoClient(config.mongo.url, {
    serverSelectionTimeoutMS: 5000
  });
  await client.connect();
  return client;
};

export const getInstructionsCollection = async (): Promise<
  Collection<InstructionRecord>
> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<InstructionRecord>("instructions");
};

export const getHistoryCollection = async (): Promise<Collection<HistoryRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<HistoryRecord>("history");
};

export const getSettingsCollection = async (): Promise<Collection<SettingRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<SettingRecord>("settings");
};

export type ProjectLessonRecord = {
  _id?: ObjectId;
  /** Identificador estavel (ex: hash do title) — usado como Qdrant point id. */
  lessonId: string;
  /** Titulo curto da licao. */
  title: string;
  /** Corpo da licao em markdown. */
  body: string;
  /** Tags livres (ex: "whatsapp", "playwright"). Opcional. */
  tags?: string[];
  /** Escopo: "global" (qualquer projeto) ou repoKey "owner/repo" especifico. */
  repoKey?: string;
  /** Embedding em cache pra evitar re-embed. */
  embedding?: number[];
  /** Modelo do embedding (invalida cache quando muda). */
  embeddingModel?: string;
  createdAt: Date;
  updatedAt: Date;
};

export const getProjectLessonsCollection = async (): Promise<Collection<ProjectLessonRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<ProjectLessonRecord>("project_lessons");
};

/* ── Project Decisions (#4 plan W4) ───────────────────────────────
 * Decisoes arquiteturais persistentes por repo. Alimentadas por inferencia
 * (package.json/stack) ou registro manual. Injetadas no planner system prompt.
 */
export type ProjectDecisionRecord = {
  _id?: ObjectId;
  /** "owner/repo" — chave de escopo. */
  repoKey: string;
  /** Categoria semantica (ex: "auth", "state-mgmt", "test-runner", "style", "primary-language"). */
  key: string;
  /** Valor humano-legivel (ex: "session-cookie", "pinia", "vitest", "tailwind"). */
  value: string;
  /** "inferred" (auto-deteccao), "manual" (registrado pelo user/agent). */
  source: "inferred" | "manual";
  /** 0-1, util pra ordenar exibicao quando varias decisoes competem. */
  confidence?: number;
  updatedAt: Date;
};

export const getProjectDecisionsCollection = async (): Promise<Collection<ProjectDecisionRecord>> => {
  const mongo = await getMongoClient();
  const col = mongo.db(config.mongo.db).collection<ProjectDecisionRecord>("project_decisions");
  // Unico por (repoKey, key) — upserts substituem decisao previa
  await col.createIndex({ repoKey: 1, key: 1 }, { unique: true }).catch(() => {});
  return col;
};

/* ── Trello webhook events (#14 plan W5) ────────────────────────── */

export type TrelloWebhookEventRecord = {
  _id?: ObjectId;
  /** Tipo do action (ex: "updateCard", "commentCard", "addLabelToCard"). */
  actionType: string;
  cardId: string;
  /** TaskId se conseguiu correlacionar; senao undefined. */
  taskId?: string;
  /** Payload bruto (truncado pra evitar explosao de tamanho). */
  raw?: unknown;
  /** Acao aplicada ao TaskRecord ("cancelled" / "comment_added" / "priority_set" / "subtask_done" / "noop"). */
  appliedAction: string;
  /** TTL — 30d. */
  receivedAt: Date;
};

export const getTrelloWebhookEventsCollection = async (): Promise<Collection<TrelloWebhookEventRecord>> => {
  const mongo = await getMongoClient();
  const col = mongo.db(config.mongo.db).collection<TrelloWebhookEventRecord>("trello_webhook_events");
  // TTL 30d
  await col.createIndex({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }).catch(() => {});
  await col.createIndex({ cardId: 1 }).catch(() => {});
  return col;
};

export const getProcessingJobsCollection = async (): Promise<Collection<ProcessingJobRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<ProcessingJobRecord>("processing_jobs");
};

/* ── Task Orchestrator ──────────────────────────────────────────── */

export type TaskStatus = "pending" | "planning" | "awaiting_approval" | "executing" | "completed" | "failed" | "cancelled";
export type TaskStage = "planning" | "coding" | "reviewing" | "reporting" | "done";
export type SubTaskType = "trello" | "github" | "api" | "custom";

export type SubTask = {
  id: string;
  type: SubTaskType;
  description: string;
  status: TaskStatus;
  priority: number;
  dependsOn: string[];
  repo?: string;
  result?: unknown;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  retryCount?: number;
  maxRetries?: number;
  /** Branch resolvida pelo pipeline (uma por task, compartilhada por todas as github subtasks do mesmo repo) */
  resolvedBranch?: string;
  /** "owner/repo" — preenchido pelo pipeline antes de executar github subtasks */
  resolvedRepoKey?: string;
  // ── Telemetria (#3 plan W1) ──
  provider?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
  // ── Replan-on-failure (#1 plan W2) ──
  fromReplan?: boolean;
  attemptHistory?: Array<{
    round: number;
    provider?: string;
    model?: string;
    errorSummary?: string;
    emptyStream?: boolean;
    runtimeVerdict?: "PASS" | "FAIL" | "PARTIAL";
    timestamp: Date;
  }>;
};

export type TaskRecord = {
  _id?: ObjectId;
  userId?: string;
  description: string;
  status: TaskStatus;
  /** Estagio atual do pipeline (planner/code/review/report/done). Persistido pra UI exibir progresso ao vivo. */
  currentStage?: TaskStage;
  /** ID (string) do projeto ao qual esta task pertence. Inbox para legados. */
  projectId?: string;
  subtasks: SubTask[];
  trelloCardIds: string[];
  /** Cards criados pelo agente Trello (subconjunto de trelloCardIds). Usado pro teto por-task. */
  trelloAgentCardIds?: string[];
  githubPrUrls: string[];
  summary?: string;
  language: "pt" | "en" | "es";
  tokenUsage?: {
    planner?: { inputTokens: number; outputTokens: number; totalTokens: number };
    code?: { inputTokens: number; outputTokens: number; totalTokens: number };
    reviewer?: { inputTokens: number; outputTokens: number; totalTokens: number };
    reporter?: { inputTokens: number; outputTokens: number; totalTokens: number };
    total: { inputTokens: number; outputTokens: number; totalTokens: number };
    /** Breakdown por provider — preenchido pelo recordAgentCall ($inc atomico). */
    byProvider?: Record<string, { tokensIn: number; tokensOut: number; costUsd: number }>;
  };
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  /** "owner/repo" → branch name. Uma branch por (task, repo). */
  branchByRepo?: Record<string, string>;
  /** Key da msg "🚀 Iniciando" enviada via WhatsApp — usada pra reagir nela em stage transitions. */
  whatsappStartMsgKey?: { id: string; remoteJid: string; fromMe: boolean };
  /** Quantos replans ja foram disparados pra esta task. Hard cap = 1. */
  replanCount?: number;
  /** Atualizado a cada stage transition pelo pipeline. Boot scan usa pra detectar orfaos. */
  heartbeatAt?: Date;
  /** Prioridade no queue (#7). */
  priority?: "low" | "normal" | "high";
  /** Comments externos (ex: vindos de Trello webhook — #14). */
  comments?: Array<{
    source: "trello" | "manual";
    text: string;
    author?: string;
    at: Date;
  }>;
  /** Quando status=="awaiting_approval", contem o plano gerado aguardando approve/reject. */
  pendingPlanApproval?: {
    subtasks: Array<{
      id: string;
      type: "trello" | "github" | "api" | "custom";
      description: string;
      priority: number;
      dependsOn: string[];
      repo?: string;
    }>;
    /** Trigger que disparou o gate: "manual" (flag explicita), "subtask_count" (>N), "estimated_cost". */
    reason: "manual" | "subtask_count" | "estimated_cost";
    /** Detalhe pra UI explicar (ex: "8 subtasks > 5 threshold"). */
    detail?: string;
    /** TTL — apos isto o gate expira e a task vira cancelled (gate-timeout). */
    expiresAt: Date;
    createdAt: Date;
  };
};

export type TaskExecutionRecord = {
  _id?: ObjectId;
  taskId: ObjectId;
  subtaskId: string;
  agent: string;
  input: unknown;
  output: unknown;
  success: boolean;
  error?: string;
  tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  elapsedMs: number;
  createdAt: Date;
  // ── Telemetria (#3 plan W1) ──
  provider?: string;
  model?: string;
  costUsd?: number;
  /** Set por rollback (#9/G4) — alimenta reverted_rate em /api/metrics. */
  reverted?: boolean;
};

export const getTasksCollection = async (): Promise<Collection<TaskRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<TaskRecord>("tasks");
};

export const getTaskExecutionsCollection = async (): Promise<Collection<TaskExecutionRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<TaskExecutionRecord>("task_executions");
};

// ============== Github Repos (entidades persistidas) ==============

export type GithubRepoRecord = {
  _id?: ObjectId;
  userId?: string;
  name: string;            // apelido (default = repo)
  owner: string;
  repo: string;
  baseBranch?: string;
  encryptedToken: string;  // hex
  iv: string;              // hex
  createdAt: Date;
  updatedAt: Date;
};

export const getGithubReposCollection = async (): Promise<Collection<GithubRepoRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<GithubRepoRecord>("github_repos");
};

// ============== Projects (agrupador de tasks com 1+ repos) ==============

export type ProjectRecord = {
  _id?: ObjectId;
  userId?: string;
  name: string;
  description?: string;
  /** IDs (string) de github_repos vinculados ao projeto */
  repoIds: string[];
  /** Override do board do Trello pra tasks deste projeto (substitui o padrao global) */
  trelloBoardId?: string;
  /** Override da lista (coluna) padrao pra tasks deste projeto */
  trelloListId?: string;
  /** Override da lista (coluna) "done" pra onde os cards sao movidos no fim da task */
  trelloDoneListId?: string;
  /** Liga o agente Trello (LLM move/comenta/label o card a cada stage). Default (undefined) = ligado quando board configurado. */
  trelloAgentEnabled?: boolean;
  /** Permite o agente Trello CRIAR novos cards no board. Default (undefined/false) = desligado (evita flood). */
  trelloAgentCreateCards?: boolean;
  /** Inbox default — criado automaticamente, nao deletavel */
  isInbox?: boolean;
  /** Comando que builda o frontend em modo preview (com MSW ativado). Ex: "npm run build:preview". */
  previewBuildCmd?: string;
  /** Diretorio onde o agent deve criar handlers MSW novos. Ex: "frontend/src/mocks/preview". */
  previewMocksDir?: string;
  /** Diretorio do build output. Ex: "frontend/dist". Default detectado. */
  previewDistDir?: string;
  /**
   * Liga/desliga a injecao automatica do scaffold MSW no worktree efemero do
   * preview. Default (undefined) = ligado. Setar `false` faz o preview buildar
   * o app SEM mock — bate no backend real (ou quebra se nao houver). Util quando
   * a app ja tem seus proprios mocks ou aponta pra um backend de staging.
   */
  previewUseMsw?: boolean;
  /** Stack detectada do repositorio primario (#12 plan W4). Atualizado on-demand. */
  stack?: {
    primary: "node" | "python" | "go" | "rust" | "unknown";
    frameworks: string[];
    hasUI: boolean;
    detectedAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
};

export const getProjectsCollection = async (): Promise<Collection<ProjectRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<ProjectRecord>("projects");
};

// ============== Preview deploys ==============

/**
 * Preview efemero de uma task. Spawneia `npm install` + previewBuildCmd + serve estatico
 * + cloudflared tunnel. TTL 30min por padrao — Mongo apaga doc, previewCleanup mata processos.
 */
export type PreviewRecord = {
  _id?: ObjectId;
  taskId: string;
  userId?: string;
  /** Porta local onde o `serve` ta escutando (range 5200-5299). */
  port: number;
  /** URL publica gerada pelo cloudflared quick-tunnel. */
  tunnelUrl: string;
  /** PIDs (dentro do container) — usados por previewCleanup pra SIGTERM. */
  servePid?: number;
  tunnelPid?: number;
  status: "starting" | "ready" | "stopped" | "failed";
  errorMessage?: string;
  /** Path absoluto do worktree usado. */
  worktreePath: string;
  startedAt: Date;
  /** TTL: Mongo deleta o doc neste horario. */
  expiresAt: Date;
};

export const getPreviewsCollection = async (): Promise<Collection<PreviewRecord>> => {
  const mongo = await getMongoClient();
  const col = mongo.db(config.mongo.db).collection<PreviewRecord>("previews");
  // TTL — Mongo apaga doc apos expiresAt. previewCleanup mata processos antes.
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
  // Unico parcial: 1 preview ativo (starting|ready) por task.
  await col.createIndex(
    { taskId: 1 },
    {
      unique: true,
      partialFilterExpression: { status: { $in: ["starting", "ready"] } }
    }
  ).catch(() => {});
  return col;
};

// ============== Bot transports (Telegram / WhatsApp) ==============

/** Vinculo entre um chat externo (Telegram / WhatsApp JID) e um user MathAI. */
export type ChatBindingRecord = {
  _id?: ObjectId;
  userId?: string;
  transport: "telegram" | "whatsapp";
  /** Chat identifier no transport. Telegram: numerico stringificado. WhatsApp: JID "5511...@s.whatsapp.net". */
  chatId: string;
  /** Display: @handle no Telegram ou nome do contato no WhatsApp. */
  displayName?: string;
  /** Token de pareamento ainda nao usado. Removido apos !start. */
  bindToken?: string;
  bindTokenExpiresAt?: Date;
  /** Projeto default pra comandos sem flag explicita. */
  defaultProjectId?: string;
  /**
   * Quando true (default), `!task` mostra o plano e espera aprovacao antes de executar.
   * Quando false, executa direto sem confirmacao.
   */
  requirePlanApproval?: boolean;
  /** True quando o chat e um grupo WhatsApp (`chatId` termina em @g.us). */
  isGroup?: boolean;
  /** Nome/assunto do grupo (cache pra exibir na UI). */
  groupSubject?: string;
  /**
   * JIDs com controle total no grupo: gerenciam permissoes e rodam qualquer comando.
   * Semeado com quem parear o grupo (!start). So relevante quando isGroup.
   */
  admins?: string[];
  /**
   * Allow-list de JIDs por comando (ex: { task: ["55...@..."], ask: [...] }).
   * Em grupos, um comando e permitido se sender ∈ admins OU sender ∈ commandPermissions[cmd].
   * Comando sem entrada = so admin. Ignorado em chat privado.
   */
  commandPermissions?: Record<string, string[]>;
  /** Última vez que o watchdog de ociosidade perguntou algo neste chat (cooldown anti-spam). */
  lastIdleNudgeAt?: Date;
  /** Quando false, desliga o nudge de ociosidade neste chat. Default true. */
  idleNudgeEnabled?: boolean;
  /** Sugestoes numeradas enviadas no ultimo idle-nudge (cards + ideias). Respondidas por numero. */
  idleSuggestions?: Array<{ n: number; kind: "card" | "idea"; description: string }>;
  active: boolean;
  createdAt: Date;
};

export const getChatBindingsCollection = async (): Promise<Collection<ChatBindingRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<ChatBindingRecord>("chat_bindings");
};

/**
 * Plano de uma task aguardando aprovacao do usuario. TTL de 10min — Mongo apaga sozinho.
 * Resolvido + filtrado: contem subtasks finais e config de github/trello ja resolvida,
 * pra que a aprovacao dispare execucao sem replanejar (skip planner via presetSubtasks).
 */
export type PendingPlanRecord = {
  _id?: ObjectId;
  jid: string;                  // chat (chatId WhatsApp) onde aprovacao acontece
  userId?: string;
  transport: "whatsapp" | "telegram";
  description: string;          // descricao original
  language: "pt" | "en" | "es";
  projectId?: string;
  /** Subtasks ja planejadas e filtradas — formato pronto pra pipeline (sem maxRetries/status). */
  plannedSubtasks: Array<{
    id: string;
    type: "trello" | "github" | "api" | "custom";
    description: string;
    priority: number;
    dependsOn: string[];
    repo?: string;
  }>;
  /** Github resolvido (com tokens) — usado se aprovado, evita re-resolver. */
  resolvedGithub?: Array<{
    name: string;
    owner: string;
    repo: string;
    token?: string;
    baseBranch?: string;
  }>;
  /** Trello resolvido. */
  resolvedTrello?: { boardId: string; listId?: string; doneListId?: string };
  /** Provider preferido pra execucao (ex: "anthropic" pra tasks do idle-nudge). Sobrevive ao gate de aprovacao. */
  execProvider?: "anthropic" | "codex" | "deepseek";
  createdAt: Date;
  /** TTL: Mongo deleta documento neste horario. */
  expiresAt: Date;
};

export const getPendingPlansCollection = async (): Promise<Collection<PendingPlanRecord>> => {
  const mongo = await getMongoClient();
  const col = mongo.db(config.mongo.db).collection<PendingPlanRecord>("pending_plans");
  // Garante TTL index (idempotente — se ja existe, no-op).
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
  return col;
};

/** Estado de autenticacao do socket WhatsApp. Singleton — uma linha so com _id fixo "creds". */
export type WhatsappAuthCredsRecord = {
  _id: "creds";
  /** Buffer encriptado do AuthenticationCreds (Baileys). */
  encrypted: Buffer;
  iv: string;
  phoneNumber?: string;
  pairedAt?: Date;
  lastConnectedAt?: Date;
  status: "unpaired" | "paired" | "logged_out";
  updatedAt: Date;
};

/** Chaves auxiliares de Signal Protocol guardadas pelo Baileys. _id composto type:id. */
export type WhatsappAuthKeyRecord = {
  _id: string;          // ex: "session:5511...@s.whatsapp.net"
  type: string;
  id: string;
  encrypted: Buffer;
  iv: string;
  updatedAt: Date;
};

export const getWhatsappAuthCredsCollection = async (): Promise<Collection<WhatsappAuthCredsRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<WhatsappAuthCredsRecord>("whatsapp_auth_creds");
};

export const getWhatsappAuthKeysCollection = async (): Promise<Collection<WhatsappAuthKeyRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<WhatsappAuthKeyRecord>("whatsapp_auth_keys");
};

// ============== Scheduler (tarefas e jobs recorrentes) ==============

/** Tipo de coisa agendada. Cada kind tem um dispatcher diferente. */
export type ScheduledKind = "task" | "ideas";

export type ScheduledRecord = {
  _id?: ObjectId;
  userId?: string;
  /** Display: "smoke test diario" — usado tambem como task description quando kind=task. */
  description: string;
  kind: ScheduledKind;
  /** projectId pra resolver repos+Trello (so usado quando kind=task). */
  projectId?: string;
  /** Cron expression padrao (5 campos: M H DoM Mon DoW). */
  cron: string;
  /** Default: "America/Sao_Paulo" — usado pra calcular nextRunAt. */
  timezone?: string;
  /** Chat WhatsApp pra notificar (jid). Se null, dispara silencioso. */
  whatsappJid?: string;
  enabled: boolean;
  /** Proximo horario calculado a partir do cron — usado pelo tick pra detectar due. */
  nextRunAt?: Date;
  lastFiredAt?: Date;
  lastFireResult?: "ok" | "failed" | "skipped";
  /** TaskId da ultima execucao (quando kind=task). */
  lastFireTaskId?: string;
  /** Lock leve pra evitar double-fire entre replicas. Setado durante tick, removido apos. */
  lockedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export const getScheduledCollection = async (): Promise<Collection<ScheduledRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<ScheduledRecord>("scheduled");
};

// ============== Ideas agent (dedup + entrega pendente) ==============

/**
 * Fingerprint de uma ideia ja sugerida — usado pra nao repetir a mesma
 * sugestao todo fim de semana. TTL de 14d (apos isso a ideia pode reaparecer).
 */
export type IdeaSuggestionRecord = {
  _id?: ObjectId;
  /** `null` = escopo global (ex. schedule autonomo sem userId). Sentinela estavel. */
  userId?: string | null;
  /** Hash estavel de (category + suggestion normalizada). */
  fingerprint: string;
  category: string;
  suggestion: string;
  /** TTL — Mongo apaga 14d apos a ultima vez que foi sugerida. */
  lastSuggestedAt: Date;
};

export const getIdeaSuggestionsCollection = async (): Promise<Collection<IdeaSuggestionRecord>> => {
  const mongo = await getMongoClient();
  const col = mongo.db(config.mongo.db).collection<IdeaSuggestionRecord>("idea_suggestions");
  // Snooze de 14d — apos isso o doc some e a ideia pode reaparecer.
  await col.createIndex({ lastSuggestedAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 }).catch(() => {});
  await col.createIndex({ userId: 1, fingerprint: 1 }).catch(() => {});
  return col;
};

/**
 * Entrega de ideias que nao pode ser enviada na hora (WhatsApp offline).
 * Reenviada no reconnect / proximo boot. TTL de 7d pra nao acumular lixo.
 */
export type IdeaDeliveryRecord = {
  _id?: ObjectId;
  whatsappJid: string;
  userId?: string;
  /** Mensagem ja formatada, pronta pra sendText. */
  text: string;
  status: "pending" | "sent";
  attempts?: number;
  createdAt: Date;
  sentAt?: Date;
};

export const getIdeaDeliveriesCollection = async (): Promise<Collection<IdeaDeliveryRecord>> => {
  const mongo = await getMongoClient();
  const col = mongo.db(config.mongo.db).collection<IdeaDeliveryRecord>("idea_deliveries");
  await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 }).catch(() => {});
  await col.createIndex({ status: 1 }).catch(() => {});
  return col;
};
