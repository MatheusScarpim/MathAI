import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * `summarizeResult` takes the detected year range as its 6th argument. Without it
 * the summary falls back to `extractYearsFromSql`, which reads a range filter as
 * a two-point comparison: a SQL of the shape `BETWEEN 2017 AND 2025` yields
 * `[2017, 2025]`, so the model is told "the query compares these periods" and is
 * forbidden from citing 2018-2024 even though those rows are right there.
 *
 * The pure functions in `summaryPeriod.test.ts` already cover that behaviour. What
 * they cannot see is a *call-site that forgets to pass the argument* — which is
 * exactly how this shipped: three of the four call-sites were wired and the fourth
 * (the semantic-cache hit, which duplicates the main path higher up in the file)
 * silently kept the old reading. TypeScript cannot catch it either, because the
 * parameter is optional with a `null` default.
 *
 * So this test reads the sources. It is deliberately structural rather than
 * behavioural: the alternative is a live DB plus a live LLM.
 */

const pipelineDir = dirname(fileURLToPath(import.meta.url));

const FILES = ["ask.ts", "askApi.ts"];

/** Matches a `summarizeResult(...)` call and captures its argument list. */
const CALL_PATTERN = /summarizeResult\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g;

const findCalls = (source: string): string[] => {
  const calls: string[] = [];
  for (const match of source.matchAll(CALL_PATTERN)) {
    if (match[1] !== undefined) calls.push(match[1]);
  }
  return calls;
};

/**
 * Counts top-level commas, so nested calls like `result.recordset ?? []` and
 * `foo(a, b)` do not inflate the arity.
 */
const countArgs = (argList: string): number => {
  let depth = 0;
  let args = 1;
  for (const char of argList) {
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) args += 1;
  }
  return args;
};

describe("summarizeResult — todo call-site passa o range", () => {
  for (const file of FILES) {
    it(`${file} nao tem chamada sem o 6o argumento`, () => {
      const source = readFileSync(join(pipelineDir, file), "utf8");
      const calls = findCalls(source);

      assert.ok(calls.length > 0, `nenhuma chamada de summarizeResult encontrada em ${file}`);

      for (const argList of calls) {
        assert.equal(
          countArgs(argList),
          6,
          `chamada com ${countArgs(argList)} argumentos em ${file} — falta o range: summarizeResult(${argList})`
        );
      }
    });
  }

  it("cobre o caminho de cache do ask.ts, que foi o que escapou", () => {
    const source = readFileSync(join(pipelineDir, "ask.ts"), "utf8");
    // The range must be computed before the semantic-cache branch returns, or the
    // cache hit has nothing to pass.
    const rangeIndex = source.indexOf("const detectedRange =");
    const cacheBranchIndex = source.indexOf("if (semanticMatch?.sql && !shouldSkipCache)");

    assert.notEqual(rangeIndex, -1, "detectedRange nao encontrado em ask.ts");
    assert.notEqual(cacheBranchIndex, -1, "branch de cache semantico nao encontrado em ask.ts");
    assert.ok(
      rangeIndex < cacheBranchIndex,
      "detectedRange e calculado depois do branch de cache — o cache hit retorna sem o range"
    );
  });
});
