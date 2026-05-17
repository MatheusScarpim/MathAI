/**
 * Pricing constants for LLM providers (USD per million tokens).
 *
 * Used to compute per-call `costUsd` for telemetry. Numbers reflect public list
 * prices as of 2026-05-15 — revise periodically (memory feedback: pricing
 * accuracy risk noted in plan W1 #3).
 *
 * Unknown (provider, model) pairs return 0 from `computeCost` (silent fallback)
 * so telemetry never throws — useful for new/experimental models not yet listed.
 */

import type { ProviderName, Route } from "./types.js";
import type { TokenUsage } from "../types.js";

/** Price table: USD per 1_000_000 tokens, broken into input/output rates. */
export const PRICE_PER_MILLION: Record<ProviderName, Record<string, { input: number; output: number }>> = {
  anthropic: {
    // Claude Opus 4.7 public list rate
    "claude-opus-4-7": { input: 15, output: 75 },
    "claude-opus-4": { input: 15, output: 75 },
    "claude-sonnet-4-5": { input: 3, output: 15 }
  },
  deepseek: {
    "deepseek-chat": { input: 0.27, output: 1.10 },
    "deepseek-reasoner": { input: 0.55, output: 2.19 }
  },
  codex: {
    // Codex pricing varies w/ plan; approx GPT-4o-class rates for telemetry
    "codexplan": { input: 5, output: 15 },
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.60 }
  }
};

const warnedUnknown = new Set<string>();

/**
 * Compute USD cost for an (provider, model, usage) tuple.
 * Returns 0 when the pair is unknown — logs warn once per unique pair so the
 * gap is visible in logs without spamming every subtask call.
 */
export const computeCost = (
  provider: ProviderName | string | undefined,
  model: string | undefined,
  usage: TokenUsage
): number => {
  if (!provider || !model) return 0;
  const providerTable = (PRICE_PER_MILLION as Record<string, Record<string, { input: number; output: number }>>)[provider];
  if (!providerTable) {
    const key = `${provider}:*`;
    if (!warnedUnknown.has(key)) {
      warnedUnknown.add(key);
      console.warn(`[pricing] unknown provider "${provider}" — cost=0 for now`);
    }
    return 0;
  }
  const rate = providerTable[model];
  if (!rate) {
    const key = `${provider}:${model}`;
    if (!warnedUnknown.has(key)) {
      warnedUnknown.add(key);
      console.warn(`[pricing] unknown model "${model}" for provider "${provider}" — cost=0`);
    }
    return 0;
  }
  const inCost = (usage.inputTokens / 1_000_000) * rate.input;
  const outCost = (usage.outputTokens / 1_000_000) * rate.output;
  return inCost + outCost;
};

/** Convenience: derive cost from a resolved Route + token usage. */
export const priceForRoute = (route: Route | undefined, usage: TokenUsage): number => {
  if (!route) return 0;
  return computeCost(route.provider, route.model, usage);
};
