import type { TableChunk } from "@auraia/shared";
import { qdrant } from "../qdrant.js";
import { loadSchemaGraph } from "../schema.js";
import { openai, EMBEDDING_MODEL } from "../openai.js";
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

export const searchRelevantTables = async (
  vector: number[]
): Promise<TableChunk[]> => {
  const search = await qdrant.search("schema_chunks", {
    vector,
    limit: 5,
    with_payload: true
  });

  return search
    .map((point) => point.payload as TableChunk)
    .filter((payload) => Boolean(payload?.tableFullName));
};

const shouldLogPrompts = (): boolean => {
  const flag = process.env.LOG_PROMPTS?.toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
};

export const generateEmbedding = async (
  text: string
): Promise<number[]> => {
  const embedding = await openai.embeddings.create({
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
