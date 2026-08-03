import { __testing } from "../core/validation.js";
import type { DbType } from "../core/appConfig.js";
import type { ClassifiedError } from "./sqlErrors.js";
import type { ColumnClass } from "../schema/lexicon.js";
import type { TableFacts } from "../schema/tableFacts.js";
import type { DictionaryIndex } from "../schema/dictionaryOps.js";

/**
 * Guardas semanticas: barram SQL que o banco aceitaria de bom grado.
 *
 * O loop de retry so acorda quando o banco reclama. Mas a classe de erro que
 * mais custa caro nao gera erro nenhum: `AVG` de um percentual, `SUM` de uma
 * coluna acumulada, filtro de periodo na data errada. O banco devolve 200, um
 * numero bem formatado sai na tela, e ninguem descobre que esta errado.
 *
 * Estas guardas rodam ANTES de executar. Elas nao sabem qual foi a pergunta —
 * so olham o SQL contra o que o dicionario ja sabe das colunas. Por isso a
 * regra de projeto e uma so: SILENCIO NA DUVIDA. Um falso positivo queima uma
 * tentativa de retry e pode fazer o motor desistir de um SQL correto, que e
 * pior do que deixar passar o caso ambiguo. Toda heuristica abaixo escolhe
 * explicitamente o falso negativo.
 *
 * Nao ha vocabulario de dominio aqui — as guardas operam sobre `ColumnClass`
 * e `TableFacts`, que o dicionario ja derivou do seed do ambiente.
 */

/** Guardas com aviso o bastante para o modelo consertar sozinho. */
export type SemanticGuardOptions = {
  dbType?: DbType;
  /**
   * Faixas que JA CONTEM outras (`{"00a07": ["00a03", "04a07"]}`). Vem do
   * vocabulario do ambiente; vazio desliga a guarda 3, que e o certo quando
   * ninguem declarou quais faixas se contem.
   */
  overlappingBuckets?: Readonly<Record<string, readonly string[]>>;
};

// --- varredura lexica -------------------------------------------------------

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_$#]*/g;

/**
 * Corta o segmento numa virgula ou numa palavra reservada.
 *
 * NAO corta em parenteses de proposito: `SUM(a) + SUM(b)` e `SUM(a + b)` sao
 * o mesmo erro e precisam cair no mesmo segmento. O que a lista separa e
 * `SUM(a), SUM(b)` — duas colunas de um detalhamento lado a lado, que e uso
 * legitimo e nao pode ser barrado.
 */
const SEGMENT_KEYWORDS: ReadonlySet<string> = new Set([
  "select", "from", "where", "group", "order", "having", "by",
  "and", "or", "not", "on", "join", "inner", "left", "right", "full",
  "outer", "cross", "apply", "case", "when", "then", "else", "end",
  "over", "partition", "union", "except", "intersect", "as", "distinct",
  "top", "offset", "fetch", "rows", "row", "only", "limit", "with"
]);

const identifiersIn = (text: string): string[] =>
  (text.match(IDENTIFIER) ?? []).map((t) => t.toLowerCase());

/** Conteudo do parenteses aberto em `open`, respeitando aninhamento. */
const argumentAt = (code: string, open: number): string | null => {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return null;
};

type Aggregate = { fn: "sum" | "avg"; arg: string };

/**
 * Apaga o trecho entre `WHEN` e `THEN`, preservando o comprimento.
 *
 * Dentro de um agregado, a condicao de um `CASE` nao e agregada: em
 * `SUM(CASE WHEN acumulada > 0 THEN 1 ELSE 0 END)` quem e somado e o `1`, e a
 * coluna acumulada e so um filtro. Ler os identificadores do predicado faria
 * as guardas 1 e 2 barrarem uma contagem condicional legitima.
 */
const withoutCasePredicates = (text: string): string =>
  text.replace(/\bwhen\b[\s\S]*?\bthen\b/gi, (m) => " ".repeat(m.length));

const aggregatesIn = (code: string): Aggregate[] => {
  const out: Aggregate[] = [];
  const re = /\b(sum|avg)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const arg = argumentAt(code, open);
    if (arg !== null) {
      out.push({ fn: m[1]!.toLowerCase() as "sum" | "avg", arg: withoutCasePredicates(arg) });
    }
  }
  return out;
};

type AdditiveTerm = { sign: 1 | -1; text: string };

/**
 * Quebra o segmento nos `+` e `-` de primeiro nivel, guardando o sinal.
 *
 * As guardas 3 e 6 acusam SOMA, nao comparacao. `realizado - meta` e desvio,
 * `pai - filho` e complemento: os dois sao uso canonico. Sem o sinal, basta um
 * `+` em qualquer lugar do segmento para as duas naturezas caírem juntas no
 * mesmo balde e serem acusadas de uma soma que ninguem escreveu.
 */
const additiveTerms = (segment: string): AdditiveTerm[] => {
  const out: AdditiveTerm[] = [];
  let depth = 0;
  let start = 0;
  let sign: 1 | -1 = 1;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === "+" || ch === "-")) {
      out.push({ sign, text: segment.slice(start, i) });
      sign = ch === "+" ? 1 : -1;
      start = i + 1;
    }
  }
  out.push({ sign, text: segment.slice(start) });
  return out;
};

/** Trechos que somam coisas. So estes interessam as guardas 3 e 6. */
const additiveSegments = (code: string): string[] => {
  const out: string[] = [];
  let start = 0;
  const push = (end: number): void => {
    const s = code.slice(start, end);
    if (s.includes("+")) out.push(s);
  };
  const re = /[A-Za-z_][A-Za-z0-9_$#]*|,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const tok = m[0];
    if (tok === "," || SEGMENT_KEYWORDS.has(tok.toLowerCase())) {
      push(m.index);
      start = m.index + tok.length;
    }
  }
  push(code.length);
  return out;
};

const whereRegion = (code: string): string => {
  const m = /\bwhere\b/i.exec(code);
  if (!m) return "";
  const rest = code.slice(m.index + m[0].length);
  const stop = /\b(group\s+by|order\s+by|having|union|except|intersect)\b/i.exec(rest);
  return stop ? rest.slice(0, stop.index) : rest;
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- resolucao de coluna ----------------------------------------------------

/**
 * A classe de uma coluna citada sem qualificador.
 *
 * Procura em TODAS as tabelas referenciadas e exige consenso: se duas tabelas
 * tem uma coluna de mesmo nome e classes diferentes, nao da para saber de qual
 * o SQL falava, entao devolve `null` e a guarda se cala. Errar aqui barraria
 * SQL correto.
 */
const makeResolver = (
  referenced: readonly TableFacts[],
  dictionary: DictionaryIndex
): ((column: string) => ColumnClass | null) => {
  const cache = new Map<string, ColumnClass | null>();

  return (column: string): ColumnClass | null => {
    const key = column.toLowerCase();
    if (cache.has(key)) return cache.get(key) ?? null;

    let agreed: ColumnClass | null = null;
    for (const t of referenced) {
      const cls = dictionary.column(t.tableFullName, key)?.class;
      if (!cls) continue;
      if (agreed === null) {
        agreed = cls;
        continue;
      }
      const same =
        agreed.cumulative === cls.cumulative &&
        agreed.unit === cls.unit &&
        agreed.nature === cls.nature &&
        agreed.bucket === cls.bucket &&
        agreed.role === cls.role;
      if (!same) {
        agreed = null;
        break;
      }
    }
    cache.set(key, agreed);
    return agreed;
  };
};

/** Colunas do trecho que o dicionario conhece, ja com a classe resolvida. */
const classifiedIn = (
  text: string,
  resolve: (column: string) => ColumnClass | null
): Array<{ name: string; cls: ColumnClass }> => {
  const out: Array<{ name: string; cls: ColumnClass }> = [];
  const seen = new Set<string>();
  for (const name of identifiersIn(text)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const cls = resolve(name);
    if (cls) out.push({ name, cls });
  }
  return out;
};

const HAS_ARITHMETIC = /[+\-*/]/;

// --- forma de filtro de periodo ---------------------------------------------

/**
 * Funcoes de data dos dialetos suportados. Sao nomes de SQL, nao de dominio.
 */
const DATE_FUNCTION =
  /^(year|month|day|quarter|week|datepart|datename|dateadd|datediff|getdate|sysdate|systimestamp|current_date|current_timestamp|now|trunc|to_date|to_timestamp|to_char|extract|add_months|last_day|months_between|convert|cast)$/i;

const COMPARISON_AHEAD = /^\s*(>=|<=|<>|!=|>|<|=)/;
const BETWEEN_AHEAD = /^\s*between\b/i;
const OPERAND_STOP = /\b(and|or|not|group|order|having|union|except|intersect)\b/i;

/**
 * A coluna aparece no WHERE numa forma que e mesmo recorte de periodo?
 *
 * Existe uma diferenca cara entre CITAR uma data e FILTRAR por ela.
 * `dat_x IS NULL` testa presenca, `dat_x = dat_y` e juncao: nenhum dos dois
 * recorta periodo, e acusa-los faz a guarda 4 mandar trocar a coluna, o que
 * reescreve a pergunta e devolve um numero certo para a pergunta errada.
 *
 * Como `scanSql` ja apagou os literais, nao da para olhar o valor comparado —
 * a decisao e pela FORMA. Operando vazio significa literal apagado, ou seja,
 * comparacao com constante: e filtro. Operando com nome de coluna e juncao.
 */
const usedAsPeriodFilter = (where: string, column: string): boolean => {
  const re = new RegExp(
    `(^|[^A-Za-z0-9_$#.])${escapeRegExp(column)}([^A-Za-z0-9_$#]|$)`,
    "gi"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(where)) !== null) {
    const after = where.slice(m.index + m[0].length - (m[2]?.length ?? 0));
    if (BETWEEN_AHEAD.test(after)) return true;
    const op = COMPARISON_AHEAD.exec(after);
    if (!op) continue;
    const rest = after.slice(op[0].length);
    const stop = OPERAND_STOP.exec(rest);
    const operand = stop ? rest.slice(0, stop.index) : rest;
    // Vazio (literal apagado) ou so funcao de data: constante temporal.
    if (identifiersIn(operand).every((id) => DATE_FUNCTION.test(id))) return true;
  }
  // `TRUNC(dat_x)`, `YEAR(dat_x)`, `EXTRACT(... FROM dat_x)`: a coluna esta
  // dentro de uma funcao de data, e o filtro recai sobre o resultado dela.
  const fn = /\b([A-Za-z_][A-Za-z0-9_$#]*)\s*\(/g;
  let f: RegExpExecArray | null;
  while ((f = fn.exec(where)) !== null) {
    if (!DATE_FUNCTION.test(f[1]!)) continue;
    const arg = argumentAt(where, f.index + f[0].length - 1);
    if (arg && identifiersIn(arg).includes(column.toLowerCase())) return true;
  }
  return false;
};

/** Nomes que o dicionario conhece como data em ALGUMA tabela. */
const dateColumnNames = (dictionary: DictionaryIndex): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const rec of dictionary.all) {
    if (rec.columnName && rec.class?.role === "date") out.add(rec.columnName.toLowerCase());
  }
  return out;
};

/**
 * Algum `BETWEEN` do WHERE recorta periodo?
 *
 * `BETWEEN` e o unico operador de intervalo que serve tanto para data quanto
 * para numero — `cod_lote BETWEEN 1 AND 10` nao tem nada de temporal. Por isso
 * so conta quando o operando da esquerda e reconhecidamente uma data.
 *
 * A consulta ao dicionario inteiro (e nao so as tabelas citadas) e de proposito:
 * o caso que a guarda 5 existe para pegar e justamente o filtro por uma data
 * que NAO pertence a tabela consultada.
 */
const betweenIsTemporal = (where: string, dateNames: ReadonlySet<string>): boolean => {
  const re = /\bbetween\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(where)) !== null) {
    const before = where.slice(0, m.index);
    const last = /([A-Za-z_][A-Za-z0-9_$#]*)\s*\)?\s*$/.exec(before);
    if (!last) continue;
    const name = last[1]!.toLowerCase();
    if (DATE_FUNCTION.test(name) || dateNames.has(name)) return true;
  }
  return false;
};

// --- guardas ----------------------------------------------------------------

const reject = (
  category: ClassifiedError["category"],
  what: string,
  hint: string
): ClassifiedError => ({
  category,
  originalMessage: `guarda semantica: ${what}`,
  hint
});

export const checkSemanticGuards = (
  sql: string,
  tables: readonly TableFacts[],
  dictionary: DictionaryIndex,
  options: SemanticGuardOptions = {}
): ClassifiedError | null => {
  if (tables.length === 0 || dictionary.all.length === 0) return null;

  // Literais e comentarios viram espaco preservando offset: um nome de coluna
  // dentro de uma string nao e uso da coluna, e um `-- SUM(x)` comentado nao
  // e agregacao nenhuma.
  const scanned = __testing.scanSql(sql, options.dbType ?? "sqlserver");
  // Colchetes/aspas de identificador atrapalham o casamento de nome de tabela
  // e nao carregam significado aqui.
  const code = scanned.code.replace(/[[\]"`]/g, " ");

  const referenced = referencedTables(code, tables);
  if (referenced.length === 0) return null;

  const resolve = makeResolver(referenced, dictionary);
  const aggregates = aggregatesIn(code);
  const segments = additiveSegments(code);
  const where = whereRegion(code);

  return (
    guardCumulativeAggregate(aggregates, resolve) ??
    guardRateAggregate(aggregates, resolve) ??
    guardOverlappingBuckets(segments, resolve, options.overlappingBuckets ?? {}) ??
    guardMixedNature(segments, resolve) ??
    guardWrongEventDate(where, referenced) ??
    guardMissingPeriodJoin(where, referenced, code, resolve, dateColumnNames(dictionary))
  );
};

/**
 * Quais tabelas o SQL cita. Sem isso toda coluna do banco seria candidata e
 * a resolucao por consenso viraria ruido.
 */
const referencedTables = (
  code: string,
  tables: readonly TableFacts[]
): TableFacts[] => {
  const bareCount = new Map<string, number>();
  for (const t of tables) {
    const bare = t.tableFullName.split(".").pop()!.toLowerCase();
    bareCount.set(bare, (bareCount.get(bare) ?? 0) + 1);
  }

  const mentions = (name: string): boolean =>
    new RegExp(`(^|[^A-Za-z0-9_$#.])${escapeRegExp(name)}([^A-Za-z0-9_$#]|$)`, "i").test(code);

  return tables.filter((t) => {
    if (mentions(t.tableFullName)) return true;
    // O schema as vezes fica implicito. So vale quando o nome curto e unico —
    // senao duas tabelas homonimas entrariam ambas e poluiriam a resolucao.
    const bare = t.tableFullName.split(".").pop()!;
    return bareCount.get(bare.toLowerCase()) === 1 && mentions(bare);
  });
};

/**
 * Guarda 1 — agregar coluna acumulada.
 *
 * A coluna ja soma tudo ate a linha. Somar as linhas entre si conta o mesmo
 * fato N vezes, e o resultado sai plausivel: grande, positivo, crescente.
 *
 * A regra e frouxa de proposito para o que esta sendo AGREGADO: qualquer
 * citacao, mesmo dentro de expressao, porque nao existe soma legitima de
 * acumulado — ao contrario da taxa, que tem media ponderada.
 *
 * O que ela nao le e a condicao de um `CASE`: em
 * `SUM(CASE WHEN acumulada > 0 THEN 1 ELSE 0 END)` a coluna acumulada e
 * filtro, nao parcela. `aggregatesIn` ja apaga o trecho entre `WHEN` e `THEN`.
 */
const guardCumulativeAggregate = (
  aggregates: readonly Aggregate[],
  resolve: (column: string) => ColumnClass | null
): ClassifiedError | null => {
  for (const agg of aggregates) {
    for (const { name, cls } of classifiedIn(agg.arg, resolve)) {
      if (!cls.cumulative) continue;
      return reject(
        "aggregation_error",
        `${agg.fn.toUpperCase()}(${name}) sobre coluna acumulada`,
        `A coluna "${name}" ja e um acumulado: cada registro dela contem o total do periodo anterior somado ao do proprio registro. Aplicar ${agg.fn.toUpperCase()} entre registros conta o mesmo fato varias vezes e infla o resultado sem gerar erro no banco. Use MAX("${name}") em vez de ${agg.fn.toUpperCase()}, ou troque por uma coluna nao acumulada e ai sim some.`
      );
    }
  }
  return null;
};

/**
 * Guarda 2 — agregar taxa/percentual.
 *
 * Media de percentual so bate com a verdade quando todos os denominadores sao
 * iguais, o que praticamente nunca acontece.
 *
 * So barra quando a taxa esta SOZINHA dentro do agregado. `SUM(taxa * peso)`
 * e media ponderada, que e correta — e barra-la seria empurrar o modelo do
 * certo para o errado.
 */
const guardRateAggregate = (
  aggregates: readonly Aggregate[],
  resolve: (column: string) => ColumnClass | null
): ClassifiedError | null => {
  for (const agg of aggregates) {
    if (HAS_ARITHMETIC.test(agg.arg)) continue;
    const found = classifiedIn(agg.arg, resolve);
    if (found.length !== 1) continue;
    const { name, cls } = found[0]!;
    if (cls.unit !== "rate") continue;
    return reject(
      "aggregation_error",
      `${agg.fn.toUpperCase()}(${name}) sobre taxa`,
      `A coluna "${name}" e uma taxa/percentual, nao um valor somavel. ${
        agg.fn === "sum"
          ? "Somar percentuais nao produz percentual nenhum"
          : "A media simples de percentuais so seria correta se todos os denominadores fossem iguais, o que nao e o caso"
      }. Recalcule a taxa a partir das colunas de contagem: SUM(numerador) / NULLIF(SUM(denominador), 0). Se as colunas componentes nao estiverem no schema, use a media ponderada SUM("${name}" * <coluna de volume>) / NULLIF(SUM(<coluna de volume>), 0).`
    );
  }
  return null;
};

/**
 * Guarda 3 — somar faixas que se contem.
 *
 * Quando uma faixa engloba outras, somar as duas conta o intervalo comum duas
 * vezes. Mostrar as duas lado a lado (`SUM(pai), SUM(filho)`) e detalhamento
 * legitimo e nao cai aqui: a guarda so olha trechos que tem `+`.
 */
const guardOverlappingBuckets = (
  segments: readonly string[],
  resolve: (column: string) => ColumnClass | null,
  overlapping: Readonly<Record<string, readonly string[]>>
): ClassifiedError | null => {
  const parents = Object.keys(overlapping);
  if (parents.length === 0) return null;

  for (const segment of segments) {
    // Por lado aditivo: `pai - filho` e o complemento da faixa, uso legitimo.
    const bySign = new Map<number, Map<string, string>>();
    for (const term of additiveTerms(segment)) {
      let byBucket = bySign.get(term.sign);
      if (!byBucket) {
        byBucket = new Map<string, string>();
        bySign.set(term.sign, byBucket);
      }
      for (const { name, cls } of classifiedIn(term.text, resolve)) {
        if (cls.bucket && !byBucket.has(cls.bucket)) byBucket.set(cls.bucket, name);
      }
    }

    for (const byBucket of bySign.values()) {
      if (byBucket.size < 2) continue;
      for (const parent of parents) {
        const parentCol = byBucket.get(parent);
        if (!parentCol) continue;
        for (const child of overlapping[parent] ?? []) {
          const childCol = byBucket.get(child);
          if (!childCol) continue;
          return reject(
            "aggregation_error",
            `faixa ${parent} somada com ${child}`,
            `A faixa ${parent} JA CONTEM a faixa ${child}: somar "${parentCol}" com "${childCol}" conta o intervalo em comum duas vezes. Escolha um dos dois niveis — ou a faixa ampla "${parentCol}" sozinha, ou apenas as faixas que a compoem — mas nunca os dois na mesma soma.`
          );
        }
      }
    }
  }
  return null;
};

/**
 * Guarda 6 — somar meta com realizado.
 *
 * Meta e realizado sao numeros de naturezas diferentes; soma-los produz um
 * total que nao existe. Compara-los, sim, e o uso normal — por isso a guarda
 * so olha `+`, deixando `-` (desvio) e `/` (atingimento) passarem.
 *
 * E precisa olhar o SINAL de cada parcela, nao so a presenca de um `+` no
 * segmento: em `SUM(realizado) - SUM(meta) + SUM(ajuste)` as duas naturezas
 * convivem, mas em lados opostos — e desvio, o uso canonico de compara-las.
 */
const guardMixedNature = (
  segments: readonly string[],
  resolve: (column: string) => ColumnClass | null
): ClassifiedError | null => {
  for (const segment of segments) {
    const sides = new Map<number, { target: string | null; actual: string | null }>();
    for (const term of additiveTerms(segment)) {
      let side = sides.get(term.sign);
      if (!side) {
        side = { target: null, actual: null };
        sides.set(term.sign, side);
      }
      for (const { name, cls } of classifiedIn(term.text, resolve)) {
        if (cls.nature === "target" && !side.target) side.target = name;
        if (cls.nature === "actual" && !side.actual) side.actual = name;
      }
    }

    const clash = [...sides.values()].find((s) => s.target && s.actual);
    if (!clash) continue;
    const target = clash.target!;
    const actual = clash.actual!;
    return reject(
      "aggregation_error",
      `soma de meta com realizado (${target} + ${actual})`,
      `"${target}" e a meta e "${actual}" e o valor realizado: somar os dois produz um total que nao representa nada. Se a intencao e comparar, devolva as duas colunas em campos separados, ou calcule o desvio ("${actual}" - "${target}") ou o atingimento ("${actual}" / NULLIF("${target}", 0)).`
    );
  }
  return null;
};

/**
 * Guarda 4 — filtrar periodo pela data errada.
 *
 * Uma tabela costuma ter varias datas e so uma delas e a do evento. Filtrar
 * pela outra devolve um recorte diferente do pedido, sem erro nenhum.
 *
 * So dispara quando a data do evento nao aparece em lugar nenhum do WHERE: se
 * as duas estao la, o SQL provavelmente sabe o que esta fazendo.
 *
 * E so quando a data alternativa esta numa forma de FILTRO (comparacao com
 * constante, `BETWEEN`, funcao de data). Citar a coluna — `IS NULL`, juncao,
 * projecao — nao e recortar periodo.
 */
const guardWrongEventDate = (
  where: string,
  referenced: readonly TableFacts[]
): ClassifiedError | null => {
  if (!where) return null;
  const used = new Set(identifiersIn(where));

  // Data que e evento de ALGUMA tabela citada nunca conta como alternativa
  // errada — sem isso, duas tabelas com nomes de data cruzados se acusariam.
  const eventDates = new Set(
    referenced.map((t) => t.eventDateColumn?.toLowerCase()).filter((d): d is string => !!d)
  );

  for (const facts of referenced) {
    const event = facts.eventDateColumn?.toLowerCase();
    if (!event || used.has(event)) continue;
    const wrong = facts.alternateDateColumns.find(
      (c) =>
        used.has(c.toLowerCase()) &&
        !eventDates.has(c.toLowerCase()) &&
        usedAsPeriodFilter(where, c)
    );
    if (!wrong) continue;
    return reject(
      "validation_error",
      `filtro de periodo por "${wrong}" em ${facts.tableFullName}`,
      `Em ${facts.tableFullName} a data do evento e "${facts.eventDateColumn}", nao "${wrong}". "${wrong}" existe e e uma data legitima, mas marca outro momento do processo — filtrar por ela devolve um conjunto de linhas diferente do que foi pedido, sem erro no banco. Troque o filtro de periodo para "${facts.eventDateColumn}".`
    );
  }
  return null;
};

/**
 * `between` NAO entra aqui: e o unico operador de intervalo que serve para
 * numero tambem, e um `cod BETWEEN 1 AND 10` viraria "tentativa de periodo".
 * O caso temporal dele e tratado por `betweenIsTemporal`.
 */
const PERIOD_SHAPED = /\b(year|month|day|datepart|dateadd|datediff|getdate|sysdate|current_date|trunc|to_date)\b/i;

/**
 * Guarda 5 — filtrar periodo em tabela que nao tem data propria.
 *
 * Algumas tabelas nao carregam data alguma: o periodo delas so existe via
 * juncao com a tabela datada. Sem a juncao, ou o filtro cai numa coluna que
 * nao e data, ou some — e o numero vira "desde sempre" disfarcado de recorte.
 *
 * Nao dispara quando nao ha tentativa de filtro de periodo: consulta sem
 * recorte temporal e legitima e a guarda nao conhece a pergunta.
 */
const guardMissingPeriodJoin = (
  where: string,
  referenced: readonly TableFacts[],
  code: string,
  resolve: (column: string) => ColumnClass | null,
  dateNames: ReadonlySet<string>
): ClassifiedError | null => {
  if (!where) return null;

  const attemptsPeriod =
    PERIOD_SHAPED.test(where) ||
    betweenIsTemporal(where, dateNames) ||
    classifiedIn(where, resolve).some((c) => c.cls.role === "date");
  if (!attemptsPeriod) return null;

  const referencedNames = new Set(referenced.map((t) => t.tableFullName.toLowerCase()));

  for (const facts of referenced) {
    if (!facts.requiresJoinForPeriod) continue;
    const join = facts.periodJoinTable;
    if (!join || referencedNames.has(join.toLowerCase())) continue;
    // A juncao pode estar escrita com o schema omitido.
    if (new RegExp(`(^|[^A-Za-z0-9_$#.])${escapeRegExp(join.split(".").pop()!)}([^A-Za-z0-9_$#]|$)`, "i").test(code)) {
      continue;
    }
    const on = facts.periodJoinColumns.length > 0
      ? facts.periodJoinColumns.join(", ")
      : (facts.joinKey ?? "a chave de juncao");
    return reject(
      "join_error",
      `periodo sem juncao em ${facts.tableFullName}`,
      `${facts.tableFullName} nao tem data propria: nao existe coluna nessa tabela que sirva de filtro de periodo. Para recortar por periodo e obrigatorio juntar com ${join}, que e a tabela datada, usando ${on} no ON — e aplicar o filtro sobre a data de ${join}. Do jeito que esta, o recorte temporal nao esta sendo aplicado a ${facts.tableFullName}.`
    );
  }
  return null;
};

/**
 * Le os fatos de tabela que o ingest ja gravou, sem reinferir nada.
 *
 * Reinferir aqui leria o schema de novo a cada pergunta e, pior, poderia
 * divergir do que o dicionario guardou — as guardas passariam a julgar o SQL
 * por uma verdade diferente da que o prompt mostrou ao modelo.
 *
 * Tabela sem registro de nivel-tabela fica de fora: sem fatos, nao ha o que
 * guardar, e as guardas de coluna ainda funcionam pelas outras tabelas.
 *
 * Sem `tableFullNames` devolve o dicionario inteiro, que e o uso normal: as
 * guardas ja filtram pelo que o SQL cita, e restringir antes a uma lista de
 * candidatas as cegaria justamente no caso perigoso — um SQL que veio do
 * cache semantico e menciona tabela que a busca desta pergunta nao trouxe.
 */
export const factsFromDictionary = (
  dictionary: DictionaryIndex,
  tableFullNames?: readonly string[]
): TableFacts[] => {
  const names =
    tableFullNames ??
    dictionary.all.filter((r) => r.columnName === undefined).map((r) => r.tableFullName);
  const out: TableFacts[] = [];
  for (const name of names) {
    const rec = dictionary.table(name);
    if (!rec) continue;
    out.push({
      tableFullName: rec.tableFullName,
      grain: rec.grain ?? null,
      eventDateColumn: rec.eventDateColumn ?? null,
      alternateDateColumns: rec.alternateDateColumns ?? [],
      joinKey: rec.joinKey ?? null,
      requiresJoinForPeriod: rec.requiresJoinForPeriod ?? false,
      periodJoinTable: rec.periodJoinTable ?? null,
      periodJoinColumns: rec.periodJoinColumns ?? []
    });
  }
  return out;
};

export const __guardTesting = {
  additiveSegments,
  aggregatesIn,
  referencedTables,
  whereRegion
};
