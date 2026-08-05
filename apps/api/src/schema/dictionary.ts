import type { Collection } from "mongodb";
import type { ColumnInfo } from "@auraia/shared";
import { getMongoClient } from "../core/mongo.js";
import { config } from "../core/config.js";
import {
  buildDictionaryIndex,
  buildInferredOps,
  buildTableFactsOps,
  normalizeEnvId,
  type DictionaryIndex,
  type DictionaryRecord
} from "./dictionaryOps.js";
import { inferTableFacts, type SchemaTableInput } from "./tableFacts.js";
import { getSeed, getVocabulary } from "./seedStore.js";
import { BUILTIN_PTBR_VOCABULARY, type DomainVocabulary } from "./vocabulary.js";

/**
 * Camada de persistencia do dicionario semantico do schema. As regras estao em
 * `dictionaryOps.ts`; aqui so mora o acesso ao Mongo.
 */
export {
  DEFAULT_ENV,
  normalizeEnvId,
  buildInferredOps,
  buildDictionaryIndex
} from "./dictionaryOps.js";
export {
  buildTableFactsOps
} from "./dictionaryOps.js";
export type {
  DictionaryRecord,
  DictionaryIndex,
  InferredColumnOp,
  TableFactsOp
} from "./dictionaryOps.js";
export { inferTableFacts, findTableFacts } from "./tableFacts.js";
export type {
  TableFacts,
  TableFactsOverride,
  TableFactsOverrides,
  SchemaTableInput
} from "./tableFacts.js";
export { getSeed, getVocabulary, saveSeed, clearSeedCache } from "./seedStore.js";
export { parseSeed, EMPTY_SEED, SeedError } from "./seed.js";
export type { DomainSeed } from "./seed.js";
export { BUILTIN_PTBR_VOCABULARY, resolveVocabulary, mergeVocabulary } from "./vocabulary.js";
export type { DomainVocabulary, PartialVocabulary, SourceRule } from "./vocabulary.js";

export const getDictionaryCollection = async (): Promise<Collection<DictionaryRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<DictionaryRecord>("schema_dictionary");
};

let indexReady = false;

/**
 * Rede de seguranca, nao o mecanismo. A protecao da curadoria vem do formato
 * dos writes (`buildInferredOps`: filtro so com a chave de identidade +
 * pipeline condicional), que nao consegue criar duplicata nem com o indice
 * ausente. O indice existe para barrar duplicata vinda de outro caminho.
 */
const ensureIndex = async (col: Collection<DictionaryRecord>): Promise<void> => {
  if (indexReady) return;
  await col.createIndex(
    { environmentId: 1, tableFullName: 1, columnName: 1 },
    { unique: true, name: "env_table_column" }
  );
  indexReady = true;
};

/**
 * Popula a classificacao inferida para as colunas de uma tabela.
 *
 * `vocabulary` e parametro em vez de leitura interna porque o ingest chama
 * isto uma vez por tabela: resolver o vocabulario aqui repetiria a busca
 * dezenas de vezes por ingest. O chamador resolve uma vez e passa.
 */
export const upsertInferredColumns = async (
  tableFullName: string,
  columns: readonly ColumnInfo[],
  environmentId?: string,
  vocabulary: DomainVocabulary = BUILTIN_PTBR_VOCABULARY
): Promise<number> => {
  if (columns.length === 0) return 0;
  const col = await getDictionaryCollection();
  await ensureIndex(col);
  const ops = buildInferredOps(tableFullName, columns, environmentId, new Date(), vocabulary);

  // Sem try/catch de proposito. Antes havia um que engolia qualquer erro de
  // bulk write e devolvia contagem zero como se fosse sucesso — uma falha
  // total de escrita saia como ingest bem-sucedido sem uma linha de log. O
  // chamador (`routes/schema.ts`) ja envolve cada tabela em try/catch e
  // registra `app.log.warn`, entao a falha agora aparece.
  //
  // Duplicata tambem nao e mais esperada: o filtro de `buildInferredOps` e a
  // propria chave de identidade, entao nao ha caminho normal que gere 11000.
  const res = await col.bulkWrite(ops, { ordered: false });
  return res.upsertedCount + res.modifiedCount;
};

/**
 * Popula grao / coluna de data do evento (E2).
 *
 * Grava TODAS as tabelas do schema, nao so as curadas: a inferencia generica
 * ja resolve chave de juncao, datas e necessidade de juncao sem configuracao
 * nenhuma, e uma view nova precisa desses fatos no dia em que aparece. Onde
 * ela nao sabe, grava `null` — que e informacao util: diz ao E4 "esta tabela
 * tem varias datas e ninguem disse qual e o evento", em vez de deixa-lo
 * escolher a primeira.
 */
export const upsertTableFacts = async (
  tables: readonly SchemaTableInput[],
  environmentId?: string
): Promise<number> => {
  if (tables.length === 0) return 0;

  const [vocabulary, seed] = await Promise.all([
    getVocabulary(environmentId),
    getSeed(environmentId)
  ]);
  const facts = inferTableFacts(tables, vocabulary, seed.tableFacts);

  const col = await getDictionaryCollection();
  await ensureIndex(col);
  // Sem try/catch, mesma razao do `upsertInferredColumns`: engolir erro de
  // escrita faz o ingest reportar sucesso sem gravar nada.
  const res = await col.bulkWrite(buildTableFactsOps(facts, environmentId) as never, {
    ordered: false
  });
  return res.upsertedCount + res.modifiedCount;
};

/** Carrega o dicionario num formato indexavel. */
export const getDictionary = async (environmentId?: string): Promise<DictionaryIndex> => {
  const col = await getDictionaryCollection();
  const all = await col.find({ environmentId: normalizeEnvId(environmentId) }).toArray();
  return buildDictionaryIndex(all);
};
