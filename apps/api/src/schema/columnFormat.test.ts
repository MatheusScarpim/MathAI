import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ResultColumnMeta } from "@auraia/shared";
import {
  formatFromClass,
  isColumnFormatKind,
  isNumericKind,
  resolveColumnFormats,
  resolveColumnFormatsFromNames
} from "./columnFormat.js";
import { classifyColumn } from "./lexicon.js";

/**
 * A matriz inteira roda sem banco e sem ambiente, porque `resolveColumnFormats`
 * e puro. O que se testa aqui e a TRADUCAO de classificacao estrutural para
 * decisao de apresentacao — nao o lexico, que tem suite propria.
 *
 * Os nomes de coluna sao reais (`pct_eclo_obtido`, `peso_final`,
 * `qtd_00a03_mort` saem do schema do cliente), porque mascara derivada de nome
 * inventado nao prova nada sobre o banco que a aplicacao atende.
 */

const col = (name: string, type = "", scale?: number | null): ResultColumnMeta =>
  scale === undefined ? { name, type } : { name, type, scale };

const kindOf = (name: string, type = "", scale?: number | null) =>
  resolveColumnFormats([col(name, type, scale)])[name];

describe("resolveColumnFormats: chave e dimensao nunca viram numero", () => {
  it("dimensao com prefixo `cod` sai como texto mesmo sendo int", () => {
    assert.deepEqual(kindOf("cod_granja", "int"), { kind: "text" });
  });

  it("`chave` e chave de juncao, nao medicao", () => {
    assert.deepEqual(kindOf("chave", "bigint"), { kind: "text" });
  });

  // Este e o bug visivel que o modulo existe para consertar, e ele sobreviveu a
  // primeira versao: `classifyColumn` so devolve `role: "key"` para os nomes
  // EXATOS de `keyNames` (`["chave"]` no builtin), entao toda chave surrogate
  // real caia no fallback por tipo e saia "1.234" ou "1.234,00".
  for (const name of [
    "sk_produto",
    "SK_PRODUTO",
    "sk_cliente",
    "nk_produto",
    "fk_granja",
    "pk_lote",
    "id_produto",
    "produto_id",
    "codigo_cliente"
  ]) {
    it(`chave surrogate \`${name}\` sai como texto, nunca numero`, () => {
      assert.deepEqual(kindOf(name, "number"), { kind: "text" });
      assert.deepEqual(kindOf(name, "int"), { kind: "text" });
    });
  }

  it("chave nao volta a numero pelo fallback por valor", () => {
    // A chave chega com `matched: false` e o dado real dela E numero — sem
    // guarda o fallback por amostra desfazia a correcao acima.
    const out = resolveColumnFormats([col("SK_PRODUTO"), col("id_lote")], {
      samples: [{ SK_PRODUTO: 1234, id_lote: 99 }]
    });
    assert.deepEqual(out.SK_PRODUTO, { kind: "text" });
    assert.deepEqual(out.id_lote, { kind: "text" });
  });

  it("token de chave casa por limite, nunca por substring", () => {
    // `idade` contem "id" e e dimensao declarada; `qtd_ovos` contem "sk"? nao —
    // o ponto e que nenhuma metrica legitima perde a mascara para a heuristica.
    assert.deepEqual(kindOf("idade", "int"), { kind: "text" }); // dimensao, via lexico
    assert.deepEqual(kindOf("qtd_ovos", "int"), { kind: "integer", decimals: 0 });
    assert.deepEqual(kindOf("vlr_total", "number"), { kind: "currency", decimals: 2 });
    assert.deepEqual(kindOf("peso_medio", "number"), { kind: "decimal", decimals: 2 });
  });

  it("dimensao textual continua texto", () => {
    assert.deepEqual(kindOf("nom_produto", "varchar"), { kind: "text" });
  });
});

describe("resolveColumnFormats: data respeita o tipo declarado", () => {
  it("`datetime` carrega hora, entao pede mascara datetime", () => {
    assert.deepEqual(kindOf("data_producao", "datetime"), { kind: "datetime" });
  });

  it("`date` puro nao inventa hora", () => {
    assert.deepEqual(kindOf("data_alojamento", "date"), { kind: "date" });
  });

  it("`timestamp` tambem e time-bearing", () => {
    assert.deepEqual(kindOf("data_alojamento", "timestamp(6)"), { kind: "datetime" });
  });

  it("data nunca recebe casa decimal, mesmo com `scale` do driver", () => {
    // `scale` em coluna de data nao quer dizer casa decimal — e precisao de
    // fracao de segundo. Deixar vazar viraria "31/12/2025" com 6 decimais.
    assert.deepEqual(kindOf("data_producao", "timestamp", 6), { kind: "datetime" });
  });
});

describe("resolveColumnFormats: unidade do lexico decide a mascara", () => {
  it("`pct_*` vira percent com 1 casa", () => {
    assert.deepEqual(kindOf("pct_eclo_obtido", "numeric"), { kind: "percent", decimals: 1 });
  });

  it("taxa em float sem scale usa o default do kind", () => {
    assert.deepEqual(kindOf("pct_eclo_padrao", "float"), { kind: "percent", decimals: 1 });
  });

  it("dinheiro vira currency com 2 casas", () => {
    assert.deepEqual(kindOf("vlr_total", "numeric"), { kind: "currency", decimals: 2 });
  });

  it("contagem e inteira por definicao, sem casa decimal", () => {
    assert.deepEqual(kindOf("qtd_00a03_mort", "int"), { kind: "integer", decimals: 0 });
  });

  // `unit: "weight"` e `unit: "gram"` sao coisas diferentes e nao podem
  // colapsar no mesmo kind. `peso_final` diz que o valor e MASSA e cala a
  // unidade; num DW de frigorifico `peso_bruto_produzido` esta em kg, e a tela
  // mostrava "3.382.117,716 g" — errado por 1000x, contradizendo o "kg" que o
  // resumo em prosa da mesma resposta escrevia certo.
  it("prefixo de peso nao afirma grama: vira decimal sem sufixo", () => {
    assert.deepEqual(kindOf("peso_final", "float"), { kind: "decimal", decimals: 2 });
    assert.deepEqual(kindOf("peso_bruto_produzido", "decimal", 6), { kind: "decimal", decimals: 3 });
  });

  it("so o nome que DIZ grama vira gram", () => {
    assert.deepEqual(kindOf("media_grama_ovo", "float"), { kind: "gram", decimals: 1 });
  });

  it("prefixo de peso ganha do radical grama — e o seed cobre a diferenca", () => {
    // `detectUnit` testa `weightPrefixes` antes de `gramTerms`, entao
    // `peso_grama_ovo` sai `weight`. Reordenar ali mexeria nas guardas
    // semanticas do prompt; quem precisa do `g` declara pelo seed.
    assert.deepEqual(kindOf("peso_grama_ovo", "float"), { kind: "decimal", decimals: 2 });
    const curated = resolveColumnFormats([col("peso_grama_ovo", "float")], {
      overrides: { peso_grama_ovo: "gram" }
    });
    assert.deepEqual(curated.peso_grama_ovo, { kind: "gram", decimals: 1 });
  });
});

describe("resolveColumnFormats: `scale` do driver refina, mas nao manda", () => {
  // Antes o `scale` vencia o default em qualquer kind numerico. Em producao o
  // mssql reporta `scale: 6` para todo `SUM(...)`, e a tabela saiu com SEIS
  // casas em coluna de dinheiro, de peso e de contagem de caixas.
  it("dinheiro e sempre dois centavos, qualquer que seja o `scale`", () => {
    assert.deepEqual(kindOf("vlr_total", "numeric", 0), { kind: "currency", decimals: 2 });
    assert.deepEqual(kindOf("vlr_total", "numeric", 6), { kind: "currency", decimals: 2 });
  });

  it("`scale` de agregado e limitado, nao descartado", () => {
    // Cortar em 3 preserva o valor real (`3382117.716`); cair no default de 1
    // casa perderia mais precisao do que o proprio limite.
    assert.deepEqual(kindOf("pct_eclo_obtido", "numeric", 4), { kind: "percent", decimals: 3 });
    assert.deepEqual(kindOf("pct_eclo_obtido", "numeric", 2), { kind: "percent", decimals: 2 });
  });

  it("`scale` negativo e ignorado — Oracle usa isso para arredondamento", () => {
    assert.deepEqual(kindOf("vlr_total", "numeric", -2), { kind: "currency", decimals: 2 });
  });

  it("`scale: null` (driver nao informou) cai no default", () => {
    assert.deepEqual(kindOf("vlr_total", "numeric", null), { kind: "currency", decimals: 2 });
  });
});

describe("formatFromClass: metrica sem unidade reconhecida", () => {
  it("NUMBER(10,0) e inteira mesmo com nome de medicao continua", () => {
    // `scale: 0` do driver e a verdade do banco e vence o palpite `decimal`.
    const meta = col("indice_conversao_x", "numeric", 0);
    const cls = classifyColumn(meta.name, meta.type, undefined);
    assert.deepEqual(formatFromClass({ ...cls, role: "metric", unit: null }, meta), {
      kind: "integer",
      decimals: 0
    });
  });

  it("tipo inteiro declarado ja basta para integer", () => {
    const meta = col("indice_conversao_x", "bigint");
    const cls = classifyColumn(meta.name, meta.type, undefined);
    assert.deepEqual(formatFromClass({ ...cls, role: "metric", unit: null }, meta), {
      kind: "integer",
      decimals: 0
    });
  });

  it("metrica sem tipo util cai em decimal — o unico palpite honesto", () => {
    const meta = col("indice_conversao_x", "");
    const cls = classifyColumn(meta.name, meta.type, undefined);
    assert.deepEqual(formatFromClass({ ...cls, role: "metric", unit: null }, meta), {
      kind: "decimal",
      decimals: 2
    });
  });

  it("kcal carrega sufixo e nao tem casa decimal", () => {
    const meta = col("energia_x", "numeric");
    const cls = classifyColumn(meta.name, meta.type, undefined);
    assert.deepEqual(formatFromClass({ ...cls, unit: "kcal" }, meta), {
      kind: "decimal",
      decimals: 0,
      suffix: "kcal"
    });
  });
});

describe("resolveColumnFormats: curadoria de seed vence tudo", () => {
  it("override transforma percent em fraction — escala que nome nenhum revela", () => {
    // `pct_fertilidade_ovosc` gravado 0.875 em vez de 87.5 e indistinguivel
    // pelo nome; so o seed sabe.
    const out = resolveColumnFormats([col("pct_fertilidade_ovosc", "numeric")], {
      overrides: { pct_fertilidade_ovosc: "fraction" }
    });
    assert.deepEqual(out.pct_fertilidade_ovosc, { kind: "fraction", decimals: 1 });
  });

  it("override e casado em minusculas, entao alias gritado tambem casa", () => {
    const out = resolveColumnFormats([col("TICKET_MEDIO", "numeric")], {
      overrides: { ticket_medio: "currency" }
    });
    assert.deepEqual(out.TICKET_MEDIO, { kind: "currency", decimals: 2 });
  });

  it("override vence ate a regra de chave", () => {
    const out = resolveColumnFormats([col("chave", "bigint")], {
      overrides: { chave: "integer" }
    });
    assert.deepEqual(out.chave, { kind: "integer", decimals: 0 });
  });

  it("`scale` do driver ainda refina o kind curado", () => {
    const out = resolveColumnFormats([col("TICKET_MEDIO", "numeric", 3)], {
      overrides: { ticket_medio: "decimal" }
    });
    assert.deepEqual(out.TICKET_MEDIO, { kind: "decimal", decimals: 3 });
  });

  it("mas curar como dinheiro fixa os dois centavos", () => {
    // O seed escolhe o KIND; a casa decimal de dinheiro nao e negociavel nem
    // por curadoria, senao volta o "R$ 1.234,560000".
    const out = resolveColumnFormats([col("TICKET_MEDIO", "numeric", 6)], {
      overrides: { ticket_medio: "currency" }
    });
    assert.deepEqual(out.TICKET_MEDIO, { kind: "currency", decimals: 2 });
  });
});

describe("resolveColumnFormats: fallback por valor quando nome e tipo calam", () => {
  const unknownName = "zzz_coluna_sem_radical";

  it("numero inteiro na amostra vira integer", () => {
    const out = resolveColumnFormats([col(unknownName)], {
      samples: [{ [unknownName]: 42 }]
    });
    assert.deepEqual(out[unknownName], { kind: "integer", decimals: 0 });
  });

  it("numero fracionario na amostra vira decimal", () => {
    const out = resolveColumnFormats([col(unknownName)], {
      samples: [{ [unknownName]: 42.5 }]
    });
    assert.deepEqual(out[unknownName], { kind: "decimal", decimals: 2 });
  });

  it("`Date` na amostra vira datetime", () => {
    const out = resolveColumnFormats([col(unknownName)], {
      samples: [{ [unknownName]: new Date("2026-01-01") }]
    });
    assert.deepEqual(out[unknownName], { kind: "datetime" });
  });

  it("NaN e Infinity nao contam como numero", () => {
    const out = resolveColumnFormats([col(unknownName)], {
      samples: [{ [unknownName]: Number.NaN }]
    });
    assert.deepEqual(out[unknownName], { kind: "text" });
  });

  it("sem amostra e sem tipo, texto e a resposta", () => {
    assert.deepEqual(kindOf(unknownName), { kind: "text" });
  });

  it("tipo declarado numerico dispensa a amostra", () => {
    // O fallback por valor so existe porque cache antigo e modo API chegam sem
    // tipo. Havendo tipo, ele decide antes.
    const out = resolveColumnFormats([col(unknownName, "numeric")], {
      samples: [{ [unknownName]: "texto" }]
    });
    assert.deepEqual(out[unknownName], { kind: "decimal", decimals: 2 });
  });

  it("amostra nao sobrepoe classificacao do lexico", () => {
    const out = resolveColumnFormats([col("qtd_00a03_mort", "int")], {
      samples: [{ qtd_00a03_mort: 1.5 }]
    });
    assert.deepEqual(out.qtd_00a03_mort, { kind: "integer", decimals: 0 });
  });
});

describe("resolveColumnFormats: bordas do contrato", () => {
  it("coluna sem nome e ignorada em vez de virar chave vazia", () => {
    const out = resolveColumnFormats([col(""), col("peso_final", "float")]);
    assert.deepEqual(Object.keys(out), ["peso_final"]);
  });

  it("lista vazia devolve objeto vazio", () => {
    assert.deepEqual(resolveColumnFormats([]), {});
  });

  it("`type` ausente nao explode", () => {
    const out = resolveColumnFormats([{ name: "peso_final" } as ResultColumnMeta]);
    assert.deepEqual(out.peso_final, { kind: "decimal", decimals: 2 });
  });

  it("nome repetido no resultado nao duplica chave", () => {
    const out = resolveColumnFormats([col("peso_final", "float"), col("peso_final", "float")]);
    assert.deepEqual(Object.keys(out), ["peso_final"]);
  });
});

describe("resolveColumnFormatsFromNames", () => {
  it("classifica so pelo nome — o caminho do cache antigo e do modo API", () => {
    const out = resolveColumnFormatsFromNames(["pct_eclo_obtido", "qtd_00a03_mort", "cod_granja"]);
    assert.deepEqual(out, {
      pct_eclo_obtido: { kind: "percent", decimals: 1 },
      qtd_00a03_mort: { kind: "integer", decimals: 0 },
      cod_granja: { kind: "text" }
    });
  });

  it("sem tipo, data e reconhecida pelo prefixo do nome", () => {
    // Sem `type` nao da para saber se carrega hora, entao `date` e o certo.
    assert.deepEqual(resolveColumnFormatsFromNames(["data_producao"]), {
      data_producao: { kind: "date" }
    });
  });

  it("repassa amostra e override", () => {
    const out = resolveColumnFormatsFromNames(["zzz_sem_radical", "TICKET_MEDIO"], {
      samples: [{ zzz_sem_radical: 7 }],
      overrides: { ticket_medio: "currency" }
    });
    assert.deepEqual(out, {
      zzz_sem_radical: { kind: "integer", decimals: 0 },
      TICKET_MEDIO: { kind: "currency", decimals: 2 }
    });
  });
});

/**
 * Os casos acima usam nomes dos seeds de avicultura, todos em snake_case — e foi
 * por isso que os defeitos deste bloco passaram verdes ate producao. As sete
 * colunas aqui saem de dois payloads reais de `/api/ask` contra um DW de
 * frigorifico, com o kind que a tela mostrou errado anotado ao lado.
 */
describe("regressao: os payloads que chegaram errados na tela", () => {
  it("`total_*` e contagem, nao decimal", () => {
    // Saia `{kind:"decimal",decimals:6}` -> "159.994,000000" caixas. A lista de
    // prefixos tinha `tot`, e `prefixOrExact` casa nome exato ou `tot_`: nunca
    // alcancava `total_`.
    assert.deepEqual(kindOf("total_caixas_produzidas", "decimal", 6), {
      kind: "integer",
      decimals: 0
    });
    assert.deepEqual(kindOf("total_pacotes_produzidos", "decimal", 6), {
      kind: "integer",
      decimals: 0
    });
  });

  it("mas `total_` de dinheiro continua dinheiro", () => {
    // `total` e prefixo de AGREGACAO: nao tem unidade propria, herda a do
    // radical. Por isso o ramo de moeda e testado antes. `saldo` e prefixo de
    // contagem de verdade e depende da guarda de `currencyTerms`.
    assert.deepEqual(kindOf("total_valor_faturado", "decimal", 6), {
      kind: "currency",
      decimals: 2
    });
    assert.deepEqual(kindOf("saldo_custo_medio", "decimal", 6), {
      kind: "currency",
      decimals: 2
    });
  });

  /**
   * Interseccao de `total_` com os outros radicais.
   *
   * Encontrado na verificacao, nao na implementacao: a primeira versao pos
   * `total` em `countPrefixes`, o que fazia o prefixo VENCER o radical em vez
   * de herdar dele. `Total_Peso_Liquido_Produzido` saia `integer/0` e
   * renderizava "3.382.118" — os 716 g sumiam, e a coluna ficava inconsistente
   * com a irma `Peso_Liquido_Produzido` na MESMA tabela. O conserto de D2
   * derrotava o de D3 exatamente onde os dois se cruzam.
   */
  it("`total_` herda a unidade do radical que soma", () => {
    // Peso: mantem casa decimal, sem sufixo `g` (D3 continua valendo sob D2).
    assert.deepEqual(kindOf("total_peso_liquido_produzido", "decimal", 6), {
      kind: "decimal",
      decimals: 3
    });
    // Taxa: `total_perda` e perda percentual somada, nao contagem de perdas.
    assert.equal(kindOf("total_perda", "decimal", 6)?.kind, "percent");
    // Grama declarada no nome sobrevive ao prefixo de agregacao.
    assert.equal(kindOf("total_grama_ovo", "decimal", 6)?.kind, "gram");
    // E onde radical nenhum casa, agregacao e contagem — o caso de D2.
    assert.deepEqual(kindOf("total_caixas_produzidas", "decimal", 6), {
      kind: "integer",
      decimals: 0
    });
  });

  it("`peso_*` do frigorifico esta em kg, e a tela dizia `g`", () => {
    for (const name of [
      "peso_bruto_produzido",
      "peso_liquido_produzido",
      "peso_padrao_produzido",
      "peso_venda_produzido"
    ]) {
      assert.deepEqual(kindOf(name, "decimal", 6), { kind: "decimal", decimals: 3 }, name);
    }
  });

  it("alias CamelCase que o modelo escreve tambem e classificado", () => {
    // `tokenRegex` delimita por `_`: em `ValorReais` o termo `valor` nao casa, a
    // coluna vinha `matched: false` e caia no fallback por tipo — e a coluna de
    // dinheiro perdia o `R$`.
    assert.deepEqual(kindOf("ValorReais", "decimal", 6), { kind: "currency", decimals: 2 });
    assert.deepEqual(kindOf("PesoLiquidoKg", "decimal", 6), { kind: "decimal", decimals: 3 });
    assert.deepEqual(kindOf("TotalCaixasProduzidas", "decimal", 6), {
      kind: "integer",
      decimals: 0
    });
    assert.deepEqual(kindOf("DataProducao", "datetime"), { kind: "datetime" });
  });

  it("chave em CamelCase continua texto, sem separador de milhar", () => {
    // A conversao tambem faz `SKProduto` visivel para `KEY_TOKEN`, e o fallback
    // por valor nao pode devolve-la para `integer`.
    const out = resolveColumnFormats([col("SKProduto", "int"), col("IdLote", "bigint")], {
      samples: [{ SKProduto: 1234, IdLote: 99 }]
    });
    assert.deepEqual(out.SKProduto, { kind: "text" });
    assert.deepEqual(out.IdLote, { kind: "text" });
  });

  it("uma tentativa so, e sem inventar quando nao ha o que reconhecer", () => {
    // Nome que nao casa em nenhuma das duas formas segue o caminho de antes: o
    // dado real decide. Amostra fracionaria mantem o palpite `decimal`.
    const out = resolveColumnFormats([col("ZzzSemRadical", "numeric")], {
      samples: [{ ZzzSemRadical: 7.5 }]
    });
    assert.deepEqual(out.ZzzSemRadical, { kind: "decimal", decimals: 2 });
  });

  it("a chave do mapa e sempre o nome ORIGINAL da coluna", () => {
    // A forma em snake_case e uso interno da classificacao. Se vazasse para a
    // chave, o frontend nao acharia a mascara e a celula voltaria ao cru.
    const out = resolveColumnFormats([col("ValorReais", "decimal", 6)]);
    assert.deepEqual(Object.keys(out), ["ValorReais"]);
  });
});

/**
 * Contagem que o lexico nao nomeia.
 *
 * O bloco acima cobre `total_caixas_produzidas`, que casa `countPrefixes` pelo
 * `total_`. Sem esse prefixo — `CaixasProduzidas`, que foi o alias que o modelo
 * escreveu — nao sobra radical nenhum: `matched: false`, `role: metric`,
 * `unit: null`, e o `scale: 6` que o mssql reporta para todo `SUM(...)` levava
 * a coluna para `decimal/3`. A tela mostrou "585.293,000000" com a mascara
 * velha do cache e mostraria "585.293,000" mesmo depois de recalculada.
 *
 * O nome tinha se esgotado como fonte. O dado nao: 585293 e inteiro.
 */
describe("contagem reconhecida pelo dado quando o nome nao diz nada", () => {
  const linhas = [
    { PesoLiquidoProduzidoKg: 11956172.458, CaixasProduzidas: 585293, PacotesProduzidos: 3787485 },
    { PesoLiquidoProduzidoKg: 8300100.25, CaixasProduzidas: 401002, PacotesProduzidos: 2900411 }
  ];

  const metas = [
    col("PesoLiquidoProduzidoKg", "numeric", 6),
    col("CaixasProduzidas", "numeric", 6),
    col("PacotesProduzidos", "numeric", 6)
  ];

  it("o payload da tela sai inteiro onde e contagem e decimal onde e peso", () => {
    const out = resolveColumnFormats(metas, { samples: linhas });
    assert.deepEqual(out.CaixasProduzidas, { kind: "integer", decimals: 0 });
    assert.deepEqual(out.PacotesProduzidos, { kind: "integer", decimals: 0 });
    // `peso_liquido_produzido_kg` casa `weightPrefixes` na retentativa em
    // snake_case, entao `matched: true` e a regra do dado nem e consultada.
    assert.deepEqual(out.PesoLiquidoProduzidoKg, { kind: "decimal", decimals: 3 });
  });

  it("uma unica linha fracionaria derruba a afirmacao", () => {
    // O ponto de varrer mais de uma linha: se a fracao aparece na linha 2 e so
    // a 1 fosse lida, o valor real seria arredondado e sumiria da tela.
    const out = resolveColumnFormats([col("CaixasProduzidas", "numeric", 6)], {
      samples: [{ CaixasProduzidas: 585293 }, { CaixasProduzidas: 401002.75 }]
    });
    assert.deepEqual(out.CaixasProduzidas, { kind: "decimal", decimals: 3 });
  });

  it("inteiro que chegou como string tambem conta", () => {
    // mssql manda BIGINT/DECIMAL grandes como string para nao perder precisao.
    const out = resolveColumnFormats([col("CaixasProduzidas", "numeric", 6)], {
      samples: [{ CaixasProduzidas: "585293" }, { CaixasProduzidas: "401002" }]
    });
    assert.deepEqual(out.CaixasProduzidas, { kind: "integer", decimals: 0 });
  });

  it("string fracionaria continua decimal", () => {
    const out = resolveColumnFormats([col("CaixasProduzidas", "numeric", 6)], {
      samples: [{ CaixasProduzidas: "585293.75" }]
    });
    assert.deepEqual(out.CaixasProduzidas, { kind: "decimal", decimals: 3 });
  });

  it("nulo nao conta contra — contagem com buraco continua contagem", () => {
    const out = resolveColumnFormats([col("CaixasProduzidas", "numeric", 6)], {
      samples: [{ CaixasProduzidas: null }, { CaixasProduzidas: 585293 }]
    });
    assert.deepEqual(out.CaixasProduzidas, { kind: "integer", decimals: 0 });
  });

  it("coluna so de nulos nao afirma nada e mantem o derivado", () => {
    const out = resolveColumnFormats([col("CaixasProduzidas", "numeric", 6)], {
      samples: [{ CaixasProduzidas: null }, { CaixasProduzidas: undefined }]
    });
    assert.deepEqual(out.CaixasProduzidas, { kind: "decimal", decimals: 3 });
  });

  it("sem linhas o dado nao opina", () => {
    const out = resolveColumnFormats([col("CaixasProduzidas", "numeric", 6)], { samples: [] });
    assert.deepEqual(out.CaixasProduzidas, { kind: "decimal", decimals: 3 });
  });

  it("classificacao do lexico nunca e sobrescrita pelo dado", () => {
    // Dinheiro e taxa saem redondos com frequencia; se o dado mandasse aqui,
    // `vlr_total` perderia os centavos num resultado de valores inteiros.
    const out = resolveColumnFormats(
      [col("vlr_total", "numeric", 6), col("pct_eclo_obtido", "numeric", 6), col("peso_final", "numeric", 6)],
      { samples: [{ vlr_total: 1500, pct_eclo_obtido: 90, peso_final: 42 }] }
    );
    assert.deepEqual(out.vlr_total, { kind: "currency", decimals: 2 });
    assert.deepEqual(out.pct_eclo_obtido, { kind: "percent", decimals: 3 });
    assert.deepEqual(out.peso_final, { kind: "decimal", decimals: 3 });
  });

  it("chave surrogate nao vira inteiro por causa do dado", () => {
    // A guarda de identificador roda antes e ja devolveu `text`; a regra do
    // dado so olha `decimal`, entao a correcao original continua de pe.
    const out = resolveColumnFormats([col("SKProduto", "numeric", 6)], {
      samples: [{ SKProduto: 1234 }]
    });
    assert.deepEqual(out.SKProduto, { kind: "text" });
  });

  it("varredura para em 50 linhas", () => {
    // A fracao na linha 51 nao e vista. E uma troca deliberada: varrer o
    // resultado inteiro a cada pergunta custa mais do que a casa decimal que se
    // perde num resultado que comeca com 50 inteiros seguidos.
    const samples = Array.from({ length: 60 }, (_, i) => ({
      CaixasProduzidas: i === 55 ? 1.5 : 100 + i
    }));
    const out = resolveColumnFormats([col("CaixasProduzidas", "numeric", 6)], { samples });
    assert.deepEqual(out.CaixasProduzidas, { kind: "integer", decimals: 0 });
  });
});

describe("guardas de tipo", () => {
  it("isColumnFormatKind aceita a lista fechada e recusa o resto", () => {
    assert.equal(isColumnFormatKind("currency"), true);
    assert.equal(isColumnFormatKind("text"), true);
    assert.equal(isColumnFormatKind("money"), false);
    assert.equal(isColumnFormatKind(undefined), false);
    assert.equal(isColumnFormatKind(2), false);
  });

  it("isNumericKind separa o que alinha a direita", () => {
    for (const kind of ["currency", "percent", "fraction", "integer", "decimal", "gram"] as const) {
      assert.equal(isNumericKind(kind), true);
    }
    for (const kind of ["date", "datetime", "text"] as const) {
      assert.equal(isNumericKind(kind), false);
    }
  });
});
