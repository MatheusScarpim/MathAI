/**
 * Preview deploys efemeros por task.
 *
 * Fluxo:
 *   1. Recebe taskId
 *   2. Resolve project (precisa de previewBuildCmd configurado)
 *   3. Recria worktree (pipeline limpa apos o PR)
 *   4. npm install + project.previewBuildCmd no worktree
 *   5. Spawn `serve -s <distDir> -l <port>` (estatico)
 *   6. Spawn `cloudflared tunnel --url http://localhost:<port>`
 *   7. Parse URL `*.trycloudflare.com` da stdout, persiste no Mongo
 *
 * TTL: 30min. Cap: 3 previews ativos simultaneos. previewCleanup mata processos.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { simpleGit } from "simple-git";
import { createServer } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { ObjectId } from "mongodb";
import {
  getPreviewsCollection,
  getTasksCollection,
  type PreviewRecord
} from "../core/mongo.js";
import { resolveProjectOptions } from "../helpers/projectOptionsResolver.js";
import { createWorktree } from "../orchestrator/integrations/github.js";
import { detectStack } from "../orchestrator/context/stackDetector.js";
import { config } from "../core/config.js";

// ── Helpers ───────────────────────────────────────────────────────

/**
 * True se o caminho parece arquivo de frontend. Tolerante a paths absolutos
 * (ex: /data/auraia-workspaces/worktrees/.../frontend/src/...) que e o que
 * o agente costuma emitir.
 */
const looksLikeFrontend = (file: string): boolean => {
  if (!file) return false;
  // Backend dirs (absolutos ou relativos)
  if (/(?:^|\/)(?:apps\/api|backend|packages\/api|server)(?:\/|$)/.test(file)) return false;
  // Se tem qualquer um dos prefixos de frontend, e frontend (mesmo embarcado num path absoluto)
  if (/(?:^|\/)(?:frontend|apps\/web|apps\/frontend|web|client|src\/(?:views|pages|components|router|stores?|composables|services))(?:\/|$)/.test(file)) {
    return true;
  }
  // Senao, assume nao-backend = pode ser frontend ou misc — devolve true por padrao
  // (permissivo: melhor tentar e falhar no build do que rejeitar cedo demais)
  return true;
};

// ── Constantes ────────────────────────────────────────────────────

const MAX_CONCURRENT = 3;
const TTL_MS = 30 * 60 * 1000;
const NPM_INSTALL_TIMEOUT_MS = 180_000;   // 3min
const BUILD_TIMEOUT_MS = 240_000;          // 4min
const SERVE_BOOT_TIMEOUT_MS = 15_000;
const TUNNEL_BOOT_TIMEOUT_MS = 20_000;
const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

// ── Process tracking (in-memory) ──────────────────────────────────

type RunningPreview = {
  taskId: string;
  serve: ChildProcess;
  tunnel: ChildProcess;
};

/** Map taskId -> processos. Permite stopPreview matar sem precisar de PID exposto. */
const running = new Map<string, RunningPreview>();

// ── API publica ───────────────────────────────────────────────────

export type StartResult =
  | { ok: true; preview: PreviewRecord }
  | { ok: false; reason: string };

/**
 * Inicia preview pra task. Idempotente: se ja existe ativo, retorna o existente.
 */
export const startPreview = async (
  taskId: string,
  userId?: string
): Promise<StartResult> => {
  if (!ObjectId.isValid(taskId)) {
    return { ok: false, reason: "taskId invalido" };
  }

  // 1. Carrega task + project
  const tasksCol = await getTasksCollection();
  const task = await tasksCol.findOne({ _id: new ObjectId(taskId) });
  if (!task) return { ok: false, reason: "task nao encontrada" };
  if (!task.projectId) return { ok: false, reason: "task sem projectId" };

  const opts = await resolveProjectOptions(task.projectId);
  if (!opts) return { ok: false, reason: "projeto nao encontrado" };

  const { project, github } = opts;
  // G3: previewBuildCmd nao eh mais hard requirement — resolvemos via stack
  // detection apos criar o worktree (project.previewBuildCmd tem prioridade).
  if (!github || github.length === 0) {
    return { ok: false, reason: "projeto sem repos GitHub configurados" };
  }

  // 2. Detect frontend changes — heuristica em 2 niveis:
  //    a) FAST PATH: olha subtask.result.changes (pode estar populado).
  //    b) FALLBACK: agente as vezes volta changes=[] mesmo tendo commitado
  //       (bug conhecido). Nesse caso, deferimos pro git diff pos-worktree.
  const subtaskHints = (task.subtasks ?? []).filter(s => s.type === "github");
  let hasFrontendChange = subtaskHints.some(s => {
    const r = s.result as { changes?: { file: string }[] } | undefined;
    return (r?.changes ?? []).some(c => looksLikeFrontend(c.file));
  });
  // Se hint existe E ja indica frontend, ok. Se nao, NAO rejeita aqui —
  // confiamos no git diff que sera feito apos a criacao do worktree.
  const hintAvailable = subtaskHints.some(s => {
    const r = s.result as { changes?: { file: string }[] } | undefined;
    return (r?.changes?.length ?? 0) > 0;
  });
  if (hintAvailable && !hasFrontendChange) {
    return { ok: false, reason: "task sem mudancas visuais (so backend)" };
  }
  // Se nao tem hint nenhuma, segue — vamos diff a branch real depois.

  const previewsCol = await getPreviewsCollection();

  // 3. Idempotencia: se ja existe ativo pra essa task, devolve
  const existing = await previewsCol.findOne({
    taskId,
    status: { $in: ["starting", "ready"] }
  });
  if (existing) {
    return { ok: true, preview: existing };
  }

  // 4. Cap concorrente
  const active = await previewsCol.countDocuments({
    status: { $in: ["starting", "ready"] }
  });
  if (active >= MAX_CONCURRENT) {
    return {
      ok: false,
      reason: `maximo ${MAX_CONCURRENT} previews ativos simultaneamente`
    };
  }

  // 5. Recria worktree (pipeline limpa apos o PR)
  const repo = github[0]!; // task pode ter multi-repo, mas preview = primeiro (heuristica)
  const branchName = `mathai/task-${taskId}`;
  let worktreePath: string;
  let baseBranch: string;
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
    baseBranch = ws.baseBranch;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `falha ao recriar worktree: ${msg}` };
  }

  // 5b. Fallback: se subtasks nao informaram changes uteis, agora que temos o worktree
  //     a gente diffa contra a base branch pra ver de verdade quais arquivos mudaram.
  if (!hasFrontendChange) {
    try {
      const git = simpleGit(worktreePath);
      const diff = await git.diff(["--name-only", `origin/${baseBranch}...HEAD`]);
      const diffFiles = diff.split("\n").map((s: string) => s.trim()).filter(Boolean);
      console.info(`[previewManager] git diff fallback task=${taskId}: ${diffFiles.length} arquivos`);
      hasFrontendChange = diffFiles.some((f: string) => looksLikeFrontend(f));
      if (!hasFrontendChange) {
        return {
          ok: false,
          reason: `task sem mudancas visuais (${diffFiles.length} arquivo${diffFiles.length === 1 ? "" : "s"} so backend)`
        };
      }
    } catch (err) {
      console.warn(`[previewManager] git diff fallback falhou task=${taskId}:`, err instanceof Error ? err.message : err);
      // Sem como saber — segue otimisticamente, build vai falhar se nao tem nada
    }
  }

  // 6. Aloca porta
  const port = await findFreePort();

  // 7. Insert doc starting
  const startedAt = new Date();
  const expiresAt = new Date(Date.now() + TTL_MS);
  const insertRes = await previewsCol.insertOne({
    taskId,
    userId,
    port,
    tunnelUrl: "",
    status: "starting",
    worktreePath,
    startedAt,
    expiresAt
  });
  const previewId = insertRes.insertedId;

  // Helper pra marcar failed e desligar tudo
  const markFailed = async (reason: string): Promise<StartResult> => {
    console.warn(`[previewManager] task=${taskId} failed: ${reason}`);
    await previewsCol.updateOne(
      { _id: previewId },
      { $set: { status: "failed", errorMessage: reason.slice(0, 500) } }
    );
    const rec = await previewsCol.findOne({ _id: previewId });
    cleanupRunning(taskId);
    return { ok: false, reason };
  };

  // G3: resolve previewBuildCmd — project tem prioridade, senao tenta stack detect.
  let resolvedPreviewCmd = project.previewBuildCmd;
  if (!resolvedPreviewCmd) {
    try {
      const stack = await detectStack(worktreePath);
      if (stack.previewBuildCmd) {
        resolvedPreviewCmd = stack.previewBuildCmd;
        console.info(`[previewManager] usando stack.previewBuildCmd="${resolvedPreviewCmd}" (stack=${stack.primary})`);
      }
    } catch (err) {
      console.warn(`[previewManager] detectStack falhou:`, err);
    }
  }
  if (!resolvedPreviewCmd) {
    return markFailed(`projeto "${project.name}" sem previewBuildCmd e stack detect nao resolveu`);
  }

  // 8. Localiza o frontend dir + garante build:preview (injeta se faltar mas tem build).
  //    Comandos abaixo rodam dentro desse dir, nao no worktree root.
  const frontendDir = prepareFrontend(worktreePath, project.previewDistDir);

  // 9. npm install dentro do frontend dir
  try {
    await runOneShot("npm", ["install", "--no-audit", "--no-fund"], frontendDir, NPM_INSTALL_TIMEOUT_MS);
  } catch (err) {
    return markFailed(`npm install falhou: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 10. previewBuildCmd dentro do frontend dir
  //     Env VITE_ENABLE_MSW=true habilita MSW caso o bootstrap use esse flag
  //     em vez de import.meta.env.MODE === 'preview'.
  try {
    await runShell(resolvedPreviewCmd, frontendDir, BUILD_TIMEOUT_MS, {
      VITE_ENABLE_MSW: "true",
      MODE: "preview"
    });
  } catch (err) {
    // Fallback: se previewBuildCmd falhou (script ausente, etc), tenta `npm run build`
    // com env de MSW ligado — funciona pra projetos com bootstrap baseado em env var.
    console.warn(`[previewManager] previewBuildCmd falhou, tentando fallback npm run build:`, err);
    try {
      await runShell("npm run build", frontendDir, BUILD_TIMEOUT_MS, {
        VITE_ENABLE_MSW: "true",
        MODE: "preview"
      });
    } catch (err2) {
      return markFailed(
        `build falhou (com fallback): ${err2 instanceof Error ? err2.message : String(err2)}`
      );
    }
  }

  // 11. Resolve distDir
  const distDir = resolveDistDir(worktreePath, project.previewDistDir);
  if (!distDir) {
    return markFailed("dist nao encontrado (configure previewDistDir no projeto)");
  }

  // 11. Spawn `serve` estatico
  const serve = spawn("serve", ["-s", distDir, "-l", String(port), "--no-clipboard"], {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"]
  });

  serve.on("error", err => console.warn(`[previewManager] serve error task=${taskId}:`, err));

  const serveReady = await waitForStdoutMatch(
    serve,
    /Accepting connections|Local:|Available on|http:\/\/localhost/i,
    SERVE_BOOT_TIMEOUT_MS
  );
  if (!serveReady) {
    serve.kill("SIGTERM");
    return markFailed("serve nao subiu no tempo esperado");
  }

  // 12. Spawn cloudflared
  const tunnel = spawn("cloudflared", [
    "tunnel",
    "--url", `http://localhost:${port}`,
    "--no-autoupdate"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  tunnel.on("error", err => console.warn(`[previewManager] cloudflared error task=${taskId}:`, err));

  const tunnelUrl = await waitForUrlMatch(tunnel, TRYCLOUDFLARE_RE, TUNNEL_BOOT_TIMEOUT_MS);
  if (!tunnelUrl) {
    serve.kill("SIGTERM");
    tunnel.kill("SIGTERM");
    return markFailed("cloudflared nao gerou URL no tempo esperado");
  }

  // 13. Track processos + persist ready
  running.set(taskId, { taskId, serve, tunnel });
  serve.on("exit", () => onProcessExit(taskId, "serve"));
  tunnel.on("exit", () => onProcessExit(taskId, "tunnel"));

  await previewsCol.updateOne(
    { _id: previewId },
    {
      $set: {
        tunnelUrl,
        servePid: serve.pid,
        tunnelPid: tunnel.pid,
        status: "ready"
      }
    }
  );

  const ready = await previewsCol.findOne({ _id: previewId });
  console.info(`[previewManager] ready task=${taskId} url=${tunnelUrl}`);
  return { ok: true, preview: ready! };
};

/**
 * Encerra preview ativo. Idempotente.
 */
export const stopPreview = async (taskId: string): Promise<{ ok: boolean }> => {
  const previewsCol = await getPreviewsCollection();
  const rec = await previewsCol.findOne({
    taskId,
    status: { $in: ["starting", "ready"] }
  });

  cleanupRunning(taskId);

  if (rec) {
    await previewsCol.updateOne(
      { _id: rec._id },
      { $set: { status: "stopped" } }
    );
    console.info(`[previewManager] stopped task=${taskId}`);
  }

  return { ok: true };
};

/** Lista previews ativos (UI/debug). */
export const listActivePreviews = async (userId?: string): Promise<PreviewRecord[]> => {
  const col = await getPreviewsCollection();
  const filter: Record<string, unknown> = { status: { $in: ["starting", "ready"] } };
  if (userId) filter.userId = userId;
  return col.find(filter).sort({ startedAt: -1 }).toArray();
};

/** Retorna o preview ativo de uma task, se houver. */
export const getActivePreview = async (taskId: string): Promise<PreviewRecord | null> => {
  const col = await getPreviewsCollection();
  return col.findOne({ taskId, status: { $in: ["starting", "ready"] } });
};

/**
 * Mata previews vencidos. Chamado pelo loop de cleanup a cada 60s.
 * Retorna quantidade matada.
 */
export const killExpired = async (): Promise<number> => {
  const col = await getPreviewsCollection();
  const expired = await col.find({
    status: { $in: ["starting", "ready"] },
    expiresAt: { $lt: new Date() }
  }).toArray();

  let killed = 0;
  for (const p of expired) {
    cleanupRunning(p.taskId);
    await col.updateOne(
      { _id: p._id },
      { $set: { status: "stopped" } }
    );
    killed++;
    console.info(`[previewManager] expired task=${p.taskId} (TTL)`);
  }
  return killed;
};

/**
 * Marca todos previews 'ready' como 'stopped' — chamado no boot.
 * Processos foram mortos junto com o container anterior.
 */
export const releaseOrphanedPreviews = async (): Promise<number> => {
  const col = await getPreviewsCollection();
  const res = await col.updateMany(
    { status: { $in: ["starting", "ready"] } },
    { $set: { status: "stopped", errorMessage: "orphaned by container restart" } }
  );
  if (res.modifiedCount > 0) {
    console.info(`[previewManager] released ${res.modifiedCount} orphaned previews`);
  }
  return res.modifiedCount;
};

// ── Helpers internos ──────────────────────────────────────────────

const cleanupRunning = (taskId: string): void => {
  const r = running.get(taskId);
  if (!r) return;
  try { r.serve.kill("SIGTERM"); } catch { /* ignore */ }
  try { r.tunnel.kill("SIGTERM"); } catch { /* ignore */ }
  running.delete(taskId);
};

const onProcessExit = (taskId: string, which: "serve" | "tunnel"): void => {
  console.info(`[previewManager] ${which} exited task=${taskId}`);
  // Se um dos dois morreu inesperadamente, mata o outro pra manter consistencia.
  const r = running.get(taskId);
  if (!r) return;
  const other = which === "serve" ? r.tunnel : r.serve;
  if (!other.killed) {
    try { other.kill("SIGTERM"); } catch { /* ignore */ }
  }
  running.delete(taskId);
  // Marca como stopped no Mongo — senao o indice unico parcial bloqueia
  // novo start pra mesma task ate o TTL natural.
  void (async () => {
    try {
      const col = await getPreviewsCollection();
      await col.updateOne(
        { taskId, status: { $in: ["starting", "ready"] } },
        { $set: { status: "stopped", errorMessage: `${which} process exited unexpectedly` } }
      );
    } catch (err) {
      console.warn(`[previewManager] failed to mark stopped on exit task=${taskId}:`, err);
    }
  })();
};

/** Acha porta livre via bind:0 (kernel escolhe). */
const findFreePort = (): Promise<number> => {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
};

/**
 * Localiza o package.json do frontend, garante que tem script "build:preview"
 * (injeta se faltar mas tem "build"), e retorna o **diretorio** onde mora —
 * pra ser usado como cwd dos comandos npm install + build.
 *
 * Retorna o worktreePath como fallback (single-package repo).
 */
const prepareFrontend = (worktreePath: string, configuredDist?: string): string => {
  const candidates = [
    configuredDist ? configuredDist.replace(/\/dist$/, "") : null,
    "frontend",
    "apps/web",
    "apps/frontend",
    "web",
    "client",
    "." // monorepo root ou single-package
  ].filter((x): x is string => !!x);

  let firstWithPkg: string | null = null;

  for (const c of candidates) {
    const dir = pathResolve(worktreePath, c);
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;

    if (!firstWithPkg) firstWithPkg = dir;

    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
      const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};

      if (scripts["build:preview"]) {
        console.info(`[previewManager] frontend dir=${dir} (build:preview ja presente)`);
        return dir;
      }
      if (scripts.build) {
        // Injeta build:preview baseado no build existente
        const buildCmd = scripts.build;
        const previewCmd = /vite\b/.test(buildCmd)
          ? `${buildCmd} --mode preview`
          : buildCmd;
        scripts["build:preview"] = previewCmd;
        pkg.scripts = scripts;
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
        console.info(`[previewManager] frontend dir=${dir} (injetou build:preview → "${previewCmd}")`);
        return dir;
      }
      // Tem package.json mas sem build — segue procurando, mas guarda como fallback
    } catch (err) {
      console.warn(`[previewManager] failed to read ${pkgPath}:`, err);
    }
  }

  // Nenhum candidato com build — usa o primeiro package.json achado, ou worktree root
  const fallback = firstWithPkg ?? worktreePath;
  console.warn(`[previewManager] nenhum build script encontrado — usando ${fallback} como fallback`);
  return fallback;
};

/** Tenta descobrir distDir. Prefere o configurado; fallback heuristico. */
const resolveDistDir = (worktreePath: string, configured?: string): string | null => {
  if (configured) {
    const p = pathResolve(worktreePath, configured);
    if (existsSync(join(p, "index.html"))) return p;
  }
  // Heuristica
  const candidates = [
    "frontend/dist",
    "apps/web/dist",
    "apps/frontend/dist",
    "web/dist",
    "client/dist",
    "dist"
  ];
  for (const c of candidates) {
    const p = pathResolve(worktreePath, c);
    if (existsSync(join(p, "index.html"))) return p;
  }
  return null;
};

/** Roda comando one-shot e rejeita se exit != 0. */
const runOneShot = (cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<void> => {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`timeout ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}: ${stderr.slice(-500)}`));
    });
    child.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
  });
};

/** Roda comando shell (string com possiveis &&, |, etc) via sh -c. */
const runShell = (
  cmd: string,
  cwd: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
    const child = spawn("sh", ["-c", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`timeout ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}: ${stderr.slice(-500)}`));
    });
    child.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
  });
};

/** Espera stdout do processo conter o regex. Retorna true/false. */
const waitForStdoutMatch = (
  child: ChildProcess,
  re: RegExp,
  timeoutMs: number
): Promise<boolean> => {
  return new Promise(resolve => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    const onData = (chunk: Buffer): void => {
      if (re.test(chunk.toString())) finish(true);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", () => finish(false));

    const timer = setTimeout(() => finish(false), timeoutMs);
  });
};

/** Espera URL aparecer na stdout/stderr. Retorna a URL ou null. */
const waitForUrlMatch = (
  child: ChildProcess,
  re: RegExp,
  timeoutMs: number
): Promise<string | null> => {
  return new Promise(resolve => {
    let settled = false;
    const finish = (url: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(url);
    };

    const onData = (chunk: Buffer): void => {
      const m = chunk.toString().match(re);
      if (m) finish(m[0]!);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", () => finish(null));

    const timer = setTimeout(() => finish(null), timeoutMs);
  });
};
