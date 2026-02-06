export type AskRequest = {
  question: string;
  chatId?: string;
  language?: "pt" | "en" | "es";
  schemaLanguage?: "pt" | "en" | "es";
  responseLanguage?: "pt" | "en" | "es";
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

export const sanitizeErrorMessage = (message: string): string => {
  const cleaned = message.replace(/password\s*=\s*[^;]+/gi, "password=***");
  return cleaned.length > 500 ? `${cleaned.slice(0, 500)}...` : cleaned;
};

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
