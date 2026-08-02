import { getOpenAI, getSummaryModel } from "../core/openai.js";
import { getAgentsConfig } from "../core/agentConfig.js";
import type { YearRange } from "../helpers/period.js";
import {
  buildPeriodInstruction,
  extractYearsFromSql,
  findSummaryYearMismatch
} from "./summaryPeriod.js";

export { buildPeriodInstruction, extractYearsFromSql, findSummaryYearMismatch };

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
  /** Years the SQL filtered on, in ascending order. */
  sqlYears?: number[];
  /** Years the summary cited that the SQL never filtered on. Empty when consistent. */
  yearMismatch?: number[];
};

export const summarizeResult = async (
  question: string,
  sql: string,
  columns: string[],
  rows: Record<string, unknown>[],
  language: "pt" | "en" | "es",
  periodRange: YearRange | null = null
): Promise<SummaryResult> => {
  const sample = rows.slice(0, 20);
  const sqlYears = extractYearsFromSql(sql);
  const periodInstruction = buildPeriodInstruction(sqlYears, language, periodRange);
  const systemBase =
    language === "en"
      ? "You are a data analyst talking to a colleague. Respond in markdown, 1 paragraph of up to 4 sentences, in natural spoken language - like someone explaining the number out loud, not a written report. Lead with the main figure, then point out what stands out (highest, lowest, variation) using only what the data actually shows - never invent causes or explanations. No bullets, no headings, and no bureaucratic openers like 'The total presented is' or 'According to the data'. Do not mention SQL or query details. Always respect the period used in the SQL. Clearly differentiate between absolute numbers and percentage rates - do not confuse them."
    : language === "es"
        ? "Eres un analista de datos hablando con un colega. Responde en markdown, 1 parrafo de hasta 4 frases, en lenguaje natural y directo - como alguien explicando el numero en voz alta, no como un informe. Empieza por la cifra principal y luego senala lo que llama la atencion (mayor, menor, variacion) usando solo lo que los datos muestran - nunca inventes causas ni explicaciones. Sin bullets, sin titulos y sin aperturas burocraticas como 'El total presentado es' o 'Conforme a los datos'. No menciones SQL ni detalles de consulta. Respeta siempre el periodo usado en el SQL. Diferencia claramente entre numeros absolutos y tasas porcentuales - no los confundas."
        : "Voce e um analista de dados conversando com um colega. Responda em markdown, 1 paragrafo de ate 4 frases, em linguagem natural e direta - como alguem explicando o numero em voz alta, nao como um relatorio escrito. Comece pelo dado principal e depois aponte o que chama atencao (maior, menor, variacao) usando apenas o que os dados realmente mostram - nunca invente causas ou explicacoes. Sem bullets, sem titulos e sem aberturas burocraticas como 'O total apresentado e' ou 'Conforme os dados'. Nao mencione SQL nem detalhes da consulta. Sempre respeite o periodo usado no SQL. Diferencie claramente numeros absolutos de taxas percentuais - nao os confunda.";
  const system = periodInstruction ? `${systemBase} ${periodInstruction}` : systemBase;

  const summaryPrompt = buildSummaryPrompt(question, sql, columns, sample, language);
  const agentsCfg = await getAgentsConfig();
  const model = await getSummaryModel();
  logPrompt("summary", {
    system,
    user: summaryPrompt,
    meta: { model, language }
  });
  const client = await getOpenAI();
  const temperature = agentsCfg.summary.temperature;
  const completion = await client.chat.completions.create({
    model,
    ...(temperature !== undefined && temperature !== null ? { temperature } : {}),
    messages: [
      { role: "system", content: system },
      { role: "user", content: summaryPrompt }
    ]
  });

  if (shouldLogPrompts() && completion.usage) {
    console.info(`[tokens] summary | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`);
  }
  const choice = completion.choices[0];
  const raw = choice?.message?.content?.trim();
  const summary = raw ? raw.replace(/\s+/g, " ") : undefined;

  // An empty completion is not an exception, so without this the caller would
  // silently serve the "A consulta retornou N resultados" fallback with no
  // trace of why the real summary never arrived.
  if (!summary) {
    console.warn(
      `[summary-empty] modelo=${model} finish_reason=${choice?.finish_reason ?? "n/a"} choices=${completion.choices.length} - usando fallback`
    );
  }
  const yearMismatch = summary ? findSummaryYearMismatch(summary, sqlYears) : [];

  if (yearMismatch.length > 0) {
    console.warn(
      `[summary-year-mismatch] o resumo citou ${yearMismatch.join(", ")} mas o SQL filtrou ${sqlYears.join(", ")}`
    );
  }

  return { summary, usage: completion.usage, sqlYears, yearMismatch };
};
