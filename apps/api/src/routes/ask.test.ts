import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAskSuccessResponse } from "./askResponse.js";
import type { AskSuccessResponse } from "@auraia/shared";

describe("normalizeAskSuccessResponse", () => {
  it("normaliza respostas legadas sem sql antes da serializacao", () => {
    const legacyData = {
      rows: [{ id: 1, qtd_ovos: 1200 }],
      columns: ["id", "qtd_ovos"],
      elapsedMs: 12,
      httpRequest: '{"method":"GET","path":"/clientes"}'
    } as unknown as AskSuccessResponse;

    assert.deepEqual(normalizeAskSuccessResponse(legacyData), {
      ...legacyData,
      sql: "",
      summary: "A consulta retornou 1 resultado.",
      // Hit de cache gravado antes da mascara existir nao tem `columnFormats`;
      // recalcular na serializacao e o que evita a tabela regredir por um TTL.
      //
      // `id` sai `text` de proposito: e identificador, e o backfill precisa
      // aplicar a mesma regra do caminho normal — senao a chave voltaria a
      // aparecer com separador de milhar so por ter batido no cache.
      columnFormats: {
        id: { kind: "text" },
        qtd_ovos: { kind: "integer", decimals: 0 }
      }
    });
  });

  it("nao sobrescreve columnFormats que o pipeline ja derivou", () => {
    // O caminho normal conhece o vocabulario do ambiente e a curadoria de seed;
    // esta funcao e sincrona e nao conhece nenhum dos dois. Recalcular por cima
    // seria trocar a resposta boa pela pior.
    const curated = { valor: { kind: "fraction", decimals: 3 } } as const;
    const data = {
      rows: [{ valor: 0.875 }],
      columns: ["valor"],
      elapsedMs: 3,
      summary: "ok",
      columnFormats: curated
    } as unknown as AskSuccessResponse;

    assert.deepEqual(normalizeAskSuccessResponse(data).columnFormats, curated);
  });

  it("backfill usa a primeira linha quando o nome nao diz nada", () => {
    const data = {
      rows: [{ zzz_sem_radical: 7.5 }],
      columns: ["zzz_sem_radical"],
      elapsedMs: 3,
      summary: "ok"
    } as unknown as AskSuccessResponse;

    assert.deepEqual(normalizeAskSuccessResponse(data).columnFormats, {
      zzz_sem_radical: { kind: "decimal", decimals: 2 }
    });
  });

  it("preserva tokenUsage sem sql quando a etapa SQL nao foi executada", () => {
    const apiData = {
      rows: [],
      columns: [],
      elapsedMs: 8,
      tokenUsage: {
        summary: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        total: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
      }
    } as unknown as AskSuccessResponse;

    const normalized = normalizeAskSuccessResponse(apiData);
    assert.deepEqual(normalized.tokenUsage, apiData.tokenUsage);
    assert.equal(normalized.summary, "Nenhum resultado foi encontrado para esta pergunta.");
  });

  it("usa fallback para summary invalido", () => {
    const data = {
      rows: [],
      columns: [],
      elapsedMs: 8,
      summary: 42
    } as unknown as AskSuccessResponse;

    assert.equal(
      normalizeAskSuccessResponse(data).summary,
      "Nenhum resultado foi encontrado para esta pergunta."
    );
  });
});

const base = (over: Partial<AskSuccessResponse> = {}): AskSuccessResponse =>
  ({
    rows: [],
    columns: [],
    elapsedMs: 0,
    sql: "SELECT 1",
    summary: "",
    ...over
  }) as AskSuccessResponse;

/**
 * "A consulta retornou 13 resultados." was the message the user actually saw
 * instead of a real analysis. It is the last-resort fallback in this module,
 * so these tests pin down when it may appear and in which language.
 */
describe("normalizeAskSuccessResponse — fallback de summary", () => {
  it("preserva o summary real do modelo", () => {
    const out = normalizeAskSuccessResponse(
      base({ rows: [{ a: 1 }], summary: "  Em 2024 o faturamento somou R$ 8,29 milhoes.  " })
    );
    assert.equal(out.summary, "Em 2024 o faturamento somou R$ 8,29 milhoes.");
  });

  it("so cai no fallback quando o summary vem vazio", () => {
    const out = normalizeAskSuccessResponse(base({ rows: [{ a: 1 }, { a: 2 }], summary: "   " }));
    assert.equal(out.summary, "A consulta retornou 2 resultados.");
  });

  it("usa singular com uma unica linha", () => {
    const out = normalizeAskSuccessResponse(base({ rows: [{ a: 1 }] }));
    assert.equal(out.summary, "A consulta retornou 1 resultado.");
  });

  // O fallback era fixo em portugues, entao um usuario em ingles recebia uma
  // resposta em portugues sempre que o summary falhava.
  it("respeita responseLanguage=en", () => {
    const out = normalizeAskSuccessResponse(
      base({ rows: [{ a: 1 }, { a: 2 }], responseLanguage: "en" })
    );
    assert.equal(out.summary, "The query returned 2 results.");
  });

  it("respeita responseLanguage=es", () => {
    const out = normalizeAskSuccessResponse(base({ rows: [{ a: 1 }], responseLanguage: "es" }));
    assert.equal(out.summary, "La consulta devolvio 1 resultado.");
  });

  it("mantem o portugues como padrao quando nao ha idioma", () => {
    const out = normalizeAskSuccessResponse(base({ rows: [{ a: 1 }, { a: 2 }] }));
    assert.equal(out.summary, "A consulta retornou 2 resultados.");
  });

  it("normaliza campos ausentes sem quebrar", () => {
    const out = normalizeAskSuccessResponse({} as unknown as AskSuccessResponse);
    assert.deepEqual(out.rows, []);
    assert.deepEqual(out.columns, []);
    assert.equal(out.sql, "");
    assert.equal(out.elapsedMs, 0);
    assert.equal(out.summary, "Nenhum resultado foi encontrado para esta pergunta.");
  });
});
