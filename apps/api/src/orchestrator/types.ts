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
  trello?: { boardId?: string; listId?: string; doneListId?: string };
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
  emit?: StepEmitter;
};
