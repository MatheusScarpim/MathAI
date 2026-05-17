import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewComment } from "./reviewer.js";
import type { DetectedStack } from "../context/stackDetector.js";

// ============== TYPES ==============

export type StaticCheckResult = {
  /** Comments derivados (compativeis com o ReviewResult do LLM reviewer). */
  comments: ReviewComment[];
  /** Ferramentas que rodaram com sucesso (tsc, eslint, npm-lint). */
  ran: string[];
  /** Ferramentas puladas (sem config) + motivo. */
  skipped: { tool: string; reason: string }[];
  /** Ferramentas que crasharam (timeout / erro interno). Nao bloqueia subtask. */
  errored: { tool: string; error: string }[];
  durationMs: number;
};

// ============== CONFIG ==============

/** Tempo maximo por ferramenta. tsc em projeto grande pode ser lento. */
const PER_TOOL_TIMEOUT_MS = 120_000;

/** Cap em quantos comments retornar — evita inundar o reviewer-loop. */
const MAX_COMMENTS = 30;

// ============== HELPERS ==============

type ExecResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean };

const runCmd = (cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<ExecResult> =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, shell: false }, (err, stdout, stderr) => {
      // err.killed = true quando o timeout dispara
      const killed = !!(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed);
      const code = err && typeof (err as NodeJS.ErrnoException).code === "number"
        ? ((err as NodeJS.ErrnoException).code as unknown as number)
        : (err ? 1 : 0);
      resolve({
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        exitCode: code,
        timedOut: killed
      });
    });
  });

const readJsonSafe = async <T>(path: string): Promise<T | null> => {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

// ============== TSC PARSING ==============

// Match: src/foo.ts(12,5): error TS2304: Cannot find name 'bar'.
const TSC_LINE_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/;

const parseTscOutput = (output: string): ReviewComment[] => {
  const out: ReviewComment[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const m = TSC_LINE_RE.exec(rawLine.trim());
    if (!m) continue;
    out.push({
      file: m[1]!,
      line: Number(m[2]),
      severity: m[4] === "error" ? "error" : "warning",
      message: `[tsc] ${m[5]!.trim()}`
    });
  }
  return out;
};

// ============== ESLINT JSON PARSING ==============

type EslintMessage = {
  ruleId: string | null;
  severity: number; // 1 = warning, 2 = error
  message: string;
  line?: number;
  column?: number;
};
type EslintFile = {
  filePath: string;
  messages: EslintMessage[];
};

const parseEslintJson = (output: string, cwd: string): ReviewComment[] => {
  const trimmed = output.trim();
  if (!trimmed) return [];
  // ESLint pode escrever logs antes do JSON quando flags estao erradas. Procura
  // o primeiro `[` valido pra ser tolerante.
  const firstBracket = trimmed.indexOf("[");
  if (firstBracket < 0) return [];
  let parsed: EslintFile[];
  try {
    parsed = JSON.parse(trimmed.slice(firstBracket)) as EslintFile[];
  } catch {
    return [];
  }
  const out: ReviewComment[] = [];
  for (const f of parsed) {
    // Path relativo ao worktree pra o LLM reconhecer
    const rel = f.filePath.startsWith(cwd) ? f.filePath.slice(cwd.length + 1) : f.filePath;
    for (const m of f.messages) {
      out.push({
        file: rel,
        line: m.line,
        severity: m.severity === 2 ? "error" : "warning",
        message: `[eslint${m.ruleId ? ` ${m.ruleId}` : ""}] ${m.message}`
      });
    }
  }
  return out;
};

// ============== DISCOVERY ==============

type PackageJson = {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};

const hasFile = (worktree: string, name: string): boolean => existsSync(join(worktree, name));

const hasEslintConfig = (worktree: string): boolean =>
  [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc.yaml"
  ].some(name => hasFile(worktree, name));

// ============== MAIN ==============

/**
 * Roda ferramentas estaticas (tsc, eslint, npm run lint) no worktree e converte
 * a saida em ReviewComment[] que alimenta o reviewer-loop existente.
 *
 * Design:
 * - Auto-detecta config files antes de invocar (sem config -> skipped, nao erro)
 * - Cada ferramenta tem timeout duro de 2min
 * - Crash interno (timeout, comando faltando) nao bloqueia subtask -> entra em `errored`
 * - Cap em MAX_COMMENTS pra nao explodir o prompt da rodada de correcao
 *
 * Stack agnostico (G3): aceita DetectedStack opcional. Quando stack.primary !=
 * "node", roda stack.staticCheckCmd (ruff/go vet/cargo check) ao inves de tsc.
 * Sem stack -> assume Node (back-compat).
 */
export const runStaticChecks = async (
  worktreePath: string,
  stack?: DetectedStack
): Promise<StaticCheckResult> => {
  const t0 = Date.now();
  const ran: string[] = [];
  const skipped: { tool: string; reason: string }[] = [];
  const errored: { tool: string; error: string }[] = [];
  const allComments: ReviewComment[] = [];

  // G3: stack nao-Node — roda staticCheckCmd dela e curto-circuita o resto.
  if (stack && stack.primary !== "node" && stack.primary !== "unknown" && stack.staticCheckCmd) {
    const { command, args } = stack.staticCheckCmd;
    try {
      const res = await runCmd(command, args, worktreePath, PER_TOOL_TIMEOUT_MS);
      if (res.timedOut) {
        errored.push({ tool: `${stack.primary}-check`, error: `timeout (${PER_TOOL_TIMEOUT_MS}ms)` });
      } else {
        // Parse generico file:line: msg (cobre go vet, cargo, ruff)
        const GENERIC_RE = /^([^\s][^:\n]*?):(\d+)(?::(\d+))?:\s*(.+)$/;
        const comments: ReviewComment[] = [];
        for (const line of (res.stdout + "\n" + res.stderr).split(/\r?\n/)) {
          const m = GENERIC_RE.exec(line);
          if (!m) continue;
          const lower = m[4]!.toLowerCase();
          const severity: ReviewComment["severity"] = lower.includes("error") ? "error" : "warning";
          comments.push({
            file: m[1]!,
            line: Number(m[2]),
            severity,
            message: `[${stack.primary}-check] ${m[4]!.trim()}`
          });
        }
        if (comments.length === 0 && res.exitCode !== 0) {
          allComments.push({
            file: `<${stack.primary}-check>`,
            severity: "warning",
            message: `[${stack.primary}-check] exit=${res.exitCode}: ${(res.stdout + res.stderr).slice(0, 300)}`
          });
        } else {
          allComments.push(...comments);
        }
        ran.push(`${stack.primary}-check(${comments.length})`);
      }
    } catch (e) {
      errored.push({ tool: `${stack.primary}-check`, error: e instanceof Error ? e.message : String(e) });
    }
    return {
      comments: allComments.slice(0, MAX_COMMENTS),
      ran,
      skipped,
      errored,
      durationMs: Date.now() - t0
    };
  }

  const pkg = await readJsonSafe<PackageJson>(join(worktreePath, "package.json"));

  // ---- 1. TypeScript: tsc --noEmit ----
  // Requer node_modules/typescript instalado no worktree (--no-install evita
  // que npx baixe pacote on-the-fly, o que seria caro e flaky).
  const hasTscBinary = existsSync(join(worktreePath, "node_modules", "typescript", "bin", "tsc"))
    || existsSync(join(worktreePath, "node_modules", ".bin", "tsc"));
  if (hasFile(worktreePath, "tsconfig.json") && hasTscBinary) {
    try {
      const res = await runCmd("npx", ["--no-install", "tsc", "--noEmit", "--pretty", "false"], worktreePath, PER_TOOL_TIMEOUT_MS);
      if (res.timedOut) {
        errored.push({ tool: "tsc", error: `timeout (${PER_TOOL_TIMEOUT_MS}ms)` });
      } else {
        // tsc escreve diagnostics no stdout
        const comments = parseTscOutput(res.stdout + "\n" + res.stderr);
        allComments.push(...comments);
        ran.push(`tsc(${comments.length})`);
      }
    } catch (e) {
      errored.push({ tool: "tsc", error: e instanceof Error ? e.message : String(e) });
    }
  } else if (!hasFile(worktreePath, "tsconfig.json")) {
    skipped.push({ tool: "tsc", reason: "no tsconfig.json at worktree root" });
  } else {
    skipped.push({ tool: "tsc", reason: "typescript not installed in worktree node_modules" });
  }

  // ---- 2. ESLint: npm run lint > npx eslint . ----
  // Prefere o script do projeto (respeita config customizado/monorepo).
  // Quando rodando via npm script, perdemos o JSON formatter — entao caimos
  // pra plain parsing (atualmente pulamos quando nao for JSON, evita falso
  // positivo). Default: npx eslint . --format json.
  const hasLintScript = !!pkg?.scripts?.lint;
  if (hasLintScript) {
    try {
      const res = await runCmd("npm", ["run", "--silent", "lint"], worktreePath, PER_TOOL_TIMEOUT_MS);
      if (res.timedOut) {
        errored.push({ tool: "npm-lint", error: `timeout (${PER_TOOL_TIMEOUT_MS}ms)` });
      } else {
        // Plain output — extrai linhas que parecem "file:line:col" com nivel
        const PLAIN_RE = /^([^\s][^:\n]+?):(\d+):(\d+):\s*(error|warning|warn)\s+(.+)$/i;
        const comments: ReviewComment[] = [];
        for (const line of (res.stdout + "\n" + res.stderr).split(/\r?\n/)) {
          const m = PLAIN_RE.exec(line);
          if (!m) continue;
          comments.push({
            file: m[1]!,
            line: Number(m[2]),
            severity: m[4]!.toLowerCase().startsWith("err") ? "error" : "warning",
            message: `[lint] ${m[5]!.trim()}`
          });
        }
        // exit !=0 sem comments parseaveis ainda pode ser sinal de problema
        if (comments.length === 0 && res.exitCode !== 0) {
          allComments.push({
            file: "<lint>",
            severity: "warning",
            message: `[lint] script saiu com exit=${res.exitCode} mas saida nao parseavel (${(res.stdout + res.stderr).slice(0, 300)})`
          });
        } else {
          allComments.push(...comments);
        }
        ran.push(`npm-lint(${comments.length})`);
      }
    } catch (e) {
      errored.push({ tool: "npm-lint", error: e instanceof Error ? e.message : String(e) });
    }
  } else if (hasEslintConfig(worktreePath) && existsSync(join(worktreePath, "node_modules", ".bin", "eslint"))) {
    try {
      const res = await runCmd("npx", ["--no-install", "eslint", ".", "--format", "json"], worktreePath, PER_TOOL_TIMEOUT_MS);
      if (res.timedOut) {
        errored.push({ tool: "eslint", error: `timeout (${PER_TOOL_TIMEOUT_MS}ms)` });
      } else {
        const comments = parseEslintJson(res.stdout, worktreePath);
        allComments.push(...comments);
        ran.push(`eslint(${comments.length})`);
      }
    } catch (e) {
      errored.push({ tool: "eslint", error: e instanceof Error ? e.message : String(e) });
    }
  } else if (!hasEslintConfig(worktreePath)) {
    skipped.push({ tool: "eslint", reason: "no lint script nor eslint config" });
  } else {
    skipped.push({ tool: "eslint", reason: "eslint config present but binary not installed in node_modules" });
  }

  // ---- Cap + prioriza errors ----
  const errors = allComments.filter(c => c.severity === "error");
  const warnings = allComments.filter(c => c.severity === "warning");
  const infos = allComments.filter(c => c.severity === "info");
  const capped: ReviewComment[] = [];
  for (const c of [...errors, ...warnings, ...infos]) {
    if (capped.length >= MAX_COMMENTS) break;
    capped.push(c);
  }

  return {
    comments: capped,
    ran,
    skipped,
    errored,
    durationMs: Date.now() - t0
  };
};
