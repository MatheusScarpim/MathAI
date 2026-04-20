import type { AskErrorResponse, AskSuccessResponse, ApiAuthConfig } from "@auraia/shared";
import { sanitizeErrorMessage } from "@auraia/shared";
import {
  getHistoryCollection,
  getInstructionsCollection,
  getSettingsCollection
} from "../core/mongo.js";
import { validateHttpRequest } from "./httpValidation.js";
import { executeHttpPlan } from "./httpExecutor.js";
import { ensureEndpointCollection } from "../core/qdrant.js";
import {
  findSemanticSql,
  getCachedValue,
  getCacheKey,
  setCachedValue,
  setSemanticEntry
} from "../core/cache.js";
import { getAppConfig, type AppConfig } from "../core/appConfig.js";

import { searchRelevantEndpoints, expandEndpoints, searchEndpointsByText } from "../agents/endpoint.js";
import { buildHttpPrompt, generateHttpRequest } from "../agents/http.js";
import { summarizeResult } from "../agents/summary.js";
import { inferChart, inferChartWithLLM } from "../agents/chart.js";
import { translateText } from "../agents/translation.js";
import { getAgentsConfig } from "../core/agentConfig.js";
import type { StepEmitter } from "./ask.js";

/* ── Types ───────────────────────────────────────────────── */

type AskResult =
  | { ok: true; data: AskSuccessResponse }
  | { ok: false; error: AskErrorResponse };

type FewShotExample = {
  question: string;
  httpRequest: string;
  tags: string[];
  similarity: number;
};

/* ── Helpers ─────────────────────────────────────────────── */

const SEMANTIC_SIMILARITY_THRESHOLD = 0.92;
const FEW_SHOT_SIMILARITY_THRESHOLD = 0.86;
const FEW_SHOT_MAX = 2;

const shouldLogPrompts = (): boolean => {
  const flag = process.env.LOG_PROMPTS?.toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
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

const getTableReferenceCount = async (): Promise<number> => {
  try {
    const collection = await getSettingsCollection();
    const doc = await collection.findOne({ key: "tableReferenceCount" });
    const value =
      typeof doc?.value === "number"
        ? doc.value
        : Number.parseInt(String(doc?.value ?? ""), 10);
    if (!Number.isFinite(value)) return 8;
    return Math.max(1, Math.min(30, Math.floor(value)));
  } catch {
    return 8;
  }
};

const buildAuthConfig = (appConfig: AppConfig): ApiAuthConfig => ({
  type: appConfig.apiAuthType ?? "none",
  token: appConfig.apiAuthToken,
  apiKeyHeader: appConfig.apiAuthApiKeyHeader,
  apiKeyValue: appConfig.apiAuthApiKeyValue,
  username: appConfig.apiAuthUsername,
  password: appConfig.apiAuthPassword
});

/* ── History Snippet ─────────────────────────────────────── */

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
      const questionLabel = language === "en" ? "Q" : "P";
      const answerLabel = language === "en" ? "A" : "R";
      return [
        `(${index + 1}) ${questionLabel}: ${q}`,
        s ? `${answerLabel}: ${s}` : null
      ]
        .filter(Boolean)
        .join("\n");
    })
  );

  return lines.join("\n");
};

/* ── Few-Shot (API mode) ─────────────────────────────────── */

const loadFewShotExamples = async (
  chatId: string | undefined,
  language: "pt" | "en" | "es",
  embedding: number[]
): Promise<FewShotExample[]> => {
  if (!embedding.length) return [];
  const collection = await getHistoryCollection();

  const items: Array<{
    question: string;
    httpRequest: string;
    tags: string[];
    embedding?: number[];
    language?: "pt" | "en" | "es";
  }> = [];
  const seen = new Set<string>();

  const baseFilter = {
    favorite: true,
    httpRequest: { $type: "string" as const, $ne: "" },
    embedding: { $type: "array" as const }
  };
  const languageFilter = {
    $or: [{ language }, { language: { $exists: false } }]
  };

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
        question: doc.embeddingQuestion ?? doc.question,
        httpRequest: doc.httpRequest ?? "",
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
        question: doc.embeddingQuestion ?? doc.question,
        httpRequest: doc.httpRequest ?? "",
        tags: doc.tags ?? [],
        embedding: doc.embedding,
        language: doc.language
      });
    }
  }

  return items
    .map((item) => ({
      question: item.question,
      httpRequest: item.httpRequest,
      tags: item.tags,
      similarity: cosineSimilarity(embedding, item.embedding ?? [])
    }))
    .filter((item) => item.similarity >= FEW_SHOT_SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, FEW_SHOT_MAX);
};

/* ── Main API-mode answerer ──────────────────────────────── */

export const answerQuestionApi = async (
  normalizedQuestion: string,
  embeddingQuestion: string,
  concreteQuestion: string,
  vector: number[],
  resolvedChatId: string,
  language: "pt" | "en" | "es",
  resolvedSchemaLanguage: "pt" | "en" | "es",
  resolvedResponseLanguage: "pt" | "en" | "es",
  emit?: StepEmitter
): Promise<AskResult> => {
  await ensureEndpointCollection();
  const appConfig = await getAppConfig();
  if (!appConfig || appConfig.mode !== "api") {
    return { ok: false, error: { errorMessage: "Modo API nao configurado." } };
  }

  const baseUrl = appConfig.apiBaseUrl ?? "";
  const readOnly = appConfig.apiReadOnly ?? true;
  const auth = buildAuthConfig(appConfig);
  const agentsCfg = await getAgentsConfig();

  const schemaQuestion = embeddingQuestion;
  const displayQuestion = normalizedQuestion;
  const cacheKey = getCacheKey(normalizedQuestion, resolvedChatId, language, resolvedSchemaLanguage, resolvedResponseLanguage);

  // Check direct cache (already done in ask.ts for DB mode, but the key differs by mode via prefix)
  const cached = await getCachedValue<AskSuccessResponse>(cacheKey);
  if (cached) {
    emit?.("step", { step: "cache_hit", label: "Resultado encontrado no cache!" });
    const historyCollection = await getHistoryCollection();
    const historyResult = await historyCollection.insertOne({
      question: normalizedQuestion,
      embeddingQuestion,
      sql: "",
      httpRequest: cached.httpRequest,
      mode: "api",
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
        mode: "api",
        historyId: historyResult.insertedId.toString(),
        responseLanguage: resolvedResponseLanguage,
        translatedQuestion: cached.translatedQuestion ?? embeddingQuestion
      }
    };
  }

  // Step 5: Search relevant endpoints
  emit?.("step", { step: "searching_endpoints", label: "Buscando endpoints relevantes..." });
  const endpointReferenceCount = await getTableReferenceCount();
  const initialEndpoints = await searchRelevantEndpoints(vector, embeddingQuestion, endpointReferenceCount);
  if (initialEndpoints.length === 0) {
    return {
      ok: false,
      error: {
        errorMessage: "Nenhum endpoint relevante encontrado.",
        hint: "Ingeste o swagger spec primeiro via /api/ingest/swagger."
      }
    };
  }

  // Step 6: Expand endpoint context
  const context = await expandEndpoints(initialEndpoints);
  const historySnippet = await buildHistorySnippet(resolvedChatId, resolvedSchemaLanguage);

  // Step 7: Load instructions
  const instructionsCollection = await getInstructionsCollection();
  const instructions = await instructionsCollection.find({}).sort({ createdAt: -1 }).limit(10).toArray();
  const instructionText = instructions.map((item) => `- ${item.text}`).join("\n");

  // Step 8: Load few-shot examples
  const fewShotExamples = await loadFewShotExamples(resolvedChatId, resolvedSchemaLanguage, vector);

  // Step 9: HTTP Request Generation Loop
  emit?.("step", { step: "generating_request", label: "Gerando requisicao HTTP..." });
  const maxAttempts = agentsCfg.http.maxRetries ?? 3;
  let lastError: string | null = null;
  let lastRequest: string | null = null;
  let httpUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
  let summaryUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
  let forceLargeModel = false;
  let currentContext = context;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // On retry after execution error, enrich context with endpoints related to the error
    if (lastError && attempt > 0) {
      try {
        emit?.("step", { step: "searching_endpoints", label: "Buscando endpoints para corrigir erro..." });
        const errorEndpoints = await searchEndpointsByText(lastError, 5);
        if (errorEndpoints.length > 0) {
          const existingKeys = new Set(
            [...currentContext.endpoints, ...currentContext.relatedEndpoints]
              .map(e => `${e.method}:${e.path}`)
          );
          const newEndpoints = errorEndpoints.filter(
            e => !existingKeys.has(`${e.method}:${e.path}`)
          );
          if (newEndpoints.length > 0) {
            currentContext = {
              endpoints: currentContext.endpoints,
              relatedEndpoints: [...currentContext.relatedEndpoints, ...newEndpoints].slice(0, 10)
            };
          }
        }
      } catch { /* keep current context */ }
    }

    const prompt = buildHttpPrompt(
      schemaQuestion,
      currentContext,
      historySnippet,
      fewShotExamples,
      lastError,
      lastRequest,
      resolvedSchemaLanguage,
      baseUrl
    );

    const useMini = !forceLargeModel && attempt === 0;
    let result = await generateHttpRequest(
      prompt,
      instructionText,
      resolvedSchemaLanguage,
      readOnly,
      useMini,
      useMini
    );
    if (result.usage) {
      httpUsage = {
        prompt_tokens: (httpUsage.prompt_tokens ?? 0) + (result.usage.prompt_tokens ?? 0),
        completion_tokens: (httpUsage.completion_tokens ?? 0) + (result.usage.completion_tokens ?? 0),
        total_tokens: (httpUsage.total_tokens ?? 0) + (result.usage.total_tokens ?? 0)
      };
    }

    if (useMini && result.escalated) {
      forceLargeModel = true;
      result = await generateHttpRequest(prompt, instructionText, resolvedSchemaLanguage, readOnly, false, false);
      if (result.usage) {
        httpUsage = {
          prompt_tokens: (httpUsage.prompt_tokens ?? 0) + (result.usage.prompt_tokens ?? 0),
          completion_tokens: (httpUsage.completion_tokens ?? 0) + (result.usage.completion_tokens ?? 0),
          total_tokens: (httpUsage.total_tokens ?? 0) + (result.usage.total_tokens ?? 0)
        };
      }
    }

    const planJson = JSON.stringify(result.plan);
    lastRequest = planJson;

    // Validate
    const validation = validateHttpRequest(result.plan, baseUrl, readOnly);
    if (!validation.ok) {
      lastError = validation.error.errorMessage;
      continue;
    }

    emit?.("httpRequest", { httpRequest: planJson });

    try {
      // Execute
      emit?.("step", { step: "executing_request", label: "Executando requisicao..." });
      const start = Date.now();
      const execResult = await executeHttpPlan(result.plan, baseUrl, auth);
      const elapsedMs = Date.now() - start;
      const rowCount = execResult.recordset?.length ?? 0;
      const columns = execResult.columns;
      const rows = execResult.recordset ?? [];
      emit?.("rows", { rows, columns, elapsedMs });

      // Summarize + Chart
      emit?.("step", { step: "summarizing", label: "Gerando resumo..." });
      const chartEnabled = agentsCfg.chart.enabled !== false;
      const summaryEnabled = agentsCfg.summary.enabled !== false;

      const parallelTasks: [Promise<unknown>, Promise<unknown>] = [
        chartEnabled
          ? inferChartWithLLM(displayQuestion, rows, columns, resolvedResponseLanguage)
          : Promise.resolve(undefined),
        summaryEnabled
          ? summarizeResult(schemaQuestion, planJson, columns, rows, resolvedSchemaLanguage)
          : Promise.resolve({ summary: undefined, usage: undefined })
      ];
      const [chartResult, summaryResultSettled] = await Promise.allSettled(parallelTasks);

      const chart = chartEnabled
        ? (chartResult.status === "fulfilled"
            ? (chartResult.value as AskSuccessResponse["chart"])
            : inferChart(rows, columns, displayQuestion))
        : undefined;

      let summary: string | undefined;
      if (summaryEnabled && summaryResultSettled.status === "fulfilled") {
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

      // Save history
      const historyCollection = await getHistoryCollection();
      const historyResult = await historyCollection.insertOne({
        question: normalizedQuestion,
        embeddingQuestion,
        sql: "",
        httpRequest: planJson,
        mode: "api",
        rows,
        columns,
        chart,
        summary,
        createdAt: new Date(),
        favorite: false,
        tags: [],
        chatId: resolvedChatId,
        language: resolvedSchemaLanguage,
        responseLanguage: resolvedResponseLanguage,
        success: true,
        elapsedMs,
        rowCount,
        embedding: vector
      });

      const responseData: AskSuccessResponse = {
        sql: "",
        httpRequest: planJson,
        mode: "api",
        rows,
        columns,
        elapsedMs,
        chatId: resolvedChatId,
        historyId: historyResult.insertedId.toString(),
        summary,
        cacheHit: false,
        chart,
        responseLanguage: resolvedResponseLanguage,
        translatedQuestion: schemaQuestion,
        tokenUsage: {
          sql: { inputTokens: httpUsage.prompt_tokens ?? 0, outputTokens: httpUsage.completion_tokens ?? 0, totalTokens: httpUsage.total_tokens ?? 0 },
          summary: summaryUsage.total_tokens
            ? { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 }
            : undefined,
          total: {
            inputTokens: (httpUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0),
            outputTokens: (httpUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0),
            totalTokens: (httpUsage.total_tokens ?? 0) + (summaryUsage.total_tokens ?? 0)
          }
        }
      };

      await setCachedValue(cacheKey, responseData);
      await setSemanticEntry(resolvedChatId, resolvedResponseLanguage, resolvedSchemaLanguage, {
        embedding: vector,
        sql: planJson,
        question: normalizedQuestion,
        createdAt: new Date().toISOString()
      });

      if (shouldLogPrompts()) {
        const totalIn = (httpUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0);
        const totalOut = (httpUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0);
        console.info(`[tokens] === TOTAL API REQUEST === | input=${totalIn} output=${totalOut} total=${totalIn + totalOut}`);
      }

      return { ok: true, data: responseData };
    } catch (error) {
      if (useMini) forceLargeModel = true;
      lastError = sanitizeErrorMessage((error as { message?: string })?.message ?? "Erro na requisicao HTTP.");
    }
  }

  // Fallback
  const fallbackSummary =
    resolvedResponseLanguage === "en"
      ? "I could not produce a reliable answer this time. Please try rephrasing your question."
      : resolvedResponseLanguage === "es"
        ? "No pude producir una respuesta confiable esta vez. Intenta reformular tu pregunta."
        : "Nao consegui produzir uma resposta confiavel desta vez. Tente reformular a pergunta.";

  const historyCollection = await getHistoryCollection();
  const historyResult = await historyCollection.insertOne({
    question: normalizedQuestion,
    embeddingQuestion,
    sql: "",
    httpRequest: lastRequest ?? "",
    mode: "api",
    createdAt: new Date(),
    favorite: false,
    tags: [],
    chatId: resolvedChatId,
    language: resolvedSchemaLanguage,
    responseLanguage: resolvedResponseLanguage,
    success: false,
    errorMessage: lastError ?? "Erro ao gerar requisicao HTTP.",
    elapsedMs: 0,
    rowCount: 0,
    embedding: vector
  });

  return {
    ok: true,
    data: {
      sql: "",
      httpRequest: lastRequest ?? "",
      mode: "api",
      rows: [],
      columns: [],
      elapsedMs: 0,
      chatId: resolvedChatId,
      historyId: historyResult.insertedId.toString(),
      summary: fallbackSummary,
      chart: undefined,
      responseLanguage: resolvedResponseLanguage,
      translatedQuestion: schemaQuestion,
      tokenUsage: {
        sql: { inputTokens: httpUsage.prompt_tokens ?? 0, outputTokens: httpUsage.completion_tokens ?? 0, totalTokens: httpUsage.total_tokens ?? 0 },
        summary: summaryUsage.total_tokens
          ? { inputTokens: summaryUsage.prompt_tokens ?? 0, outputTokens: summaryUsage.completion_tokens ?? 0, totalTokens: summaryUsage.total_tokens ?? 0 }
          : undefined,
        total: {
          inputTokens: (httpUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0),
          outputTokens: (httpUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0),
          totalTokens: (httpUsage.total_tokens ?? 0) + (summaryUsage.total_tokens ?? 0)
        }
      }
    }
  };
};
