import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { noDecomposition, parsePlannerResponse } from "./plannerResponse.js";

const twoSubQuestions = [
  { id: "sq1", question: "faturamento de 2023", focus: "ano" },
  { id: "sq2", question: "faturamento de 2024", focus: "ano" }
];

/**
 * Regression suite for the "dead planner": every degradation path used to
 * return the same silent `needsDecomposition: false`, so a malformed response
 * was indistinguishable from a planner that correctly declined to decompose.
 */
describe("parsePlannerResponse — decompoe", () => {
  it("aceita duas subperguntas com estrategia declarada", () => {
    const parsed = parsePlannerResponse(
      JSON.stringify({
        needsDecomposition: true,
        subQuestions: twoSubQuestions,
        combinationStrategy: "join",
        combinationHint: "junte por ano"
      })
    );

    assert.deepEqual(parsed, {
      decompose: true,
      subQuestions: twoSubQuestions,
      strategy: "join",
      hint: "junte por ano"
    });
  });

  it("trata 'single' como estrategia nao definida e cai para cte", () => {
    const parsed = parsePlannerResponse(
      JSON.stringify({
        needsDecomposition: true,
        subQuestions: twoSubQuestions,
        combinationStrategy: "single"
      })
    );

    assert.equal(parsed.decompose && parsed.strategy, "cte");
  });

  it("cai para cte quando a estrategia e desconhecida", () => {
    const parsed = parsePlannerResponse(
      JSON.stringify({
        needsDecomposition: true,
        subQuestions: twoSubQuestions,
        combinationStrategy: "pivot"
      })
    );

    assert.equal(parsed.decompose && parsed.strategy, "cte");
  });

  it("preenche id ausente e focus ausente", () => {
    const parsed = parsePlannerResponse(
      JSON.stringify({
        needsDecomposition: true,
        subQuestions: [{ question: "faturamento de 2023" }, { question: "faturamento de 2024" }]
      })
    );

    assert.deepEqual(parsed.decompose && parsed.subQuestions, [
      { id: "sq1", question: "faturamento de 2023", focus: "" },
      { id: "sq2", question: "faturamento de 2024", focus: "" }
    ]);
  });

  it("corta acima de quatro subperguntas", () => {
    const parsed = parsePlannerResponse(
      JSON.stringify({
        needsDecomposition: true,
        subQuestions: Array.from({ length: 7 }, (_, index) => ({
          id: `sq${index + 1}`,
          question: `pergunta ${index + 1}`,
          focus: ""
        }))
      })
    );

    assert.equal(parsed.decompose && parsed.subQuestions.length, 4);
  });

  it("hint ausente vira string vazia, nao undefined", () => {
    const parsed = parsePlannerResponse(
      JSON.stringify({ needsDecomposition: true, subQuestions: twoSubQuestions })
    );

    assert.equal(parsed.decompose && parsed.hint, "");
  });
});

describe("parsePlannerResponse — nao decompoe, com motivo", () => {
  it("json invalido diz que e json invalido", () => {
    const parsed = parsePlannerResponse("{ nao sou json");
    assert.equal(parsed.decompose, false);
    assert.match(!parsed.decompose ? parsed.reason : "", /json invalido/);
  });

  it("resposta vazia do modelo", () => {
    const parsed = parsePlannerResponse("{}");
    assert.equal(parsed.decompose, false);
    assert.match(!parsed.decompose ? parsed.reason : "", /needsDecomposition=false/);
  });

  it("array no topo nao e objeto json", () => {
    const parsed = parsePlannerResponse("[]");
    assert.equal(parsed.decompose, false);
    assert.match(!parsed.decompose ? parsed.reason : "", /nao e um objeto json/);
  });

  it("null no topo nao e objeto json", () => {
    const parsed = parsePlannerResponse("null");
    assert.equal(parsed.decompose, false);
    assert.match(!parsed.decompose ? parsed.reason : "", /nao e um objeto json/);
  });

  it("recusa explicita do planner e distinguivel de defeito", () => {
    const parsed = parsePlannerResponse(JSON.stringify({ needsDecomposition: false }));
    assert.equal(!parsed.decompose && parsed.reason.startsWith("planner respondeu"), true);
  });

  it("uma subpergunta nao e decomposicao, e a pergunta original", () => {
    const parsed = parsePlannerResponse(
      JSON.stringify({ needsDecomposition: true, subQuestions: [twoSubQuestions[0]] })
    );
    assert.equal(parsed.decompose, false);
    assert.match(!parsed.decompose ? parsed.reason : "", /1 subpergunta\(s\) validas de 1/);
  });

  it("reporta quantas subperguntas vieram e quantas sobreviveram", () => {
    const parsed = parsePlannerResponse(
      JSON.stringify({
        needsDecomposition: true,
        subQuestions: [{ question: "vale" }, { focus: "sem pergunta" }, { question: "   " }]
      })
    );
    assert.equal(parsed.decompose, false);
    assert.match(!parsed.decompose ? parsed.reason : "", /1 subpergunta\(s\) validas de 3/);
  });

  it("needsDecomposition como string nao conta como true", () => {
    const parsed = parsePlannerResponse(
      JSON.stringify({ needsDecomposition: "true", subQuestions: twoSubQuestions })
    );
    assert.equal(parsed.decompose, false);
  });
});

describe("noDecomposition", () => {
  it("preserva a pergunta original e o usage", () => {
    assert.deepEqual(noDecomposition("faturamento total", { total_tokens: 42 }), {
      needsDecomposition: false,
      subQuestions: [],
      combinationStrategy: "single",
      combinationHint: "",
      originalQuestion: "faturamento total",
      usage: { total_tokens: 42 }
    });
  });

  it("usage e opcional", () => {
    assert.equal(noDecomposition("faturamento total").usage, undefined);
  });
});
