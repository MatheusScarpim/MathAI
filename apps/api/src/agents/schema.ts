import type { TableChunk } from "@auraia/shared";
import { qdrant } from "../qdrant.js";
import { loadSchemaGraph } from "../schema.js";
import { getOpenAI, EMBEDDING_MODEL } from "../openai.js";
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

export const expandTables = async (initial: TableChunk[]): Promise<ExpandedContext> => {
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

  let score = 0;
  for (const token of questionTokens) {
    if (tableTokens.has(token)) {
      score += 2;
      continue;
    }
    for (const t of tableTokens) {
      if (t.length < 4 || token.length < 4) continue;
      if (t.includes(token) || token.includes(t)) {
        score += 1;
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

  const search = await qdrant.search("schema_chunks", {
    vector,
    limit: Math.max(3, safeMaxTables + 2),
    with_payload: true
  });

  const semanticResults = search
    .map((point) => point.payload as TableChunk)
    .filter((payload) => Boolean(payload?.tableFullName));

  const questionTokens = tokenize(question);
  if (!questionTokens.length) return semanticResults;

  const allTables = await loadSchemaGraph();
  const lexicalMatches = allTables
    .map((table) => ({
      table,
      score: scoreTableMatch(questionTokens, table)
    }))
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(3, safeMaxTables))
    .map((item) => item.table);

  const merged = new Map<string, TableChunk>();
  for (const table of semanticResults) {
    merged.set(table.tableFullName, table);
  }
  for (const table of lexicalMatches) {
    if (!merged.has(table.tableFullName)) {
      merged.set(table.tableFullName, table);
    }
  }

  return Array.from(merged.values()).slice(0, safeMaxTables);
};

const shouldLogPrompts = (): boolean => {
  const flag = process.env.LOG_PROMPTS?.toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
};

export const generateEmbedding = async (
  text: string
): Promise<number[]> => {
  const client = await getOpenAI();
  const embedding = await client.embeddings.create({
    model: EMBEDDING_MODEL,
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

  const historyLines = items.map((item, index) => {
    const previous = item.embeddingQuestion ?? item.question;
    return `${prevLabel} ${index + 1}: ${previous}`;
  });

  return `${historyLines.join("\n")}\n${currentLabel}: ${trimmed}`;
};
