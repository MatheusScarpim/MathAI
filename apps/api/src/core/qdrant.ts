import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "./config.js";
import { EMBEDDING_MODEL } from "./openai.js";

export const VECTOR_SIZE_BY_MODEL: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072
};

export const qdrant = new QdrantClient({
  url: config.qdrantUrl
});

// ================== Schema collection (per environment) ==================

const getSchemaCollectionName = (environmentId?: string): string =>
  environmentId ? `schema_chunks_${environmentId}` : "schema_chunks";

const ensuredSchemaCollections = new Set<string>();

export const ensureSchemaCollection = async (environmentId?: string): Promise<void> => {
  const collectionName = getSchemaCollectionName(environmentId);
  if (ensuredSchemaCollections.has(collectionName)) return;

  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === collectionName);
  if (exists) {
    ensuredSchemaCollections.add(collectionName);
    return;
  }

  const vectorSize = VECTOR_SIZE_BY_MODEL[EMBEDDING_MODEL] ?? 1536;
  await qdrant.createCollection(collectionName, {
    vectors: {
      size: vectorSize,
      distance: "Cosine"
    }
  });
  ensuredSchemaCollections.add(collectionName);
};

export const clearSchemaCollection = async (environmentId?: string): Promise<void> => {
  const collectionName = getSchemaCollectionName(environmentId);
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === collectionName);
  if (!exists) return;
  await qdrant.deleteCollection(collectionName);
  ensuredSchemaCollections.delete(collectionName);
};

export { getSchemaCollectionName };

/* ── Endpoint collection (API mode, per environment) ──────────────────────── */

const getEndpointCollectionName = (environmentId?: string): string =>
  environmentId ? `endpoint_chunks_${environmentId}` : "endpoint_chunks";

const ensuredEndpointCollections = new Set<string>();

export const ensureEndpointCollection = async (environmentId?: string): Promise<void> => {
  const collectionName = getEndpointCollectionName(environmentId);
  if (ensuredEndpointCollections.has(collectionName)) return;

  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === collectionName);
  if (exists) {
    ensuredEndpointCollections.add(collectionName);
    return;
  }

  const vectorSize = VECTOR_SIZE_BY_MODEL[EMBEDDING_MODEL] ?? 1536;
  await qdrant.createCollection(collectionName, {
    vectors: {
      size: vectorSize,
      distance: "Cosine"
    }
  });
  ensuredEndpointCollections.add(collectionName);
};

export const clearEndpointCollection = async (environmentId?: string): Promise<void> => {
  const collectionName = getEndpointCollectionName(environmentId);
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === collectionName);
  if (!exists) return;
  await qdrant.deleteCollection(collectionName);
  ensuredEndpointCollections.delete(collectionName);
};

export { getEndpointCollectionName };
