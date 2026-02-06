import type { TableChunk } from "@auraia/shared";
import { getOpenAI, SQL_MODEL, SQL_MODEL_MINI } from "../openai.js";
import type { DbType } from "../appConfig.js";
import type { ExpandedContext } from "./schema.js";

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

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

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

export const buildPrompt = (
  question: string,
  context: ExpandedContext,
  historySnippet: string | null,
  fewShotExamples: FewShotExample[],
  errorContext: string | null,
  previousSql: string | null,
  language: "pt" | "en" | "es",
  currentPeriod: string | null = null
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
  const periodLabel =
    language === "en"
      ? "Current period:"
      : language === "es"
        ? "Periodo actual:"
        : "Periodo atual:";
  const questionLabel =
    language === "en" ? "Question:" : language === "es" ? "Pregunta:" : "Pergunta:";
  const priorityRule =
    language === "en"
      ? "Rule: prioritize the current question. Use history only to fill missing context and never override the current question."
      : language === "es"
        ? "Regla: prioriza la pregunta actual. Usa el historial solo para completar contexto faltante y nunca sobrescribas la pregunta actual."
        : "Regra: priorize a pergunta atual. Use o historico apenas para completar contexto faltante e nunca sobrescreva a pergunta atual.";
  const periodRule =
    language === "en"
      ? "Rule: if the current question mentions a year/month/period, ignore any different period shown in history or examples."
      : language === "es"
        ? "Regla: si la pregunta actual menciona un ano/mes/periodo, ignora cualquier periodo diferente del historial o de los ejemplos."
        : "Regra: se a pergunta atual mencionar ano/mes/periodo, ignore qualquer periodo diferente do historico ou dos exemplos.";
  const followUpRule =
    language === "en"
      ? "Rule: if the current question is a short follow-up (e.g., 'and in 2024?'), keep the same metrics, dimensions, and filters from the most recent question, only change the time period."
      : language === "es"
        ? "Regla: si la pregunta actual es un seguimiento corto (ej., 'y en 2024?'), conserva las mismas metricas, dimensiones y filtros de la pregunta mas reciente, y cambia solo el periodo."
        : "Regra: se a pergunta atual for um follow-up curto (ex.: 'e em 2024?'), mantenha as mesmas metricas, dimensoes e filtros da pergunta mais recente e altere apenas o periodo.";

  const lines: Array<string | null> = [];
  lines.push(priorityRule, periodRule, followUpRule);
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
  if (currentPeriod) {
    lines.push(periodLabel, currentPeriod);
  }
  lines.push(questionLabel, question);

  return lines.filter((line) => line !== null).join("\n");
};

const buildSystemContent = (
  instructionText: string,
  language: "pt" | "en" | "es",
  dbType: DbType
): string => {
  const seasonRule =
    language === "en"
      ? "CRITICAL - Southern Hemisphere seasons (Brazil): Summer=Dec,Jan,Feb (months 12,1,2); Winter=Jun,Jul,Aug (months 6,7,8); Autumn=Mar,Apr,May; Spring=Sep,Oct,Nov. NEVER confuse seasons."
      : language === "es"
        ? "CRITICO - Estaciones del hemisferio sur (Brasil): Verano=Dic,Ene,Feb (meses 12,1,2); Invierno=Jun,Jul,Ago (meses 6,7,8); Otono=Mar,Abr,May; Primavera=Sep,Oct,Nov. NUNCA confundir estaciones."
        : "CRITICO - Estacoes do hemisferio sul (Brasil): Verao=Dez,Jan,Fev (meses 12,1,2); Inverno=Jun,Jul,Ago (meses 6,7,8); Outono=Mar,Abr,Mai; Primavera=Set,Out,Nov. NUNCA confundir estacoes.";

  const base = dbType === "oracle"
    ? language === "en"
      ? "You are an Oracle SQL expert. Output only SELECT statements, no markdown or comments. " +
        "Rules: use FETCH FIRST n ROWS ONLY or ROWNUM <= n; no SELECT *; forbid DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
        seasonRule
      : language === "es"
        ? "Eres un experto en Oracle SQL. Devuelve solo sentencias SELECT, sin markdown ni comentarios. " +
          "Reglas: usa FETCH FIRST n ROWS ONLY o ROWNUM <= n; no SELECT *; prohibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
          seasonRule
        : "Voce e um especialista em Oracle SQL. Retorne apenas sentencas SELECT, sem markdown ou comentarios. " +
          "Regras: use FETCH FIRST n ROWS ONLY ou ROWNUM <= n; nao use SELECT *; proibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
          seasonRule
    : language === "en"
      ? "You are a SQL Server expert. Output only T-SQL SELECT, no markdown or comments. " +
        "Rules: TOP (100); no SELECT *; forbid DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
        seasonRule
      : language === "es"
        ? "Eres un experto en SQL Server. Devuelve solo T-SQL SELECT, sin markdown ni comentarios. " +
          "Reglas: TOP (100); no SELECT *; prohibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
          seasonRule
        : "Voce e um especialista em SQL Server. Retorne apenas T-SQL SELECT, sem markdown ou comentarios. " +
          "Regras: TOP (100); nao use SELECT *; proibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
          seasonRule;

  const instructionsLabel =
    language === "en" ? "Additional instructions:" : language === "es" ? "Instrucciones adicionales:" : "Instrucoes adicionais:";

  if (!instructionText.trim()) return base;
  return `${base}\n${instructionsLabel}\n${instructionText}`;
};

const stripSql = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.includes("```")) return trimmed;
  return trimmed.replace(/```sql/gi, "```").replace(/```/g, "").trim();
};

export type GenerateSqlResult = {
  sql: string;
  escalated?: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export const generateSql = async (
  prompt: string,
  instructionText: string,
  language: "pt" | "en" | "es",
  dbType: DbType,
  useMini: boolean,
  allowEscalation: boolean
): Promise<GenerateSqlResult> => {
  const model = useMini ? SQL_MODEL_MINI : SQL_MODEL;
  const baseSystem = buildSystemContent(instructionText, language, dbType);
  const system = allowEscalation
    ? `${baseSystem}\nIf unsure you can produce a correct query, reply with only: ESCALATE`
    : baseSystem;
  logPrompt("sql", {
    system,
    user: prompt,
    meta: { model, language }
  });
  const client = await getOpenAI();
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt }
    ]
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  logPrompt("sql-response", {
    user: raw,
    meta: { model, language }
  });
  if (shouldLogPrompts() && completion.usage) {
    console.info(`[tokens] sql (${model}) | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`);
  }
  if (allowEscalation && raw.trim().toUpperCase() === "ESCALATE") {
    return { sql: "", escalated: true, usage: completion.usage };
  }
  const sql = stripSql(raw);
  return { sql, usage: completion.usage };
};
