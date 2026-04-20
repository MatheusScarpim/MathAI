import type { AskErrorResponse } from "@auraia/shared";
import type { DbType } from "./appConfig.js";

type ValidationResult = { ok: true } | { ok: false; error: AskErrorResponse };

const forbiddenKeywords = [
  "delete", "update", "insert", "merge", "drop", "truncate", "alter",
  "exec", "execute", "xp_", "sp_", "into", "grant", "revoke", "create",
  "openrowset", "openquery", "opendatasource", "load_file", "outfile",
  "infile", "dbms_", "utl_", "call", "set", "declare", "cursor", "bulk"
];

const hasInlineComment = (sql: string): boolean =>
  /\/\*/.test(sql) || /--/.test(sql);

const hasForbiddenKeyword = (sql: string): string | null => {
  const lower = sql.toLowerCase();
  for (const keyword of forbiddenKeywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = keyword.endsWith("_")
      ? new RegExp(`${escaped}`, "i")
      : new RegExp(`\\b${escaped}\\b`, "i");
    if (pattern.test(lower)) return keyword;
  }
  return null;
};

// ── Common validation shared by all dialects ──

const validateCommon = (sql: string): ValidationResult => {
  const trimmed = sql.trim();

  if (!trimmed) {
    return { ok: false, error: { errorMessage: "SQL vazio retornado pela IA." } };
  }

  if (hasInlineComment(trimmed)) {
    return {
      ok: false,
      error: { sql, errorMessage: "Comentarios SQL nao sao permitidos (/* ou --)." }
    };
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

  return { ok: true };
};

// ── Row-limit extractors per dialect ──

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

const extractLimitMySQL = (sql: string): number | null => {
  const match = sql.match(/limit\s+(\d+)/i);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
};

const extractLimitPostgresql = (sql: string): number | null => {
  // PostgreSQL supports both LIMIT n and FETCH FIRST n ROWS ONLY
  const limitMatch = sql.match(/limit\s+(\d+)/i);
  if (limitMatch?.[1]) return Number.parseInt(limitMatch[1], 10);

  const fetchMatch = sql.match(/fetch\s+first\s+(\d+)\s+rows?\s+only/i);
  if (fetchMatch?.[1]) return Number.parseInt(fetchMatch[1], 10);

  return null;
};

// ── Dialect-specific validators (only check row limits) ──

const checkRowLimit = (
  sql: string,
  dbType: DbType
): ValidationResult => {
  const trimmed = sql.trim();

  switch (dbType) {
    case "sqlserver": {
      const topValue = extractTopSqlServer(trimmed);
      if (!topValue) {
        return { ok: false, error: { sql, errorMessage: "A query precisa ter TOP (100)." } };
      }
      if (topValue > 500) {
        return { ok: false, error: { sql, errorMessage: "TOP maior que 500 nao eh permitido." } };
      }
      return { ok: true };
    }

    case "oracle": {
      const fetchValue = extractFetchOracle(trimmed);
      if (!fetchValue) {
        return { ok: false, error: { sql, errorMessage: "A query precisa ter FETCH FIRST n ROWS ONLY ou ROWNUM <= n." } };
      }
      if (fetchValue > 500) {
        return { ok: false, error: { sql, errorMessage: "Limite de linhas maior que 500 nao eh permitido." } };
      }
      return { ok: true };
    }

    case "mysql": {
      const limitValue = extractLimitMySQL(trimmed);
      if (!limitValue) {
        return { ok: false, error: { sql, errorMessage: "A query precisa ter LIMIT n." } };
      }
      if (limitValue > 500) {
        return { ok: false, error: { sql, errorMessage: "LIMIT maior que 500 nao eh permitido." } };
      }
      return { ok: true };
    }

    case "postgresql": {
      const limitValue = extractLimitPostgresql(trimmed);
      if (!limitValue) {
        return { ok: false, error: { sql, errorMessage: "A query precisa ter LIMIT n ou FETCH FIRST n ROWS ONLY." } };
      }
      if (limitValue > 500) {
        return { ok: false, error: { sql, errorMessage: "Limite de linhas maior que 500 nao eh permitido." } };
      }
      return { ok: true };
    }

    default:
      return { ok: true };
  }
};

// ── Public API ──

export const validateSql = (
  sql: string,
  dbType: DbType = "sqlserver"
): ValidationResult => {
  const common = validateCommon(sql);
  if (!common.ok) return common;
  return checkRowLimit(sql, dbType);
};
