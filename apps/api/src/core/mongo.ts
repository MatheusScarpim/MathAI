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

export const getProcessingJobsCollection = async (): Promise<Collection<ProcessingJobRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<ProcessingJobRecord>("processing_jobs");
};

/* ── Task Orchestrator ──────────────────────────────────────────── */

export type TaskStatus = "pending" | "planning" | "executing" | "completed" | "failed" | "cancelled";
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
  githubPrUrls: string[];
  summary?: string;
  language: "pt" | "en" | "es";
  tokenUsage?: {
    planner?: { inputTokens: number; outputTokens: number; totalTokens: number };
    code?: { inputTokens: number; outputTokens: number; totalTokens: number };
    reviewer?: { inputTokens: number; outputTokens: number; totalTokens: number };
    reporter?: { inputTokens: number; outputTokens: number; totalTokens: number };
    total: { inputTokens: number; outputTokens: number; totalTokens: number };
  };
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  /** "owner/repo" → branch name. Uma branch por (task, repo). */
  branchByRepo?: Record<string, string>;
  /** Key da msg "🚀 Iniciando" enviada via WhatsApp — usada pra reagir nela em stage transitions. */
  whatsappStartMsgKey?: { id: string; remoteJid: string; fromMe: boolean };
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
  /** Inbox default — criado automaticamente, nao deletavel */
  isInbox?: boolean;
  /** Comando que builda o frontend em modo preview (com MSW ativado). Ex: "npm run build:preview". */
  previewBuildCmd?: string;
  /** Diretorio onde o agent deve criar handlers MSW novos. Ex: "frontend/src/mocks/preview". */
  previewMocksDir?: string;
  /** Diretorio do build output. Ex: "frontend/dist". Default detectado. */
  previewDistDir?: string;
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
