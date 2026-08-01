// ============== Step Emitter ==============

export type StepEmitter = (event: string, data: unknown) => void;

// ============== Token Usage ==============

export type TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export const toTokenUsage = (usage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): TokenUsage => ({
  inputTokens: usage?.prompt_tokens ?? 0,
  outputTokens: usage?.completion_tokens ?? 0,
  totalTokens: usage?.total_tokens ?? 0
});

export const addTokenUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  totalTokens: a.totalTokens + b.totalTokens
});

// ============== Tasks ==============

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
  retryCount?: number;
  maxRetries?: number;
  result?: unknown;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  /** Branch resolvida pelo pipeline (uma por task, compartilhada por todas as github subtasks do mesmo repo) */
  resolvedBranch?: string;
  /** "owner/repo" — preenchido pelo pipeline antes de executar github subtasks */
  resolvedRepoKey?: string;
  // ── Telemetria (#3 plan W1) ──
  /** Provider LLM usado na ultima invocacao do code agent desta subtask. */
  provider?: string;
  /** Model name correspondente ao provider. */
  model?: string;
  /** Soma de input tokens ao longo de todos os rounds desta subtask. */
  tokensIn?: number;
  /** Soma de output tokens. */
  tokensOut?: number;
  /** Custo USD acumulado (inclui rounds de review e correcao). */
  costUsd?: number;
  /** Wall-clock total desta subtask (startedAt → completedAt). */
  durationMs?: number;
  // ── Replan-on-failure (#1 plan W2) ──
  /** Subtask veio de um replan? Util pra badge "REPLAN" na UI. */
  fromReplan?: boolean;
  /** Historico de tentativas — preenchido a cada round/retry pelo pipeline. */
  attemptHistory?: Array<{
    round: number;
    provider?: string;
    model?: string;
    errorSummary?: string;
    emptyStream?: boolean;
    /** Veredicto do runtime verifier desta tentativa (se rodou). */
    runtimeVerdict?: "PASS" | "FAIL" | "PARTIAL";
    timestamp: Date;
  }>;
};

export type TaskRecord = {
  _id?: unknown;
  userId?: string;
  description: string;
  status: TaskStatus;
  /** Estagio atual do pipeline (planner/code/review/report/done). */
  currentStage?: TaskStage;
  subtasks: SubTask[];
  trelloCardIds: string[];
  githubPrUrls: string[];
  summary?: string;
  language: "pt" | "en" | "es";
  tokenUsage?: {
    planner?: TokenUsage;
    code?: TokenUsage;
    reviewer?: TokenUsage;
    reporter?: TokenUsage;
    total: TokenUsage;
    /** Breakdown por provider — alimentado pelo recordAgentCall ($inc atomico). */
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
      type: SubTaskType;
      description: string;
      priority: number;
      dependsOn: string[];
      repo?: string;
    }>;
    reason: "manual" | "subtask_count" | "estimated_cost";
    detail?: string;
    expiresAt: Date;
    createdAt: Date;
  };
};

export type TaskExecutionRecord = {
  _id?: unknown;
  taskId: unknown;
  subtaskId: string;
  agent: string;
  input: unknown;
  output: unknown;
  success: boolean;
  error?: string;
  tokenUsage?: TokenUsage;
  elapsedMs: number;
  createdAt: Date;
  // ── Telemetria (#3 plan W1) ──
  provider?: string;
  model?: string;
  costUsd?: number;
  /** Set por rollback (#9/G4) — alimenta reverted_rate em /api/metrics. */
  reverted?: boolean;
};

export type TaskResult = {
  ok: boolean;
  taskId: string;
  status: TaskStatus;
  summary?: string;
  trelloCardIds: string[];
  githubPrUrls: string[];
  report?: string;
  tokenUsage: {
    planner?: TokenUsage;
    code?: TokenUsage;
    reviewer?: TokenUsage;
    reporter?: TokenUsage;
    total: TokenUsage;
    byProvider?: Record<string, { tokensIn: number; tokensOut: number; costUsd: number }>;
  };
};

export type GithubRepoConfig = {
  name: string;
  owner: string;
  repo: string;
  token?: string;
  baseBranch?: string;
};

export type TaskExecuteOptions = {
  userId?: string;
  /** ID (string) do projeto ao qual a task pertence (ja resolvido pra Inbox se nao fornecido) */
  projectId?: string;
  language?: "pt" | "en" | "es";
  github?: GithubRepoConfig | GithubRepoConfig[];
  trello?: {
    boardId?: string;
    listId?: string;
    doneListId?: string;
    /** Liga o agente Trello (LLM decide mover/comentar/label a cada stage). Default (undefined) = ligado quando Trello configurado. */
    agentEnabled?: boolean;
    /** Permite o agente criar novos cards. Default (undefined/false) = desligado. */
    agentCreateCards?: boolean;
  };
  /** Se setado, o pipeline notifica este chat WhatsApp ao iniciar e finalizar. */
  whatsapp?: { jid: string };
  /** Se setado, code agent recebe instrucao pra gerar handlers MSW alem do codigo. */
  previewMocksDir?: string;
  /**
   * Marca a task como "setup de MSW" pra um projeto. Quando setado:
   *  - pipeline injeta um prompt de bootstrap MSW
   *  - ao fim (sucesso), atualiza ProjectRecord com previewBuildCmd/Dir convencionais
   */
  setupPreviewForProjectId?: string;
  /** Forca gate de aprovacao manual (plano vira awaiting_approval mesmo se subtaskCount <= threshold). */
  requiresPlanApproval?: boolean;
  /** Prioridade no queue de concorrencia (#7). Default normal. High pula a fila. */
  priority?: "low" | "normal" | "high";
  /**
   * Se fornecido, pipeline pula o planner e usa essas subtasks diretamente.
   * Caso de uso: gate de aprovacao no bot — planeja, user aprova, executa.
   */
  presetSubtasks?: Array<{
    id: string;
    type: SubTaskType;
    description: string;
    priority: number;
    dependsOn: string[];
    repo?: string;
  }>;
  /**
   * G6 — quando setado, executeTask reusa este doc Mongo em vez de criar
   * outro. Caso de uso: approve-plan — task ja existe em awaiting_approval,
   * queremos continuar no mesmo _id pra nao duplicar UI/metricas. ObjectId
   * string. Doc deve existir.
   */
  existingTaskId?: string;
  /**
   * Se setado, o code agent (taskCode) prefere rodar neste provider (via RouteContext.preferProvider).
   * Caso de uso: tasks disparadas pelo idle-nudge devem executar no claude ("anthropic").
   * Nao afeta tasks normais (roteamento por rules).
   */
  execProvider?: import("./routing/types.js").ProviderName;
  emit?: StepEmitter;
};
