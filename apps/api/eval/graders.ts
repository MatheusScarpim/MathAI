import type { AskSuccessResponse } from "@auraia/shared";
import { extractYearsFromSql, findSummaryYearMismatch } from "../src/agents/summaryPeriod.js";
import { isConfidentlyNotLanguage, foldText } from "./lib/language.js";
import { compileMatcher } from "./lib/matchers.js";
import type { CheckResult, EvalCase, FailureCode, Lang } from "./types.js";

/**
 * All graders are deterministic. There is no LLM judge here on purpose: a judge
 * adds cost and variance to the very measurement you use to decide whether a
 * change helped, which defeats the point of having a baseline.
 */

const fail = (name: string, code: FailureCode, detail: string): CheckResult => ({
  name,
  ok: false,
  code,
  detail
});

const pass = (name: string): CheckResult => ({ name, ok: true });

/**
 * Fills in the years between the lowest and highest year the SQL mentions, for
 * cases that declared `summaryYearsWithinSqlRange`.
 */
const expandSqlYearsToRange = (sqlYears: number[]): number[] => {
  if (sqlYears.length < 2) return sqlYears;
  const start = sqlYears[0]!;
  const end = sqlYears[sqlYears.length - 1]!;
  const expanded: number[] = [];
  for (let year = start; year <= end; year += 1) expanded.push(year);
  return expanded;
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    // Tolerate pt-BR formatting ("1.234,56") and currency noise coming from
    // drivers that return decimals as strings.
    const cleaned = value.replace(/[^\d,.-]/g, "");
    const normalized =
      cleaned.includes(",") && cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "");
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * The two halves of a regex expectation. Shared by the SQL and summary graders
 * so both dialects of matcher behave identically — an author should not have to
 * remember which fields are regexes and which are substrings, nor which ones
 * survive a typo.
 */
const gradeMustMatch = (
  label: string,
  pattern: string,
  subject: string,
  code: FailureCode
): CheckResult => {
  const compiled = compileMatcher(pattern);
  if (!compiled.ok) return fail(label, "BAD_PATTERN", `regex invalida: ${compiled.message}`);

  return compiled.regex.test(subject)
    ? pass(label)
    : fail(label, code, `nao casou em: ${subject}`);
};

const gradeMustNotMatch = (
  label: string,
  pattern: string,
  subject: string,
  code: FailureCode
): CheckResult => {
  const compiled = compileMatcher(pattern);
  if (!compiled.ok) return fail(label, "BAD_PATTERN", `regex invalida: ${compiled.message}`);

  const match = compiled.regex.exec(subject);
  return match
    ? fail(label, code, `casou "${match[0]}" em: ${subject}`)
    : pass(label);
};

const sameYearSet = (actual: number[], expected: number[]): boolean => {
  if (actual.length !== expected.length) return false;
  const sortedExpected = [...expected].sort((a, b) => a - b);
  return actual.every((year, index) => year === sortedExpected[index]);
};

/** `expect.shouldSucceed` handling, including the FALSE_BLOCK special case. */
export const gradeOutcome = (
  evalCase: EvalCase,
  outcome: { ok: boolean; errorMessage?: string }
): CheckResult[] => {
  const shouldSucceed = evalCase.expect?.shouldSucceed ?? true;

  if (shouldSucceed && !outcome.ok) {
    const message = outcome.errorMessage ?? "sem mensagem";

    // Distinguish "our own validator refused a legitimate query" from "the
    // database refused it". They point at different fixes, so they must not
    // land in the same bucket.
    const isValidatorRefusal =
      /keyword proibida|nao sao permitidos|precisa iniciar|somente uma query|nao eh permitido|nao fechado|liste as colunas/i.test(
        message
      );

    return [
      fail(
        "outcome",
        isValidatorRefusal ? "FALSE_BLOCK" : "SQL_ERROR",
        message
      )
    ];
  }

  if (!shouldSucceed && outcome.ok) {
    return [fail("outcome", "UNEXPECTED_SUCCESS", "caso negativo retornou resposta")];
  }

  return [pass("outcome")];
};

export const gradeSql = (evalCase: EvalCase, sql: string): CheckResult[] => {
  const checks: CheckResult[] = [];
  const expect = evalCase.expect;
  if (!expect) return checks;

  for (const pattern of expect.sqlMustMatch ?? []) {
    checks.push(
      gradeMustMatch(`sql~/${pattern}/`, pattern, sql, "SQL_PATTERN_MISSING")
    );
  }

  for (const pattern of expect.sqlMustNotMatch ?? []) {
    checks.push(
      gradeMustNotMatch(`sql!~/${pattern}/`, pattern, sql, "SQL_PATTERN_FORBIDDEN")
    );
  }

  if (expect.sqlYears) {
    const actual = extractYearsFromSql(sql);
    checks.push(
      sameYearSet(actual, expect.sqlYears)
        ? pass("sqlYears")
        : fail(
            "sqlYears",
            "SQL_YEAR_DRIFT",
            `esperado [${expect.sqlYears.join(", ")}], obtido [${actual.join(", ")}]`
          )
    );
  }

  return checks;
};

export const gradeRows = (
  evalCase: EvalCase,
  rows: Record<string, unknown>[],
  columns: string[]
): CheckResult[] => {
  const checks: CheckResult[] = [];
  const expect = evalCase.expect;
  if (!expect) return checks;

  const count = rows.length;

  if (expect.exactRows !== undefined) {
    checks.push(
      count === expect.exactRows
        ? pass("exactRows")
        : fail("exactRows", "ROW_COUNT", `esperado ${expect.exactRows}, obtido ${count}`)
    );
  }

  if (expect.minRows !== undefined) {
    checks.push(
      count >= expect.minRows
        ? pass("minRows")
        : fail("minRows", "ROW_COUNT", `esperado >= ${expect.minRows}, obtido ${count}`)
    );
  }

  if (expect.maxRows !== undefined) {
    checks.push(
      count <= expect.maxRows
        ? pass("maxRows")
        : fail("maxRows", "ROW_COUNT", `esperado <= ${expect.maxRows}, obtido ${count}`)
    );
  }

  if (expect.expectedValue) {
    checks.push(gradeExpectedValue(expect.expectedValue, rows, columns));
  }

  return checks;
};

const gradeExpectedValue = (
  expected: NonNullable<EvalCase["expect"]>["expectedValue"],
  rows: Record<string, unknown>[],
  columns: string[]
): CheckResult => {
  if (!expected) return pass("expectedValue");

  const rowIndex = expected.row ?? 0;
  const row = rows[rowIndex];
  if (!row) {
    return fail("expectedValue", "VALUE_MISMATCH", `linha ${rowIndex} inexistente`);
  }

  const column = expected.column ?? columns[0];
  if (!column) {
    return fail("expectedValue", "VALUE_MISMATCH", "nenhuma coluna disponivel");
  }

  // Tolerate alias drift: the model may name the aggregate differently across
  // runs, so fall back to a case-insensitive lookup before giving up.
  const rawValue =
    column in row
      ? row[column]
      : Object.entries(row).find(([key]) => key.toLowerCase() === column.toLowerCase())?.[1];

  const actual = toNumber(rawValue);
  if (actual === null) {
    return fail(
      "expectedValue",
      "VALUE_MISMATCH",
      `coluna "${column}" ausente ou nao numerica (valor: ${JSON.stringify(rawValue)})`
    );
  }

  const tolerance = expected.tolerance ?? 0;
  const allowed = Math.abs(expected.value) * tolerance;
  const delta = Math.abs(actual - expected.value);

  return delta <= allowed
    ? pass("expectedValue")
    : fail(
        "expectedValue",
        "VALUE_MISMATCH",
        `esperado ${expected.value} (+-${tolerance * 100}%), obtido ${actual}`
      );
};

export const gradeSummary = (
  evalCase: EvalCase,
  summary: string | undefined,
  sql: string,
  responseLanguage: Lang
): CheckResult[] => {
  const checks: CheckResult[] = [];
  const expect = evalCase.expect ?? {};

  const needsSummary =
    expect.answerContains?.length ||
    expect.answerMustNotContain?.length ||
    expect.answerMustMatch?.length ||
    expect.answerMustNotMatch?.length ||
    expect.assertLanguage ||
    (expect.summaryYearsSubsetOfSql ?? true);

  if (!summary?.trim()) {
    return needsSummary
      ? [fail("summary", "NO_SUMMARY", "resumo vazio")]
      : [pass("summary")];
  }

  // Item #1 guard. The old code rewrote mismatching years in place, which hid
  // exactly this defect; here it is a first-class failure instead.
  if (expect.summaryYearsSubsetOfSql ?? true) {
    const sqlYears = expect.summaryYearsWithinSqlRange
      ? expandSqlYearsToRange(extractYearsFromSql(sql))
      : extractYearsFromSql(sql);
    const mismatch = findSummaryYearMismatch(summary, sqlYears);
    checks.push(
      mismatch.length === 0
        ? pass("summaryYears")
        : fail(
            "summaryYears",
            "SUMMARY_YEAR_INCONSISTENT",
            `resumo cita [${mismatch.join(", ")}] mas o SQL filtrou [${sqlYears.join(", ")}]`
          )
    );
  }

  const foldedSummary = foldText(summary);

  for (const needle of expect.answerContains ?? []) {
    checks.push(
      foldedSummary.includes(foldText(needle))
        ? pass(`answer~"${needle}"`)
        : fail(`answer~"${needle}"`, "ANSWER_CONTENT", `ausente em: ${summary}`)
    );
  }

  for (const needle of expect.answerMustNotContain ?? []) {
    checks.push(
      foldedSummary.includes(foldText(needle))
        ? fail(`answer!~"${needle}"`, "ANSWER_CONTENT", `presente em: ${summary}`)
        : pass(`answer!~"${needle}"`)
    );
  }

  // Regex form of the two above. `summaryYearsSubsetOfSql` can only compare the
  // summary against years the SQL *did* filter; when the SQL filtered none it
  // has nothing to compare and goes inert, so forbidding the shape outright is
  // the only way a case can assert "do not invent a period at all".
  for (const pattern of expect.answerMustMatch ?? []) {
    checks.push(
      gradeMustMatch(`answer~/${pattern}/`, pattern, summary, "ANSWER_PATTERN_MISSING")
    );
  }

  for (const pattern of expect.answerMustNotMatch ?? []) {
    checks.push(
      gradeMustNotMatch(`answer!~/${pattern}/`, pattern, summary, "ANSWER_PATTERN_FORBIDDEN")
    );
  }

  if (expect.assertLanguage) {
    const { mismatch, detection } = isConfidentlyNotLanguage(summary, responseLanguage);
    checks.push(
      mismatch
        ? fail(
            "summaryLanguage",
            "WRONG_LANGUAGE",
            `esperado ${responseLanguage}, detectado ${detection.language} (scores ${JSON.stringify(detection.scores)})`
          )
        : pass("summaryLanguage")
    );
  }

  return checks;
};

export const gradeLatency = (evalCase: EvalCase, elapsedMs: number): CheckResult[] => {
  const budget = evalCase.expect?.maxElapsedMs;
  if (budget === undefined) return [];
  return [
    elapsedMs <= budget
      ? pass("latency")
      : fail("latency", "TOO_SLOW", `${elapsedMs}ms > ${budget}ms`)
  ];
};

/** Run every applicable grader against a successful pipeline response. */
export const gradeSuccess = (
  evalCase: EvalCase,
  data: AskSuccessResponse,
  responseLanguage: Lang
): CheckResult[] => [
  ...gradeSql(evalCase, data.sql ?? ""),
  ...gradeRows(evalCase, data.rows ?? [], data.columns ?? []),
  ...gradeSummary(evalCase, data.summary, data.sql ?? "", responseLanguage),
  ...gradeLatency(evalCase, data.elapsedMs ?? 0)
];
