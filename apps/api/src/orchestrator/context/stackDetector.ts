/**
 * Stack detector — plan #12.
 *
 * Identifica a stack primaria + frameworks de um worktree via arquivos-marca.
 * Cada gate downstream (staticChecks, uxCritic, runtimeVerifier, preview)
 * consulta o resultado pra adaptar comando/skip.
 *
 * Detecta:
 *   - node     (package.json) + frameworks: vite/next/nuxt/express/fastify/vue/react
 *   - python   (pyproject.toml ou requirements.txt) + frameworks: django/fastapi/flask
 *   - go       (go.mod)
 *   - rust     (Cargo.toml)
 *
 * Resultado eh idempotente (best-effort cache: chamadas repetidas sao baratas, le 1-3 arquivos).
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type PrimaryStack = "node" | "python" | "go" | "rust" | "unknown";

export type DetectedStack = {
  primary: PrimaryStack;
  frameworks: string[];
  /** Pra UI: stack tem UI (eh app rodavel via HTTP) ou eh CLI/lib? */
  hasUI: boolean;
  /** Pra ux/runtime gates: comando de check estatico (tsc/ruff/go vet/cargo). */
  staticCheckCmd?: { command: string; args: string[] };
  /** Comando de preview/serve default — usado se project.previewBuildCmd nao setado. */
  previewBuildCmd?: string;
  /** Heuristica de razao quando primary="unknown". */
  reason?: string;
};

const NODE_FRAMEWORK_MARKERS: Record<string, string> = {
  vite: "vite",
  "@vitejs/plugin-vue": "vue",
  "@vitejs/plugin-react": "react",
  next: "next",
  nuxt: "nuxt",
  "@nuxt/kit": "nuxt",
  express: "express",
  fastify: "fastify",
  "@nestjs/core": "nest",
  react: "react",
  vue: "vue",
  svelte: "svelte",
  "@angular/core": "angular"
};

const PYTHON_FRAMEWORK_MARKERS: Record<string, string> = {
  django: "django",
  fastapi: "fastapi",
  flask: "flask",
  starlette: "starlette",
  uvicorn: "uvicorn",
  pytest: "pytest"
};

const UI_FRAMEWORKS = new Set([
  "vue", "react", "svelte", "angular", "next", "nuxt", "vite",
  "django", "flask", "fastapi" // tambem podem servir HTML
]);

const HTTP_FRAMEWORKS = new Set([
  "express", "fastify", "nest", "next", "nuxt", "django", "flask", "fastapi", "starlette", "uvicorn"
]);

const readJsonSafe = async (p: string): Promise<Record<string, unknown> | null> => {
  try {
    const content = await readFile(p, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const readTextSafe = async (p: string): Promise<string | null> => {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return null;
  }
};

const detectNodeFrameworks = (pkg: Record<string, unknown>): string[] => {
  const deps = {
    ...(pkg.dependencies as Record<string, unknown> | undefined),
    ...(pkg.devDependencies as Record<string, unknown> | undefined),
    ...(pkg.peerDependencies as Record<string, unknown> | undefined)
  };
  const out = new Set<string>();
  for (const [name, label] of Object.entries(NODE_FRAMEWORK_MARKERS)) {
    if (deps[name] !== undefined) out.add(label);
  }
  return Array.from(out);
};

const detectPythonFrameworks = (text: string): string[] => {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (const [marker, label] of Object.entries(PYTHON_FRAMEWORK_MARKERS)) {
    // requirements style: "django==4.2" / pyproject: "django = ..."
    const re = new RegExp(`(^|[\\n\\s"'\\[\\(])${marker}[\\s=><~"\\]]`);
    if (re.test(lower)) out.add(label);
  }
  return Array.from(out);
};

/**
 * Detecta a stack do worktree. Best-effort; em caso de erro retorna unknown.
 * Cap em ~3 arquivos lidos pra ficar barato (chamado 1x por subtask/project).
 */
export const detectStack = async (worktreePath: string): Promise<DetectedStack> => {
  if (!worktreePath || !existsSync(worktreePath)) {
    return { primary: "unknown", frameworks: [], hasUI: false, reason: "no_worktree" };
  }

  // Node (highest priority — most common in this project's ecosystem)
  const pkgPath = join(worktreePath, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = await readJsonSafe(pkgPath);
    if (pkg) {
      const frameworks = detectNodeFrameworks(pkg);
      const hasUI = frameworks.some(f => UI_FRAMEWORKS.has(f));
      const isHttp = frameworks.some(f => HTTP_FRAMEWORKS.has(f));
      const scripts = (pkg.scripts as Record<string, unknown> | undefined) ?? {};
      let previewBuildCmd: string | undefined;
      // Prefer "build:preview" -> "build" -> "start" -> "dev"
      if (typeof scripts["build:preview"] === "string") previewBuildCmd = "npm run build:preview";
      else if (typeof scripts.build === "string" && hasUI) previewBuildCmd = "npm run build";
      else if (typeof scripts.start === "string" && isHttp) previewBuildCmd = "npm start";
      return {
        primary: "node",
        frameworks,
        hasUI: hasUI || isHttp,
        staticCheckCmd: { command: "npx", args: ["tsc", "--noEmit"] },
        previewBuildCmd
      };
    }
  }

  // Python
  const pyproject = join(worktreePath, "pyproject.toml");
  const requirements = join(worktreePath, "requirements.txt");
  if (existsSync(pyproject) || existsSync(requirements)) {
    const text = (await readTextSafe(pyproject)) ?? (await readTextSafe(requirements)) ?? "";
    const frameworks = detectPythonFrameworks(text);
    const hasUI = frameworks.some(f => HTTP_FRAMEWORKS.has(f));
    return {
      primary: "python",
      frameworks,
      hasUI,
      staticCheckCmd: { command: "npx", args: ["ruff", "check", "."] }, // ruff via npx-equivalent; fallback graceful
      previewBuildCmd: frameworks.includes("uvicorn") || frameworks.includes("fastapi")
        ? "uvicorn app:app --host 0.0.0.0 --port 8000"
        : frameworks.includes("django")
          ? "python manage.py runserver 0.0.0.0:8000"
          : undefined
    };
  }

  // Go
  const goMod = join(worktreePath, "go.mod");
  if (existsSync(goMod)) {
    return {
      primary: "go",
      frameworks: [],
      hasUI: false, // assume CLI by default
      staticCheckCmd: { command: "go", args: ["vet", "./..."] },
      previewBuildCmd: "go run ."
    };
  }

  // Rust
  const cargoToml = join(worktreePath, "Cargo.toml");
  if (existsSync(cargoToml)) {
    return {
      primary: "rust",
      frameworks: [],
      hasUI: false,
      staticCheckCmd: { command: "cargo", args: ["check"] },
      previewBuildCmd: "cargo run"
    };
  }

  return { primary: "unknown", frameworks: [], hasUI: false, reason: "no_known_markers" };
};
