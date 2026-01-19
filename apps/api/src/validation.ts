import type { AskErrorResponse } from "@auraia/shared";
import { config, type SqlDialect } from "./config.js";

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

const extractLimit = (sql: string): number | null => {
  const match = sql.match(/limit\s+(\d+)\s*(?:,\s*(\d+)|\s+offset\s+(\d+))?/i);
  if (!match) return null;
  const first = Number.parseInt(match[1] ?? "", 10);
  const second = match[2] ? Number.parseInt(match[2], 10) : null;
  if (Number.isNaN(first)) return null;
  if (second !== null && !Number.isNaN(second)) return second;
  return first;
};

const extractRowLimit = (sql: string, dialect: SqlDialect): number | null =>
  dialect === "mysql" ? extractLimit(sql) : extractTop(sql);

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

  const rowLimit = extractRowLimit(trimmed, config.sql.dialect);
  if (!rowLimit) {
    return {
      ok: false,
      error: {
        sql,
        errorMessage:
          config.sql.dialect === "mysql"
            ? "A query precisa ter LIMIT 100."
            : "A query precisa ter TOP (100)."
      }
    };
  }

  if (rowLimit > 500) {
    return {
      ok: false,
      error: {
        sql,
        errorMessage:
          config.sql.dialect === "mysql"
            ? "LIMIT maior que 500 nao eh permitido."
            : "TOP maior que 500 nao eh permitido."
      }
    };
  }

  return { ok: true };
};
