import type { AskErrorResponse } from "@auraia/shared";

const forbiddenKeywords = [
  "delete",
  "update",
  "insert",
  "merge",
  "drop",
  "truncate",
  "alter",
  "exec",
  "execute",
  "xp_"
];

const hasForbiddenKeyword = (sql: string): string | null => {
  const lower = sql.toLowerCase();
  for (const keyword of forbiddenKeywords) {
    const pattern = new RegExp(`\\b${keyword}\\b`, "i");
    if (pattern.test(lower)) return keyword;
  }
  return null;
};

const extractTop = (sql: string): number | null => {
  const match = sql.match(/top\s*\(\s*(\d+)\s*\)|top\s+(\d+)/i);
  const value = match?.[1] ?? match?.[2];
  return value ? Number.parseInt(value, 10) : null;
};

export const validateSql = (
  sql: string
): { ok: true } | { ok: false; error: AskErrorResponse } => {
  if (!sql.trim()) {
    return { ok: false, error: { errorMessage: "SQL vazio retornado pela IA." } };
  }

  const trimmed = sql.trim();
  if (!/^(with|select)\b/i.test(trimmed)) {
    return {
      ok: false,
      error: { sql, errorMessage: "A query precisa iniciar com SELECT ou WITH." }
    };
  }

  const forbidden = hasForbiddenKeyword(trimmed);
  if (forbidden) {
    return {
      ok: false,
      error: { sql, errorMessage: `Keyword proibida detectada: ${forbidden}.` }
    };
  }

  const semicolonIndex = trimmed.indexOf(";");
  if (semicolonIndex !== -1 && semicolonIndex < trimmed.length - 1) {
    return {
      ok: false,
      error: { sql, errorMessage: "Somente uma query eh permitida." }
    };
  }

  if (/select\s+\*/i.test(trimmed)) {
    return {
      ok: false,
      error: { sql, errorMessage: "SELECT * nao eh permitido." }
    };
  }

  const topValue = extractTop(trimmed);
  if (!topValue) {
    return {
      ok: false,
      error: { sql, errorMessage: "A query precisa ter TOP (100)." }
    };
  }

  if (topValue > 500) {
    return {
      ok: false,
      error: { sql, errorMessage: "TOP maior que 500 nao eh permitido." }
    };
  }

  return { ok: true };
};
