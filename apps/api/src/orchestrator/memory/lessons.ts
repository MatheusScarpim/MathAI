import { createHash, randomUUID } from "node:crypto";
import type { WithId } from "mongodb";
import { getOpenAI, EMBEDDING_MODEL } from "../../core/openai.js";
import { qdrant, VECTOR_SIZE_BY_MODEL } from "../../core/qdrant.js";
import { getProjectLessonsCollection, type ProjectLessonRecord } from "../../core/mongo.js";

// ============== TYPES ==============

export type Lesson = {
  lessonId: string;
  title: string;
  body: string;
  tags?: string[];
  repoKey?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type LessonCreateInput = {
  title: string;
  body: string;
  tags?: string[];
  repoKey?: string;
};

export type LessonSearchOptions = {
  /** Top-K. Default 3. Cap em 10. */
  k?: number;
  /** Filtra por repoKey ("global" sempre incluido). */
  repoKey?: string;
};

// ============== CONFIG ==============

const COLLECTION = "project_lessons";
const DEFAULT_K = 3;
const MAX_K = 10;
/** Score minimo de similaridade pra incluir uma licao no resultado. */
const MIN_SCORE = 0.30;

// ============== QDRANT ==============

let ensured = false;

/** Garante a colecao Qdrant. Idempotente. */
const ensureCollection = async (): Promise<void> => {
  if (ensured) return;
  try {
    const cols = await qdrant.getCollections();
    const exists = cols.collections.some(c => c.name === COLLECTION);
    if (!exists) {
      const size = VECTOR_SIZE_BY_MODEL[EMBEDDING_MODEL] ?? 1536;
      await qdrant.createCollection(COLLECTION, {
        vectors: { size, distance: "Cosine" }
      });
    }
    ensured = true;
  } catch (err) {
    // Nao bloqueia o pipeline se Qdrant estiver fora; loga e segue.
    console.warn(`[lessons] ensureCollection failed: ${err instanceof Error ? err.message : err}`);
  }
};

// ============== EMBEDDING ==============

const embed = async (text: string): Promise<number[]> => {
  const openai = await getOpenAI();
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8000) // truncate por seguranca (limite do model e bem maior)
  });
  return res.data[0]!.embedding;
};

// ============== ID HELPERS ==============

/**
 * Qdrant point IDs precisam ser uint OR uuid. lessonId e free-form (mongo string),
 * entao geramos um UUID v5-like deterministico via hash sha-256 -> uuid4 layout.
 */
const lessonIdToPointId = (lessonId: string): string => {
  const hash = createHash("sha256").update(lessonId).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32)
  ].join("-");
};

const generateLessonId = (): string => randomUUID();

const recordToLesson = (rec: ProjectLessonRecord): Lesson => ({
  lessonId: rec.lessonId,
  title: rec.title,
  body: rec.body,
  tags: rec.tags,
  repoKey: rec.repoKey,
  createdAt: rec.createdAt,
  updatedAt: rec.updatedAt
});

// ============== CRUD ==============

export const createLesson = async (input: LessonCreateInput): Promise<Lesson> => {
  const now = new Date();
  const lessonId = generateLessonId();
  const text = `${input.title}\n\n${input.body}`;
  const vector = await embed(text).catch(() => null);

  const rec: ProjectLessonRecord = {
    lessonId,
    title: input.title,
    body: input.body,
    tags: input.tags,
    repoKey: input.repoKey,
    embedding: vector ?? undefined,
    embeddingModel: vector ? EMBEDDING_MODEL : undefined,
    createdAt: now,
    updatedAt: now
  };

  const col = await getProjectLessonsCollection();
  await col.insertOne(rec);

  if (vector) {
    await ensureCollection();
    try {
      await qdrant.upsert(COLLECTION, {
        wait: true,
        points: [{
          id: lessonIdToPointId(lessonId),
          vector,
          payload: { lessonId, title: input.title, repoKey: input.repoKey ?? "global", tags: input.tags ?? [] }
        }]
      });
    } catch (err) {
      console.warn(`[lessons] qdrant upsert failed for ${lessonId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return recordToLesson(rec);
};

export const listLessons = async (filter?: { repoKey?: string }): Promise<Lesson[]> => {
  const col = await getProjectLessonsCollection();
  const q: Record<string, unknown> = {};
  if (filter?.repoKey) q.repoKey = filter.repoKey;
  const docs = await col.find(q).sort({ updatedAt: -1 }).toArray();
  return docs.map(recordToLesson);
};

export const deleteLesson = async (lessonId: string): Promise<boolean> => {
  const col = await getProjectLessonsCollection();
  const res = await col.deleteOne({ lessonId });
  if (res.deletedCount && res.deletedCount > 0) {
    try {
      await qdrant.delete(COLLECTION, { wait: true, points: [lessonIdToPointId(lessonId)] });
    } catch {
      // ignore — mongo e a fonte da verdade
    }
    return true;
  }
  return false;
};

/**
 * Re-embeda todas as licoes do Mongo e upserta no Qdrant. Util quando o modelo
 * de embedding muda, ou pra inicializar apos um restore.
 */
export const reindexAllLessons = async (): Promise<{ indexed: number; failed: number }> => {
  await ensureCollection();
  const col = await getProjectLessonsCollection();
  const docs = await col.find({}).toArray();
  let indexed = 0;
  let failed = 0;
  for (const d of docs) {
    const text = `${d.title}\n\n${d.body}`;
    try {
      const vector = await embed(text);
      await col.updateOne(
        { _id: d._id },
        { $set: { embedding: vector, embeddingModel: EMBEDDING_MODEL, updatedAt: new Date() } }
      );
      await qdrant.upsert(COLLECTION, {
        wait: true,
        points: [{
          id: lessonIdToPointId(d.lessonId),
          vector,
          payload: { lessonId: d.lessonId, title: d.title, repoKey: d.repoKey ?? "global", tags: d.tags ?? [] }
        }]
      });
      indexed++;
    } catch (err) {
      console.warn(`[lessons] reindex failed for ${d.lessonId}: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }
  return { indexed, failed };
};

// ============== SEARCH ==============

/**
 * Retrieve top-K licoes mais similares ao query. Falha silenciosamente
 * (retorna []) se Qdrant/OpenAI estao fora — nunca bloqueia o pipeline.
 *
 * Filtragem por repoKey: inclui "global" + repoKey especifico (se passado).
 */
export const searchLessons = async (
  query: string,
  opts: LessonSearchOptions = {}
): Promise<Lesson[]> => {
  const k = Math.min(opts.k ?? DEFAULT_K, MAX_K);
  if (!query || query.trim().length === 0 || k === 0) return [];

  try {
    await ensureCollection();
    const vector = await embed(query);

    // Filter Qdrant: repoKey deve ser "global" OU igual ao repoKey passado
    const filter = opts.repoKey
      ? {
          should: [
            { key: "repoKey", match: { value: "global" } },
            { key: "repoKey", match: { value: opts.repoKey } }
          ]
        }
      : undefined;

    const res = await qdrant.search(COLLECTION, {
      vector,
      limit: k,
      filter,
      with_payload: true,
      score_threshold: MIN_SCORE
    });

    if (res.length === 0) return [];

    const lessonIds = res
      .map(p => (p.payload as { lessonId?: string } | undefined)?.lessonId)
      .filter((s): s is string => typeof s === "string");

    if (lessonIds.length === 0) return [];

    const col = await getProjectLessonsCollection();
    const docs = await col.find({ lessonId: { $in: lessonIds } }).toArray();

    // Re-ordena pra preservar ranking de similaridade do Qdrant
    const byId = new Map(docs.map(d => [d.lessonId, d]));
    return lessonIds
      .map(id => byId.get(id))
      .filter((d): d is WithId<ProjectLessonRecord> => !!d)
      .map(recordToLesson);
  } catch (err) {
    console.warn(`[lessons] search failed (returning empty): ${err instanceof Error ? err.message : err}`);
    return [];
  }
};

/**
 * Helper que formata um set de licoes como bloco de texto pra injecao em prompt.
 */
export const formatLessonsBlock = (lessons: Lesson[]): string => {
  if (lessons.length === 0) return "";
  const items = lessons.map((l, i) => {
    const tags = l.tags && l.tags.length > 0 ? ` (tags: ${l.tags.join(", ")})` : "";
    return `${i + 1}. ${l.title}${tags}\n${l.body.trim()}`;
  }).join("\n\n");
  return `Licoes aprendidas relevantes (de tarefas anteriores):\n\n${items}`;
};
