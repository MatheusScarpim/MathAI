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

export const ensureSchemaCollection = async (): Promise<void> => {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === "schema_chunks");
  if (exists) {
    return;
  }

  const vectorSize = VECTOR_SIZE_BY_MODEL[EMBEDDING_MODEL] ?? 1536;
  await qdrant.createCollection("schema_chunks", {
    vectors: {
      size: vectorSize,
      distance: "Cosine"
    }
  });
};

export const clearSchemaCollection = async (): Promise<void> => {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === "schema_chunks");
  if (!exists) return;
  await qdrant.deleteCollection("schema_chunks");
};

/* ── Endpoint collection (API mode) ──────────────────────── */

export const ensureEndpointCollection = async (): Promise<void> => {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === "endpoint_chunks");
  if (exists) return;

  const vectorSize = VECTOR_SIZE_BY_MODEL[EMBEDDING_MODEL] ?? 1536;
  await qdrant.createCollection("endpoint_chunks", {
    vectors: {
      size: vectorSize,
      distance: "Cosine"
    }
  });
};

export const clearEndpointCollection = async (): Promise<void> => {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === "endpoint_chunks");
  if (!exists) return;
  await qdrant.deleteCollection("endpoint_chunks");
};
