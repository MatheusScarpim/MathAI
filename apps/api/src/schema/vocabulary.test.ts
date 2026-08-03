import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyColumn } from "./lexicon.js";
import { inferTableFacts, periodStatus, type SchemaTableInput } from "./tableFacts.js";
import {
  BUILTIN_PTBR_VOCABULARY,
  mergeVocabulary,
  resolveVocabulary
} from "./vocabulary.js";
import { loadBundledSeed } from "./seedFile.js";
import { REAL_SCHEMA } from "./realSchema.fixture.js";

/**
 * A ferramenta e vendida como generica: qualquer banco, qualquer cliente.
 * Ate agora ela nao era — o lexico tinha `eclosao`, `racao` e `ovosc`
 * escritos no codigo, e os fatos de tabela eram catorze registros de UM
 * cliente. Um segundo cliente receberia um motor que classifica o negocio do
 * primeiro.
 *
 * Esta suite e a prova de que a separacao e real e continua real. Ela nao
 * testa "a funcao roda": testa que o motor sozinho, sem seed nenhum, ja
 * classifica um schema PT-BR que nunca viu, e que nenhum termo do primeiro
 * cliente voltou a se infiltrar no codigo.
 */

// --- schema sinteticO de um dominio que nao e o do cliente -----------------

/**
 * Vendas e estoque. Nenhuma palavra deste schema aparece no seed de
 * avicultura, de proposito: o que classificar aqui tem de vir das convencoes
 * PT-BR embutidas, ou nao vem de lugar nenhum.
 */
const VENDAS: SchemaTableInput[] = [
  {
    fullName: "com.pedidos",
    columns: [
      { name: "cod_pedido", type: "int" },
      { name: "cod_cliente", type: "int" },
      { name: "dat_emissao", type: "date" },
      { name: "data_entrega", type: "datetime" },
      { name: "qtd_itens", type: "int" },
      { name: "valor_total", type: "numeric(18,2)" },
      { name: "pct_desconto", type: "numeric(5,2)" },
      { name: "situacao", type: "varchar(20)" }
    ]
  },
  {
    fullName: "com.itens_pedido",
    columns: [
      { name: "cod_pedido", type: "int" },
      { name: "cod_produto", type: "int" },
      { name: "dat_emissao", type: "date" },
      { name: "qtd_vendida", type: "int" },
      { name: "peso_liquido", type: "float" },
      { name: "meta_valor", type: "numeric(18,2)" },
      { name: "valor_acum", type: "numeric(18,2)" }
    ]
  },
  {
    fullName: "com.estoque_saldo",
    columns: [
      { name: "cod_pedido", type: "int" },
      { name: "cod_produto", type: "int" },
      { name: "saldo", type: "int" },
      { name: "qtd_consumo", type: "float" }
    ]
  }
];

const cls = (name: string, type: string) => classifyColumn(name, type);

describe("o motor sozinho classifica um schema PT-BR que nunca viu", () => {
  // Sem `vocabulary`, `classifyColumn` usa so as convencoes embutidas. Se
  // algum destes casos precisasse de seed, a ferramenta nao seria generica:
  // um cliente novo comecaria com classificacao zero.

  it("prefixo de contagem vale sem seed", () => {
    assert.deepEqual(
      [cls("qtd_itens", "int").role, cls("qtd_itens", "int").unit],
      ["metric", "count"]
    );
    assert.equal(cls("saldo", "int").unit, "count");
  });

  it("marca de percentual vale sem seed", () => {
    assert.equal(cls("pct_desconto", "numeric(5,2)").unit, "rate");
  });

  it("prefixo de data vale sem seed, e o tipo declarado tambem", () => {
    assert.equal(cls("dat_emissao", "date").role, "date");
    assert.equal(cls("data_entrega", "datetime").role, "date");
    // Tipo vence nome: coluna de data sem prefixo nenhum.
    assert.equal(cls("emissao", "datetime").role, "date");
  });

  it("prefixo de dimensao vence radical de metrica sem seed", () => {
    assert.equal(cls("cod_cliente", "int").role, "dimension");
    // `nro_perda` tem radical de taxa e ainda assim e identificador.
    assert.equal(cls("nro_perda", "int").role, "dimension");
  });

  it("peso em ponto flutuante vale sem seed", () => {
    assert.equal(cls("peso_liquido", "float").unit, "weight");
    // Contagem que na verdade e massa: `qtd_` + consumo + float.
    assert.equal(cls("qtd_consumo", "float").unit, "weight");
    // O mesmo nome em inteiro continua contagem.
    assert.equal(cls("qtd_consumo", "int").unit, "count");
  });

  it("meta e acumulado — as duas armadilhas mais caras — valem sem seed", () => {
    // Responder a meta como se fosse o realizado nao gera erro de SQL.
    assert.equal(cls("meta_valor", "numeric(18,2)").nature, "target");
    assert.equal(cls("valor_realizado", "numeric(18,2)").nature, "actual");
    // Somar acumulado entre linhas dupla-conta.
    assert.equal(cls("valor_acum", "numeric(18,2)").cumulative, true);
  });

  it("dimensao por substantivo generico vale sem seed", () => {
    const c = cls("situacao", "varchar(20)");
    assert.equal(c.role, "dimension");
    // `matched` e o que separa "o lexico reconheceu" de "caiu no fallback por
    // tipo". Sem ele a cobertura medida seria falsa.
    assert.equal(c.matched, true);
  });

  it("cobre a maioria do schema desconhecido sem uma linha de configuracao", () => {
    const all = VENDAS.flatMap((t) => t.columns);
    const matched = all.filter((col) => cls(col.name, col.type).matched);
    // Nao e "quase tudo" por acaso: e o retorno de embutir as convencoes em
    // vez de exigir seed para o primeiro ingest de qualquer cliente.
    assert.ok(
      matched.length / all.length >= 0.9,
      `so ${matched.length}/${all.length} classificadas sem seed`
    );
  });
});

describe("o motor sozinho nao inventa o que nao pode saber", () => {
  it("procedencia fica null sem regras de dominio", () => {
    // Nao ha como adivinhar onde uma medicao foi feita. `null` e a resposta
    // honesta; um rotulo chutado aqui trocaria um numero por outro.
    assert.equal(cls("qtd_vendida_gra", "int").source, null);
    assert.equal(cls("valor_total_inc", "numeric").source, null);
  });

  it("nao ha faixas que se contem sem dominio que as declare", () => {
    assert.deepEqual(BUILTIN_PTBR_VOCABULARY.overlappingBuckets, {});
    // O PADRAO da faixa, porem, e generico: dois numeros ligados por "a".
    assert.equal(cls("qtd_00a03_perda", "int").bucket, "00a03");
  });

  it("nao ha nota de dominio embutida", () => {
    assert.deepEqual(BUILTIN_PTBR_VOCABULARY.notes, []);
  });
});

describe("inferencia de fatos de tabela num schema sem seed", () => {
  const facts = inferTableFacts(VENDAS);
  const of = (name: string) => facts.find((f) => f.tableFullName === name)!;

  it("acha a chave de juncao sem keyNames declarados", () => {
    // Nenhuma coluna e `key` para o lexico embutido; o segundo nivel entra e
    // elege a coluna com prefixo de identificador mais espalhada.
    assert.equal(of("com.pedidos").joinKey, "cod_pedido");
  });

  it("uma data so na tabela = e o evento; varias = se recusa a escolher", () => {
    assert.equal(of("com.itens_pedido").eventDateColumn, "dat_emissao");
    // `com.pedidos` tem duas datas. Emissao e entrega respondem perguntas
    // diferentes e chutar uma devolve o conjunto errado com SQL perfeito.
    assert.equal(of("com.pedidos").eventDateColumn, null);
    assert.deepEqual(of("com.pedidos").alternateDateColumns, ["dat_emissao", "data_entrega"]);
  });

  it("tabela sem data exige juncao, e o ON leva o grao compartilhado", () => {
    const estoque = of("com.estoque_saldo");
    assert.equal(estoque.requiresJoinForPeriod, true);
    // So `cod_pedido` casaria todas as linhas do outro lado e multiplicaria o
    // resultado — inflar SUM e o modo de falha caro aqui.
    assert.deepEqual(estoque.periodJoinColumns, ["cod_pedido", "cod_produto"]);
    // Uma unica candidata datada com esse grao: nao ha ambiguidade a resolver.
    assert.equal(estoque.periodJoinTable, "com.itens_pedido");
    assert.equal(periodStatus(estoque), "requires-join");
  });

  it("varias datas nao e o mesmo que nenhuma data", () => {
    // `com.pedidos` tem duas datas: a informacao esta ALI, so falta escolher.
    // Marca-la como "precisa juntar" mandaria o E4 fabricar um JOIN inutil
    // para buscar fora o que a tabela ja tem.
    const pedidos = of("com.pedidos");
    assert.equal(pedidos.requiresJoinForPeriod, false);
    assert.equal(pedidos.periodJoinTable, null);
    assert.deepEqual(pedidos.periodJoinColumns, []);
    assert.equal(periodStatus(pedidos), "ambiguous");
    assert.equal(periodStatus(of("com.itens_pedido")), "ready");
  });

  it("dinheiro e metrica, e nao se confunde com contagem", () => {
    // Somar quantidade junto com valor num mesmo SUM e erro que nao gera erro.
    assert.equal(cls("valor_total", "numeric(18,2)").unit, "currency");
    assert.equal(cls("custo_unitario", "numeric(18,2)").unit, "currency");
    assert.equal(cls("qtd_itens", "int").unit, "count");
    // Participacao percentual do valor continua taxa, nao dinheiro.
    assert.equal(cls("pct_valor", "numeric(5,2)").unit, "rate");
  });

  it("grao em prosa nunca e inventado", () => {
    // Nenhuma heuristica produz "1 linha = pedido x produto". Sem curadoria a
    // resposta e null, e null e informacao: diz ao E4 que ninguem revisou.
    for (const f of facts) assert.equal(f.grain, null);
  });

  it("empate na chave devolve null em vez de chutar", () => {
    const empatado = inferTableFacts([
      {
        fullName: "x.a",
        columns: [
          { name: "cod_um", type: "int" },
          { name: "cod_dois", type: "int" }
        ]
      },
      {
        fullName: "x.b",
        columns: [
          { name: "cod_um", type: "int" },
          { name: "cod_dois", type: "int" }
        ]
      }
    ]);
    assert.equal(empatado[0]!.joinKey, null);
  });

  it("schema vazio nao explode", () => {
    assert.deepEqual(inferTableFacts([]), []);
  });
});

describe("mesclar vocabulario e ADITIVO — um seed nunca apaga convencao", () => {
  it("o seed acrescenta e o builtin permanece", () => {
    const merged = mergeVocabulary(BUILTIN_PTBR_VOCABULARY, { rateTerms: ["evasao"] });
    assert.ok(merged.rateTerms.includes("evasao"), "termo do seed entrou");
    assert.ok(merged.rateTerms.includes("perda"), "termo builtin sobreviveu");
  });

  it("nao ha como um seed remover um termo builtin", () => {
    // Se desse, um seed poderia apagar `padrao` da lista de metas e o motor
    // passaria a responder a meta da linhagem como se fosse o realizado.
    const merged = mergeVocabulary(BUILTIN_PTBR_VOCABULARY, { targetTerms: [] });
    assert.deepEqual(merged.targetTerms, BUILTIN_PTBR_VOCABULARY.targetTerms);
  });

  it("termo repetido no seed nao duplica", () => {
    const merged = mergeVocabulary(BUILTIN_PTBR_VOCABULARY, { rateTerms: ["perda", "perda"] });
    assert.equal(merged.rateTerms.filter((t) => t === "perda").length, 1);
  });

  it("sem seed o resultado e exatamente o builtin", () => {
    assert.deepEqual(resolveVocabulary(), BUILTIN_PTBR_VOCABULARY);
    assert.deepEqual(resolveVocabulary({}), BUILTIN_PTBR_VOCABULARY);
  });

  it("o seed do dominio nao vaza para quem nao o carregou", () => {
    // Duas chamadas, dois vocabularios, zero contaminacao. O cache compilado
    // e por objeto de vocabulario justamente para isto nao acontecer.
    const avicultura = resolveVocabulary(loadBundledSeed("avicultura").vocabulary);
    assert.equal(classifyColumn("pct_eclosao", "numeric", avicultura).unit, "rate");
    // Sem o seed, `eclosao` nao significa nada: sobra o fallback por tipo.
    const semSeed = classifyColumn("pct_eclosao_x", "numeric");
    assert.equal(semSeed.matched, true, "pct_ ainda casa, e generico");
    assert.equal(classifyColumn("eclosao_x", "numeric").matched, false);
  });
});

// --- a guarda que impede a regressao ---------------------------------------

/**
 * Remove comentarios para procurar termos so no CODIGO.
 *
 * A distincao importa: explicar POR QUE `eclosao` nao pode estar no motor
 * exige escrever `eclosao` no comentario. Proibir a palavra no arquivo
 * inteiro tornaria a documentacao impossivel e o teste seria contornado
 * apagando a explicacao — exatamente a parte que se quer preservar.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/**
 * Quebra em tokens por caractere nao-alfanumerico E por CamelCase.
 *
 * A versao anterior desta guarda casava `\b<termo>\b` dentro de string
 * literal. Duas falhas, as duas provadas por injecao: `_` e caractere de
 * palavra, entao `\b` nunca dispara entre `pct` e `eclosao`; e exigir aspas
 * antes deixava passar regex literal, identificador e nome de simbolo.
 * `ubi.cifsResumoEclosaoMortalidade` entrava inteiro no motor com a suite
 * verde.
 *
 * Comparar TOKEN por igualdade (nao substring) e o que separa `racao` de
 * `integracao`/`comparacao`/`configuracao`, que sao palavras legitimas do
 * motor e apareceriam em qualquer teste de substring.
 */
const tokenize = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const chunk of String(text).split(/[^A-Za-z0-9]+/)) {
    if (!chunk) continue;
    out.add(chunk.toLowerCase());
    const parts = chunk
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(" ");
    for (const p of parts) if (p) out.add(p.toLowerCase());
  }
  return out;
};

/**
 * Campos do seed que sao PROSA ou ESTRUTURA, nao identificador de banco.
 *
 * `grain` e frase em portugues ("1 linha = lote x semana"); varre-la traria
 * meia lingua para a lista de proibidos. `match` carrega `"token"`/`"suffix"`,
 * que sao valores do enum `SourceMatch` do proprio motor — estruturais, nao
 * do cliente.
 *
 * As metricas repetem os dois casos. `label` e `pitfalls` sao prosa ("nunca
 * some a coluna acumulada"), e varre-las proibiria o motor de escrever em
 * portugues. `kind`, `unit` e `provenance` sao enums declarados em
 * `metrics.ts` — `ratio`, `percent`, `inferred` sao palavras do motor que o
 * seed apenas SELECIONA, entao proibi-las seria o motor se auto-acusar.
 *
 * O que continua varrido nas metricas e o que de fato pertence ao cliente:
 * `id`, `synonyms`, `table`, `numerator`, `denominator`, `column`,
 * `precomputed` e `targetColumn`.
 */
const NON_IDENTIFIER_FIELDS = new Set([
  "name",
  "description",
  "notes",
  "grain",
  "match",
  "label",
  "pitfalls",
  "kind",
  "unit",
  "provenance"
]);

const seedIdentifierText = (node: unknown): string[] => {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(seedIdentifierText);
  if (node && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      NON_IDENTIFIER_FIELDS.has(k) ? [] : [k.includes(".") ? k : "", ...seedIdentifierText(v)]
    );
  }
  return [];
};

/**
 * Palavras do motor que colidem por acaso com token do cliente.
 *
 * `rec` vem de `dat_rec`/`hor_rec` e tambem e o nome de variavel de registro
 * em dois arquivos. `nao` vem de `qtd_ovos_nao_eclodidos` e e a negacao
 * portuguesa, que aparece em mensagem de erro do motor.
 *
 * Deve permanecer minuscula: e a unica valvula de escape da guarda, e o
 * teste abaixo trava o tamanho justamente para ela nao virar o lugar onde
 * se enfia o termo inconveniente. Diante de uma colisao nova, a saida
 * preferida e RENOMEAR o simbolo do motor; entrar aqui so quando a palavra
 * for portugues comum e nao houver nome melhor.
 */
const ENGINE_WORDS = new Set(["rec", "nao"]);

/**
 * Nomes de tabela e coluna do schema real do cliente.
 *
 * A fixture e a segunda fonte da lista de proibidos, e nao por conveniencia:
 * o seed declara VOCABULARIO (`eclosao`, `granja`), nao o schema. Um nome de
 * coluna como `dat_aloj_inicial` nunca aparece no seed, entao derivar so
 * dele deixava `aloj` — e outros 100+ radicais do cliente — fora da guarda.
 * A fixture e dado de teste e ja esta excluida da varredura, logo nao ha
 * auto-acusacao.
 */
const fixtureIdentifiers = (): string[] => {
  const out: string[] = [];
  for (const t of REAL_SCHEMA) {
    out.push(t.tableFullName);
    for (const c of t.columns) out.push(c.name);
  }
  return out;
};

/**
 * A lista de proibidos NAO e escrita a mao: sai do seed e do schema do
 * cliente, menos o vocabulario generico que o motor tem direito de conhecer.
 * Termo novo no seed ou coluna nova na fixture passa a ser protegido
 * sozinho, sem segunda edicao.
 */
const deriveForbiddenTokens = (): string[] => {
  const seed = loadBundledSeed("avicultura");
  const fromClient = tokenize(
    [...seedIdentifierText(seed), ...fixtureIdentifiers()].join(" ")
  );
  const generic = tokenize(JSON.stringify(BUILTIN_PTBR_VOCABULARY));
  return [...fromClient].filter(
    (t) =>
      t.length >= 3 &&
      !generic.has(t) &&
      !ENGINE_WORDS.has(t) &&
      !/^\d/.test(t) &&
      t !== "null" &&
      t !== "true" &&
      t !== "false"
  );
};

describe("nenhum termo de dominio voltou para o motor", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const FORBIDDEN = deriveForbiddenTokens();

  /**
   * Arquivos de motor que vivem fora de `schema/`.
   *
   * A varredura por diretorio nao alcanca `agents/`, e o diretorio inteiro nao
   * pode entrar: ali tambem moram prompts e adaptadores, que legitimamente
   * carregam texto do cliente. Entao a inclusao e nominal — quem consome o
   * `ColumnClass` para DECIDIR algo entra nesta lista, porque e exatamente ali
   * que um termo de dominio reapareceria chumbado.
   */
  const EXTERNAL_ENGINE_FILES = ["../agents/sqlGuards.ts", "../agents/sqlSemantics.ts"];

  const engineFiles = [
    ...readdirSync(dir).filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        // A fixture E o schema do cliente: e dado de teste, nao motor.
        !f.endsWith(".fixture.ts")
    ),
    ...EXTERNAL_ENGINE_FILES
  ];

  it("varre arquivos de verdade (guarda contra o glob vazio)", () => {
    // Um teste que nao le arquivo nenhum passa em silencio para sempre.
    assert.ok(engineFiles.length >= 6, `so ${engineFiles.length} arquivos varridos`);
    assert.ok(engineFiles.includes("lexicon.ts"));
    assert.ok(engineFiles.includes("tableFacts.ts"));
    assert.ok(engineFiles.includes("vocabulary.ts"));
    // Lista nominal: se o arquivo for renomeado sem atualizar a lista, o
    // `readFileSync` abaixo estoura em vez de deixar de varrer em silencio.
    for (const f of EXTERNAL_ENGINE_FILES) assert.ok(engineFiles.includes(f));
  });

  it("a lista de proibidos saiu mesmo do cliente e cobre o que importa", () => {
    // Se o derivador quebrar e devolver [], todo arquivo passa em silencio.
    assert.ok(FORBIDDEN.length >= 100, `so ${FORBIDDEN.length} termos derivados`);
    // Vindos do SEED (vocabulario de dominio).
    for (const t of ["eclosao", "eclo", "ovosc", "granja", "incub", "ubi", "cifs", "avfs"]) {
      assert.ok(FORBIDDEN.includes(t), `"${t}" sumiu da parte vinda do seed`);
    }
    // Vindos da FIXTURE (schema do cliente). Nenhum destes existe no seed —
    // se sumirem, a segunda fonte deixou de ser lida.
    for (const t of ["aloj", "ovoscopia", "nascedouros", "bicado"]) {
      assert.ok(FORBIDDEN.includes(t), `"${t}" sumiu da parte vinda da fixture`);
    }
  });

  it("a valvula de escape continua minuscula", () => {
    // ENGINE_WORDS e o unico jeito de liberar um termo. Se crescer, a guarda
    // vira decorativa por acumulo em vez de por bug.
    assert.ok(ENGINE_WORDS.size <= 3, `ENGINE_WORDS cresceu para ${ENGINE_WORDS.size}`);
  });

  it("a lista de campos nao-varridos continua curta", () => {
    // NON_IDENTIFIER_FIELDS e a segunda valvula: cada nome aqui e um campo do
    // seed que a guarda deixa de ler. Justificar campo a campo (prosa ou enum
    // do motor) e barato; o risco e alguem enfiar um campo de identificador
    // aqui para calar um teste vermelho. O limite forca essa conversa.
    assert.ok(
      NON_IDENTIFIER_FIELDS.size <= 12,
      `NON_IDENTIFIER_FIELDS cresceu para ${NON_IDENTIFIER_FIELDS.size} — ` +
        "campo novo aqui e campo do cliente que a guarda para de ver"
    );
  });

  for (const file of engineFiles) {
    it(`${file} nao tem vocabulario de dominio no codigo`, () => {
      const tokens = tokenize(stripComments(readFileSync(join(dir, file), "utf8")));
      const found = FORBIDDEN.filter((t) => tokens.has(t));
      assert.deepEqual(
        found,
        [],
        `${file}: ${found.join(", ")} — dominio pertence ao seed, nao ao motor`
      );
    });
  }

  it("o strip de comentario funciona (senao a guarda inteira e decorativa)", () => {
    assert.equal(stripComments("/* eclosao */ const x = 1;").includes("eclosao"), false);
    assert.equal(stripComments("  // eclosao\nconst x = 1;").includes("eclosao"), false);
    assert.equal(stripComments('const t = "eclosao";').includes("eclosao"), true);
  });

  it("pega as formas que a guarda antiga deixava passar", () => {
    // Cada uma destas foi injetada no motor por um verificador e a suite
    // ficou verde. Sao o motivo desta guarda ter sido reescrita.
    const deveriaPegar = [
      'const a = "pct_eclosao";',
      'const b = "cod_granja";',
      'const c = "qtd_ovos";',
      'const d = "dat_aloj_inicial";',
      'const e = "ovo_ave";',
      'const f = "ovo_inc_ave";',
      'const g = "pinto_ave";',
      'const h = "eclosao_pct";',
      'const i = "cod_lote_num";',
      'const j = "nro_lote";',
      'const k = "dat_incub";',
      'const l = "ubi.cifsResumoEclosaoMortalidade";',
      "const m = /eclo(sao)?/i;", // regex literal: sem aspas, invisivel antes
      "const cifsResumoNascimento = 1;" // identificador: idem
    ];
    for (const trecho of deveriaPegar) {
      const tokens = tokenize(stripComments(trecho));
      const found = FORBIDDEN.filter((t) => tokens.has(t));
      assert.ok(found.length > 0, `passou batido: ${trecho}`);
    }
  });

  it("nao dispara em palavra legitima do motor", () => {
    // Substring ingenuo acusaria `racao` dentro destas tres.
    for (const trecho of [
      "const integracao = 1;",
      "const comparacao = 2;",
      "const configuracao = 3;",
      "const recordCount = 4;",
      "const suffix = 5;"
    ]) {
      const tokens = tokenize(stripComments(trecho));
      assert.deepEqual(FORBIDDEN.filter((t) => tokens.has(t)), [], trecho);
    }
  });
});
