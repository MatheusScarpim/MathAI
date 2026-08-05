import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadBundledSeed } from "./seedFile.js";
import { parseSeed, SeedError } from "./seed.js";
import { REAL_SCHEMA } from "./realSchema.fixture.js";
import {
  findMetrics,
  metricColumns,
  metricSql,
  renderMetricsSection,
  type MetricDefinition
} from "./metrics.js";

const seed = loadBundledSeed("avicultura");
const metrics = seed.metrics;

/** Colunas reais por tabela, em minusculas — o banco nao distingue caixa. */
const REAL: Map<string, Set<string>> = new Map(
  REAL_SCHEMA.map((t) => [
    t.tableFullName.toLowerCase(),
    new Set(t.columns.map((c) => c.name.toLowerCase()))
  ])
);

const base = (): MetricDefinition => ({
  id: "m",
  label: "M",
  synonyms: [],
  kind: "ratio",
  table: "t",
  numerator: "a",
  denominator: "b",
  unit: "fraction",
  provenance: "schema",
  pitfalls: []
});

const parseWith = (m: unknown) =>
  parseSeed({ name: "x", vocabulary: {}, tableFacts: {}, metrics: [m] });

describe("catalogo de metricas: toda coluna citada existe no schema real", () => {
  it("o catalogo nao esta vazio (senao os testes abaixo passam em silencio)", () => {
    assert.ok(metrics.length >= 30, `so ${metrics.length} metricas`);
  });

  it("a fixture foi lida (senao a checagem de coluna nao checa nada)", () => {
    assert.ok(REAL.size >= 14, `so ${REAL.size} tabelas na fixture`);
  });

  for (const m of metrics) {
    it(`${m.id}: tabela e colunas existem`, () => {
      const cols = REAL.get(m.table.toLowerCase());
      assert.ok(cols, `tabela "${m.table}" nao existe no schema real`);
      for (const c of metricColumns(m)) {
        assert.ok(
          cols.has(c.toLowerCase()),
          `${m.id}: coluna "${c}" nao existe em ${m.table}`
        );
      }
    });
  }
});

describe("a forma da metrica manda no SQL, e o SQL respeita as guardas do E3", () => {
  it("ratio sempre vira SUM/NULLIF(SUM) — nunca AVG de coluna pronta", () => {
    for (const m of metrics.filter((x) => x.kind === "ratio")) {
      const sql = metricSql(m);
      assert.equal(sql, `SUM(${m.numerator}) / NULLIF(SUM(${m.denominator}), 0)`);
      // O erro que o E3 barra: a coluna pre-calculada dentro de um AVG.
      if (m.precomputed) assert.ok(!sql?.includes(m.precomputed));
    }
  });

  it("acumulada vira MAX, nunca SUM", () => {
    const acc = metrics.filter((x) => x.kind === "cumulative");
    assert.ok(acc.length > 0, "nenhuma metrica acumulada no catalogo");
    for (const m of acc) {
      assert.equal(metricSql(m), `MAX(${m.column})`);
    }
  });

  it("saldo e taxa-sem-par nao ganham expressao inventada", () => {
    for (const m of metrics.filter((x) => x.kind === "snapshot" || x.kind === "rate_only")) {
      assert.equal(metricSql(m), null, `${m.id} ganhou SQL que ninguem pode garantir`);
    }
  });
});

describe("o catalogo nao ensina o que a guarda depois barra", () => {
  it("nenhuma faixa que contem outra aparece sem o aviso de dupla contagem", () => {
    const buckets = Object.keys(seed.vocabulary.overlappingBuckets ?? {});
    assert.ok(buckets.length > 0, "o seed perdeu overlappingBuckets");
    for (const parent of buckets) {
      const affected = metrics.filter((m) =>
        metricColumns(m).some((c) => c.toLowerCase().includes(parent))
      );
      assert.ok(affected.length > 0, `nenhuma metrica cita a faixa ${parent}`);
      for (const m of affected) {
        assert.ok(
          m.pitfalls.some((p) => p.includes("JA CONTEM")),
          `${m.id} usa a faixa ${parent} e nao avisa que ela contem outras`
        );
      }
    }
  });

  it("nenhuma metrica aponta para uma coluna de meta como se fosse o realizado", () => {
    const targetTerms = ["padrao", "meta", "_pad"];
    for (const m of metrics) {
      const measured = [m.numerator, m.denominator, m.column, m.precomputed].filter(
        (c): c is string => typeof c === "string"
      );
      for (const c of measured) {
        assert.ok(
          !targetTerms.some((t) => c.toLowerCase().includes(t)),
          `${m.id}: "${c}" parece meta, nao realizado`
        );
      }
    }
  });

  it("toda metrica inferida declara o que falta confirmar", () => {
    for (const m of metrics.filter((x) => x.provenance === "inferred")) {
      assert.ok(m.pitfalls.length > 0, `${m.id} e inferida e nao diz o que falta`);
    }
  });
});

describe("findMetrics so casa quando a pergunta pede mesmo", () => {
  it("acha pelo id e por sinonimo", () => {
    assert.deepEqual(
      findMetrics("qual a eclosao do lote 12?", metrics).map((m) => m.id).includes("eclosao"),
      true
    );
    assert.ok(
      findMetrics("me mostra a eclodibilidade por granja", metrics).some((m) => m.id === "eclosao")
    );
  });

  it("ignora acento e caixa", () => {
    assert.ok(findMetrics("ECLOSÃO média", metrics).some((m) => m.id === "eclosao"));
  });

  it("sinonimo composto exige todos os tokens", () => {
    const m: MetricDefinition = { ...base(), id: "x", synonyms: ["ovo ave"] };
    assert.equal(findMetrics("quantos ovos?", [m]).length, 0);
    assert.equal(findMetrics("ovo por ave alojada", [m]).length, 1);
  });

  it("pergunta sem metrica nenhuma devolve lista vazia", () => {
    assert.deepEqual(findMetrics("quantas linhas tem a tabela?", metrics), []);
    assert.deepEqual(findMetrics("", metrics), []);
  });

  it("catalogo vazio nunca casa", () => {
    assert.deepEqual(findMetrics("eclosao", []), []);
  });
});

describe("renderMetricsSection", () => {
  it("sem metrica reconhecida devolve null — o prompt fica igual ao de antes", () => {
    assert.equal(renderMetricsSection([]), null);
  });

  it("ratio mostra a formula e marca a coluna pronta como uso restrito", () => {
    const m = metrics.find((x) => x.id === "eclosao");
    assert.ok(m);
    const out = renderMetricsSection([m]) ?? "";
    assert.ok(out.includes("SUM(qtd_pintos_nascidos) / NULLIF(SUM(qtd_ovos_incubados), 0)"));
    assert.ok(out.includes("eclosao_real"));
    assert.ok(out.includes("um registro so"));
  });

  it("acumulada manda usar MAX", () => {
    const m = metrics.find((x) => x.kind === "cumulative");
    assert.ok(m);
    assert.ok((renderMetricsSection([m]) ?? "").includes(`MAX(${m.column})`));
  });

  it("inferida sai marcada para conferencia", () => {
    const m = metrics.find((x) => x.provenance === "inferred");
    assert.ok(m);
    assert.ok((renderMetricsSection([m]) ?? "").includes("NAO CONFIRMADO"));
  });

  it("confirmada nao sai marcada", () => {
    const m = metrics.find((x) => x.provenance === "schema");
    assert.ok(m);
    assert.ok(!(renderMetricsSection([m]) ?? "").includes("NAO CONFIRMADO"));
  });

  it("cita a coluna de meta sem deixar duvida de que e meta", () => {
    const m = metrics.find((x) => x.targetColumn);
    assert.ok(m);
    const out = renderMetricsSection([m]) ?? "";
    assert.ok(out.includes(m.targetColumn as string));
    assert.ok(out.includes("nunca o realizado"));
  });
});

describe("parseSeed rejeita catalogo malformado em vez de aceitar em silencio", () => {
  it("ratio sem denominador", () => {
    assert.throws(() => parseWith({ ...base(), denominator: undefined }), SeedError);
  });

  it("ratio com column", () => {
    assert.throws(() => parseWith({ ...base(), column: "c" }), SeedError);
  });

  it("nao-ratio sem column", () => {
    assert.throws(
      () => parseWith({ ...base(), kind: "cumulative", numerator: undefined, denominator: undefined }),
      SeedError
    );
  });

  it("nao-ratio com par", () => {
    assert.throws(() => parseWith({ ...base(), kind: "cumulative", column: "c" }), SeedError);
  });

  it("kind desconhecido", () => {
    assert.throws(() => parseWith({ ...base(), kind: "media" }), SeedError);
  });

  it("provenance desconhecida", () => {
    assert.throws(() => parseWith({ ...base(), provenance: "achismo" }), SeedError);
  });

  it("campo desconhecido (erro de digitacao nao pode passar batido)", () => {
    assert.throws(() => parseWith({ ...base(), numarator: "a" }), SeedError);
  });

  it("id duplicado", () => {
    assert.throws(
      () => parseSeed({ name: "x", vocabulary: {}, tableFacts: {}, metrics: [base(), base()] }),
      SeedError
    );
  });

  it("id com espaco ou maiuscula", () => {
    assert.throws(() => parseWith({ ...base(), id: "taxa de x" }), SeedError);
    assert.throws(() => parseWith({ ...base(), id: "TaxaX" }), SeedError);
  });

  it("inferida sem pitfall", () => {
    assert.throws(() => parseWith({ ...base(), provenance: "inferred" }), SeedError);
  });

  it("aceita o caso valido (senao os throws acima nao provam nada)", () => {
    assert.equal(parseWith(base()).metrics.length, 1);
  });

  it("seed sem metrics continua valido — o campo e opcional (fim)", () => {
    assert.deepEqual(parseSeed({ name: "x", vocabulary: {}, tableFacts: {} }).metrics, []);
  });
});

describe("vocabulary.notes e prosa, nao termo de casamento", () => {
  const withVocab = (vocabulary: unknown) =>
    parseSeed({ name: "x", vocabulary, tableFacts: {}, metrics: [] });

  it("preserva caixa, underscore e enfase", () => {
    // O motor injeta esta frase inteira no prompt. Normalizar mataria o nome
    // exato da coluna e a enfase — que sao a razao de a nota existir.
    const nota = "Ps_Liquido NUNCA soma com Ps_Bruto; use AVG entre linhas";
    assert.deepEqual(withVocab({ notes: [nota] }).vocabulary.notes, [nota]);
  });

  it("apara espaco em volta, sem tocar no meio", () => {
    assert.deepEqual(withVocab({ notes: ["  Dt_Transacao e o evento  "] }).vocabulary.notes, [
      "Dt_Transacao e o evento"
    ]);
  });

  it("rejeita note vazia ou que nao e string", () => {
    assert.throws(() => withVocab({ notes: [""] }), SeedError);
    assert.throws(() => withVocab({ notes: ["   "] }), SeedError);
    assert.throws(() => withVocab({ notes: [42] }), SeedError);
    assert.throws(() => withVocab({ notes: "uma nota so" }), SeedError);
  });

  it("os campos que o lexico compara continuam em minusculas", () => {
    const v = withVocab({ notes: ["Mantem A Caixa"], dimensionPrefixes: ["Sk", "ID"] }).vocabulary;
    assert.deepEqual(v.dimensionPrefixes, ["sk", "id"]);
    assert.deepEqual(v.notes, ["Mantem A Caixa"]);
  });
});
