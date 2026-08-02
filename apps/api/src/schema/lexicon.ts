import type { ColumnInfo } from "@auraia/shared";

/**
 * Lexico deterministico do schema de avicultura (views ubi.cifs* / ubi.avfs*).
 *
 * O banco tem ~500 colunas com nomes abreviados em portugues, zero descricao,
 * zero tag, zero PK/FK (sao views). O modelo escolhia colunas as cegas. A
 * nomenclatura, porem, e rigida o bastante para virar regra: ~70 termos de
 * vocabulario classificam a esmagadora maioria das colunas sem LLM nenhum.
 *
 * Nada aqui faz I/O nem chama modelo. E funcao pura, e por isso e testavel
 * sem ambiente — o que importa porque a baseline do eval ainda nao existe.
 */

export type ColumnRole = "metric" | "dimension" | "date" | "key" | "unknown";
export type ColumnUnit = "count" | "rate" | "weight" | "gram" | "kcal" | null;
export type ColumnNature = "target" | "actual" | null;
export type ColumnSex = "fem" | "mac" | null;
export type ColumnSource =
  | "mort"
  | "ovosc"
  | "granja"
  | "incubatorio"
  | "auditoria"
  | "transferencia"
  | null;
export type ColumnPeriod = "week" | "acum" | null;

export type ColumnClass = {
  role: ColumnRole;
  unit: ColumnUnit;
  /** "target" = meta da linhagem (_padrao). Nunca e o realizado. */
  nature: ColumnNature;
  /** Acumulado ate a idade. Somar entre linhas dupla-conta. */
  cumulative: boolean;
  sex: ColumnSex;
  /** Onde a medicao foi feita. So preenchido para metricas. */
  source: ColumnSource;
  /** Faixa de mortalidade embrionaria, ex "00a03". */
  bucket: string | null;
  period: ColumnPeriod;
  /**
   * true = alguma regra do lexico disparou. false = caiu no fallback por tipo
   * declarado. E o que a suite de cobertura mede: fallback nao conta como
   * classificado.
   */
  matched: boolean;
};

/**
 * Faixas que JA CONTEM outras. `qtd_00a07_mort` e a soma de `qtd_00a03_mort`
 * com `qtd_04a07_mort` — somar as tres dupla-conta a mortalidade.
 * Consumido pela guarda semantica (E3).
 */
export const OVERLAPPING_BUCKETS: Readonly<Record<string, readonly string[]>> = {
  "00a07": ["00a03", "04a07"],
  "15a21": ["15a18", "19a21"]
};

const has = (name: string, term: string): boolean =>
  new RegExp(`(^|_)${term}(_|$)`).test(name);

const hasAny = (name: string, terms: readonly string[]): boolean =>
  terms.some((t) => has(name, t));

/** Termo como token FINAL. Distingue `qtd_ovos_aprov_inc` (medido no
 *  incubatorio) de `ovo_inc_ave_padrao` (ovo incubavel por ave). */
const endsWithTerm = (name: string, term: string): boolean =>
  new RegExp(`(^|_)${term}$`).test(name);

// --- vocabulario -----------------------------------------------------------

/** Metrica expressa como taxa/indice. Nao se soma; media simples tambem
 *  mente — o certo e SUM(numerador)/SUM(denominador). */
const RATE_TERMS = [
  "eclosao",
  "eclo",
  "fertilidade",
  "infertilidade",
  "fertil",
  "infertil",
  "viab",
  "viabilidade",
  "unif",
  "uniformidade",
  "cv",
  "postura",
  "aprov",
  "aproveitamento",
  "contamin",
  "densidade",
  "relacao",
  "perda",
  "mort"
] as const;

/** Radicais compostos que sao razao por ave — tambem nao somaveis. */
const RATE_PHRASES = ["ovo_ave", "ovo_inc_ave", "pinto_ave", "coef_varicacao", "coef_variacao"];

const WEIGHT_TERMS = ["peso", "pm", "racao", "cons", "consumo"] as const;

/** `peso`/`pm` como token inicial declaram peso mesmo que o resto do nome
 *  carregue radical de taxa. Ver a nota de precedencia em `detectUnit`. */
const WEIGHT_PREFIXES = ["peso", "pm"] as const;
const GRAM_TERMS = ["grama", "proteina", "lisina", "metionina", "cistina"] as const;
const KCAL_TERMS = ["calor"] as const;

/** Prefixos que declaram contagem absoluta. `qtde_` e `qtd_` convivem no
 *  mesmo banco, as vezes na mesma tabela. */
const COUNT_PREFIXES = ["qtd", "qtde", "amostra", "tot", "classif", "ovos", "saldo"] as const;

const DIMENSION_PREFIXES = ["cod", "nro", "ide", "nom", "tip", "tipo"] as const;

/** Substantivos de dimensao que nao carregam prefixo algum. Sem esta lista
 *  eles cairiam no fallback por tipo e a cobertura medida seria falsa. */
const DIMENSION_TERMS = [
  "granja",
  "linhagem",
  "situacao",
  "local",
  "nucleo",
  "galpao",
  "galinheiro",
  "box",
  "incubatorio",
  "propriedade",
  "faixa",
  "sexo",
  "modelo",
  "classe",
  "grupo",
  "especie",
  "espec",
  "ave",
  "est",
  "maq",
  "incubacao",
  "depto",
  "dias",
  "estocagem",
  "recebido",
  // `lote_proprio` e flag bit (lote da propria empresa x terceiro), nao metrica
  "proprio",
  // `idade` e SEMANA DE VIDA do lote — nunca ano, nunca data, nunca idade
  // de pessoa. Filtrar periodo nela e um dos erros que a guarda barra.
  "idade"
] as const;

/** Chaves de juncao reais. `cod_lote_num` e a chave que atravessa as 14
 *  views; o modelo tinha que adivinhar isso porque as views nao tem FK. */
const KEY_NAMES = new Set([
  "cod_lote_num",
  "chave",
  "chave_0",
  "codigo_lote",
  "codigo_lote_completo",
  "codigo_lote_f",
  "codigo_lote_m",
  "lote",
  "nro_lote",
  "cod_lf",
  "cod_lm"
]);

const DATE_TYPES = /^(date|datetime|datetime2|smalldatetime|timestamp|time)/i;
const TEXT_TYPES = /^(char|nchar|varchar|nvarchar|text|ntext|bit|uniqueidentifier)/i;
const NUMERIC_TYPES = /^(int|bigint|smallint|tinyint|numeric|decimal|float|real|money)/i;

// --- classificacao ---------------------------------------------------------

const detectBucket = (name: string): string | null => {
  const m = name.match(/(^|_)(\d{2})a(\d{2})(_|$)/);
  return m ? `${m[2]}a${m[3]}` : null;
};

const detectNature = (name: string): ColumnNature => {
  // _padrao ganha de tudo. Um falso "actual" aqui faz o modelo responder a
  // meta da linhagem como se fosse o resultado obtido.
  if (hasAny(name, ["padrao", "pad", "meta"])) return "target";
  if (hasAny(name, ["obtido", "obtida", "real", "realizado", "obt"])) return "actual";
  return null;
};

const detectSex = (name: string): ColumnSex => {
  // Nao ha excecao para `pct_relacao_mf` (relacao macho/femea, que nao e nem
  // um sexo nem o outro): `mf` nao e token de `fem` nem de `mac`, entao o
  // casamento por limite de token ja devolve null sozinho. Havia uma guarda
  // explicita aqui e ela era codigo morto — o teste que a cobria passava com
  // ela removida. O invariante continua testado, agora contra o motivo real.
  if (hasAny(name, ["fem", "femea", "femeas"])) return "fem";
  if (hasAny(name, ["mac", "macho", "machos"])) return "mac";
  return null;
};

const detectSource = (name: string): ColumnSource => {
  if (has(name, "mort")) return "mort";
  if (has(name, "ovosc")) return "ovosc";
  if (has(name, "auditoria")) return "auditoria";
  if (has(name, "transf")) return "transferencia";
  // Token final apenas: o mesmo ovo aparece contado na granja e no
  // incubatorio, e os dois numeros divergem de proposito.
  if (endsWithTerm(name, "gra")) return "granja";
  if (endsWithTerm(name, "inc")) return "incubatorio";
  return null;
};

const detectPeriod = (name: string, cumulative: boolean): ColumnPeriod => {
  if (cumulative) return "acum";
  if (hasAny(name, ["sem", "semana"])) return "week";
  return null;
};

const detectUnit = (name: string, type: string): ColumnUnit => {
  // Ordem importa: pct_ vence radical, e prefixo de contagem vence radical
  // de taxa (`qtd_00a03_mort` e contagem, `mort_00a03_padrao` e taxa).
  if (name.startsWith("pct_") || has(name, "pct")) return "rate";

  // `saldo` e `tot` aparecem sozinhos, sem sufixo. Exigir o `_` deixaria a
  // coluna cair no fallback por tipo.
  const isCount = COUNT_PREFIXES.some((p) => name === p || name.startsWith(`${p}_`));
  if (isCount) {
    // `qtd_consumo_femea` e float e mede gramas de racao, nao unidades.
    if (NUMERIC_TYPES.test(type) && /^(float|real|numeric|decimal)/i.test(type)) {
      if (hasAny(name, ["cons", "consumo", "racao"])) return "weight";
    }
    return "count";
  }

  // Prefixo de peso tambem vence radical de taxa, pelo mesmo motivo que o
  // prefixo de contagem: `peso_eclosao_perda_peso` e o peso medio na eclosao
  // (gramas) usado para CALCULAR a perda, nao a perda em si. Sem esta regra os
  // radicais `eclosao` e `perda` o classificariam como taxa, e a guarda do E3
  // barraria um AVG que esta correto. `meta_perda_peso` continua taxa: nao tem
  // prefixo de peso e e mesmo a meta de perda percentual.
  const isWeightPrefix = WEIGHT_PREFIXES.some((p) => name === p || name.startsWith(`${p}_`));
  if (isWeightPrefix) return "weight";

  if (RATE_PHRASES.some((p) => name.includes(p))) return "rate";
  if (hasAny(name, RATE_TERMS)) return "rate";
  if (hasAny(name, GRAM_TERMS)) return "gram";
  if (hasAny(name, KCAL_TERMS)) return "kcal";
  if (hasAny(name, WEIGHT_TERMS)) return "weight";
  if (hasAny(name, ["ovos", "ovo", "pintos", "pinto", "bandejas", "aves"])) return "count";
  return null;
};

export const classifyColumn = (name: string, type: string): ColumnClass => {
  const n = name.toLowerCase();
  const t = (type ?? "").toLowerCase();

  const bucket = detectBucket(n);
  const cumulative = has(n, "acum");
  const nature = detectNature(n);
  const sex = detectSex(n);
  const period = detectPeriod(n, cumulative);

  const base = { nature, cumulative, sex, bucket, period };

  // 1. Data — o tipo declarado e mais confiavel que o nome. Pega `hor_rec`,
  //    que e datetime apesar do prefixo de hora.
  if (DATE_TYPES.test(t) || n.startsWith("dat_") || n === "data" || n.startsWith("data_")) {
    return { ...base, role: "date", unit: null, source: null, matched: true };
  }

  // 2. Chave de juncao.
  if (KEY_NAMES.has(n)) {
    return { ...base, role: "key", unit: null, source: null, matched: true };
  }

  // 3. Dimensao por prefixo ou por substantivo conhecido.
  const isDimPrefix = DIMENSION_PREFIXES.some((p) => n.startsWith(`${p}_`));
  const isDimTerm = hasAny(n, DIMENSION_TERMS) || DIMENSION_TERMS.includes(n as never);
  const unit = detectUnit(n, t);

  // Prefixo de dimensao vence: `nro_maq_inc` e o numero da maquina, nao uma
  // medicao feita no incubatorio.
  if (isDimPrefix) {
    return { ...base, role: "dimension", unit: null, source: null, matched: true };
  }

  // 4. Metrica — so aqui `source` faz sentido: ele diz de onde veio a medicao.
  if (unit !== null) {
    return { ...base, role: "metric", unit, source: detectSource(n), matched: true };
  }

  if (isDimTerm) {
    return { ...base, role: "dimension", unit: null, source: null, matched: true };
  }

  // 5. Fallback por tipo declarado. Nao conta como classificado.
  if (TEXT_TYPES.test(t)) {
    return { ...base, role: "dimension", unit: null, source: null, matched: false };
  }
  if (NUMERIC_TYPES.test(t)) {
    return { ...base, role: "metric", unit: null, source: detectSource(n), matched: false };
  }

  return { ...base, role: "unknown", unit: null, source: null, matched: false };
};

export const classifyColumns = (
  columns: readonly ColumnInfo[]
): Array<ColumnInfo & { class: ColumnClass }> =>
  columns.map((c) => ({ ...c, class: classifyColumn(c.name, c.type) }));
