import type { AskErrorResponse } from "@auraia/shared";
import type { DbType } from "./appConfig.js";

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

const extractTopSqlServer = (sql: string): number | null => {
  const match = sql.match(/top\s*\(\s*(\d+)\s*\)|top\s+(\d+)/i);
  const value = match?.[1] ?? match?.[2];
  return value ? Number.parseInt(value, 10) : null;
};

const extractFetchOracle = (sql: string): number | null => {
  const fetchMatch = sql.match(/fetch\s+first\s+(\d+)\s+rows?\s+only/i);
  if (fetchMatch?.[1]) return Number.parseInt(fetchMatch[1], 10);

  const rownumMatch = sql.match(/rownum\s*<=?\s*(\d+)/i);
  if (rownumMatch?.[1]) return Number.parseInt(rownumMatch[1], 10);

  return null;
};

const validateSqlServer = (
  sql: string
): { ok: true } | { ok: false; error: AskErrorResponse } => {
  const trimmed = sql.trim();

  if (!trimmed) {
    return { ok: false, error: { errorMessage: "SQL vazio retornado pela IA." } };
  }

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

  const topValue = extractTopSqlServer(trimmed);
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

const validateOracle = (
  sql: string
): { ok: true } | { ok: false; error: AskErrorResponse } => {
  const trimmed = sql.trim();

  if (!trimmed) {
    return { ok: false, error: { errorMessage: "SQL vazio retornado pela IA." } };
  }

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

  const fetchValue = extractFetchOracle(trimmed);
  if (!fetchValue) {
    return {
      ok: false,
      error: { sql, errorMessage: "A query precisa ter FETCH FIRST n ROWS ONLY ou ROWNUM <= n." }
    };
  }

  if (fetchValue > 500) {
    return {
      ok: false,
      error: { sql, errorMessage: "Limite de linhas maior que 500 nao eh permitido." }
    };
  }

  return { ok: true };
};

const extractLimitMySQL = (sql: string): number | null => {
  const match = sql.match(/limit\s+(\d+)/i);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
};

const validateMySQL = (
  sql: string
): { ok: true } | { ok: false; error: AskErrorResponse } => {
  const trimmed = sql.trim();

  if (!trimmed) {
    return { ok: false, error: { errorMessage: "SQL vazio retornado pela IA." } };
  }

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

  const limitValue = extractLimitMySQL(trimmed);
  if (!limitValue) {
    return {
      ok: false,
      error: { sql, errorMessage: "A query precisa ter LIMIT n." }
    };
  }

  if (limitValue > 500) {
    return {
      ok: false,
      error: { sql, errorMessage: "LIMIT maior que 500 nao eh permitido." }
    };
  }

  return { ok: true };
};

export const validateSql = (
  sql: string,
  dbType: DbType = "sqlserver"
): { ok: true } | { ok: false; error: AskErrorResponse } => {
  if (dbType === "oracle") {
    return validateOracle(sql);
  }
  if (dbType === "mysql") {
    return validateMySQL(sql);
  }
  return validateSqlServer(sql);
};
