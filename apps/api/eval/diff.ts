/**
 * Compare two eval runs.
 *
 *   npm run eval -- --label antes
 *   ...change something...
 *   npm run eval -- --label depois
 *   npm run eval:diff -- antes depois
 *
 * With no arguments the two most recent runs are compared.
 *
 * The output separates *regressions* (was passing, now fails) from *fixes*
 * (was failing, now passes). A net pass-rate delta alone hides the case where a
 * change fixes three cases and breaks three others — which is not progress, it
 * is churn, and it should be visible.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CaseResult, FailureCode, RunReport } from "./types.js";
import { FAILURE_HINTS } from "./types.js";

const RUNS_DIR = path.join(import.meta.dirname, "runs");

const loadReport = async (label: string): Promise<RunReport> => {
  const candidate = label.endsWith(".json") ? label : `${label}.json`;
  const filePath = path.isAbsolute(candidate) ? candidate : path.join(RUNS_DIR, candidate);
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as RunReport;
  if (parsed.schemaVersion !== 1) {
    throw new Error(`${filePath}: schemaVersion ${parsed.schemaVersion} nao suportado`);
  }
  return parsed;
};

const twoMostRecent = async (): Promise<[string, string]> => {
  const entries = (await readdir(RUNS_DIR)).filter((name) => name.endsWith(".json"));
  if (entries.length < 2) {
    throw new Error(`Precisa de 2 runs em ${RUNS_DIR}, encontrei ${entries.length}`);
  }

  const withTimes = await Promise.all(
    entries.map(async (name) => ({
      name,
      mtime: (await stat(path.join(RUNS_DIR, name))).mtimeMs
    }))
  );

  withTimes.sort((a, b) => b.mtime - a.mtime);
  const [newest, previous] = withTimes;
  if (!newest || !previous) throw new Error("runs insuficientes");
  // Older first, so the diff reads as before → after.
  return [previous.name, newest.name];
};

const signed = (value: number, digits = 0): string =>
  `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;

const indexById = (results: CaseResult[]): Map<string, CaseResult> =>
  new Map(results.map((result) => [result.id, result]));

const main = async (): Promise<void> => {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const [beforeLabel, afterLabel] = args.length >= 2 ? [args[0]!, args[1]!] : await twoMostRecent();

  const before = await loadReport(beforeLabel);
  const after = await loadReport(afterLabel);

  const beforeById = indexById(before.results);
  const afterById = indexById(after.results);

  const regressions: CaseResult[] = [];
  const fixes: CaseResult[] = [];
  const stillFailing: CaseResult[] = [];
  const added: CaseResult[] = [];
  const removed: CaseResult[] = [];
  const codeChanged: Array<{ result: CaseResult; from: FailureCode[]; to: FailureCode[] }> = [];

  for (const [id, afterResult] of afterById) {
    const beforeResult = beforeById.get(id);
    if (!beforeResult) {
      added.push(afterResult);
      continue;
    }
    if (beforeResult.status === "pass" && afterResult.status === "fail") {
      regressions.push(afterResult);
    } else if (beforeResult.status === "fail" && afterResult.status === "pass") {
      fixes.push(afterResult);
    } else if (beforeResult.status === "fail" && afterResult.status === "fail") {
      stillFailing.push(afterResult);
      const from = [...beforeResult.failureCodes].sort();
      const to = [...afterResult.failureCodes].sort();
      // Same verdict, different reason — usually means a fix landed and exposed
      // the next defect underneath it.
      if (from.join("|") !== to.join("|")) {
        codeChanged.push({ result: afterResult, from, to });
      }
    }
  }

  for (const [id, beforeResult] of beforeById) {
    if (!afterById.has(id)) removed.push(beforeResult);
  }

  console.log(`antes   ${before.label}  (${before.gitSha ?? "?"}${before.gitDirty ? " dirty" : ""})`);
  console.log(`depois  ${after.label}  (${after.gitSha ?? "?"}${after.gitDirty ? " dirty" : ""})`);

  if (before.cacheEnabled !== after.cacheEnabled) {
    console.log("\n⚠ runs com modos de cache diferentes — latencia nao e comparavel");
  }
  if (before.concurrency !== after.concurrency) {
    console.log("⚠ concurrency diferente entre os runs — latencia nao e comparavel");
  }

  const rateDelta = (after.totals.passRate - before.totals.passRate) * 100;
  console.log("\n── Totais ────────────────────────────────────────────");
  console.log(
    `taxa      ${(before.totals.passRate * 100).toFixed(1)}%  →  ${(after.totals.passRate * 100).toFixed(1)}%   (${signed(rateDelta, 1)} pp)`
  );
  console.log(
    `pass      ${before.totals.passed}  →  ${after.totals.passed}   (${signed(after.totals.passed - before.totals.passed)})`
  );
  console.log(
    `fail      ${before.totals.failed}  →  ${after.totals.failed}   (${signed(after.totals.failed - before.totals.failed)})`
  );
  console.log(
    `p50       ${before.latencyMs.p50}ms  →  ${after.latencyMs.p50}ms   (${signed(after.latencyMs.p50 - before.latencyMs.p50)}ms)`
  );
  console.log(
    `p95       ${before.latencyMs.p95}ms  →  ${after.latencyMs.p95}ms   (${signed(after.latencyMs.p95 - before.latencyMs.p95)}ms)`
  );
  console.log(
    `tokens    ${before.tokens.total}  →  ${after.tokens.total}   (${signed(after.tokens.total - before.tokens.total)})`
  );

  if (regressions.length > 0) {
    console.log(`\n── REGRESSOES (${regressions.length}) ───────────────────────────`);
    for (const result of regressions) {
      console.log(`  ✗ ${result.id}  [${result.failureCodes.join(", ")}]`);
      for (const check of result.checks.filter((entry) => !entry.ok)) {
        console.log(`      ${check.name}: ${check.detail ?? "falhou"}`);
      }
    }
  }

  if (fixes.length > 0) {
    console.log(`\n── Corrigidos (${fixes.length}) ──────────────────────────────`);
    for (const result of fixes) console.log(`  ✓ ${result.id}`);
  }

  if (codeChanged.length > 0) {
    console.log(`\n── Ainda falhando, por outro motivo (${codeChanged.length}) ──────`);
    for (const entry of codeChanged) {
      console.log(`  ~ ${entry.result.id}: ${entry.from.join(",") || "-"} → ${entry.to.join(",") || "-"}`);
    }
  }

  if (added.length > 0) {
    console.log(`\n── Casos novos (${added.length}) ─────────────────────────────`);
    for (const result of added) {
      console.log(`  + ${result.id} (${result.status})`);
    }
  }

  if (removed.length > 0) {
    console.log(`\n── Casos removidos (${removed.length}) ───────────────────────`);
    for (const result of removed) console.log(`  - ${result.id}`);
  }

  const codes = new Set<FailureCode>([
    ...(Object.keys(before.failureCounts) as FailureCode[]),
    ...(Object.keys(after.failureCounts) as FailureCode[])
  ]);

  const rows = [...codes]
    .map((code) => ({
      code,
      before: before.failureCounts[code] ?? 0,
      after: after.failureCounts[code] ?? 0
    }))
    .filter((row) => row.before !== row.after)
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));

  if (rows.length > 0) {
    console.log("\n── Falhas por tipo (so o que mudou) ──────────────────");
    for (const row of rows) {
      const delta = row.after - row.before;
      const marker = delta > 0 ? "↑" : "↓";
      console.log(
        `  ${marker} ${row.code.padEnd(26)} ${row.before} → ${row.after}   ${FAILURE_HINTS[row.code]}`
      );
    }
  }

  console.log("");
  if (regressions.length > 0) {
    console.log(`veredito: ${regressions.length} regressao(oes) — nao subir sem explicar`);
    process.exitCode = 1;
  } else if (fixes.length > 0) {
    console.log(`veredito: ${fixes.length} corrigido(s), 0 regressoes`);
  } else {
    console.log("veredito: sem mudanca de status em nenhum caso");
  }
};

main().catch((error) => {
  console.error("[eval:diff] erro:", (error as Error).message);
  process.exitCode = 1;
});
