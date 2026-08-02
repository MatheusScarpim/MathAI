import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { compileMatcher, findBadPatterns } from "./matchers.js";
import type { EvalCase } from "../types.js";

/**
 * These live here rather than in a `graders.test.ts` because importing
 * `eval/graders.ts` pulls `src/core/config.ts` through `src/agents/summary.ts`,
 * and config calls `process.exit` on a missing JWT_SECRET — the test file would
 * kill the whole `npm test` run before asserting anything. Keeping the pattern
 * logic in an env-free module is what makes it testable at all.
 */

describe("compileMatcher", () => {
  it("compiles case-insensitively", () => {
    const compiled = compileMatcher("FROM vendas");
    assert.equal(compiled.ok, true);
    assert.ok(compiled.ok && compiled.regex.test("select * from Vendas"));
  });

  it("reports an invalid pattern instead of throwing", () => {
    // The whole reason this function exists: `new RegExp("[unclosed")` threw
    // straight out of the grader and aborted the run for one bad case file.
    const compiled = compileMatcher("[unclosed");
    assert.equal(compiled.ok, false);
    assert.ok(!compiled.ok && compiled.message.length > 0);
  });

  it("does not fold accents in the pattern", () => {
    // Folding the pattern would rewrite `\D` into `\d` and silently invert the
    // matcher, so accents are the author's job. Documented in CaseExpect.
    const compiled = compileMatcher("m\u00eas");
    assert.ok(compiled.ok && !compiled.regex.test("mes"));
    assert.ok(compiled.ok && compiled.regex.test("M\u00caS"));
  });

  it("keeps negated character classes intact", () => {
    const compiled = compileMatcher("\\D+");
    assert.ok(compiled.ok && compiled.regex.test("abc"));
    assert.ok(compiled.ok && !compiled.regex.test("123"));
  });
});

describe("findBadPatterns", () => {
  const caseWith = (expect: EvalCase["expect"]): EvalCase => ({
    id: "c1",
    question: "q",
    expect
  });

  it("returns nothing for a clean suite", () => {
    const cases = [
      caseWith({ sqlMustMatch: ["FROM \\w+"], answerMustNotMatch: ["\\b20\\d{2}\\b"] }),
      caseWith({ shouldSucceed: false })
    ];
    assert.deepEqual(findBadPatterns(cases), []);
  });

  it("finds a bad pattern in each regex field", () => {
    const fields = [
      "sqlMustMatch",
      "sqlMustNotMatch",
      "answerMustMatch",
      "answerMustNotMatch"
    ] as const;

    for (const field of fields) {
      const bad = findBadPatterns([caseWith({ [field]: ["(unclosed"] })]);
      assert.equal(bad.length, 1, `nao detectou em ${field}`);
      assert.equal(bad[0]!.field, field);
      assert.equal(bad[0]!.pattern, "(unclosed");
      assert.equal(bad[0]!.caseId, "c1");
    }
  });

  it("does not inspect the substring fields", () => {
    // `answerContains` is a literal substring list, so "(" is legal content
    // there and must not be reported as a broken regex.
    const bad = findBadPatterns([caseWith({ answerContains: ["(total"] })]);
    assert.deepEqual(bad, []);
  });

  it("reports every offender across cases, not just the first", () => {
    const bad = findBadPatterns([
      { id: "a", question: "q", expect: { sqlMustMatch: ["("] } },
      { id: "b", question: "q" },
      { id: "c", question: "q", expect: { answerMustMatch: ["["], answerMustNotMatch: ["*"] } }
    ]);

    assert.deepEqual(
      bad.map((entry) => `${entry.caseId}.${entry.field}`),
      ["a.sqlMustMatch", "c.answerMustMatch", "c.answerMustNotMatch"]
    );
  });

  it("tolerates a case with no expect block", () => {
    assert.deepEqual(findBadPatterns([{ id: "a", question: "q" }]), []);
  });
});

describe("year-shape pattern used by ano-sem-filtro-pt", () => {
  // The case forbids any 4-digit year in the summary. If this pattern is wrong,
  // the case is decorative — which is exactly what it was before.
  const pattern = "\\b(19|20)\\d{2}\\b";
  const compiled = compileMatcher(pattern);
  const matches = (text: string): boolean => compiled.ok && compiled.regex.test(text);

  it("catches an invented period", () => {
    assert.equal(matches("O faturamento total foi de R$ 12 mi em 2024."), true);
  });

  it("ignores a plain total with no period", () => {
    assert.equal(matches("O faturamento total de todos os tempos foi de R$ 12 mi."), false);
  });

  it("does not fire on a large number that merely contains four digits", () => {
    // `\b` on both sides is what keeps "R$ 1.234.567" and "12000 pedidos" from
    // reading as years.
    assert.equal(matches("total de 12000 pedidos"), false);
    assert.equal(matches("R$ 1.234.567,00"), false);
  });
});
