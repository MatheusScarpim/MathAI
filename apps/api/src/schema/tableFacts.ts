import type { ColumnInfo } from "@auraia/shared";
import { classifyColumn } from "./lexicon.js";
import { BUILTIN_PTBR_VOCABULARY, type DomainVocabulary } from "./vocabulary.js";

/**
 * Fatos de NIVEL TABELA: o que uma linha representa, qual data e o evento
 * dela, e o que fazer quando a tabela nao tem data nenhuma.
 *
 * Por que isto existe: filtro de periodo e a maior fonte de resposta
 * silenciosamente errada. Uma tabela pode ter meia duzia de colunas de data
 * candidatas e o modelo nao tem como saber qual delas e o EVENTO da linha.
 * Escolher a errada produz SQL perfeito sobre o conjunto errado.
 *
 * Duas camadas, nesta ordem:
 *
 *  1. INFERENCIA (`inferTableFacts`) — generica, roda em qualquer banco, sem
 *     configuracao. Deriva chave de juncao, colunas de data e necessidade de
 *     juncao a partir da forma do schema. Quando o schema e ambiguo ela
 *     devolve `null` em vez de chutar.
 *  2. CURADORIA (`overrides`) — dado do ambiente, vindo do seed. Resolve as
 *     ambiguidades e escreve o grao em prosa, que nenhuma heuristica produz.
 *
 * A inferencia nunca inventa: `eventDateColumn` so sai preenchido quando ha
 * exatamente UMA data na tabela. Uma tabela com tres datas sai `null` e o
 * modelo recebe "nao sei" em vez de um palpite — porque o palpite errado e
 * indistinguivel de acerto no resultado.
 */

export type TableFacts = {
  tableFullName: string;
  /** Texto livre: o que UMA linha representa. Nunca inferivel — so curadoria. */
  grain: string | null;
  /**
   * A data do evento da linha. `null` quando a tabela nao tem data que sirva
   * de filtro de periodo, ou quando tem varias e nenhuma foi curada.
   */
  eventDateColumn: string | null;
  /** Outras datas da tabela. Legitimas, mas NAO sao o evento. Sempre
   *  derivadas do schema real — nunca escritas a mao, senao divergem. */
  alternateDateColumns: readonly string[];
  /** Coluna que atravessa as tabelas. `null` se o schema nao tem uma. */
  joinKey: string | null;
  requiresJoinForPeriod: boolean;
  /** Tabela datada a juntar para obter periodo. */
  periodJoinTable: string | null;
  /** Colunas do ON. Grao errado aqui multiplica linha e infla SUM. */
  periodJoinColumns: readonly string[];
};

/** Forma minima que a inferencia precisa. Casa com o que o ingest carrega. */
export type SchemaTableInput = {
  fullName: string;
  columns: readonly ColumnInfo[];
};

/**
 * Curadoria por tabela. Todo campo e opcional: o seed corrige so o que a
 * inferencia errou ou nao soube.
 *
 * `alternateDateColumns` de proposito NAO e sobrescrivel — ela e sempre
 * derivada das datas reais da tabela menos o evento. Deixar o seed escreve-la
 * a mao criaria a chance de listar uma coluna que nao existe mais, ou de
 * abreviar um nome errado (o mesmo banco pode ter `dat_transferencia` numa
 * view e `dat_transf` na vizinha).
 */
export type TableFactsOverride = {
  grain?: string;
  eventDateColumn?: string | null;
  joinKey?: string;
  periodJoinTable?: string | null;
  periodJoinColumns?: readonly string[];
};

export type TableFactsOverrides = Readonly<Record<string, TableFactsOverride>>;

/**
 * Fracao das tabelas em que uma coluna precisa aparecer para contar como
 * parte do grao compartilhado do schema.
 *
 * O numero so importa para montar o ON da juncao de periodo, e la o custo de
 * errar e ASSIMETRICO: uma coluna a menos no ON casa varias linhas do outro
 * lado, multiplica o resultado e infla SUM sem erro nenhum; uma coluna a mais
 * apenas restringe, e o excesso ainda e filtrado pela intersecao com as
 * colunas que a tabela realmente tem. Por isso 0.5 e nao 0.7 — na duvida,
 * inclui.
 */
const SHARED_GRAIN_THRESHOLD = 0.5;

const lower = (s: string): string => s.toLowerCase();

type Analyzed = {
  fullName: string;
  /** Nomes originais, na ordem declarada. */
  dateColumns: string[];
  keyColumns: string[];
  /** Candidatas a coluna de grao: chave ou dimensao, nunca metrica ou data. */
  grainCandidates: string[];
  has: ReadonlySet<string>;
};

const analyze = (table: SchemaTableInput, vocabulary: DomainVocabulary): Analyzed => {
  const dateColumns: string[] = [];
  const keyColumns: string[] = [];
  const grainCandidates: string[] = [];
  const has = new Set<string>();

  for (const col of table.columns) {
    has.add(lower(col.name));
    const cls = classifyColumn(col.name, col.type, vocabulary);
    if (cls.role === "date") {
      dateColumns.push(col.name);
      continue;
    }
    // Chave NAO e candidata a grao. Num schema de views sem FK as chaves se
    // multiplicam em grafias alternativas da mesma entidade (`lote`,
    // `nro_lote`, `codigo_lote_completo`) — todas dependentes da chave
    // principal. Coloca-las no ON de juncao nao restringe nada que a chave ja
    // nao restrinja, so alonga a clausula e cria chance de casar `null`.
    if (cls.role === "key") {
      keyColumns.push(col.name);
      continue;
    }
    // Dimensao so entra no grao se o lexico a reconheceu. O fallback por tipo
    // (`matched: false`) marca varchar desconhecido como dimensao, e por ali
    // entrariam campos de texto livre que nao sao grao de nada.
    if (cls.role === "dimension" && cls.matched) grainCandidates.push(col.name);
  }

  return { fullName: table.fullName, dateColumns, keyColumns, grainCandidates, has };
};

/** Em quantas tabelas cada coluna de uma lista aparece. */
const countAcross = (
  analyzed: readonly Analyzed[],
  pick: (t: Analyzed) => readonly string[]
): Map<string, { original: string; count: number }> => {
  const counts = new Map<string, { original: string; count: number }>();
  for (const t of analyzed) {
    const names = pick(t);
    for (const name of new Set(names.map(lower))) {
      const entry = counts.get(name);
      if (entry) entry.count += 1;
      else counts.set(name, { original: names.find((n) => lower(n) === name)!, count: 1 });
    }
  }
  return counts;
};

/**
 * A chave de juncao e a coluna presente no maior numero de tabelas.
 *
 * Frequencia e o sinal certo aqui porque views nao tem FK: o que faz uma
 * coluna ser a chave do schema e justamente ela reaparecer em todo lugar.
 *
 * Dois niveis. Se o vocabulario nomeia chaves (`keyNames`), so elas
 * concorrem — e um sinal declarado e vale mais que qualquer contagem. Sem
 * nenhuma chave nomeada, concorrem as colunas com prefixo de dimensao
 * (`cod_`, `nro_`, `ide_`), que e como um schema PT-BR escreve identificador.
 * O segundo nivel e o que faz um banco novo, sem seed, ainda achar sua chave.
 *
 * Exige presenca em pelo menos duas tabelas — uma chave que so existe numa
 * tabela nao junta nada. EMPATE DEVOLVE `null`: duas colunas igualmente
 * centrais significam que o schema tem dois eixos e escolher um no criterio
 * alfabetico seria um chute com cara de resposta. Quem desempata e o seed.
 */
const inferJoinKey = (
  analyzed: readonly Analyzed[],
  vocabulary: DomainVocabulary
): string | null => {
  const named = countAcross(analyzed, (t) => t.keyColumns);
  const prefixes = vocabulary.dimensionPrefixes;
  const counts =
    named.size > 0
      ? named
      : countAcross(analyzed, (t) =>
          t.grainCandidates.filter((c) => prefixes.some((p) => lower(c).startsWith(`${p}_`)))
        );

  let max = 0;
  let winners: string[] = [];
  for (const entry of counts.values()) {
    if (entry.count > max) {
      max = entry.count;
      winners = [entry.original];
    } else if (entry.count === max) winners.push(entry.original);
  }
  return max >= 2 && winners.length === 1 ? winners[0]! : null;
};

/** Colunas de grao que se repetem por quase todo o schema, sem a chave. */
const inferSharedGrainColumns = (
  analyzed: readonly Analyzed[],
  joinKey: string | null
): string[] => {
  if (analyzed.length === 0) return [];
  const counts = new Map<string, { original: string; count: number }>();
  for (const t of analyzed) {
    for (const name of new Set(t.grainCandidates.map(lower))) {
      const original = t.grainCandidates.find((c) => lower(c) === name)!;
      const entry = counts.get(name);
      if (entry) entry.count += 1;
      else counts.set(name, { original, count: 1 });
    }
  }

  const min = analyzed.length * SHARED_GRAIN_THRESHOLD;
  const keyLower = joinKey ? lower(joinKey) : null;
  return [...counts.entries()]
    .filter(([name, e]) => e.count >= min && name !== keyLower)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([, e]) => e.original);
};

/**
 * Tabela datada com que uma tabela sem data pode ser juntada para ganhar
 * periodo.
 *
 * So devolve resposta quando existe UMA candidata. Varias candidatas nao e
 * "escolha a primeira": tabelas diferentes podem representar fases
 * diferentes do mesmo processo, e juntar a fase errada devolve o conjunto
 * errado. Nesse caso a inferencia devolve `null` e a curadoria decide.
 */
const inferPeriodJoinTable = (
  target: Analyzed,
  analyzed: readonly Analyzed[],
  joinKey: string,
  onColumns: readonly string[]
): string | null => {
  const required = onColumns.map(lower);
  const candidates = analyzed.filter(
    (t) =>
      t.fullName !== target.fullName &&
      t.dateColumns.length > 0 &&
      t.has.has(lower(joinKey)) &&
      required.every((c) => t.has.has(c))
  );
  return candidates.length === 1 ? candidates[0]!.fullName : null;
};

/**
 * Deriva os fatos de todas as tabelas e aplica a curadoria por cima.
 *
 * Sem `overrides` o resultado ja e util: chave de juncao, datas e necessidade
 * de juncao saem certos em qualquer schema razoavel. O que a curadoria
 * acrescenta e o grao em prosa e o desempate das ambiguidades.
 */
export const inferTableFacts = (
  tables: readonly SchemaTableInput[],
  vocabulary: DomainVocabulary = BUILTIN_PTBR_VOCABULARY,
  overrides: TableFactsOverrides = {}
): TableFacts[] => {
  const analyzed = tables.map((t) => analyze(t, vocabulary));
  const inferredKey = inferJoinKey(analyzed, vocabulary);
  const sharedGrain = inferSharedGrainColumns(analyzed, inferredKey);

  const overrideFor = (fullName: string): TableFactsOverride | undefined => {
    const direct = overrides[fullName];
    if (direct) return direct;
    const key = Object.keys(overrides).find((k) => lower(k) === lower(fullName));
    return key ? overrides[key] : undefined;
  };

  return analyzed.map((t) => {
    const ov = overrideFor(t.fullName) ?? {};
    const joinKey = ov.joinKey ?? inferredKey;

    // Uma data => e o evento, sem ambiguidade. Varias => a inferencia se
    // recusa a escolher e espera a curadoria.
    const inferredEvent = t.dateColumns.length === 1 ? t.dateColumns[0]! : null;
    const eventDateColumn =
      ov.eventDateColumn !== undefined ? ov.eventDateColumn : inferredEvent;

    // Sempre derivado do schema real: as datas da tabela menos o evento.
    const alternateDateColumns = t.dateColumns.filter(
      (d) => eventDateColumn === null || lower(d) !== lower(eventDateColumn)
    );

    // Duas razoes diferentes para `eventDateColumn` ser null, e elas NAO
    // pedem a mesma coisa:
    //
    //  - a tabela nao tem data alguma, ou a curadoria zerou a data que ela
    //    tem (porque aquela data nao e o evento). Ai so juncao resolve.
    //  - a tabela tem VARIAS datas e ninguem disse qual e o evento. Juntar
    //    com outra tabela nao ajudaria em nada: a informacao existe aqui, so
    //    falta alguem escolher. O que falta e curadoria, nao juncao.
    //
    // Tratar as duas como "precisa juntar" mandaria o E4 fabricar um JOIN
    // para uma tabela que ja tem a data na mao — SQL mais caro e mais errado.
    const curatedToNull = ov.eventDateColumn === null;
    const requiresJoinForPeriod = t.dateColumns.length === 0 || curatedToNull;

    let periodJoinColumns: readonly string[] = [];
    let periodJoinTable: string | null = null;
    if (requiresJoinForPeriod && joinKey) {
      // O ON leva a chave MAIS o grao compartilhado que a tabela realmente
      // tem. So a chave casaria todas as linhas do outro lado e multiplicaria
      // o resultado — inflar SUM e o modo de falha caro aqui.
      periodJoinColumns = [joinKey, ...sharedGrain.filter((c) => t.has.has(lower(c)))];
      periodJoinTable =
        ov.periodJoinTable !== undefined
          ? ov.periodJoinTable
          : inferPeriodJoinTable(t, analyzed, joinKey, periodJoinColumns.slice(1));
      if (ov.periodJoinColumns) periodJoinColumns = ov.periodJoinColumns;
    }

    return {
      tableFullName: t.fullName,
      grain: ov.grain ?? null,
      eventDateColumn,
      alternateDateColumns,
      joinKey,
      requiresJoinForPeriod,
      periodJoinTable,
      periodJoinColumns
    };
  });
};

/**
 * O que dizer ao E4 sobre filtro de periodo nesta tabela.
 *
 * Existe porque `eventDateColumn: null` tem tres significados diferentes e
 * ler os campos crus convida a confundi-los — e cada confusao produz um SQL
 * que roda e responde errado.
 */
export type PeriodStatus =
  /** Ha uma data do evento. Filtre por ela. */
  | "ready"
  /** A tabela tem varias datas e ninguem escolheu. Nao invente: pergunte, ou
   *  diga qual escolheu. Juntar com outra tabela NAO resolve. */
  | "ambiguous"
  /** A data util esta em outra tabela. Junte por `periodJoinColumns`. */
  | "requires-join"
  /** Nao ha data alcancavel e nenhuma juncao conhecida. Esta tabela nao
   *  responde pergunta com periodo — dizer isso e melhor que estimar. */
  | "unavailable";

export const periodStatus = (facts: TableFacts): PeriodStatus => {
  if (facts.eventDateColumn !== null) return "ready";
  if (!facts.requiresJoinForPeriod) return "ambiguous";
  return facts.periodJoinTable !== null ? "requires-join" : "unavailable";
};

export const findTableFacts = (
  facts: readonly TableFacts[],
  tableFullName: string
): TableFacts | undefined =>
  facts.find((t) => lower(t.tableFullName) === lower(tableFullName));
