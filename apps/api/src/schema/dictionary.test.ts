import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MongoClient, type Collection } from "mongodb";
import {
  DEFAULT_ENV,
  buildDictionaryIndex,
  buildInferredOps,
  normalizeEnvId,
  type DictionaryRecord
} from "./dictionaryOps.js";

/**
 * O dicionario e o unico lugar onde a revisao humana das ~30 metricas de
 * negocio vive. O re-ingest roda toda vez que o schema muda; se ele
 * sobrescrever um doc `curated`, a curadoria some no primeiro reindex e
 * ninguem percebe ate a resposta sair errada de novo.
 *
 * A suite tem duas camadas. As asercoes de formato abaixo so tem valor porque
 * a protecao passou a ser estrutural (filtro = chave de identidade, update =
 * pipeline condicional); a versao anterior dependia do indice unico existir, o
 * que nenhum teste de formato conseguiria detectar. Por isso existe tambem o
 * teste de integracao no fim do arquivo, que escreve de verdade no Mongo COM O
 * INDICE AUSENTE — o cenario exato que expunha o bug.
 */

const cols = [
  { name: "pct_eclosao_obtida", type: "numeric" },
  { name: "qtd_ovos_acum", type: "int" }
];

describe("normalizeEnvId", () => {
  it("cai no ambiente default quando a request nao manda nada", () => {
    assert.equal(normalizeEnvId(undefined), DEFAULT_ENV);
    assert.equal(normalizeEnvId(""), DEFAULT_ENV);
    assert.equal(normalizeEnvId("   "), DEFAULT_ENV);
  });

  it("preserva um ambiente informado", () => {
    assert.equal(normalizeEnvId("prod"), "prod");
  });
});

describe("buildInferredOps — o re-ingest nao pode apagar curadoria", () => {
  const ops = buildInferredOps("ubi.cifsResumo_Nascimento", cols, "prod");
  const setStage = (op: (typeof ops)[number]) => op.updateOne.update[0].$set;

  it("o filtro e SO a chave de identidade", () => {
    // Esta e A asercao que mata o bug do duplicado. Qualquer clausula extra no
    // filtro (era `source: {$ne:"curated"}`) faz o upsert deixar de casar o
    // doc curado e inserir um segundo documento para a mesma coluna.
    for (const op of ops) {
      assert.deepEqual(Object.keys(op.updateOne.filter).sort(), [
        "columnName",
        "environmentId",
        "tableFullName"
      ]);
    }
  });

  it("todo campo mutavel e protegido por um $cond sobre source", () => {
    // Varre o pipeline em vez de checar campo a campo: se o E2 acrescentar
    // `grain`/`eventDateColumn` ao update sem proteger, este teste quebra.
    const guarded = (expr: unknown): boolean => {
      const cond = (expr as { $cond?: unknown[] })?.$cond;
      return (
        Array.isArray(cond) &&
        JSON.stringify(cond[0]) === JSON.stringify({ $eq: ["$source", "curated"] })
      );
    };
    for (const op of ops) {
      const set = setStage(op) as unknown as Record<string, unknown>;
      for (const [field, expr] of Object.entries(set)) {
        // `source` e o unico que nao usa $cond: preserva via $ifNull, que tem
        // o mesmo efeito (nunca rebaixa curated para inferred).
        if (field === "source") continue;
        assert.ok(guarded(expr), `campo ${field} escreve sem proteger curated`);
      }
    }
  });

  it("preserva o valor atual do doc quando ele e curated", () => {
    for (const op of ops) {
      const set = setStage(op);
      assert.equal(set.class.$cond[1], "$class");
      assert.equal(set.updatedAt.$cond[1], "$updatedAt");
    }
  });

  it("nunca rebaixa curated para inferred", () => {
    // `$ifNull` so grava "inferred" quando o campo nao existe, ou seja, na
    // insercao. Um `$set` literal aqui apagaria a curadoria.
    for (const op of ops) {
      assert.deepEqual(setStage(op).source, { $ifNull: ["$source", "inferred"] });
    }
  });

  it("a identidade do documento nao entra no update", () => {
    // Na insercao o Mongo deriva a chave das clausulas de igualdade do filtro;
    // reescreve-la a cada reindex seria trabalho perdido.
    for (const op of ops) {
      const set = setStage(op) as unknown as Record<string, unknown>;
      assert.equal("environmentId" in set, false);
      assert.equal("tableFullName" in set, false);
      assert.equal("columnName" in set, false);
    }
  });

  it("faz upsert para cobrir coluna nova sem apagar as existentes", () => {
    assert.equal(ops.length, cols.length);
    for (const op of ops) assert.equal(op.updateOne.upsert, true);
  });

  it("grava a classificacao vinda do lexico", () => {
    const eclosao = setStage(ops[0]!).class.$cond[2].$literal;
    assert.equal(eclosao.role, "metric");
    assert.equal(eclosao.unit, "rate");
    assert.equal(eclosao.nature, "actual");

    const acum = setStage(ops[1]!).class.$cond[2].$literal;
    assert.equal(acum.cumulative, true);
    assert.equal(acum.unit, "count");
  });

  it("envolve a classe em $literal para o driver nao avaliar como expressao", () => {
    for (const op of ops) {
      assert.ok("$literal" in setStage(op).class.$cond[2]);
    }
  });

  it("usa o ambiente default quando a request nao especifica", () => {
    const [op] = buildInferredOps("ubi.x", [cols[0]!]);
    assert.equal(op!.updateOne.filter.environmentId, DEFAULT_ENV);
  });

  it("carimba o mesmo updatedAt em todas as colunas da tabela", () => {
    // Um timestamp por tabela deixa "quando esta view foi reclassificada"
    // respondivel com uma leitura so.
    const stamps = new Set(
      ops.map((o) => setStage(o).updatedAt.$cond[2].$literal.getTime())
    );
    assert.equal(stamps.size, 1);
  });
});

describe("buildDictionaryIndex", () => {
  const now = new Date();
  const records: DictionaryRecord[] = [
    {
      environmentId: "prod",
      tableFullName: "ubi.cifsResumo_Nascimento",
      source: "inferred",
      grain: "lote x data de eclosao",
      eventDateColumn: "dat_eclosao",
      updatedAt: now
    },
    {
      environmentId: "prod",
      tableFullName: "ubi.cifsResumo_Nascimento",
      columnName: "pct_eclosao_obtida",
      source: "curated",
      description: "Eclosao realizada",
      updatedAt: now
    }
  ];
  const index = buildDictionaryIndex(records);

  it("separa registro de tabela de registro de coluna", () => {
    // O doc sem `columnName` e o de nivel-tabela (grao e coluna de data que o
    // E2 preenche); se vazasse para o indice de colunas, uma consulta por
    // coluna devolveria o grao da tabela.
    assert.equal(index.table("ubi.cifsResumo_Nascimento")?.eventDateColumn, "dat_eclosao");
    assert.equal(index.column("ubi.cifsResumo_Nascimento", "pct_eclosao_obtida")?.source, "curated");
  });

  it("resolve independente do caixa", () => {
    // O SQL gerado pelo modelo nao respeita o caixa do catalogo.
    assert.ok(index.column("UBI.CIFSRESUMO_NASCIMENTO", "PCT_ECLOSAO_OBTIDA"));
    assert.ok(index.table("UBI.CifsResumo_Nascimento"));
  });

  it("devolve undefined para o que nao existe, sem estourar", () => {
    assert.equal(index.column("ubi.inexistente", "x"), undefined);
    assert.equal(index.table("ubi.inexistente"), undefined);
  });

  it("expoe a lista completa para varredura", () => {
    assert.equal(index.all.length, 2);
  });
});

/**
 * Integracao real: as asercoes de formato acima nao teriam pego o bug
 * original, porque ele so aparecia no comportamento do upsert do Mongo. Este
 * bloco escreve de verdade e roda DE PROPOSITO SEM O INDICE UNICO — sem ele o
 * codigo antigo criava um segundo documento para a mesma coluna e a curadoria
 * sumia em silencio.
 *
 * Opt-in por env var para nao quebrar maquina sem Mongo:
 *   AURAIA_TEST_MONGO_URL=mongodb://localhost:27018 npm --workspace apps/api test
 *
 * Nao importa `dictionary.ts` de proposito: aquele modulo puxa `core/config`,
 * que encerra o processo sem JWT_SECRET. Aplica os ops direto na collection.
 */
const MONGO_URL = process.env.AURAIA_TEST_MONGO_URL;

describe("integracao Mongo — curadoria sobrevive ao re-ingest", { skip: !MONGO_URL }, () => {
  const TABLE = "ubi.cifsResumo_Nascimento";
  const CURATED_COL = "pct_eclosao_obtida";
  const REFRESHED_COL = "qtd_ovos_acum";
  const dbName = `auraia_test_dict_${process.pid}_${Date.now()}`;

  let client: MongoClient;
  let col: Collection<DictionaryRecord>;

  const ingest = async (columns = cols) => {
    const ops = buildInferredOps(TABLE, columns, "prod");
    const res = await col.bulkWrite(ops as never, { ordered: false });
    return res.upsertedCount + res.modifiedCount;
  };

  before(async () => {
    client = new MongoClient(MONGO_URL!, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db(dbName);
    // Cria explicitamente para o `listIndexes` abaixo ter namespace. Nenhum
    // indice e criado de proposito — ver o primeiro teste.
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

  it("primeiro ingest insere as colunas como inferred", async () => {
    const written = await ingest();
    assert.equal(written, cols.length);
    assert.equal(await col.countDocuments({}), cols.length);
    const docs = await col.find({}).toArray();
    for (const d of docs) assert.equal(d.source, "inferred");
  });

  it("re-ingest sobre doc curated nao duplica nem sobrescreve", async () => {
    const curatedClass = { role: "metric", unit: "rate", nature: "actual", curadoDeVerdade: true };
    const curatedAt = new Date("2020-01-01T00:00:00.000Z");
    await col.updateOne(
      { tableFullName: TABLE, columnName: CURATED_COL },
      { $set: { source: "curated", class: curatedClass as never, updatedAt: curatedAt } }
    );

    const before = await col.findOne({ tableFullName: TABLE, columnName: CURATED_COL });
    await ingest();

    // 1. Nenhum documento-sombra.
    assert.equal(await col.countDocuments({}), cols.length);
    assert.equal(await col.countDocuments({ tableFullName: TABLE, columnName: CURATED_COL }), 1);

    // 2. O doc curado saiu identico do outro lado.
    const after = await col.findOne({ tableFullName: TABLE, columnName: CURATED_COL });
    assert.equal(after!.source, "curated");
    assert.deepEqual(after!.class, before!.class);
    assert.equal(after!.updatedAt.getTime(), curatedAt.getTime());
  });

  it("doc inferred continua sendo atualizado pelo re-ingest", async () => {
    // O contraponto: se a protecao virasse "nao escreve nunca", o dicionario
    // congelaria e uma mudanca no lexico nunca chegaria ao banco.
    await col.updateOne(
      { tableFullName: TABLE, columnName: REFRESHED_COL },
      { $set: { updatedAt: new Date("2020-01-01T00:00:00.000Z") } }
    );
    await ingest();
    const doc = await col.findOne({ tableFullName: TABLE, columnName: REFRESHED_COL });
    assert.ok(doc!.updatedAt.getTime() > new Date("2021-01-01").getTime());
    assert.equal(doc!.class?.cumulative, true);
  });

  it("coluna nova entra sem tocar nas existentes", async () => {
    const written = await ingest([...cols, { name: "peso_eclosao", type: "float" }]);
    assert.ok(written > 0, "contagem devolvida nao pode ser zero (bug do driver v3)");
    assert.equal(await col.countDocuments({}), cols.length + 1);
    const nova = await col.findOne({ tableFullName: TABLE, columnName: "peso_eclosao" });
    assert.equal(nova!.class?.unit, "weight");
    assert.equal(
      (await col.findOne({ tableFullName: TABLE, columnName: CURATED_COL }))!.source,
      "curated"
    );
  });
});
