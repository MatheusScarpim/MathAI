import type { RoutingRule } from "./types.js";

/**
 * Seed rules persisted on first boot. Editable via /api/settings/routing-rules.
 * Order matters only as a tiebreaker — `priority` is authoritative.
 */
export const DEFAULT_ROUTING_RULES: RoutingRule[] = [
  // Politica "Claude na maior, codex distribui": claude-opus pra o codigo mais
  // pesado (frontend/backend complexo), codex distribui o resto (backend simples,
  // docs, api/custom, planner, reporter), reviewer em claude-sonnet (diversidade),
  // deepseek so no catch-all final.

  // Frontend complexo (dashboard, layout, chart, etc.) → Claude Opus
  {
    priority: 5,
    agent: "taskCode",
    when: { type: "github", descriptionMatches: "(dashboard|grafico|chart|layout|page|componente.complexo|design.system)" },
    route: { provider: "anthropic", model: "claude-opus-4-8" }
  },
  // Backend complexo (pipeline, orchestrator, core, etc.) → Claude Opus
  {
    priority: 10,
    agent: "taskCode",
    when: { type: "github", descriptionMatches: "(pipeline|orquestrador|core|cache|fila|queue|middleware|estrategia|strategy|event.stream|service.layer|workflow|motor|processor)" },
    route: { provider: "anthropic", model: "claude-opus-4-8" }
  },
  // Frontend (.vue, .tsx, etc.) → Claude Opus (melhor desempenho em frontend)
  {
    priority: 15,
    agent: "taskCode",
    when: { type: "github", descriptionMatches: "(vue|tsx|jsx|svelte|html|css)" },
    route: { provider: "anthropic", model: "claude-opus-4-8" }
  },
  // Backend simples (rotas, controllers, models, etc.) → Codex (distribui)
  {
    priority: 20,
    agent: "taskCode",
    when: { type: "github", descriptionMatches: "(rota|route|controller|controlador|model|schema|repository|repositorio|migration|seeder|dto|endpoint|mock)" },
    route: { provider: "codex", model: "codexplan" }
  },
  // Refatoração / docs → Codex (distribui; deepseek so no catch-all)
  {
    priority: 25,
    agent: "taskCode",
    when: { type: "github", descriptionMatches: "(refactor|refatorar|doc|docs|readme|comentario|comment|typo|limpeza|cleanup|test|spec|teste)" },
    route: { provider: "codex", model: "codexplan" }
  },
  // Fallback github (backend complexo que não pegou nas regras acima) → Claude
  {
    priority: 30,
    agent: "taskCode",
    when: { type: "github" },
    route: { provider: "anthropic", model: "claude-opus-4-8" }
  },
  // Scratch subtasks (api / custom) → Codex (distribui)
  {
    priority: 40,
    agent: "taskCode",
    when: { type: "api" },
    route: { provider: "codex", model: "codexplan" }
  },
  {
    priority: 41,
    agent: "taskCode",
    when: { type: "custom" },
    route: { provider: "codex", model: "codexplan" }
  },
  // Planner → Codex (distribui)
  {
    priority: 50,
    agent: "taskPlanner",
    route: { provider: "codex", model: "codexplan" }
  },
  // Reviewer via Claude Sonnet — usa modelo DIFERENTE do code agent (Opus)
  // pra preservar diversidade de review (ver feedback_blind_self_review_same_model).
  {
    priority: 50,
    agent: "taskReviewer",
    route: { provider: "anthropic", model: "claude-sonnet-4-5" }
  },
  // Reporter → Codex (distribui)
  {
    priority: 50,
    agent: "taskReporter",
    route: { provider: "codex", model: "codexplan" }
  },
  // Catch-all final → DeepSeek (unico uso de deepseek)
  {
    priority: 99,
    agent: "any",
    route: { provider: "deepseek", model: "deepseek-v4-flash" }
  }
];
