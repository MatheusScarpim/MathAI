import { openai, SUMMARY_MODEL } from "../openai.js";

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

export const extractYearsFromSql = (sql: string): number[] => {
  const matches = sql.match(/\b(20\d{2})\b/g);
  if (!matches || matches.length === 0) return [];
  const uniqueYears = [...new Set(matches.map((m) => Number.parseInt(m, 10)))];
  return uniqueYears.sort((a, b) => a - b);
};

export const extractYearFromSql = (sql: string): number | null => {
  const years = extractYearsFromSql(sql);
  if (years.length !== 1) return null;
  return years[0] ?? null;
};

const enforceSummaryYear = (summary: string, year: number | null): string => {
  if (!year) return summary;
  const yearText = String(year);
  const years = summary.match(/\b20\d{2}\b/g) ?? [];
  if (years.length === 0) return summary;
  if (years.every((value) => value === yearText)) return summary;
  return summary.replace(/\b20\d{2}\b/g, yearText);
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

export type SummaryResult = {
  summary?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export const summarizeResult = async (
  question: string,
  sql: string,
  columns: string[],
  rows: Record<string, unknown>[],
  language: "pt" | "en" | "es"
): Promise<SummaryResult> => {
  const sample = rows.slice(0, 20);
  const sqlYear = extractYearFromSql(sql);
  const periodInstruction =
    sqlYear && Number.isFinite(sqlYear)
      ? language === "en"
        ? `Period year must be ${sqlYear}.`
        : language === "es"
          ? `El ano del periodo debe ser ${sqlYear}.`
          : `O ano do periodo deve ser ${sqlYear}.`
      : "";
  const systemBase =
    language === "en"
      ? "You are a data assistant. Respond in markdown with 1 short paragraph (max 2 sentences), non-technical, no bullets or headings. Do not mention SQL or query details. Always respect the period used in the SQL. Clearly differentiate between absolute numbers and percentage rates - do not confuse them."
    : language === "es"
        ? "Eres un asistente de datos. Responde en markdown con 1 parrafo corto (max 2 frases), sin tecnicismos, sin bullets ni titulos. No menciones SQL ni detalles de consulta. Respeta siempre el periodo usado en el SQL. Diferencia claramente entre numeros absolutos y tasas porcentuales - no los confundas."
        : "Voce e um assistente de dados. Responda em markdown com 1 paragrafo curto (max 2 frases), sem tecnicismos, sem bullets ou titulos. Nao mencione SQL nem detalhes da consulta. Sempre respeite o periodo usado no SQL. Diferencie claramente entre numeros absolutos e taxas percentuais - nao os confunda.";
  const system = periodInstruction ? `${systemBase} ${periodInstruction}` : systemBase;

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
      { role: "user", content: summaryPrompt }
    ]
  });

  if (shouldLogPrompts() && completion.usage) {
    console.info(`[tokens] summary | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`);
  }
  const summary = completion.choices[0]?.message?.content?.trim();
  return {
    summary: summary
      ? enforceSummaryYear(summary.replace(/\s+/g, " "), sqlYear)
      : undefined,
    usage: completion.usage
  };
};
