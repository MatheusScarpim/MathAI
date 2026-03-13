import type { TableChunk } from "@auraia/shared";
import { qdrant } from "../qdrant.js";
import { loadSchemaGraph } from "../schema.js";
import { getOpenAI, getEmbeddingModel, getSqlModelMini } from "../openai.js";
import { getHistoryCollection } from "../mongo.js";

export type ExpandedContext = {
  tables: TableChunk[];
  joins: string[];
};

const preferTableOrder = (table: TableChunk, connectedToFat: boolean): number => {
  const isDim = table.tags?.includes("Dim");
  if (connectedToFat && isDim) return 0;
  return 1;
};

const buildJoinKey = (from: string, fromCol: string, to: string, toCol: string): string =>
  `${from}.${fromCol}->${to}.${toCol}`;

const COMPLEX_KEYWORDS = /\bjoin\b|\bcross\b|\bunion\b|\bsubquer|\bcorrelat|\bmultip|\bcompar|\brelaci|\brelation|\bcruzar|\bcruzamento|\bcombinar|\bentre\b.*\be\b/i;
const SIMPLE_KEYWORDS = /\btotal\b|\bquant|\bcount|\blistar?\b|\bmostrar?\b|\bexib|\blist\b|\bshow\b|\bhow many\b/i;

export const estimateQueryComplexity = (question: string, initialTableCount: number): 1 | 2 | 3 => {
  const tokens = tokenize(question);
  const hasComplexSignal = COMPLEX_KEYWORDS.test(question);
  const hasSimpleSignal = SIMPLE_KEYWORDS.test(question) && !hasComplexSignal;

  // Many initial tables found → likely complex cross-table question
  if (initialTableCount >= 5 || hasComplexSignal) return 3;
  // Few tokens, simple verbs, single table → minimal expansion
  if (hasSimpleSignal && tokens.length <= 6 && initialTableCount <= 2) return 1;
  // Default medium complexity
  return 2;
};

export const expandTables = async (
  initial: TableChunk[],
  maxHops: number = 2
): Promise<ExpandedContext> => {
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

const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_\. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenize = (value: string): string[] =>
  normalizeText(value)
    .split(/[\s\.\_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

const scoreTableMatch = (questionTokens: string[], table: TableChunk): number => {
  const tableTokens = new Set<string>([
    ...tokenize(table.tableFullName),
    ...tokenize(table.tableFullName.split(".").pop() ?? "")
  ]);
  if (!tableTokens.size || !questionTokens.length) return 0;

  // Build column token sets for column-level matching
  const columnNames = new Set<string>();
  const columnTokens = new Set<string>();
  for (const col of table.columns ?? []) {
    const normalized = normalizeText(col.name);
    columnNames.add(normalized);
    for (const t of tokenize(col.name)) {
      columnTokens.add(t);
    }
  }

  let score = 0;
  for (const token of questionTokens) {
    // Table name exact match
    if (tableTokens.has(token)) {
      score += 2;
      continue;
    }
    // Table name partial match
    let matched = false;
    for (const t of tableTokens) {
      if (t.length < 4 || token.length < 4) continue;
      if (t.includes(token) || token.includes(t)) {
        score += 1;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Column-level search: exact column name match (e.g. "cpf" matches column "CPF")
    if (columnNames.has(token) || columnTokens.has(token)) {
      score += 1.5;
      continue;
    }
    // Column-level partial match
    for (const ct of columnTokens) {
      if (ct.length < 4 || token.length < 4) continue;
      if (ct.includes(token) || token.includes(ct)) {
        score += 0.8;
        break;
      }
    }
  }
  if (table.tags?.includes("Fat")) score += 0.5;
  return score;
};

export const searchRelevantTables = async (
  vector: number[],
  question: string,
  maxTables: number = 8
): Promise<TableChunk[]> => {
  const safeMaxTables = Number.isFinite(maxTables)
    ? Math.max(1, Math.min(30, Math.floor(maxTables)))
    : 8;

  // Fetch more candidates than needed for reranking (~15)
  const candidateLimit = Math.max(15, safeMaxTables + 7);

  const search = await qdrant.search("schema_chunks", {
    vector,
    limit: candidateLimit,
    with_payload: true
  });

  const semanticResults = search
    .map((point) => point.payload as TableChunk)
    .filter((payload) => Boolean(payload?.tableFullName));

  const questionTokens = tokenize(question);
  const allTables = await loadSchemaGraph();
  const lexicalMatches = questionTokens.length
    ? allTables
        .map((table) => ({
          table,
          score: scoreTableMatch(questionTokens, table)
        }))
        .filter((item) => item.score >= 1.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, candidateLimit)
        .map((item) => item.table)
    : [];

  const merged = new Map<string, TableChunk>();
  for (const table of semanticResults) {
    merged.set(table.tableFullName, table);
  }
  for (const table of lexicalMatches) {
    if (!merged.has(table.tableFullName)) {
      merged.set(table.tableFullName, table);
    }
  }

  const candidates = Array.from(merged.values());

  // If we have enough candidates, use LLM reranking to pick the best ones
  if (candidates.length > safeMaxTables) {
    try {
      const reranked = await rerankTablesWithLLM(question, candidates, safeMaxTables);
      if (reranked.length > 0) return reranked;
    } catch {
      // Fallback to original ordering on LLM failure
    }
  }

  return candidates.slice(0, safeMaxTables);
};

export const rerankTablesWithLLM = async (
  question: string,
  candidates: TableChunk[],
  topN: number
): Promise<TableChunk[]> => {
  const client = await getOpenAI();
  const model = await getSqlModelMini();

  const tableList = candidates
    .map((t, i) => {
      const cols = t.columns.slice(0, 10).map((c: { name: string }) => c.name).join(", ");
      const tags = t.tags.length ? ` [${t.tags.join(",")}]` : "";
      return `${i + 1}. ${t.tableFullName}${tags}: ${cols}`;
    })
    .join("\n");

  const systemPrompt =
    "You are a database schema expert. Given a user question and a numbered list of candidate tables (with sample columns), " +
    `return ONLY the numbers of the top ${topN} most relevant tables for answering the question, as a comma-separated list (e.g. "3,1,7,5,2"). ` +
    "Rank by relevance — most relevant first. No explanation, no text, only numbers.";

  const userPrompt = `Question: ${question}\n\nCandidate tables:\n${tableList}`;

  if (shouldLogPrompts()) {
    console.info(`[prompt-log] rerank | system:\n${systemPrompt}`);
    console.info(`[prompt-log] rerank | user:\n${userPrompt}`);
  }

  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  if (shouldLogPrompts()) {
    console.info(`[prompt-log] rerank-response: ${raw}`);
    if (completion.usage) {
      console.info(`[tokens] rerank (${model}) | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`);
    }
  }

  // Parse comma-separated indices
  const indices = raw
    .replace(/[^0-9,]/g, "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10) - 1)
    .filter((i) => Number.isFinite(i) && i >= 0 && i < candidates.length);

  const seen = new Set<number>();
  const result: TableChunk[] = [];
  for (const idx of indices) {
    if (seen.has(idx)) continue;
    seen.add(idx);
    result.push(candidates[idx]);
    if (result.length >= topN) break;
  }

  return result;
};

const shouldLogPrompts = (): boolean => {
  const flag = process.env.LOG_PROMPTS?.toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
};

export const generateEmbedding = async (
  text: string
): Promise<number[]> => {
  const client = await getOpenAI();
  const embeddingModel = await getEmbeddingModel();
  const embedding = await client.embeddings.create({
    model: embeddingModel,
    input: text
  });
  if (shouldLogPrompts() && embedding.usage) {
    console.info(`[tokens] embedding | input=${embedding.usage.prompt_tokens} total=${embedding.usage.total_tokens}`);
  }
  return embedding.data[0]?.embedding ?? [];
};

export const buildEmbeddingInput = async (
  question: string,
  chatId: string | undefined,
  language: "pt" | "en" | "es"
): Promise<string> => {
  const trimmed = question.trim();
  if (!chatId) return trimmed;
  const MAX_HISTORY_FOR_EMBEDDING = 8;
  const collection = await getHistoryCollection();
  const items = await collection
    .find({ chatId })
    .sort({ createdAt: -1 })
    .limit(MAX_HISTORY_FOR_EMBEDDING)
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

  const historyLines = items.reverse().map((item, index) => {
    const previous = item.embeddingQuestion ?? item.question;
    return `${prevLabel} ${index + 1}: ${previous}`;
  });

  return `${historyLines.join("\n")}\n${currentLabel}: ${trimmed}`;
};
