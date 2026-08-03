import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkSemanticGuards, factsFromDictionary } from "./sqlGuards.js";
import { classifyColumn, type ColumnClass } from "../schema/lexicon.js";
import { buildDictionaryIndex, type DictionaryRecord } from "../schema/dictionaryOps.js";
import { inferTableFacts, type TableFacts } from "../schema/tableFacts.js";
import { resolveVocabulary } from "../schema/vocabulary.js";
import { loadBundledSeed } from "../schema/seedFile.js";
import { REAL_SCHEMA } from "../schema/realSchema.fixture.js";

/**
 * As guardas existem para o erro que NAO gera erro. Por isso todo teste aqui
 * vem em par: um SQL que precisa ser barrado e o SQL vizinho, legitimo, que
 * NAO pode ser. Um falso positivo queima tentativa de retry e pode derrubar
 * uma pergunta que teria resposta certa — e mais caro que deixar passar.
 *
 * A primeira metade usa um schema sintetico de pedidos, montado so com as
 * convencoes PT-BR embutidas: prova que o mecanismo funciona sem seed de
 * dominio nenhum. A segunda roda sobre o schema real do cliente, para provar
 * que ele funciona sobre nomes que ninguem escolheu para o teste.
 */

// --- schema sintetico -------------------------------------------------------

const COLUMNS: Record<string, Array<[string, string]>> = {
  "dbo.pedidos": [
    ["cod_pedido", "int"],
    ["dat_emissao", "date"],
    ["dat_entrega", "date"],
    ["qtd_itens", "int"],
    ["qtd_vendas_acum", "int"],
    ["pct_aprov", "numeric"],
    ["valor_total_padrao", "numeric"],
    ["valor_total_obtido", "numeric"],
    ["qtd_00a07_perda", "int"],
    ["qtd_00a03_perda", "int"]
  ],
  "dbo.itens": [
    ["cod_pedido", "int"],
    ["qtd_pecas", "int"]
  ]
};

const SYNTHETIC_FACTS: TableFacts[] = [
  {
    tableFullName: "dbo.pedidos",
    grain: "1 linha = pedido",
    eventDateColumn: "dat_emissao",
    alternateDateColumns: ["dat_entrega"],
    joinKey: "cod_pedido",
    requiresJoinForPeriod: false,
    periodJoinTable: null,
    periodJoinColumns: []
  },
  {
    tableFullName: "dbo.itens",
    grain: "1 linha = item do pedido",
    eventDateColumn: null,
    alternateDateColumns: [],
    joinKey: "cod_pedido",
    requiresJoinForPeriod: true,
    periodJoinTable: "dbo.pedidos",
    periodJoinColumns: ["cod_pedido"]
  }
];

const syntheticRecords = (): DictionaryRecord[] => {
  const out: DictionaryRecord[] = [];
  for (const [table, cols] of Object.entries(COLUMNS)) {
    for (const [name, type] of cols) {
      out.push({
        environmentId: "test",
        tableFullName: table,
        columnName: name,
        source: "inferred",
        class: classifyColumn(name, type),
        updatedAt: new Date()
      });
    }
  }
  for (const f of SYNTHETIC_FACTS) {
    out.push({
      environmentId: "test",
      tableFullName: f.tableFullName,
      source: "inferred",
      grain: f.grain,
      eventDateColumn: f.eventDateColumn,
      alternateDateColumns: [...f.alternateDateColumns],
      joinKey: f.joinKey,
      requiresJoinForPeriod: f.requiresJoinForPeriod,
      periodJoinTable: f.periodJoinTable,
      periodJoinColumns: [...f.periodJoinColumns],
      updatedAt: new Date()
    });
  }
  return out;
};

const DICT = buildDictionaryIndex(syntheticRecords());
const BUCKETS = { "00a07": ["00a03", "04a07"] };

const check = (sql: string) =>
  checkSemanticGuards(sql, SYNTHETIC_FACTS, DICT, {
    dbType: "sqlserver",
    overlappingBuckets: BUCKETS
  });

/** O teste inteiro seria vacuo se o lexico nao classificasse o sintetico. */
describe("o schema sintetico e mesmo classificavel so com as convencoes", () => {
  const classOf = (table: string, column: string): ColumnClass => {
    const cls = DICT.column(table, column)?.class;
    assert.ok(cls, `${table}.${column} nao esta no dicionario`);
    return cls!;
  };

  it("as colunas que as guardas leem tem a classe esperada", () => {
    assert.equal(classOf("dbo.pedidos", "qtd_vendas_acum").cumulative, true);
    assert.equal(classOf("dbo.pedidos", "pct_aprov").unit, "rate");
    assert.equal(classOf("dbo.pedidos", "qtd_itens").unit, "count");
    assert.equal(classOf("dbo.pedidos", "qtd_itens").cumulative, false);
    assert.equal(classOf("dbo.pedidos", "valor_total_padrao").nature, "target");
    assert.equal(classOf("dbo.pedidos", "valor_total_obtido").nature, "actual");
    assert.equal(classOf("dbo.pedidos", "qtd_00a07_perda").bucket, "00a07");
    assert.equal(classOf("dbo.pedidos", "qtd_00a03_perda").bucket, "00a03");
    assert.equal(classOf("dbo.pedidos", "dat_emissao").role, "date");
  });
});

describe("guarda 1 — agregado sobre coluna acumulada", () => {
  it("barra SUM de acumulado", () => {
    const err = check("SELECT SUM(qtd_vendas_acum) FROM dbo.pedidos");
    assert.equal(err?.category, "aggregation_error");
    assert.match(err!.hint, /MAX/);
    assert.match(err!.hint, /qtd_vendas_acum/);
  });

  it("barra AVG de acumulado", () => {
    assert.ok(check("SELECT AVG(qtd_vendas_acum) FROM dbo.pedidos"));
  });

  it("barra acumulado dentro de expressao", () => {
    // Nao ha uso legitimo de acumulado dentro de agregado, entao aqui a
    // guarda e frouxa de proposito — diferente da taxa.
    assert.ok(check("SELECT SUM(qtd_vendas_acum - qtd_itens) FROM dbo.pedidos"));
  });

  it("nao barra MAX do acumulado, que e a forma correta", () => {
    assert.equal(check("SELECT MAX(qtd_vendas_acum) FROM dbo.pedidos"), null);
  });

  it("nao barra SUM de coluna nao acumulada", () => {
    assert.equal(check("SELECT SUM(qtd_itens) FROM dbo.pedidos"), null);
  });
});

describe("guarda 2 — agregado sobre taxa", () => {
  it("barra AVG de percentual", () => {
    const err = check("SELECT AVG(pct_aprov) FROM dbo.pedidos");
    assert.equal(err?.category, "aggregation_error");
    assert.match(err!.hint, /NULLIF/);
  });

  it("barra SUM de percentual", () => {
    assert.ok(check("SELECT SUM(pct_aprov) FROM dbo.pedidos"));
  });

  it("barra mesmo embrulhado em CAST", () => {
    // O embrulho nao muda nada: continua uma media de percentual.
    assert.ok(check("SELECT AVG(CAST(pct_aprov AS float)) FROM dbo.pedidos"));
  });

  it("nao barra media ponderada, que e a forma correta", () => {
    assert.equal(
      check(
        "SELECT SUM(pct_aprov * qtd_itens) / NULLIF(SUM(qtd_itens), 0) FROM dbo.pedidos"
      ),
      null
    );
  });

  it("nao barra a taxa recalculada a partir das contagens", () => {
    assert.equal(
      check("SELECT SUM(qtd_itens) / NULLIF(SUM(qtd_pecas), 0) FROM dbo.pedidos"),
      null
    );
  });

  it("nao barra a taxa fora de agregado", () => {
    assert.equal(check("SELECT pct_aprov FROM dbo.pedidos WHERE pct_aprov > 90"), null);
  });
});

describe("guarda 3 — faixas que se contem", () => {
  it("barra a faixa ampla somada com a que ela contem", () => {
    const err = check(
      "SELECT SUM(qtd_00a07_perda + qtd_00a03_perda) FROM dbo.pedidos"
    );
    assert.equal(err?.category, "aggregation_error");
    assert.match(err!.hint, /00a07/);
    assert.match(err!.hint, /00a03/);
  });

  it("barra tambem quando a soma e entre dois agregados", () => {
    assert.ok(
      check("SELECT SUM(qtd_00a07_perda) + SUM(qtd_00a03_perda) FROM dbo.pedidos")
    );
  });

  it("nao barra as duas faixas lado a lado (detalhamento)", () => {
    assert.equal(
      check("SELECT SUM(qtd_00a07_perda), SUM(qtd_00a03_perda) FROM dbo.pedidos"),
      null
    );
  });

  it("fica calada quando ninguem declarou faixas que se contem", () => {
    assert.equal(
      checkSemanticGuards(
        "SELECT SUM(qtd_00a07_perda + qtd_00a03_perda) FROM dbo.pedidos",
        SYNTHETIC_FACTS,
        DICT,
        { dbType: "sqlserver" }
      ),
      null
    );
  });
});

describe("guarda 6 — meta somada com realizado", () => {
  it("barra a soma", () => {
    const err = check(
      "SELECT SUM(valor_total_obtido + valor_total_padrao) FROM dbo.pedidos"
    );
    assert.equal(err?.category, "aggregation_error");
    assert.match(err!.hint, /desvio|atingimento/);
  });

  it("nao barra o desvio", () => {
    assert.equal(
      check(
        "SELECT SUM(valor_total_obtido) - SUM(valor_total_padrao) FROM dbo.pedidos"
      ),
      null
    );
  });

  it("nao barra o atingimento", () => {
    assert.equal(
      check(
        "SELECT SUM(valor_total_obtido) / NULLIF(SUM(valor_total_padrao), 0) FROM dbo.pedidos"
      ),
      null
    );
  });

  it("nao barra as duas em colunas separadas", () => {
    assert.equal(
      check(
        "SELECT SUM(valor_total_obtido) AS obtido, SUM(valor_total_padrao) AS meta FROM dbo.pedidos"
      ),
      null
    );
  });
});

describe("guarda 4 — periodo filtrado pela data errada", () => {
  it("barra o filtro na data que nao e a do evento", () => {
    const err = check(
      "SELECT SUM(qtd_itens) FROM dbo.pedidos WHERE dat_entrega >= '2025-01-01'"
    );
    assert.equal(err?.category, "validation_error");
    assert.match(err!.hint, /dat_emissao/);
  });

  it("nao barra o filtro na data do evento", () => {
    assert.equal(
      check(
        "SELECT SUM(qtd_itens) FROM dbo.pedidos WHERE dat_emissao >= '2025-01-01'"
      ),
      null
    );
  });

  it("nao barra quando as duas datas aparecem (o SQL sabe o que faz)", () => {
    assert.equal(
      check(
        "SELECT SUM(qtd_itens) FROM dbo.pedidos WHERE dat_emissao >= '2025-01-01' AND dat_entrega IS NOT NULL"
      ),
      null
    );
  });

  it("nao barra a data alternativa fora do WHERE", () => {
    assert.equal(
      check("SELECT dat_entrega, SUM(qtd_itens) FROM dbo.pedidos GROUP BY dat_entrega"),
      null
    );
  });
});

describe("guarda 5 — periodo sem a juncao que o torna possivel", () => {
  it("barra o recorte temporal na tabela sem data propria", () => {
    const err = check(
      "SELECT SUM(qtd_pecas) FROM dbo.itens WHERE YEAR(dat_emissao) = 2025"
    );
    assert.equal(err?.category, "join_error");
    assert.match(err!.hint, /dbo\.pedidos/);
    assert.match(err!.hint, /cod_pedido/);
  });

  it("nao barra quando a juncao esta la", () => {
    assert.equal(
      check(
        "SELECT SUM(i.qtd_pecas) FROM dbo.itens i JOIN dbo.pedidos p ON i.cod_pedido = p.cod_pedido WHERE YEAR(p.dat_emissao) = 2025"
      ),
      null
    );
  });

  it("nao barra a consulta sem recorte de periodo", () => {
    // A guarda nao conhece a pergunta: total geral e uso legitimo.
    assert.equal(
      check("SELECT SUM(qtd_pecas) FROM dbo.itens WHERE cod_pedido > 0"),
      null
    );
  });
});

describe("a guarda se cala quando nao tem base para falar", () => {
  it("sem tabela conhecida no SQL", () => {
    assert.equal(check("SELECT SUM(qualquer_coisa) FROM dbo.inexistente"), null);
  });

  it("sem fatos de tabela", () => {
    assert.equal(
      checkSemanticGuards("SELECT SUM(qtd_vendas_acum) FROM dbo.pedidos", [], DICT),
      null
    );
  });

  it("sem dicionario", () => {
    const vazio = buildDictionaryIndex([]);
    assert.equal(
      checkSemanticGuards(
        "SELECT SUM(qtd_vendas_acum) FROM dbo.pedidos",
        SYNTHETIC_FACTS,
        vazio
      ),
      null
    );
  });

  it("nao confunde sufixo de nome com nome de tabela", () => {
    // `qtd_itens` contem "itens"; se isso marcasse `dbo.itens` como
    // referenciada, a guarda 5 dispararia numa consulta que nao a envolve.
    assert.equal(
      check("SELECT SUM(qtd_itens) FROM dbo.pedidos WHERE YEAR(dat_emissao) = 2025"),
      null
    );
  });
});

describe("comentario e literal nao contam como uso de coluna", () => {
  it("agregado errado dentro de comentario passa", () => {
    assert.equal(
      check("SELECT SUM(qtd_itens) FROM dbo.pedidos -- SUM(qtd_vendas_acum)"),
      null
    );
  });

  it("agregado errado dentro de comentario de bloco passa", () => {
    assert.equal(
      check("SELECT /* AVG(pct_aprov) */ SUM(qtd_itens) FROM dbo.pedidos"),
      null
    );
  });

  it("nome de coluna dentro de string passa", () => {
    assert.equal(
      check("SELECT 'AVG(pct_aprov)' AS rotulo, SUM(qtd_itens) FROM dbo.pedidos"),
      null
    );
  });

  it("mas o agregado errado de verdade continua sendo pego no mesmo SQL", () => {
    assert.ok(
      check("SELECT 'nada' AS rotulo, AVG(pct_aprov) FROM dbo.pedidos")
    );
  });
});

/**
 * Regressao dos falsos positivos que a verificacao independente encontrou.
 *
 * Os 42 testes acima passavam com os quatro defeitos no lugar: cada guarda
 * tinha contraprova para o caso legitimo OBVIO, e nenhuma para a forma vizinha
 * que tambem e legitima. Cada caso aqui vem com o verdadeiro positivo colado,
 * para provar que estreitar o gatilho nao desligou a guarda.
 */
describe("falsos positivos corrigidos", () => {
  describe("FP-A — citar a data alternativa nao e filtrar por ela", () => {
    it("nao barra IS NULL na data alternativa", () => {
      assert.equal(
        check("SELECT SUM(qtd_itens) FROM dbo.pedidos WHERE dat_entrega IS NULL"),
        null
      );
    });

    it("nao barra IS NOT NULL na data alternativa", () => {
      assert.equal(
        check("SELECT SUM(qtd_itens) FROM dbo.pedidos WHERE dat_entrega IS NOT NULL"),
        null
      );
    });

    it("nao barra a data alternativa usada como juncao", () => {
      assert.equal(
        check(
          "SELECT SUM(i.qtd_pecas) FROM dbo.itens i JOIN dbo.pedidos p ON i.cod_pedido = p.cod_pedido WHERE p.dat_entrega = p.dat_emissao"
        ),
        null
      );
    });

    it("VP: comparacao com constante continua barrada", () => {
      assert.ok(
        check("SELECT SUM(qtd_itens) FROM dbo.pedidos WHERE dat_entrega >= '2025-01-01'")
      );
    });

    it("VP: BETWEEN na data alternativa continua barrado", () => {
      assert.ok(
        check(
          "SELECT SUM(qtd_itens) FROM dbo.pedidos WHERE dat_entrega BETWEEN '2025-01-01' AND '2025-12-31'"
        )
      );
    });

    it("VP: funcao de data sobre a alternativa continua barrada", () => {
      assert.ok(
        check("SELECT SUM(qtd_itens) FROM dbo.pedidos WHERE YEAR(dat_entrega) = 2025")
      );
    });
  });

  describe("FP-B — BETWEEN numerico nao e recorte de periodo", () => {
    it("nao barra BETWEEN sobre chave numerica", () => {
      assert.equal(
        check("SELECT SUM(qtd_pecas) FROM dbo.itens WHERE cod_pedido BETWEEN 1 AND 10"),
        null
      );
    });

    it("VP: BETWEEN sobre data continua exigindo a juncao", () => {
      const err = check(
        "SELECT SUM(qtd_pecas) FROM dbo.itens WHERE dat_emissao BETWEEN '2025-01-01' AND '2025-12-31'"
      );
      assert.equal(err?.category, "join_error");
      assert.match(err!.hint, /dbo\.pedidos/);
    });

    it("VP: funcao de data continua exigindo a juncao", () => {
      assert.equal(
        check("SELECT SUM(qtd_pecas) FROM dbo.itens WHERE YEAR(dat_emissao) = 2025")?.category,
        "join_error"
      );
    });
  });

  describe("FP-C — a condicao do CASE nao e o que se agrega", () => {
    it("nao barra acumulado no predicado de um CASE", () => {
      assert.equal(
        check(
          "SELECT SUM(CASE WHEN qtd_vendas_acum > 0 THEN 1 ELSE 0 END) FROM dbo.pedidos"
        ),
        null
      );
    });

    it("nao barra taxa no predicado de um CASE (mesma familia, guarda 2)", () => {
      assert.equal(
        check("SELECT SUM(CASE WHEN pct_aprov > 90 THEN 1 ELSE 0 END) FROM dbo.pedidos"),
        null
      );
    });

    it("VP: acumulado no ramo THEN continua barrado", () => {
      assert.ok(
        check(
          "SELECT SUM(CASE WHEN qtd_itens > 0 THEN qtd_vendas_acum ELSE 0 END) FROM dbo.pedidos"
        )
      );
    });

    it("VP: SUM direto do acumulado continua barrado", () => {
      assert.ok(check("SELECT SUM(qtd_vendas_acum) FROM dbo.pedidos"));
    });
  });

  describe("FP-D — naturezas em lados opostos nao sao soma", () => {
    it("nao barra desvio com uma terceira parcela somada", () => {
      assert.equal(
        check(
          "SELECT SUM(valor_total_obtido) - SUM(valor_total_padrao) + SUM(qtd_itens) FROM dbo.pedidos"
        ),
        null
      );
    });

    it("nao barra faixa ampla menos a contida, com terceira parcela (guarda 3)", () => {
      assert.equal(
        check(
          "SELECT SUM(qtd_00a07_perda) - SUM(qtd_00a03_perda) + SUM(qtd_itens) FROM dbo.pedidos"
        ),
        null
      );
    });

    it("VP: meta e realizado do mesmo lado continuam barrados", () => {
      assert.ok(
        check(
          "SELECT SUM(valor_total_obtido) + SUM(valor_total_padrao) - SUM(qtd_itens) FROM dbo.pedidos"
        )
      );
    });

    it("VP: faixas que se contem do mesmo lado continuam barradas", () => {
      assert.ok(
        check(
          "SELECT SUM(qtd_00a07_perda) + SUM(qtd_00a03_perda) - SUM(qtd_itens) FROM dbo.pedidos"
        )
      );
    });
  });
});

// --- schema real ------------------------------------------------------------

/**
 * O sintetico prova o mecanismo; este bloco prova que ele sobrevive a nomes
 * que ninguem escolheu para o teste. As colunas sao DERIVADAS do schema real:
 * um nome escrito a mao aqui envelheceria em silencio.
 */
describe("as guardas funcionam sobre o schema real", () => {
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
      alternateDateColumns: [...f.alternateDateColumns],
      joinKey: f.joinKey,
      requiresJoinForPeriod: f.requiresJoinForPeriod,
      periodJoinTable: f.periodJoinTable,
      periodJoinColumns: [...f.periodJoinColumns],
      updatedAt: new Date()
    });
  }
  const realDict = buildDictionaryIndex(records);

  const realCheck = (sql: string) =>
    checkSemanticGuards(sql, FACTS, realDict, {
      dbType: "sqlserver",
      overlappingBuckets: VOCABULARY.overlappingBuckets
    });

  /** Primeira coluna do schema real cuja classe satisfaz o predicado. */
  const pick = (
    predicate: (cls: ColumnClass) => boolean
  ): { table: string; column: string } => {
    for (const t of REAL_SCHEMA) {
      for (const c of t.columns) {
        const cls = classifyColumn(c.name, c.type, VOCABULARY);
        if (predicate(cls)) return { table: t.tableFullName, column: c.name };
      }
    }
    throw new Error("nenhuma coluna do schema real satisfaz o predicado");
  };

  it("uma taxa real nao pode ser mediada", () => {
    const { table, column } = pick((c) => c.unit === "rate" && !c.cumulative);
    const err = realCheck(`SELECT AVG(${column}) FROM ${table}`);
    assert.ok(err, `AVG(${column}) em ${table} passou batido`);
    assert.equal(err!.category, "aggregation_error");
  });

  it("uma contagem real pode ser somada", () => {
    const { table, column } = pick(
      (c) => c.unit === "count" && !c.cumulative && c.nature === null && c.bucket === null
    );
    assert.equal(realCheck(`SELECT SUM(${column}) FROM ${table}`), null);
  });

  it("a data do evento de cada tabela datada passa no filtro de periodo", () => {
    // A contraprova da guarda 4: se ela acusasse a data CERTA, toda consulta
    // com recorte temporal morreria no primeiro retry.
    for (const facts of FACTS) {
      if (!facts.eventDateColumn) continue;
      const sql = `SELECT COUNT(*) FROM ${facts.tableFullName} WHERE ${facts.eventDateColumn} >= '2025-01-01'`;
      assert.equal(realCheck(sql), null, `${facts.tableFullName} barrou a propria data do evento`);
    }
  });

  it("a data alternativa e barrada e o aviso aponta a certa", () => {
    const facts = FACTS.find(
      (f) => f.eventDateColumn !== null && f.alternateDateColumns.length > 0
    );
    assert.ok(facts, "o schema real nao tem tabela com data alternativa");
    const wrong = facts!.alternateDateColumns[0]!;
    const err = realCheck(
      `SELECT COUNT(*) FROM ${facts!.tableFullName} WHERE ${wrong} >= '2025-01-01'`
    );
    assert.ok(err, `${wrong} passou como filtro de periodo`);
    assert.match(err!.hint, new RegExp(facts!.eventDateColumn!, "i"));
  });

  it("tabela sem data propria exige a juncao declarada", () => {
    const facts = FACTS.find((f) => f.requiresJoinForPeriod && f.periodJoinTable);
    assert.ok(facts, "o schema real nao tem tabela que exige juncao para periodo");
    const err = realCheck(
      `SELECT COUNT(*) FROM ${facts!.tableFullName} WHERE YEAR(dat_qualquer) = 2025`
    );
    assert.equal(err?.category, "join_error");
    assert.match(err!.hint, new RegExp(facts!.periodJoinTable!.replace(".", "\\."), "i"));
  });

  it("factsFromDictionary devolve o que o ingest gravou, sem reinferir", () => {
    const names = FACTS.map((f) => f.tableFullName);
    const roundTrip = factsFromDictionary(realDict, names);
    assert.equal(roundTrip.length, FACTS.length);
    for (const original of FACTS) {
      const read = roundTrip.find((f) => f.tableFullName === original.tableFullName);
      assert.ok(read, `${original.tableFullName} sumiu na leitura`);
      assert.deepEqual(read, original);
    }
  });

  it("tabela sem registro no dicionario simplesmente nao entra", () => {
    assert.deepEqual(factsFromDictionary(realDict, ["dbo.nao_existe"]), []);
  });
});
