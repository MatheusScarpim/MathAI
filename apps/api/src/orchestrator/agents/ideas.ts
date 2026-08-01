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

import { createHash } from "node:crypto";
import { config } from "../../core/config.js";
import { runOpenClaude } from "../integrations/openclaude.js";
import { markProviderDown } from "../routing/router.js";
import {
  getTasksCollection,
  getProjectsCollection,
  getIdeaSuggestionsCollection,
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
  /** Indica se o LLM nao achou nada relevante (vazio LEGITIMO). */
  empty?: boolean;
  /** True quando a geracao FALHOU (LLM/parse) — distinto de "nada relevante". */
  failed?: boolean;
  /** Motivo humano da falha (quando failed=true). */
  error?: string;
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
  projects: Array<{ name: string; repoCount: number; hasTrello: boolean; openTasks: number; lastActivityDays?: number }>;
  stats: {
    last7d: { total: number; completed: number; failed: number; cancelled: number };
    last24h: { total: number };
    /** Baseline pra categoria "performance" — media de duracao das tasks concluidas (7d). */
    avgDurationMin?: number;
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

  // Stuck PRs: query PROPRIA numa janela de 30d (independente da janela de 7d
  // das tasks) — antes PRs de 8+ dias caiam fora da janela e nunca eram flagados.
  const day30 = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const stuckPrs: IdeasContext["stuckPrs"] = [];
  const prTasks = await tasksCol
    .find({
      ...baseFilter,
      createdAt: { $gte: day30 },
      githubPrUrls: { $exists: true, $ne: [] }
    } as Record<string, unknown>)
    .sort({ createdAt: 1 })
    .limit(40)
    .toArray();
  for (const t of prTasks) {
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
  // Ordena mais antigos primeiro e limita a 10 pra nao inundar o prompt.
  stuckPrs.sort((a, b) => b.ageDays - a.ageDays);
  stuckPrs.splice(10);

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

  // #3 performance: baseline de duracao media (tasks concluidas na janela de 7d).
  const durations = tasks
    .filter(t => t.completedAt)
    .map(t => Math.max(0, Math.floor((new Date(t.completedAt!).getTime() - new Date(t.createdAt).getTime()) / 60000)))
    .filter(d => d > 0);
  const avgDurationMin = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : undefined;

  // #3 inactive-project: ultima atividade POR projeto (query propria, sem janela)
  // — a janela de 7d das tasks nao serve pra detectar projeto parado ha semanas.
  const lastActivityByProject = new Map<string, number>();
  const activityAgg = await tasksCol
    .aggregate<{ _id: string | null; last: Date }>([
      { $match: { ...baseFilter, projectId: { $exists: true, $ne: null } } },
      { $group: { _id: "$projectId", last: { $max: "$createdAt" } } }
    ])
    .toArray();
  for (const row of activityAgg) {
    if (!row._id || !row.last) continue;
    const days = Math.floor((now - new Date(row.last).getTime()) / (24 * 60 * 60 * 1000));
    lastActivityByProject.set(row._id, days);
  }

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
    projects: projects.map(p => {
      const pid = p._id?.toString() ?? "";
      return {
        name: p.name,
        repoCount: (p.repoIds ?? []).length,
        hasTrello: !!p.trelloBoardId,
        openTasks: openByProject.get(pid) ?? 0,
        lastActivityDays: lastActivityByProject.get(pid)
      };
    }),
    stats: { last7d, last24h, avgDurationMin },
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

// ─── Fleet call (claude primario, codex distribui) ──────────────────────

/** Ordem de tentativa: claude-opus (o "maior") primeiro, codex distribui/fallback. */
const FLEET_ORDER: Array<{ provider: "anthropic" | "codex"; model: string }> = [
  { provider: "anthropic", model: "claude-opus-4-8" },
  { provider: "codex", model: "codexplan" }
];

/** Extrai o primeiro objeto JSON de um texto (tolera cercas ```json e prosa em volta). */
const extractJson = (text: string): unknown => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("sem objeto JSON na resposta");
  return JSON.parse(candidate.slice(start, end + 1));
};

/** Validacao defensiva das ideias vindas do LLM. */
const validateIdeas = (parsed: unknown): Idea[] => {
  const arr = parsed && typeof parsed === "object" && Array.isArray((parsed as { ideas?: unknown }).ideas)
    ? (parsed as { ideas: Idea[] }).ideas.slice(0, 3)
    : [];
  return arr
    .filter(i => i && typeof i.signal === "string" && typeof i.suggestion === "string")
    .map(i => ({
      category: typeof i.category === "string" ? i.category as IdeaCategory : "other",
      signal: i.signal,
      suggestion: i.suggestion,
      effort: ["small", "medium", "large"].includes(i.effort as string) ? i.effort : "medium"
    } as Idea));
};

/**
 * Chama a fleet OpenClaude em ordem (claude → codex). Primeiro provider que
 * responder JSON parseavel vence. Distingue:
 *  - erro de TRANSPORTE (empty-stream/gRPC/timeout) → markProviderDown (router pula 60s) + proximo
 *  - erro de PARSE (respondeu mas mal formatado) → NAO marca down (provider esta vivo) + proximo
 * Se todos falharem, failed=true (dispatchIdeas avisa "sweep falhou").
 */
const runIdeasViaFleet = async (
  userPrompt: string,
  preferProvider?: "anthropic" | "codex"
): Promise<IdeasResult> => {
  const prompt = `${SYSTEM_PROMPT}\n\n${userPrompt}\n\nIMPORTANTE: responda APENAS com o JSON pedido, sem texto fora dele e sem usar ferramentas.`;
  const errors: string[] = [];

  // Reordena a fleet quando preferProvider setado (ex: analise de melhorias via codex).
  // Fallback mantem o outro provider na sequencia.
  const order = preferProvider
    ? [...FLEET_ORDER].sort((a, b) => (a.provider === preferProvider ? -1 : b.provider === preferProvider ? 1 : 0))
    : FLEET_ORDER;

  for (const route of order) {
    const grpcUrl = config.openclaude.providers?.[route.provider];
    if (!grpcUrl) { errors.push(`${route.provider}: sem grpcUrl`); continue; }

    let result: { fullText: string; promptTokens: number; completionTokens: number };
    try {
      result = await runOpenClaude(prompt, {
        workingDirectory: "/tmp",
        model: route.model,
        grpcUrl,
        autoApprove: true,
        timeoutMs: 120_000,
        onEvent: () => {}
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${route.provider}: transporte ${msg.slice(0, 100)}`);
      markProviderDown(grpcUrl); // empty-stream/gRPC/timeout → pula esse provider por 60s
      console.warn(`[ideas] provider ${route.provider} (transporte) falhou: ${msg.slice(0, 160)}`);
      continue;
    }

    try {
      const validated = validateIdeas(extractJson(result.fullText));
      return {
        ideas: validated,
        empty: validated.length === 0,
        usage: { prompt_tokens: result.promptTokens, completion_tokens: result.completionTokens }
      };
    } catch (perr) {
      const msg = perr instanceof Error ? perr.message : String(perr);
      errors.push(`${route.provider}: parse ${msg.slice(0, 100)}`);
      console.warn(`[ideas] provider ${route.provider} respondeu mas parse falhou: ${msg.slice(0, 160)}`);
      // NAO marca down — o provider esta vivo, so nao formatou direito.
    }
  }

  return { ideas: [], empty: false, failed: true, error: `fleet falhou (${errors.join(" | ")})` };
};

// ─── Main ───────────────────────────────────────────────────────────────

export const generateIdeas = async (
  userId?: string,
  opts?: { preferProvider?: "anthropic" | "codex" }
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
- Canceladas: ${context.stats.last7d.cancelled}${context.stats.avgDurationMin !== undefined ? `\n- Duracao media (concluidas): ${context.stats.avgDurationMin}min` : ""}

PROJETOS:
${context.projects.length > 0
  ? context.projects.map(p => `- ${p.name}: ${p.repoCount} repos · Trello ${p.hasTrello ? "ON" : "OFF"} · ${p.openTasks} tasks abertas${p.lastActivityDays !== undefined ? ` · ultima atividade ha ${p.lastActivityDays}d` : " · sem atividade registrada"}`).join("\n")
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

  // Roteia via fleet OpenClaude: claude-opus PRIMARIO (o "maior"), codex como
  // distribuicao/fallback. So esses dois tem reasoning effort — deepseek nao.
  const generated = await runIdeasViaFleet(userPrompt, opts?.preferProvider);

  // Se falhou, propaga sem tentar dedup.
  if (generated.failed) return generated;

  // #5 dedup: remove ideias ja sugeridas nos ultimos 14d (TTL da collection),
  // registra as novas. Evita repetir a mesma sugestao todo fim de semana.
  const deduped = await applyDedup(userId, generated.ideas);
  return { ...generated, ideas: deduped, empty: deduped.length === 0 };
};

/** Fingerprint estavel de uma ideia (categoria + sugestao normalizada). */
const ideaFingerprint = (idea: Idea): string => {
  const norm = idea.suggestion.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 160);
  return createHash("sha1").update(`${idea.category}|${norm}`).digest("hex");
};

/**
 * Filtra ideias ja sugeridas (dentro do TTL de 14d) e registra as emitidas.
 * Best-effort: se o Mongo falhar, retorna as ideias originais (nao bloqueia entrega).
 */
const applyDedup = async (userId: string | undefined, ideas: Idea[]): Promise<Idea[]> => {
  if (ideas.length === 0) return ideas;
  // Normaliza userId ausente para `null` (sentinela estavel). O driver serializa
  // undefined -> null no write; usar `null` tambem no read garante que o cenario
  // autonomo (sem userId, ex. schedule de fim de semana) case corretamente.
  const uid = userId ?? null;
  try {
    const col = await getIdeaSuggestionsCollection();
    const withFp = ideas.map(i => ({ idea: i, fp: ideaFingerprint(i) }));
    const fps = withFp.map(x => x.fp);
    const seen = await col
      .find({ userId: uid, fingerprint: { $in: fps } })
      .toArray();
    const seenSet = new Set(seen.map(s => s.fingerprint));

    const fresh = withFp.filter(x => !seenSet.has(x.fp));
    const now = new Date();
    // Registra/renova TODAS as emitidas nesta rodada (as frescas). Renova
    // lastSuggestedAt das ja vistas nao faz sentido — elas foram suprimidas.
    if (fresh.length > 0) {
      await col.bulkWrite(
        fresh.map(x => ({
          updateOne: {
            filter: { userId: uid, fingerprint: x.fp },
            update: {
              $set: {
                userId: uid,
                fingerprint: x.fp,
                category: x.idea.category,
                suggestion: x.idea.suggestion,
                lastSuggestedAt: now
              }
            },
            upsert: true
          }
        }))
      );
    }
    return fresh.map(x => x.idea);
  } catch (err) {
    console.warn("[ideas] dedup falhou, retornando ideias sem filtro:", err);
    return ideas;
  }
};
