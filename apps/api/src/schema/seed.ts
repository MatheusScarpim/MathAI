import type { PartialVocabulary, SourceRule, SourceMatch } from "./vocabulary.js";
import type { TableFactsOverride, TableFactsOverrides } from "./tableFacts.js";
import type { ColumnFormatKind } from "@auraia/shared";
import { COLUMN_FORMAT_KINDS } from "@auraia/shared";
import type { MetricDefinition, MetricKind, MetricProvenance, MetricUnit } from "./metrics.js";
import {
  METRIC_KINDS,
  METRIC_PROVENANCES,
  METRIC_UNITS,
  kindNeedsPair,
  kindNeedsColumn
} from "./metrics.js";

/**
 * O DADO de dominio, separado do motor.
 *
 * Um seed e o que um cliente sabe do proprio negocio e o motor nao tem como
 * adivinhar: que `eclosao` e uma taxa, que `racao` se mede em peso, que a
 * data do evento daquela view de resumo e a da view vizinha e nao a dela
 * mesma. Isso e dado, nao codigo — mora em JSON, entra por rota, fica no
 * Mongo por ambiente e nunca no bundle.
 *
 * Este modulo e puro de proposito, pelo mesmo motivo que `dictionaryOps.ts`:
 * validar um seed nao pode exigir Mongo nem variavel de ambiente. O acesso ao
 * banco esta em `seedStore.ts`.
 */

export type DomainSeed = {
  /** Identificador legivel do dominio, ex "avicultura". So para diagnostico. */
  name: string;
  description?: string;
  vocabulary: PartialVocabulary;
  /** Curadoria de nivel tabela, chaveada pelo nome completo da tabela. */
  tableFacts: TableFactsOverrides;
  /** Definicao das metricas do negocio. Ver `metrics.ts`. */
  metrics: readonly MetricDefinition[];
  /**
   * Mascara de exibicao por nome de coluna, em minusculas. Vence a inferencia
   * do lexico porque cobre o que nenhuma heuristica alcanca: se a taxa foi
   * gravada como 0.875 (`fraction`) ou 87.5 (`percent`), e o significado de um
   * alias que o modelo inventou e nao esta no vocabulario.
   */
  columnFormats: Readonly<Record<string, ColumnFormatKind>>;
};

/** Ausencia de seed. O motor roda com ele: so as convencoes PT-BR valem. */
export const EMPTY_SEED: DomainSeed = {
  name: "none",
  vocabulary: {},
  tableFacts: {},
  metrics: [],
  columnFormats: {}
};

const STRING_LIST_FIELDS = [
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
  "dimensionPrefixes",
  "dimensionTerms",
  "datePrefixes",
  "keyNames",
  "targetTerms",
  "actualTerms",
  "cumulativeTerms",
  "weekTerms",
  "femaleTerms",
  "maleTerms"
] as const satisfies readonly (keyof PartialVocabulary)[];

/** Erro de seed e erro do usuario: precisa dizer QUAL campo, nao "invalido". */
export class SeedError extends Error {}

const fail = (msg: string): never => {
  throw new SeedError(`seed invalido: ${msg}`);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asStringList = (value: unknown, where: string): string[] => {
  if (!Array.isArray(value)) fail(`${where} deve ser lista de strings`);
  return (value as unknown[]).map((v, i) => {
    if (typeof v !== "string" || v.trim() === "") fail(`${where}[${i}] deve ser string nao vazia`);
    // Nomes de coluna chegam do catalogo em caixa arbitraria; o lexico compara
    // sempre em minusculas. Normalizar aqui evita um termo que nunca casa.
    return (v as string).trim().toLowerCase();
  });
};

/**
 * `notes` e a excecao a normalizacao de `asStringList`: e prosa que vai
 * INTEIRA para o prompt, nao termo que o lexico procura. Baixar a caixa aqui
 * destruiria justamente o que a nota quer ensinar — o nome exato de uma
 * coluna (`Ps_Liquido`) e a enfase de uma regra (`NUNCA`, `SUM`, `AVG`).
 */
const asNotes = (value: unknown): string[] => {
  if (!Array.isArray(value)) fail("vocabulary.notes deve ser lista de strings");
  return (value as unknown[]).map((v, i) => {
    if (typeof v !== "string" || v.trim() === "")
      fail(`vocabulary.notes[${i}] deve ser string nao vazia`);
    return (v as string).trim();
  });
};

const asSourceRules = (value: unknown): SourceRule[] => {
  if (!Array.isArray(value)) fail("vocabulary.sourceRules deve ser lista");
  return (value as unknown[]).map((raw, i) => {
    if (!isRecord(raw)) return fail(`vocabulary.sourceRules[${i}] deve ser objeto`);
    const { term, label, match } = raw;
    if (typeof term !== "string" || term.trim() === "")
      fail(`vocabulary.sourceRules[${i}].term deve ser string nao vazia`);
    if (typeof label !== "string" || label.trim() === "")
      fail(`vocabulary.sourceRules[${i}].label deve ser string nao vazia`);
    if (match !== "token" && match !== "suffix")
      fail(`vocabulary.sourceRules[${i}].match deve ser "token" ou "suffix"`);
    return {
      term: (term as string).trim().toLowerCase(),
      label: (label as string).trim(),
      match: match as SourceMatch
    };
  });
};

const asBuckets = (value: unknown): Record<string, string[]> => {
  if (!isRecord(value)) fail("vocabulary.overlappingBuckets deve ser objeto");
  const out: Record<string, string[]> = {};
  for (const [parent, children] of Object.entries(value as Record<string, unknown>)) {
    const list = asStringList(children, `vocabulary.overlappingBuckets.${parent}`);
    if (list.length < 2)
      fail(`vocabulary.overlappingBuckets.${parent} precisa de ao menos 2 faixas contidas`);
    if (list.includes(parent.toLowerCase()))
      fail(`vocabulary.overlappingBuckets.${parent} contem a si mesma`);
    out[parent.toLowerCase()] = list;
  }
  return out;
};

const asVocabulary = (value: unknown): PartialVocabulary => {
  if (value === undefined) return {};
  if (!isRecord(value)) return fail("vocabulary deve ser objeto");

  const known = new Set<string>([
    ...STRING_LIST_FIELDS,
    "notes",
    "sourceRules",
    "overlappingBuckets"
  ]);
  for (const key of Object.keys(value)) {
    // Campo desconhecido quase sempre e erro de digitacao, e silencia-lo faz
    // o termo simplesmente nunca valer — falha invisivel, a pior especie.
    if (!known.has(key)) fail(`vocabulary.${key} nao e um campo conhecido`);
  }

  const out: Record<string, unknown> = {};
  for (const field of STRING_LIST_FIELDS) {
    if (value[field] !== undefined) out[field] = asStringList(value[field], `vocabulary.${field}`);
  }
  if (value.notes !== undefined) out.notes = asNotes(value.notes);
  if (value.sourceRules !== undefined) out.sourceRules = asSourceRules(value.sourceRules);
  if (value.overlappingBuckets !== undefined)
    out.overlappingBuckets = asBuckets(value.overlappingBuckets);
  return out as PartialVocabulary;
};

const asTableFacts = (value: unknown): TableFactsOverrides => {
  if (value === undefined) return {};
  if (!isRecord(value)) return fail("tableFacts deve ser objeto chaveado pelo nome da tabela");

  const out: Record<string, TableFactsOverride> = {};
  for (const [table, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isRecord(raw)) fail(`tableFacts["${table}"] deve ser objeto`);
    const rec = raw as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (!["grain", "eventDateColumn", "joinKey", "periodJoinTable", "periodJoinColumns"].includes(key))
        // `alternateDateColumns` cai aqui de proposito: e derivada do schema
        // real e escreve-la a mao so cria divergencia silenciosa.
        fail(`tableFacts["${table}"].${key} nao e um campo curavel`);
    }

    const ov: TableFactsOverride = {};
    if (rec.grain !== undefined) {
      if (typeof rec.grain !== "string" || rec.grain.trim() === "")
        fail(`tableFacts["${table}"].grain deve ser string nao vazia`);
      ov.grain = (rec.grain as string).trim();
    }
    if (rec.eventDateColumn !== undefined) {
      if (rec.eventDateColumn !== null && typeof rec.eventDateColumn !== "string")
        fail(`tableFacts["${table}"].eventDateColumn deve ser string ou null`);
      ov.eventDateColumn = rec.eventDateColumn === null ? null : (rec.eventDateColumn as string);
    }
    if (rec.joinKey !== undefined) {
      if (typeof rec.joinKey !== "string" || rec.joinKey.trim() === "")
        fail(`tableFacts["${table}"].joinKey deve ser string nao vazia`);
      ov.joinKey = rec.joinKey as string;
    }
    if (rec.periodJoinTable !== undefined) {
      if (rec.periodJoinTable !== null && typeof rec.periodJoinTable !== "string")
        fail(`tableFacts["${table}"].periodJoinTable deve ser string ou null`);
      ov.periodJoinTable = rec.periodJoinTable === null ? null : (rec.periodJoinTable as string);
    }
    if (rec.periodJoinColumns !== undefined)
      ov.periodJoinColumns = asStringList(
        rec.periodJoinColumns,
        `tableFacts["${table}"].periodJoinColumns`
      );

    out[table] = ov;
  }
  return out;
};

/**
 * Chave normalizada em minusculas pelo mesmo motivo que `asStringList`: nome de
 * coluna chega do catalogo em caixa arbitraria, e a busca compara minusculo.
 * Um `VLR_TOTAL` curado que nunca casasse seria falha invisivel.
 */
const asColumnFormats = (value: unknown): Record<string, ColumnFormatKind> => {
  if (value === undefined) return {};
  if (!isRecord(value)) return fail("columnFormats deve ser objeto chaveado pelo nome da coluna");

  const out: Record<string, ColumnFormatKind> = {};
  for (const [column, raw] of Object.entries(value as Record<string, unknown>)) {
    if (column.trim() === "") fail("columnFormats tem chave vazia");
    if (typeof raw !== "string" || !(COLUMN_FORMAT_KINDS as readonly string[]).includes(raw))
      fail(
        `columnFormats["${column}"] deve ser um de: ${COLUMN_FORMAT_KINDS.join(", ")}`
      );
    out[column.trim().toLowerCase()] = raw as ColumnFormatKind;
  }
  return out;
};

const MetricFields = [
  "id",
  "label",
  "synonyms",
  "kind",
  "table",
  "numerator",
  "denominator",
  "column",
  "precomputed",
  "targetColumn",
  "unit",
  "provenance",
  "pitfalls"
];

const asMetrics = (value: unknown): MetricDefinition[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail("metrics deve ser lista");

  const seen = new Set<string>();
  return (value as unknown[]).map((raw, i) => {
    if (!isRecord(raw)) return fail(`metrics[${i}] deve ser objeto`);
    const at = (f: string) => `metrics[${i}].${f}`;
    for (const key of Object.keys(raw)) {
      if (!MetricFields.includes(key)) fail(`${at(key)} nao e um campo conhecido`);
    }

    const str = (f: string, required: boolean): string | undefined => {
      const v = raw[f];
      if (v === undefined) {
        if (required) fail(`${at(f)} e obrigatorio`);
        return undefined;
      }
      if (typeof v !== "string" || v.trim() === "") fail(`${at(f)} deve ser string nao vazia`);
      return (v as string).trim();
    };

    const id = str("id", true) as string;
    // Id duplicado silenciosamente sobrescreveria a definicao anterior no
    // primeiro `Map` que alguem montar — e a formula errada e indistinguivel
    // da certa depois que o SQL sai.
    if (seen.has(id)) fail(`${at("id")}: "${id}" esta duplicado`);
    seen.add(id);
    if (!/^[a-z0-9_]+$/.test(id)) fail(`${at("id")} deve ser minusculo, sem espaco`);

    const kind = raw.kind;
    if (typeof kind !== "string" || !(METRIC_KINDS as readonly string[]).includes(kind))
      fail(`${at("kind")} deve ser um de: ${METRIC_KINDS.join(", ")}`);
    const provenance = raw.provenance;
    if (
      typeof provenance !== "string" ||
      !(METRIC_PROVENANCES as readonly string[]).includes(provenance)
    )
      fail(`${at("provenance")} deve ser um de: ${METRIC_PROVENANCES.join(", ")}`);
    const unit = raw.unit;
    if (typeof unit !== "string" || !(METRIC_UNITS as readonly string[]).includes(unit))
      fail(`${at("unit")} deve ser um de: ${METRIC_UNITS.join(", ")}`);

    const k = kind as MetricKind;
    const numerator = str("numerator", false);
    const denominator = str("denominator", false);
    const column = str("column", false);

    // A forma decide quais campos existem. Sem esta checagem um `ratio` sem
    // denominador viraria `SUM(x) / NULLIF(SUM(undefined), 0)` — SQL que o
    // banco recusa, mas so depois de gastar uma tentativa.
    if (kindNeedsPair(k)) {
      if (!numerator || !denominator)
        fail(`${at("kind")}="${k}" exige numerator e denominator`);
      if (column) fail(`${at("column")} nao se aplica a kind="${k}"`);
    }
    if (kindNeedsColumn(k)) {
      if (!column) fail(`${at("kind")}="${k}" exige column`);
      if (numerator || denominator)
        fail(`${at("kind")}="${k}" nao aceita numerator/denominator`);
    }

    const synonyms = raw.synonyms === undefined ? [] : asStringList(raw.synonyms, at("synonyms"));
    const pitfalls =
      raw.pitfalls === undefined
        ? []
        : (() => {
            if (!Array.isArray(raw.pitfalls)) return fail(`${at("pitfalls")} deve ser lista`);
            return (raw.pitfalls as unknown[]).map((p, j) => {
              if (typeof p !== "string" || p.trim() === "")
                fail(`${at("pitfalls")}[${j}] deve ser string nao vazia`);
              return (p as string).trim();
            });
          })();

    // Uma metrica inferida sem armadilha declarada e a pior combinacao: entra
    // no prompt com cara de confirmada e sem nada que faca alguem conferir.
    if (provenance === "inferred" && pitfalls.length === 0)
      fail(`${at("provenance")}="inferred" exige ao menos um pitfall explicando o que falta`);

    return {
      id,
      label: str("label", true) as string,
      synonyms,
      kind: k,
      table: str("table", true) as string,
      ...(numerator ? { numerator } : {}),
      ...(denominator ? { denominator } : {}),
      ...(column ? { column } : {}),
      ...(str("precomputed", false) ? { precomputed: str("precomputed", false) } : {}),
      ...(str("targetColumn", false) ? { targetColumn: str("targetColumn", false) } : {}),
      unit: unit as MetricUnit,
      provenance: provenance as MetricProvenance,
      pitfalls
    } as MetricDefinition;
  });
};

/**
 * Valida e normaliza um seed vindo de JSON.
 *
 * Rejeita campo desconhecido em vez de ignorar: um `rateTerms` escrito
 * `rateterms` seria aceito em silencio e o cliente veria classificacao
 * inalterada sem nenhuma pista do porque.
 */
export const parseSeed = (raw: unknown): DomainSeed => {
  if (!isRecord(raw)) return fail("raiz deve ser objeto");
  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") fail("name deve ser string nao vazia");

  for (const key of Object.keys(raw)) {
    if (
      !["name", "description", "vocabulary", "tableFacts", "metrics", "columnFormats"].includes(key)
    )
      fail(`${key} nao e um campo conhecido`);
  }
  if (raw.description !== undefined && typeof raw.description !== "string")
    fail("description deve ser string");

  return {
    name: (name as string).trim(),
    ...(raw.description !== undefined ? { description: raw.description as string } : {}),
    vocabulary: asVocabulary(raw.vocabulary),
    tableFacts: asTableFacts(raw.tableFacts),
    metrics: asMetrics(raw.metrics),
    columnFormats: asColumnFormats(raw.columnFormats)
  };
};
