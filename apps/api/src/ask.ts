import type { AskErrorResponse, AskSuccessResponse, TableChunk } from "@auraia/shared";
import { sanitizeErrorMessage } from "@auraia/shared";
import { openai, EMBEDDING_MODEL, SQL_MODEL, SQL_MODEL_MINI, SUMMARY_MODEL } from "./openai.js";
import { qdrant, ensureSchemaCollection } from "./qdrant.js";
import { loadSchemaGraph } from "./schema.js";
import { validateSql } from "./validation.js";
import { getDbClient } from "./db.js";
import { config, type SqlDialect } from "./config.js";
import { getHistoryCollection, getInstructionsCollection, type HistoryRecord } from "./mongo.js";
import type { Filter } from "mongodb";
import {
  findSemanticSql,
  getCachedValue,
  getCacheKey,
  setCachedValue,
  setSemanticEntry
} from "./cache.js";

type AskResult =
  | { ok: true; data: AskSuccessResponse }
  | { ok: false; error: AskErrorResponse };

type ExpandedContext = {
  tables: TableChunk[];
  joins: string[];
};

const SEMANTIC_SIMILARITY_THRESHOLD = 0.92;
const FEW_SHOT_SIMILARITY_THRESHOLD = 0.86;
const FEW_SHOT_MAX = 2;

type FewShotExample = {
  question: string;
  sql: string;
  tags: string[];
  similarity: number;
};

const shouldLogPrompts = (): boolean => {
  const flag = process.env.LOG_PROMPTS?.toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
};

const logPrompt = (
  label: string,
  payload: { system?: string; user?: string; meta?: Record<string, unknown> }
): void => {
  if (!shouldLogPrompts()) return;
  const header = `[prompt-log] ${label}`;
  console.info(header);
  if (payload.meta) {
    console.info(`${header} meta=${JSON.stringify(payload.meta)}`);
  }
  if (payload.system) {
    console.info(`${header} system:\n${payload.system}`);
  }
  if (payload.user) {
    console.info(`${header} user:\n${payload.user}`);
  }
};

const preferTableOrder = (table: TableChunk, connectedToFat: boolean): number => {
  const isDim = table.tags?.includes("Dim");
  if (connectedToFat && isDim) return 0;
  return 1;
};

const buildJoinKey = (from: string, fromCol: string, to: string, toCol: string): string =>
  `${from}.${fromCol}->${to}.${toCol}`;

const expandTables = async (initial: TableChunk[]): Promise<ExpandedContext> => {
  const maxHops = 2;
  const maxTablesFinal = 10;
  const allTables = await loadSchemaGraph();
  const byName = new Map(allTables.map((table) => [table.tableFullName, table]));

  const adjacency = new Map<string, TableChunk[]>();
  for (const table of allTables) {
    const neighbors: TableChunk[] = [];
    for (const fk of table.foreignKeys ?? []) {
      const to = byName.get(fk.toTable);
      if (to) neighbors.push(to);
      const from = byName.get(fk.fromTable);
      if (from && from.tableFullName !== table.tableFullName) {
        neighbors.push(from);
      }
    }
    adjacency.set(table.tableFullName, neighbors);
  }

  const finalSet = new Set<string>(initial.map((t) => t.tableFullName));
  const queue: Array<{ name: string; hop: number }> = initial.map((t) => ({
    name: t.tableFullName,
    hop: 0
  }));

  while (queue.length > 0 && finalSet.size < maxTablesFinal) {
    const current = queue.shift();
    if (!current) break;
    if (current.hop >= maxHops) continue;
    const neighbors = adjacency.get(current.name) ?? [];

    const currentTable = byName.get(current.name);
    const connectedToFat = currentTable?.tags?.includes("Fat") ?? false;

    neighbors
      .slice()
      .sort((a, b) => preferTableOrder(a, connectedToFat) - preferTableOrder(b, connectedToFat))
      .forEach((neighbor) => {
        if (finalSet.size >= maxTablesFinal) return;
        if (!finalSet.has(neighbor.tableFullName)) {
          finalSet.add(neighbor.tableFullName);
          queue.push({ name: neighbor.tableFullName, hop: current.hop + 1 });
        }
      });
  }

  const finalTables = Array.from(finalSet)
    .map((name) => byName.get(name))
    .filter((table): table is TableChunk => Boolean(table));

  const joinSet = new Set<string>();
  for (const table of finalTables) {
    for (const fk of table.foreignKeys ?? []) {
      if (finalSet.has(fk.fromTable) && finalSet.has(fk.toTable)) {
        joinSet.add(buildJoinKey(fk.fromTable, fk.fromColumn, fk.toTable, fk.toColumn));
      }
    }
  }

  const joins = Array.from(joinSet).map((key) => {
    const [left, right] = key.split("->");
    return `${left} = ${right}`;
  });

  return { tables: finalTables, joins };
};

const buildPrompt = (
  question: string,
  context: ExpandedContext,
  historySnippet: string | null,
  fewShotExamples: FewShotExample[],
  errorContext: string | null,
  previousSql: string | null,
  language: "pt" | "en" | "es"
): string => {
  const includeForeignKeys = context.joins.length === 0;
  const tableDetails = context.tables
    .map((table) => {
      const cols = table.columns.map((c) => `${c.name}:${c.type}`).join(", ");
      const parts = [`Table ${table.tableFullName}`, `Cols ${cols}`];
      if (table.primaryKey.length) parts.push(`PK ${table.primaryKey.join(", ")}`);
      if (includeForeignKeys && table.foreignKeys.length) {
        parts.push(
          `FK ${table.foreignKeys
            .map((fk) => `${fk.fromTable}.${fk.fromColumn}->${fk.toTable}.${fk.toColumn}`)
            .join("; ")}`
        );
      }
      if (table.tags.length) parts.push(`Tags ${table.tags.join(", ")}`);
      return parts.join(" | ");
    })
    .join("\n\n");

  const joins = context.joins.length ? context.joins.join("\n") : null;
  const fewShotSection = buildFewShotSection(fewShotExamples, language);
  const schemaLabel =
    language === "en" ? "Schema:" : language === "es" ? "Esquema:" : "Schema:";
  const joinsLabel =
    language === "en" ? "Joins:" : language === "es" ? "Joins:" : "Joins:";
  const historyLabel =
    language === "en" ? "History:" : language === "es" ? "Historial:" : "Historico:";
  const errorLabel =
    language === "en" ? "Error:" : language === "es" ? "Error:" : "Erro:";
  const previousSqlLabel =
    language === "en" ? "Prev SQL:" : language === "es" ? "SQL previo:" : "SQL anterior:";
  const questionLabel =
    language === "en" ? "Question:" : language === "es" ? "Pregunta:" : "Pergunta:";
  const priorityRule =
    language === "en"
      ? "Rule: prioritize the current question. Use history only to fill missing context and never override the current question."
      : language === "es"
        ? "Regla: prioriza la pregunta actual. Usa el historial solo para completar contexto faltante y nunca sobrescribas la pregunta actual."
        : "Regra: priorize a pergunta atual. Use o historico apenas para completar contexto faltante e nunca sobrescreva a pergunta atual.";

  const lines: Array<string | null> = [];
  lines.push(priorityRule);
  if (historySnippet) {
    lines.push(historyLabel, historySnippet);
  }
  if (fewShotSection) {
    lines.push(fewShotSection);
  }
  lines.push(schemaLabel, tableDetails);
  if (joins) {
    lines.push(joinsLabel, joins);
  }
  if (errorContext) {
    lines.push(errorLabel, errorContext);
  }
  if (previousSql) {
    lines.push(previousSqlLabel, previousSql);
  }
  lines.push(questionLabel, question);

  return lines.filter((line) => line !== null).join("\n");
};

const stripSql = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.includes("```")) return trimmed;
  return trimmed.replace(/```sql/gi, "```").replace(/```/g, "").trim();
};

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

const buildEmbeddingInput = async (
  question: string,
  chatId: string | undefined,
  language: "pt" | "en" | "es"
): Promise<string> => {
  const trimmed = question.trim();
  if (!chatId) return trimmed;
  const collection = await getHistoryCollection();
  const items = await collection
    .find({ chatId })
    .sort({ createdAt: 1 })
    .toArray();
  if (!items.length) return trimmed;

  const prevLabel =
    language === "en"
      ? "Previous question"
      : language === "es"
        ? "Pregunta anterior"
        : "Pergunta anterior";
  const currentLabel =
    language === "en" ? "Current question" : language === "es" ? "Pregunta atual" : "Pergunta atual";

  const historyLines = items
    .map((item, index) => `${prevLabel} ${index + 1}: ${item.question}`)
    .join("\n");

  return `${historyLines}\n${currentLabel}: ${trimmed}`;
};

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

const buildFewShotSection = (
  examples: FewShotExample[],
  language: "pt" | "en" | "es"
): string | null => {
  if (!examples.length) return null;
  const label =
    language === "en" ? "Examples:" : language === "es" ? "Ejemplos:" : "Exemplos:";
  const exampleLabel = language === "en" ? "Ex" : language === "es" ? "Ej" : "Ex";
  const tagLabel = language === "en" ? "Tags" : language === "es" ? "Tags" : "Tags";

  const lines = examples.map((item, index) => {
    const question = truncate(item.question, 300);
    const sql = truncate(item.sql, 900);
    const tags = item.tags.length ? `${tagLabel}: ${item.tags.join(", ")}` : null;
    return [
      `${exampleLabel} ${index + 1}`,
      `Q: ${question}`,
      tags,
      `SQL: ${sql}`
    ]
      .filter((line) => line !== null)
      .join("\n");
  });

  return [label, ...lines].join("\n\n");
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
        question: doc.question,
        sql: doc.sql,
        tags: doc.tags ?? [],
        embedding: doc.embedding
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
        question: doc.question,
        sql: doc.sql,
        tags: doc.tags ?? [],
        embedding: doc.embedding
      });
    }
  }

  const scored = items
    .map((item) => ({
      question: item.question,
      sql: item.sql,
      tags: item.tags,
      similarity: cosineSimilarity(embedding, item.embedding ?? [])
    }))
    .filter((item) => item.similarity >= FEW_SHOT_SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, FEW_SHOT_MAX);
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

  return items
    .reverse()
    .map((item, index) => {
      const q = truncate(item.question, 300);
      const s = item.summary ? truncate(item.summary, 300) : null;
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
    .join("\n");
};

const monthMap: Array<{ key: string; value: number }> = [
  { key: "janeiro", value: 1 },
  { key: "jan", value: 1 },
  { key: "february", value: 2 },
  { key: "feb", value: 2 },
  { key: "fevereiro", value: 2 },
  { key: "fev", value: 2 },
  { key: "march", value: 3 },
  { key: "mar", value: 3 },
  { key: "marco", value: 3 },
  { key: "março", value: 3 },
  { key: "abril", value: 4 },
  { key: "apr", value: 4 },
  { key: "april", value: 4 },
  { key: "mayo", value: 5 },
  { key: "may", value: 5 },
  { key: "maio", value: 5 },
  { key: "junho", value: 6 },
  { key: "jun", value: 6 },
  { key: "june", value: 6 },
  { key: "julho", value: 7 },
  { key: "jul", value: 7 },
  { key: "july", value: 7 },
  { key: "agosto", value: 8 },
  { key: "aug", value: 8 },
  { key: "august", value: 8 },
  { key: "septiembre", value: 9 },
  { key: "sept", value: 9 },
  { key: "september", value: 9 },
  { key: "setembro", value: 9 },
  { key: "outubro", value: 10 },
  { key: "oct", value: 10 },
  { key: "october", value: 10 },
  { key: "novembro", value: 11 },
  { key: "nov", value: 11 },
  { key: "november", value: 11 },
  { key: "dezembro", value: 12 },
  { key: "dec", value: 12 },
  { key: "december", value: 12 },
  { key: "diciembre", value: 12 }
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
      ? [
          "January",
          "February",
          "March",
          "April",
          "May",
          "June",
          "July",
          "August",
          "September",
          "October",
          "November",
          "December"
        ]
      : language === "es"
        ? [
            "enero",
            "febrero",
            "marzo",
            "abril",
            "mayo",
            "junio",
            "julio",
            "agosto",
            "septiembre",
            "octubre",
            "noviembre",
            "diciembre"
          ]
        : [
            "janeiro",
            "fevereiro",
            "marco",
            "abril",
            "maio",
            "junho",
            "julho",
            "agosto",
            "setembro",
            "outubro",
            "novembro",
            "dezembro"
          ];
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

const buildSystemContent = (
  instructionText: string,
  language: "pt" | "en" | "es",
  dialect: SqlDialect
): string => {
  const base =
    dialect === "mysql"
      ? language === "en"
        ? "You are a MySQL expert. Output only MySQL SELECT, no markdown or comments. " +
          "Rules: LIMIT 100; no SELECT *; forbid DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_."
        : language === "es"
          ? "Eres un experto en MySQL. Devuelve solo SELECT de MySQL, sin markdown ni comentarios. " +
            "Reglas: LIMIT 100; no SELECT *; prohibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_."
          : "Voce e um especialista em MySQL. Retorne apenas SELECT MySQL, sem markdown ou comentarios. " +
            "Regras: LIMIT 100; nao use SELECT *; proibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_."
      : language === "en"
        ? "You are a SQL Server expert. Output only T-SQL SELECT, no markdown or comments. " +
          "Rules: TOP (100); no SELECT *; forbid DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_."
        : language === "es"
          ? "Eres un experto en SQL Server. Devuelve solo T-SQL SELECT, sin markdown ni comentarios. " +
            "Reglas: TOP (100); no SELECT *; prohibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_."
          : "Voce e um especialista em SQL Server. Retorne apenas T-SQL SELECT, sem markdown ou comentarios. " +
            "Regras: TOP (100); nao use SELECT *; proibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_.";

  const instructionsLabel =
    language === "en" ? "Additional instructions:" : language === "es" ? "Instrucciones adicionales:" : "Instrucoes adicionais:";

  if (!instructionText.trim()) return base;
  return `${base}\n${instructionsLabel}\n${instructionText}`;
};

const generateSql = async (
  prompt: string,
  instructionText: string,
  language: "pt" | "en" | "es",
  model: string,
  allowEscalation: boolean,
  dialect: SqlDialect
): Promise<{
  sql: string;
  escalated?: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}> => {
  const baseSystem = buildSystemContent(instructionText, language, dialect);
  const system = allowEscalation
    ? `${baseSystem}\nIf unsure you can produce a correct query, reply with only: ESCALATE`
    : baseSystem;
  logPrompt("sql", {
    system,
    user: prompt,
    meta: { model, language }
  });
  const completion = await openai.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: system
      },
      {
        role: "user",
        content: prompt
      }
    ]
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  if (allowEscalation && raw.trim().toUpperCase() === "ESCALATE") {
    return { sql: "", escalated: true, usage: completion.usage };
  }
  const sql = stripSql(raw);
  return { sql, usage: completion.usage };
};

const buildSummaryPrompt = (
  question: string,
  sql: string,
  columns: string[],
  rows: Record<string, unknown>[],
  language: "pt" | "en" | "es"
): string => {
  const labelQuestion =
    language === "en" ? "Question" : language === "es" ? "Pregunta" : "Pergunta";
  const labelSql = language === "en" ? "SQL" : "SQL";
  const labelColumns =
    language === "en" ? "Columns" : language === "es" ? "Columnas" : "Colunas";
  const labelRows =
    language === "en" ? "Sample rows" : language === "es" ? "Filas de ejemplo" : "Linhas de exemplo";

  return [
    `${labelQuestion}: ${question}`,
    `${labelSql}: ${sql}`,
    `${labelColumns}: ${columns.join(", ")}`,
    `${labelRows}: ${JSON.stringify(rows)}`
  ].join("\n");
};

const summarizeResult = async (
  question: string,
  sql: string,
  columns: string[],
  rows: Record<string, unknown>[],
  language: "pt" | "en" | "es"
): Promise<{ summary?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }> => {
  const sample = rows.slice(0, 20);
  const system =
    language === "en"
      ? "You are a data assistant. Respond in markdown with 1 short paragraph (max 2 sentences), non-technical, no bullets or headings. Do not mention SQL or query details."
    : language === "es"
        ? "Eres un asistente de datos. Responde en markdown con 1 parrafo corto (max 2 frases), sin tecnicismos, sin bullets ni titulos. No menciones SQL ni detalles de consulta."
        : "Voce e um assistente de dados. Responda em markdown com 1 paragrafo curto (max 2 frases), sem tecnicismos, sem bullets ou titulos. Nao mencione SQL nem detalhes da consulta.";

  const summaryPrompt = buildSummaryPrompt(question, sql, columns, sample, language);
  logPrompt("summary", {
    system,
    user: summaryPrompt,
    meta: { model: SUMMARY_MODEL, language }
  });
  const completion = await openai.chat.completions.create({
    model: SUMMARY_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: summaryPrompt
      }
    ]
  });

  const summary = completion.choices[0]?.message?.content?.trim();
  return {
    summary: summary ? summary.replace(/\s+/g, " ") : undefined,
    usage: completion.usage
  };
};

const inferChart = (
  rows: Record<string, unknown>[],
  columns: string[],
  title?: string
): AskSuccessResponse["chart"] => {
  if (!rows.length || !columns.length) return undefined;

  const sample = rows.slice(0, 50);
  const typeByColumn = new Map<string, "number" | "date" | "string">();

  for (const column of columns) {
    let hasNumber = 0;
    let hasDate = 0;
    let hasString = 0;

    for (const row of sample) {
      const value = row[column];
      if (value === null || value === undefined) continue;
      if (typeof value === "number" && Number.isFinite(value)) {
        hasNumber += 1;
        continue;
      }
      if (value instanceof Date) {
        hasDate += 1;
        continue;
      }
      if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed) && /[-/:]/.test(value)) {
          hasDate += 1;
        } else {
          hasString += 1;
        }
        continue;
      }
      hasString += 1;
    }

    if (hasNumber >= hasDate && hasNumber >= hasString) {
      typeByColumn.set(column, "number");
    } else if (hasDate >= hasString) {
      typeByColumn.set(column, "date");
    } else {
      typeByColumn.set(column, "string");
    }
  }

  const numericColumns = columns.filter((col) => typeByColumn.get(col) === "number");
  if (!numericColumns.length) return undefined;

  const valueColumn = numericColumns[0] ?? "";
  const categoryColumn =
    columns.find((col) => typeByColumn.get(col) === "date" && col !== valueColumn) ??
    columns.find((col) => typeByColumn.get(col) === "string" && col !== valueColumn) ??
    columns.find((col) => col !== valueColumn) ??
    valueColumn;

  const data = rows.map((row, index) => {
    const categoryValue = categoryColumn ? row[categoryColumn] : index + 1;
    const category =
      categoryValue instanceof Date
        ? categoryValue.toISOString()
        : typeof categoryValue === "string" || typeof categoryValue === "number"
          ? categoryValue
          : String(categoryValue ?? "");
    const valueRaw = valueColumn ? row[valueColumn] : null;
    const value =
      typeof valueRaw === "number" && Number.isFinite(valueRaw) ? valueRaw : null;
    return { category, value };
  });

  const chartType = typeByColumn.get(categoryColumn) === "date" ? "line" : "bar";

  return {
    type: chartType,
    data,
    title,
    xKey: categoryColumn,
    yKey: valueColumn
  };
};

const buildChartPrompt = (
  question: string,
  columns: string[],
  rows: Record<string, unknown>[],
  language: "pt" | "en" | "es"
): string => {
  const labelQuestion =
    language === "en" ? "Question" : language === "es" ? "Pregunta" : "Pergunta";
  const labelColumns =
    language === "en" ? "Columns" : language === "es" ? "Columnas" : "Colunas";
  const labelRows =
    language === "en" ? "Sample rows" : language === "es" ? "Filas de ejemplo" : "Linhas de exemplo";

  return [
    `${labelQuestion}: ${question}`,
    `${labelColumns}: ${columns.join(", ")}`,
    `${labelRows}: ${JSON.stringify(rows)}`
  ].join("\n");
};

const inferChartWithLLM = async (
  question: string,
  rows: Record<string, unknown>[],
  columns: string[],
  language: "pt" | "en" | "es"
): Promise<AskSuccessResponse["chart"]> => {
  if (!rows.length || !columns.length) return undefined;
  const sample = rows.slice(0, 30);
  const system =
    language === "en"
      ? "You are a data assistant. Build a chart suggestion. Return ONLY a JSON object with fields: type (bar|line), data (array of {category, value}), title, xKey, yKey. Do not include markdown."
      : language === "es"
        ? "Eres un asistente de datos. Crea una sugerencia de grafico. Devuelve SOLO un objeto JSON con campos: type (bar|line), data (array de {category, value}), title, xKey, yKey. Sin markdown."
        : "Voce e um assistente de dados. Crie uma sugestao de grafico. Retorne APENAS um objeto JSON com campos: type (bar|line), data (array de {category, value}), title, xKey, yKey. Sem markdown.";

  const chartPrompt = buildChartPrompt(question, columns, sample, language);
  logPrompt("chart", {
    system,
    user: chartPrompt,
    meta: { model: SUMMARY_MODEL, language }
  });
  const completion = await openai.chat.completions.create({
    model: SUMMARY_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: chartPrompt }
    ]
  });

  const raw = completion.choices[0]?.message?.content?.trim() ?? "";
  try {
    const parsed = JSON.parse(raw) as AskSuccessResponse["chart"];
    if (
      parsed &&
      (parsed.type === "bar" || parsed.type === "line") &&
      Array.isArray(parsed.data) &&
      typeof parsed.xKey === "string" &&
      typeof parsed.yKey === "string"
    ) {
      return parsed;
    }
  } catch {
    return inferChart(rows, columns, question);
  }

  return inferChart(rows, columns, question);
};

export const answerQuestion = async (
  question: string,
  chatId?: string,
  language: "pt" | "en" | "es" = "pt"
): Promise<AskResult> => {
  await ensureSchemaCollection();
  const normalizedChatId = chatId?.trim() ? chatId.trim() : undefined;
  const resolvedChatId =
    normalizedChatId ?? `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const cacheKey = getCacheKey(question, resolvedChatId, language);
  const cached = await getCachedValue<AskSuccessResponse>(cacheKey);
  const embeddingInput = await buildEmbeddingInput(question, resolvedChatId, language);
  const embedding = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: embeddingInput
  });
  const vector = embedding.data[0]?.embedding ?? [];
  if (cached) {
    const historyCollection = await getHistoryCollection();
    const historyResult = await historyCollection.insertOne({
      question,
      sql: cached.sql,
      summary: cached.summary,
      createdAt: new Date(),
      favorite: false,
      tags: [],
      chatId: resolvedChatId,
      language,
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
        historyId: historyResult.insertedId.toString()
      }
    };
  }
  const db = await getDbClient();

  const semanticMatch = await findSemanticSql(
    resolvedChatId,
    language,
    vector,
    SEMANTIC_SIMILARITY_THRESHOLD
  );
  if (semanticMatch?.sql) {
    const validation = validateSql(semanticMatch.sql);
    if (validation.ok) {
      try {
        const start = Date.now();
        const result = await db.query(semanticMatch.sql);
        const elapsedMs = Date.now() - start;
        const rowCount = result.rows.length;
        const columns = result.columns;
        let chart = inferChart(result.rows, columns, question);
        try {
          chart = await inferChartWithLLM(
            question,
            result.rows,
            columns,
            language
          );
        } catch {
          chart = inferChart(result.rows, columns, question);
        }
        let summary: string | undefined;
        let summaryUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
        try {
          const summaryResult = await summarizeResult(
            question,
            semanticMatch.sql,
            columns,
            result.rows,
            language
          );
          summary = summaryResult.summary;
          if (summaryResult.usage) {
            summaryUsage = {
              prompt_tokens: summaryResult.usage.prompt_tokens ?? 0,
              completion_tokens: summaryResult.usage.completion_tokens ?? 0,
              total_tokens: summaryResult.usage.total_tokens ?? 0
            };
          }
        } catch {
          summary = undefined;
        }
        const historyCollection = await getHistoryCollection();
        const historyResult = await historyCollection.insertOne({
          question,
          sql: semanticMatch.sql,
          summary,
          createdAt: new Date(),
          favorite: false,
          tags: [],
          chatId: resolvedChatId,
          language,
          success: true,
          elapsedMs,
          rowCount,
          embedding: vector
        });

        const responseData: AskSuccessResponse = {
          sql: semanticMatch.sql,
          rows: result.rows,
          columns,
          elapsedMs,
          chatId: resolvedChatId,
          historyId: historyResult.insertedId.toString(),
          summary,
          cacheHit: true,
          chart,
          tokenUsage: {
            sql: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0
            },
            summary: summaryUsage.total_tokens
              ? {
                  inputTokens: summaryUsage.prompt_tokens ?? 0,
                  outputTokens: summaryUsage.completion_tokens ?? 0,
                  totalTokens: summaryUsage.total_tokens ?? 0
                }
              : undefined,
            total: {
              inputTokens: summaryUsage.prompt_tokens ?? 0,
              outputTokens: summaryUsage.completion_tokens ?? 0,
              totalTokens: summaryUsage.total_tokens ?? 0
            }
          }
        };
        await setCachedValue(cacheKey, responseData);
        await setSemanticEntry(resolvedChatId, language, {
          embedding: vector,
          sql: semanticMatch.sql,
          question,
          createdAt: new Date().toISOString()
        });
        return { ok: true, data: responseData };
      } catch {
        // Fall back to LLM generation below.
      }
    }
  }

  const search = await qdrant.search("schema_chunks", {
    vector,
    limit: 5,
    with_payload: true
  });

  const initialTables = search
    .map((point) => point.payload as TableChunk)
    .filter((payload) => Boolean(payload?.tableFullName));

  if (initialTables.length === 0) {
    return {
      ok: false,
      error: {
        errorMessage: "Nenhuma tabela relevante encontrada no schema indexado.",
        hint: "Rode /api/ingest/schema para indexar o banco."
      }
    };
  }

  const context = await expandTables(initialTables);
  const historySnippet = await buildHistorySnippet(resolvedChatId, language);
  const periodHint = await buildPeriodHint(resolvedChatId, question, language);
  const instructionsCollection = await getInstructionsCollection();
  const instructions = await instructionsCollection
    .find({})
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();
  const instructionText = instructions.length
    ? instructions.map((item) => `- ${item.text}`).join("\n")
    : "";
  const fewShotExamples = await loadFewShotExamples(resolvedChatId, language, vector);

  const maxAttempts = 3;
  let lastError: string | null = null;
  let lastSql: string | null = null;
  let sqlUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
  let summaryUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
  let forceLargeModel = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const prompt = buildPrompt(
      question,
      context,
      historySnippet,
      fewShotExamples,
      lastError,
      lastSql,
      language
    );
    const promptWithPeriod = periodHint
      ? [
          prompt,
          "",
          language === "en"
            ? `Fixed period from chat history: ${periodHint}`
            : language === "es"
              ? `Periodo fijo del historial del chat: ${periodHint}`
          : `Periodo fixo do historico do chat: ${periodHint}`
        ].join("\n")
      : prompt;
    const useMini = !forceLargeModel && attempt === 0;
    let result = await generateSql(
      promptWithPeriod,
      instructionText,
      language,
      useMini ? SQL_MODEL_MINI : SQL_MODEL,
      useMini,
      config.sql.dialect
    );
    if (result.usage) {
      sqlUsage = {
        prompt_tokens: (sqlUsage.prompt_tokens ?? 0) + (result.usage.prompt_tokens ?? 0),
        completion_tokens: (sqlUsage.completion_tokens ?? 0) + (result.usage.completion_tokens ?? 0),
        total_tokens: (sqlUsage.total_tokens ?? 0) + (result.usage.total_tokens ?? 0)
      };
    }
    if (useMini && result.escalated) {
      forceLargeModel = true;
      result = await generateSql(
        promptWithPeriod,
        instructionText,
        language,
        SQL_MODEL,
        false,
        config.sql.dialect
      );
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
      const retry = await generateSql(
        promptWithPeriod,
        instructionText,
        language,
        SQL_MODEL,
        false,
        config.sql.dialect
      );
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
      const queryResult = await db.query(sql);
      const elapsedMs = Date.now() - start;
      const rowCount = queryResult.rows.length;
      const columns = queryResult.columns;
      let chart = inferChart(queryResult.rows, columns, question);
      try {
        chart = await inferChartWithLLM(
          question,
          queryResult.rows,
          columns,
          language
        );
      } catch {
        chart = inferChart(queryResult.rows, columns, question);
      }
      let summary: string | undefined;
      try {
        const summaryResult = await summarizeResult(
          question,
          sql,
          columns,
          queryResult.rows,
          language
        );
        summary = summaryResult.summary;
        if (summaryResult.usage) {
          summaryUsage = {
            prompt_tokens:
              (summaryUsage.prompt_tokens ?? 0) + (summaryResult.usage.prompt_tokens ?? 0),
            completion_tokens:
              (summaryUsage.completion_tokens ?? 0) +
              (summaryResult.usage.completion_tokens ?? 0),
            total_tokens:
              (summaryUsage.total_tokens ?? 0) + (summaryResult.usage.total_tokens ?? 0)
          };
        }
      } catch {
        summary = undefined;
      }
      const historyCollection = await getHistoryCollection();
      const historyResult = await historyCollection.insertOne({
        question,
        sql,
        summary,
        createdAt: new Date(),
        favorite: false,
        tags: [],
        chatId: resolvedChatId,
        language,
        success: true,
        elapsedMs,
        rowCount,
        embedding: vector
      });

      const responseData: AskSuccessResponse = {
        sql,
        rows: queryResult.rows,
        columns,
        elapsedMs,
        chatId: resolvedChatId,
        historyId: historyResult.insertedId.toString(),
        summary,
        cacheHit: false,
        chart,
        tokenUsage: {
          sql: {
            inputTokens: sqlUsage.prompt_tokens ?? 0,
            outputTokens: sqlUsage.completion_tokens ?? 0,
            totalTokens: sqlUsage.total_tokens ?? 0
          },
          summary: summaryUsage.total_tokens
            ? {
                inputTokens: summaryUsage.prompt_tokens ?? 0,
                outputTokens: summaryUsage.completion_tokens ?? 0,
                totalTokens: summaryUsage.total_tokens ?? 0
              }
            : undefined,
          total: {
            inputTokens: (sqlUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0),
            outputTokens:
              (sqlUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0),
            totalTokens: (sqlUsage.total_tokens ?? 0) + (summaryUsage.total_tokens ?? 0)
          }
        }
      };
      await setCachedValue(cacheKey, responseData);
      await setSemanticEntry(resolvedChatId, language, {
        embedding: vector,
        sql,
        question,
        createdAt: new Date().toISOString()
      });
      return {
        ok: true,
        data: responseData
      };
    } catch (error) {
      if (useMini) {
        forceLargeModel = true;
      }
      lastError = sanitizeErrorMessage((error as { message?: string })?.message ?? "Erro SQL.");
    }
  }

  const fallbackSummary =
    language === "en"
      ? "I could not produce a reliable answer this time. Please try rephrasing your question."
      : language === "es"
        ? "No pude producir una respuesta confiable esta vez. Intenta reformular tu pregunta."
        : "Nao consegui produzir uma resposta confiavel desta vez. Tente reformular a pergunta.";

  const historyCollection = await getHistoryCollection();
  const historyResult = await historyCollection.insertOne({
    question,
    sql: lastSql ?? "",
    createdAt: new Date(),
    favorite: false,
    tags: [],
    chatId: resolvedChatId,
    language,
    success: false,
    errorMessage: lastError ?? "Erro ao gerar SQL.",
    elapsedMs: 0,
    rowCount: 0,
    embedding: vector
  });

  return {
    ok: true,
    data: {
      sql: lastSql ?? "",
      rows: [],
      columns: [],
      elapsedMs: 0,
      chatId: resolvedChatId,
      historyId: historyResult.insertedId.toString(),
      summary: fallbackSummary,
      chart: undefined,
      tokenUsage: {
        sql: {
          inputTokens: sqlUsage.prompt_tokens ?? 0,
          outputTokens: sqlUsage.completion_tokens ?? 0,
          totalTokens: sqlUsage.total_tokens ?? 0
        },
        summary: summaryUsage.total_tokens
          ? {
              inputTokens: summaryUsage.prompt_tokens ?? 0,
              outputTokens: summaryUsage.completion_tokens ?? 0,
              totalTokens: summaryUsage.total_tokens ?? 0
            }
          : undefined,
        total: {
          inputTokens: (sqlUsage.prompt_tokens ?? 0) + (summaryUsage.prompt_tokens ?? 0),
          outputTokens:
            (sqlUsage.completion_tokens ?? 0) + (summaryUsage.completion_tokens ?? 0),
          totalTokens: (sqlUsage.total_tokens ?? 0) + (summaryUsage.total_tokens ?? 0)
        }
      }
    }
  };
};
