import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSettingsCollection } from "../../core/mongo.js";
import { searchLessons, formatLessonsBlock } from "../memory/lessons.js";
import { getProjectDecisions, formatDecisionsBlock } from "../memory/projectDecisions.js";

// ============== TYPES ==============

export type ProjectContextSource = {
  /** Path to a worktree to read CLAUDE.md and package.json from. */
  worktreePath?: string;
  /** Repo identifier (owner/name) used as cache key + Mongo lookup key. */
  repoKey?: string;
  /**
   * Texto da tarefa/subtarefa. Quando presente, faz RAG sobre `project_lessons`
   * e injeta as top-K mais relevantes. Sem query -> sem licoes.
   */
  query?: string;
  /** Quantas licoes injetar (default 3, cap 10). */
  lessonsK?: number;
};

export type ProjectContext = {
  /** Free-form text block ready to inject into a system prompt. */
  text: string;
  /** Sources successfully read. Used for telemetry. */
  sources: string[];
};

// ============== CONFIG ==============

const CACHE_TTL_MS = 5 * 60 * 1000; // 5min
const CLAUDE_MD_CAP = 4000;         // chars
const NOTES_CAP = 2000;             // chars (Mongo notes)
const SETTINGS_KEY = "projectContext"; // Mongo doc { key, value: { repoKey: notes } }

// ============== CACHE ==============

// Cache so o pedaco ESTATICO (stack + CLAUDE.md + Mongo notes). Licoes RAG
// dependem do query e sao buscadas em todo call (search e barato).
type StaticPart = { sections: string[]; sources: string[] };
const staticCache = new Map<string, { part: StaticPart; expiresAt: number }>();

const cacheKey = (s: ProjectContextSource): string =>
  `${s.repoKey ?? "_"}|${s.worktreePath ?? "_"}`;

/** Limpa o cache — uso: UI quando user editar projectContext em settings. */
export const clearProjectContextCache = (): void => {
  staticCache.clear();
};

// ============== HELPERS ==============

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const readTextSafe = async (path: string, maxChars: number): Promise<string | null> => {
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    return raw.length > maxChars ? raw.slice(0, maxChars) + "\n[... truncado]" : raw;
  } catch {
    return null;
  }
};

const readJsonSafe = async <T>(path: string): Promise<T | null> => {
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

/**
 * Detecta stack a partir das deps do package.json. Lista expandivel —
 * cada chave e a tecnologia, valor sao os pacotes-indicio.
 */
const STACK_HINTS: Record<string, string[]> = {
  "Vue 3": ["vue", "@vue/runtime-core"],
  "React": ["react"],
  "Svelte": ["svelte"],
  "Vite": ["vite"],
  "Next.js": ["next"],
  "Nuxt": ["nuxt"],
  "Fastify": ["fastify"],
  "Express": ["express"],
  "NestJS": ["@nestjs/core"],
  "TypeScript": ["typescript"],
  "MongoDB": ["mongodb", "mongoose"],
  "PostgreSQL": ["pg", "pg-promise"],
  "MySQL": ["mysql", "mysql2"],
  "Prisma": ["@prisma/client"],
  "Drizzle": ["drizzle-orm"],
  "Tailwind": ["tailwindcss"],
  "Pinia": ["pinia"],
  "Vuex": ["vuex"],
  "Redux": ["@reduxjs/toolkit", "redux"],
  "TanStack Query": ["@tanstack/query-core", "@tanstack/react-query", "@tanstack/vue-query"],
  "Axios": ["axios"],
  "Vitest": ["vitest"],
  "Playwright": ["playwright", "@playwright/test"],
  "ESLint": ["eslint"],
  "Baileys (WhatsApp)": ["@whiskeysockets/baileys"]
};

const detectStack = (pkg: PackageJson | null): string[] => {
  if (!pkg) return [];
  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const out: string[] = [];
  for (const [label, hints] of Object.entries(STACK_HINTS)) {
    if (hints.some(h => h in allDeps)) out.push(label);
  }
  return out;
};

/** Le notas customizadas do Mongo (settings.projectContext.<repoKey>). */
const readMongoNotes = async (repoKey: string | undefined): Promise<string | null> => {
  if (!repoKey) return null;
  try {
    const col = await getSettingsCollection();
    const doc = await col.findOne({ key: SETTINGS_KEY });
    const map = (doc?.value as Record<string, string> | undefined) ?? {};
    const text = map[repoKey];
    if (!text || typeof text !== "string") return null;
    return text.length > NOTES_CAP ? text.slice(0, NOTES_CAP) + "\n[... truncado]" : text;
  } catch {
    return null;
  }
};

/** Salva notas customizadas. Util pra rota /api/settings/project-context. */
export const setProjectContextNotes = async (repoKey: string, notes: string): Promise<void> => {
  const col = await getSettingsCollection();
  await col.updateOne(
    { key: SETTINGS_KEY },
    { $set: { [`value.${repoKey}`]: notes, updatedAt: new Date() } },
    { upsert: true }
  );
  clearProjectContextCache();
};

// ============== MAIN ==============

/**
 * Constroi um bloco [PROJECT CONTEXT] consolidado pra injecao em system prompt.
 * Composto por: stack detectado (package.json), CLAUDE.md do repo se existir,
 * e notas custom do Mongo (settings.projectContext.<repoKey>).
 *
 * Quando nenhuma fonte produz conteudo, retorna text="" (caller injeta vazio).
 * Cache 5min por (repoKey, worktreePath).
 */
/** Resolve a parte estatica (stack + CLAUDE.md + Mongo notes) com cache 5min. */
const getStaticPart = async (source: ProjectContextSource): Promise<StaticPart> => {
  const ck = cacheKey(source);
  const now = Date.now();
  const hit = staticCache.get(ck);
  if (hit && hit.expiresAt > now) return hit.part;

  const sources: string[] = [];
  const sections: string[] = [];

  // 1. Stack detectado (so se temos worktree)
  if (source.worktreePath) {
    const pkg = await readJsonSafe<PackageJson>(join(source.worktreePath, "package.json"));
    const stack = detectStack(pkg);
    if (stack.length > 0) {
      sections.push(`Stack detectado: ${stack.join(", ")}.`);
      sources.push("package.json");
    }

    // 2. CLAUDE.md (convencao comum pra instrucoes do projeto)
    const claudeMd = await readTextSafe(join(source.worktreePath, "CLAUDE.md"), CLAUDE_MD_CAP);
    if (claudeMd) {
      sections.push(`Convencoes do projeto (de CLAUDE.md):\n${claudeMd.trim()}`);
      sources.push("CLAUDE.md");
    }
  }

  // 3. Notas custom (Mongo settings)
  const notes = await readMongoNotes(source.repoKey);
  if (notes) {
    sections.push(`Notas adicionais do mantenedor:\n${notes.trim()}`);
    sources.push("settings.projectContext");
  }

  // 4. Project decisions persistidas (#4 plan W4)
  if (source.repoKey) {
    const decisions = await getProjectDecisions(source.repoKey);
    const decisionsBlock = formatDecisionsBlock(decisions);
    if (decisionsBlock) {
      sections.push(decisionsBlock);
      sources.push(`project_decisions(${decisions.length})`);
    }
  }

  const part: StaticPart = { sections, sources };
  staticCache.set(ck, { part, expiresAt: now + CACHE_TTL_MS });
  return part;
};

export const getProjectContext = async (source: ProjectContextSource): Promise<ProjectContext> => {
  const staticPart = await getStaticPart(source);

  const sections = [...staticPart.sections];
  const sources = [...staticPart.sources];

  // 4. RAG sobre licoes — so se query foi fornecido
  if (source.query && source.query.trim().length > 0) {
    const lessons = await searchLessons(source.query, {
      k: source.lessonsK ?? 3,
      repoKey: source.repoKey
    });
    if (lessons.length > 0) {
      const block = formatLessonsBlock(lessons);
      if (block) {
        sections.push(block);
        sources.push(`lessons(${lessons.length})`);
      }
    }
  }

  const text = sections.length > 0
    ? `[PROJECT CONTEXT]\n${sections.join("\n\n")}`
    : "";

  return { text, sources };
};

/**
 * Helper pra anexar context.text a um system prompt existente.
 * Se text vazio, retorna basePrompt inalterado.
 */
export const appendProjectContext = (basePrompt: string, ctx: ProjectContext | string | undefined): string => {
  const block = typeof ctx === "string" ? ctx : (ctx?.text ?? "");
  if (!block) return basePrompt;
  return `${basePrompt}\n\n${block}`;
};
