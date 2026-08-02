/**
 * Draft eval cases from real history — the practical way to reach 50 cases.
 *
 *   npm run eval:bootstrap -- --limit 60 --out drafts.json
 *   npm run eval:bootstrap -- --favorites --limit 30
 *
 * Writes eval/cases/<out>.json with every case marked `"skip": true`.
 *
 * They stay skipped until a human reviews them, and that is the whole point: a
 * case generated from a past answer asserts that the past answer was *correct*,
 * which nobody has checked. Auto-enabling them would freeze today's bugs into
 * the baseline as expected behaviour — the suite would then defend the defects
 * it exists to find.
 *
 * Review checklist per draft:
 *   1. Is the recorded answer actually right? If not, fix `expect` or drop it.
 *   2. Tighten `expect`: add sqlMustMatch for the table that must be used, and
 *      expectedValue when you know the true number.
 *   3. Remove `skip` and commit.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { getHistoryCollection } from "../src/core/mongo.js";
import { extractYearsFromSql } from "../src/agents/summary.js";
import type { EvalCase, Lang } from "./types.js";

const CASES_DIR = path.join(import.meta.dirname, "cases");

type Options = { limit: number; out: string; favoritesOnly: boolean; environmentId?: string };

const parseArgs = (argv: string[]): Options => {
  const options: Options = { limit: 50, out: "drafts.json", favoritesOnly: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--limit") {
      options.limit = Math.max(1, Number.parseInt(next ?? "50", 10) || 50);
      index += 1;
    } else if (arg === "--out") {
      if (next) options.out = next.endsWith(".json") ? next : `${next}.json`;
      index += 1;
    } else if (arg === "--env") {
      options.environmentId = next;
      index += 1;
    } else if (arg === "--favorites") {
      options.favoritesOnly = true;
    }
  }

  return options;
};

/** Stable, readable id from the question text. */
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44) || "caso";

/**
 * Collapse questions that differ only in whitespace, punctuation or the year
 * mentioned. Fifty near-identical "faturamento de <ano>" cases measure one code
 * path fifty times and tell you nothing new.
 */
const shapeKey = (question: string): string =>
  question
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b\d+\b/g, "#")
    .replace(/[^a-z0-9#]+/g, " ")
    .trim();

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const collection = await getHistoryCollection();

  const filter: Record<string, unknown> = {
    deletedAt: { $exists: false },
    success: true,
    sql: { $exists: true, $ne: "" }
  };
  if (options.favoritesOnly) filter.favorite = true;
  if (options.environmentId) filter.environmentId = options.environmentId;

  // Favourites first (a human already vouched for them), then most recent.
  const docs = await collection
    .find(filter, {
      projection: {
        question: 1, sql: 1, summary: 1, language: 1, responseLanguage: 1,
        environmentId: 1, rowCount: 1, elapsedMs: 1, favorite: 1, tags: 1, createdAt: 1
      }
    })
    .sort({ favorite: -1, createdAt: -1 })
    .limit(options.limit * 4)
    .toArray();

  const cases: EvalCase[] = [];
  const usedIds = new Set<string>();
  const usedShapes = new Set<string>();
  let skippedDuplicates = 0;

  for (const doc of docs) {
    if (cases.length >= options.limit) break;
    const question = doc.question?.trim();
    if (!question || !doc.sql?.trim()) continue;

    const shape = shapeKey(question);
    if (usedShapes.has(shape)) {
      skippedDuplicates += 1;
      continue;
    }
    usedShapes.add(shape);

    let id = slugify(question);
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${slugify(question)}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);

    const language = (doc.language ?? "pt") as Lang;
    const sqlYears = extractYearsFromSql(doc.sql);
    const rowCount = typeof doc.rowCount === "number" ? doc.rowCount : undefined;

    const evalCase: EvalCase = {
      id,
      question,
      language,
      ...(doc.responseLanguage ? { responseLanguage: doc.responseLanguage as Lang } : {}),
      ...(doc.environmentId ? { environmentId: doc.environmentId } : {}),
      tags: ["historico", ...(doc.favorite ? ["favorito"] : [])],
      skip: true,
      notes: `Rascunho gerado do historico (${new Date(doc.createdAt).toISOString().slice(0, 10)}${
        doc.favorite ? ", favoritado" : ""
      }). REVISAR antes de habilitar: confirme que a resposta registrada estava correta.`,
      expect: {
        // Only assertions that are safe to derive mechanically. Row counts are
        // recorded as an exact value the reviewer can tighten or loosen, never
        // as a range invented here.
        ...(sqlYears.length > 0 ? { sqlYears } : {}),
        ...(rowCount !== undefined ? { exactRows: rowCount } : {}),
        summaryYearsSubsetOfSql: true,
        assertLanguage: true
      }
    };

    cases.push(evalCase);
  }

  const outputPath = path.join(CASES_DIR, options.out);
  await writeFile(outputPath, `${JSON.stringify(cases, null, 2)}\n`, "utf8");

  console.log(`[bootstrap] ${cases.length} rascunho(s) em ${path.relative(process.cwd(), outputPath)}`);
  if (skippedDuplicates > 0) {
    console.log(`[bootstrap] ${skippedDuplicates} pergunta(s) ignorada(s) por serem variacao da mesma forma`);
  }
  console.log('[bootstrap] todos com "skip": true — revise um por um e remova o skip');
};

main()
  .catch((error) => {
    console.error("[bootstrap] erro:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
  });
