/**
 * Rollback assistido — plan #9.
 *
 * Cria branch + PR de revert do merge commit de uma task ja mergeada.
 * Nao mergeia automaticamente — usuario aprova o revert PR no GitHub.
 *
 * Fluxo:
 *   1. Carrega task + descobre PR URL (1 obrigatorio; multi-PR exige body.prUrl)
 *   2. GET /repos/owner/repo/pulls/N -> merge_commit_sha + base.ref + title
 *   3. createWorktree (clean checkout do base)
 *   4. git revert -m 1 <merge_sha> --no-edit  (-m 1 = mantem mainline)
 *   5. pushBranch revert/<taskId>
 *   6. createOrGetPullRequest "Revert: <originalTitle>" linkando original
 *   7. Marca TaskExecutionRecord{reverted:true} via flag em TaskRecord
 */

import { ObjectId } from "mongodb";
import {
  getTasksCollection,
  getGithubReposCollection,
  getTaskExecutionsCollection
} from "../core/mongo.js";
import { decryptToken } from "../core/repoCrypto.js";
import {
  createWorktree,
  pushBranch,
  createOrGetPullRequest,
  removeWorktree,
  getGit
} from "../orchestrator/integrations/github.js";

export type RevertRequest = {
  taskId: string;
  /** Quando task tem >1 PR, especifica qual. Senao usa o unico. */
  prUrl?: string;
  /** Texto livre — vai pro body do PR de revert. */
  reason?: string;
};

export type RevertResult = {
  ok: boolean;
  revertPrUrl?: string;
  revertBranch?: string;
  originalPrUrl?: string;
  mergeSha?: string;
  reason?: string;
};

const PR_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

const parsePrUrl = (url: string): { owner: string; repo: string; number: number } | null => {
  const m = PR_URL_RE.exec(url);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
};

type GithubPrResponse = {
  title?: string;
  merge_commit_sha?: string;
  merged?: boolean;
  state?: string;
  base?: { ref?: string };
};

const fetchPrDetails = async (
  token: string,
  owner: string,
  repo: string,
  number: number
): Promise<GithubPrResponse | null> => {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!res.ok) return null;
  return (await res.json()) as GithubPrResponse;
};

export const revertTask = async (input: RevertRequest): Promise<RevertResult> => {
  const { taskId, prUrl: explicitPrUrl, reason } = input;
  if (!ObjectId.isValid(taskId)) {
    return { ok: false, reason: "invalid_task_id" };
  }
  const tasksCol = await getTasksCollection();
  const task = await tasksCol.findOne({ _id: new ObjectId(taskId) });
  if (!task) return { ok: false, reason: "task_not_found" };

  // Escolhe o PR
  const candidatePrs = task.githubPrUrls ?? [];
  let selectedPrUrl: string | null = null;
  if (explicitPrUrl) {
    if (!candidatePrs.includes(explicitPrUrl)) {
      return { ok: false, reason: "pr_url_not_in_task" };
    }
    selectedPrUrl = explicitPrUrl;
  } else if (candidatePrs.length === 1) {
    selectedPrUrl = candidatePrs[0]!;
  } else if (candidatePrs.length === 0) {
    return { ok: false, reason: "task_has_no_pr" };
  } else {
    return { ok: false, reason: "task_has_multiple_prs_specify_prUrl" };
  }

  const parsed = parsePrUrl(selectedPrUrl);
  if (!parsed) return { ok: false, reason: "pr_url_unparseable" };

  // Resolve token via github_repos
  const reposCol = await getGithubReposCollection();
  const repoDoc = await reposCol.findOne({ owner: parsed.owner, repo: parsed.repo });
  if (!repoDoc) return { ok: false, reason: "repo_credentials_not_found" };
  let token: string;
  try {
    token = decryptToken(repoDoc.encryptedToken, repoDoc.iv);
  } catch {
    return { ok: false, reason: "decrypt_failed" };
  }

  // Busca detalhes do PR
  const pr = await fetchPrDetails(token, parsed.owner, parsed.repo, parsed.number);
  if (!pr) return { ok: false, reason: "github_api_failed" };
  if (!pr.merged || !pr.merge_commit_sha) {
    return { ok: false, reason: "pr_not_merged" };
  }
  const baseBranch = pr.base?.ref ?? repoDoc.baseBranch ?? "main";
  const originalTitle = pr.title ?? `task ${taskId.slice(-8)}`;

  // Cria worktree numa branch nova revert/<taskId>
  const revertBranch = `mathai/revert-${taskId.slice(-12)}`;
  const worktreeId = `revert-${taskId.slice(-8)}`;
  const ws = await createWorktree(
    parsed.owner,
    parsed.repo,
    revertBranch,
    worktreeId,
    token,
    baseBranch
  );

  try {
    const git = getGit(ws.worktreePath);
    // -m 1 = mantem mainline (necessario pra revertir merge commit)
    try {
      await git.raw(["revert", "-m", "1", "--no-edit", pr.merge_commit_sha]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Se ja foi revertido (no conflito) ou outro problema, propaga
      return { ok: false, reason: `revert_failed: ${msg.slice(0, 200)}` };
    }

    await pushBranch(ws.worktreePath, parsed.owner, parsed.repo, revertBranch, token);

    const body = [
      `Revert do PR original: ${selectedPrUrl}`,
      "",
      `Merge commit: \`${pr.merge_commit_sha}\``,
      "",
      `Motivo: ${reason ?? "(nao informado)"}`,
      "",
      "_Gerado automaticamente pelo MathAI rollback (#9)._"
    ].join("\n");

    const revertPr = await createOrGetPullRequest({
      token,
      owner: parsed.owner,
      repo: parsed.repo,
      head: revertBranch,
      base: baseBranch,
      title: `Revert: ${originalTitle}`.slice(0, 250),
      body
    });

    // Marca a task original
    await tasksCol.updateOne(
      { _id: task._id },
      {
        $set: {
          updatedAt: new Date()
        },
        $push: { githubPrUrls: revertPr.url }
      } as Parameters<typeof tasksCol.updateOne>[1]
    );

    // G4: marca todas as execucoes desta task como reverted (alimenta #11 metrics).
    try {
      const execCol = await getTaskExecutionsCollection();
      await execCol.updateMany(
        { taskId: task._id },
        { $set: { reverted: true } }
      );
    } catch (err) {
      console.warn("[rollback] failed to mark task_executions.reverted:", err);
    }

    return {
      ok: true,
      revertPrUrl: revertPr.url,
      revertBranch,
      originalPrUrl: selectedPrUrl,
      mergeSha: pr.merge_commit_sha
    };
  } finally {
    // Cleanup do worktree (push ja feito)
    const wid = ws.worktreePath.split(/[\\/]/).pop()?.split("--")[1] ?? "";
    await removeWorktree(parsed.owner, parsed.repo, wid).catch(() => {});
  }
};
