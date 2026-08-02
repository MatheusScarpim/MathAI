import { detectLanguage, type LanguageDetection } from "../../src/helpers/detectLanguage.js";
import type { Lang } from "../types.js";

/**
 * Language grading for the eval suite.
 *
 * The detector itself lives in `src/helpers/detectLanguage.ts` and is shared with
 * the request pipeline (review item #2) on purpose: if the harness carried its
 * own copy, a case could pass here and still be misrouted in production, which
 * is the exact class of bug the suite is supposed to catch.
 */

export const foldText = (value: string): string =>
  value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/**
 * Whether `text` is confidently *not* written in `expected`.
 *
 * Asymmetric on purpose, and it reuses the pipeline's own `confident` flag
 * rather than inventing a second threshold. A weak signal must never fail a
 * case: short numeric answers ("R$ 1,2 mi em 2024") legitimately carry almost no
 * linguistic signal, and failing those would bury real regressions in noise.
 * Only a well-separated verdict for a *different* language counts as a failure.
 */
export const isConfidentlyNotLanguage = (
  text: string,
  expected: Lang
): { mismatch: boolean; detection: LanguageDetection } => {
  const detection = detectLanguage(text);
  const mismatch =
    detection.confident && detection.language !== null && detection.language !== expected;

  return { mismatch, detection };
};
