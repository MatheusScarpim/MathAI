import type { SubTaskType } from "../types.js";

export type ProviderName = "anthropic" | "codex" | "deepseek";

export type AgentSlot = "taskCode" | "taskPlanner" | "taskReviewer" | "taskReporter";

/** Conditions a rule can filter on. Empty `when` (or `agent: "any"`) = match anything for that agent. */
export type RoutingMatchClause = {
  type?: SubTaskType;
  /** ECMAScript regex source (compiled with `new RegExp(..., "i")`). Matched against subtask description. */
  descriptionMatches?: string;
  /** Regex against `owner/repo` string. */
  repoMatches?: string;
};

export type RoutingRule = {
  /** Lower number = evaluated first. Stable ordering across ties via array index. */
  priority: number;
  /** Which agent this rule applies to. "any" = matches any agent. */
  agent: AgentSlot | "any";
  when?: RoutingMatchClause;
  route: {
    provider: ProviderName;
    model: string;
  };
};

export type RouteContext = {
  type?: SubTaskType;
  description?: string;
  repo?: string;
  /** When set, prefer routing to this provider (if healthy) over the normal rule match. Used for idle-nudge execution (claude). */
  preferProvider?: ProviderName;
};

export type Route = {
  provider: ProviderName;
  model: string;
  /** gRPC endpoint resolved from `config.openclaude.providers[provider]`. Only present for OpenClaude-routed agents. */
  grpcUrl?: string;
  /** Human-readable reason — which rule matched, for audit/UI. */
  reason: string;
};
