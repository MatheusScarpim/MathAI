import type { RoutingRule } from "./types.js";

/**
 * Seed rules persisted on first boot. Editable via /api/settings/routing-rules.
 * Order matters only as a tiebreaker — `priority` is authoritative.
 */
export const DEFAULT_ROUTING_RULES: RoutingRule[] = [
  // Frontend complexo (dashboard, layout, chart, etc.) → Claude Opus 4.7
  {
    priority: 5,
    agent: "taskCode",
    when: { type: "github", descriptionMatches: "(dashboard|grafico|chart|layout|page|componente.complexo|design.system)" },
    route: { provider: "anthropic", model: "claude-opus-4-7" }
  },
  // Backend complexo (pipeline, orchestrator, core, etc.) → Claude Opus 4.7
  {
    priority: 10,
    agent: "taskCode",
    when: { type: "github", descriptionMatches: "(pipeline|orquestrador|core|cache|fila|queue|middleware|estrategia|strategy|event.stream|service.layer|workflow|motor|processor)" },
    route: { provider: "anthropic", model: "claude-opus-4-7" }
  },
  // Frontend simples (.vue, .tsx, etc.) → Codex (ChatGPT OAuth)
  {
    priority: 15,
    agent: "taskCode",
    when: { type: "github", descriptionMatches: "(vue|tsx|jsx|svelte|html|css)" },
    route: { provider: "codex", model: "codexplan" }
  },
  // Backend simples (rotas, controllers, models, etc.) → Codex
  {
    priority: 20,
    agent: "taskCode",
    when: { type: "github", descriptionMatches: "(rota|route|controller|controlador|model|schema|repository|repositorio|migration|seeder|dto|endpoint|mock)" },
    route: { provider: "codex", model: "codexplan" }
  },
  // Refatoração / docs → DeepSeek (barato)
  {
    priority: 25,
    agent: "taskCode",
    when: { type: "github", descriptionMatches: "(refactor|refatorar|doc|docs|readme|comentario|comment|typo|limpeza|cleanup|test|spec|teste)" },
    route: { provider: "deepseek", model: "deepseek-chat" }
  },
  // Fallback github (backend complexo que não pegou nas regras acima) → Claude
  {
    priority: 30,
    agent: "taskCode",
    when: { type: "github" },
    route: { provider: "anthropic", model: "claude-opus-4-7" }
  },
  // Scratch subtasks (api / custom) → DeepSeek
  {
    priority: 40,
    agent: "taskCode",
    when: { type: "api" },
    route: { provider: "deepseek", model: "deepseek-chat" }
  },
  {
    priority: 41,
    agent: "taskCode",
    when: { type: "custom" },
    route: { provider: "deepseek", model: "deepseek-chat" }
  },
  // Non-code agents → DeepSeek (precisa de API key pra outros provedores)
  {
    priority: 50,
    agent: "taskPlanner",
    route: { provider: "deepseek", model: "deepseek-chat" }
  },
  {
    priority: 50,
    agent: "taskReviewer",
    route: { provider: "deepseek", model: "deepseek-chat" }
  },
  {
    priority: 50,
    agent: "taskReporter",
    route: { provider: "deepseek", model: "deepseek-chat" }
  },
  // Catch-all final
  {
    priority: 99,
    agent: "any",
    route: { provider: "deepseek", model: "deepseek-chat" }
  }
];
