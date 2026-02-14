import type { AskSuccessResponse } from "@auraia/shared";
import { getOpenAI, getChartModel } from "../openai.js";
import { getAgentsConfig } from "../agentConfig.js";

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

export const inferChart = (
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

export const inferChartWithLLM = async (
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
  const model = await getChartModel();
  const agentsCfg = await getAgentsConfig();
  logPrompt("chart", {
    system,
    user: chartPrompt,
    meta: { model, language }
  });
  const client = await getOpenAI();
  const completion = await client.chat.completions.create({
    model,
    temperature: agentsCfg.chart.temperature ?? 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: chartPrompt }
    ]
  });

  if (shouldLogPrompts() && completion.usage) {
    console.info(`[tokens] chart | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`);
  }
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
