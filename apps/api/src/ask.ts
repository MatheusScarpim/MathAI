import type { AskErrorResponse, AskSuccessResponse } from "@auraia/shared";
import { sanitizeErrorMessage } from "@auraia/shared";
import { getAdapter } from "./db.js";
import {
  getHistoryCollection,
  getInstructionsCollection,
  getSettingsCollection,
  type HistoryRecord
} from "./mongo.js";
import { validateSql } from "./validation.js";
import { ensureSchemaCollection } from "./qdrant.js";
import { ObjectId, type Filter } from "mongodb";
import {
  findSemanticSql,
  getCachedValue,
  getCacheKey,
  setCachedValue,
  setSemanticEntry
} from "./cache.js";
import { getAppConfig } from "./appConfig.js";
import { answerQuestionApi } from "./askApi.js";
import { config } from "./config.js";

// Import agents
import { translateText, buildStandaloneQuestion } from "./agents/translation.js";
import { expandTables, searchRelevantTables, generateEmbedding, buildEmbeddingInput, estimateQueryComplexity } from "./agents/schema.js";
import { buildPrompt, generateSql, generateCorrectedSql, classifyError, reflectOnError } from "./agents/sql.js";
import { decomposeQuestion, combineSubQueries, type DecompositionPlan } from "./agents/planner.js";
import { summarizeResult, extractYearFromSql } from "./agents/summary.js";
import { inferChart, inferChartWithLLM } from "./agents/chart.js";
import { getAgentsConfig } from "./agentConfig.js";

type AskResult =
  | { ok: true; data: AskSuccessResponse }
  | { ok: false; error: AskErrorResponse };

type FewShotExample = {
  question: string;
  sql: string;
  tags: string[];
  similarity: number;
};

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

const getTableReferenceCount = async (): Promise<number> => {
  try {
    const collection = await getSettingsCollection();
    const doc = await collection.findOne({ key: "tableReferenceCount" });
    const value = typeof doc?.value === "number" ? doc.value : Number.parseInt(String(doc?.value ?? ""), 10);
    if (!Number.isFinite(value)) return 8;
    return Math.max(1, Math.min(30, Math.floor(value)));
  } catch {
    return 8;
  }
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

const extractYearFromText = (text: string): number | null => {
  const match = text.match(/\b(20\d{2})\b/);
  if (!match?.[1]) return null;
  return Number.parseInt(match[1], 10);
};

const enforceQuestionYear = (question: string, year: number | null): string => {
  if (!year) return question;
  const yearText = String(year);
  if (!/\b20\d{2}\b/.test(question)) return question;
  return question.replace(/\b20\d{2}\b/g, yearText);
};

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

const truncateRows = <T>(rows: T[]): T[] =>
  rows.slice(0, config.historyMaxRows);

const cosineSimilarity = (a: number[], b: number[]): number => {
  const length = Math.min(a.length, b.length);
  if (!length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

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

// ============== PERIOD HELPERS ==============

const monthMap: Array<{ key: string; value: number }> = [
  { key: "janeiro", value: 1 }, { key: "jan", value: 1 },
  { key: "february", value: 2 }, { key: "feb", value: 2 }, { key: "fevereiro", value: 2 }, { key: "fev", value: 2 },
  { key: "march", value: 3 }, { key: "mar", value: 3 }, { key: "marco", value: 3 }, { key: "março", value: 3 },
  { key: "abril", value: 4 }, { key: "apr", value: 4 }, { key: "april", value: 4 },
  { key: "mayo", value: 5 }, { key: "may", value: 5 }, { key: "maio", value: 5 },
  { key: "junho", value: 6 }, { key: "jun", value: 6 }, { key: "june", value: 6 },
  { key: "julho", value: 7 }, { key: "jul", value: 7 }, { key: "july", value: 7 },
  { key: "agosto", value: 8 }, { key: "aug", value: 8 }, { key: "august", value: 8 },
  { key: "septiembre", value: 9 }, { key: "sept", value: 9 }, { key: "september", value: 9 }, { key: "setembro", value: 9 },
  { key: "outubro", value: 10 }, { key: "oct", value: 10 }, { key: "october", value: 10 },
  { key: "novembro", value: 11 }, { key: "nov", value: 11 }, { key: "november", value: 11 },
  { key: "dezembro", value: 12 }, { key: "dec", value: 12 }, { key: "december", value: 12 }, { key: "diciembre", value: 12 }
];

const findPeriodInText = (text: string): { month?: number; year?: number } | null => {
  const lowered = text.toLowerCase();
  const yearMatch = lowered.match(/\b(20\d{2})\b/);
  const year = yearMatch?.[1] ? Number.parseInt(yearMatch[1], 10) : undefined;
  for (const item of monthMap) {
    const pattern = new RegExp(`\\b${item.key}\\b`, "i");
    if (pattern.test(lowered)) {
      return { month: item.value, year };
    }
  }
  return year ? { year } : null;
};

const formatMonth = (month: number, language: "pt" | "en" | "es"): string => {
  const names =
    language === "en"
      ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
      : language === "es"
        ? ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
        : ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  return names[month - 1] ?? `${month}`;
};

const buildPeriodHint = async (
  chatId: string | undefined,
  question: string,
  language: "pt" | "en" | "es"
): Promise<string | null> => {
  if (!chatId) return null;
  const current = findPeriodInText(question);
  if (current?.month || current?.year) return null;

  const collection = await getHistoryCollection();
  const items = await collection
    .find({ chatId })
    .sort({ createdAt: -1 })
    .limit(6)
    .toArray();

  for (const item of items) {
    const period = findPeriodInText(item.question);
    if (period?.month || period?.year) {
      const monthLabel = period.month ? formatMonth(period.month, language) : null;
      if (monthLabel && period.year) return `${monthLabel} ${period.year}`;
      if (monthLabel) return monthLabel;
      if (period.year) return String(period.year);
    }
  }

  return null;
};

const formatPeriodText = (
  period: { month?: number; year?: number },
  language: "pt" | "en" | "es"
): string | null => {
  if (!period.month && !period.year) return null;
  const monthLabel = period.month ? formatMonth(period.month, language) : null;
  if (monthLabel && period.year) return `${monthLabel} ${period.year}`;
  if (monthLabel) return monthLabel;
  if (period.year) return String(period.year);
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
          const currentYear = extractYearFromText(translatedQuestion) ?? extractYearFromText(normalizedQuestion);
          concreteQuestion = enforceQuestionYear(result.question, currentYear);
        }
      } catch {
        concreteQuestion = translatedQuestion.trim() || normalizedQuestion;
      }
    }
  }

  const embeddingQuestion = concreteQuestion.trim() || normalizedQuestion;

  // Step 3: Check direct cache
  const cacheKey = getCacheKey(normalizedQuestion, resolvedChatId, language, resolvedSchemaLanguage, resolvedResponseLanguage, resolvedEnvironmentId);
  const cached = await getCachedValue<AskSuccessResponse>(cacheKey);

  // Step 4: Generate embedding (SchemaAgent) — skip history if new topic detected
  emit?.("step", { step: "embedding", label: "Gerando embedding..." });
  const embeddingChatId = isNewTopic ? undefined : resolvedChatId;
  const embeddingInput = await buildEmbeddingInput(embeddingQuestion, embeddingChatId, resolvedSchemaLanguage);
  const vector = await generateEmbedding(embeddingInput);

  const schemaQuestion = embeddingQuestion;
  const displayQuestion = normalizedQuestion;

  // ── Mode branching: delegate to API orchestrator if mode === "api" ──
  const { getEnvironment } = await import("./appConfig.js");
  const currentConfig = resolvedEnvironmentId ? await getEnvironment(resolvedEnvironmentId) : await getAppConfig();
  if (currentConfig?.mode === "api") {
    return answerQuestionApi(
      normalizedQuestion,
      embeddingQuestion,
      concreteQuestion,
      vector,
      resolvedChatId,
      language,
      resolvedSchemaLanguage,
      resolvedResponseLanguage,
      emit
    );
  }

  if (cached) {
    emit?.("step", { step: "cache_hit", label: "Resultado encontrado no cache!" });
    const historyCollection = await getHistoryCollection();
    const historyResult = await historyCollection.insertOne({
      environmentId: resolvedEnvironmentId,
      question: normalizedQuestion,
      embeddingQuestion,
      sql: cached.sql,
      rows: truncateRows(cached.rows ?? []),
      columns: cached.columns ?? [],
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
      rowCount: cached.rows?.length ?? 0,
      embedding: vector
    });
    return {
      ok: true,
      data: {
        ...cached,
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

  if (semanticMatch?.sql && !shouldSkipCache) {
    const validation = validateSql(semanticMatch.sql, dbType);
    if (validation.ok) {
      try {
        const start = Date.now();
        const result = await adapter.query(semanticMatch.sql);
        const elapsedMs = Date.now() - start;
        const rowCount = result.recordset?.length ?? 0;
        const columns = result.columns;

        // Run chart + summary in parallel to reduce end-to-end latency.
        const chartEnabled = agentsCfg.chart.enabled !== false;
        const summaryEnabled = agentsCfg.summary.enabled !== false;
        const parallelTasks: [Promise<unknown>, Promise<unknown>] = [
          chartEnabled
            ? inferChartWithLLM(displayQuestion, result.recordset ?? [], columns, resolvedResponseLanguage)
            : Promise.resolve(undefined),
          summaryEnabled
            ? summarizeResult(schemaQuestion, semanticMatch.sql, columns, result.recordset ?? [], resolvedSchemaLanguage)
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
        }

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
          chart,
          summary,
          createdAt: new Date(), favorite: false, tags: [], chatId: resolvedChatId,
          language: resolvedSchemaLanguage, responseLanguage: resolvedResponseLanguage,
          success: true, elapsedMs, rowCount, embedding: vector
        });

        const responseData: AskSuccessResponse = {
          sql: semanticMatch.sql, rows: result.recordset ?? [], columns, elapsedMs,
          chatId: resolvedChatId, historyId: historyResult.insertedId.toString(),
          summary, cacheHit: true, chart, responseLanguage: resolvedResponseLanguage,
          translatedQuestion: schemaQuestion,
          tokenUsage: {
            sql: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            summary: summaryUsage.total_tokens ? { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 } : undefined,
            total: { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 }
          }
        };
        await setCachedValue(cacheKey, responseData);
        await setSemanticEntry(resolvedChatId, resolvedResponseLanguage, resolvedSchemaLanguage, { embedding: vector, sql: semanticMatch.sql, question: normalizedQuestion, createdAt: new Date().toISOString() }, resolvedEnvironmentId);
        return { ok: true, data: responseData };
      } catch { /* Fall back to LLM generation */ }
    }
  }

  // Step 6: Search relevant tables (SchemaAgent)
  emit?.("step", { step: "searching_tables", label: "Buscando tabelas relevantes..." });
  const tableReferenceCount = await getTableReferenceCount();
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
  const rawPeriod = findPeriodInText(schemaQuestion) ?? {};
  const currentPeriodText = formatPeriodText(rawPeriod, resolvedSchemaLanguage);
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
  emit?.("step", { step: "planning", label: "Analisando complexidade da pergunta..." });
  let decompositionPlan: DecompositionPlan | null = null;
  let plannerUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
  try {
    decompositionPlan = await decomposeQuestion(schemaQuestion, context, resolvedSchemaLanguage, dbType);
    if (decompositionPlan.usage) plannerUsage = decompositionPlan.usage;
  } catch {
    decompositionPlan = null;
  }

  // Step 11: SQL Generation Loop (SQLAgent) with Self-Correction Feedback Loop
  emit?.("step", { step: "generating_sql", label: "Gerando SQL..." });
  const maxAttempts = agentsCfg.sql.maxRetries ?? 3;
  let lastError: string | null = null;
  let lastSql: string | null = null;
  let lastClassifiedError: ReturnType<typeof classifyError> | null = null;
  let lastReflection: string | null = null;
  let sqlUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
  let summaryUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
  let forceLargeModel = false;

  const accumulateUsage = (usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => {
    if (!usage) return;
    sqlUsage = {
      prompt_tokens: (sqlUsage.prompt_tokens ?? 0) + (usage.prompt_tokens ?? 0),
      completion_tokens: (sqlUsage.completion_tokens ?? 0) + (usage.completion_tokens ?? 0),
      total_tokens: (sqlUsage.total_tokens ?? 0) + (usage.total_tokens ?? 0)
    };
  };

  // Include planner tokens in SQL usage tracking
  accumulateUsage(plannerUsage);

  // ── Decomposed query path: generate SQL for each sub-question, then combine ──
  if (decompositionPlan?.needsDecomposition && decompositionPlan.subQuestions.length >= 2) {
    emit?.("step", { step: "decomposing", label: `Decompondo em ${decompositionPlan.subQuestions.length} sub-consultas...` });

    const subSqls: Array<{ id: string; sql: string; question: string }> = [];
    let decompositionFailed = false;

    for (const subQ of decompositionPlan.subQuestions) {
      const subPrompt = buildPrompt(subQ.question, context, null, fewShotExamples, null, null, resolvedSchemaLanguage, currentPeriodText);
      const subPromptWithPeriod = periodHint
        ? `${subPrompt}\n\n${resolvedSchemaLanguage === "en" ? `Fixed period from chat history: ${periodHint}` : resolvedSchemaLanguage === "es" ? `Periodo fijo del historial del chat: ${periodHint}` : `Periodo fixo do historico do chat: ${periodHint}`}`
        : subPrompt;

      emit?.("step", { step: "generating_sub_sql", label: `Gerando SQL: ${subQ.focus}...` });
      const subResult = await generateSql(subPromptWithPeriod, instructionText, resolvedSchemaLanguage, dbType, false, false);
      accumulateUsage(subResult.usage);

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
        accumulateUsage(combined.usage);

        const combinedValidation = validateSql(combined.sql, dbType);
        if (combinedValidation.ok) {
          const sql = combined.sql;
          emit?.("sql", { sql });

          emit?.("step", { step: "executing_query", label: "Executando query combinada..." });
          const start = Date.now();
          const queryResult = await adapter.query(sql);
          const elapsedMs = Date.now() - start;
          const rowCount = queryResult.recordset?.length ?? 0;
          const columns = queryResult.columns;
          emit?.("rows", { rows: queryResult.recordset ?? [], columns, elapsedMs });

          emit?.("step", { step: "summarizing", label: "Gerando resumo..." });
          const chartEnabled2 = agentsCfg.chart.enabled !== false;
          const summaryEnabled2 = agentsCfg.summary.enabled !== false;
          const parallelTasks2: [Promise<unknown>, Promise<unknown>] = [
            chartEnabled2
              ? inferChartWithLLM(displayQuestion, queryResult.recordset ?? [], columns, resolvedResponseLanguage)
              : Promise.resolve(undefined),
            summaryEnabled2
              ? summarizeResult(schemaQuestion, sql, columns, queryResult.recordset ?? [], resolvedSchemaLanguage)
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
              summaryUsage = {
                prompt_tokens: (summaryUsage.prompt_tokens ?? 0) + (settled.usage.prompt_tokens ?? 0),
                completion_tokens: (summaryUsage.completion_tokens ?? 0) + (settled.usage.completion_tokens ?? 0),
                total_tokens: (summaryUsage.total_tokens ?? 0) + (settled.usage.total_tokens ?? 0)
              };
            }
          }

          if (summary && resolvedSchemaLanguage !== resolvedResponseLanguage && agentsCfg.translation.enabled !== false) {
            try {
              summary = await translateText(summary, resolvedResponseLanguage, "summary");
            } catch { /* keep original */ }
          }

          const historyCollection = await getHistoryCollection();
          const historyResult = await historyCollection.insertOne({
            environmentId: resolvedEnvironmentId,
            question: normalizedQuestion, embeddingQuestion, sql,
            rows: truncateRows(queryResult.recordset ?? []), columns, chart, summary,
            createdAt: new Date(), favorite: false, tags: [], chatId: resolvedChatId,
            language: resolvedSchemaLanguage, responseLanguage: resolvedResponseLanguage,
            success: true, elapsedMs, rowCount, embedding: vector
          });

          const responseData: AskSuccessResponse = {
            sql, rows: queryResult.recordset ?? [], columns, elapsedMs,
            chatId: resolvedChatId, historyId: historyResult.insertedId.toString(),
            summary, cacheHit: false, chart, responseLanguage: resolvedResponseLanguage,
            translatedQuestion: schemaQuestion,
            tokenUsage: {
              sql: { inputTokens: sqlUsage.prompt_tokens ?? 0, outputTokens: sqlUsage.completion_tokens ?? 0, totalTokens: sqlUsage.total_tokens ?? 0 },
              summary: summaryUsage.total_tokens ? { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 } : undefined,
              total: { inputTokens: (sqlUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0), outputTokens: (sqlUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0), totalTokens: (sqlUsage.total_tokens ?? 0) + (summaryUsage.total_tokens ?? 0) }
            }
          };
          await setCachedValue(cacheKey, responseData);
          await setSemanticEntry(resolvedChatId, resolvedResponseLanguage, resolvedSchemaLanguage, { embedding: vector, sql, question: normalizedQuestion, createdAt: new Date().toISOString() }, resolvedEnvironmentId);

          if (shouldLogPrompts()) {
            const totalIn = (sqlUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0);
            const totalOut = (sqlUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0);
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

    const prompt = buildPrompt(schemaQuestion, context, historySnippet, fewShotExamples, lastError, lastSql, resolvedSchemaLanguage, currentPeriodText);
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
      accumulateUsage(result.usage);
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
      accumulateUsage(result.usage);

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
        accumulateUsage(result.usage);
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
      accumulateUsage(retry.usage);
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
          accumulateUsage(reflectionResult.usage);
        } catch {
          lastReflection = lastError;
        }
      }
      continue;
    }

    const sql = result.sql;
    emit?.("sql", { sql });
    try {
      emit?.("step", { step: "executing_query", label: "Executando query..." });
      const start = Date.now();
      const queryResult = await adapter.query(sql);
      const elapsedMs = Date.now() - start;
      const rowCount = queryResult.recordset?.length ?? 0;
      const columns = queryResult.columns;
      emit?.("rows", { rows: queryResult.recordset ?? [], columns, elapsedMs });

      emit?.("step", { step: "summarizing", label: "Gerando resumo..." });
      const chartEnabled2 = agentsCfg.chart.enabled !== false;
      const summaryEnabled2 = agentsCfg.summary.enabled !== false;
      const parallelTasks2: [Promise<unknown>, Promise<unknown>] = [
        chartEnabled2
          ? inferChartWithLLM(displayQuestion, queryResult.recordset ?? [], columns, resolvedResponseLanguage)
          : Promise.resolve(undefined),
        summaryEnabled2
          ? summarizeResult(schemaQuestion, sql, columns, queryResult.recordset ?? [], resolvedSchemaLanguage)
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
          summaryUsage = {
            prompt_tokens: (summaryUsage.prompt_tokens ?? 0) + (settled.usage.prompt_tokens ?? 0),
            completion_tokens: (summaryUsage.completion_tokens ?? 0) + (settled.usage.completion_tokens ?? 0),
            total_tokens: (summaryUsage.total_tokens ?? 0) + (settled.usage.total_tokens ?? 0)
          };
        }
      }

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
        chart,
        summary,
        createdAt: new Date(), favorite: false, tags: [], chatId: resolvedChatId,
        language: resolvedSchemaLanguage, responseLanguage: resolvedResponseLanguage,
        success: true, elapsedMs, rowCount, embedding: vector
      });

      const responseData: AskSuccessResponse = {
        sql, rows: queryResult.recordset ?? [], columns, elapsedMs,
        chatId: resolvedChatId, historyId: historyResult.insertedId.toString(),
        summary, cacheHit: false, chart, responseLanguage: resolvedResponseLanguage,
        translatedQuestion: schemaQuestion,
        tokenUsage: {
          sql: { inputTokens: sqlUsage.prompt_tokens ?? 0, outputTokens: sqlUsage.completion_tokens ?? 0, totalTokens: sqlUsage.total_tokens ?? 0 },
          summary: summaryUsage.total_tokens ? { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 } : undefined,
          total: { inputTokens: (sqlUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0), outputTokens: (sqlUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0), totalTokens: (sqlUsage.total_tokens ?? 0) + (summaryUsage.total_tokens ?? 0) }
        }
      };
      await setCachedValue(cacheKey, responseData);
      await setSemanticEntry(resolvedChatId, resolvedResponseLanguage, resolvedSchemaLanguage, { embedding: vector, sql, question: normalizedQuestion, createdAt: new Date().toISOString() }, resolvedEnvironmentId);

      // Log total tokens
      if (shouldLogPrompts()) {
        const totalIn = (sqlUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0);
        const totalOut = (sqlUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0);
        console.info(`[tokens] === TOTAL REQUEST === | input=${totalIn} output=${totalOut} total=${totalIn + totalOut}`);
      }

      return { ok: true, data: responseData };
    } catch (error) {
      // Classify the execution error and run self-reflection for next retry
      const rawError = sanitizeErrorMessage((error as { message?: string })?.message ?? "Erro SQL.");
      lastError = rawError;
      lastClassifiedError = classifyError(rawError, false);
      forceLargeModel = true;

      if (attempt < maxAttempts - 1) {
        try {
          emit?.("step", { step: "reflecting", label: "Analisando erro..." });
          const reflectionResult = await reflectOnError(sql, lastClassifiedError, schemaQuestion, resolvedSchemaLanguage);
          lastReflection = reflectionResult.reflection;
          accumulateUsage(reflectionResult.usage);
        } catch {
          lastReflection = rawError;
        }
      }
    }
  }

  // Fallback response
  const fallbackSummary =
    resolvedResponseLanguage === "en" ? "I could not produce a reliable answer this time. Please try rephrasing your question."
      : resolvedResponseLanguage === "es" ? "No pude producir una respuesta confiable esta vez. Intenta reformular tu pregunta."
      : "Nao consegui produzir uma resposta confiavel desta vez. Tente reformular a pergunta.";

  const historyCollection = await getHistoryCollection();
  const historyResult = await historyCollection.insertOne({
    environmentId: resolvedEnvironmentId,
    question: normalizedQuestion, embeddingQuestion, sql: lastSql ?? "",
    createdAt: new Date(), favorite: false, tags: [], chatId: resolvedChatId,
    language: resolvedSchemaLanguage, responseLanguage: resolvedResponseLanguage,
    success: false, errorMessage: lastError ?? "Erro ao gerar SQL.", elapsedMs: 0, rowCount: 0, embedding: vector
  });

  return {
    ok: true,
    data: {
      sql: lastSql ?? "", rows: [], columns: [], elapsedMs: 0,
      chatId: resolvedChatId, historyId: historyResult.insertedId.toString(),
      summary: fallbackSummary, chart: undefined, responseLanguage: resolvedResponseLanguage,
      translatedQuestion: schemaQuestion,
      tokenUsage: {
        sql: { inputTokens: sqlUsage.prompt_tokens ?? 0, outputTokens: sqlUsage.completion_tokens ?? 0, totalTokens: sqlUsage.total_tokens ?? 0 },
        summary: summaryUsage.total_tokens ? { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 } : undefined,
        total: { inputTokens: (sqlUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0), outputTokens: (sqlUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0), totalTokens: (sqlUsage.total_tokens ?? 0) + (summaryUsage.total_tokens ?? 0) }
      }
    }
  };
};
