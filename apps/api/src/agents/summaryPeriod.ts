import { isContiguousYearRun, type YearRange } from "../helpers/period.js";

/**
 * Period reasoning for the summary agent, kept apart from summary.ts because
 * that module pulls the OpenAI client and the app config at import time. These
 * functions are pure, so living here is what lets them be unit tested offline.
 */

/**
 * Compact date literals ('20170101') have no word boundary before the month
 * digits, so the plain year pattern skips them entirely. A query that filters a
 * period only through such literals would report zero years and silence every
 * period guard downstream.
 */
const COMPACT_DATE_PATTERN = /\b(20\d{2})(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\b/g;

export const extractYearsFromSql = (sql: string): number[] => {
  const years = new Set<number>();
  for (const match of sql.matchAll(COMPACT_DATE_PATTERN)) {
    if (match[1]) years.add(Number.parseInt(match[1], 10));
  }
  for (const match of sql.match(/\b20\d{2}\b/g) ?? []) {
    years.add(Number.parseInt(match, 10));
  }
  return [...years].sort((a, b) => a - b);
};

/**
 * Years cited by the summary that the SQL never filtered on.
 *
 * This only *detects* the drift. It deliberately does not correct it: the
 * previous implementation rewrote every year in the summary to the single year
 * found in the SQL, which turned a correct comparison ("cresceu de 2023 para
 * 2024") into a false statement ("cresceu de 2024 para 2024") with no error
 * signal. Getting the period right belongs to the prompt; this function exists
 * so the eval suite can measure how often the prompt fails.
 */
export const findSummaryYearMismatch = (summary: string, sqlYears: number[]): number[] => {
  if (sqlYears.length === 0) return [];
  const cited = [
    ...new Set((summary.match(/\b20\d{2}\b/g) ?? []).map((value) => Number.parseInt(value, 10)))
  ];
  return cited.filter((year) => !sqlYears.includes(year)).sort((a, b) => a - b);
};

const joinYears = (years: number[], language: "pt" | "en" | "es"): string => {
  if (years.length === 1) return String(years[0]);
  const conjunction = language === "en" ? "and" : language === "es" ? "y" : "e";
  const head = years.slice(0, -1).join(", ");
  return `${head} ${conjunction} ${years[years.length - 1]}`;
};

/**
 * `range` wins over the years read back from the SQL because a range filter
 * written as `>= '20170101' AND < '20260101'` yields 2026 — the exclusive upper
 * bound, a year the query never actually covers.
 */
export const buildPeriodInstruction = (
  sqlYears: number[],
  language: "pt" | "en" | "es",
  range: YearRange | null = null
): string => {
  const interval =
    range ??
    (isContiguousYearRun(sqlYears)
      ? { startYear: sqlYears[0]!, endYear: sqlYears[sqlYears.length - 1]! }
      : null);

  if (interval) {
    const span = `${interval.startYear} ${language === "en" ? "to" : "a"} ${interval.endYear}`;
    return language === "en"
      ? `The query covers the continuous interval ${span}. Describe the evolution across the period; do not treat it as a two-point comparison and do not mention any year outside the interval.`
      : language === "es"
        ? `La consulta cubre el intervalo continuo ${span}. Describe la evolucion a lo largo del periodo; no lo trates como una comparacion de dos puntos y no menciones ningun ano fuera del intervalo.`
        : `A consulta cobre o intervalo continuo de ${span}. Descreva a evolucao ao longo do periodo; nao trate como comparacao de dois pontos e nao mencione nenhum ano fora do intervalo.`;
  }

  if (sqlYears.length === 0) return "";
  const list = joinYears(sqlYears, language);

  if (sqlYears.length === 1) {
    return language === "en"
      ? `The query covers only ${list}. Do not mention any other year.`
      : language === "es"
        ? `La consulta cubre solo ${list}. No menciones ningun otro ano.`
        : `A consulta cobre apenas ${list}. Nao mencione nenhum outro ano.`;
  }

  return language === "en"
    ? `The query compares these periods: ${list}. Use exactly these years, keep each figure attached to its own year, and do not mention any other year.`
    : language === "es"
      ? `La consulta compara estos periodos: ${list}. Usa exactamente estos anos, manten cada cifra con su propio ano, y no menciones ningun otro ano.`
      : `A consulta compara estes periodos: ${list}. Use exatamente esses anos, mantenha cada numero ligado ao seu proprio ano, e nao mencione nenhum outro ano.`;
};
