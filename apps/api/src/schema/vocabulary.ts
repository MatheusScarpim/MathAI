/**
 * Fronteira entre o MOTOR e o DOMINIO.
 *
 * A ferramenta e generica: qualquer banco, qualquer cliente. O que ela pode
 * saber de antemao sao CONVENCOES DE NOMENCLATURA PT-BR — `qtd_`, `pct_`,
 * `dat_`, `cod_`, `_padrao`, `_acum`, `_obtido`. Essas convencoes nao sao de
 * nenhum cliente: sao como bancos brasileiros nomeiam coluna ha decadas, e
 * embuti-las faz um banco novo render classificacao util no primeiro ingest,
 * com zero configuracao.
 *
 * O que NAO pode estar aqui e vocabulario de negocio — `eclosao`, `ovosc`,
 * `granja`, `racao`. Isso e dado, entra por seed por ambiente (ver
 * `seed.ts`), fica no Mongo e nunca no bundle.
 *
 * A regra pratica para decidir onde um termo mora: se ele so faz sentido
 * depois de saber QUAL e o negocio do cliente, e seed.
 */

/**
 * Como um termo marca a procedencia de uma medicao.
 *
 * `token` casa em qualquer posicao delimitada por `_`; `suffix` exige que o
 * termo seja o ULTIMO token. A distincao existe porque abreviacoes curtas
 * (`inc`, `gra`) aparecem no meio de outras palavras e casariam demais — o
 * mesmo ovo e contado na granja e no incubatorio, e os dois numeros divergem
 * de proposito, entao errar aqui troca um numero por outro sem erro de SQL.
 */
export type SourceMatch = "token" | "suffix";

export type SourceRule = {
  /** Radical procurado no nome da coluna. */
  term: string;
  /** Valor gravado em `ColumnClass.source`. */
  label: string;
  match: SourceMatch;
};

/**
 * Todo campo e uma lista de termos consumida pelo lexico. O seed do dominio
 * tem a mesma forma e e MESCLADO por cima (concatenacao, nunca substituicao):
 * um cliente pode acrescentar vocabulario, nunca apagar as convencoes PT-BR.
 *
 * Tudo aqui e serializavel em JSON de proposito — o seed e um arquivo de
 * dados e o mesmo objeto viaja para o Mongo sem conversao.
 */
export type DomainVocabulary = {
  /** Metricas expressas como taxa/indice. Nao somaveis; media simples tambem
   *  mente — o certo e SUM(numerador)/SUM(denominador). */
  rateTerms: readonly string[];
  /** Radicais compostos de razao, casados como substring (`ovo_ave`). */
  ratePhrases: readonly string[];
  /** Marca explicita de percentual. `pct` cobre `pct_` e `_pct_`. */
  rateMarkers: readonly string[];
  /** Termos que, como PRIMEIRO token, declaram peso mesmo contra radical de
   *  taxa. Ver a nota de precedencia em `detectUnit`. */
  weightPrefixes: readonly string[];
  /** Consumo. Em coluna de ponto flutuante convertem contagem em peso. */
  consumptionTerms: readonly string[];
  /** Pesos que nao sao prefixo nem consumo. Normalmente vazio. */
  weightTerms: readonly string[];
  /** Dinheiro. Somavel como contagem, mas nunca a mesma coisa: misturar
   *  quantidade e valor num mesmo SUM e erro que nao gera erro. */
  currencyTerms: readonly string[];
  gramTerms: readonly string[];
  kcalTerms: readonly string[];
  /** Prefixos que declaram contagem absoluta. */
  countPrefixes: readonly string[];
  /** Substantivos contaveis sem prefixo algum. */
  countNouns: readonly string[];
  /**
   * Prefixos de AGREGACAO, que nao declaram unidade propria: herdam a do
   * radical que somam. `total_peso_liquido` e peso, `total_valor` e dinheiro,
   * `total_perda` e taxa — e `total_caixas`, onde nada mais casa, e contagem.
   *
   * Separado de `countPrefixes` de proposito. `qtd` DECLARA contagem e por
   * isso vence radical de taxa (`qtd_00a03_mort` e contagem, nao mortalidade);
   * `total` nao declara nada, e trata-lo como contagem faz a soma de uma
   * coluna de peso perder as casas decimais.
   */
  aggregatePrefixes: readonly string[];
  /** Prefixos que declaram dimensao. Vencem qualquer radical de metrica. */
  dimensionPrefixes: readonly string[];
  /** Substantivos de dimensao sem prefixo. Sem eles a coluna cai no fallback
   *  por tipo e a cobertura medida fica falsa. */
  dimensionTerms: readonly string[];
  /** Prefixos de data (alem do tipo declarado, que sempre vence). */
  datePrefixes: readonly string[];
  /** Nomes que sao chave de juncao. Comparados inteiros, nao por radical. */
  keyNames: readonly string[];
  /**
   * Prefixos que denunciam identificador, para fins de EXIBICAO apenas.
   *
   * Existe separado de `dimensionPrefixes` de proposito. Este campo e lido so
   * por `columnFormat.ts`, para decidir que a coluna nao leva separador de
   * milhar. `dimensionPrefixes` alimenta `grainCandidates` e `inferJoinKey`
   * (`tableFacts.ts`), e por ali um prefixo a mais muda a chave de juncao que
   * vai no prompt: com `codigo` la dentro, `codigo_barras` passava a disputar a
   * juncao de uma tabela cuja chave real e `cod_lote`. Consertar alinhamento de
   * tabela nao vale esse preco.
   */
  identifierPrefixes: readonly string[];
  /** Meta da linhagem / orcado. Nunca o realizado. */
  targetTerms: readonly string[];
  actualTerms: readonly string[];
  /** Acumulado ate a linha. Somar entre linhas dupla-conta. */
  cumulativeTerms: readonly string[];
  weekTerms: readonly string[];
  femaleTerms: readonly string[];
  maleTerms: readonly string[];
  sourceRules: readonly SourceRule[];
  /** Faixas que JA CONTEM outras: somar pai e filhos dupla-conta. */
  overlappingBuckets: Readonly<Record<string, readonly string[]>>;
  /** Frases livres injetadas no prompt (E4). Onde mora, por exemplo, o aviso
   *  de que `idade` e semana de vida e nao ano. */
  notes: readonly string[];
};

/**
 * Convencoes PT-BR. Nenhum termo daqui depende do negocio do cliente.
 *
 * Regra de manutencao: so entra aqui termo que um DBA brasileiro qualquer
 * reconheceria fora de contexto. `acum`, `padrao`, `qtd` passam. `eclosao`,
 * `racao` nao — mesmo sendo palavras comuns, o significado de METRICA delas
 * so existe dentro de um dominio.
 */
export const BUILTIN_PTBR_VOCABULARY: DomainVocabulary = {
  rateTerms: [
    "unif",
    "uniformidade",
    "cv",
    "densidade",
    "aprov",
    "aproveitamento",
    "relacao",
    "perda"
  ],
  ratePhrases: ["coef_varicacao", "coef_variacao"],
  rateMarkers: ["pct"],
  weightPrefixes: ["peso", "pm"],
  consumptionTerms: ["cons", "consumo"],
  weightTerms: [],
  // Coluna de dinheiro existe em praticamente todo banco de negocio, e nao
  // depende de saber QUAL negocio e — por isso e convencao, nao dominio.
  currencyTerms: ["valor", "vlr", "custo", "preco", "receita", "faturamento"],
  gramTerms: ["grama"],
  kcalTerms: [],
  // `qtde_` e `qtd_` convivem no mesmo banco, as vezes na mesma tabela.
  // `total` nao e redundante com `tot`: `prefixOrExact` casa nome EXATO ou
  // `<termo>_`, entao `tot` nao alcanca `total_caixas_produzidas` — e a
  // contagem caia no fallback por tipo e saia com casa decimal.
  countPrefixes: ["qtd", "qtde", "amostra", "tot", "saldo"],
  countNouns: [],
  aggregatePrefixes: ["total"],
  dimensionPrefixes: ["cod", "nro", "ide", "nom", "tip", "tipo"],
  dimensionTerms: [
    "situacao",
    "local",
    "propriedade",
    "faixa",
    "sexo",
    "modelo",
    "classe",
    "grupo",
    "depto",
    "dias",
    "recebido",
    // flag "e da propria empresa" (bit), nao metrica
    "proprio",
    // Tratar `idade` como DIMENSAO, e nao metrica, e uma decisao generica: em
    // qualquer banco ela e um eixo de agrupamento. O que ela SIGNIFICA
    // (semana de vida, ano, anos de pessoa) e dominio e vem em `notes`.
    "idade"
  ],
  datePrefixes: ["dat", "data"],
  // `chave` e literalmente "key" em portugues.
  keyNames: ["chave"],
  // `cod` ja e `dimensionPrefix` e viraria texto de qualquer forma; esta aqui
  // para a lista ser legivel por si, sem depender de outra. `codigo` e a forma
  // por extenso, que convive com a abreviacao no mesmo banco.
  identifierPrefixes: ["cod", "codigo"],
  targetTerms: ["padrao", "pad", "meta"],
  actualTerms: ["obtido", "obtida", "real", "realizado", "obt"],
  // `acum` e a abreviacao que o schema do cliente usa; as formas por extenso
  // entram porque `token()` casa por limite de token, nao por prefixo — sem
  // elas uma coluna `mortalidade_acumulada` escapava da guarda de acumulado.
  cumulativeTerms: ["acum", "acumulado", "acumulada"],
  weekTerms: ["sem", "semana"],
  femaleTerms: ["fem", "femea", "femeas"],
  maleTerms: ["mac", "macho", "machos"],
  // Procedencia e sempre dominio: depende de onde o cliente mede.
  sourceRules: [],
  overlappingBuckets: {},
  notes: []
};

/** Campos de lista de `DomainVocabulary`, para mesclar sem repetir nome. */
const LIST_FIELDS = [
  "rateTerms",
  "ratePhrases",
  "rateMarkers",
  "weightPrefixes",
  "consumptionTerms",
  "weightTerms",
  "currencyTerms",
  "gramTerms",
  "kcalTerms",
  "countPrefixes",
  "countNouns",
  "aggregatePrefixes",
  "dimensionPrefixes",
  "dimensionTerms",
  "datePrefixes",
  "keyNames",
  "identifierPrefixes",
  "targetTerms",
  "actualTerms",
  "cumulativeTerms",
  "weekTerms",
  "femaleTerms",
  "maleTerms",
  "notes"
] as const satisfies readonly (keyof DomainVocabulary)[];

type ListField = (typeof LIST_FIELDS)[number];

/** Um seed pode preencher qualquer subconjunto. O que faltar vem do builtin. */
export type PartialVocabulary = Partial<{
  [K in ListField]: readonly string[];
}> & {
  sourceRules?: readonly SourceRule[];
  overlappingBuckets?: Readonly<Record<string, readonly string[]>>;
};

const dedupe = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * Mescla ADITIVA: as convencoes PT-BR vem primeiro e nunca sao removidas.
 *
 * Nao ha modo "substituir". Um seed que pudesse apagar `padrao` da lista de
 * metas faria o motor responder a meta da linhagem como se fosse o realizado
 * — o tipo de erro que devolve numero errado com SQL perfeito. Se um termo
 * builtin atrapalhar um cliente, ele esta errado como convencao e sai daqui,
 * nao do seed.
 *
 * `sourceRules` e a excecao a ordem: o builtin nao tem nenhuma, entao a ordem
 * do seed e preservada — e ela IMPORTA, a primeira regra que casa vence.
 */
export const mergeVocabulary = (
  base: DomainVocabulary,
  extra?: PartialVocabulary
): DomainVocabulary => {
  if (!extra) return base;

  const merged = { ...base } as { [K in ListField]: readonly string[] } & DomainVocabulary;
  for (const field of LIST_FIELDS) {
    const added = extra[field];
    merged[field] = added ? dedupe([...base[field], ...added]) : base[field];
  }

  return {
    ...merged,
    sourceRules: [...base.sourceRules, ...(extra.sourceRules ?? [])],
    overlappingBuckets: { ...base.overlappingBuckets, ...(extra.overlappingBuckets ?? {}) }
  };
};

/** Vocabulario efetivo: convencoes PT-BR + o que o ambiente acrescentou. */
export const resolveVocabulary = (extra?: PartialVocabulary): DomainVocabulary =>
  mergeVocabulary(BUILTIN_PTBR_VOCABULARY, extra);
