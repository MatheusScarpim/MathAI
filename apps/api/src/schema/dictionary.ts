import type { Collection } from "mongodb";
import type { ColumnInfo } from "@auraia/shared";
import { getMongoClient } from "../core/mongo.js";
import { config } from "../core/config.js";
import {
  buildDictionaryIndex,
  buildInferredOps,
  normalizeEnvId,
  type DictionaryIndex,
  type DictionaryRecord
} from "./dictionaryOps.js";

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
export type {
  DictionaryRecord,
  DictionaryIndex,
  InferredColumnOp
} from "./dictionaryOps.js";

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

/** Popula a classificacao inferida para as colunas de uma tabela. */
export const upsertInferredColumns = async (
  tableFullName: string,
  columns: readonly ColumnInfo[],
  environmentId?: string
): Promise<number> => {
  if (columns.length === 0) return 0;
  const col = await getDictionaryCollection();
  await ensureIndex(col);
  const ops = buildInferredOps(tableFullName, columns, environmentId);

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

/** Carrega o dicionario num formato indexavel. */
export const getDictionary = async (environmentId?: string): Promise<DictionaryIndex> => {
  const col = await getDictionaryCollection();
  const all = await col.find({ environmentId: normalizeEnvId(environmentId) }).toArray();
  return buildDictionaryIndex(all);
};
