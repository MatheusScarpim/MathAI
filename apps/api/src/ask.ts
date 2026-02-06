import type { AskErrorResponse, AskSuccessResponse } from "@auraia/shared";
import { sanitizeErrorMessage } from "@auraia/shared";
import { getPool } from "./db.js";
import { getHistoryCollection, getInstructionsCollection, type HistoryRecord } from "./mongo.js";
import { validateSql } from "./validation.js";
import { ensureSchemaCollection } from "./qdrant.js";
import type { Filter } from "mongodb";
import {
  findSemanticSql,
  getCachedValue,
  getCacheKey,
  setCachedValue,
  setSemanticEntry
} from "./cache.js";

// Import agents
import { translateText, buildStandaloneQuestion } from "./agents/translation.js";
import { expandTables, searchRelevantTables, generateEmbedding, buildEmbeddingInput } from "./agents/schema.js";
import { buildPrompt, generateSql } from "./agents/sql.js";
import { summarizeResult, extractYearFromSql } from "./agents/summary.js";
import { inferChart, inferChartWithLLM } from "./agents/chart.js";

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

export const answerQuestion = async (
  question: string,
  chatId?: string,
  language: "pt" | "en" | "es" = "pt",
  schemaLanguage: "pt" | "en" | "es" = language,
  responseLanguage: "pt" | "en" | "es" = language
): Promise<AskResult> => {
  await ensureSchemaCollection();
  await ensureAliasInstruction();

  const normalizedQuestion = question.trim();
  const resolvedSchemaLanguage = schemaLanguage ?? language;
  const resolvedResponseLanguage = responseLanguage ?? language;

  // Step 1: Translate question if needed (TranslationAgent)
  let translatedQuestion = normalizedQuestion;
  if (resolvedSchemaLanguage !== language) {
    try {
      translatedQuestion = await translateText(normalizedQuestion, resolvedSchemaLanguage, "question");
    } catch {
      translatedQuestion = normalizedQuestion;
    }
  }

  const normalizedChatId = chatId?.trim() ? chatId.trim() : undefined;
  const resolvedChatId = normalizedChatId ?? `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Step 2: Build standalone question from history (TranslationAgent)
  let concreteQuestion = translatedQuestion.trim() || normalizedQuestion;
  if (normalizedChatId) {
    const historyForRewrite = await loadHistoryForRewrite(normalizedChatId, resolvedSchemaLanguage);
    if (historyForRewrite.length) {
      try {
        const rewritten = await buildStandaloneQuestion(translatedQuestion, historyForRewrite, resolvedSchemaLanguage);
        if (rewritten.trim()) {
          const currentYear = extractYearFromText(translatedQuestion) ?? extractYearFromText(normalizedQuestion);
          concreteQuestion = enforceQuestionYear(rewritten, currentYear);
        }
      } catch {
        concreteQuestion = translatedQuestion.trim() || normalizedQuestion;
      }
    }
  }

  const embeddingQuestion = concreteQuestion.trim() || normalizedQuestion;

  // Step 3: Check direct cache
  const cacheKey = getCacheKey(normalizedQuestion, resolvedChatId, language, resolvedSchemaLanguage, resolvedResponseLanguage);
  const cached = await getCachedValue<AskSuccessResponse>(cacheKey);

  // Step 4: Generate embedding (SchemaAgent)
  const embeddingInput = await buildEmbeddingInput(embeddingQuestion, resolvedChatId, resolvedSchemaLanguage);
  const vector = await generateEmbedding(embeddingInput);

  const schemaQuestion = embeddingQuestion;
  const displayQuestion = normalizedQuestion;

  if (cached) {
    const historyCollection = await getHistoryCollection();
    const historyResult = await historyCollection.insertOne({
      question: normalizedQuestion,
      embeddingQuestion,
      sql: cached.sql,
      rows: cached.rows ?? [],
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

  const pool = await getPool();

  // Step 5: Check semantic cache (with number mismatch detection)
  const semanticMatch = await findSemanticSql(resolvedChatId, resolvedResponseLanguage, resolvedSchemaLanguage, vector, SEMANTIC_SIMILARITY_THRESHOLD);

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

  if (hasNumberMismatch && shouldLogPrompts()) {
    console.info(`[semantic-cache] Skipping cache due to number mismatch: question=[${questionNumbers.join(',')}], cachedSql=[${cachedSqlNumbers.join(',')}]`);
  }

  if (semanticMatch?.sql && !hasNumberMismatch) {
    const validation = validateSql(semanticMatch.sql);
    if (validation.ok) {
      try {
        const start = Date.now();
        const result = await pool.request().query(semanticMatch.sql);
        const elapsedMs = Date.now() - start;
        const rowCount = result.recordset?.length ?? 0;
        const columns = result.recordset?.columns
          ? Object.keys(result.recordset.columns)
          : result.recordset?.[0] ? Object.keys(result.recordset[0]) : [];

        // ChartAgent
        let chart = inferChart(result.recordset ?? [], columns, displayQuestion);
        try {
          chart = await inferChartWithLLM(displayQuestion, result.recordset ?? [], columns, resolvedResponseLanguage);
        } catch {
          chart = inferChart(result.recordset ?? [], columns, displayQuestion);
        }

        // SummaryAgent
        let summary: string | undefined;
        let summaryUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
        try {
          const summaryResult = await summarizeResult(schemaQuestion, semanticMatch.sql, columns, result.recordset ?? [], resolvedSchemaLanguage);
          summary = summaryResult.summary;
          if (summaryResult.usage) summaryUsage = summaryResult.usage;
        } catch {
          summary = undefined;
        }

        if (summary && resolvedSchemaLanguage !== resolvedResponseLanguage) {
          try {
            summary = await translateText(summary, resolvedResponseLanguage, "summary");
          } catch { /* keep original */ }
        }

        const historyCollection = await getHistoryCollection();
        const historyResult = await historyCollection.insertOne({
          question: normalizedQuestion,
          embeddingQuestion,
          sql: semanticMatch.sql,
          rows: result.recordset ?? [],
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
        await setSemanticEntry(resolvedChatId, resolvedResponseLanguage, resolvedSchemaLanguage, { embedding: vector, sql: semanticMatch.sql, question: normalizedQuestion, createdAt: new Date().toISOString() });
        return { ok: true, data: responseData };
      } catch { /* Fall back to LLM generation */ }
    }
  }

  // Step 6: Search relevant tables (SchemaAgent)
  const initialTables = await searchRelevantTables(vector, embeddingQuestion);
  if (initialTables.length === 0) {
    return {
      ok: false,
      error: { errorMessage: "Nenhuma tabela relevante encontrada no schema indexado.", hint: "Rode /api/ingest/schema para indexar o banco." }
    };
  }

  // Step 7: Expand tables context (SchemaAgent)
  const context = await expandTables(initialTables);
  const rawPeriod = findPeriodInText(schemaQuestion) ?? {};
  const currentPeriodText = formatPeriodText(rawPeriod, resolvedSchemaLanguage);
  const historySnippet = currentPeriodText ? null : await buildHistorySnippet(resolvedChatId, resolvedSchemaLanguage);
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

  // Step 10: SQL Generation Loop (SQLAgent)
  const maxAttempts = 3;
  let lastError: string | null = null;
  let lastSql: string | null = null;
  let sqlUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
  let summaryUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
  let forceLargeModel = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const prompt = buildPrompt(schemaQuestion, context, historySnippet, fewShotExamples, lastError, lastSql, resolvedSchemaLanguage, currentPeriodText);
    const promptWithPeriod = periodHint
      ? `${prompt}\n\n${resolvedSchemaLanguage === "en" ? `Fixed period from chat history: ${periodHint}` : resolvedSchemaLanguage === "es" ? `Periodo fijo del historial del chat: ${periodHint}` : `Periodo fixo do historico do chat: ${periodHint}`}`
      : prompt;

    const useMini = !forceLargeModel && attempt === 0;
    let result = await generateSql(promptWithPeriod, instructionText, resolvedSchemaLanguage, useMini, useMini);
    if (result.usage) {
      sqlUsage = {
        prompt_tokens: (sqlUsage.prompt_tokens ?? 0) + (result.usage.prompt_tokens ?? 0),
        completion_tokens: (sqlUsage.completion_tokens ?? 0) + (result.usage.completion_tokens ?? 0),
        total_tokens: (sqlUsage.total_tokens ?? 0) + (result.usage.total_tokens ?? 0)
      };
    }

    if (useMini && result.escalated) {
      forceLargeModel = true;
      result = await generateSql(promptWithPeriod, instructionText, resolvedSchemaLanguage, false, false);
      if (result.usage) {
        sqlUsage = {
          prompt_tokens: (sqlUsage.prompt_tokens ?? 0) + (result.usage.prompt_tokens ?? 0),
          completion_tokens: (sqlUsage.completion_tokens ?? 0) + (result.usage.completion_tokens ?? 0),
          total_tokens: (sqlUsage.total_tokens ?? 0) + (result.usage.total_tokens ?? 0)
        };
      }
    }

    lastSql = result.sql;
    let validation = validateSql(result.sql);

    if (!validation.ok && useMini && !result.escalated) {
      forceLargeModel = true;
      const retry = await generateSql(promptWithPeriod, instructionText, resolvedSchemaLanguage, false, false);
      if (retry.usage) {
        sqlUsage = {
          prompt_tokens: (sqlUsage.prompt_tokens ?? 0) + (retry.usage.prompt_tokens ?? 0),
          completion_tokens: (sqlUsage.completion_tokens ?? 0) + (retry.usage.completion_tokens ?? 0),
          total_tokens: (sqlUsage.total_tokens ?? 0) + (retry.usage.total_tokens ?? 0)
        };
      }
      lastSql = retry.sql;
      validation = validateSql(retry.sql);
    }

    if (!validation.ok) {
      lastError = validation.error.errorMessage;
      continue;
    }

    const sql = result.sql;
    try {
      const start = Date.now();
      const queryResult = await pool.request().query(sql);
      const elapsedMs = Date.now() - start;
      const rowCount = queryResult.recordset?.length ?? 0;
      const columns = queryResult.recordset?.columns
        ? Object.keys(queryResult.recordset.columns)
        : queryResult.recordset?.[0] ? Object.keys(queryResult.recordset[0]) : [];

      // ChartAgent
      let chart = inferChart(queryResult.recordset ?? [], columns, displayQuestion);
      try {
        chart = await inferChartWithLLM(displayQuestion, queryResult.recordset ?? [], columns, resolvedResponseLanguage);
      } catch {
        chart = inferChart(queryResult.recordset ?? [], columns, displayQuestion);
      }

      // SummaryAgent
      let summary: string | undefined;
      try {
        const summaryResult = await summarizeResult(schemaQuestion, sql, columns, queryResult.recordset ?? [], resolvedSchemaLanguage);
        summary = summaryResult.summary;
        if (summaryResult.usage) {
          summaryUsage = {
            prompt_tokens: (summaryUsage.prompt_tokens ?? 0) + (summaryResult.usage.prompt_tokens ?? 0),
            completion_tokens: (summaryUsage.completion_tokens ?? 0) + (summaryResult.usage.completion_tokens ?? 0),
            total_tokens: (summaryUsage.total_tokens ?? 0) + (summaryResult.usage.total_tokens ?? 0)
          };
        }
      } catch { summary = undefined; }

      if (summary && resolvedSchemaLanguage !== resolvedResponseLanguage) {
        try {
          summary = await translateText(summary, resolvedResponseLanguage, "summary");
        } catch { /* keep original */ }
      }

      const historyCollection = await getHistoryCollection();
      const historyResult = await historyCollection.insertOne({
        question: normalizedQuestion,
        embeddingQuestion,
        sql,
        rows: queryResult.recordset ?? [],
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
      await setSemanticEntry(resolvedChatId, resolvedResponseLanguage, resolvedSchemaLanguage, { embedding: vector, sql, question: normalizedQuestion, createdAt: new Date().toISOString() });

      // Log total tokens
      if (shouldLogPrompts()) {
        const totalIn = (sqlUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0);
        const totalOut = (sqlUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0);
        console.info(`[tokens] === TOTAL REQUEST === | input=${totalIn} output=${totalOut} total=${totalIn + totalOut}`);
      }

      return { ok: true, data: responseData };
    } catch (error) {
      if (useMini) forceLargeModel = true;
      lastError = sanitizeErrorMessage((error as { message?: string })?.message ?? "Erro SQL.");
    }
  }

  // Fallback response
  const fallbackSummary =
    resolvedResponseLanguage === "en" ? "I could not produce a reliable answer this time. Please try rephrasing your question."
      : resolvedResponseLanguage === "es" ? "No pude producir una respuesta confiable esta vez. Intenta reformular tu pregunta."
      : "Nao consegui produzir uma resposta confiavel desta vez. Tente reformular a pergunta.";

  const historyCollection = await getHistoryCollection();
  const historyResult = await historyCollection.insertOne({
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
