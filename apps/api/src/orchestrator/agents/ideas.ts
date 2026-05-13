/**
 * Ideas agent — analisa o estado real do MathAI (tasks recentes, falhas, padroes
 * recorrentes, projetos parados) e sugere ate 3 melhorias acionaveis.
 *
 * Design anti-noise:
 *  - Foco em SINAIS concretos (numeros), nao em scan abstrato de codigo
 *  - Prompt exige "signal" (a evidencia que motivou) — sem signal nao retorna
 *  - Hard cap de 3 ideias forca priorizacao
 *  - Categorias rigidas pra evitar "geral demais"
 *  - Retorna [] se nada relevante (e isso e ok)
 */

import { getOpenAI } from "../../core/openai.js";
import { withRetry } from "./withRetry.js";
import {
  getTasksCollection,
  getProjectsCollection,
  type TaskRecord,
  type ProjectRecord
} from "../../core/mongo.js";

// ─── Types ──────────────────────────────────────────────────────────────

export type IdeaCategory =
  | "task-flaky"          // mesma area falha repetidamente
  | "recurring-pattern"   // descricao repetida -> automatizar/template
  | "stale-config"        // projeto sem repos ou Trello configurado
  | "missing-automation"  // padrao manual obvio
  | "stuck-pr"            // PR aberto sem merge ha muito tempo
  | "inactive-project"    // projeto sem atividade
  | "performance"         // task durando muito mais que media
  | "other";

export type Idea = {
  category: IdeaCategory;
  signal: string;       // dado concreto que motivou (ex: "3 tasks sobre auth falharam essa semana")
  suggestion: string;   // o que fazer
  effort: "small" | "medium" | "large";
};

export type IdeasResult = {
  ideas: Idea[];
  /** Indica se o LLM nao achou nada relevante. */
  empty?: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

// ─── Context fetcher ────────────────────────────────────────────────────

type IdeasContext = {
  recentTasks: Array<{
    id: string;
    description: string;
    status: string;
    stage?: string;
    durationMin?: number;
    error?: string;
    createdAt: string;
    projectName?: string;
  }>;
  projects: Array<{ name: string; repoCount: number; hasTrello: boolean; openTasks: number }>;
  stats: {
    last7d: { total: number; completed: number; failed: number; cancelled: number };
    last24h: { total: number };
  };
  recurringDescriptions: Array<{ pattern: string; count: number }>;
  stuckPrs: Array<{ taskId: string; description: string; ageDays: number; url: string }>;
};

const TRUNCATE_DESC = 120;

const buildContext = async (userId?: string): Promise<IdeasContext> => {
  const tasksCol = await getTasksCollection();
  const projectsCol = await getProjectsCollection();
  const baseFilter: Record<string, unknown> = {};
  if (userId) baseFilter.userId = userId;

  const now = Date.now();
  const day7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const day1 = new Date(now - 24 * 60 * 60 * 1000);

  // Tasks dos ultimos 7 dias
  const tasks = await tasksCol
    .find({ ...baseFilter, createdAt: { $gte: day7 } })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();

  // Projetos
  const projects = await projectsCol.find(baseFilter).toArray();
  const projectById = new Map<string, ProjectRecord>();
  for (const p of projects) {
    if (p._id) projectById.set(p._id.toString(), p);
  }

  // Open tasks por projeto
  const openByProject = new Map<string, number>();
  for (const t of tasks) {
    if (!t.projectId) continue;
    if (t.status !== "planning" && t.status !== "executing" && t.status !== "pending") continue;
    openByProject.set(t.projectId, (openByProject.get(t.projectId) ?? 0) + 1);
  }

  // Recurring descriptions: normaliza pra primeiros 60 chars lowercase
  const descCount = new Map<string, number>();
  for (const t of tasks) {
    const norm = t.description.split(/\r?\n/)[0]!.slice(0, 60).toLowerCase().trim();
    if (norm.length < 10) continue;
    descCount.set(norm, (descCount.get(norm) ?? 0) + 1);
  }
  const recurring = [...descCount.entries()]
    .filter(([, c]) => c >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([pattern, count]) => ({ pattern, count }));

  // Stuck PRs: tasks com PR aberto ha 3+ dias e ainda em executing/falha
  const stuckPrs: IdeasContext["stuckPrs"] = [];
  for (const t of tasks) {
    if (!t.githubPrUrls || t.githubPrUrls.length === 0) continue;
    const ageDays = Math.floor((now - new Date(t.createdAt).getTime()) / (24 * 60 * 60 * 1000));
    if (ageDays < 3) continue;
    for (const url of t.githubPrUrls) {
      stuckPrs.push({
        taskId: t._id?.toString() ?? "",
        description: t.description.split(/\r?\n/)[0]!.slice(0, TRUNCATE_DESC),
        ageDays,
        url
      });
    }
  }

  // Stats
  const last7d = {
    total: tasks.length,
    completed: tasks.filter(t => t.status === "completed").length,
    failed: tasks.filter(t => t.status === "failed").length,
    cancelled: tasks.filter(t => t.status === "cancelled").length
  };
  const last24h = {
    total: tasks.filter(t => new Date(t.createdAt) >= day1).length
  };

  // Recent tasks normalized for prompt
  const recentTasks = tasks.slice(0, 25).map((t: TaskRecord) => {
    const projectName = t.projectId ? projectById.get(t.projectId)?.name : undefined;
    const durationMin = t.completedAt
      ? Math.max(0, Math.floor((new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime()) / 60000))
      : undefined;
    return {
      id: t._id?.toString() ?? "",
      description: t.description.split(/\r?\n/)[0]!.slice(0, TRUNCATE_DESC),
      status: t.status,
      stage: t.currentStage,
      durationMin,
      error: t.subtasks.find(s => s.error)?.error?.slice(0, 200),
      createdAt: t.createdAt.toISOString().slice(0, 16),
      projectName
    };
  });

  return {
    recentTasks,
    projects: projects.map(p => ({
      name: p.name,
      repoCount: (p.repoIds ?? []).length,
      hasTrello: !!p.trelloBoardId,
      openTasks: openByProject.get(p._id?.toString() ?? "") ?? 0
    })),
    stats: { last7d, last24h },
    recurringDescriptions: recurring,
    stuckPrs
  };
};

// ─── Prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Voce analisa o estado de um sistema de orquestracao de tasks (MathAI) e sugere ate 3 melhorias acionaveis.

REGRAS DURAS:
- Toda ideia DEVE ter um "signal" — o dado concreto da contexto que motivou. Sem signal, nao inclua.
- Maximo de 3 ideias. Se nao houver nada relevante, retorne array vazio.
- Categoria DEVE ser uma destas: "task-flaky", "recurring-pattern", "stale-config", "missing-automation", "stuck-pr", "inactive-project", "performance", "other".
- "suggestion" deve ser ESPECIFICO e ACIONAVEL. Nao escreva "considere refatorar X" — escreva "extraia X em helper Y porque foi tocado por 4 tasks".
- "effort": "small" (< 1h), "medium" (~half day), "large" (> 1 day).
- Nao invente sinais — use SOMENTE o que esta no contexto.
- Priorize: tasks que falham repetidamente, descricoes recorrentes (pode virar template), PRs parados, projetos sem config completa.

RESPONDA SEMPRE em JSON valido:
{
  "ideas": [
    {
      "category": "task-flaky",
      "signal": "...",
      "suggestion": "...",
      "effort": "small"
    }
  ]
}

Se nada relevante: { "ideas": [] }`;

// ─── Main ───────────────────────────────────────────────────────────────

export const generateIdeas = async (
  userId?: string
): Promise<IdeasResult> => {
  const context = await buildContext(userId);

  // Fast path: contexto vazio
  if (context.recentTasks.length === 0 && context.projects.length === 0) {
    return { ideas: [], empty: true };
  }

  const userPrompt = `Estado atual do MathAI:

ESTATISTICAS (ultimos 7 dias):
- Total: ${context.stats.last7d.total} tasks (${context.stats.last24h.total} nas ultimas 24h)
- Concluidas: ${context.stats.last7d.completed}
- Falhas: ${context.stats.last7d.failed}
- Canceladas: ${context.stats.last7d.cancelled}

PROJETOS:
${context.projects.length > 0
  ? context.projects.map(p => `- ${p.name}: ${p.repoCount} repos · Trello ${p.hasTrello ? "ON" : "OFF"} · ${p.openTasks} tasks abertas`).join("\n")
  : "(nenhum)"}

DESCRICOES RECORRENTES (>= 2 ocorrencias):
${context.recurringDescriptions.length > 0
  ? context.recurringDescriptions.map(r => `- "${r.pattern}" (${r.count}x)`).join("\n")
  : "(nenhuma)"}

PRs PARADOS (>= 3 dias):
${context.stuckPrs.length > 0
  ? context.stuckPrs.map(p => `- ${p.ageDays}d: "${p.description}" — ${p.url}`).join("\n")
  : "(nenhum)"}

TASKS RECENTES (ate 25):
${context.recentTasks.length > 0
  ? context.recentTasks.map(t =>
      `- [${t.status}${t.stage ? `/${t.stage}` : ""}] "${t.description}"` +
      (t.projectName ? ` @ ${t.projectName}` : "") +
      (t.durationMin !== undefined ? ` (${t.durationMin}min)` : "") +
      (t.error ? ` ERR: ${t.error.slice(0, 100)}` : "")
    ).join("\n")
  : "(nenhuma)"}

Analise e retorne ate 3 ideias acionaveis com base nos sinais acima.`;

  return withRetry<IdeasResult>(
    async () => {
      const client = await getOpenAI();
      const completion = await client.chat.completions.create({
        model: "deepseek-chat",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ]
      });

      const raw = completion.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(raw) as { ideas?: Idea[] };
      const ideas = Array.isArray(parsed.ideas) ? parsed.ideas.slice(0, 3) : [];

      // Validacao defensiva
      const validated = ideas
        .filter(i => i && typeof i.signal === "string" && typeof i.suggestion === "string")
        .map(i => ({
          category: typeof i.category === "string" ? i.category as IdeaCategory : "other",
          signal: i.signal,
          suggestion: i.suggestion,
          effort: ["small", "medium", "large"].includes(i.effort as string) ? i.effort : "medium"
        } as Idea));

      return {
        ideas: validated,
        empty: validated.length === 0,
        usage: completion.usage
      };
    },
    {
      label: "ideasAgent",
      attempts: 2,
      baseDelayMs: 500,
      fallback: () => ({ ideas: [], empty: true })
    }
  );
};
