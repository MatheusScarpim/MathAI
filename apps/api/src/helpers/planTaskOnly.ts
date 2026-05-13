/**
 * Plan-only entry point: roda o planner + filtragem de subtasks SEM executar.
 *
 * Reutiliza a mesma logica do pipeline (build context, call planTask, filter por
 * integracoes disponiveis) mas para uso fora do pipeline — bots, previews,
 * dry-runs, etc.
 *
 * Retorna: subtasks resolvidas (formato pronto pra executeTask via presetSubtasks)
 * + contexto de execucao (github/trello ja resolvidos) pra evitar replanejar
 * quando o user aprovar o plano.
 */

import { planTask, type PlannedSubTask } from "../orchestrator/agents/planner.js";
import { config } from "../core/config.js";
import {
  ensureBaseRepo,
  getRepoTree
} from "../orchestrator/integrations/github.js";
import { getBoardLists } from "../orchestrator/integrations/trello.js";
import type { GithubRepoConfig, SubTaskType } from "../orchestrator/types.js";

export type PlanTaskOnlyInput = {
  description: string;
  language: "pt" | "en" | "es";
  github?: GithubRepoConfig[];
  trello?: { boardId?: string; listId?: string; doneListId?: string };
};

export type PlanTaskOnlyResult = {
  /** Subtasks ja filtradas por integracoes disponiveis. Formato pronto pra pipeline. */
  subtasks: PlannedSubTask[];
  /** Contexto de execucao resolvido — passar de volta pro executeTask se aprovar. */
  resolvedGithub?: GithubRepoConfig[];
  resolvedTrello?: { boardId: string; listId?: string; doneListId?: string };
  warnings: string[];
};

/** Normaliza github option pra array. */
const normalizeRepos = (github?: GithubRepoConfig[] | GithubRepoConfig): GithubRepoConfig[] => {
  if (!github) return [];
  if (Array.isArray(github)) return github;
  return [github];
};

export const planTaskOnly = async (input: PlanTaskOnlyInput): Promise<PlanTaskOnlyResult> => {
  const warnings: string[] = [];
  const plannerContext: Parameters<typeof planTask>[1] = {};
  const availableTypes: SubTaskType[] = ["api", "custom"];

  // Resolve repos (with tree pra dar contexto bom ao planner)
  const repos = normalizeRepos(input.github);
  if (repos.length > 0) {
    availableTypes.push("github");
    const repoContexts: { name: string; owner: string; repo: string; tree?: string }[] = [];
    for (const r of repos) {
      try {
        const basePath = await ensureBaseRepo(r.owner, r.repo, r.token);
        const tree = await getRepoTree(basePath);
        repoContexts.push({ name: r.name || r.repo, owner: r.owner, repo: r.repo, tree });
      } catch (err) {
        warnings.push(`Falha ao resolver repo ${r.owner}/${r.repo}: ${err instanceof Error ? err.message : String(err)}`);
        repoContexts.push({ name: r.name || r.repo, owner: r.owner, repo: r.repo });
      }
    }
    plannerContext.repos = repoContexts;
  }

  // Trello
  const hasTrello = !!(input.trello?.boardId || config.trello.defaultBoardId);
  if (hasTrello) {
    availableTypes.push("trello");
    const boardId = input.trello?.boardId || config.trello.defaultBoardId;
    try {
      const lists = await getBoardLists(boardId!);
      plannerContext.trelloBoardLists = lists.map(l => ({ id: l.id, name: l.name }));
    } catch (err) {
      warnings.push(`Falha ao listar Trello lists: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  plannerContext.availableTypes = availableTypes;

  const planResult = await planTask(input.description, plannerContext, input.language);

  // Filtra por integracoes disponiveis (mesma logica do pipeline)
  const filtered = planResult.subtasks.filter(st => {
    if (st.type === "trello" && !hasTrello) return false;
    if (st.type === "github" && repos.length === 0) return false;
    return true;
  });

  let resolvedTrello: PlanTaskOnlyResult["resolvedTrello"];
  if (input.trello?.boardId) {
    resolvedTrello = {
      boardId: input.trello.boardId,
      listId: input.trello.listId,
      doneListId: input.trello.doneListId
    };
  } else if (config.trello.defaultBoardId) {
    resolvedTrello = { boardId: config.trello.defaultBoardId };
  }

  return {
    subtasks: filtered,
    resolvedGithub: repos.length > 0 ? repos : undefined,
    resolvedTrello,
    warnings
  };
};
