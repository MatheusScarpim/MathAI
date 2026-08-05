/**
 * O catalogo de metricas (E5) so vale se CHEGAR no prompt.
 *
 * `metrics.test.ts` prova que o catalogo esta correto; este arquivo prova que
 * ele e consumido. A distincao importa porque o modo de falha do E1/E2 foi
 * exatamente esse: conhecimento validado, guardado e nunca dito ao modelo.
 * Um teste de unidade de `renderMetricsSection` passaria com o bloco
 * desconectado do `buildPrompt`.
 */

import "../core/testEnv.fixture.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TableChunk } from "@auraia/shared";
import { buildPrompt } from "./sql.js";
import type { ExpandedContext } from "./schema.js";
import { REAL_SCHEMA } from "../schema/realSchema.fixture.js";
import { loadBundledSeed } from "../schema/seedFile.js";

const seed = loadBundledSeed("avicultura");
const metrics = seed.metrics;

const ECLOSAO_TABLE = "ubi.cifsResumoEclosaoMortalidade";

/**
 * O contexto que o E4 entregaria: tabelas reais, direto da fixture.
 *
 * A fixture guarda so `tableFullName` e `columns` — e de proposito, ela existe
 * para checar nome de coluna. `buildPrompt` le tambem PK/FK/tags, entao aqui
 * as tres viram lista vazia. Vazio e o caso honesto: sem PK nem tag o prompt
 * imprime apenas a lista de colunas, que e exatamente o que estes testes
 * inspecionam.
 */
const asChunk = (t: (typeof REAL_SCHEMA)[number]): TableChunk =>
  ({ ...t, primaryKey: [], foreignKeys: [], tags: [] }) as unknown as TableChunk;

const contextWith = (...tableNames: string[]): ExpandedContext => {
  const tables = tableNames.map((name) => {
    const found = REAL_SCHEMA.find((t) => t.tableFullName === name);
    assert.ok(found, `fixture nao tem ${name} — o teste perdeu a ancora`);
    return asChunk(found);
  });
  return { tables, joins: [] };
};

/** Mesma ordem de argumentos do `ask.ts`, com o catalogo no fim. */
const prompt = (
  question: string,
  context: ExpandedContext,
  catalog = metrics
): string =>
  buildPrompt(
    question,
    context,
    null,
    [],
    null,
    null,
    "pt",
    null,
    undefined,
    null,
    null,
    catalog
  );

describe("E5 chega no prompt de verdade", () => {
  it("a fixture tem a tabela da eclosao (senao o resto nao prova nada)", () => {
    assert.ok(REAL_SCHEMA.some((t) => t.tableFullName === ECLOSAO_TABLE));
    assert.ok(metrics.length >= 30, `catalogo com so ${metrics.length} metricas`);
  });

  it("pergunta que cita a metrica traz a formula para dentro do prompt", () => {
    const out = prompt("qual a eclosao do lote 12?", contextWith(ECLOSAO_TABLE));
    assert.ok(
      out.includes("SUM(qtd_pintos_nascidos) / NULLIF(SUM(qtd_ovos_incubados), 0)"),
      "a formula da eclosao nao chegou no prompt"
    );
    assert.ok(out.includes("Metricas canonicas"), "o cabecalho da secao sumiu");
  });

  it("a meta entra marcada como meta, nunca como realizado", () => {
    const out = prompt("eclosao por granja", contextWith(ECLOSAO_TABLE));
    assert.ok(out.includes("eclosao_padrao"));
    assert.ok(out.includes("nunca o realizado"));
  });

  it("pergunta sem metrica nenhuma nao adiciona a secao", () => {
    const out = prompt("quantas linhas tem a tabela?", contextWith(ECLOSAO_TABLE));
    assert.ok(!out.includes("Metricas canonicas"));
  });

  it("catalogo vazio (ambiente sem seed) degrada para o prompt de antes", () => {
    const context = contextWith(ECLOSAO_TABLE);
    assert.ok(!prompt("qual a eclosao?", context, []).includes("Metricas canonicas"));
  });

  it("sem o argumento de metricas o prompt continua o de antes", () => {
    const context = contextWith(ECLOSAO_TABLE);
    const semCatalogo = buildPrompt("qual a eclosao?", context, null, [], null, null, "pt");
    assert.ok(!semCatalogo.includes("Metricas canonicas"));
  });
});

describe("a poda do E4 e o catalogo do E5 nao se contradizem", () => {
  it("metrica cuja tabela foi podada nao e citada", () => {
    // A pergunta casa a eclosao, mas o contexto entregue nao tem a tabela
    // dela. Citar a formula aqui mandaria somar coluna invisivel.
    const outra = REAL_SCHEMA.find((t) => t.tableFullName !== ECLOSAO_TABLE);
    assert.ok(outra);
    const out = prompt("qual a eclosao?", contextWith(outra.tableFullName));
    assert.ok(!out.includes("Metricas canonicas"), "citou metrica de tabela podada");
  });

  it("metrica com coluna podada some inteira, em vez de citar coluna invisivel", () => {
    const full = REAL_SCHEMA.find((t) => t.tableFullName === ECLOSAO_TABLE);
    assert.ok(full);
    const podada = asChunk({
      ...full,
      columns: full.columns.filter((c) => c.name.toLowerCase() !== "qtd_ovos_incubados")
    });
    const out = prompt("qual a eclosao?", { tables: [podada], joins: [] });
    // Nao da para procurar o nome da coluna solto no prompt: a mesma tabela
    // tem `qtd_ovos_incubados_mort`, que CONTEM o nome podado. A invariante e
    // a secao inteira sumir — sem denominador nao ha formula honesta.
    assert.ok(!out.includes("Metricas canonicas"), "citou metrica com coluna podada");
    assert.ok(!out.includes("NULLIF(SUM(qtd_ovos_incubados)"), "vazou a formula");
  });

  it("toda coluna citada na secao aparece no schema impresso do mesmo prompt", () => {
    // A invariante que realmente importa, checada por varredura: se a secao
    // fala de uma coluna, o modelo precisa ter acabado de le-la na lista.
    for (const m of metrics) {
      const context = contextWith(m.table);
      const out = prompt(m.id.replace(/_/g, " "), context);
      if (!out.includes("Metricas canonicas")) continue;
      const schemaPart = out.slice(0, out.indexOf("Metricas canonicas"));
      for (const c of [m.numerator, m.denominator, m.column].filter(Boolean)) {
        assert.ok(
          schemaPart.includes(c as string),
          `${m.id}: a secao cita ${c}, que nao esta no schema impresso`
        );
      }
    }
  });
});
