/**
 * Resolve `TaskExecuteOptions` (github + trello) a partir de um projectId.
 *
 * Mesmo papel de `buildGithubConfig` e `resolveTrelloOpts` em routes/task.ts,
 * mas comecando do projeto persistido em vez de um body HTTP.
 *
 * Uso: bots (Telegram/WhatsApp), schedulers, e qualquer trigger que opere
 * a partir de um projeto pre-configurado.
 */

import { ObjectId } from "mongodb";
import {
  getProjectsCollection,
  getGithubReposCollection,
  type ProjectRecord
} from "../core/mongo.js";
import { decryptToken } from "../core/repoCrypto.js";
import { getIntegrationsSettings } from "./settings.js";
import { config } from "../core/config.js";
import type { GithubRepoConfig } from "../orchestrator/types.js";

export type ResolvedProjectOptions = {
  project: ProjectRecord;
  github?: GithubRepoConfig[];
  trello?: {
    boardId: string;
    listId?: string;
    doneListId?: string;
    agentEnabled?: boolean;
    agentCreateCards?: boolean;
  };
};

/** Carrega projeto + GitHub repos + Trello config consolidados. Retorna null se projeto nao existir. */
export const resolveProjectOptions = async (
  projectId: string
): Promise<ResolvedProjectOptions | null> => {
  if (!ObjectId.isValid(projectId)) return null;

  const projectsCol = await getProjectsCollection();
  const project = await projectsCol.findOne({ _id: new ObjectId(projectId) });
  if (!project) return null;

  // ── GitHub repos ──
  let github: GithubRepoConfig[] | undefined;
  const repoIds = (project.repoIds ?? []).filter(id => ObjectId.isValid(id));
  if (repoIds.length > 0) {
    const reposCol = await getGithubReposCollection();
    const docs = await reposCol
      .find({ _id: { $in: repoIds.map(id => new ObjectId(id)) } })
      .toArray();
    const resolved: GithubRepoConfig[] = [];
    for (const doc of docs) {
      try {
        resolved.push({
          name: doc.name || doc.repo,
          owner: doc.owner,
          repo: doc.repo,
          baseBranch: doc.baseBranch,
          token: decryptToken(doc.encryptedToken, doc.iv)
        });
      } catch {
        // se decrypt falhar, pula esse repo
      }
    }
    if (resolved.length > 0) github = resolved;
  }

  // Fallback: env default
  if (!github && config.github.defaultOwner && config.github.defaultRepo) {
    github = [{
      name: config.github.defaultRepo,
      owner: config.github.defaultOwner,
      repo: config.github.defaultRepo,
      token: config.github.token
    }];
  }

  // ── Trello (project override > settings global > env default) ──
  const settings = await getIntegrationsSettings();
  const boardId =
    project.trelloBoardId ||
    settings.trelloBoardId ||
    config.trello.defaultBoardId;

  let trello: ResolvedProjectOptions["trello"];
  if (boardId) {
    trello = {
      boardId,
      listId: project.trelloListId || settings.trelloListId || undefined,
      doneListId: project.trelloDoneListId || settings.trelloDoneListId || undefined,
      agentEnabled: project.trelloAgentEnabled ?? true,
      agentCreateCards: project.trelloAgentCreateCards ?? false
    };
  }

  return { project, github, trello };
};
