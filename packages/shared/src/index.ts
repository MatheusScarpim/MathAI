/* ── Mode & Auth ─────────────────────────────────────────── */

export type AppMode = "database" | "api";

export type ApiAuthType = "none" | "bearer" | "apikey" | "basic";

export type ApiAuthConfig = {
  type: ApiAuthType;
  token?: string;
  apiKeyHeader?: string;
  apiKeyValue?: string;
  username?: string;
  password?: string;
};

/* ── Endpoint types (API mode) ───────────────────────────── */

export type EndpointParameter = {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required: boolean;
  type: string;
  description?: string;
};

export type EndpointChunk = {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary?: string;
  description?: string;
  parameters: EndpointParameter[];
  requestBodySchema?: string;
  responseSchema?: string;
  tags: string[];
};

export type HttpRequestStep = {
  stepIndex: number;
  method: string;
  url: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  body?: unknown;
  description: string;
  dependsOn?: number;
  extractFrom?: string;
};

export type HttpRequestPlan = {
  steps: HttpRequestStep[];
};

/* ── HTTP Agent config ───────────────────────────────────── */

export type HttpAgentConfig = AgentConfig & {
  maxRetries: number;
};

/* ── Ask ─────────────────────────────────────────────────── */

export type AskRequest = {
  question: string;
  chatId?: string;
  language?: "pt" | "en" | "es";
  schemaLanguage?: "pt" | "en" | "es";
  responseLanguage?: "pt" | "en" | "es";
  async?: boolean;
  webhookUrl?: string;
};

export type AskSuccessResponse = {
  sql: string;
  rows: Record<string, unknown>[];
  columns: string[];
  elapsedMs: number;
  chatId?: string;
  historyId?: string;
  summary?: string;
  translatedQuestion?: string;
  cacheHit?: boolean;
  responseLanguage?: "pt" | "en" | "es";
  mode?: AppMode;
  httpRequest?: string;
  chart?: {
    type: "bar" | "line";
    data: Array<{
      category: string | number;
      value: number | null;
    }>;
    title?: string;
    xKey?: string;
    yKey?: string;
  };
  tokenUsage?: {
    sql: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    summary?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    total: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
  };
};

export type HistoryItem = {
  id: string;
  chatId?: string;
  question: string;
  sql: string;
  httpRequest?: string;
  mode?: AppMode;
  summary?: string;
  createdAt: string;
  favorite: boolean;
  tags: string[];
  language?: "pt" | "en" | "es";
  responseLanguage?: "pt" | "en" | "es";
  success?: boolean;
  errorMessage?: string;
  elapsedMs?: number;
  rowCount?: number;
};

export type HistoryUpdateRequest = {
  favorite?: boolean;
  tags?: string[];
};

export type AskErrorResponse = {
  sql?: string;
  errorMessage: string;
  hint?: string;
};

export type AskQueuedResponse = {
  processingId: string;
  status: "processing";
};

export type AskProcessingResponse =
  | {
      processingId: string;
      status: "processing";
    }
  | {
      processingId: string;
      status: "completed";
      data: AskSuccessResponse;
    }
  | {
      processingId: string;
      status: "failed";
      error: AskErrorResponse;
    };

export type IngestResponse = {
  tablesIndexed: number;
};

export type InstructionRequest = {
  text: string;
};

export type InstructionResponse = {
  id: string;
  text: string;
  createdAt: string;
};

export type ColumnInfo = {
  name: string;
  type: string;
};

export type ForeignKeyInfo = {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
};

export type TableChunk = {
  tableFullName: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  tags: string[];
};

export type AgentConfig = {
  model: string;
  temperature?: number;
  enabled?: boolean;
};

export type SqlAgentConfig = AgentConfig & {
  modelMini: string;
  maxRetries: number;
};

export type EmbeddingAgentConfig = {
  model: string;
};

export type AgentsConfig = {
  sql: SqlAgentConfig;
  http: HttpAgentConfig;
  summary: AgentConfig;
  translation: AgentConfig;
  chart: AgentConfig;
  embedding: EmbeddingAgentConfig;
  planner?: AgentConfig;
};

export const sanitizeErrorMessage = (message: string): string => {
  const cleaned = message.replace(/password\s*=\s*[^;]+/gi, "password=***");
  return cleaned.length > 500 ? `${cleaned.slice(0, 500)}...` : cleaned;
};

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
