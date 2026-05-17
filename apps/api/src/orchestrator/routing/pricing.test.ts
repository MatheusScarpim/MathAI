/**
 * Testes unitarios — G10 plan W3.
 *
 * Roda com `node --test --import tsx src/orchestrator/routing/pricing.test.ts`.
 * Sem framework externo — node:test built-in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCost, PRICE_PER_MILLION } from "./pricing.js";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

test("computeCost: provider/model conhecidos calcula input+output", () => {
  // claude-opus-4-7: input=15, output=75 USD/M tokens
  // 1000 input + 500 output = 1000*15/1e6 + 500*75/1e6 = 0.015 + 0.0375 = 0.0525
  const cost = computeCost("anthropic", "claude-opus-4-7", {
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500
  });
  assert.equal(Number(cost.toFixed(6)), 0.0525);
});

test("computeCost: deepseek-chat usa preco baixo correto", () => {
  // deepseek-chat: input=0.27, output=1.10
  const cost = computeCost("deepseek", "deepseek-chat", {
    inputTokens: 10_000,
    outputTokens: 5_000,
    totalTokens: 15_000
  });
  // 10000*0.27/1e6 + 5000*1.10/1e6 = 0.0027 + 0.0055 = 0.0082
  assert.equal(Number(cost.toFixed(6)), 0.0082);
});

test("computeCost: provider desconhecido retorna 0 (silent fallback)", () => {
  const cost = computeCost("unknown-provider", "some-model", { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });
  assert.equal(cost, 0);
});

test("computeCost: model desconhecido em provider conhecido retorna 0", () => {
  const cost = computeCost("anthropic", "claude-vaporware", { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });
  assert.equal(cost, 0);
});

test("computeCost: undefined provider/model retorna 0", () => {
  assert.equal(computeCost(undefined, "any", ZERO_USAGE), 0);
  assert.equal(computeCost("anthropic", undefined, ZERO_USAGE), 0);
});

test("computeCost: usage zerado retorna 0", () => {
  const cost = computeCost("anthropic", "claude-opus-4-7", ZERO_USAGE);
  assert.equal(cost, 0);
});

test("PRICE_PER_MILLION: providers basicos presentes", () => {
  assert.ok(PRICE_PER_MILLION.anthropic, "anthropic prices set");
  assert.ok(PRICE_PER_MILLION.deepseek, "deepseek prices set");
  assert.ok(PRICE_PER_MILLION.codex, "codex prices set");
  // Sanity: output deve ser >= input pra modelos LLM tipicos
  assert.ok(
    PRICE_PER_MILLION.anthropic["claude-opus-4-7"]!.output >=
      PRICE_PER_MILLION.anthropic["claude-opus-4-7"]!.input,
    "output >= input for opus"
  );
});
