import { getSettingsCollection } from "../../core/mongo.js";
import { config } from "../../core/config.js";
import { pingOpenClaude, deepPingOpenClaude } from "../integrations/openclaude.js";
import { DEFAULT_ROUTING_RULES } from "./defaults.js";
import type { SubTaskType } from "../types.js";
import type { AgentSlot, ProviderName, Route, RouteContext, RoutingRule } from "./types.js";

const isSubTaskType = (v: unknown): v is SubTaskType =>
  v === "trello" || v === "github" || v === "api" || v === "custom";

const SETTINGS_KEY = "routingRules";
const CACHE_TTL_MS = 30_000;

let cache: { rules: RoutingRule[]; expiresAt: number } | null = null;

const isProvider = (v: unknown): v is ProviderName =>
  v === "anthropic" || v === "codex" || v === "deepseek";

const sanitizeRule = (raw: unknown): RoutingRule | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const priority = Number(r.priority);
  if (!Number.isFinite(priority)) return null;
  const agent = r.agent;
  if (
    agent !== "taskCode" &&
    agent !== "taskPlanner" &&
    agent !== "taskReviewer" &&
    agent !== "taskReporter" &&
    agent !== "any"
  ) {
    return null;
  }
  const route = r.route as Record<string, unknown> | undefined;
  if (!route || !isProvider(route.provider) || typeof route.model !== "string" || !route.model) {
    return null;
  }
  const when = (r.when as Record<string, unknown> | undefined) ?? undefined;
  return {
    priority,
    agent: agent as RoutingRule["agent"],
    when: when
      ? {
          type: isSubTaskType(when.type) ? when.type : undefined,
          descriptionMatches: typeof when.descriptionMatches === "string" ? when.descriptionMatches : undefined,
          repoMatches: typeof when.repoMatches === "string" ? when.repoMatches : undefined
        }
      : undefined,
    route: { provider: route.provider, model: route.model }
  };
};

/** Read rules from Mongo (cached) or fall back to defaults. */
export const getRoutingRules = async (): Promise<RoutingRule[]> => {
  if (cache && cache.expiresAt > Date.now()) return cache.rules;
  try {
    const col = await getSettingsCollection();
    const doc = await col.findOne({ key: SETTINGS_KEY });
    if (doc && Array.isArray(doc.value)) {
      const cleaned = (doc.value as unknown[])
        .map(sanitizeRule)
        .filter((r): r is RoutingRule => r !== null);
      if (cleaned.length > 0) {
        cache = { rules: cleaned, expiresAt: Date.now() + CACHE_TTL_MS };
        return cleaned;
      }
    }
  } catch {
    // fall through to defaults on Mongo error
  }
  cache = { rules: DEFAULT_ROUTING_RULES, expiresAt: Date.now() + CACHE_TTL_MS };
  return DEFAULT_ROUTING_RULES;
};

export const saveRoutingRules = async (rules: RoutingRule[]): Promise<void> => {
  const col = await getSettingsCollection();
  await col.updateOne(
    { key: SETTINGS_KEY },
    { $set: { value: rules, updatedAt: new Date() } },
    { upsert: true }
  );
  cache = { rules, expiresAt: Date.now() + CACHE_TTL_MS };
};

export const clearRoutingRulesCache = (): void => {
  cache = null;
};

/**
 * Seed Mongo with DEFAULT_ROUTING_RULES if no document exists. Idempotent.
 * Call once at boot.
 */
export const ensureRoutingRulesSeeded = async (): Promise<void> => {
  try {
    const col = await getSettingsCollection();
    const doc = await col.findOne({ key: SETTINGS_KEY });
    if (!doc) {
      await col.insertOne({
        key: SETTINGS_KEY,
        value: DEFAULT_ROUTING_RULES,
        updatedAt: new Date()
      });
    }
  } catch (err) {
    console.warn("[routing] ensureRoutingRulesSeeded failed:", err);
  }
};

const matchesWhen = (rule: RoutingRule, ctx: RouteContext): boolean => {
  if (!rule.when) return true;
  if (rule.when.type && rule.when.type !== ctx.type) return false;
  if (rule.when.descriptionMatches) {
    try {
      const re = new RegExp(rule.when.descriptionMatches, "i");
      if (!re.test(ctx.description ?? "")) return false;
    } catch {
      // bad regex → rule never matches (safer than throwing)
      return false;
    }
  }
  if (rule.when.repoMatches) {
    try {
      const re = new RegExp(rule.when.repoMatches, "i");
      if (!re.test(ctx.repo ?? "")) return false;
    } catch {
      return false;
    }
  }
  return true;
};

const resolveGrpcUrl = (provider: ProviderName): string | undefined =>
  config.openclaude.providers?.[provider];

// ============== HEALTH CACHE ==============
// Cacheia o resultado do TCP ping pra cada grpcUrl por ~10s.
// Evita pingar a cada selectRoute (uma task pode disparar dezenas).
// Quando um provider volta a responder, a proxima janela de 10s ja
// detecta — sem precisar edit manual de rules.
const HEALTH_TTL_MS = 10_000;
const HEALTH_PING_TIMEOUT_MS = 1_000;
const healthCache = new Map<string, { status: "ok" | "down"; expiresAt: number }>();

// Deep health: detecta "porta aberta mas pipeline morto" (empty-stream
// in=0 out=0) que o pingOpenClaude (TCP) nao pega. Caro (1 LLM round-trip),
// entao roda em BACKGROUND e nunca bloqueia o hot path do selectRoute.
// Cache proprio: "ok" dura 60s, "down" dura 20s (re-checa recuperacao mais rapido).
const DEEP_HEALTH_TTL_OK_MS = 60_000;
const DEEP_HEALTH_TTL_DOWN_MS = 20_000;
const DEEP_PING_TIMEOUT_MS = 8_000;
const deepHealthCache = new Map<string, { status: "ok" | "down"; expiresAt: number }>();
const deepInFlight = new Set<string>();

const refreshDeepHealth = (grpcUrl: string): void => {
  if (deepInFlight.has(grpcUrl)) return;
  deepInFlight.add(grpcUrl);
  void deepPingOpenClaude(grpcUrl, DEEP_PING_TIMEOUT_MS)
    .then((status) => {
      const ttl = status === "ok" ? DEEP_HEALTH_TTL_OK_MS : DEEP_HEALTH_TTL_DOWN_MS;
      deepHealthCache.set(grpcUrl, { status, expiresAt: Date.now() + ttl });
    })
    .catch(() => {
      deepHealthCache.set(grpcUrl, { status: "down", expiresAt: Date.now() + DEEP_HEALTH_TTL_DOWN_MS });
    })
    .finally(() => deepInFlight.delete(grpcUrl));
};

const checkProviderHealth = async (grpcUrl: string): Promise<"ok" | "down"> => {
  const now = Date.now();
  const cached = healthCache.get(grpcUrl);
  let tcpStatus: "ok" | "down";
  if (cached && cached.expiresAt > now) {
    tcpStatus = cached.status;
  } else {
    tcpStatus = await pingOpenClaude(grpcUrl, HEALTH_PING_TIMEOUT_MS).catch(() => "down" as const);
    healthCache.set(grpcUrl, { status: tcpStatus, expiresAt: now + HEALTH_TTL_MS });
  }
  // Porta fechada (rebuild/crash) — TCP ja resolve, sem deep check.
  if (tcpStatus === "down") return "down";

  // TCP ok: consulta o deep cache pra pegar pipeline-morto-com-porta-aberta.
  const deep = deepHealthCache.get(grpcUrl);
  if (deep && deep.expiresAt > now) {
    return deep.status;
  }
  // Deep cache vencido/ausente: refresca em background e confia no TCP agora.
  refreshDeepHealth(grpcUrl);
  return "ok";
};

/** Permite invalidar o cache de health (uso: UI provider-health page). */
export const clearProviderHealthCache = (): void => {
  healthCache.clear();
  deepHealthCache.clear();
};

/**
 * Marca um provider como "down" no health-cache por `ttlMs`.
 * Uso: app-level failures (EMPTY_STREAM, zero-changes) onde o TCP ping passa
 * mas o provider esta efetivamente quebrado (ex: codex OAuth expirado).
 * O proximo selectRoute pula esse provider e tenta a proxima rule.
 * TTL default 60s — auto-recupera quando o provider voltar.
 */
export const markProviderDown = (grpcUrl: string | undefined, ttlMs = 60_000): void => {
  if (!grpcUrl) return;
  const expiresAt = Date.now() + ttlMs;
  healthCache.set(grpcUrl, { status: "down", expiresAt });
  deepHealthCache.set(grpcUrl, { status: "down", expiresAt });
};

/**
 * Pick the route for a given agent slot + subtask context.
 * Walks rules in priority order, picks first match (with agent === slot OR "any").
 *
 * Health gate: antes de aceitar uma rule, ping o grpcUrl do provider.
 * Se down, pula pra proxima rule e acumula o nome em skippedProviders.
 * Resolve cenarios como "Codex tokens expirados" sem precisar editar
 * rules manualmente — auto-recupera quando o provider volta.
 *
 * Always returns a Route — falls back to deepseek if nothing matches (shouldn't happen
 * given the priority-99 catch-all in defaults).
 */
/** Modelo default por provider, usado ao sintetizar rota via preferProvider quando nenhuma rule casa. */
const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderName, string> = {
  anthropic: "claude-opus-4-8",
  codex: "codexplan",
  deepseek: "deepseek-chat"
};

export const selectRoute = async (agent: AgentSlot, ctx: RouteContext = {}): Promise<Route> => {
  const rules = await getRoutingRules();
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  const skipped: string[] = [];

  // preferProvider: honra o provider pedido (ex: idle-nudge → claude) ANTES do match normal.
  // Se saudavel, usa uma rule desse provider (agent OU any); senao sintetiza rota c/ model default.
  // Se o provider estiver down, cai no fluxo de rules normal (nunca quebra).
  if (ctx.preferProvider) {
    const grpcUrl = resolveGrpcUrl(ctx.preferProvider);
    const healthy = grpcUrl ? (await checkProviderHealth(grpcUrl)) === "ok" : true;
    if (healthy) {
      const preferredRule = sorted.find(
        (r) => (r.agent === agent || r.agent === "any") && r.route.provider === ctx.preferProvider && matchesWhen(r, ctx)
      );
      const model = preferredRule?.route.model ?? DEFAULT_MODEL_BY_PROVIDER[ctx.preferProvider];
      return {
        provider: ctx.preferProvider,
        model,
        grpcUrl,
        reason: `preferProvider=${ctx.preferProvider}${preferredRule ? ` (rule p=${preferredRule.priority})` : " (synth)"}`
      };
    }
    skipped.push(`prefer:${ctx.preferProvider}(down)`);
  }

  for (const rule of sorted) {
    if (rule.agent !== agent && rule.agent !== "any") continue;
    if (!matchesWhen(rule, ctx)) continue;

    const grpcUrl = resolveGrpcUrl(rule.route.provider);
    // Skip health-check quando grpcUrl nao esta configurado — deixa
    // a chamada falhar no openclaude.ts com mensagem mais especifica.
    if (grpcUrl) {
      const health = await checkProviderHealth(grpcUrl);
      if (health === "down") {
        skipped.push(`${rule.route.provider}@p${rule.priority}`);
        continue;
      }
    }

    const skippedSuffix = skipped.length > 0 ? ` skipped=[${skipped.join(",")}]` : "";
    return {
      provider: rule.route.provider,
      model: rule.route.model,
      grpcUrl,
      reason: `rule p=${rule.priority} agent=${rule.agent}${rule.when ? " when=match" : ""}${skippedSuffix}`
    };
  }

  // Hard fallback — todas as rules ou nao bateram ou estao com provider down.
  // Tenta deepseek (catch-all) sem health-check pra garantir resposta.
  const skippedSuffix = skipped.length > 0 ? ` skipped=[${skipped.join(",")}]` : "";
  return {
    provider: "deepseek",
    model: "deepseek-chat",
    grpcUrl: resolveGrpcUrl("deepseek"),
    reason: `fallback (no healthy rule matched)${skippedSuffix}`
  };
};
