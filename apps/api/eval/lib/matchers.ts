import type { CaseExpect, EvalCase } from "../types.js";

/**
 * Regex handling for case expectations.
 *
 * Lives under `lib/` and imports nothing from `src/` on purpose: `graders.ts`
 * reaches into `src/agents/summary.ts` for the year helpers, which pulls in
 * `src/core/config.ts` and aborts the process on a missing JWT_SECRET. Keeping
 * the pattern logic here is what makes it unit-testable with no environment.
 *
 * Two rules apply to every regex a case file can carry:
 *
 *   - Case-insensitive, matched against the *raw* text. Accent folding is what
 *     the `answerContains` substring matchers are for; a regex author who needs
 *     it can write `[eé]`. Folding the pattern instead would silently rewrite
 *     `\D` into `\d`, so it is not an option.
 *   - An invalid pattern fails its own case with the compile error. It used to
 *     throw out of `new RegExp`, which took the entire run down for one typo in
 *     one case file.
 */

export type CompiledMatcher =
  | { ok: true; regex: RegExp }
  | { ok: false; message: string };

export const compileMatcher = (pattern: string): CompiledMatcher => {
  try {
    return { ok: true, regex: new RegExp(pattern, "i") };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
};

/** Every `expect` field holding regexes. Order is the order they are reported. */
const PATTERN_FIELDS = [
  "sqlMustMatch",
  "sqlMustNotMatch",
  "answerMustMatch",
  "answerMustNotMatch"
] as const satisfies readonly (keyof CaseExpect)[];

export type PatternField = (typeof PATTERN_FIELDS)[number];

export type BadPattern = {
  caseId: string;
  field: PatternField;
  pattern: string;
  message: string;
};

/**
 * Static lint over the suite. Feeds `--list`, which needs no environment, so an
 * unparseable regex is caught before you spend a full run discovering it.
 */
export const findBadPatterns = (cases: EvalCase[]): BadPattern[] => {
  const bad: BadPattern[] = [];

  for (const evalCase of cases) {
    for (const field of PATTERN_FIELDS) {
      for (const pattern of evalCase.expect?.[field] ?? []) {
        const compiled = compileMatcher(pattern);
        if (!compiled.ok) {
          bad.push({ caseId: evalCase.id, field, pattern, message: compiled.message });
        }
      }
    }
  }

  return bad;
};
