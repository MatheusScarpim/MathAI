import type { ColumnFormat, ResultColumnMeta } from "@auraia/shared";
import { resolveColumnFormats, resolveColumnFormatsFromNames } from "./columnFormat.js";
import { getSeed, getVocabulary } from "./seedStore.js";

/**
 * Envelope com I/O em volta de `columnFormat.ts`, que e puro de proposito.
 *
 * Existe para o caminho de cache: a resposta guardada no Redis pode ter sido
 * gravada por uma versao anterior da derivacao, e a chave de cache nao tem
 * carimbo de versao. Recalcular na leitura e o que impede a tabela de alternar
 * entre formatada e crua durante os 900s de TTL.
 *
 * `columnsMeta` e opcional mas importa: sem ele so sobra o nome da coluna, e a
 * derivacao perde o `scale` que o driver declarou. `PesoLiquidoProduzidoKg`
 * saia com 3 casas na resposta fresca e 2 no hit de cache — a mesma pergunta
 * mudando de precisao conforme o cache, e a versao rebaixada indo parar no
 * history. Por isso quem grava no Redis guarda o meta junto e passa aqui.
 * Entrada antiga nao tem o campo e cai no caminho por nomes, que e o
 * comportamento de antes.
 *
 * Barato apesar do `await`: `getSeed`/`getVocabulary` sao memoizados em
 * processo por `seedStore.ts`, sem TTL — depois da primeira pergunta do
 * ambiente as duas chamadas nao tocam o Mongo.
 *
 * Sem seed, cai nas convencoes PT-BR embutidas em vez de propagar o erro: uma
 * mascara pior e melhor que uma pergunta quebrada.
 */
export const resolveColumnFormatsForEnvironment = async (
  environmentId: string | undefined,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
  columnsMeta?: readonly ResultColumnMeta[]
): Promise<Record<string, ColumnFormat>> => {
  const resolve = (opts: Parameters<typeof resolveColumnFormats>[1]) =>
    columnsMeta?.length
      ? resolveColumnFormats(columnsMeta, opts)
      : resolveColumnFormatsFromNames(columns, opts);

  try {
    const [vocabulary, seed] = await Promise.all([getVocabulary(environmentId), getSeed(environmentId)]);
    return resolve({ vocabulary, overrides: seed.columnFormats, samples: rows });
  } catch {
    return resolve({ samples: rows });
  }
};
