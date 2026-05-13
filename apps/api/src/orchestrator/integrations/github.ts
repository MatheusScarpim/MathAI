import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { config } from "../../core/config.js";
import { execShell } from "./shell.js";

// ============== TYPES ==============

export type WorkspaceInfo = {
  basePath: string;
  worktreePath: string;
  owner: string;
  repo: string;
  branchName: string;
  /** Branch base resolvida (auto-detectada se nao foi fornecida) */
  baseBranch: string;
  isNewClone: boolean;
};

// ============== PATHS ==============

/**
 * Clone base: /data/auraia-workspaces/repos/<owner>-<repo>/
 * Worktrees:  /data/auraia-workspaces/worktrees/<owner>-<repo>--<taskId>-<subtaskId>/
 */
const getBasePath = (owner: string, repo: string): string =>
  join(config.workspace.dir, "repos", `${owner}-${repo}`);

const getWorktreePath = (owner: string, repo: string, worktreeId: string): string =>
  join(config.workspace.dir, "worktrees", `${owner}-${repo}--${worktreeId}`);

// ============== BASE REPO (clone uma vez) ==============

/**
 * Garante que o repo base existe. Clona na primeira vez, fetch nas seguintes.
 * O repo base NUNCA e modificado — serve apenas como source para worktrees.
 */
export const ensureBaseRepo = async (
  owner: string,
  repo: string,
  token?: string
): Promise<string> => {
  const basePath = getBasePath(owner, repo);
  const ghToken = token ?? config.github.token;
  const cloneUrl = `https://x-access-token:${ghToken}@github.com/${owner}/${repo}.git`;

  if (!existsSync(basePath)) {
    await mkdir(join(config.workspace.dir, "repos"), { recursive: true });
    const git = simpleGit();
    await git.clone(cloneUrl, basePath);
    const baseGit = simpleGit(basePath);
    await baseGit.addConfig("user.name", "MathAI Bot");
    await baseGit.addConfig("user.email", "mathai-bot@noreply.github.com");
  } else {
    // Fetch todas as branches sem modificar o working tree
    const baseGit = simpleGit(basePath);
    await baseGit.fetch("origin");
  }

  return basePath;
};

// ============== WORKTREES ==============

/**
 * Cria um worktree isolado para uma tarefa.
 * Instantaneo — sem re-clone, copia leve do .git.
 * Cada tarefa trabalha no seu proprio diretorio sem conflito.
 */
export const createWorktree = async (
  owner: string,
  repo: string,
  branchName: string,
  worktreeId: string,
  token?: string,
  baseBranch?: string
): Promise<WorkspaceInfo> => {
  const basePath = await ensureBaseRepo(owner, repo, token);
  const wtPath = getWorktreePath(owner, repo, worktreeId);

  // Limpar worktree anterior se existir (task re-run)
  if (existsSync(wtPath)) {
    const baseGit = simpleGit(basePath);
    await baseGit.raw(["worktree", "remove", wtPath, "--force"]).catch(() => {});
    await rm(wtPath, { recursive: true, force: true });
  }

  await mkdir(join(config.workspace.dir, "worktrees"), { recursive: true });

  const baseGit = simpleGit(basePath);

  // Detectar branch padrao do remote
  let defaultBranch = baseBranch;
  if (!defaultBranch) {
    // Tenta detectar via origin/HEAD
    const headRef = await baseGit
      .raw(["symbolic-ref", "refs/remotes/origin/HEAD"])
      .catch(() => "");
    if (headRef) {
      defaultBranch = headRef.replace("refs/remotes/origin/", "").trim();
    }
    // Fallback: tenta main, depois master
    if (!defaultBranch) {
      const branches = await baseGit.branch(["-r"]);
      if (branches.all.includes("origin/main")) defaultBranch = "main";
      else if (branches.all.includes("origin/master")) defaultBranch = "master";
      else defaultBranch = "main"; // fallback final
    }
  }

  // Garantir que temos a branch base atualizada
  await baseGit.fetch("origin", defaultBranch).catch(() => {});

  // Limpa qualquer ref local stale da branch alvo (sobra de worktree anterior).
  // Idempotente — ignora falha se nao existir.
  await baseGit.raw(["branch", "-D", branchName]).catch(() => {});

  // Fetch da branch alvo no remote (cria refs/remotes/origin/<branch> se existir).
  await baseGit.fetch("origin", branchName).catch(() => {});

  // Usa branchLocal/remote do simple-git (mais confiavel que show-ref):
  let remoteHasBranch = false;
  try {
    const remoteBranches = await baseGit.branch(["-r"]);
    remoteHasBranch = remoteBranches.all.includes(`origin/${branchName}`);
  } catch { /* ignore */ }

  if (remoteHasBranch) {
    // Recria local rastreando o remote (continua de onde o push anterior parou)
    await baseGit.raw(["worktree", "add", "-b", branchName, wtPath, `origin/${branchName}`]);
  } else {
    // Branch totalmente nova — parte da base
    await baseGit.raw(["worktree", "add", "-b", branchName, wtPath, `origin/${defaultBranch}`]);
  }

  // Configurar git user no worktree
  const wtGit = simpleGit(wtPath);
  await wtGit.addConfig("user.name", "MathAI Bot");
  await wtGit.addConfig("user.email", "mathai-bot@noreply.github.com");

  return {
    basePath,
    worktreePath: wtPath,
    owner,
    repo,
    branchName,
    baseBranch: defaultBranch,
    isNewClone: false
  };
};

/**
 * Remove um worktree apos uso (PR ja foi aberto).
 * Libera espaco em disco.
 */
export const removeWorktree = async (
  owner: string,
  repo: string,
  worktreeId: string
): Promise<void> => {
  const basePath = getBasePath(owner, repo);
  const wtPath = getWorktreePath(owner, repo, worktreeId);

  if (!existsSync(wtPath)) return;

  try {
    const baseGit = simpleGit(basePath);
    await baseGit.raw(["worktree", "remove", wtPath, "--force"]);
  } catch {
    // Fallback: remove manualmente
    await rm(wtPath, { recursive: true, force: true });
  }
};

/**
 * Lista worktrees ativos de um repo.
 */
export const listWorktrees = async (owner: string, repo: string): Promise<string[]> => {
  const basePath = getBasePath(owner, repo);
  if (!existsSync(basePath)) return [];

  const baseGit = simpleGit(basePath);
  const result = await baseGit.raw(["worktree", "list", "--porcelain"]);
  return result
    .split("\n")
    .filter(line => line.startsWith("worktree "))
    .map(line => line.replace("worktree ", ""));
};

// ============== HELPERS ==============

/**
 * Lista a estrutura de arquivos de um worktree.
 */
export const getRepoTree = async (wsPath: string): Promise<string> => {
  const result = await execShell("find", [
    ".", "-type", "f",
    "-not", "-path", "./.git/*",
    "-not", "-path", "./node_modules/*"
  ], wsPath, 30000);
  return result.stdout;
};

/**
 * Retorna o SimpleGit de um path para operacoes customizadas.
 */
export const getGit = (wsPath: string): SimpleGit => simpleGit(wsPath);

// ============== PUSH + PR (orchestrator-side, no agent) ==============

/**
 * Verifica se a branch tem commits a frente da base.
 * Retorna false se nao ha nada pra abrir um PR (head == base).
 */
export const branchHasCommits = async (
  workdir: string,
  baseBranch: string,
  branch: string
): Promise<boolean> => {
  const git = simpleGit(workdir);
  try {
    // origin/<baseBranch>..HEAD — quantos commits estao adiante da base remota?
    const out = await git.raw(["rev-list", "--count", `origin/${baseBranch}..HEAD`]);
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) && n > 0;
  } catch {
    // Fallback: comparar local branch vs origin/baseBranch
    try {
      const out = await git.raw(["rev-list", "--count", `origin/${baseBranch}..${branch}`]);
      const n = parseInt(out.trim(), 10);
      return Number.isFinite(n) && n > 0;
    } catch {
      return false;
    }
  }
};

/**
 * Faz push da branch usando o token inline na URL (sem persistir credenciais).
 */
export const pushBranch = async (
  workdir: string,
  owner: string,
  repo: string,
  branch: string,
  token: string
): Promise<void> => {
  const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  const git = simpleGit(workdir);
  // --set-upstream pra a branch ficar trackeada (futuras operacoes nao precisam de --upstream)
  await git.raw(["push", "--set-upstream", remoteUrl, `${branch}:${branch}`]);
};

// ============== PULL REQUEST (REST API, sem dependencia extra) ==============

export type CreatePrInput = {
  token: string;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
};

export type CreatePrResult = {
  url: string;
  number: number;
  created: boolean;
};

const githubApiHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json"
});

/**
 * Abre um PR. Se ja existe um PR aberto pra mesma branch, atualiza body+title e devolve.
 */
export const createOrGetPullRequest = async (
  input: CreatePrInput
): Promise<CreatePrResult> => {
  const { token, owner, repo, head, base, title, body } = input;
  const apiBase = `https://api.github.com/repos/${owner}/${repo}`;

  // Tentativa de criar
  const createRes = await fetch(`${apiBase}/pulls`, {
    method: "POST",
    headers: githubApiHeaders(token),
    body: JSON.stringify({ title, body, head, base })
  });

  if (createRes.ok) {
    const json = (await createRes.json()) as { html_url?: string; number?: number };
    if (!json.html_url || typeof json.number !== "number") {
      throw new Error(`GitHub returned PR without html_url/number`);
    }
    return { url: json.html_url, number: json.number, created: true };
  }

  // 422 normalmente significa "PR ja existe pra essa branch" — tentar localizar
  const errText = await createRes.text();
  const alreadyExists = createRes.status === 422 && /already exists/i.test(errText);

  if (!alreadyExists) {
    throw new Error(`gh pr create failed (${createRes.status}): ${errText.slice(0, 500)}`);
  }

  // Buscar PR existente
  const listUrl = `${apiBase}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open`;
  const listRes = await fetch(listUrl, { headers: githubApiHeaders(token) });
  if (!listRes.ok) {
    throw new Error(`PR existe mas falha ao buscar (${listRes.status}): ${(await listRes.text()).slice(0, 300)}`);
  }
  const list = (await listRes.json()) as Array<{ number: number; html_url: string }>;
  const existing = list[0];
  if (!existing) {
    throw new Error(`PR reportado como existente mas nao encontrado no GET /pulls`);
  }

  // Atualizar body + title (consolidacao novamente caso a task tenha rodado de novo)
  const patchRes = await fetch(`${apiBase}/pulls/${existing.number}`, {
    method: "PATCH",
    headers: githubApiHeaders(token),
    body: JSON.stringify({ title, body })
  }).catch(() => null);
  // Se PATCH falhar nao e fatal — o PR existe e tem body antigo.
  if (patchRes && !patchRes.ok) {
    console.warn(`[github] PATCH PR ${existing.number} retornou ${patchRes.status}`);
  }

  return { url: existing.html_url, number: existing.number, created: false };
};
