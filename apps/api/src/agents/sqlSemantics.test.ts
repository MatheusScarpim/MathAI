import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TableChunk } from "@auraia/shared";
import { classifyColumn, type ColumnClass } from "../schema/lexicon.js";
import { inferTableFacts, periodStatus, type TableFacts } from "../schema/tableFacts.js";
import { buildDictionaryIndex, type DictionaryRecord } from "../schema/dictionaryOps.js";
import { resolveVocabulary } from "../schema/vocabulary.js";
import { loadBundledSeed } from "../schema/seedFile.js";
import { REAL_SCHEMA } from "../schema/realSchema.fixture.js";
import { buildSemanticsSection, pruneContext, type SemanticContext } from "./sqlSemantics.js";

const TABLE = "sch.medicao";

const cls = (over: Partial<ColumnClass> = {}): ColumnClass => ({
  role: "metric",
  unit: null,
  nature: null,
  cumulative: false,
  sex: null,
  source: null,
  bucket: null,
  period: null,
  matched: true,
  ...over
});

const facts = (over: Partial<TableFacts> = {}): TableFacts => ({
  tableFullName: TABLE,
  grain: null,
  eventDateColumn: null,
  alternateDateColumns: [],
  joinKey: null,
  requiresJoinForPeriod: false,
  periodJoinTable: null,
  periodJoinColumns: [],
  ...over
});

const table = (columns: string[], over: Partial<TableChunk> = {}): TableChunk => ({
  tableFullName: TABLE,
  columns: columns.map((name) => ({ name, type: "number" })),
  primaryKey: [],
  foreignKeys: [],
  tags: [],
  ...over
});

const context = (t: TableChunk) => ({ tables: [t], joins: [] });

const semantics = (
  columnClasses: Record<string, ColumnClass>,
  tableFacts: TableFacts = facts(),
  overlappingBuckets: Record<string, readonly string[]> = {}
): SemanticContext => {
  const records: DictionaryRecord[] = [
    {
      environmentId: "e",
      tableFullName: TABLE,
      source: "inferred",
      grain: tableFacts.grain,
      eventDateColumn: tableFacts.eventDateColumn,
      updatedAt: new Date()
    },
    ...Object.entries(columnClasses).map(([columnName, c]) => ({
      environmentId: "e",
      tableFullName: TABLE,
      columnName,
      source: "inferred" as const,
      class: c,
      updatedAt: new Date()
    }))
  ];
  return {
    facts: [tableFacts],
    dictionary: buildDictionaryIndex(records),
    overlappingBuckets,
    notes: []
  };
};

const wide = (n: number, prefix = "col"): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);

describe("E4 — sem dicionario o comportamento e o de antes", () => {
  it("pruneContext devolve a MESMA referencia quando nao ha semantica", () => {
    const ctx = context(table(wide(200)));
    assert.equal(pruneContext(ctx, "qualquer pergunta", null), ctx);
  });

  it("pruneContext devolve a MESMA referencia quando o dicionario esta vazio", () => {
    const ctx = context(table(wide(200)));
    const empty: SemanticContext = {
      facts: [],
      dictionary: buildDictionaryIndex([]),
      overlappingBuckets: {},
      notes: []
    };
    assert.equal(pruneContext(ctx, "pergunta", empty), ctx);
  });

  it("buildSemanticsSection devolve null sem semantica", () => {
    assert.equal(buildSemanticsSection(context(table(["a"])), null, "pt"), null);
  });

  it("devolve null quando o dicionario nao tem nada a dizer sobre a tabela", () => {
    const s = semantics({ a: cls() });
    assert.equal(buildSemanticsSection(context(table(["a"])), s, "pt"), null);
  });

  it("notes do seed saem no prompt com a caixa original", () => {
    const nota = "Ps_Liquido NUNCA soma com Ps_Bruto; para agregar use AVG";
    const s = { ...semantics({ a: cls() }), notes: [nota] };
    const out = buildSemanticsSection(context(table(["a"])), s, "pt") ?? "";
    // Literal: a nota existe justamente para carregar o nome exato da coluna
    // e a enfase da regra. Baixar a caixa destruiria as duas coisas.
    assert.ok(out.includes(nota));
  });

  it("notes sozinhas ja produzem bloco, mesmo sem fato nem dicionario", () => {
    const s: SemanticContext = {
      facts: [],
      dictionary: buildDictionaryIndex([]),
      overlappingBuckets: {},
      notes: ["convencao qualquer"]
    };
    const out = buildSemanticsSection(context(table(["a"])), s, "pt");
    assert.ok(out !== null && out.includes("convencao qualquer"));
  });

  it("notes vem ANTES dos blocos por tabela", () => {
    const s = { ...semantics({ a: cls({ cumulative: true }) }), notes: ["legenda primeiro"] };
    const out = buildSemanticsSection(context(table(["a"])), s, "pt") ?? "";
    const iNota = out.indexOf("legenda primeiro");
    const iTabela = out.indexOf(TABLE);
    assert.ok(iNota >= 0 && iTabela >= 0, "esperava nota e bloco de tabela na saida");
    assert.ok(iNota < iTabela, "a legenda do banco precisa preceder o que ela explica");
  });

  it("sem notes o comportamento de antes fica igual", () => {
    const s = semantics({ a: cls({ cumulative: true }) });
    const out = buildSemanticsSection(context(table(["a"])), s, "pt") ?? "";
    assert.ok(!out.includes("Convencoes deste banco"));
    assert.ok(out.includes(TABLE));
  });
});

describe("E4 — poda", () => {
  it("tabela abaixo do teto sai intacta", () => {
    const t = table(wide(40));
    const out = pruneContext(context(t), "pergunta", semantics({}));
    assert.equal(out.tables[0]!.columns.length, 40);
  });

  it("tabela acima do teto e podada", () => {
    const t = table(wide(200));
    const out = pruneContext(context(t), "pergunta", semantics({}));
    assert.equal(out.tables[0]!.columns.length, 40);
  });

  it("preserva PK, FK e as colunas de data/juncao dos fatos", () => {
    const t = table([...wide(200), "pk_id", "fk_id", "dt_evento", "dt_outra", "k_join", "c_join"], {
      primaryKey: ["pk_id"],
      foreignKeys: [{ fromTable: TABLE, fromColumn: "fk_id", toTable: "sch.dim", toColumn: "id" }]
    });
    const f = facts({
      eventDateColumn: "dt_evento",
      alternateDateColumns: ["dt_outra"],
      joinKey: "k_join",
      periodJoinColumns: ["c_join"]
    });
    const kept = new Set(
      pruneContext(context(t), "pergunta", semantics({}, f)).tables[0]!.columns.map((c) => c.name)
    );
    for (const name of ["pk_id", "fk_id", "dt_evento", "dt_outra", "k_join", "c_join"]) {
      assert.ok(kept.has(name), `${name} foi podada`);
    }
  });

  it("preserva a coluna que a pergunta cita", () => {
    const t = table([...wide(200), "valor_liquido"]);
    const kept = pruneContext(
      context(t),
      "qual o valor_liquido do mes?",
      semantics({})
    ).tables[0]!.columns.map((c) => c.name);
    assert.ok(kept.includes("valor_liquido"));
  });

  it("preserva coluna sobre a qual as guardas tem algo a dizer", () => {
    const t = table([...wide(200), "acum_total", "taxa_x", "meta_y", "real_z", "faixa_a"]);
    const s = semantics({
      acum_total: cls({ cumulative: true }),
      taxa_x: cls({ unit: "rate" }),
      meta_y: cls({ nature: "target" }),
      real_z: cls({ nature: "actual" }),
      faixa_a: cls({ bucket: "00a03" })
    });
    const kept = new Set(
      pruneContext(context(t), "pergunta", s).tables[0]!.columns.map((c) => c.name)
    );
    for (const name of ["acum_total", "taxa_x", "meta_y", "real_z", "faixa_a"]) {
      assert.ok(kept.has(name), `${name} foi podada apesar de ter aviso`);
    }
  });

  it("mantem a ordem original das colunas", () => {
    const t = table([...wide(200), "zzz_ultima"], { primaryKey: ["col000"] });
    const kept = pruneContext(context(t), "zzz_ultima", semantics({})).tables[0]!.columns.map(
      (c) => c.name
    );
    const sorted = [...kept].sort(
      (a, b) => t.columns.findIndex((c) => c.name === a) - t.columns.findIndex((c) => c.name === b)
    );
    assert.deepEqual(kept, sorted);
  });

  it("nao corta o obrigatorio mesmo quando ele sozinho estoura o teto", () => {
    const many = wide(60, "dt");
    const t = table(many, { primaryKey: many });
    const kept = pruneContext(context(t), "pergunta", semantics({})).tables[0]!.columns;
    assert.equal(kept.length, 60);
  });
});

describe("E4 — o bloco espelha as guardas do E3", () => {
  const sectionFor = (
    columns: string[],
    columnClasses: Record<string, ColumnClass>,
    tableFacts?: TableFacts,
    buckets?: Record<string, readonly string[]>
  ): string =>
    buildSemanticsSection(
      context(table(columns)),
      semantics(columnClasses, tableFacts ?? facts(), buckets ?? {}),
      "pt"
    ) ?? "";

  it("guarda 1 — acumulada manda usar MAX", () => {
    const out = sectionFor(["acum_total"], { acum_total: cls({ cumulative: true }) });
    assert.match(out, /acum_total/);
    assert.match(out, /MAX/);
  });

  it("guarda 2 — taxa proibe soma e media simples", () => {
    const out = sectionFor(["taxa_x"], { taxa_x: cls({ unit: "rate" }) });
    assert.match(out, /taxa_x/);
    assert.match(out, /NULLIF/);
  });

  it("guarda 6 — meta e realizado juntos viram aviso", () => {
    const out = sectionFor(["meta_y", "real_z"], {
      meta_y: cls({ nature: "target" }),
      real_z: cls({ nature: "actual" })
    });
    assert.match(out, /meta_y/);
    assert.match(out, /real_z/);
  });

  it("guarda 6 — meta sozinha nao gera aviso de soma", () => {
    const out = sectionFor(["meta_y"], { meta_y: cls({ nature: "target" }) });
    assert.equal(/nao se somam/.test(out), false);
  });

  it("guarda 3 — faixa que contem outra", () => {
    const out = sectionFor(
      ["f_pai", "f_filho"],
      { f_pai: cls({ bucket: "00a07" }), f_filho: cls({ bucket: "00a03" }) },
      facts(),
      { "00a07": ["00a03"] }
    );
    assert.match(out, /JA CONTEM/);
  });

  it("guarda 3 — sem faixas declaradas fica calada", () => {
    const out = sectionFor(["f_pai", "f_filho"], {
      f_pai: cls({ bucket: "00a07" }),
      f_filho: cls({ bucket: "00a03" })
    });
    assert.equal(/JA CONTEM/.test(out), false);
  });

  it("guarda 4 — data do evento com as alternativas nomeadas", () => {
    const out = sectionFor(
      ["dt_evento", "dt_outra"],
      {},
      facts({ eventDateColumn: "dt_evento", alternateDateColumns: ["dt_outra"] })
    );
    assert.match(out, /dt_evento/);
    assert.match(out, /NAO use dt_outra/);
  });

  it("guarda 5 — tabela sem data manda juntar", () => {
    const out = sectionFor(
      ["c_join"],
      {},
      facts({
        requiresJoinForPeriod: true,
        periodJoinTable: "sch.datada",
        periodJoinColumns: ["c_join"]
      })
    );
    assert.match(out, /sch\.datada/);
    assert.match(out, /c_join/);
  });

  it("tabela sem data alcancavel avisa que nao responde periodo", () => {
    const out = sectionFor(["a"], {}, facts({ requiresJoinForPeriod: true }));
    assert.match(out, /nao responde pergunta com recorte de periodo/);
  });

  it("o grao entra quando existe", () => {
    const out = sectionFor(["a"], {}, facts({ grain: "uma linha por dia" }));
    assert.match(out, /grao: uma linha por dia/);
  });
});

describe("E4 — coerencia entre poda e bloco", () => {
  it("o bloco nunca cita coluna que a poda cortou", () => {
    const t = table([...wide(200), "acum_total"]);
    const s = semantics({
      acum_total: cls({ cumulative: true }),
      col000: cls({ cumulative: true })
    });
    const pruned = pruneContext(context(t), "pergunta", s);
    const out = buildSemanticsSection(pruned, s, "pt") ?? "";
    const visible = new Set(pruned.tables[0]!.columns.map((c) => c.name));
    for (const name of out.matchAll(/col\d{3}|acum_total/g)) {
      assert.ok(visible.has(name[0]), `${name[0]} citado mas podado`);
    }
  });

  /**
   * O teste acima so exercita `tableNotes`, que ja itera as colunas visiveis
   * — ele nao PODE falhar. O cabecalho e outra historia: ele le `facts.*`, que
   * nomeia coluna de OUTRA tabela, e foi por essa fresta que o D1 passou.
   */
  it("o cabecalho nao manda juntar por coluna que a poda escondeu no ALVO", () => {
    const alvo = "sch.datada";
    const origem = table([...wide(200), "k_join", "c_grao"]);
    const destino: TableChunk = {
      ...table([...wide(200), "k_join", "c_grao", "dt_evento"]),
      tableFullName: alvo
    };

    const semOrigem = facts({
      requiresJoinForPeriod: true,
      periodJoinTable: alvo,
      periodJoinColumns: ["k_join", "c_grao"],
      joinKey: "k_join"
    });
    const semAlvo = facts({ tableFullName: alvo, eventDateColumn: "dt_evento" });

    const records: DictionaryRecord[] = [semOrigem, semAlvo].map((f) => ({
      environmentId: "e",
      tableFullName: f.tableFullName,
      source: "inferred" as const,
      grain: f.grain,
      eventDateColumn: f.eventDateColumn,
      updatedAt: new Date()
    }));
    const s: SemanticContext = {
      facts: [semOrigem, semAlvo],
      dictionary: buildDictionaryIndex(records),
      overlappingBuckets: {},
      notes: []
    };

    const pruned = pruneContext({ tables: [origem, destino], joins: [] }, "pergunta", s);
    const visivelNo = (nome: string): Set<string> =>
      new Set(
        pruned.tables
          .find((t) => t.tableFullName === nome)!
          .columns.map((c) => c.name)
      );

    // As duas pontas do ON: a instrucao e impossivel se faltar qualquer uma.
    for (const col of semOrigem.periodJoinColumns) {
      assert.ok(visivelNo(TABLE).has(col), `${col} podada da ORIGEM`);
      assert.ok(visivelNo(alvo).has(col), `${col} podada do ALVO`);
    }
    assert.match(buildSemanticsSection(pruned, s, "pt") ?? "", /junte com sch\.datada por k_join, c_grao/);
  });
});

/**
 * Faixa que contem outra e meta-versus-realizado sao relacoes entre COLUNAS.
 * As guardas do E3 resolvem coluna nao-qualificada por consenso entre todas as
 * tabelas do SQL, entao elas disparam com as pontas separadas — e ate o D2 o
 * prompt ficava calado justamente nesse caso.
 */
describe("E4 — avisos cujas pontas estao em tabelas diferentes", () => {
  const OUTRA = "sch.outra";

  const doisLados = (
    aqui: Record<string, ColumnClass>,
    la: Record<string, ColumnClass>,
    overlappingBuckets: Record<string, readonly string[]> = {}
  ) => {
    const records: DictionaryRecord[] = [
      ...Object.entries(aqui).map(([columnName, c]) => ({
        environmentId: "e",
        tableFullName: TABLE,
        columnName,
        source: "inferred" as const,
        class: c,
        updatedAt: new Date()
      })),
      ...Object.entries(la).map(([columnName, c]) => ({
        environmentId: "e",
        tableFullName: OUTRA,
        columnName,
        source: "inferred" as const,
        class: c,
        updatedAt: new Date()
      }))
    ];
    const s: SemanticContext = {
      facts: [],
      dictionary: buildDictionaryIndex(records),
      overlappingBuckets,
      notes: []
    };
    const ctx = {
      tables: [
        table(Object.keys(aqui)),
        { ...table(Object.keys(la)), tableFullName: OUTRA }
      ],
      joins: []
    };
    return buildSemanticsSection(ctx, s, "pt") ?? "";
  };

  it("faixa pai numa tabela e filha na outra vira aviso", () => {
    const out = doisLados(
      { f_pai: cls({ bucket: "00a07" }) },
      { f_filho: cls({ bucket: "00a03" }) },
      { "00a07": ["00a03"] }
    );
    assert.match(out, /JA CONTEM/);
    assert.match(out, /sch\.medicao\.f_pai/);
    assert.match(out, /sch\.outra\.f_filho/);
  });

  it("meta numa tabela e realizado na outra vira aviso", () => {
    const out = doisLados(
      { meta_y: cls({ nature: "target" }) },
      { real_z: cls({ nature: "actual" }) }
    );
    assert.match(out, /nao se somam/);
    assert.match(out, /sch\.medicao\.meta_y/);
    assert.match(out, /sch\.outra\.real_z/);
  });

  it("nao repete o aviso quando as duas pontas estao na mesma tabela", () => {
    const out = doisLados(
      { meta_y: cls({ nature: "target" }), real_z: cls({ nature: "actual" }) },
      { neutra: cls() }
    );
    assert.equal(out.includes("Entre tabelas:"), false);
  });

  it("uma tabela so nao gera secao cross-table", () => {
    const out =
      buildSemanticsSection(
        context(table(["meta_y", "real_z"])),
        semantics({ meta_y: cls({ nature: "target" }), real_z: cls({ nature: "actual" }) }),
        "pt"
      ) ?? "";
    assert.equal(out.includes("Entre tabelas:"), false);
  });
});

/**
 * O invariante do D1 sobre o schema do cliente, nao sobre fixture escolhida a
 * dedo: NENHUMA coluna nomeada em texto injetado pode estar ausente do schema
 * podado, em qualquer tabela. O defeito original so aparecia aqui — com
 * `facts()` vazio ele e invisivel.
 */
describe("E4 — o invariante vale no schema real", () => {
  const SEED = loadBundledSeed("avicultura");
  const VOCABULARY = resolveVocabulary(SEED.vocabulary);
  const inputs = REAL_SCHEMA.map((t) => ({ fullName: t.tableFullName, columns: t.columns }));
  const FACTS = inferTableFacts(inputs, VOCABULARY, SEED.tableFacts);

  const records: DictionaryRecord[] = [];
  for (const t of REAL_SCHEMA) {
    for (const c of t.columns) {
      records.push({
        environmentId: "test",
        tableFullName: t.tableFullName,
        columnName: c.name,
        source: "inferred",
        class: classifyColumn(c.name, c.type, VOCABULARY),
        updatedAt: new Date()
      });
    }
  }
  for (const f of FACTS) {
    records.push({
      environmentId: "test",
      tableFullName: f.tableFullName,
      source: "inferred",
      grain: f.grain,
      eventDateColumn: f.eventDateColumn,
      updatedAt: new Date()
    });
  }

  const s: SemanticContext = {
    facts: FACTS,
    dictionary: buildDictionaryIndex(records),
    overlappingBuckets: VOCABULARY.overlappingBuckets,
    notes: []
  };

  const fullContext = {
    tables: REAL_SCHEMA.map((t) => ({
      tableFullName: t.tableFullName,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
      primaryKey: [],
      foreignKeys: [],
      tags: []
    })),
    joins: []
  };

  const PERGUNTAS = [
    "qual a eclosao media por granja em 2024?",
    "quantos ovos foram incubados no mes passado?",
    "compare o realizado com o padrao da linhagem"
  ];

  for (const pergunta of PERGUNTAS) {
    it(`nenhuma coluna do ON some do alvo — "${pergunta}"`, () => {
      const pruned = pruneContext(fullContext, pergunta, s);
      const visiveis = new Map(
        pruned.tables.map((t) => [
          t.tableFullName.toLowerCase(),
          new Set(t.columns.map((c) => c.name.toLowerCase()))
        ])
      );

      const violacoes: string[] = [];
      for (const f of FACTS) {
        if (periodStatus(f) !== "requires-join" || !f.periodJoinTable) continue;
        const doOn = f.periodJoinColumns.length
          ? f.periodJoinColumns
          : f.joinKey
            ? [f.joinKey]
            : [];
        for (const col of doOn) {
          for (const lado of [f.tableFullName, f.periodJoinTable]) {
            const cols = visiveis.get(lado.toLowerCase());
            if (cols && !cols.has(col.toLowerCase())) {
              violacoes.push(`${col} ausente de ${lado} (ON de ${f.tableFullName})`);
            }
          }
        }
      }
      assert.deepEqual(violacoes, []);
    });
  }

  it("o alvo do join tem ao menos uma tabela requires-join no schema real", () => {
    // Sem isto os testes acima passariam num schema onde nada precisa juntar.
    const comJoin = FACTS.filter((f) => periodStatus(f) === "requires-join");
    assert.ok(comJoin.length >= 1, "nenhuma tabela requires-join: o invariante nao foi exercitado");
    assert.ok(
      comJoin.some((f) => f.periodJoinColumns.length >= 2),
      "nenhum ON com 2+ colunas: o caso do D1 nao foi exercitado"
    );
  });
});

describe("E4 — idioma", () => {
  it("en e es nao caem no texto pt", () => {
    const ctx = context(table(["acum_total"]));
    const s = semantics({ acum_total: cls({ cumulative: true }) });
    assert.match(buildSemanticsSection(ctx, s, "en") ?? "", /cumulative/);
    assert.match(buildSemanticsSection(ctx, s, "es") ?? "", /acumuladas/);
    assert.match(buildSemanticsSection(ctx, s, "pt") ?? "", /acumuladas/);
  });
});
