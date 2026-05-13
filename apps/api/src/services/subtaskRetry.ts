/**
 * Retry de subtask falha sem refazer a task inteira.
 *
 * Estrategia:
 *  - Recria o worktree do branch da task (ja tem commits das subtasks completadas).
 *  - Injeta no prompt um bloco "CONTEXTO" listando o que cada subtask anterior fez,
 *    pra o agent entender o estado da branch.
 *  - Re-executa apenas a subtask alvo.
 *  - Push da branch → PR atualiza sozinho (mesmo head).
 *  - Re-gera report e atualiza task.summary.
 */

import { ObjectId } from "mongodb";
import { getTasksCollection, type TaskRecord } from "../core/mongo.js";
import { resolveProjectOptions } from "../helpers/projectOptionsResolver.js";
import {
  createWorktree,
  removeWorktree,
  branchHasCommits,
  pushBranch,
  createOrGetPullRequest
} from "../orchestrator/integrations/github.js";
import { generateCodeChanges, type CodeChange } from "../orchestrator/agents/code.js";
import { generateReport, type ExecutedSubtask } from "../orchestrator/agents/reporter.js";
import { buildPrBody, derivePrTitle, type ChangeRow } from "../orchestrator/pipeline/prBody.js";
import type { SubTask, GithubRepoConfig } from "../orchestrator/types.js";

export type RetryResult =
  | { ok: true; subtaskId: string; prUrl?: string }
  | { ok: false; reason: string };

/**
 * Re-executa uma subtask falha. Pode ser chamada multiplas vezes — cada retry
 * roda do zero pra subtask alvo, com worktree fresh e contexto das subtasks
 * ja completadas injetado no prompt.
 */
export const retrySubtask = async (
  taskId: string,
  subtaskId: string
): Promise<RetryResult> => {
  if (!ObjectId.isValid(taskId)) {
    return { ok: false, reason: "taskId invalido" };
  }

  const tasksCol = await getTasksCollection();
  const task = await tasksCol.findOne({ _id: new ObjectId(taskId) });
  if (!task) return { ok: false, reason: "task nao encontrada" };

  if (task.status === "executing" || task.status === "planning") {
    return { ok: false, reason: "task ainda esta executando — espere terminar" };
  }

  const targetIndex = (task.subtasks ?? []).findIndex(s => s.id === subtaskId);
  if (targetIndex < 0) return { ok: false, reason: "subtask nao encontrada" };

  const target = task.subtasks[targetIndex]!;
  if (target.status !== "failed" && target.status !== "cancelled") {
    return { ok: false, reason: `subtask esta '${target.status}' — so retry de failed/cancelled` };
  }

  // Por ora, suportamos so retry de github (re-run com push)
  if (target.type !== "github") {
    return { ok: false, reason: `retry implementado apenas pra subtask 'github' (esta e '${target.type}')` };
  }

  if (!task.projectId) {
    return { ok: false, reason: "task sem projectId — nao consegue resolver repos" };
  }

  const opts = await resolveProjectOptions(task.projectId);
  if (!opts?.github || opts.github.length === 0) {
    return { ok: false, reason: "projeto sem repos GitHub configurados" };
  }

  // Resolve qual repo essa subtask usa (mesma logica do pipeline)
  const repo = resolveRepoForSubtask(opts.github, target, task);
  const repoKey = `${repo.owner}/${repo.repo}`;
  const branchName = `mathai/task-${taskId}`;
  const language = task.language ?? "pt";

  // Recria worktree (createWorktree faz cleanup se ja existir + checkout do branch)
  let worktreePath: string;
  try {
    const ws = await createWorktree(
      repo.owner,
      repo.repo,
      branchName,
      taskId,
      repo.token,
      repo.baseBranch
    );
    worktreePath = ws.worktreePath;
  } catch (err) {
    return { ok: false, reason: `falha ao recriar worktree: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Marca a subtask como executing pra UI
  await tasksCol.updateOne(
    { _id: task._id, "subtasks.id": subtaskId },
    {
      $set: {
        "subtasks.$.status": "executing",
        "subtasks.$.startedAt": new Date(),
        "subtasks.$.error": undefined,
        updatedAt: new Date()
      }
    }
  );

  const startedAt = Date.now();
  let prUrl: string | undefined;
  let retryReason: string | null = null; // nao-null = falhou

  try {
    // Constroi bloco de contexto a partir das subtasks ja completadas
    const contextBlock = buildContextBlock(task, target);
    const augmentedDescription = contextBlock
      ? `${contextBlock}\n\n## SUA TAREFA AGORA\n${target.description}`
      : target.description;

    // Executa via OpenClaude (mesmo executor que o pipeline usa)
    let codeResult;
    try {
      codeResult = await generateCodeChanges(
        augmentedDescription,
        worktreePath,
        language,
        undefined,
        { branchName, baseBranch: repo.baseBranch, taskDescription: target.description }
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await tasksCol.updateOne(
        { _id: task._id, "subtasks.id": subtaskId },
        {
          $set: {
            "subtasks.$.status": "failed",
            "subtasks.$.completedAt": new Date(),
            "subtasks.$.error": errMsg,
            "subtasks.$.retryCount": (target.retryCount ?? 0) + 1,
            updatedAt: new Date()
          }
        }
      );
      retryReason = `agent falhou: ${errMsg}`;
      return { ok: false, reason: retryReason };
    }

    // Atualiza a subtask como completed com o novo result
    const newResult = {
      changes: codeResult.changes,
      codeUsage: codeResult.usage,
      prUrl: undefined as string | undefined
    };

    // Push branch + PR idempotente
    try {
      const hasCommits = await branchHasCommits(worktreePath, repo.baseBranch ?? "main", branchName);
      if (hasCommits && repo.token) {
        await pushBranch(worktreePath, repo.owner, repo.repo, branchName, repo.token);

        // Reconstroi PR body com TODAS as subtasks (incluindo a retry-ada)
        const allSubs = task.subtasks ?? [];
        const githubSubsForRepo = allSubs.filter(s =>
          s.type === "github" && (s.resolvedRepoKey === repoKey || s.id === subtaskId)
        );
        const otherSubs = allSubs.filter(s =>
          !(s.type === "github" && (s.resolvedRepoKey === repoKey || s.id === subtaskId))
        );
        const changes: ChangeRow[] = [];
        for (const s of githubSubsForRepo) {
          const r = (s.id === subtaskId ? newResult : s.result) as { changes?: CodeChange[] } | undefined;
          for (const c of r?.changes ?? []) {
            changes.push({ file: c.file, action: c.action, subtaskId: s.id });
          }
        }

        const pr = await createOrGetPullRequest({
          token: repo.token,
          owner: repo.owner,
          repo: repo.repo,
          head: branchName,
          base: repo.baseBranch ?? "main",
          title: derivePrTitle(task.description),
          body: buildPrBody({
            taskDescription: task.description,
            repoKey,
            githubSubs: githubSubsForRepo,
            otherSubs,
            changes,
            reporterMarkdown: task.summary ?? ""
          })
        });
        prUrl = pr.url;
        newResult.prUrl = pr.url;
      }
    } catch (err) {
      console.warn("[subtaskRetry] push/PR failed:", err);
    }

    // Atualiza subtask como completed
    await tasksCol.updateOne(
      { _id: task._id, "subtasks.id": subtaskId },
      {
        $set: {
          "subtasks.$.status": "completed",
          "subtasks.$.completedAt": new Date(),
          "subtasks.$.result": newResult,
          "subtasks.$.resolvedBranch": branchName,
          "subtasks.$.resolvedRepoKey": repoKey,
          "subtasks.$.error": undefined,
          updatedAt: new Date()
        }
      }
    );

    // Re-roda reporter + atualiza task.summary + status final
    try {
      const fresh = await tasksCol.findOne({ _id: task._id });
      const executed: ExecutedSubtask[] = (fresh?.subtasks ?? [])
        .filter(s => s.status === "completed" || s.status === "failed")
        .map(s => ({
          id: s.id,
          type: s.type,
          description: s.description,
          status: s.status as "completed" | "failed",
          result: s.result,
          error: s.error
        }));
      const reportResult = await generateReport(task.description, executed, language);
      const allCompleted = (fresh?.subtasks ?? []).every(s => s.status === "completed");
      const newStatus = allCompleted ? "completed" : "failed";
      const prUrls = fresh?.githubPrUrls ?? [];
      if (prUrl && !prUrls.includes(prUrl)) prUrls.push(prUrl);
      await tasksCol.updateOne(
        { _id: task._id },
        {
          $set: {
            status: newStatus,
            summary: reportResult.report,
            githubPrUrls: prUrls,
            completedAt: new Date(),
            updatedAt: new Date()
          }
        }
      );
    } catch (err) {
      console.warn("[subtaskRetry] reporter/finalize failed:", err);
    }

    console.info(`[subtaskRetry] task=${taskId.slice(-8)} sub=${subtaskId} OK in ${Date.now() - startedAt}ms`);
    return { ok: true, subtaskId, prUrl };
  } finally {
    // Cleanup worktree SEMPRE — success ou failure, evita leak de directory.
    try {
      await removeWorktree(repo.owner, repo.repo, taskId);
    } catch (err) {
      console.warn(`[subtaskRetry] removeWorktree failed task=${taskId}:`, err);
    }
  }
};

// ── Helpers ───────────────────────────────────────────────────────

const resolveRepoForSubtask = (
  repos: GithubRepoConfig[],
  sub: SubTask,
  task: TaskRecord
): GithubRepoConfig => {
  // Prioridade: resolvedRepoKey persistido > hint da subtask > primeiro repo
  if (sub.resolvedRepoKey) {
    const [owner, repo] = sub.resolvedRepoKey.split("/");
    const match = repos.find(r => r.owner === owner && r.repo === repo);
    if (match) return match;
  }
  if (sub.repo) {
    const match = repos.find(r =>
      r.name === sub.repo || r.repo === sub.repo || `${r.owner}/${r.repo}` === sub.repo
    );
    if (match) return match;
  }
  // Fallback: primeiro repo conhecido via branchByRepo, ou repos[0]
  if (task.branchByRepo) {
    const firstKey = Object.keys(task.branchByRepo)[0];
    if (firstKey) {
      const [owner, repo] = firstKey.split("/");
      const match = repos.find(r => r.owner === owner && r.repo === repo);
      if (match) return match;
    }
  }
  return repos[0]!;
};

/**
 * Constroi um bloco markdown listando o que cada subtask anterior (completed)
 * fez. Inclui descricao + arquivos modificados. Injetado no prompt do agent
 * pra dar contexto de onde a branch esta.
 */
const buildContextBlock = (task: TaskRecord, target: SubTask): string => {
  const previousCompleted = (task.subtasks ?? [])
    .filter(s => s.id !== target.id && s.status === "completed");
  if (previousCompleted.length === 0) return "";

  const lines: string[] = [
    "## CONTEXTO — Steps ja completados nesta task",
    "",
    "A branch ja contem os commits abaixo. NAO refaca esses passos — apenas leia pra entender o estado atual:"
  ];

  for (const s of previousCompleted) {
    lines.push("");
    lines.push(`### Step "${s.id}" (concluido)`);
    lines.push(`Descricao: ${s.description.slice(0, 400)}`);
    const r = s.result as { changes?: CodeChange[] } | undefined;
    if (r?.changes && r.changes.length > 0) {
      lines.push("Arquivos modificados:");
      for (const c of r.changes.slice(0, 20)) {
        lines.push(`- ${c.file} (${c.action})`);
      }
      if (r.changes.length > 20) lines.push(`- ... e mais ${r.changes.length - 20} arquivo(s)`);
    } else {
      lines.push("(sem detalhes de arquivos persistidos — leia os commits da branch)");
    }
  }

  return lines.join("\n");
};
