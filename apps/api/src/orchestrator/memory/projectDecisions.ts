/**
 * Project decisions store — plan #4.
 *
 * Decisoes arquiteturais por repo (auth=session-cookie, state-mgmt=pinia, etc).
 * Lidas pelo getProjectContext e injetadas no planner system prompt como
 * "## Project Conventions" pra planner usar convencoes ja estabelecidas
 * em vez de assumir defaults.
 *
 * Fonte das decisoes:
 *   - "inferred": auto-detectadas via package.json (chamado on-demand)
 *   - "manual":   registradas via /api/projects/:id/decisions ou agent
 *
 * Storage: collection `project_decisions` com indice unico (repoKey, key).
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getProjectDecisionsCollection,
  type ProjectDecisionRecord
} from "../../core/mongo.js";

export type DecisionKey =
  | "primary-language"
  | "test-runner"
  | "state-mgmt"
  | "ui-framework"
  | "css-strategy"
  | "auth-strategy"
  | "orm"
  | "build-tool";

// ============== READ ==============

export const getProjectDecisions = async (repoKey: string): Promise<ProjectDecisionRecord[]> => {
  if (!repoKey) return [];
  try {
    const col = await getProjectDecisionsCollection();
    return await col.find({ repoKey }).sort({ key: 1 }).toArray();
  } catch (err) {
    console.warn("[project-decisions] read failed:", err);
    return [];
  }
};

/**
 * Formata decisoes pra bloco markdown injetavel em system prompts.
 * Caller usa direto OU via getProjectContext (que ja inclui).
 */
export const formatDecisionsBlock = (decisions: ProjectDecisionRecord[]): string => {
  if (decisions.length === 0) return "";
  const lines = ["Project Conventions (decisoes arquiteturais ja estabelecidas — REUTILIZE):"];
  for (const d of decisions) {
    const suffix = d.source === "inferred" ? " (inferido)" : "";
    lines.push(`- ${d.key}: ${d.value}${suffix}`);
  }
  return lines.join("\n");
};

// ============== WRITE ==============

export const setProjectDecision = async (
  repoKey: string,
  key: string,
  value: string,
  source: "inferred" | "manual" = "manual",
  confidence?: number
): Promise<void> => {
  if (!repoKey || !key || !value) return;
  try {
    const col = await getProjectDecisionsCollection();
    await col.updateOne(
      { repoKey, key },
      {
        $set: {
          repoKey,
          key,
          value,
          source,
          ...(typeof confidence === "number" ? { confidence } : {}),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  } catch (err) {
    console.warn("[project-decisions] write failed:", err);
  }
};

export const deleteProjectDecision = async (repoKey: string, key: string): Promise<boolean> => {
  try {
    const col = await getProjectDecisionsCollection();
    const r = await col.deleteOne({ repoKey, key });
    return (r.deletedCount ?? 0) > 0;
  } catch {
    return false;
  }
};

// ============== INFERENCE ==============

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

/**
 * Inferencia rapida a partir do package.json. Roda 1x por repo (chamada on-demand).
 * Marca todas as decisoes com source="inferred" + confidence proporcional ao
 * sinal (dep direta > devDep, signature exata > heuristica).
 */
export const inferDecisionsFromWorktree = async (
  worktreePath: string,
  repoKey: string
): Promise<{ inferred: number }> => {
  if (!worktreePath || !repoKey) return { inferred: 0 };
  const pkgPath = join(worktreePath, "package.json");
  if (!existsSync(pkgPath)) return { inferred: 0 };

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as PackageJson;
  } catch {
    return { inferred: 0 };
  }

  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const has = (name: string): boolean => name in deps;

  const decisions: Array<{ key: string; value: string; confidence: number }> = [];

  // primary-language
  if (has("typescript")) decisions.push({ key: "primary-language", value: "typescript", confidence: 1 });

  // ui-framework
  if (has("vue")) decisions.push({ key: "ui-framework", value: "vue", confidence: 1 });
  else if (has("react")) decisions.push({ key: "ui-framework", value: "react", confidence: 1 });
  else if (has("svelte")) decisions.push({ key: "ui-framework", value: "svelte", confidence: 1 });
  else if (has("@angular/core")) decisions.push({ key: "ui-framework", value: "angular", confidence: 1 });

  // state-mgmt
  if (has("pinia")) decisions.push({ key: "state-mgmt", value: "pinia", confidence: 1 });
  else if (has("@reduxjs/toolkit") || has("redux")) decisions.push({ key: "state-mgmt", value: "redux", confidence: 1 });
  else if (has("vuex")) decisions.push({ key: "state-mgmt", value: "vuex", confidence: 1 });
  else if (has("zustand")) decisions.push({ key: "state-mgmt", value: "zustand", confidence: 1 });
  else if (has("jotai")) decisions.push({ key: "state-mgmt", value: "jotai", confidence: 1 });

  // build-tool
  if (has("vite")) decisions.push({ key: "build-tool", value: "vite", confidence: 1 });
  else if (has("next")) decisions.push({ key: "build-tool", value: "next", confidence: 1 });
  else if (has("nuxt")) decisions.push({ key: "build-tool", value: "nuxt", confidence: 1 });
  else if (has("webpack")) decisions.push({ key: "build-tool", value: "webpack", confidence: 0.8 });

  // test-runner
  if (has("vitest")) decisions.push({ key: "test-runner", value: "vitest", confidence: 1 });
  else if (has("jest")) decisions.push({ key: "test-runner", value: "jest", confidence: 1 });
  else if (has("@playwright/test")) decisions.push({ key: "test-runner", value: "playwright", confidence: 0.8 });

  // css-strategy
  if (has("tailwindcss")) decisions.push({ key: "css-strategy", value: "tailwindcss", confidence: 1 });
  else if (has("sass") || has("node-sass")) decisions.push({ key: "css-strategy", value: "sass", confidence: 0.7 });
  else if (has("styled-components")) decisions.push({ key: "css-strategy", value: "styled-components", confidence: 1 });
  else if (has("@emotion/react") || has("@emotion/styled")) decisions.push({ key: "css-strategy", value: "emotion", confidence: 1 });

  // orm
  if (has("@prisma/client")) decisions.push({ key: "orm", value: "prisma", confidence: 1 });
  else if (has("drizzle-orm")) decisions.push({ key: "orm", value: "drizzle", confidence: 1 });
  else if (has("mongoose")) decisions.push({ key: "orm", value: "mongoose", confidence: 1 });
  else if (has("typeorm")) decisions.push({ key: "orm", value: "typeorm", confidence: 1 });
  else if (has("sequelize")) decisions.push({ key: "orm", value: "sequelize", confidence: 0.9 });

  // auth-strategy (heuristica baseada em deps comuns)
  if (has("@fastify/jwt") || has("jsonwebtoken")) decisions.push({ key: "auth-strategy", value: "jwt", confidence: 0.8 });
  else if (has("passport")) decisions.push({ key: "auth-strategy", value: "passport", confidence: 0.8 });
  else if (has("next-auth")) decisions.push({ key: "auth-strategy", value: "next-auth", confidence: 1 });

  // Persiste todas via bulk upsert
  for (const d of decisions) {
    await setProjectDecision(repoKey, d.key, d.value, "inferred", d.confidence);
  }

  return { inferred: decisions.length };
};
