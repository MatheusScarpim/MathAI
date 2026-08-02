/**
 * Eval runner — review item #11.
 *
 * Usage (from apps/api):
 *   npm run eval                          # every non-skipped case
 *   npm run eval -- --tags year,language  # only cases carrying these tags
 *   npm run eval -- --only vendas-2024    # a single case by id
 *   npm run eval -- --label before        # name the run for a later diff
 *   npm run eval -- --list                # print the suite, run nothing
 *   npm run eval -- --warm                # second (cache-warm) pass timings
 *
 * Writes eval/runs/<label>.json. Compare two runs with `npm run eval:diff`.
 *
 * Cache control needs no change to the pipeline: the semantic cache is keyed by
 * chatId, so a fresh random chatId per case guarantees the cold path. `--warm`
 * replays the same case on the same chatId to measure the cached path instead.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
// Env-free by construction (see lib/matchers.ts), so it can run under --list.
import { findBadPatterns } from "./lib/matchers.js";
import {
  FAILURE_HINTS,
  type CaseResult,
  type CheckResult,
  type EvalCase,
  type FailureCode,
  type Lang,
  type RunReport
} from "./types.js";

const CASES_DIR = path.join(import.meta.dirname, "cases");
const RUNS_DIR = path.join(import.meta.dirname, "runs");

/**
 * The pipeline is imported lazily because `src/core/config.ts` aborts the
 * process on a missing JWT_SECRET the moment it is loaded. Keeping the import
 * out of module scope lets `--list` validate the suite — duplicate ids, bad
 * JSON, malformed `expect` blocks — with no environment configured at all,
 * which is what makes it usable as a cheap lint step.
 */
type Harness = {
  ask: typeof import("../src/pipeline/ask.js")["answerQuestion"];
  graders: typeof import("./graders.js");
};

const loadPipeline = async (): Promise<Harness> => {
  const [{ answerQuestion }, { ensureDefaultSettings }, graders] = await Promise.all([
    import("../src/pipeline/ask.js"),
    import("../src/helpers/settings.js"),
    // graders reaches into src/agents/summary.ts for the year helpers, so it
    // pulls in config too and has to stay behind the same lazy boundary.
    import("./graders.js")
  ]);
  await ensureDefaultSettings();
  return { ask: answerQuestion, graders };
};

/* ── CLI ──────────────────────────────────────────────────────────── */

type Options = {
  tags: string[];
  only: string[];
  label: string;
  concurrency: number;
  list: boolean;
  warm: boolean;
  verbose: boolean;
  environmentId?: string;
};

const parseArgs = (argv: string[]): Options => {
  const options: Options = {
    tags: [],
    only: [],
    label: new Date().toISOString().replace(/[:.]/g, "-"),
    concurrency: 1,
    list: false,
    warm: false,
    verbose: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    const next = argv[index + 1];

    switch (arg) {
      case "--tags":
        options.tags = (next ?? "").split(",").map((value) => value.trim()).filter(Boolean);
        index += 1;
        break;
      case "--only":
        options.only = (next ?? "").split(",").map((value) => value.trim()).filter(Boolean);
        index += 1;
        break;
      case "--label":
        if (next) options.label = next.replace(/[^\w.-]/g, "_");
        index += 1;
        break;
      case "--concurrency":
        options.concurrency = Math.max(1, Number.parseInt(next ?? "1", 10) || 1);
        index += 1;
        break;
      case "--env":
        options.environmentId = next;
        index += 1;
        break;
      case "--list":
        options.list = true;
        break;
      case "--warm":
        options.warm = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      default:
        if (arg.startsWith("--")) {
          console.warn(`[eval] flag desconhecida ignorada: ${arg}`);
        }
    }
  }

  return options;
};

/* ── Case loading ─────────────────────────────────────────────────── */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const loadCases = async (): Promise<EvalCase[]> => {
  let entries: string[];
  try {
    entries = await readdir(CASES_DIR);
  } catch {
    throw new Error(`Diretorio de casos nao encontrado: ${CASES_DIR}`);
  }

  const files = entries.filter((name) => name.endsWith(".json")).sort();
  const cases: EvalCase[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    const raw = await readFile(path.join(CASES_DIR, file), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`JSON invalido em ${file}: ${(error as Error).message}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`${file} deve conter um array de casos`);
    }

    for (const entry of parsed) {
      if (!isRecord(entry)) throw new Error(`${file}: caso nao e um objeto`);
      const { id, question } = entry;
      if (typeof id !== "string" || !id.trim()) {
        throw new Error(`${file}: caso sem "id"`);
      }
      if (typeof question !== "string" || !question.trim()) {
        throw new Error(`${file}: caso "${id}" sem "question"`);
      }
      const previous = seen.get(id);
      if (previous) {
        throw new Error(`id duplicado "${id}" (${previous} e ${file})`);
      }
      seen.set(id, file);
      cases.push(entry as EvalCase);
    }
  }

  return cases;
};

const selectCases = (cases: EvalCase[], options: Options): EvalCase[] =>
  cases.filter((evalCase) => {
    if (options.only.length > 0) return options.only.includes(evalCase.id);
    if (options.tags.length > 0) {
      return (evalCase.tags ?? []).some((tag) => options.tags.includes(tag));
    }
    return true;
  });

/* ── Execution ────────────────────────────────────────────────────── */

const resolveLanguages = (evalCase: EvalCase): { question: Lang; schema: Lang; response: Lang } => {
  const question = evalCase.language ?? "pt";
  return {
    question,
    schema: evalCase.schemaLanguage ?? question,
    response: evalCase.responseLanguage ?? question
  };
};

const runCase = async (
  evalCase: EvalCase,
  options: Options,
  harness: Harness
): Promise<CaseResult> => {
  const { ask, graders } = harness;
  const tags = evalCase.tags ?? [];

  if (evalCase.skip) {
    return {
      id: evalCase.id,
      tags,
      status: "skip",
      checks: [],
      failureCodes: [],
      question: evalCase.question,
      notes: evalCase.notes,
      elapsedMs: 0
    };
  }

  const languages = resolveLanguages(evalCase);
  const environmentId = evalCase.environmentId ?? options.environmentId;
  // Fresh chat per case: isolates the semantic cache and the conversation
  // history so cases cannot contaminate each other.
  const chatId = `eval-${evalCase.id}-${randomUUID().slice(0, 8)}`;

  const invoke = () =>
    ask(
      evalCase.question,
      chatId,
      languages.question,
      languages.schema,
      languages.response,
      undefined,
      environmentId
    );

  const startedAt = Date.now();

  try {
    // Multi-turn cases replay their prior turns first so follow-up questions
    // ("e no ano anterior?") are graded with the context they need.
    for (const previousQuestion of evalCase.history ?? []) {
      await ask(
        previousQuestion,
        chatId,
        languages.question,
        languages.schema,
        languages.response,
        undefined,
        environmentId
      );
    }

    let result = await invoke();
    let elapsedMs = Date.now() - startedAt;

    if (options.warm) {
      const warmStart = Date.now();
      result = await invoke();
      elapsedMs = Date.now() - warmStart;
    }

    const checks: CheckResult[] = [
      ...graders.gradeOutcome(evalCase, {
        ok: result.ok,
        errorMessage: result.ok ? undefined : result.error.errorMessage
      })
    ];

    if (result.ok) {
      checks.push(...graders.gradeSuccess(evalCase, result.data, languages.response));
    }

    const failureCodes = [
      ...new Set(checks.filter((check) => !check.ok && check.code).map((check) => check.code as FailureCode))
    ];

    return {
      id: evalCase.id,
      tags,
      status: failureCodes.length === 0 ? "pass" : "fail",
      checks,
      failureCodes,
      question: evalCase.question,
      notes: evalCase.notes,
      sql: result.ok ? result.data.sql : result.error.sql,
      summary: result.ok ? result.data.summary : undefined,
      rowCount: result.ok ? result.data.rows.length : undefined,
      elapsedMs,
      totalTokens: result.ok ? result.data.tokenUsage?.total.totalTokens : undefined,
      errorMessage: result.ok ? undefined : result.error.errorMessage
    };
  } catch (error) {
    // A thrown exception is itself a finding: the pipeline should return
    // ok:false, never reject.
    return {
      id: evalCase.id,
      tags,
      status: "fail",
      checks: [
        { name: "outcome", ok: false, code: "PIPELINE_ERROR", detail: (error as Error).message }
      ],
      failureCodes: ["PIPELINE_ERROR"],
      question: evalCase.question,
      notes: evalCase.notes,
      elapsedMs: Date.now() - startedAt,
      errorMessage: (error as Error).message
    };
  }
};

/** Bounded-concurrency map that preserves input order in the output. */
const runAll = async (
  cases: EvalCase[],
  options: Options,
  harness: Harness,
  onDone: (result: CaseResult, index: number) => void
): Promise<CaseResult[]> => {
  const results = new Array<CaseResult>(cases.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < cases.length) {
      const index = cursor;
      cursor += 1;
      const evalCase = cases[index];
      if (!evalCase) continue;
      const result = await runCase(evalCase, options, harness);
      results[index] = result;
      onDone(result, index);
    }
  };

  const workers = Array.from({ length: Math.min(options.concurrency, cases.length) }, worker);
  await Promise.all(workers);

  return results.filter((value): value is CaseResult => value !== undefined);
};

/* ── Reporting ────────────────────────────────────────────────────── */

const percentile = (sorted: number[], fraction: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
};

const gitInfo = (): { sha?: string; dirty?: boolean } => {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
    return { sha, dirty: status.length > 0 };
  } catch {
    return {};
  }
};

const buildReport = (
  results: CaseResult[],
  options: Options,
  startedAt: string,
  finishedAt: string
): RunReport => {
  const executed = results.filter((result) => result.status !== "skip");
  const passed = executed.filter((result) => result.status === "pass").length;
  const failed = executed.filter((result) => result.status === "fail").length;
  const skipped = results.length - executed.length;

  const failureCounts: Partial<Record<FailureCode, number>> = {};
  for (const result of results) {
    for (const code of result.failureCodes) {
      failureCounts[code] = (failureCounts[code] ?? 0) + 1;
    }
  }

  const latencies = executed.map((result) => result.elapsedMs).sort((a, b) => a - b);
  const totalTokens = executed.reduce((sum, result) => sum + (result.totalTokens ?? 0), 0);
  const { sha, dirty } = gitInfo();

  return {
    schemaVersion: 1,
    label: options.label,
    startedAt,
    finishedAt,
    gitSha: sha,
    gitDirty: dirty,
    // Every case runs on a fresh chatId, so the semantic cache is always cold
    // unless --warm asked for a second pass.
    cacheEnabled: options.warm,
    concurrency: options.concurrency,
    totals: {
      cases: results.length,
      passed,
      failed,
      skipped,
      passRate: executed.length === 0 ? 0 : passed / executed.length
    },
    failureCounts,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length > 0 ? (latencies[latencies.length - 1] ?? 0) : 0,
      mean:
        latencies.length === 0
          ? 0
          : Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
    },
    tokens: { total: totalTokens },
    results
  };
};

const printReport = (report: RunReport, options: Options): void => {
  const failures = report.results.filter((result) => result.status === "fail");

  if (failures.length > 0) {
    console.log("\n── Falhas ────────────────────────────────────────────");
    for (const result of failures) {
      console.log(`\n✗ ${result.id}  [${result.failureCodes.join(", ")}]`);
      console.log(`  pergunta: ${result.question}`);
      if (result.notes) console.log(`  por que existe: ${result.notes}`);
      for (const check of result.checks.filter((entry) => !entry.ok)) {
        console.log(`  · ${check.name}: ${check.detail ?? "falhou"}`);
      }
      if (result.sql && options.verbose) console.log(`  sql: ${result.sql.replace(/\s+/g, " ")}`);
      if (result.summary && options.verbose) console.log(`  resumo: ${result.summary}`);
    }
  }

  const { totals, latencyMs } = report;
  console.log("\n── Resumo ────────────────────────────────────────────");
  console.log(`label        ${report.label}`);
  console.log(`git          ${report.gitSha ?? "?"}${report.gitDirty ? " (dirty)" : ""}`);
  console.log(
    `casos        ${totals.cases} · ${totals.passed} pass · ${totals.failed} fail · ${totals.skipped} skip`
  );
  console.log(`taxa         ${(totals.passRate * 100).toFixed(1)}%`);
  console.log(
    `latencia     p50 ${latencyMs.p50}ms · p95 ${latencyMs.p95}ms · max ${latencyMs.max}ms${
      report.concurrency > 1 ? "  (concurrency>1: numeros nao comparaveis)" : ""
    }`
  );
  console.log(`tokens       ${report.tokens.total}`);

  const codes = Object.entries(report.failureCounts).sort(([, a], [, b]) => b - a);
  if (codes.length > 0) {
    console.log("\n── Falhas por tipo ───────────────────────────────────");
    for (const [code, count] of codes) {
      console.log(`  ${String(count).padStart(3)}  ${code.padEnd(26)} ${FAILURE_HINTS[code as FailureCode]}`);
    }
  }
};

/* ── Entry point ──────────────────────────────────────────────────── */

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const allCases = await loadCases();
  const selected = selectCases(allCases, options);

  // Reported before anything runs, on both paths: a regex that does not compile
  // fails its own case at grade time (BAD_PATTERN) rather than throwing, so
  // without this you would only find out one case at a time, after paying for
  // the run. Under --list it is the whole point — a lint with no environment.
  const badPatterns = findBadPatterns(selected);
  if (badPatterns.length > 0) {
    console.error(`\n[eval] ${badPatterns.length} regex invalida(s) nos casos:`);
    for (const bad of badPatterns) {
      console.error(`  ✗ ${bad.caseId} · ${bad.field}: /${bad.pattern}/ — ${bad.message}`);
    }
    console.error("");
  }

  if (options.list) {
    console.log(`${selected.length} caso(s):`);
    for (const evalCase of selected) {
      const flag = evalCase.skip ? "skip" : "    ";
      console.log(`  ${flag} ${evalCase.id.padEnd(28)} [${(evalCase.tags ?? []).join(", ")}]`);
      console.log(`       ${evalCase.question}`);
    }
    if (badPatterns.length > 0) process.exitCode = 1;
    return;
  }

  if (selected.length === 0) {
    console.error("[eval] nenhum caso selecionado — confira --only/--tags");
    process.exitCode = 1;
    return;
  }

  const harness = await loadPipeline();

  const startedAt = new Date().toISOString();
  console.log(`[eval] ${selected.length} caso(s), concurrency ${options.concurrency}\n`);

  const results = await runAll(selected, options, harness, (result, index) => {
    const symbol = result.status === "pass" ? "✓" : result.status === "skip" ? "-" : "✗";
    const position = `${String(index + 1).padStart(3)}/${selected.length}`;
    const codes = result.failureCodes.length > 0 ? `  ${result.failureCodes.join(",")}` : "";
    console.log(`${position} ${symbol} ${result.id.padEnd(28)} ${String(result.elapsedMs).padStart(6)}ms${codes}`);
  });

  const report = buildReport(results, options, startedAt, new Date().toISOString());
  printReport(report, options);

  await mkdir(RUNS_DIR, { recursive: true });
  const outputPath = path.join(RUNS_DIR, `${options.label}.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\n[eval] gravado em ${path.relative(process.cwd(), outputPath)}`);

  // Non-zero exit so CI can gate on it once the suite is trusted.
  if (report.totals.failed > 0) process.exitCode = 1;
};

main()
  .catch((error) => {
    console.error("[eval] erro fatal:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    // Mongo/Qdrant/SQL pools keep the loop alive; the run is done, so leave.
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  });
