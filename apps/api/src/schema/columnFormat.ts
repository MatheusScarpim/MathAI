import {
  COLUMN_FORMAT_KINDS,
  type ColumnFormat,
  type ColumnFormatKind,
  type ResultColumnMeta
} from "@auraia/shared";
import { classifyColumn, type ColumnClass } from "./lexicon.js";
import { BUILTIN_PTBR_VOCABULARY, type DomainVocabulary } from "./vocabulary.js";

/**
 * Mascara de exibicao por coluna do resultado.
 *
 * O problema: a tabela do chat formatava toda celula igual — um
 * `toLocaleString` cego. Dinheiro saia sem simbolo, taxa sem `%`, e o pior,
 * chave surrogate (`sk_produto` = 1234) saia com separador de milhar e
 * alinhada a direita, indistinguivel de uma medicao.
 *
 * A informacao para resolver isso ja existia: `classifyColumn` sabe se a
 * coluna e chave, data, dinheiro ou contagem. Este modulo so traduz aquela
 * classificacao ESTRUTURAL numa decisao de APRESENTACAO. Nenhuma regra nova de
 * dominio nasce aqui.
 *
 * Duas propriedades importam. Primeira: e deterministico — a mesma pergunta
 * repetida devolve a mesma mascara, o que um agente LLM nao garantiria, e nao
 * custa token nenhum. Segunda: opera sobre o ALIAS que o SQL devolveu, nao
 * sobre a coluna fisica, e funciona porque `classifyColumn` e puro sobre o
 * nome. `SUM(vlr_total) AS VLR_TOTAL_GERAL` casa; um alias inventado fora do
 * vocabulario (`TICKET_MEDIO`) nao casa e cai no fallback — e e exatamente
 * esse caso que a curadoria de seed existe para cobrir.
 *
 * Puro e sem I/O, como `lexicon.ts` e `metrics.ts`: da para testar a matriz
 * inteira sem banco e sem ambiente.
 */

const DEFAULT_DECIMALS: Record<ColumnFormatKind, number | undefined> = {
  currency: 2,
  percent: 1,
  fraction: 1,
  integer: 0,
  decimal: 2,
  gram: 1,
  date: undefined,
  datetime: undefined,
  text: undefined
};

/** Tipos declarados que carregam hora, e por isso pedem `datetime`. */
const TIME_BEARING = /^(datetime|timestamp|smalldatetime|time)/i;

const INTEGER_TYPES = /^(int|bigint|smallint|tinyint)/i;
const NUMERIC_TYPES = /^(int|bigint|smallint|tinyint|numeric|decimal|float|real|money|number|double)/i;

/**
 * Identificador por convencao de nome, para o que o lexico nao reconheceu.
 *
 * Existe porque `classifyColumn` so devolve `role: "key"` para os nomes em
 * `keyNames`, que e uma lista de nome EXATO (`["chave"]` no builtin). Chave
 * surrogate de modelagem dimensional — `sk_produto`, `id_cliente`,
 * `produto_id` — nao casa lista nenhuma, cai no fallback por tipo declarado e
 * saia formatada como medicao. Era o bug que originou este modulo.
 *
 * Nao mexo em `classifyColumn` de proposito: `role` alimenta a poda de schema e
 * as guardas do prompt, e mudar a classificacao para consertar alinhamento de
 * tabela seria pagar risco no lugar errado. Aqui e decisao de APRESENTACAO.
 *
 * Aqui moram SO as convencoes de modelagem dimensional, que nao sao termo de
 * negocio nem de idioma nenhum — mesma natureza dos regex de tipo acima. As
 * formas em portugues (`cod`, `codigo`, `chave`) ficam no vocabulario, onde um
 * seed pode estender; `vocabulary.test.ts` falha se voltarem para ca, e esta
 * exatamente certo em falhar.
 *
 * Casa por LIMITE DE TOKEN, nunca por substring: `idade` nao contem o token
 * `id`, `identificador` nao contem `ide`.
 */
const KEY_TOKEN = /(^|_)(sk|nk|fk|pk|id|ids)(_|$)/i;

const nameTokens = (name: string): string[] => name.toLowerCase().split(/[^a-z0-9]+/i);

/**
 * Nome de identificador, pela convencao estrutural OU pelo vocabulario.
 *
 * Le `identifierPrefixes` em vez de `dimensionPrefixes` porque este julgamento
 * nao pode escapar da apresentacao: `dimensionPrefixes` alimenta `inferJoinKey`,
 * e um prefixo a mais la muda a chave de juncao que o prompt recebe.
 */
const isIdentifierName = (name: string, vocabulary?: DomainVocabulary): boolean => {
  if (KEY_TOKEN.test(name)) return true;
  const prefixes = vocabulary?.identifierPrefixes;
  if (!prefixes || prefixes.length === 0) return false;
  const [head] = nameTokens(name);
  return head !== undefined && prefixes.includes(head);
};

export const isColumnFormatKind = (value: unknown): value is ColumnFormatKind =>
  typeof value === "string" && (COLUMN_FORMAT_KINDS as readonly string[]).includes(value);

/** `true` para mascara que renderiza numero — o frontend alinha a direita. */
export const isNumericKind = (kind: ColumnFormatKind): boolean =>
  kind === "currency" ||
  kind === "percent" ||
  kind === "fraction" ||
  kind === "integer" ||
  kind === "decimal" ||
  kind === "gram";

/**
 * Teto de casas decimais que o `scale` do driver pode pedir.
 *
 * Existe porque `scale` de coluna DERIVADA nao e a verdade do banco: o mssql
 * reporta `scale: 6` para qualquer `SUM(...)` — e o valor sai
 * "159.994,000000" numa contagem de caixas. Tres casas cobrem medicao
 * legitima (peso com grama, taxa fina) e cortam o artefato do agregado.
 */
const MAX_SCALE_DECIMALS = 3;

const withDecimals = (kind: ColumnFormatKind, scale?: number | null): ColumnFormat => {
  const base: ColumnFormat = { kind };
  const fallback = DEFAULT_DECIMALS[kind];

  // Dois kinds tem casa decimal FIXA pela propria natureza, e para eles o
  // `scale` nao e informacao: dinheiro sao dois centavos (decisao do usuario) e
  // inteiro e inteiro. Uma coluna de valor somada num `NUMERIC(38,6)` continua
  // sendo dinheiro, e "R$ 1.234,560000" nao e leitura de dinheiro em lugar
  // nenhum; um `integer` com tres casas seria contradicao no proprio nome.
  if (kind === "currency" || kind === "integer") {
    if (fallback !== undefined) base.decimals = fallback;
    return base;
  }

  // Para os demais o `scale` ainda vale — uma NUMBER(10,0) e inteira mesmo que
  // o nome sugira medicao continua — mas LIMITADO, nunca descartado: com
  // `scale: 6` cair no default de 1 casa perderia mais precisao do que cortar
  // em 3. `scale` em data nao quer dizer casa decimal, entao mascara nao
  // numerica nem olha.
  if (isNumericKind(kind) && typeof scale === "number" && scale >= 0) {
    if (scale === 0 && kind === "decimal") return { kind: "integer", decimals: 0 };
    base.decimals = Math.min(scale, MAX_SCALE_DECIMALS);
  } else if (fallback !== undefined) {
    base.decimals = fallback;
  }

  return base;
};

/**
 * `ColumnClass` -> mascara.
 *
 * A ordem espelha a de `classifyColumn`: `role` decide antes de `unit`, porque
 * uma chave numerica e uma chave mesmo que o nome tenha radical de contagem.
 */
export const formatFromClass = (
  cls: ColumnClass,
  meta: ResultColumnMeta,
  vocabulary?: DomainVocabulary
): ColumnFormat => {
  const type = (meta.type ?? "").toLowerCase();

  // Chave nunca e numero de exibicao. Esta e a regra que conserta o bug mais
  // visivel: sem ela `sk_produto` = 1234 aparecia "1.234".
  if (cls.role === "key") return { kind: "text" };

  // Chave que o lexico nao nomeou. So vale quando ele nao reconheceu NADA
  // (`matched: false`) — assim uma classificacao real nunca e sobrescrita por
  // heuristica de nome, e `qtd_pk_ovos` continuaria contagem se existisse.
  if (!cls.matched && isIdentifierName(meta.name, vocabulary)) return { kind: "text" };

  if (cls.role === "date") {
    return { kind: TIME_BEARING.test(type) ? "datetime" : "date" };
  }

  switch (cls.unit) {
    case "currency":
      return withDecimals("currency", meta.scale);
    // O lexico so tem `rate`; a distincao 0.875 vs 87.5 nao esta no nome, e
    // assumir `percent` e a aposta certa para nomenclatura `pct_*`/`tx_*`
    // brasileira. Quem grava fracao corrige pelo seed.
    case "rate":
      return withDecimals("percent", meta.scale);
    case "count":
      return { kind: "integer", decimals: 0 };
    // `gram` e `weight` NAO colapsam. `gram` vem de `gramTerms`, onde o nome
    // diz a unidade. `weight` vem de `weightPrefixes` (`peso`, `pm`), onde o
    // nome diz que e MASSA e cala a unidade — e num DW de frigorifico
    // `peso_bruto_produzido` esta em kg. Marcar isso como grama saia errado por
    // 1000x, com o "g" na tela contradizendo o "kg" que o proprio resumo em
    // prosa escrevia. Numero certo sem unidade e melhor que numero errado com
    // unidade; quem sabe a unidade declara pelo seed.
    case "gram":
      return withDecimals("gram", meta.scale);
    case "weight":
      return withDecimals("decimal", meta.scale);
    case "kcal":
      return { kind: "decimal", decimals: 0, suffix: "kcal" };
    case null:
      break;
  }

  if (cls.role === "dimension") return { kind: "text" };

  // Metrica sem unidade reconhecida: da para dizer que e numero, nao da para
  // dizer de que. `decimal` e o unico palpite honesto.
  if (cls.role === "metric") {
    if (INTEGER_TYPES.test(type)) return { kind: "integer", decimals: 0 };
    return withDecimals("decimal", meta.scale);
  }

  if (NUMERIC_TYPES.test(type)) return withDecimals("decimal", meta.scale);

  return { kind: "text" };
};

/**
 * Ultima camada: nem nome nem tipo declarado disseram nada, entao olha o dado.
 *
 * Existe porque duas fontes chegam sem tipo: hit de cache antigo (que so
 * guardou `columns: string[]`) e o modo API, onde a resposta e JSON e nao tem
 * metadata de driver. Sem isso o numero cru vazaria sem separador de milhar.
 *
 * Le so a PRIMEIRA linha: aqui a pergunta e "que especie de coisa e isto",
 * e para isso um exemplar basta.
 */
const formatFromSample = (
  name: string,
  samples: readonly Record<string, unknown>[] | undefined
): ColumnFormat | null => {
  const sample = samples?.[0];
  if (!sample) return null;
  const value = sample[name];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? { kind: "integer", decimals: 0 } : { kind: "decimal", decimals: 2 };
  }
  if (value instanceof Date) return { kind: "datetime" };
  return null;
};

/**
 * Quantas linhas a checagem de integralidade varre.
 *
 * Diferente de `formatFromSample`, aqui uma linha NAO basta: a pergunta e
 * "esta coluna INTEIRA e inteira", e uma unica contra-amostra derruba a
 * resposta. Cinquenta linhas e o suficiente para pegar a fracao que aparece no
 * meio do resultado sem varrer paginas inteiras a toa.
 */
const SAMPLE_SCAN_LIMIT = 50;

/**
 * Numero a partir do que o driver devolveu.
 *
 * Aceita string porque o mssql manda `BIGINT` e `DECIMAL` grandes como string
 * para nao perder precisao, e o pg faz o mesmo com `numeric`. Sem isto a coluna
 * de contagem que chega como `"585293"` nunca seria reconhecida como inteira.
 * Espelha o `toNumber` do frontend (`utils/formatters.ts`).
 */
const numericValue = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * `true` quando todo valor observado da coluna e inteiro.
 *
 * Existe porque o `scale` de coluna DERIVADA mente: o mssql reporta `scale: 6`
 * para qualquer `SUM(...)`, e uma contagem de caixas saia "585.293,000". O
 * nome tambem nao ajuda quando o modelo inventa o alias — `CaixasProduzidas`
 * nao casa termo nenhum do lexico. Sobra o dado, que e a unica fonte que sabe
 * a diferenca entre uma contagem e uma medicao continua.
 *
 * Nulo nao conta contra: coluna de contagem com buraco continua contagem. Mas
 * coluna SO de nulos devolve `false` — sem nenhum valor observado nao ha o que
 * afirmar, e o palpite do tipo declarado e melhor que um chute.
 */
const allIntegral = (
  name: string,
  samples: readonly Record<string, unknown>[] | undefined
): boolean => {
  if (!samples?.length) return false;

  let observed = false;
  const limit = Math.min(samples.length, SAMPLE_SCAN_LIMIT);

  for (let i = 0; i < limit; i += 1) {
    const value = samples[i]?.[name];
    if (value === null || value === undefined) continue;

    const parsed = numericValue(value);
    // Valor que nem numero e (texto, objeto) tira a base da afirmacao.
    if (parsed === null || !Number.isInteger(parsed)) return false;
    observed = true;
  }

  return observed;
};

/**
 * Alias quebrado nas fronteiras de caixa, para o lexico enxergar os tokens.
 *
 * `ValorReais` -> `valor_reais`, `PesoLiquidoKg` -> `peso_liquido_kg`,
 * `SKProduto` -> `sk_produto`.
 */
const toSnake = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Za-z])(\d)/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();

/**
 * Classificacao para fim de mascara, tolerante a alias em CamelCase.
 *
 * `tokenRegex` no lexico delimita token por `_` ou pela borda do nome, entao em
 * `ValorReais` o termo `valor` nao casa: a coluna chega `matched: false` e cai
 * no fallback por tipo — foi assim que uma coluna de dinheiro perdeu o `R$`. E
 * `SELECT ... AS ValorReais` e o que o modelo escreve naturalmente.
 *
 * A correcao fica AQUI e nao em `tokenRegex` de proposito. Aquele regex
 * alimenta as guardas semanticas do prompt, a poda de schema, `inferJoinKey` e
 * `grainCandidates`; alargar a tokenizacao para consertar a formatacao de uma
 * tabela seria pagar risco no lugar errado. Mesma decisao ja registrada em
 * `isIdentifierName`.
 *
 * Uma tentativa so, e so quando a primeira nao reconheceu nada. O nome
 * convertido volta junto porque `formatFromClass` e a checagem de identificador
 * tambem precisam ver os tokens — mas `formatFromSample` continua usando o nome
 * ORIGINAL, que e a chave real da linha.
 */
const classifyForFormat = (
  meta: ResultColumnMeta,
  vocabulary: DomainVocabulary
): { cls: ColumnClass; name: string } => {
  const type = meta.type ?? "";
  const cls = classifyColumn(meta.name, type, vocabulary);
  if (cls.matched) return { cls, name: meta.name };

  const snake = toSnake(meta.name);
  if (snake === meta.name.toLowerCase()) return { cls, name: meta.name };

  const retry = classifyColumn(snake, type, vocabulary);
  if (retry.matched || isIdentifierName(snake, vocabulary)) return { cls: retry, name: snake };

  return { cls, name: meta.name };
};

export type ResolveFormatsOptions = {
  vocabulary?: DomainVocabulary;
  /** Curadoria do seed, chaveada por nome de coluna em minusculas. */
  overrides?: Readonly<Record<string, ColumnFormatKind>>;
  /**
   * Linhas do resultado, para as duas camadas que consultam o dado.
   *
   * E a lista inteira, nao a primeira linha: decidir se uma coluna e inteira
   * exige ver mais de um valor, senao uma fracao na linha 5 seria arredondada
   * e desapareceria da tela.
   */
  samples?: readonly Record<string, unknown>[];
};

/**
 * Mascara de cada coluna, em tres camadas: seed > lexico > tipo/valor.
 *
 * O seed vence tudo porque e a unica camada que sabe o que nenhuma heuristica
 * alcanca — a escala em que a taxa foi gravada, e o significado de um alias
 * que o modelo inventou.
 */
export const resolveColumnFormats = (
  columns: readonly ResultColumnMeta[],
  opts: ResolveFormatsOptions = {}
): Record<string, ColumnFormat> => {
  const vocabulary = opts.vocabulary ?? BUILTIN_PTBR_VOCABULARY;
  const overrides = opts.overrides ?? {};
  const out: Record<string, ColumnFormat> = {};

  for (const meta of columns) {
    if (!meta?.name) continue;

    const curated = overrides[meta.name.toLowerCase()];
    if (curated) {
      out[meta.name] = withDecimals(curated, meta.scale);
      continue;
    }

    const { cls, name: lexName } = classifyForFormat(meta, vocabulary);
    const derived = formatFromClass(cls, { ...meta, name: lexName }, vocabulary);

    // O lexico so perde a vez quando nao reconheceu nada: `matched: false` com
    // `text` significa "nao sei", e ai o dado real decide.
    //
    // Chave reconhecida por convencao de nome NAO entra aqui: ela tambem chega
    // com `matched: false` e `text`, e o dado real de uma chave e um numero —
    // o fallback por valor a devolveria para `integer` e desfaria a correcao.
    if (!cls.matched && derived.kind === "text" && !isIdentifierName(lexName, vocabulary)) {
      out[meta.name] = formatFromSample(meta.name, opts.samples) ?? derived;
      continue;
    }

    // Contagem que se passou por medicao continua.
    //
    // `decimal` e o palpite de quem nao sabe: ou o lexico nao reconheceu o
    // radical, ou o `scale` do driver veio de um agregado. Quando o lexico
    // reconheceu algo — `weight`, `currency`, `rate` — a classificacao vale e
    // esta regra nem olha, senao `PesoLiquidoProduzidoKg` perderia os gramas
    // toda vez que o resultado calhasse de ter so valores redondos.
    if (!cls.matched && derived.kind === "decimal" && allIntegral(meta.name, opts.samples)) {
      out[meta.name] = { kind: "integer", decimals: 0 };
      continue;
    }

    out[meta.name] = derived;
  }

  return out;
};

/**
 * Conveniencia para quem so tem `columns: string[]` — hit de cache antigo e
 * modo API. Sem tipo declarado o lexico ainda classifica pelo nome, que e a
 * fonte principal de qualquer forma.
 */
export const resolveColumnFormatsFromNames = (
  columns: readonly string[],
  opts: ResolveFormatsOptions = {}
): Record<string, ColumnFormat> =>
  resolveColumnFormats(
    columns.map((name) => ({ name, type: "" })),
    opts
  );
