/**
 * Shared types for the eval harness.
 *
 * The harness exists to answer one question: did this change make the assistant
 * better or worse? Every run is written to disk so two runs can be diffed.
 */

export type Lang = "pt" | "en" | "es";

/**
 * Failure taxonomy. The point of having codes instead of free-text is that the
 * report can aggregate them, and each code maps to a known defect class from the
 * assertiveness review — so a spike in one code points at one item in the plan.
 */
export type FailureCode =
  /** The pipeline threw or returned ok:false when the case expected an answer. */
  | "PIPELINE_ERROR"
  /** validateSql rejected a query the case considers legitimate (review item #3). */
  | "FALSE_BLOCK"
  /** The database rejected the generated SQL. */
  | "SQL_ERROR"
  /** The case expected a failure and got an answer instead. */
  | "UNEXPECTED_SUCCESS"
  /** Required pattern absent from the SQL (wrong table, missing filter, ...). */
  | "SQL_PATTERN_MISSING"
  /** Forbidden pattern present in the SQL. */
  | "SQL_PATTERN_FORBIDDEN"
  /** SQL filtered on a different set of years than the case demands. */
  | "SQL_YEAR_DRIFT"
  /** Summary cites a year the SQL never filtered on (review item #1). */
  | "SUMMARY_YEAR_INCONSISTENT"
  /** Summary came back in a language other than the requested one (items #2/#8). */
  | "WRONG_LANGUAGE"
  /** Row count outside the expected window. */
  | "ROW_COUNT"
  /** A numeric value in the result set does not match the expected value. */
  | "VALUE_MISMATCH"
  /** Summary text is missing required content, or contains forbidden content. */
  | "ANSWER_CONTENT"
  /** Required pattern absent from the summary. */
  | "ANSWER_PATTERN_MISSING"
  /** Forbidden pattern present in the summary (an invented period, a leaked id). */
  | "ANSWER_PATTERN_FORBIDDEN"
  /** No summary was produced at all. */
  | "NO_SUMMARY"
  /** Wall-clock budget for the case was exceeded. */
  | "TOO_SLOW"
  /** A regex in the case file does not compile. An authoring bug, not a defect. */
  | "BAD_PATTERN";

export const FAILURE_CODES: FailureCode[] = [
  "PIPELINE_ERROR",
  "FALSE_BLOCK",
  "SQL_ERROR",
  "UNEXPECTED_SUCCESS",
  "SQL_PATTERN_MISSING",
  "SQL_PATTERN_FORBIDDEN",
  "SQL_YEAR_DRIFT",
  "SUMMARY_YEAR_INCONSISTENT",
  "WRONG_LANGUAGE",
  "ROW_COUNT",
  "VALUE_MISMATCH",
  "ANSWER_CONTENT",
  "ANSWER_PATTERN_MISSING",
  "ANSWER_PATTERN_FORBIDDEN",
  "NO_SUMMARY",
  "TOO_SLOW",
  "BAD_PATTERN"
];

/** Which review item each failure code points at. Used by the report. */
export const FAILURE_HINTS: Record<FailureCode, string> = {
  PIPELINE_ERROR: "erro nao classificado no pipeline",
  FALSE_BLOCK: "item #3 — validateSql rejeitando query legitima",
  SQL_ERROR: "SQL invalido para o banco: prompt/schema chunks",
  UNEXPECTED_SUCCESS: "caso negativo deixou de ser bloqueado",
  SQL_PATTERN_MISSING: "item #12/#13 — schema chunks ou few-shot",
  SQL_PATTERN_FORBIDDEN: "SQL usou construcao proibida pelo caso",
  SQL_YEAR_DRIFT: "filtro de periodo errado no SQL",
  SUMMARY_YEAR_INCONSISTENT: "item #1 — resumo cita ano que o SQL nao filtrou",
  WRONG_LANGUAGE: "item #2/#8 — idioma da resposta",
  ROW_COUNT: "granularidade do resultado (group by / filtro)",
  VALUE_MISMATCH: "numero errado — o pior tipo de falha",
  ANSWER_CONTENT: "resumo nao respondeu o que foi pedido",
  ANSWER_PATTERN_MISSING: "resumo nao respondeu o que foi pedido",
  ANSWER_PATTERN_FORBIDDEN: "item #1 — resumo afirmou algo que o SQL nao sustenta",
  NO_SUMMARY: "summarizeResult nao produziu texto",
  TOO_SLOW: "item #8/#9 — latencia",
  BAD_PATTERN: "regex invalida no arquivo de caso — corrija o caso, nao o pipeline"
};

export type ExpectedValue = {
  /** Column to read. Defaults to the first column of the first row. */
  column?: string;
  value: number;
  /** Relative tolerance. 0.01 = 1%. Defaults to 0. */
  tolerance?: number;
  /** Which row to read. Defaults to 0. */
  row?: number;
};

export type CaseExpect = {
  /** Defaults to true. Set false for cases that must be refused. */
  shouldSucceed?: boolean;
  /** Case-insensitive regexes that must all match the generated SQL. */
  sqlMustMatch?: string[];
  /** Case-insensitive regexes that must not match the generated SQL. */
  sqlMustNotMatch?: string[];
  /** Exact set of 4-digit years the SQL is allowed to filter on. */
  sqlYears?: number[];
  minRows?: number;
  maxRows?: number;
  exactRows?: number;
  /** Substrings required in the summary (accent- and case-insensitive). */
  answerContains?: string[];
  /** Substrings forbidden in the summary (accent- and case-insensitive). */
  answerMustNotContain?: string[];
  /**
   * Case-insensitive regexes that must all match the summary. Same semantics as
   * `sqlMustMatch`, so a case can assert shape ("cites some 4-digit year")
   * rather than an exact string. Matched raw: unlike `answerContains`, accents
   * are not folded — write `[eé]` if you need both.
   */
  answerMustMatch?: string[];
  /**
   * Case-insensitive regexes that must not match the summary. This is how a
   * case forbids a *class* of text: `20\\d{2}` catches a summary that invented
   * any period, which no substring list can express.
   */
  answerMustNotMatch?: string[];
  expectedValue?: ExpectedValue;
  /**
   * Assert every year cited by the summary was actually filtered by the SQL.
   * Defaults to true — this is the item #1 regression guard and should stay on.
   */
  summaryYearsSubsetOfSql?: boolean;
  /**
   * Read the years found in the SQL as the endpoints of a closed interval, so
   * every year between them is allowed in the summary too.
   *
   * Opt-in, because it genuinely weakens `summaryYearsSubsetOfSql` and only
   * makes sense for continuous-range questions. A range filter written as
   * `>= '20170101' AND < '20260101'` exposes just its bounds to
   * `extractYearsFromSql`, so a summary that correctly walks 2018..2025 would
   * otherwise be reported as citing eight years the SQL "never filtered".
   */
  summaryYearsWithinSqlRange?: boolean;
  /** Assert the summary is written in this language. Defaults to the case's responseLanguage. */
  assertLanguage?: boolean;
  maxElapsedMs?: number;
};

export type EvalCase = {
  id: string;
  question: string;
  /** Language the question is written in. Defaults to "pt". */
  language?: Lang;
  /** Language of the ingested schema. Defaults to the environment setting. */
  schemaLanguage?: Lang;
  /** Language the answer must come back in. Defaults to `language`. */
  responseLanguage?: Lang;
  /** Target environment. Omit to use the default environment. */
  environmentId?: string;
  /** Free-form labels, used by --tags to filter. */
  tags?: string[];
  /** Multi-turn context: previous questions replayed in the same chat first. */
  history?: string[];
  skip?: boolean;
  /** Why this case exists. Shown in the report on failure. */
  notes?: string;
  expect?: CaseExpect;
};

export type CheckResult = {
  name: string;
  ok: boolean;
  code?: FailureCode;
  detail?: string;
};

export type CaseResult = {
  id: string;
  tags: string[];
  status: "pass" | "fail" | "skip";
  checks: CheckResult[];
  failureCodes: FailureCode[];
  question: string;
  notes?: string;
  sql?: string;
  summary?: string;
  rowCount?: number;
  elapsedMs: number;
  totalTokens?: number;
  errorMessage?: string;
};

export type RunTotals = {
  cases: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number;
};

export type RunReport = {
  schemaVersion: 1;
  label: string;
  startedAt: string;
  finishedAt: string;
  gitSha?: string;
  gitDirty?: boolean;
  cacheEnabled: boolean;
  concurrency: number;
  totals: RunTotals;
  failureCounts: Partial<Record<FailureCode, number>>;
  latencyMs: { p50: number; p95: number; max: number; mean: number };
  tokens: { total: number };
  results: CaseResult[];
};
