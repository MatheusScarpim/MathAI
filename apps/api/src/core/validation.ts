import type { AskErrorResponse } from "@auraia/shared";
import type { DbType } from "./appConfig.js";

type ValidationResult = { ok: true } | { ok: false; error: AskErrorResponse };

const forbiddenKeywords = [
  "delete", "update", "insert", "merge", "drop", "truncate", "alter",
  "exec", "execute", "xp_", "sp_", "into", "grant", "revoke", "create",
  "openrowset", "openquery", "opendatasource", "load_file", "outfile",
  "infile", "dbms_", "utl_", "call", "set", "declare", "cursor", "bulk"
];

/**
 * Result of walking the SQL text once, classifying every character as either
 * executable code or an inert region (string literal, quoted identifier, comment).
 *
 * `code` has the same length as the input, with every inert region replaced by
 * spaces. Keeping the length stable preserves token boundaries, so a value like
 * `'%insert%'` can never be mistaken for the INSERT keyword, and a `;` or
 * `LIMIT 9999` inside a literal can never trip the structural checks.
 */
type SqlScan = {
  code: string;
  hasComment: boolean;
  unterminated: "string" | "identifier" | null;
};

/** Oracle q-quote delimiters that close with a mirrored character. */
const QQUOTE_PAIRS: Record<string, string> = { "[": "]", "{": "}", "(": ")", "<": ">" };

const isIdentifierChar = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z0-9_$#]/.test(char);

const scanSql = (sql: string, dbType: DbType): SqlScan => {
  // MySQL treats \ as an escape inside strings; the other dialects we support
  // run with standard-conforming strings where \ is a literal character.
  const backslashEscapes = dbType === "mysql";
  const hashComments = dbType === "mysql";
  const bracketIdentifiers = dbType === "sqlserver";
  // Backticks quote identifiers in MySQL only. Elsewhere a backtick is not a
  // valid token at all, so treating one as a quote let a crafted pair blank out
  // a region of real code - inert against the database, but it hid keywords
  // from the blocklist, which is the one job this scan has.
  const backtickIdentifiers = dbType === "mysql";
  const qQuotes = dbType === "oracle";

  let code = "";
  let hasComment = false;
  let unterminated: "string" | "identifier" | null = null;
  let i = 0;

  const blank = (from: number, to: number): void => {
    code += " ".repeat(to - from);
  };

  while (i < sql.length) {
    const char = sql[i]!;
    const next = sql[i + 1];

    if (char === "/" && next === "*") {
      hasComment = true;
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    if ((char === "-" && next === "-") || (hashComments && char === "#")) {
      hasComment = true;
      const newline = sql.indexOf("\n", i);
      const stop = newline === -1 ? sql.length : newline;
      blank(i, stop);
      i = stop;
      continue;
    }

    // Oracle alternative quoting: q'<delim>text<delim>'. The inner text may
    // contain apostrophes, which is the whole point of the syntax. Without this
    // branch the apostrophe in q'{it's}' reads as a terminator and everything
    // after it is swallowed as an unterminated string, so a perfectly valid
    // Oracle query gets rejected - the exact false positive this scan removes
    // everywhere else.
    if (qQuotes && (char === "q" || char === "Q") && next === "'" && !isIdentifierChar(sql[i - 1])) {
      const delimiter = sql[i + 2];
      if (delimiter !== undefined) {
        const closer = QQUOTE_PAIRS[delimiter] ?? delimiter;
        const end = sql.indexOf(`${closer}'`, i + 3);
        if (end === -1) unterminated = "string";
        const stop = end === -1 ? sql.length : end + 2;
        blank(i, stop);
        i = stop;
        continue;
      }
    }

    const opensQuote =
      char === "'" ||
      char === '"' ||
      (backtickIdentifiers && char === "`") ||
      (bracketIdentifiers && char === "[");

    if (opensQuote) {
      const closing = char === "[" ? "]" : char;
      // '' and "" (and ]] in SQL Server) are escaped occurrences, not terminators.
      const doubledEscapes = char !== "`";
      let j = i + 1;
      let closed = false;

      while (j < sql.length) {
        const inner = sql[j]!;
        if (backslashEscapes && inner === "\\" && (char === "'" || char === '"')) {
          j += 2;
          continue;
        }
        if (inner === closing) {
          if (doubledEscapes && sql[j + 1] === closing) {
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }

      if (!closed) {
        unterminated = char === "'" ? "string" : "identifier";
        j = sql.length;
      }

      blank(i, j);
      i = j;
      continue;
    }

    code += char;
    i += 1;
  }

  return { code, hasComment, unterminated };
};

const hasForbiddenKeyword = (code: string): string | null => {
  for (const keyword of forbiddenKeywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = keyword.endsWith("_")
      ? new RegExp(escaped, "i")
      : new RegExp(`\\b${escaped}\\b`, "i");
    if (pattern.test(code)) return keyword;
  }
  return null;
};

// ── Common validation shared by all dialects ──

const validateCommon = (sql: string, scan: SqlScan): ValidationResult => {
  const trimmed = sql.trim();
  const code = scan.code.trim();

  if (!trimmed) {
    return { ok: false, error: { errorMessage: "SQL vazio retornado pela IA." } };
  }

  if (scan.unterminated) {
    const label = scan.unterminated === "string" ? "String" : "Identificador";
    return {
      ok: false,
      error: { sql, errorMessage: `${label} nao fechado na query — verifique as aspas.` }
    };
  }

  if (scan.hasComment) {
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

  const forbidden = hasForbiddenKeyword(code);
  if (forbidden) {
    return {
      ok: false,
      error: {
        sql,
        errorMessage: `Keyword proibida detectada: ${forbidden}. Apenas leitura eh permitida — reescreva como SELECT/WITH. Se "${forbidden}" eh um nome de coluna ou tabela, coloque entre aspas duplas.`
      }
    };
  }

  const semicolonIndex = code.indexOf(";");
  if (semicolonIndex !== -1 && semicolonIndex < code.length - 1) {
    return {
      ok: false,
      error: { sql, errorMessage: "Somente uma query eh permitida." }
    };
  }

  if (/select\s+\*/i.test(code)) {
    return {
      ok: false,
      error: { sql, errorMessage: "SELECT * nao eh permitido — liste as colunas explicitamente." }
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

const checkRowLimit = (code: string, sql: string, dbType: DbType): ValidationResult => {
  const trimmed = code.trim();

  switch (dbType) {
    case "sqlserver": {
      const topValue = extractTopSqlServer(trimmed);
      if (topValue && topValue > 500) {
        return { ok: false, error: { sql, errorMessage: "TOP maior que 500 nao eh permitido." } };
      }
      return { ok: true };
    }

    case "oracle": {
      const fetchValue = extractFetchOracle(trimmed);
      if (fetchValue && fetchValue > 500) {
        return { ok: false, error: { sql, errorMessage: "Limite de linhas maior que 500 nao eh permitido." } };
      }
      return { ok: true };
    }

    case "mysql": {
      const limitValue = extractLimitMySQL(trimmed);
      if (limitValue && limitValue > 500) {
        return { ok: false, error: { sql, errorMessage: "LIMIT maior que 500 nao eh permitido." } };
      }
      return { ok: true };
    }

    case "postgresql": {
      const limitValue = extractLimitPostgresql(trimmed);
      if (limitValue && limitValue > 500) {
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
  const scan = scanSql(sql, dbType);
  const common = validateCommon(sql, scan);
  if (!common.ok) return common;
  return checkRowLimit(scan.code, sql, dbType);
};

export const __testing = { scanSql };
