import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyColumn, OVERLAPPING_BUCKETS, type ColumnClass } from "./lexicon.js";
import { ALL_COLUMNS, REAL_SCHEMA } from "./realSchema.fixture.js";

/**
 * O banco tem 791 colunas em 14 views, com nomes abreviados em portugues e
 * zero descricao. O modelo escolhia colunas as cegas e a resposta saia
 * sintaticamente perfeita com o numero errado.
 *
 * Cada bloco abaixo cobre uma armadilha que ja produziu numero errado. Nao sao
 * testes de "a funcao roda" — sao testes de "este engano especifico nao volta".
 */

const c = (name: string, type = "int"): ColumnClass => classifyColumn(name, type);

describe("nature — meta da linhagem nunca pode virar resultado obtido", () => {
  // O erro mais caro do lote: responder a meta como se fosse o realizado.
  // Nao gera erro de SQL, gera um numero plausivel e falso.
  const targets = [
    "unif_fem_pad",
    "mort_bicado_anomalia_padrao",
    "pct_padrao_trinc_auditoria",
    "metionina_cistina_padrao_fem_sem",
    "ovo_inc_ave_padrao",
    "meta_perda_peso",
    "peso_padrao_fem"
  ];
  for (const name of targets) {
    it(`${name} e target`, () => {
      assert.equal(c(name, "float").nature, "target");
    });
  }

  const actuals = ["proteina_obtida_mac_sem", "pct_eclosao_obtida", "peso_real_fem", "unif_obtida"];
  for (const name of actuals) {
    it(`${name} e actual`, () => {
      assert.equal(c(name, "float").nature, "actual");
    });
  }

  it("padrao ganha de obtido quando os dois aparecem no mesmo nome", () => {
    // `pct_padrao_obtido_x` existe no schema como "o padrao para o obtido".
    // Se resolvesse como actual, a comparacao meta-vs-real se compararia
    // consigo mesma.
    assert.equal(c("pct_padrao_obtido_trinc", "float").nature, "target");
  });

  it("coluna sem marcador nao inventa nature", () => {
    assert.equal(c("qtd_ovos_dia").nature, null);
  });
});

describe("cumulative — somar acumulado dupla-conta", () => {
  for (const name of ["qtd_ovos_acum", "producao_acum_fem", "acum_mort"]) {
    it(`${name} marca cumulative e period=acum`, () => {
      const k = c(name);
      assert.equal(k.cumulative, true);
      assert.equal(k.period, "acum");
    });
  }

  it("nao marca acumulado por substring solta", () => {
    // `acumulador` nao existe hoje, mas o regex de token evita que uma coluna
    // nova com esse radical vire acumulada por acidente.
    assert.equal(c("acumulador_teste").cumulative, false);
  });

  it("semanal nao e acumulado", () => {
    const k = c("proteina_obtida_mac_sem", "float");
    assert.equal(k.cumulative, false);
    assert.equal(k.period, "week");
  });
});

describe("unit — taxa nao se soma, contagem nao se tira media", () => {
  it("pct_* e sempre rate", () => {
    assert.equal(c("pct_eclosao", "numeric").unit, "rate");
    assert.equal(c("pct_00a04_ovosc", "numeric").unit, "rate");
  });

  it("prefixo de contagem vence radical de taxa", () => {
    // `qtd_00a03_mort` e uma contagem de embrioes mortos, nao um percentual —
    // apesar de conter `mort`, que e radical de taxa.
    assert.equal(c("qtd_00a03_mort").unit, "count");
    assert.equal(c("mort_00a03_padrao", "float").unit, "rate");
  });

  it("radical de razao por ave e rate", () => {
    for (const name of ["ovo_ave_padrao", "ovo_inc_ave_padrao", "pinto_ave_obtido"]) {
      assert.equal(c(name, "float").unit, "rate", name);
    }
  });

  it("consumo em float sob prefixo de contagem e peso, nao unidade", () => {
    // `qtd_consumo_femea` mede gramas de racao. Tratar como contagem fazia o
    // modelo somar gramas achando que somava aves.
    assert.equal(c("qtd_consumo_femea", "float").unit, "weight");
    assert.equal(c("qtd_ovos_femea", "int").unit, "count");
  });

  it("nutrientes sao gramas", () => {
    for (const name of ["proteina_fem_sem", "lisina_padrao", "metionina_cistina_padrao_fem_sem"]) {
      assert.equal(c(name, "float").unit, "gram", name);
    }
  });

  it("saldo e tot sozinhos ainda sao contagem", () => {
    assert.equal(c("saldo", "int").unit, "count");
    assert.equal(c("tot_ovos_dia", "int").unit, "count");
  });

  // A perda de peso na incubacao e medida comparando pesagens. As pesagens
  // (`peso_*`, `pm_*`) sao gramas; a perda em si e percentual. Sem separar os
  // dois, o E3 barraria `AVG(pm_eclosao_perda_peso)`, que esta certo, e
  // deixaria passar `AVG` numa taxa, que esta errado.
  describe("prefixo de peso vence radical de taxa", () => {
    const weights = [
      "peso_incubacao_perda_peso",
      "peso_transf_perda_peso",
      "peso_eclosao_perda_peso",
      "pm_incubacao_perda_peso",
      "pm_transf_perda_peso",
      "pm_eclosao_perda_peso",
      "peso_eclosao"
    ];
    for (const name of weights) {
      it(`${name} e peso, nao taxa`, () => {
        assert.equal(c(name, "float").unit, "weight");
      });
    }

    // O contraponto: sem prefixo de peso, o radical manda de novo.
    const rates = [
      "eclosao_padrao",
      "eclosao_real",
      "eclosao_ovo_fertil_padrao",
      "eclosao_ovo_fertil_real",
      "pct_eclo_obtido",
      "pct_eclo_padrao",
      "perda_transf",
      "perda_final",
      // Este e mesmo a meta da perda percentual, apesar de terminar em `peso`.
      "meta_perda_peso"
    ];
    for (const name of rates) {
      it(`${name} continua taxa`, () => {
        assert.equal(c(name, "float").unit, "rate");
      });
    }

    // Denominadores da amostragem: o prefixo de contagem continua ganhando de
    // ambos os radicais.
    const counts = [
      "amostra_incubacao_perda_peso",
      "amostra_transf_perda_peso",
      "amostra_eclosao_perda_peso"
    ];
    for (const name of counts) {
      it(`${name} continua contagem`, () => {
        assert.equal(c(name, "int").unit, "count");
      });
    }
  });
});

describe("bucket — faixas de mortalidade embrionaria que se contem", () => {
  it("extrai a faixa do nome", () => {
    assert.equal(c("qtd_00a03_mort").bucket, "00a03");
    assert.equal(c("pct_00a04_ovosc", "numeric").bucket, "00a04");
  });

  it("declara quais faixas ja contem outras", () => {
    // Somar 00a07 com 00a03 e 04a07 dupla-conta a mesma mortalidade.
    assert.deepEqual(OVERLAPPING_BUCKETS["00a07"], ["00a03", "04a07"]);
    assert.deepEqual(OVERLAPPING_BUCKETS["15a21"], ["15a18", "19a21"]);
  });

  it("as faixas contidas existem no schema real", () => {
    // Guarda contra a lista de overlap referenciar faixa que nao existe mais.
    const buckets = new Set(
      ALL_COLUMNS.map((col) => classifyColumn(col.name, col.type).bucket).filter(Boolean)
    );
    for (const [parent, children] of Object.entries(OVERLAPPING_BUCKETS)) {
      assert.ok(buckets.has(parent), `faixa ${parent} sumiu do schema`);
      for (const child of children) {
        assert.ok(buckets.has(child), `faixa ${child} sumiu do schema`);
      }
    }
  });
});

describe("source — a mesma medicao existe duas vezes e os numeros divergem", () => {
  it("token final _gra e granja, _inc e incubatorio", () => {
    assert.equal(c("qtd_ovos_aprov_gra").source, "granja");
    assert.equal(c("qtd_ovos_aprov_inc").source, "incubatorio");
  });

  it("_inc no meio do nome nao e local de medicao", () => {
    // `ovo_inc_ave_padrao` e "ovo incubavel por ave", nao "ovo no incubatorio".
    assert.equal(c("ovo_inc_ave_padrao", "float").source, null);
  });

  it("dimensao terminada em _inc nao ganha source", () => {
    // `nro_maq_inc` e o numero da maquina; nao e medicao nenhuma.
    const k = c("nro_maq_inc", "smallint");
    assert.equal(k.role, "dimension");
    assert.equal(k.source, null);
  });

  it("reconhece as demais origens", () => {
    assert.equal(c("qtd_00a03_mort").source, "mort");
    assert.equal(c("pct_00a04_ovosc", "numeric").source, "ovosc");
    assert.equal(c("pct_padrao_trinc_auditoria").source, "auditoria");
    assert.equal(c("qtd_transf_ovos").source, "transferencia");
  });

  it("source so existe em metrica", () => {
    for (const col of ALL_COLUMNS) {
      const k = classifyColumn(col.name, col.type);
      if (k.source !== null) {
        assert.equal(k.role, "metric", `${col.name} tem source mas nao e metrica`);
      }
    }
  });
});

describe("role — data, chave e dimensao", () => {
  it("tipo declarado decide data mesmo com prefixo enganoso", () => {
    // `hor_rec` parece hora, e datetime.
    assert.equal(c("hor_rec", "datetime").role, "date");
    assert.equal(c("dat_aloj_inicial", "datetime").role, "date");
  });

  it("chaves de juncao sao key, nao dimensao", () => {
    // As views nao tem FK; sem esta lista o modelo tinha que adivinhar por
    // onde juntar as 14 tabelas.
    for (const name of ["cod_lote_num", "chave", "chave_0", "Codigo_Lote_Completo", "cod_lf", "cod_lm"]) {
      assert.equal(c(name, "varchar").role, "key", name);
    }
  });

  it("prefixo de dimensao nao vira metrica", () => {
    for (const name of ["cod_inc_depto", "nro_lote_ave", "ide_granja", "nom_ovo", "tipo_ave"]) {
      const k = c(name, "char");
      assert.ok(k.role === "dimension" || k.role === "key", `${name} -> ${k.role}`);
    }
  });

  it("idade e semana de vida do lote, nao data", () => {
    // Filtrar periodo em `idade` e um dos erros que a guarda semantica (E3)
    // vai barrar. Aqui so garantimos que ela nao se apresenta como data.
    const k = c("idade", "smallint");
    assert.equal(k.role, "dimension");
    assert.notEqual(k.role, "date");
  });

  it("flag bit e dimensao, nao metrica", () => {
    assert.equal(c("lote_proprio", "bit").role, "dimension");
  });
});

describe("sex", () => {
  it("separa femea e macho", () => {
    assert.equal(c("peso_medio_fem", "float").sex, "fem");
    assert.equal(c("proteina_obtida_mac_sem", "float").sex, "mac");
  });

  it("relacao macho-femea nao pertence a nenhum dos dois", () => {
    // As duas colunas `mf` reais do schema. O par fem/mac logo abaixo e o que
    // torna a asercao nao-vacua: sem ele, zerar `detectSex` inteiro faria o
    // teste passar.
    assert.equal(c("pct_relacao_mf", "numeric").sex, null);
    assert.equal(c("pct_relacao_mf_padrao", "float").sex, null);
    assert.equal(c("pct_relacao_fem", "float").sex, "fem");
    assert.equal(c("pct_relacao_mac", "float").sex, "mac");
  });

  it("o sexo vem de token inteiro, nao de substring", () => {
    // E este casamento por limite de token — nao uma excecao para `mf` — que
    // mantem a relacao macho/femea sem sexo. Uma guarda explicita para `mf`
    // seria codigo morto.
    assert.equal(c("femur_teste", "float").sex, null);
    assert.equal(c("macico_teste", "float").sex, null);
  });
});

describe("cobertura no schema real de producao", () => {
  it("classifica TODAS as colunas por regra, nenhuma por fallback", () => {
    // Limiar percentual (era `> 95`) deixava ~40 colunas regredirem em
    // silencio. Hoje o lexico cobre as 791; qualquer queda e regressao, e o
    // teste tem que dizer QUAIS colunas cairam para ser diagnosticavel.
    const unmatched = ALL_COLUMNS.filter((col) => !classifyColumn(col.name, col.type).matched);
    assert.deepEqual(
      unmatched.map((col) => `${col.name} (${col.type})`),
      [],
      `${unmatched.length} de ${ALL_COLUMNS.length} colunas cairam no fallback por tipo`
    );
  });

  it("nenhuma das 14 views fica abaixo de 90%", () => {
    // A media global esconde uma view inteira mal classificada.
    for (const table of REAL_SCHEMA) {
      const matched = table.columns.filter((col) => classifyColumn(col.name, col.type).matched).length;
      const pct = (matched / table.columns.length) * 100;
      assert.ok(pct >= 90, `${table.tableFullName}: ${pct.toFixed(1)}%`);
    }
  });

  it("nenhuma coluna _padrao/_pad e classificada como realizado", () => {
    for (const col of ALL_COLUMNS) {
      if (/(^|_)(padrao|pad)$/.test(col.name.toLowerCase())) {
        assert.notEqual(classifyColumn(col.name, col.type).nature, "actual", col.name);
      }
    }
  });

  it("toda coluna _acum e cumulativa", () => {
    for (const col of ALL_COLUMNS) {
      if (/(^|_)acum(_|$)/.test(col.name.toLowerCase())) {
        assert.equal(classifyColumn(col.name, col.type).cumulative, true, col.name);
      }
    }
  });

  it("toda coluna pct_* e taxa", () => {
    for (const col of ALL_COLUMNS) {
      if (col.name.toLowerCase().startsWith("pct_")) {
        assert.equal(classifyColumn(col.name, col.type).unit, "rate", col.name);
      }
    }
  });

  it("toda coluna dat_*/data* e data", () => {
    for (const col of ALL_COLUMNS) {
      const n = col.name.toLowerCase();
      if (n.startsWith("dat_") || n === "data" || n.startsWith("data_")) {
        assert.equal(classifyColumn(col.name, col.type).role, "date", col.name);
      }
    }
  });

  it("cod_*/nro_*/ide_*/nom_* nunca sao metrica", () => {
    for (const col of ALL_COLUMNS) {
      const n = col.name.toLowerCase();
      if (["cod_", "nro_", "ide_", "nom_"].some((p) => n.startsWith(p))) {
        const role = classifyColumn(col.name, col.type).role;
        assert.ok(role === "dimension" || role === "key", `${col.name} -> ${role}`);
      }
    }
  });

  it("nenhuma coluna fica sem role", () => {
    for (const col of ALL_COLUMNS) {
      assert.notEqual(classifyColumn(col.name, col.type).role, "unknown", col.name);
    }
  });
});
