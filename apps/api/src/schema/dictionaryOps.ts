import type { ObjectId } from "mongodb";
import type { ColumnInfo } from "@auraia/shared";
import { classifyColumn, type ColumnClass } from "./lexicon.js";
import { BUILTIN_PTBR_VOCABULARY, type DomainVocabulary } from "./vocabulary.js";

/**
 * Regras do dicionario semantico, sem I/O.
 *
 * Separado de `dictionary.ts` de proposito: aquele modulo importa `core/config`,
 * que encerra o processo se `JWT_SECRET` nao existir. A regra que protege a
 * curadoria humana precisa ser testavel sem subir Mongo nem montar ambiente.
 */

/**
 * Um documento por coluna (`columnName` preenchido) ou por tabela
 * (`columnName` ausente — usado pelo E2 para grao e coluna de data do
 * evento). O ingest popula os `inferred` pelo lexico; o que for revisado a
 * mao vira `curated` e passa a ser intocavel.
 */
export type DictionaryRecord = {
  _id?: ObjectId;
  environmentId: string;
  tableFullName: string;
  /** Ausente = registro de nivel-tabela. */
  columnName?: string;
  source: "inferred" | "curated";

  // --- nivel coluna, vindo do lexico ---
  class?: ColumnClass;
  description?: string;
  synonyms?: string[];

  // --- nivel tabela (E2) ---
  grain?: string | null;
  eventDateColumn?: string | null;
  alternateDateColumns?: string[];
  joinKey?: string | null;
  requiresJoinForPeriod?: boolean;
  periodJoinTable?: string | null;
  periodJoinColumns?: string[];

  updatedAt: Date;
};

/** Ambiente default quando a request nao manda environmentId. */
export const DEFAULT_ENV = "__default__";

export const normalizeEnvId = (environmentId?: string): string =>
  environmentId && environmentId.trim() !== "" ? environmentId : DEFAULT_ENV;

/** Preserva o valor atual quando o documento e `curated`, senao grava o novo. */
type KeepIfCurated<T> = { $cond: [CuratedTest, string, { $literal: T }] };
type CuratedTest = { $eq: ["$source", "curated"] };

export const CURATED_TEST: CuratedTest = { $eq: ["$source", "curated"] };

export type InferredColumnOp = {
  updateOne: {
    /** Chave de identidade e nada mais — ver `buildInferredOps`. */
    filter: {
      environmentId: string;
      tableFullName: string;
      columnName: string;
    };
    update: [
      {
        $set: {
          class: KeepIfCurated<ColumnClass>;
          updatedAt: KeepIfCurated<Date>;
          source: { $ifNull: ["$source", "inferred"] };
        };
      }
    ];
    upsert: true;
  };
};

/**
 * Monta os writes do re-ingest.
 *
 * Regra dura: NUNCA sobrescreve um documento `curated`. O re-ingest roda toda
 * vez que o schema muda e nao pode apagar revisao humana — sem isso a
 * curadoria das ~30 metricas se perderia no primeiro reindex.
 *
 * A versao anterior tentava garantir isso com `source: {$ne:"curated"}` no
 * filtro, e isso estava ERRADO: o filtro deixa de casar justamente o doc
 * curated, entao o upsert insere um SEGUNDO documento para a mesma coluna. Sem
 * indice unico o write passa, `buildDictionaryIndex` resolve para o duplicado
 * inferido e a curadoria some sem erro nenhum.
 *
 * Aqui a protecao e estrutural, em duas partes:
 *  - o filtro e so a chave de identidade, entao duplicata e impossivel: ou
 *    casa o doc que ja existe, ou nao existe nenhum e insere o primeiro;
 *  - o update e um pipeline de agregacao que le o `source` atual e so
 *    sobrescreve `class`/`updatedAt` quando ele nao e `curated`.
 *
 * `environmentId`/`tableFullName`/`columnName` nao aparecem no pipeline de
 * proposito: na insercao o Mongo os deriva das clausulas de igualdade do
 * filtro.
 */
export const buildInferredOps = (
  tableFullName: string,
  columns: readonly ColumnInfo[],
  environmentId?: string,
  now: Date = new Date(),
  vocabulary: DomainVocabulary = BUILTIN_PTBR_VOCABULARY
): InferredColumnOp[] => {
  const envId = normalizeEnvId(environmentId);
  return columns.map((c) => ({
    updateOne: {
      filter: {
        environmentId: envId,
        tableFullName,
        columnName: c.name
      },
      update: [
        {
          $set: {
            // `$literal` para o driver tratar o objeto como constante em vez
            // de tentar avaliar suas chaves como expressao.
            class: {
              $cond: [
                CURATED_TEST,
                "$class",
                { $literal: classifyColumn(c.name, c.type, vocabulary) }
              ]
            },
            updatedAt: { $cond: [CURATED_TEST, "$updatedAt", { $literal: now }] },
            // Insercao nao tem `$source`: nasce `inferred`. Doc existente
            // mantem o que ja era, inclusive `curated`.
            source: { $ifNull: ["$source", "inferred"] as ["$source", "inferred"] }
          }
        }
      ],
      upsert: true as const
    }
  }));
};

/**
 * Discriminador do registro de nivel-tabela.
 *
 * Nao da para usar so `{environmentId, tableFullName}`: esse filtro casaria
 * tambem os ~50 a ~180 documentos de COLUNA da mesma tabela, e o update
 * sobrescreveria um deles com grao/data. `$exists:false` isola o unico doc
 * sem `columnName`. Continua sendo chave de identidade — nenhuma clausula
 * sobre `source`, entao o bug do duplicado nao volta por aqui.
 *
 * Na insercao o Mongo copia so as clausulas de igualdade do filtro, entao o
 * doc nasce sem `columnName` — que e exatamente o que o discriminador quer.
 */
type TableIdentityFilter = {
  environmentId: string;
  tableFullName: string;
  columnName: { $exists: false };
};

export type TableFactsOp = {
  updateOne: {
    filter: TableIdentityFilter;
    update: [
      {
        $set: {
          grain: KeepIfCurated<string | null>;
          eventDateColumn: KeepIfCurated<string | null>;
          alternateDateColumns: KeepIfCurated<string[]>;
          joinKey: KeepIfCurated<string | null>;
          requiresJoinForPeriod: KeepIfCurated<boolean>;
          periodJoinTable: KeepIfCurated<string | null>;
          periodJoinColumns: KeepIfCurated<string[]>;
          updatedAt: KeepIfCurated<Date>;
          source: { $ifNull: ["$source", "inferred"] };
        };
      }
    ];
    upsert: true;
  };
};

/** Campos de nivel-tabela que o re-ingest reescreve, um a um. */
type TableFactsInput = {
  /** `null` = ninguem curou ainda. Distinto de string vazia, que seria uma
   *  curadoria vazia — o E4 precisa saber a diferenca para nao injetar
   *  "grao: " sem nada no prompt. */
  grain: string | null;
  eventDateColumn: string | null;
  alternateDateColumns: readonly string[];
  joinKey: string | null;
  requiresJoinForPeriod: boolean;
  periodJoinTable: string | null;
  periodJoinColumns: readonly string[];
};

/**
 * Mesma garantia do `buildInferredOps`, no nivel tabela: filtro so com a
 * chave de identidade e update em pipeline, cada campo mutavel guardado por
 * `$cond` sobre `$source`. Grao e coluna de data sao justamente o tipo de
 * fato que alguem revisa a mao depois — nao podem morrer no proximo reindex.
 */
export const buildTableFactsOps = (
  facts: readonly (TableFactsInput & { tableFullName: string })[],
  environmentId?: string,
  now: Date = new Date()
): TableFactsOp[] => {
  const envId = normalizeEnvId(environmentId);
  const keep = <T>(field: string, value: T): KeepIfCurated<T> => ({
    $cond: [CURATED_TEST, `$${field}`, { $literal: value }]
  });

  return facts.map((f) => ({
    updateOne: {
      filter: {
        environmentId: envId,
        tableFullName: f.tableFullName,
        columnName: { $exists: false as const }
      },
      update: [
        {
          $set: {
            grain: keep("grain", f.grain),
            eventDateColumn: keep("eventDateColumn", f.eventDateColumn),
            alternateDateColumns: keep("alternateDateColumns", [...f.alternateDateColumns]),
            joinKey: keep("joinKey", f.joinKey),
            requiresJoinForPeriod: keep("requiresJoinForPeriod", f.requiresJoinForPeriod),
            periodJoinTable: keep("periodJoinTable", f.periodJoinTable),
            periodJoinColumns: keep("periodJoinColumns", [...f.periodJoinColumns]),
            updatedAt: keep("updatedAt", now),
            source: { $ifNull: ["$source", "inferred"] as ["$source", "inferred"] }
          }
        }
      ],
      upsert: true as const
    }
  }));
};

export type DictionaryIndex = {
  column: (tableFullName: string, columnName: string) => DictionaryRecord | undefined;
  table: (tableFullName: string) => DictionaryRecord | undefined;
  all: DictionaryRecord[];
};

/**
 * Indexa os registros em memoria — o E3/E4 consultam por coluna a cada SQL
 * gerado e nao podem pagar uma query por consulta. Chaves em minusculas
 * porque o nome que chega do SQL gerado nao respeita o caixa do catalogo.
 */
export const buildDictionaryIndex = (all: readonly DictionaryRecord[]): DictionaryIndex => {
  const byColumn = new Map<string, DictionaryRecord>();
  const byTable = new Map<string, DictionaryRecord>();
  for (const rec of all) {
    if (rec.columnName) {
      byColumn.set(`${rec.tableFullName.toLowerCase()}.${rec.columnName.toLowerCase()}`, rec);
    } else {
      byTable.set(rec.tableFullName.toLowerCase(), rec);
    }
  }

  return {
    column: (t, c) => byColumn.get(`${t.toLowerCase()}.${c.toLowerCase()}`),
    table: (t) => byTable.get(t.toLowerCase()),
    all: [...all]
  };
};
