import type {
  AskErrorResponse,
  AskSuccessResponse,
  ColumnFormat,
  ColumnFormatKind,
  ResultColumnMeta
} from "@auraia/shared";
import { sanitizeErrorMessage } from "@auraia/shared";
import { getAdapter } from "../core/db.js";
import {
  getHistoryCollection,
  getInstructionsCollection,
  type HistoryRecord
} from "../core/mongo.js";
import { validateSql } from "../core/validation.js";
import { ensureSchemaCollection } from "../core/qdrant.js";
import { ObjectId, type Filter } from "mongodb";
import {
  findSemanticSql,
  getCachedValue,
  getCacheKey,
  setCachedValue,
  setSemanticEntry
} from "../core/cache.js";
import { getAppConfig, getEnvironment } from "../core/appConfig.js";
import { answerQuestionApi } from "./askApi.js";
import { config } from "../core/config.js";
import { cosineSimilarity } from "../utils/math.js";
import { getTableReferenceCountSetting } from "../helpers/settings.js";
import {
  findPeriodInText,
  formatPeriodText,
  formatMonth,
  formatYearRange,
  parseYearRange,
  type DetectedPeriod,
  type YearRange
} from "../helpers/period.js";

export { findPeriodInText, formatPeriodText };

// Import agents
import { translateText, buildStandaloneQuestion } from "../agents/translation.js";
import { expandTables, searchRelevantTables, generateEmbedding, buildEmbeddingInput, estimateQueryComplexity } from "../agents/schema.js";
import { buildPrompt, generateSql, generateCorrectedSql, reflectOnError } from "../agents/sql.js";
import { classifyError, isRetriableError, type ClassifiedError } from "../agents/sqlErrors.js";
import { profileTables, type TableProfileMap } from "../agents/profiler.js";
import { checkSemanticGuards, factsFromDictionary } from "../agents/sqlGuards.js";
import { getDictionary, getVocabulary } from "../schema/dictionary.js";
import type { DictionaryIndex } from "../schema/dictionaryOps.js";
import { getSeed } from "../schema/seedStore.js";
import { resolveColumnFormats } from "../schema/columnFormat.js";
import { resolveColumnFormatsForEnvironment } from "../schema/columnFormatEnv.js";
import type { DomainVocabulary } from "../schema/vocabulary.js";
import type { MetricDefinition } from "../schema/metrics.js";
import type { TableFacts } from "../schema/tableFacts.js";
import { decomposeQuestion, combineSubQueries, type DecompositionPlan } from "../agents/planner.js";
import { summarizeResult } from "../agents/summary.js";
import { inferChart, inferChartWithLLM } from "../agents/chart.js";
import { getAgentsConfig } from "../core/agentConfig.js";

type AskResult =
  | { ok: true; data: AskSuccessResponse }
  | { ok: false; error: AskErrorResponse };

type FewShotExample = {
  question: string;
  sql: string;
  tags: string[];
  similarity: number;
};

/**
 * O que vai para o Redis: a resposta mais o metadata das colunas.
 *
 * `columnsMeta` nao faz parte de `AskSuccessResponse` de proposito — o cliente
 * nao tem uso para o tipo declarado pelo driver. Ele viaja aqui porque a
 * mascara e recalculada na leitura do cache, e sem o `scale` a derivacao
 * rebaixa as casas decimais em relacao a resposta fresca. Fica de fora do
 * payload devolvido, na desestruturacao do hit.
 */
type CachedAsk = AskSuccessResponse & { columnsMeta?: ResultColumnMeta[] };

const SEMANTIC_SIMILARITY_THRESHOLD = 0.92;
const FEW_SHOT_SIMILARITY_THRESHOLD = 0.86;
const FEW_SHOT_MAX = 2;
const ALIAS_INSTRUCTION_TEXT =
  "When using AS for aliases, write alias names in {{language}}.";
let aliasInstructionEnsured = false;

const shouldLogPrompts = (): boolean => {
  const flag = process.env.LOG_PROMPTS?.toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
};

// ============== HELPER FUNCTIONS ==============

const ensureAliasInstruction = async (): Promise<void> => {
  if (aliasInstructionEnsured) return;
  try {
    const collection = await getInstructionsCollection();
    const existing = await collection.findOne({ text: ALIAS_INSTRUCTION_TEXT });
    if (!existing) {
      await collection.insertOne({
        text: ALIAS_INSTRUCTION_TEXT,
        createdAt: new Date()
      });
    }
    aliasInstructionEnsured = true;
  } catch {
    aliasInstructionEnsured = true;
  }
};

const languageName = (language: "pt" | "en" | "es"): string =>
  language === "pt" ? "Portuguese" : language === "es" ? "Spanish" : "English";

const applyInstructionTemplate = (
  text: string,
  responseLanguage: "pt" | "en" | "es"
): string => text.replace(/{{\s*language\s*}}/gi, languageName(responseLanguage));

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

const truncateRows = <T>(rows: T[]): T[] =>
  rows.slice(0, config.historyMaxRows);

const fallbackSummary = (
  rowCount: number,
  language: "pt" | "en" | "es"
): string => {
  if (language === "en") {
    return rowCount === 0 ? "No results were found for this question." : `The query returned ${rowCount} result${rowCount === 1 ? "" : "s"}.`;
  }
  if (language === "es") {
    return rowCount === 0 ? "No se encontraron resultados para esta pregunta." : `La consulta devolvio ${rowCount} resultado${rowCount === 1 ? "" : "s"}.`;
  }
  return rowCount === 0 ? "Nenhum resultado foi encontrado para esta pergunta." : `A consulta retornou ${rowCount} resultado${rowCount === 1 ? "" : "s"}.`;
};

const ensureSummary = (
  summary: string | undefined,
  rowCount: number,
  language: "pt" | "en" | "es"
): string => summary?.trim() || fallbackSummary(rowCount, language);

// ============== HISTORY & FEW-SHOT LOADERS ==============

const loadHistoryForRewrite = async (
  chatId: string,
  targetLanguage: "pt" | "en" | "es"
): Promise<string[]> => {
  const collection = await getHistoryCollection();
  const items = await collection
    .find({ chatId })
    .sort({ createdAt: -1 })
    .limit(4)
    .toArray();

  const ordered = items.reverse();
  const questions = await Promise.all(
    ordered.map(async (item) => {
      if (item.embeddingQuestion) return item.embeddingQuestion;
      const base = item.question || "";
      const itemLang = item.language ?? "pt";
      if (!base || itemLang === targetLanguage) return base;
      try {
        return await translateText(base, targetLanguage, "history-rewrite");
      } catch {
        return base;
      }
    })
  );

  return questions.filter((value) => value.trim().length > 0);
};

const loadFewShotExamples = async (
  chatId: string | undefined,
  language: "pt" | "en" | "es",
  embedding: number[]
): Promise<FewShotExample[]> => {
  if (!embedding.length) return [];
  const collection = await getHistoryCollection();
  const baseFilter = {
    favorite: true,
    sql: { $type: "string", $ne: "" },
    embedding: { $type: "array" }
  } satisfies Filter<HistoryRecord>;
  const languageFilter = {
    $or: [{ language }, { language: { $exists: false } }]
  };

  const items: Array<{
    id: string;
    question: string;
    sql: string;
    tags: string[];
    embedding?: number[];
    language?: "pt" | "en" | "es";
  }> = [];
  const seen = new Set<string>();

  if (chatId) {
    const sameChat = await collection
      .find({ ...baseFilter, ...languageFilter, chatId })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    for (const doc of sameChat) {
      const id = doc._id?.toString() ?? "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push({
        id,
        question: doc.embeddingQuestion ?? doc.question,
        sql: doc.sql,
        tags: doc.tags ?? [],
        embedding: doc.embedding,
        language: doc.language
      });
    }
  }

  if (items.length < FEW_SHOT_MAX) {
    const extra = await collection
      .find({ ...baseFilter, ...languageFilter })
      .sort({ createdAt: -1 })
      .limit(150)
      .toArray();
    for (const doc of extra) {
      const id = doc._id?.toString() ?? "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push({
        id,
        question: doc.embeddingQuestion ?? doc.question,
        sql: doc.sql,
        tags: doc.tags ?? [],
        embedding: doc.embedding,
        language: doc.language
      });
    }
  }

  const scored = items
    .map((item) => ({
      question: item.question,
      sql: item.sql,
      tags: item.tags,
      similarity: cosineSimilarity(embedding, item.embedding ?? []),
      language: item.language
    }))
    .filter((item) => item.similarity >= FEW_SHOT_SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity);

  const top = scored.slice(0, FEW_SHOT_MAX);
  const translated = await Promise.all(
    top.map(async (item) => {
      const base: FewShotExample = {
        question: item.question,
        sql: item.sql,
        tags: item.tags,
        similarity: item.similarity
      };
      if (!item.question) return base;
      const itemLang = item.language ?? language;
      if (itemLang === language) return base;
      try {
        const translatedQuestion = await translateText(item.question, language, "fewshot");
        return { ...base, question: translatedQuestion };
      } catch {
        return base;
      }
    })
  );

  return translated;
};

const buildHistorySnippet = async (
  chatId: string | undefined,
  language: "pt" | "en" | "es"
): Promise<string | null> => {
  if (!chatId) return null;
  const collection = await getHistoryCollection();
  const items = await collection
    .find({ chatId })
    .sort({ createdAt: -1 })
    .limit(4)
    .toArray();

  if (!items.length) return null;

  const reversed = items.reverse();
  const lines = await Promise.all(
    reversed.map(async (item, index) => {
      let questionText = item.embeddingQuestion ?? item.question;
      const itemLang = item.language ?? "pt";
      if (!item.embeddingQuestion && item.question && itemLang !== language) {
        try {
          questionText = await translateText(item.question, language, "history-snippet");
        } catch {
          questionText = item.question;
        }
      }
      const q = truncate(questionText, 300);
      const summaryText = typeof item.summary === "string" ? item.summary : "";
      const includeSummary =
        summaryText.length > 0 &&
        (item.responseLanguage === language ||
          (!item.responseLanguage && language === "pt"));
      const s = includeSummary ? truncate(summaryText, 300) : null;
      const questionLabel =
        language === "en" ? "Q" : language === "es" ? "P" : "P";
      const answerLabel = language === "en" ? "A" : language === "es" ? "R" : "R";
      return [
        `(${index + 1}) ${questionLabel}: ${q}`,
        s ? `${answerLabel}: ${s}` : null
      ]
        .filter((line) => line !== null)
        .join("\n");
    })
  );

  return lines.join("\n");
};

const buildPeriodHint = async (
  chatId: string | undefined,
  question: string,
  language: "pt" | "en" | "es"
): Promise<string | null> => {
  if (!chatId) return null;
  const current = findPeriodInText(question);
  if (current?.month || current?.year || current?.range) return null;

  const collection = await getHistoryCollection();
  const items = await collection
    .find({ chatId })
    .sort({ createdAt: -1 })
    .limit(6)
    .toArray();

  for (const item of items) {
    const period = findPeriodInText(item.question);
    if (period?.range) return formatYearRange(period.range, language);
    if (period?.month || period?.year) {
      const monthLabel = period.month ? formatMonth(period.month, language) : null;
      if (monthLabel && period.year) return `${monthLabel} ${period.year}`;
      if (monthLabel) return monthLabel;
      if (period.year) return String(period.year);
    }
  }

  return null;
};

// ============== MAIN FUNCTION ==============

export type StepEmitter = (event: string, data: unknown) => void;

export const answerQuestion = async (
  question: string,
  chatId?: string,
  language: "pt" | "en" | "es" = "pt",
  schemaLanguage: "pt" | "en" | "es" = language,
  responseLanguage: "pt" | "en" | "es" = language,
  emit?: StepEmitter,
  environmentId?: string,
  historyId?: string
): Promise<AskResult> => {
  // Fallback: se não veio environmentId, buscar pelo historyId ou chatId no histórico
  let resolvedEnvironmentId = environmentId;
  if (!resolvedEnvironmentId) {
    try {
      const historyCollection = await getHistoryCollection();
      let found: { environmentId?: string } | null = null;

      if (historyId?.trim()) {
        found = await historyCollection.findOne(
          { _id: new ObjectId(historyId.trim()), environmentId: { $exists: true, $nin: [null as unknown as string, ""] } },
          { projection: { environmentId: 1 } }
        );
      }

      if (!found && chatId?.trim()) {
        found = await historyCollection.findOne(
          { chatId: chatId.trim(), environmentId: { $exists: true, $nin: [null as unknown as string, ""] } },
          { sort: { createdAt: -1 }, projection: { environmentId: 1 } }
        );
      }

      if (found?.environmentId) {
        resolvedEnvironmentId = found.environmentId;
      }
    } catch { /* ignore, proceed without */ }
  }

  await ensureSchemaCollection(resolvedEnvironmentId);
  await ensureAliasInstruction();

  const normalizedQuestion = question.trim();
  const resolvedSchemaLanguage = schemaLanguage ?? language;
  const resolvedResponseLanguage = responseLanguage ?? language;
  const agentsCfg = await getAgentsConfig();

  // Step 1: Translate question if needed (TranslationAgent)
  emit?.("step", { step: "translating", label: "Traduzindo pergunta..." });
  let translatedQuestion = normalizedQuestion;
  if (resolvedSchemaLanguage !== language && agentsCfg.translation.enabled !== false) {
    try {
      translatedQuestion = await translateText(normalizedQuestion, resolvedSchemaLanguage, "question");
    } catch {
      translatedQuestion = normalizedQuestion;
    }
  }

  const normalizedChatId = chatId?.trim() ? chatId.trim() : undefined;
  const resolvedChatId = normalizedChatId ?? `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Step 2: Build standalone question from history (TranslationAgent)
  emit?.("step", { step: "building_context", label: "Construindo contexto..." });
  let concreteQuestion = translatedQuestion.trim() || normalizedQuestion;
  let isNewTopic = false;
  if (normalizedChatId && agentsCfg.translation.enabled !== false) {
    const historyForRewrite = await loadHistoryForRewrite(normalizedChatId, resolvedSchemaLanguage);
    if (historyForRewrite.length) {
      try {
        const result = await buildStandaloneQuestion(translatedQuestion, historyForRewrite, resolvedSchemaLanguage);
        isNewTopic = result.isNewTopic;
        if (result.question.trim()) {
          concreteQuestion = result.question;
        }
      } catch {
        concreteQuestion = translatedQuestion.trim() || normalizedQuestion;
      }
    }
  }

  const embeddingQuestion = concreteQuestion.trim() || normalizedQuestion;

  // Step 3: Check direct cache
  const cacheKey = getCacheKey(normalizedQuestion, resolvedChatId, language, resolvedSchemaLanguage, resolvedResponseLanguage, resolvedEnvironmentId);
  const cached = await getCachedValue<CachedAsk>(cacheKey);

  // Step 4: Generate embedding (SchemaAgent) — skip history if new topic detected
  emit?.("step", { step: "embedding", label: "Gerando embedding..." });
  const embeddingChatId = isNewTopic ? undefined : resolvedChatId;
  const embeddingInput = await buildEmbeddingInput(embeddingQuestion, embeddingChatId, resolvedSchemaLanguage);
  const vector = await generateEmbedding(embeddingInput);

  const schemaQuestion = embeddingQuestion;
  const displayQuestion = normalizedQuestion;

  // ── Mode branching: delegate to API orchestrator if mode === "api" ──
  const currentConfig = resolvedEnvironmentId ? await getEnvironment(resolvedEnvironmentId) : await getAppConfig();
  if (currentConfig?.mode === "api") {
    return answerQuestionApi({
      normalizedQuestion,
      embeddingQuestion,
      concreteQuestion,
      vector,
      resolvedChatId,
      language,
      resolvedSchemaLanguage,
      resolvedResponseLanguage,
      environmentId: resolvedEnvironmentId,
      emit
    });
  }

  if (cached) {
    emit?.("step", { step: "cache_hit", label: "Resultado encontrado no cache!" });
    const { columnsMeta: cachedMeta, ...cachedResponse } = cached;
    const cachedRows = cached.rows ?? [];
    const cachedColumns = cached.columns ?? [];
    // A entrada de cache pode ter sido gravada por uma versao anterior da
    // derivacao de mascara (TTL de 900s, chave sem versao). Recalcular aqui e
    // barato porque getSeed/getVocabulary sao memoizados em processo.
    //
    // `cachedMeta` viaja no payload so para isto: sem ele a derivacao perde o
    // `scale` do driver e a mesma coluna sai com menos casas no hit do que na
    // resposta fresca. Ausente em entrada gravada antes deste campo existir.
    const cachedFormats = await resolveColumnFormatsForEnvironment(resolvedEnvironmentId, cachedColumns, cachedRows, cachedMeta);
    const historyCollection = await getHistoryCollection();
    const historyResult = await historyCollection.insertOne({
      environmentId: resolvedEnvironmentId,
      question: normalizedQuestion,
      embeddingQuestion,
      sql: cached.sql ?? "",
      rows: truncateRows(cachedRows),
      columns: cachedColumns,
      columnFormats: cachedFormats,
      chart: cached.chart,
      summary: cached.summary,
      createdAt: new Date(),
      favorite: false,
      tags: [],
      chatId: resolvedChatId,
      language: resolvedSchemaLanguage,
      responseLanguage: resolvedResponseLanguage,
      success: true,
      elapsedMs: cached.elapsedMs ?? 0,
      rowCount: cachedRows.length,
      embedding: vector
    });
    return {
      ok: true,
      data: {
        // `cachedResponse` e o payload sem `columnsMeta`: o meta e detalhe do
        // cache, nao contrato da resposta.
        ...cachedResponse,
        columnFormats: cachedFormats,
        summary: ensureSummary(cached.summary, cachedRows.length, resolvedResponseLanguage),
        cacheHit: true,
        historyId: historyResult.insertedId.toString(),
        responseLanguage: resolvedResponseLanguage,
        translatedQuestion: cached.translatedQuestion ?? embeddingQuestion
      }
    };
  }

  const adapter = await getAdapter(resolvedEnvironmentId);
  const dbType = adapter.getDbType();

  // Step 5: Check semantic cache (with mismatch detection)
  emit?.("step", { step: "checking_cache", label: "Verificando cache semantico..." });
  const semanticMatch = await findSemanticSql(resolvedChatId, resolvedResponseLanguage, resolvedSchemaLanguage, vector, SEMANTIC_SIMILARITY_THRESHOLD, resolvedEnvironmentId);

  // Extract all numbers from question and cached SQL to detect mismatches
  const extractNumbers = (text: string): string[] => {
    const matches = text.match(/\b\d+\b/g) ?? [];
    return [...new Set(matches)].sort();
  };

  const questionNumbers = extractNumbers(embeddingQuestion);
  const cachedSqlNumbers = semanticMatch?.sql ? extractNumbers(semanticMatch.sql) : [];

  // Check if important numbers from question are missing in cached SQL
  const hasNumberMismatch = questionNumbers.length > 0 && questionNumbers.some(num => {
    // Skip small numbers (likely not IDs or years)
    const n = parseInt(num, 10);
    if (n < 100) return false;
    // Check if this number exists in cached SQL
    return !cachedSqlNumbers.includes(num);
  });

  // ── Text-level mismatch detection (Jaccard similarity) ──
  // Embedding similarity alone can miss differences between questions in
  // the same domain (e.g., same table, different filters). We compute a
  // Jaccard index on the meaningful terms of both questions; if overlap
  // is too low the cache hit is discarded regardless of cosine score.
  const TERM_SIMILARITY_THRESHOLD = 0.4;

  const extractTerms = (text: string): Set<string> => {
    const normalized = text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[''"""`]/g, "");
    const stopwords = new Set([
      "o", "a", "os", "as", "de", "do", "da", "dos", "das", "em", "no", "na",
      "nos", "nas", "por", "para", "com", "que", "qual", "quais", "foi", "sao",
      "total", "todos", "todas", "some", "um", "uma", "ao", "aos", "se", "ou",
      "e", "the", "of", "in", "and", "to", "what", "how", "was", "is", "are",
      "were", "all", "from", "which", "me", "meu", "minha", "seu", "sua",
    ]);
    return new Set(
      normalized.split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w))
    );
  };

  const jaccardSimilarity = (a: Set<string>, b: Set<string>): number => {
    if (!a.size && !b.size) return 1;
    let intersection = 0;
    for (const term of a) {
      if (b.has(term)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 1 : intersection / union;
  };

  let hasTermMismatch = false;
  if (semanticMatch?.sql && semanticMatch.question) {
    const newTerms = extractTerms(embeddingQuestion);
    const cachedTerms = extractTerms(semanticMatch.question);
    const termSim = jaccardSimilarity(newTerms, cachedTerms);
    hasTermMismatch = termSim < TERM_SIMILARITY_THRESHOLD;
  }

  const shouldSkipCache = hasNumberMismatch || hasTermMismatch;

  if (shouldSkipCache && shouldLogPrompts()) {
    const reason = hasNumberMismatch ? "number" : "term";
    console.info(`[semantic-cache] Skipping cache due to ${reason} mismatch: question="${embeddingQuestion}", cached="${semanticMatch?.question ?? ""}"`);
  }

  // Detected before the cache branch below: a cache hit returns early, and the
  // summary needs the range there too or it describes a continuous interval as a
  // two-point comparison. `buildStandaloneQuestion` rewrites follow-ups like
  // "e de 2017 a 2025" and can drop the interval syntax, so the raw question is
  // consulted first.
  const detectedRange = parseYearRange(question) ?? parseYearRange(schemaQuestion);
  const rawPeriod: DetectedPeriod = detectedRange
    ? { range: detectedRange }
    : findPeriodInText(schemaQuestion) ?? {};
  const currentPeriodText = formatPeriodText(rawPeriod, resolvedSchemaLanguage);

  // Guardas semanticas (E3). Carregadas aqui, antes do primeiro caminho que
  // executa SQL: o cache semantico devolve consulta gerada em outro dia, que
  // pode ser anterior as proprias guardas — e uma resposta errada servida do
  // cache se repete a cada pergunta parecida, em vez de acontecer uma vez.
  //
  // Uma leitura por pergunta, nao por tentativa: o schema nao muda no meio.
  // Qualquer falha aqui desliga as guardas em vez de derrubar a pergunta —
  // ambiente que nunca rodou o ingest tem de continuar respondendo.
  let semanticGuards: {
    facts: TableFacts[];
    dictionary: DictionaryIndex;
    overlappingBuckets: Readonly<Record<string, readonly string[]>>;
    notes: readonly string[];
  } | null = null;
  // O catalogo de metricas e independente das guardas: um ambiente pode ter
  // seed com formulas antes de ter dicionario ingerido. Por isso vive fora do
  // `if (facts.length > 0)` acima.
  let seedMetrics: readonly MetricDefinition[] = [];
  // Hoistados pelo mesmo motivo que `seedMetrics`: a mascara de exibicao e
  // calculada na hora de montar a resposta, fora deste try. Sem seed valem as
  // convencoes PT-BR embutidas.
  let formatVocabulary: DomainVocabulary | undefined;
  let seedColumnFormats: Readonly<Record<string, ColumnFormatKind>> = {};
  try {
    const [dictionary, vocabulary, seed] = await Promise.all([
      getDictionary(resolvedEnvironmentId),
      getVocabulary(resolvedEnvironmentId),
      getSeed(resolvedEnvironmentId)
    ]);
    const facts = factsFromDictionary(dictionary);
    // As notes nao dependem do ingest: sao prosa do seed. Um ambiente recem
    // semeado, ainda sem dicionario, precisa levar a legenda do banco para o
    // prompt — com `facts` vazio nenhuma guarda dispara, e so as notes saem.
    if (facts.length > 0 || vocabulary.notes.length > 0) {
      semanticGuards = {
        facts,
        dictionary,
        overlappingBuckets: vocabulary.overlappingBuckets,
        notes: vocabulary.notes
      };
    }
    seedMetrics = seed.metrics;
    formatVocabulary = vocabulary;
    seedColumnFormats = seed.columnFormats;
  } catch { /* sem dicionario as guardas ficam caladas, nao quebram a pergunta */ }

  /** Mascara de cada coluna do resultado. Ver `schema/columnFormat.ts`. */
  const formatsFor = (
    result: { columns: string[]; columnsMeta?: ResultColumnMeta[] },
    rows: readonly Record<string, unknown>[]
  ): Record<string, ColumnFormat> =>
    resolveColumnFormats(result.columnsMeta ?? result.columns.map((name) => ({ name, type: "" })), {
      vocabulary: formatVocabulary,
      overrides: seedColumnFormats,
      samples: rows
    });

  const guardSql = (candidate: string): ClassifiedError | null =>
    semanticGuards
      ? checkSemanticGuards(candidate, semanticGuards.facts, semanticGuards.dictionary, {
          dbType,
          overlappingBuckets: semanticGuards.overlappingBuckets
        })
      : null;

  if (semanticMatch?.sql && !shouldSkipCache) {
    const validation = validateSql(semanticMatch.sql, dbType);
    const cachedGuardError = validation.ok ? guardSql(semanticMatch.sql) : null;
    if (cachedGuardError) {
      // Nao ha o que corrigir num SQL que veio pronto: descartar o cache e
      // deixar o fluxo normal gerar de novo ja e a correcao.
      console.warn(
        `[semantic-cache] SQL em cache rejeitado por guarda semantica (${cachedGuardError.originalMessage}); regenerando`
      );
    }
    if (validation.ok && !cachedGuardError) {
      try {
        const start = Date.now();
        const result = await adapter.query(semanticMatch.sql);
        const elapsedMs = Date.now() - start;
        const rowCount = result.recordset?.length ?? 0;
        const columns = result.columns;
        const columnFormats = formatsFor(result, result.recordset ?? []);

        // Run chart + summary in parallel to reduce end-to-end latency.
        const chartEnabled = agentsCfg.chart.enabled !== false;
        const summaryEnabled = agentsCfg.summary.enabled !== false;
        const parallelTasks: [Promise<unknown>, Promise<unknown>] = [
          chartEnabled
            ? inferChartWithLLM(displayQuestion, result.recordset ?? [], columns, resolvedResponseLanguage)
            : Promise.resolve(undefined),
          summaryEnabled
            ? summarizeResult(schemaQuestion, semanticMatch.sql, columns, result.recordset ?? [], resolvedSchemaLanguage, rawPeriod.range ?? null)
            : Promise.resolve({ summary: undefined, usage: undefined })
        ];
        const [chartResult, summaryResultSettled] = await Promise.allSettled(parallelTasks);

        let chart = chartEnabled
          ? (chartResult.status === "fulfilled"
              ? (chartResult.value as AskSuccessResponse["chart"])
              : inferChart(result.recordset ?? [], columns, displayQuestion))
          : undefined;

        let summary: string | undefined;
        let summaryUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
        if (summaryEnabled && summaryResultSettled.status === "fulfilled") {
          const settled = summaryResultSettled.value as { summary?: string; usage?: typeof summaryUsage };
          summary = settled.summary;
          if (settled.usage) summaryUsage = settled.usage;
        } else if (summaryEnabled && summaryResultSettled.status === "rejected") {
          console.warn("[summary-failed] usando fallback:", summaryResultSettled.reason);
        }

        summary = ensureSummary(summary, rowCount, resolvedResponseLanguage);

        if (summary && resolvedSchemaLanguage !== resolvedResponseLanguage && agentsCfg.translation.enabled !== false) {
          try {
            summary = await translateText(summary, resolvedResponseLanguage, "summary");
          } catch { /* keep original */ }
        }

        const historyCollection = await getHistoryCollection();
        const historyResult = await historyCollection.insertOne({
          environmentId: resolvedEnvironmentId,
          question: normalizedQuestion,
          embeddingQuestion,
          sql: semanticMatch.sql,
          rows: truncateRows(result.recordset ?? []),
          columns,
          columnFormats,
          chart,
          summary,
          createdAt: new Date(), favorite: false, tags: [], chatId: resolvedChatId,
          language: resolvedSchemaLanguage, responseLanguage: resolvedResponseLanguage,
          success: true, elapsedMs, rowCount, embedding: vector,
          tokenUsage: {
            summary: summaryUsage.total_tokens ? { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 } : undefined,
            total: { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 }
          }
        });

        const responseData: AskSuccessResponse = {
          sql: semanticMatch.sql, rows: result.recordset ?? [], columns, columnFormats, elapsedMs,
          chatId: resolvedChatId, historyId: historyResult.insertedId.toString(),
          summary, cacheHit: true, chart, responseLanguage: resolvedResponseLanguage,
          translatedQuestion: schemaQuestion,
          tokenUsage: {
            summary: summaryUsage.total_tokens ? { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 } : undefined,
            total: { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 }
          }
        };
        await setCachedValue(cacheKey, { ...responseData, columnsMeta: result.columnsMeta });
        await setSemanticEntry(resolvedChatId, resolvedResponseLanguage, resolvedSchemaLanguage, { embedding: vector, sql: semanticMatch.sql, question: normalizedQuestion, createdAt: new Date().toISOString() }, resolvedEnvironmentId);
        return { ok: true, data: responseData };
      } catch { /* Fall back to LLM generation */ }
    }
  }

  // Step 6: Search relevant tables (SchemaAgent)
  emit?.("step", { step: "searching_tables", label: "Buscando tabelas relevantes..." });
  const tableReferenceCount = await getTableReferenceCountSetting();
  const initialTables = await searchRelevantTables(vector, embeddingQuestion, tableReferenceCount, resolvedEnvironmentId);
  if (initialTables.length === 0) {
    return {
      ok: false,
      error: { errorMessage: "Nenhuma tabela relevante encontrada no schema indexado.", hint: "Rode /api/ingest/schema para indexar o banco." }
    };
  }

  // Step 7: Expand tables context (SchemaAgent) — dynamic hops based on question complexity
  const hops = estimateQueryComplexity(embeddingQuestion, initialTables.length);
  const context = await expandTables(initialTables, hops, resolvedEnvironmentId);

  // Step 7.5: Profile tables to discover real column values for low-cardinality columns
  let tableProfiles: TableProfileMap = new Map();
  try {
    tableProfiles = await profileTables(context.tables, adapter, dbType, resolvedEnvironmentId);
  } catch { /* non-critical, proceed without profiles */ }

  const historySnippet = currentPeriodText || isNewTopic ? null : await buildHistorySnippet(resolvedChatId, resolvedSchemaLanguage);
  const periodHint = await buildPeriodHint(resolvedChatId, schemaQuestion, resolvedSchemaLanguage);

  // Step 8: Load instructions
  const instructionsCollection = await getInstructionsCollection();
  const instructions = await instructionsCollection.find({}).sort({ createdAt: -1 }).limit(10).toArray();
  const aliasInstruction = applyInstructionTemplate(ALIAS_INSTRUCTION_TEXT, resolvedResponseLanguage);
  const instructionLines = instructions.map((item: { text: string }) => `- ${applyInstructionTemplate(item.text, resolvedResponseLanguage)}`);
  if (!instructionLines.some((line) => line.includes(aliasInstruction))) {
    instructionLines.push(`- ${aliasInstruction}`);
  }
  const instructionText = instructionLines.length ? instructionLines.join("\n") : "";

  // Step 9: Load few-shot examples and adjust years
  let fewShotExamples = await loadFewShotExamples(resolvedChatId, resolvedSchemaLanguage, vector);
  if (currentPeriodText && rawPeriod.year) {
    fewShotExamples = fewShotExamples.map((example) => {
      const examplePeriod = findPeriodInText(example.question) ?? {};
      if (examplePeriod.year && examplePeriod.year !== rawPeriod.year) {
        const yearStr = String(rawPeriod.year);
        return {
          ...example,
          question: example.question.replace(/\b20\d{2}\b/g, yearStr),
          sql: example.sql.replace(/\b20\d{2}\b/g, yearStr)
        };
      }
      return example;
    });
  }

  // Step 10: Query Decomposition (PlannerAgent)
  let decompositionPlan: DecompositionPlan | null = null;
  let plannerUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
  if (rawPeriod.range) {
    // A continuous interval is one aggregated query. Decomposing it turns the
    // range into its two endpoints and silently drops every year in between.
    emit?.("step", {
      step: "planning",
      label: `Intervalo continuo detectado (${rawPeriod.range.startYear}-${rawPeriod.range.endYear}) — consulta unica agregada por ano.`
    });
  } else {
    emit?.("step", { step: "planning", label: "Analisando complexidade da pergunta..." });
    try {
      decompositionPlan = await decomposeQuestion(schemaQuestion, context, resolvedSchemaLanguage, dbType);
      if (decompositionPlan.usage) plannerUsage = decompositionPlan.usage;
    } catch (error) {
      // decomposeQuestion already degrades gracefully on its own failures, so
      // reaching here means something unexpected broke. Swallowing it without a
      // trace is what made a dead planner look like an idle one.
      decompositionPlan = null;
      console.warn(
        `[planner-error] ${error instanceof Error ? error.message : String(error)} - seguindo sem decomposicao`
      );
    }
  }

  // Step 11: SQL Generation Loop (SQLAgent) with Self-Correction Feedback Loop
  emit?.("step", { step: "generating_sql", label: "Gerando SQL..." });
  const maxAttempts = agentsCfg.sql.maxRetries ?? 3;
  let lastError: string | null = null;
  let lastSql: string | null = null;
  let lastClassifiedError: ReturnType<typeof classifyError> | null = null;
  let lastReflection: string | null = null;
  type UsageBucket = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  const sqlMiniUsage: UsageBucket = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const sqlLargeUsage: UsageBucket = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const summaryUsage: UsageBucket = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let forceLargeModel = false;

  const addTo = (bucket: UsageBucket, usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => {
    const pt = usage.prompt_tokens ?? 0;
    const ct = usage.completion_tokens ?? 0;
    bucket.prompt_tokens += pt;
    bucket.completion_tokens += ct;
    bucket.total_tokens += usage.total_tokens ?? (pt + ct);
  };
  const accumulateMiniUsage = (usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => { if (usage) addTo(sqlMiniUsage, usage); };
  const accumulateLargeUsage = (usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => { if (usage) addTo(sqlLargeUsage, usage); };


  // ── Decomposed query path: generate SQL for each sub-question, then combine ──
  if (decompositionPlan?.needsDecomposition && decompositionPlan.subQuestions.length >= 2) {
    emit?.("step", { step: "decomposing", label: `Decompondo em ${decompositionPlan.subQuestions.length} sub-consultas...` });

    const subSqls: Array<{ id: string; sql: string; question: string }> = [];
    let decompositionFailed = false;

    for (const subQ of decompositionPlan.subQuestions) {
      const subPrompt = buildPrompt(subQ.question, context, null, fewShotExamples, null, null, resolvedSchemaLanguage, currentPeriodText, tableProfiles, null, semanticGuards, seedMetrics);
      const subPromptWithPeriod = periodHint
        ? `${subPrompt}\n\n${resolvedSchemaLanguage === "en" ? `Fixed period from chat history: ${periodHint}` : resolvedSchemaLanguage === "es" ? `Periodo fijo del historial del chat: ${periodHint}` : `Periodo fixo do historico do chat: ${periodHint}`}`
        : subPrompt;

      emit?.("step", { step: "generating_sub_sql", label: `Gerando SQL: ${subQ.focus}...` });
      const subResult = await generateSql(subPromptWithPeriod, instructionText, resolvedSchemaLanguage, dbType, false, false);
      accumulateLargeUsage(subResult.usage);

      const subValidation = validateSql(subResult.sql, dbType);
      if (!subValidation.ok) {
        decompositionFailed = true;
        if (shouldLogPrompts()) console.info(`[planner] Sub-query ${subQ.id} validation failed, falling back to single query`);
        break;
      }
      subSqls.push({ id: subQ.id, sql: subResult.sql, question: subQ.question });
    }

    if (!decompositionFailed && subSqls.length === decompositionPlan.subQuestions.length) {
      emit?.("step", { step: "combining_sql", label: "Combinando sub-consultas..." });
      try {
        const combined = await combineSubQueries(decompositionPlan, subSqls, resolvedSchemaLanguage, dbType, instructionText);
        accumulateLargeUsage(combined.usage);

        const combinedValidation = validateSql(combined.sql, dbType);
        // Guarda semantica na consulta combinada. Aqui ela e ainda mais
        // necessaria que no caminho normal: combinar sub-consultas e
        // exatamente onde acumulado e taxa acabam dentro de um SUM que
        // ninguem reviu. Rejeitada, cai no fallback de consulta unica logo
        // abaixo, que tem loop de retry para corrigir.
        const combinedGuardError = combinedValidation.ok ? guardSql(combined.sql) : null;
        if (combinedGuardError) {
          if (shouldLogPrompts()) {
            console.info(`[planner] Combined query blocked by guard: ${combinedGuardError.originalMessage}`);
          }
        }
        if (combinedValidation.ok && !combinedGuardError) {
          const sql = combined.sql;
          emit?.("sql", { sql });

          emit?.("step", { step: "executing_query", label: "Executando query combinada..." });
          const start = Date.now();
          const queryResult = await adapter.query(sql);
          const elapsedMs = Date.now() - start;
          const rowCount = queryResult.recordset?.length ?? 0;
          const columns = queryResult.columns;
          const columnFormats = formatsFor(queryResult, queryResult.recordset ?? []);
          emit?.("rows", { rows: queryResult.recordset ?? [], columns, columnFormats, elapsedMs });

          emit?.("step", { step: "summarizing", label: "Gerando resumo..." });
          const chartEnabled2 = agentsCfg.chart.enabled !== false;
          const summaryEnabled2 = agentsCfg.summary.enabled !== false;
          const parallelTasks2: [Promise<unknown>, Promise<unknown>] = [
            chartEnabled2
              ? inferChartWithLLM(displayQuestion, queryResult.recordset ?? [], columns, resolvedResponseLanguage)
              : Promise.resolve(undefined),
            summaryEnabled2
              ? summarizeResult(schemaQuestion, sql, columns, queryResult.recordset ?? [], resolvedSchemaLanguage, rawPeriod.range ?? null)
              : Promise.resolve({ summary: undefined, usage: undefined })
          ];
          const [chartResult, summaryResultSettled] = await Promise.allSettled(parallelTasks2);

          let chart = chartEnabled2
            ? (chartResult.status === "fulfilled"
                ? (chartResult.value as AskSuccessResponse["chart"])
                : inferChart(queryResult.recordset ?? [], columns, displayQuestion))
            : undefined;

          let summary: string | undefined;
          if (summaryEnabled2 && summaryResultSettled.status === "fulfilled") {
            const settled = summaryResultSettled.value as { summary?: string; usage?: typeof summaryUsage };
            summary = settled.summary;
            if (settled.usage) {
              addTo(summaryUsage, settled.usage);
            }
          } else if (summaryEnabled2 && summaryResultSettled.status === "rejected") {
            console.warn("[summary-failed] usando fallback:", summaryResultSettled.reason);
          }

          summary = ensureSummary(summary, rowCount, resolvedResponseLanguage);

        if (summary && resolvedSchemaLanguage !== resolvedResponseLanguage && agentsCfg.translation.enabled !== false) {
            try {
              summary = await translateText(summary, resolvedResponseLanguage, "summary");
            } catch { /* keep original */ }
          }

          const historyCollection = await getHistoryCollection();
          const historyResult = await historyCollection.insertOne({
            environmentId: resolvedEnvironmentId,
            question: normalizedQuestion, embeddingQuestion, sql,
            rows: truncateRows(queryResult.recordset ?? []), columns, columnFormats, chart, summary,
            createdAt: new Date(), favorite: false, tags: [], chatId: resolvedChatId,
            language: resolvedSchemaLanguage, responseLanguage: resolvedResponseLanguage,
            success: true, elapsedMs, rowCount, embedding: vector,
            tokenUsage: {
              planner: plannerUsage.total_tokens ? { inputTokens: plannerUsage.prompt_tokens ?? 0, outputTokens: plannerUsage.completion_tokens ?? 0, totalTokens: plannerUsage.total_tokens ?? 0 } : undefined,
              sqlMini: sqlMiniUsage.total_tokens ? { inputTokens: sqlMiniUsage.prompt_tokens ?? 0, outputTokens: sqlMiniUsage.completion_tokens ?? 0, totalTokens: sqlMiniUsage.total_tokens ?? 0 } : undefined,
              sqlLarge: sqlLargeUsage.total_tokens ? { inputTokens: sqlLargeUsage.prompt_tokens ?? 0, outputTokens: sqlLargeUsage.completion_tokens ?? 0, totalTokens: sqlLargeUsage.total_tokens ?? 0 } : undefined,
              summary: summaryUsage.total_tokens ? { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 } : undefined,
              total: { inputTokens: (plannerUsage.prompt_tokens ?? 0) + (sqlMiniUsage.prompt_tokens ?? 0) + (sqlLargeUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0), outputTokens: (plannerUsage.completion_tokens ?? 0) + (sqlMiniUsage.completion_tokens ?? 0) + (sqlLargeUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0), totalTokens: (plannerUsage.total_tokens ?? 0) + (sqlMiniUsage.total_tokens ?? 0) + (sqlLargeUsage.total_tokens ?? 0) + (summaryUsage.total_tokens ?? 0) }
            }
          });

          const responseData: AskSuccessResponse = {
            sql, rows: queryResult.recordset ?? [], columns, columnFormats, elapsedMs,
            chatId: resolvedChatId, historyId: historyResult.insertedId.toString(),
            summary, cacheHit: false, chart, responseLanguage: resolvedResponseLanguage,
            translatedQuestion: schemaQuestion,
            tokenUsage: {
              planner: plannerUsage.total_tokens ? { inputTokens: plannerUsage.prompt_tokens ?? 0, outputTokens: plannerUsage.completion_tokens ?? 0, totalTokens: plannerUsage.total_tokens ?? 0 } : undefined,
              sqlMini: sqlMiniUsage.total_tokens ? { inputTokens: sqlMiniUsage.prompt_tokens ?? 0, outputTokens: sqlMiniUsage.completion_tokens ?? 0, totalTokens: sqlMiniUsage.total_tokens ?? 0 } : undefined,
              sqlLarge: sqlLargeUsage.total_tokens ? { inputTokens: sqlLargeUsage.prompt_tokens ?? 0, outputTokens: sqlLargeUsage.completion_tokens ?? 0, totalTokens: sqlLargeUsage.total_tokens ?? 0 } : undefined,
              summary: summaryUsage.total_tokens ? { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 } : undefined,
              total: { inputTokens: (plannerUsage.prompt_tokens ?? 0) + (sqlMiniUsage.prompt_tokens ?? 0) + (sqlLargeUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0), outputTokens: (plannerUsage.completion_tokens ?? 0) + (sqlMiniUsage.completion_tokens ?? 0) + (sqlLargeUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0), totalTokens: (plannerUsage.total_tokens ?? 0) + (sqlMiniUsage.total_tokens ?? 0) + (sqlLargeUsage.total_tokens ?? 0) + (summaryUsage.total_tokens ?? 0) }
            }
          };
          await setCachedValue(cacheKey, { ...responseData, columnsMeta: queryResult.columnsMeta });
          await setSemanticEntry(resolvedChatId, resolvedResponseLanguage, resolvedSchemaLanguage, { embedding: vector, sql, question: normalizedQuestion, createdAt: new Date().toISOString() }, resolvedEnvironmentId);

          if (shouldLogPrompts()) {
            const totalIn = (plannerUsage.prompt_tokens ?? 0) + (sqlMiniUsage.prompt_tokens ?? 0) + (sqlLargeUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0);
            const totalOut = (plannerUsage.completion_tokens ?? 0) + (sqlMiniUsage.completion_tokens ?? 0) + (sqlLargeUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0);
            console.info(`[tokens] === TOTAL REQUEST (decomposed) === | input=${totalIn} output=${totalOut} total=${totalIn + totalOut}`);
          }

          return { ok: true, data: responseData };
        }
      } catch (error) {
        if (shouldLogPrompts()) console.info(`[planner] Combined query failed: ${(error as { message?: string })?.message}, falling back to single query`);
      }
    }

    // If decomposition failed at any point, fall back to single query flow
    if (shouldLogPrompts()) console.info("[planner] Falling back to single query generation");
    emit?.("step", { step: "generating_sql", label: "Gerando SQL (fallback)..." });
  }

  // ── Standard single-query path (also used as fallback from decomposition) ──
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const isRetry = attempt > 0 && lastClassifiedError && lastReflection && lastSql;

    const prompt = buildPrompt(schemaQuestion, context, historySnippet, fewShotExamples, lastError, lastSql, resolvedSchemaLanguage, currentPeriodText, tableProfiles, rawPeriod.range ?? null, semanticGuards, seedMetrics);
    const promptWithPeriod = periodHint
      ? `${prompt}\n\n${resolvedSchemaLanguage === "en" ? `Fixed period from chat history: ${periodHint}` : resolvedSchemaLanguage === "es" ? `Periodo fijo del historial del chat: ${periodHint}` : `Periodo fixo do historico do chat: ${periodHint}`}`
      : prompt;

    let result;

    if (isRetry) {
      // Use differentiated correction prompt with self-reflection context
      emit?.("step", { step: "correcting_sql", label: `Corrigindo SQL (tentativa ${attempt + 1})...` });
      result = await generateCorrectedSql(
        promptWithPeriod,
        instructionText,
        resolvedSchemaLanguage,
        dbType,
        lastClassifiedError!,
        lastReflection!
      );
      accumulateLargeUsage(result.usage);
    } else {
      // First attempt: use mini model with escalation
      const useMini = !forceLargeModel;
      result = await generateSql(
        promptWithPeriod,
        instructionText,
        resolvedSchemaLanguage,
        dbType,
        useMini,
        useMini
      );
      if (useMini) accumulateMiniUsage(result.usage); else accumulateLargeUsage(result.usage);

      if (useMini && result.escalated) {
        forceLargeModel = true;
        result = await generateSql(
          promptWithPeriod,
          instructionText,
          resolvedSchemaLanguage,
          dbType,
          false,
          false
        );
        accumulateLargeUsage(result.usage);
      }
    }

    lastSql = result.sql;
    let validation = validateSql(result.sql, dbType);

    // On first attempt with mini model, escalate to large model on validation failure
    if (!validation.ok && attempt === 0 && !isRetry && !forceLargeModel) {
      forceLargeModel = true;
      const retry = await generateSql(
        promptWithPeriod,
        instructionText,
        resolvedSchemaLanguage,
        dbType,
        false,
        false
      );
      accumulateLargeUsage(retry.usage);
      lastSql = retry.sql;
      validation = validateSql(retry.sql, dbType);
    }

    if (!validation.ok) {
      // Classify the validation error and run self-reflection
      const validationErrorMsg = validation.error.errorMessage ?? "Erro de validacao SQL.";
      lastError = validationErrorMsg;
      lastClassifiedError = classifyError(validationErrorMsg, true);
      forceLargeModel = true;

      if (attempt < maxAttempts - 1) {
        try {
          emit?.("step", { step: "reflecting", label: "Analisando erro..." });
          const reflectionResult = await reflectOnError(lastSql ?? "", lastClassifiedError, schemaQuestion, resolvedSchemaLanguage);
          lastReflection = reflectionResult.reflection;
          accumulateMiniUsage(reflectionResult.usage);
        } catch {
          lastReflection = lastError;
        }
      }
      continue;
    }

    // Guardas semanticas (E3): o SQL e valido e o banco o executaria sem
    // reclamar. O que se barra aqui e o erro que nao vira erro — media de
    // percentual, soma de acumulado, filtro na data errada.
    const guardError = guardSql(lastSql);

    if (guardError) {
      lastError = guardError.originalMessage;
      lastClassifiedError = guardError;
      // A guarda ja explica o erro e como sair dele. Chamar `reflectOnError`
      // aqui gastaria uma ida ao modelo para reescrever, pior, um diagnostico
      // que ja e deterministico.
      lastReflection = guardError.hint;
      forceLargeModel = true;
      emit?.("step", { step: "reflecting", label: "Corrigindo uso das colunas..." });

      if (attempt < maxAttempts - 1) continue;

      // Sem tentativa sobrando. Executar assim devolveria um numero bem
      // formatado que a guarda ja sabe estar errado — e um resultado errado
      // que ninguem questiona custa mais que uma resposta faltando.
      return {
        ok: false,
        error: {
          errorMessage: `A consulta gerada usaria as colunas de um jeito que produz numero errado: ${guardError.originalMessage}`,
          hint: guardError.hint
        }
      };
    }

    const sql = lastSql;
    emit?.("sql", { sql });
    try {
      emit?.("step", { step: "executing_query", label: "Executando query..." });
      const start = Date.now();
      const queryResult = await adapter.query(sql);
      const elapsedMs = Date.now() - start;
      const rowCount = queryResult.recordset?.length ?? 0;
      const columns = queryResult.columns;
      const columnFormats = formatsFor(queryResult, queryResult.recordset ?? []);
      emit?.("rows", { rows: queryResult.recordset ?? [], columns, columnFormats, elapsedMs });

      emit?.("step", { step: "summarizing", label: "Gerando resumo..." });
      const chartEnabled2 = agentsCfg.chart.enabled !== false;
      const summaryEnabled2 = agentsCfg.summary.enabled !== false;
      const parallelTasks2: [Promise<unknown>, Promise<unknown>] = [
        chartEnabled2
          ? inferChartWithLLM(displayQuestion, queryResult.recordset ?? [], columns, resolvedResponseLanguage)
          : Promise.resolve(undefined),
        summaryEnabled2
          ? summarizeResult(schemaQuestion, sql, columns, queryResult.recordset ?? [], resolvedSchemaLanguage, rawPeriod.range ?? null)
          : Promise.resolve({ summary: undefined, usage: undefined })
      ];
      const [chartResult, summaryResultSettled] = await Promise.allSettled(parallelTasks2);

      let chart = chartEnabled2
        ? (chartResult.status === "fulfilled"
            ? (chartResult.value as AskSuccessResponse["chart"])
            : inferChart(queryResult.recordset ?? [], columns, displayQuestion))
        : undefined;

      let summary: string | undefined;
      if (summaryEnabled2 && summaryResultSettled.status === "fulfilled") {
        const settled = summaryResultSettled.value as { summary?: string; usage?: typeof summaryUsage };
        summary = settled.summary;
        if (settled.usage) {
          addTo(summaryUsage, settled.usage);
        }
      } else if (summaryEnabled2 && summaryResultSettled.status === "rejected") {
        console.warn("[summary-failed] usando fallback:", summaryResultSettled.reason);
      }

      summary = ensureSummary(summary, rowCount, resolvedResponseLanguage);

      if (summary && resolvedSchemaLanguage !== resolvedResponseLanguage && agentsCfg.translation.enabled !== false) {
        try {
          summary = await translateText(summary, resolvedResponseLanguage, "summary");
        } catch { /* keep original */ }
      }

      const historyCollection = await getHistoryCollection();
      const historyResult = await historyCollection.insertOne({
        environmentId: resolvedEnvironmentId,
        question: normalizedQuestion,
        embeddingQuestion,
        sql,
        rows: truncateRows(queryResult.recordset ?? []),
        columns,
        columnFormats,
        chart,
        summary,
        createdAt: new Date(), favorite: false, tags: [], chatId: resolvedChatId,
        language: resolvedSchemaLanguage, responseLanguage: resolvedResponseLanguage,
        success: true, elapsedMs, rowCount, embedding: vector,
        tokenUsage: {
          planner: plannerUsage.total_tokens ? { inputTokens: plannerUsage.prompt_tokens ?? 0, outputTokens: plannerUsage.completion_tokens ?? 0, totalTokens: plannerUsage.total_tokens ?? 0 } : undefined,
          sqlMini: sqlMiniUsage.total_tokens > 0 ? { inputTokens: sqlMiniUsage.prompt_tokens, outputTokens: sqlMiniUsage.completion_tokens, totalTokens: sqlMiniUsage.total_tokens } : undefined,
          sqlLarge: sqlLargeUsage.total_tokens > 0 ? { inputTokens: sqlLargeUsage.prompt_tokens, outputTokens: sqlLargeUsage.completion_tokens, totalTokens: sqlLargeUsage.total_tokens } : undefined,
          summary: summaryUsage.total_tokens > 0 ? { inputTokens: summaryUsage.prompt_tokens, outputTokens: summaryUsage.completion_tokens, totalTokens: summaryUsage.total_tokens } : undefined,
          total: { inputTokens: (plannerUsage.prompt_tokens ?? 0) + sqlMiniUsage.prompt_tokens + sqlLargeUsage.prompt_tokens + summaryUsage.prompt_tokens, outputTokens: (plannerUsage.completion_tokens ?? 0) + sqlMiniUsage.completion_tokens + sqlLargeUsage.completion_tokens + summaryUsage.completion_tokens, totalTokens: (plannerUsage.total_tokens ?? 0) + sqlMiniUsage.total_tokens + sqlLargeUsage.total_tokens + summaryUsage.total_tokens }
        }
      });

      const responseData: AskSuccessResponse = {
        sql, rows: queryResult.recordset ?? [], columns, columnFormats, elapsedMs,
        chatId: resolvedChatId, historyId: historyResult.insertedId.toString(),
        summary, cacheHit: false, chart, responseLanguage: resolvedResponseLanguage,
        translatedQuestion: schemaQuestion,
        tokenUsage: {
          planner: plannerUsage.total_tokens ? { inputTokens: plannerUsage.prompt_tokens ?? 0, outputTokens: plannerUsage.completion_tokens ?? 0, totalTokens: plannerUsage.total_tokens ?? 0 } : undefined,
          sqlMini: sqlMiniUsage.total_tokens > 0 ? { inputTokens: sqlMiniUsage.prompt_tokens, outputTokens: sqlMiniUsage.completion_tokens, totalTokens: sqlMiniUsage.total_tokens } : undefined,
          sqlLarge: sqlLargeUsage.total_tokens > 0 ? { inputTokens: sqlLargeUsage.prompt_tokens, outputTokens: sqlLargeUsage.completion_tokens, totalTokens: sqlLargeUsage.total_tokens } : undefined,
          summary: summaryUsage.total_tokens > 0 ? { inputTokens: summaryUsage.prompt_tokens, outputTokens: summaryUsage.completion_tokens, totalTokens: summaryUsage.total_tokens } : undefined,
          total: { inputTokens: (plannerUsage.prompt_tokens ?? 0) + sqlMiniUsage.prompt_tokens + sqlLargeUsage.prompt_tokens + summaryUsage.prompt_tokens, outputTokens: (plannerUsage.completion_tokens ?? 0) + sqlMiniUsage.completion_tokens + sqlLargeUsage.completion_tokens + summaryUsage.completion_tokens, totalTokens: (plannerUsage.total_tokens ?? 0) + sqlMiniUsage.total_tokens + sqlLargeUsage.total_tokens + summaryUsage.total_tokens }
        }
      };
      await setCachedValue(cacheKey, { ...responseData, columnsMeta: queryResult.columnsMeta });
      await setSemanticEntry(resolvedChatId, resolvedResponseLanguage, resolvedSchemaLanguage, { embedding: vector, sql, question: normalizedQuestion, createdAt: new Date().toISOString() }, resolvedEnvironmentId);

      // Log total tokens
      if (shouldLogPrompts()) {
        const totalIn = (plannerUsage.prompt_tokens ?? 0) + (sqlMiniUsage.prompt_tokens ?? 0) + (sqlLargeUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0);
        const totalOut = (plannerUsage.completion_tokens ?? 0) + (sqlMiniUsage.completion_tokens ?? 0) + (sqlLargeUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0);
        console.info(`[tokens] === TOTAL REQUEST === | input=${totalIn} output=${totalOut} total=${totalIn + totalOut}`);
      }

      return { ok: true, data: responseData };
    } catch (error) {
      // Classify the execution error and run self-reflection for next retry
      const rawError = sanitizeErrorMessage((error as { message?: string })?.message ?? "Erro SQL.");
      lastError = rawError;
      lastClassifiedError = classifyError(rawError, false);
      forceLargeModel = true;

      // A dead database will not be revived by a different SELECT. Stop now
      // instead of paying the connect timeout twice more.
      if (!isRetriableError(lastClassifiedError.category)) {
        console.error(`[ask] erro nao-retentavel (${lastClassifiedError.category}):`, rawError);
        break;
      }

      if (attempt < maxAttempts - 1) {
        try {
          emit?.("step", { step: "reflecting", label: "Analisando erro..." });
          const reflectionResult = await reflectOnError(sql, lastClassifiedError, schemaQuestion, resolvedSchemaLanguage);
          lastReflection = reflectionResult.reflection;
          accumulateMiniUsage(reflectionResult.usage);
        } catch {
          lastReflection = rawError;
        }
      }
    }
  }

  // Fallback response. A connection failure is not the user's fault and
  // rephrasing will not help, so it gets its own honest message.
  const isConnectionFailure = lastClassifiedError?.category === "connection_error";
  const fallbackSummary = isConnectionFailure
    ? resolvedResponseLanguage === "en"
        ? "I could not reach the database, so there is no data to answer with. This is a connection problem, not a problem with your question."
      : resolvedResponseLanguage === "es"
        ? "No pude conectarme a la base de datos, asi que no hay datos para responder. Es un problema de conexion, no de tu pregunta."
        : "Nao consegui conectar ao banco de dados, entao nao ha dados para responder. E um problema de conexao, nao da sua pergunta."
    : resolvedResponseLanguage === "en" ? "I could not produce a reliable answer this time. Please try rephrasing your question."
      : resolvedResponseLanguage === "es" ? "No pude producir una respuesta confiable esta vez. Intenta reformular tu pregunta."
      : "Nao consegui produzir uma resposta confiavel desta vez. Tente reformular a pergunta.";

  const historyCollection = await getHistoryCollection();
  const historyResult = await historyCollection.insertOne({
    environmentId: resolvedEnvironmentId,
    question: normalizedQuestion, embeddingQuestion, sql: lastSql ?? "",
    createdAt: new Date(), favorite: false, tags: [], chatId: resolvedChatId,
    language: resolvedSchemaLanguage, responseLanguage: resolvedResponseLanguage,
    success: false, errorMessage: lastError ?? "Erro ao gerar SQL.", elapsedMs: 0, rowCount: 0, embedding: vector,
    tokenUsage: {
      planner: plannerUsage.total_tokens ? { inputTokens: plannerUsage.prompt_tokens ?? 0, outputTokens: plannerUsage.completion_tokens ?? 0, totalTokens: plannerUsage.total_tokens ?? 0 } : undefined,
      sqlMini: sqlMiniUsage.total_tokens ? { inputTokens: sqlMiniUsage.prompt_tokens ?? 0, outputTokens: sqlMiniUsage.completion_tokens ?? 0, totalTokens: sqlMiniUsage.total_tokens ?? 0 } : undefined,
      sqlLarge: sqlLargeUsage.total_tokens ? { inputTokens: sqlLargeUsage.prompt_tokens ?? 0, outputTokens: sqlLargeUsage.completion_tokens ?? 0, totalTokens: sqlLargeUsage.total_tokens ?? 0 } : undefined,
      summary: summaryUsage.total_tokens ? { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 } : undefined,
      total: { inputTokens: (plannerUsage.prompt_tokens ?? 0) + (sqlMiniUsage.prompt_tokens ?? 0) + (sqlLargeUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0), outputTokens: (plannerUsage.completion_tokens ?? 0) + (sqlMiniUsage.completion_tokens ?? 0) + (sqlLargeUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0), totalTokens: (plannerUsage.total_tokens ?? 0) + (sqlMiniUsage.total_tokens ?? 0) + (sqlLargeUsage.total_tokens ?? 0) + (summaryUsage.total_tokens ?? 0) }
    }
  });

  return {
    ok: true,
    data: {
      sql: lastSql ?? "", rows: [], columns: [], elapsedMs: 0,
      chatId: resolvedChatId, historyId: historyResult.insertedId.toString(),
      summary: fallbackSummary, chart: undefined, responseLanguage: resolvedResponseLanguage,
      translatedQuestion: schemaQuestion,
      tokenUsage: {
        planner: plannerUsage.total_tokens ? { inputTokens: plannerUsage.prompt_tokens ?? 0, outputTokens: plannerUsage.completion_tokens ?? 0, totalTokens: plannerUsage.total_tokens ?? 0 } : undefined,
        sqlMini: sqlMiniUsage.total_tokens ? { inputTokens: sqlMiniUsage.prompt_tokens ?? 0, outputTokens: sqlMiniUsage.completion_tokens ?? 0, totalTokens: sqlMiniUsage.total_tokens ?? 0 } : undefined,
        sqlLarge: sqlLargeUsage.total_tokens ? { inputTokens: sqlLargeUsage.prompt_tokens ?? 0, outputTokens: sqlLargeUsage.completion_tokens ?? 0, totalTokens: sqlLargeUsage.total_tokens ?? 0 } : undefined,
        summary: summaryUsage.total_tokens ? { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 } : undefined,
        total: { inputTokens: (plannerUsage.prompt_tokens ?? 0) + (sqlMiniUsage.prompt_tokens ?? 0) + (sqlLargeUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0), outputTokens: (plannerUsage.completion_tokens ?? 0) + (sqlMiniUsage.completion_tokens ?? 0) + (sqlLargeUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0), totalTokens: (plannerUsage.total_tokens ?? 0) + (sqlMiniUsage.total_tokens ?? 0) + (sqlLargeUsage.total_tokens ?? 0) + (summaryUsage.total_tokens ?? 0) }
      }
    }
  };
};
