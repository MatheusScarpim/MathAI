import type { ColumnInfo } from "@auraia/shared";
import {
  BUILTIN_PTBR_VOCABULARY,
  type DomainVocabulary
} from "./vocabulary.js";

/**
 * Lexico deterministico: nome de coluna -> classificacao estrutural.
 *
 * O problema que ele resolve: um banco de views com centenas de colunas
 * abreviadas em portugues, zero descricao, zero tag, zero PK/FK. O modelo
 * escolhia coluna as cegas. A nomenclatura, porem, e rigida o bastante para
 * virar regra — o vocabulario classifica a esmagadora maioria das colunas sem
 * chamar modelo nenhum.
 *
 * Este arquivo e o MECANISMO, nao o vocabulario. Os termos vem de
 * `DomainVocabulary`: as convencoes PT-BR ja embutidas, mais o que o ambiente
 * acrescentar por seed. Nao ha termo de negocio de cliente nenhum aqui — se
 * voce esta prestes a escrever um, ele pertence ao seed.
 *
 * Nada aqui faz I/O nem chama modelo. E funcao pura, e por isso e testavel
 * sem ambiente — o que importa porque a baseline do eval ainda nao existe.
 */

export type ColumnRole = "metric" | "dimension" | "date" | "key" | "unknown";
export type ColumnUnit = "count" | "rate" | "weight" | "currency" | "gram" | "kcal" | null;
export type ColumnNature = "target" | "actual" | null;
export type ColumnSex = "fem" | "mac" | null;
/**
 * Procedencia da medicao. Aberto de proposito: os rotulos saem de
 * `vocabulary.sourceRules`, que e dado do ambiente. Fecha-lo em uniao
 * literal seria chumbar o dominio de um cliente no tipo.
 */
export type ColumnSource = string | null;
export type ColumnPeriod = "week" | "acum" | null;

export type ColumnClass = {
  role: ColumnRole;
  unit: ColumnUnit;
  /** "target" = meta/orcado (_padrao). Nunca e o realizado. */
  nature: ColumnNature;
  /** Acumulado ate a linha. Somar entre linhas dupla-conta. */
  cumulative: boolean;
  sex: ColumnSex;
  /** Onde a medicao foi feita. So preenchido para metricas. */
  source: ColumnSource;
  /** Faixa numerica embutida no nome, ex "00a03". */
  bucket: string | null;
  period: ColumnPeriod;
  /**
   * true = alguma regra do lexico disparou. false = caiu no fallback por tipo
   * declarado. E o que a suite de cobertura mede: fallback nao conta como
   * classificado.
   */
  matched: boolean;
};

const DATE_TYPES = /^(date|datetime|datetime2|smalldatetime|timestamp|time)/i;
const TEXT_TYPES = /^(char|nchar|varchar|nvarchar|text|ntext|bit|uniqueidentifier)/i;
const NUMERIC_TYPES = /^(int|bigint|smallint|tinyint|numeric|decimal|float|real|money)/i;
const FLOAT_TYPES = /^(float|real|numeric|decimal)/i;

/**
 * Faixa `NNaNN` no nome (`qtd_00a03_mort`). O PADRAO e generico — dois
 * numeros ligados por `a` e como se escreve intervalo em portugues. QUAIS
 * faixas contem quais e que e dominio, e mora em `overlappingBuckets`.
 */
const BUCKET_PATTERN = /(^|_)(\d{2})a(\d{2})(_|$)/;

/**
 * Vocabulario pre-compilado.
 *
 * `classifyColumn` roda uma vez por coluna a cada ingest — centenas de
 * chamadas em sequencia com o MESMO vocabulario. Montar `RegExp` por termo a
 * cada chamada desperdicaria o trabalho inteiro; aqui ele e feito uma vez e
 * memoizado por objeto de vocabulario.
 */
type CompiledLexicon = {
  vocab: DomainVocabulary;
  token: (name: string, terms: readonly string[]) => boolean;
  tokenOne: (name: string, term: string) => boolean;
  suffix: (name: string, term: string) => boolean;
  prefixOrExact: (name: string, terms: readonly string[]) => boolean;
  keyNames: ReadonlySet<string>;
  weightTerms: readonly string[];
};

/** Termo como token delimitado por `_` (ou pelas bordas do nome). */
const tokenRegex = (term: string): RegExp => new RegExp(`(^|_)${term}(_|$)`);
/** Termo como token FINAL. Distingue `qtd_ovos_aprov_inc` (medido no
 *  incubatorio) de `ovo_inc_ave_padrao` (ovo incubavel por ave). */
const suffixRegex = (term: string): RegExp => new RegExp(`(^|_)${term}$`);

const compile = (vocab: DomainVocabulary): CompiledLexicon => {
  const tokenCache = new Map<string, RegExp>();
  const suffixCache = new Map<string, RegExp>();

  const tokenOne = (name: string, term: string): boolean => {
    let re = tokenCache.get(term);
    if (!re) {
      re = tokenRegex(term);
      tokenCache.set(term, re);
    }
    return re.test(name);
  };

  const suffix = (name: string, term: string): boolean => {
    let re = suffixCache.get(term);
    if (!re) {
      re = suffixRegex(term);
      suffixCache.set(term, re);
    }
    return re.test(name);
  };

  return {
    vocab,
    tokenOne,
    suffix,
    token: (name, terms) => terms.some((t) => tokenOne(name, t)),
    // `saldo` e `tot` aparecem sozinhos, sem sufixo. Exigir o `_` deixaria a
    // coluna cair no fallback por tipo.
    prefixOrExact: (name, terms) => terms.some((p) => name === p || name.startsWith(`${p}_`)),
    keyNames: new Set(vocab.keyNames),
    // Peso efetivo = prefixos de peso + termos de consumo + extras do seed.
    // Derivado em vez de listado para nao existir estado onde `racao` conta
    // como consumo mas nao como peso.
    weightTerms: [
      ...new Set([...vocab.weightPrefixes, ...vocab.consumptionTerms, ...vocab.weightTerms])
    ]
  };
};

const compiledCache = new WeakMap<DomainVocabulary, CompiledLexicon>();

export const compileVocabulary = (vocab: DomainVocabulary): CompiledLexicon => {
  const hit = compiledCache.get(vocab);
  if (hit) return hit;
  const built = compile(vocab);
  compiledCache.set(vocab, built);
  return built;
};

// --- classificacao ---------------------------------------------------------

const detectBucket = (name: string): string | null => {
  const m = name.match(BUCKET_PATTERN);
  return m ? `${m[2]}a${m[3]}` : null;
};

const detectNature = (name: string, lex: CompiledLexicon): ColumnNature => {
  // Meta ganha de tudo. Um falso "actual" aqui faz o modelo responder o
  // orcado como se fosse o resultado obtido.
  if (lex.token(name, lex.vocab.targetTerms)) return "target";
  if (lex.token(name, lex.vocab.actualTerms)) return "actual";
  return null;
};

const detectSex = (name: string, lex: CompiledLexicon): ColumnSex => {
  // Nao ha excecao para nomes como `pct_relacao_mf` (relacao macho/femea, que
  // nao e nem um sexo nem o outro): `mf` nao e token de `fem` nem de `mac`,
  // entao o casamento por limite de token ja devolve null sozinho. Havia uma
  // guarda explicita aqui e ela era codigo morto.
  if (lex.token(name, lex.vocab.femaleTerms)) return "fem";
  if (lex.token(name, lex.vocab.maleTerms)) return "mac";
  return null;
};

/**
 * Primeira regra que casa vence, na ordem em que o seed as declarou. Sem
 * regra nenhuma (motor puro, sem seed) toda coluna sai com `source: null` —
 * que e a resposta honesta: o motor nao tem como inventar procedencia.
 */
const detectSource = (name: string, lex: CompiledLexicon): ColumnSource => {
  for (const rule of lex.vocab.sourceRules) {
    const hit = rule.match === "suffix" ? lex.suffix(name, rule.term) : lex.tokenOne(name, rule.term);
    if (hit) return rule.label;
  }
  return null;
};

const detectPeriod = (name: string, cumulative: boolean, lex: CompiledLexicon): ColumnPeriod => {
  if (cumulative) return "acum";
  if (lex.token(name, lex.vocab.weekTerms)) return "week";
  return null;
};

const detectUnit = (name: string, type: string, lex: CompiledLexicon): ColumnUnit => {
  const v = lex.vocab;

  // Ordem importa: marca de percentual vence radical, e prefixo de contagem
  // vence radical de taxa (`qtd_00a03_mort` e contagem, `mort_00a03_padrao`
  // e taxa).
  if (v.rateMarkers.some((m) => name.startsWith(`${m}_`) || lex.tokenOne(name, m))) return "rate";

  if (lex.prefixOrExact(name, v.countPrefixes)) {
    // Contagem em ponto flutuante com radical de consumo nao e contagem: e
    // massa. `qtd_consumo_femea` e float e mede gramas, nao unidades.
    if (NUMERIC_TYPES.test(type) && FLOAT_TYPES.test(type)) {
      if (lex.token(name, v.consumptionTerms)) return "weight";
    }
    // Nem radical de dinheiro: `total_valor_faturado` e `saldo_custo` sao
    // somas de dinheiro, nao contagens de unidade. Cai para o ramo de moeda
    // logo abaixo em vez de devolver `count` aqui.
    if (!lex.token(name, v.currencyTerms)) return "count";
  }

  // Prefixo de peso tambem vence radical de taxa, pelo mesmo motivo que o
  // prefixo de contagem: em `peso_<algo>_perda_peso` o valor e o peso medio
  // (gramas) usado para CALCULAR a perda, nao a perda em si. Sem esta regra o
  // radical `perda` o classificaria como taxa e a guarda semantica barraria
  // um AVG correto. `meta_perda_peso` continua taxa: nao tem prefixo de peso
  // e e mesmo a meta de perda percentual.
  if (lex.prefixOrExact(name, v.weightPrefixes)) return "weight";

  if (v.ratePhrases.some((p) => name.includes(p))) return "rate";
  if (lex.token(name, v.rateTerms)) return "rate";
  // Depois das taxas: `pct_valor` e uma participacao percentual, nao dinheiro.
  if (lex.token(name, v.currencyTerms)) return "currency";
  if (lex.token(name, v.gramTerms)) return "gram";
  if (lex.token(name, v.kcalTerms)) return "kcal";
  if (lex.token(name, lex.weightTerms)) return "weight";
  if (lex.token(name, v.countNouns)) return "count";

  // Ultimo recurso, e de proposito: prefixo de agregacao nao tem unidade
  // propria, so herda a do radical que soma. Chegar aqui significa que nenhum
  // radical casou, e ai `total_<coisa>` e contagem de coisas.
  //
  // Fica DEPOIS de peso, taxa, moeda e grama porque a ordem e o que separa
  // `total_caixas` (contagem) de `total_peso_liquido` (peso, com casa decimal)
  // e `total_perda` (taxa). Subir esta linha faz a soma de uma coluna de peso
  // virar inteiro e perder os gramas.
  if (lex.prefixOrExact(name, v.aggregatePrefixes)) return "count";

  return null;
};

export const classifyColumn = (
  name: string,
  type: string,
  vocabulary: DomainVocabulary = BUILTIN_PTBR_VOCABULARY
): ColumnClass => {
  const lex = compileVocabulary(vocabulary);
  const v = lex.vocab;
  const n = name.toLowerCase();
  const t = (type ?? "").toLowerCase();

  const bucket = detectBucket(n);
  const cumulative = lex.token(n, v.cumulativeTerms);
  const nature = detectNature(n, lex);
  const sex = detectSex(n, lex);
  const period = detectPeriod(n, cumulative, lex);

  const base = { nature, cumulative, sex, bucket, period };

  // 1. Data — o tipo declarado e mais confiavel que o nome. Pega colunas como
  //    `hor_rec`, que e datetime apesar do prefixo de hora.
  if (DATE_TYPES.test(t) || lex.prefixOrExact(n, v.datePrefixes)) {
    return { ...base, role: "date", unit: null, source: null, matched: true };
  }

  // 2. Chave de juncao.
  if (lex.keyNames.has(n)) {
    return { ...base, role: "key", unit: null, source: null, matched: true };
  }

  // 3. Dimensao por prefixo ou por substantivo conhecido.
  const isDimPrefix = v.dimensionPrefixes.some((p) => n.startsWith(`${p}_`));
  const isDimTerm = lex.token(n, v.dimensionTerms);
  const unit = detectUnit(n, t, lex);

  // Prefixo de dimensao vence: `nro_maq_inc` e o numero da maquina, nao uma
  // medicao feita no incubatorio.
  if (isDimPrefix) {
    return { ...base, role: "dimension", unit: null, source: null, matched: true };
  }

  // 4. Metrica — so aqui `source` faz sentido: ele diz de onde veio a medicao.
  if (unit !== null) {
    return { ...base, role: "metric", unit, source: detectSource(n, lex), matched: true };
  }

  if (isDimTerm) {
    return { ...base, role: "dimension", unit: null, source: null, matched: true };
  }

  // 5. Fallback por tipo declarado. Nao conta como classificado.
  if (TEXT_TYPES.test(t)) {
    return { ...base, role: "dimension", unit: null, source: null, matched: false };
  }
  if (NUMERIC_TYPES.test(t)) {
    return { ...base, role: "metric", unit: null, source: detectSource(n, lex), matched: false };
  }

  return { ...base, role: "unknown", unit: null, source: null, matched: false };
};

export const classifyColumns = (
  columns: readonly ColumnInfo[],
  vocabulary: DomainVocabulary = BUILTIN_PTBR_VOCABULARY
): Array<ColumnInfo & { class: ColumnClass }> =>
  columns.map((c) => ({ ...c, class: classifyColumn(c.name, c.type, vocabulary) }));
