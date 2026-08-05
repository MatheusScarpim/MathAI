import type { Collection } from "mongodb";
import { getMongoClient } from "../core/mongo.js";
import { config } from "../core/config.js";
import { normalizeEnvId } from "./dictionaryOps.js";
import { EMPTY_SEED, type DomainSeed } from "./seed.js";
import { resolveVocabulary, type DomainVocabulary } from "./vocabulary.js";

/**
 * Persistencia do seed de dominio, um por ambiente.
 *
 * O seed e dado do cliente e por isso mora no banco, nao no bundle: dois
 * ambientes no mesmo processo podem falar de negocios diferentes, e um
 * arquivo importado no build serviria so ao primeiro.
 */

export type SeedRecord = {
  environmentId: string;
  seed: DomainSeed;
  updatedAt: Date;
};

export const getSeedCollection = async (): Promise<Collection<SeedRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<SeedRecord>("schema_seeds");
};

/**
 * O vocabulario e lido a cada coluna classificada — centenas de vezes por
 * ingest, e de novo em toda pergunta. Ir ao Mongo em cada uma seria absurdo,
 * entao ele fica em memoria.
 *
 * Sem TTL de proposito: o seed so muda por `saveSeed`, que invalida o cache
 * na hora. Um TTL aqui so criaria uma janela onde o processo responde com
 * vocabulario velho sem nenhum ganho.
 */
type CacheEntry = { seed: DomainSeed; vocabulary: DomainVocabulary };
const cache = new Map<string, CacheEntry>();

export const clearSeedCache = (environmentId?: string): void => {
  if (environmentId === undefined) cache.clear();
  else cache.delete(normalizeEnvId(environmentId));
};

const load = async (envId: string): Promise<CacheEntry> => {
  const col = await getSeedCollection();
  const doc = await col.findOne({ environmentId: envId });
  const seed = doc?.seed ?? EMPTY_SEED;
  return { seed, vocabulary: resolveVocabulary(seed.vocabulary) };
};

/**
 * Seed do ambiente, ou `EMPTY_SEED` quando nao ha nenhum.
 *
 * Ambiente sem seed nao e erro: o motor roda so com as convencoes PT-BR e
 * ja classifica. O seed melhora, nao habilita.
 */
export const getSeed = async (environmentId?: string): Promise<DomainSeed> =>
  (await getCacheEntry(environmentId)).seed;

/** Convencoes PT-BR + vocabulario do ambiente, pronto para o lexico. */
export const getVocabulary = async (environmentId?: string): Promise<DomainVocabulary> =>
  (await getCacheEntry(environmentId)).vocabulary;

const getCacheEntry = async (environmentId?: string): Promise<CacheEntry> => {
  const envId = normalizeEnvId(environmentId);
  const hit = cache.get(envId);
  if (hit) return hit;
  const entry = await load(envId);
  cache.set(envId, entry);
  return entry;
};

/**
 * Grava o seed do ambiente e invalida o cache.
 *
 * Substitui inteiro em vez de mesclar: o seed e um documento curado que o
 * cliente versiona por fora, e um merge parcial tornaria impossivel REMOVER
 * um termo errado — que e exatamente o que se faz quando o vocabulario esta
 * classificando alguma coluna torto.
 */
export const saveSeed = async (seed: DomainSeed, environmentId?: string): Promise<void> => {
  const envId = normalizeEnvId(environmentId);
  const col = await getSeedCollection();
  await col.updateOne(
    { environmentId: envId },
    { $set: { seed, updatedAt: new Date() } },
    { upsert: true }
  );
  clearSeedCache(envId);
};
