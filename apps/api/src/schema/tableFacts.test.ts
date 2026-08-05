import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MongoClient, type Collection } from "mongodb";
import { REAL_SCHEMA } from "./realSchema.fixture.js";
import {
  inferTableFacts,
  findTableFacts as findIn,
  type TableFacts
} from "./tableFacts.js";
import { loadBundledSeed } from "./seedFile.js";
import { BUILTIN_PTBR_VOCABULARY, resolveVocabulary } from "./vocabulary.js";
import { buildTableFactsOps, type DictionaryRecord } from "./dictionaryOps.js";

/**
 * Nenhum banco e alcancavel, entao `realSchema.fixture.ts` (as 791 colunas
 * reais) e a fonte da verdade. Estes testes existem para uma falha especifica:
 * apontar para uma coluna de data que NAO EXISTE. Isso nao explode no ingest —
 * o dicionario grava feliz — e so aparece como `ORA-00904`/`invalid column`
 * depois, dentro do loop de retry, ou pior, como filtro que nunca casa nada.
 *
 * Os fatos nao sao mais uma tabela escrita a mao: saem de `inferTableFacts`
 * sobre o schema real, com a curadoria do seed por cima. Por isso a maioria
 * das asercoes abaixo mudou de "o que escrevemos bate com o schema" para "o
 * que o motor derivou bate com o schema" — que e a versao forte da mesma
 * pergunta, porque agora nem a curadoria pode divergir sem o teste ver.
 */

type Col = { name: string; type: string };

const SEED = loadBundledSeed("avicultura");
const VOCABULARY = resolveVocabulary(SEED.vocabulary);

const asInput = REAL_SCHEMA.map((t) => ({ fullName: t.tableFullName, columns: t.columns }));

/** Fatos com curadoria — o que o ingest realmente grava. */
const TABLE_FACTS: TableFacts[] = inferTableFacts(asInput, VOCABULARY, SEED.tableFacts);
/** Fatos so com inferencia, para provar o que o motor sabe sem seed nenhum. */
const INFERRED_ONLY: TableFacts[] = inferTableFacts(asInput, VOCABULARY);

const findTableFacts = (name: string): TableFacts | undefined => findIn(TABLE_FACTS, name);
const JOIN_KEY = TABLE_FACTS[0]!.joinKey!;

const fixture = new Map<string, Col[]>(
  REAL_SCHEMA.map((t) => [t.tableFullName.toLowerCase(), t.columns as Col[]])
);

const colOf = (table: string, column: string): Col | undefined =>
  fixture.get(table.toLowerCase())?.find((c) => c.name.toLowerCase() === column.toLowerCase());

const isDateType = (type: string): boolean => /date|time/i.test(type);

describe("TABLE_FACTS cobre exatamente as tabelas do schema", () => {
  it("nenhuma tabela faltando e nenhum nome inventado", () => {
    // Nome de tabela aqui e facil de errar: a fonte tem
    // `avfsAproveitamento_OvoGranja_Inccubatorio` com dois "c" mesmo. Um
    // typo faz o registro nunca casar e o grao sumir sem erro nenhum.
    const declared = TABLE_FACTS.map((t) => t.tableFullName.toLowerCase()).sort();
    const real = REAL_SCHEMA.map((t) => t.tableFullName.toLowerCase()).sort();
    assert.deepEqual(declared, real);
  });

  it("nao ha tabela declarada duas vezes", () => {
    const seen = new Set(TABLE_FACTS.map((t) => t.tableFullName.toLowerCase()));
    assert.equal(seen.size, TABLE_FACTS.length);
  });
});

describe("toda coluna de data declarada existe e e mesmo data", () => {
  for (const facts of TABLE_FACTS) {
    it(`${facts.tableFullName}: eventDateColumn`, () => {
      if (facts.eventDateColumn === null) {
        // Sem data do evento so e legitimo se houver juncao declarada.
        assert.equal(
          facts.requiresJoinForPeriod,
          true,
          "tabela sem eventDateColumn precisa de requiresJoinForPeriod"
        );
        return;
      }
      const col = colOf(facts.tableFullName, facts.eventDateColumn);
      assert.ok(col, `${facts.eventDateColumn} nao existe em ${facts.tableFullName}`);
      assert.ok(
        isDateType(col!.type),
        `${facts.eventDateColumn} e ${col!.type}, nao serve de filtro de periodo`
      );
    });

    it(`${facts.tableFullName}: alternateDateColumns`, () => {
      for (const name of facts.alternateDateColumns) {
        const col = colOf(facts.tableFullName, name);
        assert.ok(col, `${name} nao existe em ${facts.tableFullName}`);
        assert.ok(isDateType(col!.type), `${name} e ${col!.type}, nao e data`);
      }
    });

    it(`${facts.tableFullName}: a data do evento nao se repete nas alternativas`, () => {
      assert.equal(
        facts.alternateDateColumns.some(
          (c) => c.toLowerCase() === (facts.eventDateColumn ?? "").toLowerCase()
        ),
        false
      );
    });
  }
});

describe("as juncoes de periodo resolvem de verdade", () => {
  for (const facts of TABLE_FACTS.filter((t) => t.requiresJoinForPeriod)) {
    it(`${facts.tableFullName}: destino datado e chave presente dos dois lados`, () => {
      assert.ok(facts.joinKey, "requiresJoinForPeriod sem joinKey");
      assert.ok(facts.periodJoinTable, "requiresJoinForPeriod sem periodJoinTable");

      const target = findTableFacts(facts.periodJoinTable!);
      assert.ok(target, `${facts.periodJoinTable} nao existe`);
      // Sem isto a juncao poderia cair em outra tabela sem data e nao
      // resolver nada — o erro seria invisivel.
      assert.ok(
        target!.eventDateColumn,
        `${facts.periodJoinTable} tambem nao tem data: a juncao nao resolve periodo`
      );
      assert.equal(target!.requiresJoinForPeriod, false, "juncao encadeada nao e suportada");

      assert.ok(facts.periodJoinColumns.length > 0, "ON vazio");
      for (const key of facts.periodJoinColumns) {
        assert.ok(colOf(facts.tableFullName, key), `${key} nao existe na origem`);
        assert.ok(colOf(facts.periodJoinTable!, key), `${key} nao existe no destino`);
      }
      // Nao e `!`: uma tabela que EXIGE juncao e chegou aqui sem joinKey nao
      // tem por onde casar as linhas, e o ON sairia arbitrario. Isso e falha
      // do fato, nao ruido do tipo — entao vira asserção com mensagem.
      const { joinKey } = facts;
      assert.ok(joinKey, `${facts.tableFullName} exige juncao mas nao tem joinKey`);
      assert.ok(
        facts.periodJoinColumns.some((k) => k.toLowerCase() === joinKey.toLowerCase()),
        "o ON precisa conter a joinKey"
      );
    });
  }

  it("tabela com data propria nao declara juncao", () => {
    for (const facts of TABLE_FACTS.filter((t) => t.eventDateColumn !== null)) {
      assert.equal(facts.requiresJoinForPeriod, false, facts.tableFullName);
      assert.equal(facts.periodJoinTable, null, facts.tableFullName);
    }
  });

  it("as 3 tabelas sem data nenhuma sao exatamente as que exigem juncao semanal", () => {
    // Se uma tabela ganhar coluna de data no futuro, este teste avisa que o
    // registro ficou desatualizado em vez de deixar a juncao inutil no ar.
    const semData = REAL_SCHEMA.filter(
      (t) => !(t.columns as Col[]).some((c) => isDateType(c.type))
    ).map((t) => t.tableFullName);
    assert.deepEqual(semData.slice().sort(), [
      "ubi.avfsConsumo_Racao_Semana",
      "ubi.avfsNutrientes_Racao",
      "ubi.avfsProducao_Ovos_Semana"
    ]);
    for (const name of semData) {
      const f = findTableFacts(name)!;
      assert.equal(f.eventDateColumn, null);
      // Grao semanal: juntar so por lote casaria todas as semanas e inflaria
      // qualquer SUM. O ON tem que levar `idade` junto.
      assert.deepEqual(f.periodJoinColumns, [JOIN_KEY, "idade"]);
    }
  });
});

describe("fatos validos em todo o schema", () => {
  it("cod_lote_num existe nas 14 views", () => {
    for (const t of REAL_SCHEMA) {
      assert.ok(colOf(t.tableFullName, JOIN_KEY), `${t.tableFullName} sem ${JOIN_KEY}`);
    }
  });

  it("toda tabela declara joinKey = cod_lote_num", () => {
    for (const f of TABLE_FACTS) {
      assert.equal(f.joinKey, JOIN_KEY, f.tableFullName);
    }
  });

  it("todo grao declara o que E uma linha, na forma que o E4 injeta", () => {
    // `length > 10` passava com qualquer frase. O grao vai literalmente para
    // o prompt para o modelo decidir se pode somar sem duplicar linha, entao
    // o que importa nao e o tamanho: e declarar a cardinalidade.
    for (const f of TABLE_FACTS) {
      const grain = f.grain;
      assert.ok(grain, `${f.tableFullName} sem grao`);
      assert.match(grain, /^1 linha = \S/, `${f.tableFullName}: "${grain}"`);
      const corpo = grain.replace(/^1 linha = /, "").trim();
      assert.ok(corpo.length >= 8, `${f.tableFullName}: corpo do grao vago ("${corpo}")`);
    }
  });

  it("grao semanal e juncao por idade contam a mesma historia", () => {
    // Cruza prosa com estrutura: se o ON leva `idade`, a linha e por semana,
    // e o grao TEM de dizer isso. Divergir aqui significa que o prompt
    // descreve uma tabela e o SQL junta outra.
    for (const f of TABLE_FACTS) {
      if (!f.periodJoinColumns.includes("idade")) continue;
      assert.match(
        f.grain ?? "",
        /semana/,
        `${f.tableFullName} junta por idade mas o grao nao menciona semana: "${f.grain}"`
      );
    }
  });

  it("cifsResumoEclosaoMortalidade nao aceita dat_aloj_inicial como evento (curado)", () => {
    // Esta e a armadilha concreta: lote alojado em 2023 eclode em 2024.
    // Se alguem "consertar" isto promovendo a alternativa a evento, o filtro
    // de periodo volta a devolver o conjunto errado com SQL perfeito.
    const f = findTableFacts("ubi.cifsResumoEclosaoMortalidade")!;
    assert.equal(f.eventDateColumn, null);
    assert.deepEqual(f.alternateDateColumns, ["dat_aloj_inicial"]);
    assert.equal(f.periodJoinTable, "ubi.cifsResumo_Nascimento");
    assert.equal(findTableFacts(f.periodJoinTable!)!.eventDateColumn, "dat_retirada");
  });

  it("cifsPerdaPesoIncub usa dat_transf, nao dat_transferencia", () => {
    // As duas views abreviam diferente. Copiar o nome da vizinha quebra.
    const f = findTableFacts("ubi.cifsPerdaPesoIncub")!;
    assert.ok(f.alternateDateColumns.includes("dat_transf"));
    assert.equal(colOf("ubi.cifsPerdaPesoIncub", "dat_transferencia"), undefined);
    assert.ok(colOf("ubi.cifsPerdas_Transferencia", "dat_transferencia"));
  });
});

describe("buildTableFactsOps — a curadoria do grao tambem e intocavel", () => {
  const ops = buildTableFactsOps(TABLE_FACTS, "prod");

  it("um op por tabela", () => {
    assert.equal(ops.length, TABLE_FACTS.length);
  });

  it("o filtro e so a chave de identidade, sem clausula sobre source", () => {
    for (const op of ops) {
      assert.deepEqual(Object.keys(op.updateOne.filter).sort(), [
        "columnName",
        "environmentId",
        "tableFullName"
      ]);
      // `$exists:false` isola o doc de nivel-tabela dos ~180 docs de coluna
      // da mesma tabela. Sem ele o update sobrescreveria uma coluna.
      assert.deepEqual(op.updateOne.filter.columnName, { $exists: false });
    }
  });

  it("todo campo mutavel e protegido por $cond sobre source", () => {
    const guarded = (expr: unknown): boolean => {
      const cond = (expr as { $cond?: unknown[] })?.$cond;
      return (
        Array.isArray(cond) &&
        JSON.stringify(cond[0]) === JSON.stringify({ $eq: ["$source", "curated"] })
      );
    };
    for (const op of ops) {
      const set = op.updateOne.update[0].$set as unknown as Record<string, unknown>;
      const fields = Object.keys(set);
      // Se alguem acrescentar campo ao update sem proteger, quebra aqui.
      assert.ok(fields.includes("grain") && fields.includes("eventDateColumn"));
      for (const [field, expr] of Object.entries(set)) {
        if (field === "source") continue;
        assert.ok(guarded(expr), `campo ${field} escreve sem proteger curated`);
      }
    }
  });

  it("o branch preservado le o proprio campo, nao outro", () => {
    // Um copy-paste que deixasse `"$grain"` em eventDateColumn preservaria o
    // valor errado — passaria no teste acima e corromperia a curadoria.
    for (const op of ops) {
      const set = op.updateOne.update[0].$set as unknown as Record<
        string,
        { $cond?: [unknown, string, unknown] }
      >;
      for (const [field, expr] of Object.entries(set)) {
        if (field === "source") continue;
        assert.equal(expr.$cond![1], `$${field}`, `${field} preserva o campo errado`);
      }
    }
  });
});

/**
 * Integracao real, opt-in:
 *   AURAIA_TEST_MONGO_URL=mongodb://localhost:27018 npm --workspace apps/api test
 *
 * Roda de proposito COM O INDICE UNICO AUSENTE — mesmo cenario do E1.
 */
const MONGO_URL = process.env.AURAIA_TEST_MONGO_URL;

describe("integracao Mongo — grao curado sobrevive ao re-ingest", { skip: !MONGO_URL }, () => {
  const TABLE = "ubi.cifsResumoEclosaoMortalidade";
  const dbName = `auraia_test_facts_${process.pid}_${Date.now()}`;

  let client: MongoClient;
  let col: Collection<DictionaryRecord>;

  const ingest = async () => {
    const res = await col.bulkWrite(buildTableFactsOps(TABLE_FACTS, "prod") as never, {
      ordered: false
    });
    return res.upsertedCount + res.modifiedCount;
  };

  before(async () => {
    client = new MongoClient(MONGO_URL!, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db(dbName);
    await db.createCollection("schema_dictionary");
    col = db.collection<DictionaryRecord>("schema_dictionary");
  });

  after(async () => {
    await client.db(dbName).dropDatabase();
    await client.close();
  });

  it("nao existe indice unico — e o cenario que expunha o bug", async () => {
    const idx = await col.listIndexes().toArray();
    assert.equal(
      idx.some((i) => i.unique === true),
      false,
      "o teste perde o sentido se o indice estiver protegendo o write"
    );
  });

  it("primeiro ingest grava as 14 tabelas como inferred", async () => {
    const written = await ingest();
    assert.equal(written, TABLE_FACTS.length, "contagem devolvida nao bate com o gravado");
    assert.equal(await col.countDocuments({}), TABLE_FACTS.length);
    assert.equal(await col.countDocuments({ source: "inferred" }), TABLE_FACTS.length);

    const rec = await col.findOne({ tableFullName: TABLE });
    assert.equal(rec!.eventDateColumn, null);
    assert.equal(rec!.periodJoinTable, "ubi.cifsResumo_Nascimento");
    assert.equal(rec!.columnName, undefined, "doc de tabela nao pode nascer com columnName");
  });

  it("o doc de tabela nao colide com os docs de coluna da mesma tabela", async () => {
    await col.insertOne({
      environmentId: "prod",
      tableFullName: TABLE,
      columnName: "dat_aloj_inicial",
      source: "inferred",
      updatedAt: new Date()
    } as DictionaryRecord);

    await ingest();

    const colDoc = await col.findOne({ tableFullName: TABLE, columnName: "dat_aloj_inicial" });
    assert.ok(colDoc, "o upsert de tabela apagou o doc de coluna");
    assert.equal(colDoc!.grain, undefined, "o upsert de tabela vazou para o doc de coluna");
    await col.deleteOne({ tableFullName: TABLE, columnName: "dat_aloj_inicial" });
  });

  it("re-ingest sobre um doc curado nao duplica nem sobrescreve", async () => {
    const curatedAt = new Date("2020-01-01T00:00:00.000Z");
    await col.updateOne(
      { tableFullName: TABLE, columnName: { $exists: false } },
      {
        $set: {
          source: "curated",
          grain: "GRAO REVISADO A MAO",
          eventDateColumn: "dat_aloj_inicial",
          updatedAt: curatedAt,
          description: "campo que o pipeline nunca escreve"
        }
      }
    );

    await ingest();
    await ingest();

    assert.equal(await col.countDocuments({ tableFullName: TABLE }), 1, "criou duplicata");
    const rec = await col.findOne({ tableFullName: TABLE });
    assert.equal(rec!.source, "curated");
    assert.equal(rec!.grain, "GRAO REVISADO A MAO");
    assert.equal(rec!.eventDateColumn, "dat_aloj_inicial");
    assert.equal(rec!.updatedAt.getTime(), curatedAt.getTime());
    assert.equal(
      (rec as unknown as { description?: string }).description,
      "campo que o pipeline nunca escreve"
    );
  });

  it("doc nao curado continua sendo atualizado pelo re-ingest", async () => {
    const other = "ubi.cifsResumo_Nascimento";
    await col.updateOne(
      { tableFullName: other, columnName: { $exists: false } },
      { $set: { grain: "obsoleto", updatedAt: new Date(0) } }
    );

    await ingest();

    const rec = await col.findOne({ tableFullName: other });
    assert.equal(rec!.source, "inferred");
    assert.equal(rec!.grain, findTableFacts(other)!.grain);
    assert.ok(rec!.updatedAt.getTime() > 0, "updatedAt nao foi refrescado");
  });
});

/**
 * O que o motor sabe SEM seed nenhum.
 *
 * `INFERRED_ONLY` existia calculado e nao era afirmado por nenhum teste — o
 * bloco abaixo e a divisao de trabalho que ele deveria provar: onde a
 * inferencia generica basta, onde a curadoria e obrigatoria, e — o mais
 * importante — o limite do que a curadoria tem permissao de mudar.
 */
describe("motor generico vs. curadoria", () => {
  const inferredOf = (name: string): TableFacts =>
    findIn(INFERRED_ONLY, name) ?? assert.fail(`${name} ausente em INFERRED_ONLY`);

  /** Evento + alternativas, normalizado — o conjunto de datas que a tabela declara. */
  const datasDe = (f: TableFacts): string[] =>
    [...new Set([...f.alternateDateColumns, ...(f.eventDateColumn ? [f.eventDateColumn] : [])])]
      .map((d) => d.toLowerCase())
      .sort();

  it("a chave de juncao sai da inferencia nas 14 views, sem seed", () => {
    // Se isto quebrar, o motor deixou de resolver juncao sozinho e todo
    // cliente novo passa a precisar de curadoria so para nao dar erro.
    for (const f of INFERRED_ONLY) {
      assert.equal(f.joinKey, JOIN_KEY, `${f.tableFullName} sem joinKey inferida`);
    }
    assert.equal(INFERRED_ONLY.length, REAL_SCHEMA.length);
  });

  it("prosa de grao nunca e inventada pela inferencia", () => {
    // Grao e a unica coisa que o motor NAO pode adivinhar: descreve o que uma
    // linha significa no negocio. Inventar aqui e pior que omitir, porque o
    // E4 injeta no prompt como se fosse fato verificado.
    for (const f of INFERRED_ONLY) {
      assert.equal(f.grain, null, `${f.tableFullName} inventou grao: "${f.grain}"`);
    }
    assert.ok(
      TABLE_FACTS.every((f) => f.grain),
      "com seed, as 14 tem grao"
    );
  });

  it("a curadoria so aumenta a cobertura de data do evento", () => {
    const comData = (l: readonly TableFacts[]): number =>
      l.filter((f) => f.eventDateColumn !== null).length;
    assert.equal(comData(INFERRED_ONLY), 4, "cobertura inferida mudou");
    assert.equal(comData(TABLE_FACTS), 10, "cobertura curada mudou");
  });

  it("a unica data que a curadoria RETIRA e a armadilha do alojamento", () => {
    // Retirar data e o movimento perigoso: deixa a tabela sem filtro proprio.
    // So se justifica quando a data inferida responde outra pergunta — aqui,
    // alojamento (2023) em vez de eclosao (2024). Qualquer nova retirada tem
    // de passar por este teste e ser explicada.
    const retiradas = TABLE_FACTS.filter(
      (f) => f.eventDateColumn === null && inferredOf(f.tableFullName).eventDateColumn !== null
    ).map((f) => f.tableFullName);
    assert.deepEqual(retiradas, ["ubi.cifsResumoEclosaoMortalidade"]);
    assert.equal(
      inferredOf("ubi.cifsResumoEclosaoMortalidade").eventDateColumn,
      "dat_aloj_inicial"
    );
  });

  it("a curadoria reparticiona as datas, nunca inventa uma", () => {
    // Invariante forte: para cada tabela, {evento} U {alternativas} e o MESMO
    // conjunto com e sem seed. A curadoria so decide qual das datas reais e o
    // evento — nao pode introduzir um nome que o catalogo nao tem, que e
    // exatamente como um typo viraria SQL que nao compila em producao.
    for (const curado of TABLE_FACTS) {
      assert.deepEqual(
        datasDe(curado),
        datasDe(inferredOf(curado.tableFullName)),
        `${curado.tableFullName}: a curadoria mexeu no conjunto de datas`
      );
    }
  });

  it("toda data curada existe mesmo no catalogo e e do tipo data", () => {
    // Fecha o laco do invariante acima contra a fixture real.
    for (const f of TABLE_FACTS) {
      for (const nome of datasDe(f)) {
        const col = colOf(f.tableFullName, nome);
        assert.ok(col, `${f.tableFullName}.${nome} nao existe`);
        assert.ok(isDateType(col!.type), `${f.tableFullName}.${nome} e ${col!.type}`);
      }
    }
  });
});

/**
 * `dimensionPrefixes` nao e lista de exibicao.
 *
 * Este bloco existe por um erro cometido: para fazer `codigo_cliente` deixar de
 * sair com separador de milhar na tabela do chat, `codigo` foi acrescentado a
 * `dimensionPrefixes` — que parecia o lugar dos prefixos de identificador. So
 * que esse campo alimenta `inferJoinKey`, e um prefixo a mais muda a CHAVE DE
 * JUNCAO que o prompt recebe. Consertar alinhamento de coluna nao pode custar
 * isso, e a correcao foi mover o julgamento de exibicao para
 * `identifierPrefixes`, lido so por `columnFormat.ts`.
 *
 * A suite passou antes e depois daquela mudanca: o vazamento nao tinha teste
 * nenhum. Os testes acima nao pegam porque a fixture real nunca chega no
 * segundo nivel de `inferJoinKey` — o seed de avicultura declara `keyNames`, e
 * mesmo sem seed existe uma coluna literalmente chamada `chave`, entao o nivel
 * declarado sempre vence e o ramo por prefixo fica inalcancavel.
 *
 * Por isso o schema abaixo e sintetico: e o cenario que o segundo nivel existe
 * para atender — banco novo, sem seed, sem nenhuma chave nomeada — que e
 * justamente onde o dano acontece sem ninguem ver.
 */
describe("inferJoinKey: prefixo de exibicao nao entra na juncao", () => {
  /** Banco novo: nenhuma coluna casa `keyNames`, entao decide o prefixo. */
  const NOVO_SCHEMA = ["f_venda", "f_estoque", "d_produto"].map((fullName) => ({
    fullName,
    columns: [
      // A chave real do schema.
      { name: "cod_lote", type: "varchar" },
      // Identificador que NAO e chave de juncao — e o codigo de barras do item.
      // Aparece nas mesmas 3 tabelas, entao empata se for deixado concorrer.
      { name: "codigo_barras", type: "varchar" },
      { name: "dat_mov", type: "date" },
      { name: "qtd_itens", type: "int" }
    ]
  }));

  const joinKeysCom = (dimensionPrefixes: readonly string[]): (string | null)[] => [
    ...new Set(
      inferTableFacts(NOVO_SCHEMA, { ...BUILTIN_PTBR_VOCABULARY, dimensionPrefixes }).map(
        (f) => f.joinKey
      )
    )
  ];

  /** Prefixos que existem SO para exibicao — os que nao podem vazar. */
  const soExibicao = BUILTIN_PTBR_VOCABULARY.identifierPrefixes.filter(
    (p) => !BUILTIN_PTBR_VOCABULARY.dimensionPrefixes.includes(p)
  );

  it("a fixture real nao exercita o ramo por prefixo — daqui o schema sintetico", () => {
    // Guarda da guarda: documenta POR QUE este bloco nao usa `REAL_SCHEMA`. Se
    // um dia a fixture perder a coluna `chave`, este asserto cai e avisa que os
    // testes de cima passaram a cobrir o ramo — em vez de deixar a duplicacao
    // silenciosa aqui.
    const temChaveNomeada = REAL_SCHEMA.some((t) =>
      (t.columns as Col[]).some((c) =>
        BUILTIN_PTBR_VOCABULARY.keyNames.includes(c.name.toLowerCase())
      )
    );
    assert.equal(temChaveNomeada, true, "a fixture real perdeu a chave nomeada");
  });

  it("o motor acha a chave sozinho, sem seed", () => {
    assert.deepEqual(joinKeysCom(BUILTIN_PTBR_VOCABULARY.dimensionPrefixes), ["cod_lote"]);
  });

  it("`identifierPrefixes` tem termo que `dimensionPrefixes` nao tem", () => {
    // Se alguem fundir os dois campos, o teste seguinte viraria tautologia
    // (mutacao vazia). Esta asercao e o que impede o guard de morrer calado.
    assert.ok(
      soExibicao.length > 0,
      "identifierPrefixes virou subconjunto de dimensionPrefixes: o teste abaixo nao prova mais nada"
    );
  });

  it("deixar o prefixo de exibicao concorrer destroi a chave inferida", () => {
    // O dano concreto: `codigo_barras` passa a casar o filtro de prefixo,
    // empata 3 a 3 com `cod_lote` e `inferJoinKey` devolve `null` — por
    // desenho, porque empate e chute. Sem chave, `requiresJoinForPeriod` nao
    // tem ON e a tabela sem data propria perde o filtro de periodo.
    const vazado = joinKeysCom([...BUILTIN_PTBR_VOCABULARY.dimensionPrefixes, ...soExibicao]);
    assert.deepEqual(
      vazado,
      [null],
      `esperado perder a chave com ${JSON.stringify(soExibicao)} em dimensionPrefixes`
    );
  });
});
