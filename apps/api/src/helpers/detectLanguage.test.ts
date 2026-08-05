import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLanguage, WORD_LISTS } from "./detectLanguage.js";

const expectConfident = (text: string, language: "pt" | "en" | "es"): void => {
  const result = detectLanguage(text);
  assert.equal(
    result.language,
    language,
    `"${text}" -> ${result.language} (scores ${JSON.stringify(result.scores)})`
  );
  assert.equal(
    result.confident,
    true,
    `"${text}" should be confident (scores ${JSON.stringify(result.scores)})`
  );
};

test("detects Portuguese questions", () => {
  expectConfident("quantas vendas tivemos em 2024?", "pt");
  expectConfident("qual o faturamento por mes?", "pt");
  expectConfident("mostre os produtos com maior receita", "pt");
  expectConfident("quanto cresceu a receita comparado ao trimestre anterior?", "pt");
});

test("detects English questions", () => {
  expectConfident("how many sales did we have in 2024?", "en");
  expectConfident("what is the revenue by month?", "en");
  expectConfident("show the top products by total amount", "en");
  expectConfident("which customers grew the most between 2023 and 2024?", "en");
});

test("detects Spanish questions", () => {
  expectConfident("cuantas ventas tuvimos en 2024?", "es");
  expectConfident("cual es la facturacion por mes?", "es");
  expectConfident("muestra los productos con mayor ingresos", "es");
});

test("inverted punctuation is a strong Spanish signal", () => {
  const result = detectLanguage("\u00bfcuantas ventas?");
  assert.equal(result.language, "es");
  assert.equal(result.confident, true);
});

test("Portuguese-only orthography is a strong Portuguese signal", () => {
  // "nao" carries no accent here; the a-tilde in "operacao" is doing the work.
  const result = detectLanguage("qual a situacao das opera\u00e7\u00f5es?");
  assert.equal(result.language, "pt");
  assert.equal(result.confident, true);
});

test("accented and unaccented spellings score the same", () => {
  const accented = detectLanguage("quantas vendas em 2024, m\u00e9dia por m\u00eas?");
  const plain = detectLanguage("quantas vendas em 2024, media por mes?");
  assert.equal(accented.language, "pt");
  assert.equal(plain.language, "pt");
  assert.equal(accented.scores.pt, plain.scores.pt);
});

test("English text with a Portuguese proper noun is not confidently Portuguese", () => {
  // Regression guard: a +3 orthography bonus used to win here and mislabel the
  // question as Portuguese on the strength of a city name alone.
  const result = detectLanguage("sales for S\u00e3o Paulo");
  assert.equal(result.confident, false);
});

test("ambiguous or too-short text returns no language", () => {
  for (const text of ["", "   ", "2024", "total", "x", "42 / 7"]) {
    const result = detectLanguage(text);
    assert.equal(result.language, null, `"${text}" should be undetectable`);
    assert.equal(result.confident, false);
    assert.equal(result.confidence, 0);
  }
});

test("the three word lists are disjoint", () => {
  // Structural guard. The behavioural test below only catches a shared word if
  // that exact word happens to be in the sample sentence; this catches every
  // one of them. `comparado`, `menor`, `pedidos`, `semana`, `trimestre`, `cada`
  // and `usuarios` were all in both the pt and es lists at once.
  const pairs = [["pt", "es"], ["pt", "en"], ["en", "es"]] as const;

  for (const [a, b] of pairs) {
    const shared = [...WORD_LISTS[a]].filter((word) => WORD_LISTS[b].has(word));
    assert.deepEqual(shared, [], `${a} e ${b} compartilham: ${shared.join(", ")}`);
  }
});

test("shared vocabulary alone does not decide a language", () => {
  // Every token here exists in more than one of the three languages, so none of
  // them is in the word lists. If this starts returning a language, a shared
  // term leaked into a list.
  const result = detectLanguage("total para clientes por mes");
  assert.equal(result.language, null);
});

test("confidence is a 0..1 margin", () => {
  const result = detectLanguage("how many sales did we have in 2024?");
  assert.ok(result.confidence > 0 && result.confidence <= 1, String(result.confidence));
  assert.equal(result.scores.pt, 0);
  assert.equal(result.scores.es, 0);
});

test("does not mistake Portuguese for Spanish on near-identical words", () => {
  // "vendas"/"ventas" and "em"/"en" are the discriminators.
  assert.equal(detectLanguage("quantas vendas em janeiro").language, "pt");
  assert.equal(detectLanguage("cuantas ventas del mes").language, "es");
});
