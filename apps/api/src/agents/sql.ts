import type { TableChunk } from "@auraia/shared";
import { getOpenAI, getSqlModel, getSqlModelMini } from "../core/openai.js";
import { getAgentsConfig } from "../core/agentConfig.js";
import type { DbType } from "../core/appConfig.js";
import type { ExpandedContext } from "./schema.js";
import type { TableProfileMap } from "./profiler.js";
import type { ClassifiedError } from "./sqlErrors.js";
import type { YearRange } from "../helpers/period.js";
import {
  buildSemanticsSection,
  pruneContext,
  type SemanticContext
} from "./sqlSemantics.js";
import {
  findMetrics,
  metricColumns,
  renderMetricsSection,
  type MetricDefinition
} from "../schema/metrics.js";

/**
 * Metricas que sobreviveram a poda do E4.
 *
 * A poda corta coluna que a pergunta nao pediu. Se a formula cita uma coluna
 * que sumiu do schema impresso, o prompt manda somar algo que o modelo nao
 * esta vendo — e ele inventa o nome. Entao a regra e a mesma do E3: na duvida,
 * silencio. Metrica com qualquer coluna podada simplesmente nao entra.
 */
const metricsVisibleIn = (
  context: ExpandedContext,
  matched: readonly MetricDefinition[]
): MetricDefinition[] => {
  const visible = new Map<string, Set<string>>(
    context.tables.map((t) => [
      t.tableFullName.toLowerCase(),
      new Set(t.columns.map((c) => c.name.toLowerCase()))
    ])
  );
  return matched.filter((m) => {
    const cols = visible.get(m.table.toLowerCase());
    if (!cols) return false;
    return metricColumns(m).every((c) => cols.has(c.toLowerCase()));
  });
};

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
  rawContext: ExpandedContext,
  historySnippet: string | null,
  fewShotExamples: FewShotExample[],
  errorContext: string | null,
  previousSql: string | null,
  language: "pt" | "en" | "es",
  currentPeriod: string | null = null,
  tableProfiles?: TableProfileMap,
  periodRange: YearRange | null = null,
  semantics: SemanticContext | null = null,
  metrics: readonly MetricDefinition[] = []
): string => {
  // Poda antes de montar o schema: o bloco semantico so pode citar coluna que
  // sobreviveu, senao o prompt avisa sobre algo que o modelo nao esta vendo.
  // Sem dicionario `pruneContext` devolve a mesma referencia.
  const context = pruneContext(rawContext, question, semantics);
  const semanticsSection = buildSemanticsSection(context, semantics, language);
  const metricsSection = renderMetricsSection(
    metricsVisibleIn(context, findMetrics(question, metrics))
  );

  const includeForeignKeys = context.joins.length === 0;
  const tableDetails = context.tables
    .map((table) => {
      const colProfiles = tableProfiles?.get(table.tableFullName);
      const cols = table.columns.map((c) => {
        const profile = colProfiles?.find(p => p.name === c.name);
        if (profile?.values?.length) return `${c.name}:${c.type}[${profile.values.join(",")}]`;
        if (profile?.range) return `${c.name}:${c.type}[${profile.range}]`;
        return `${c.name}:${c.type}`;
      }).join(", ");
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

  /**
   * The interval must survive as a single aggregated query. Without this the
   * agent tends to filter only the first year or to emit one branch per
   * endpoint, dropping every year in between.
   */
  const rangeRule = periodRange
    ? language === "en"
      ? `Rule: the question covers the continuous interval ${periodRange.startYear} to ${periodRange.endYear}. Write ONE query with a range filter covering every year from ${periodRange.startYear} through ${periodRange.endYear} (inclusive), group by year, and order by year ascending. Do NOT filter a single year and do NOT emit one branch per endpoint.`
      : language === "es"
        ? `Regla: la pregunta cubre el intervalo continuo ${periodRange.startYear} a ${periodRange.endYear}. Escribe UNA sola consulta con filtro de rango que cubra todos los anos de ${periodRange.startYear} a ${periodRange.endYear} (inclusive), agrupa por ano y ordena por ano ascendente. NO filtres un solo ano y NO generes una rama por extremo.`
        : `Regra: a pergunta cobre o intervalo continuo de ${periodRange.startYear} a ${periodRange.endYear}. Escreva UMA unica consulta com filtro de intervalo cobrindo todos os anos de ${periodRange.startYear} a ${periodRange.endYear} (inclusive), agrupe por ano e ordene por ano crescente. NAO filtre um ano isolado e NAO gere um ramo por extremo.`
    : null;

  const lines: Array<string | null> = [];
  lines.push(priorityRule, periodRule, followUpRule, rangeRule);
  if (historySnippet) {
    lines.push(historyLabel, historySnippet);
  }
  if (fewShotSection) {
    lines.push(fewShotSection);
  }
  lines.push(schemaLabel, tableDetails);
  // Depois do schema: as regras citam colunas, e o modelo precisa ter acabado
  // de ler a lista para saber de quem se fala.
  if (semanticsSection) {
    lines.push(semanticsSection);
  }
  // Depois das guardas: elas dizem o que NAO fazer, o catalogo diz o que
  // fazer. A definicao positiva vem por ultimo para ser a que o modelo lembra.
  if (metricsSection) {
    lines.push(metricsSection);
  }
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

  const textCompareRule = dbType === "oracle"
    ? language === "en"
      ? "CRITICAL - Text comparison: ALL string comparisons (=, IN, LIKE) MUST be accent-insensitive AND case-insensitive. " +
        "Use NLSSORT on BOTH sides: NLSSORT(column,'NLS_SORT=BINARY_AI') = NLSSORT('literal','NLS_SORT=BINARY_AI'). " +
        "For LIKE: NLSSORT(column,'NLS_SORT=BINARY_AI') LIKE NLSSORT('%text%','NLS_SORT=BINARY_AI'). " +
        "For IN: use individual NLSSORT comparisons with OR instead of IN. " +
        "This ensures 'SAÍDA' matches 'SAIDA', 'saída' matches 'SAIDA', etc. NEVER compare raw text."
      : language === "es"
        ? "CRITICO - Comparacion de texto: TODAS las comparaciones de strings (=, IN, LIKE) DEBEN ser accent-insensitive Y case-insensitive. " +
          "Usa NLSSORT en AMBOS lados: NLSSORT(columna,'NLS_SORT=BINARY_AI') = NLSSORT('literal','NLS_SORT=BINARY_AI'). " +
          "Para LIKE: NLSSORT(columna,'NLS_SORT=BINARY_AI') LIKE NLSSORT('%texto%','NLS_SORT=BINARY_AI'). " +
          "Para IN: usa comparaciones individuales con NLSSORT y OR en vez de IN. " +
          "Esto asegura que 'SAÍDA' coincida con 'SAIDA', etc. NUNCA compares texto sin normalizar."
        : "CRITICO - Comparacao de texto: TODAS as comparacoes de strings (=, IN, LIKE) DEVEM ser accent-insensitive E case-insensitive. " +
          "Use NLSSORT em AMBOS os lados: NLSSORT(coluna,'NLS_SORT=BINARY_AI') = NLSSORT('literal','NLS_SORT=BINARY_AI'). " +
          "Para LIKE: NLSSORT(coluna,'NLS_SORT=BINARY_AI') LIKE NLSSORT('%texto%','NLS_SORT=BINARY_AI'). " +
          "Para IN: use comparacoes individuais com NLSSORT e OR em vez de IN. " +
          "Isso garante que 'SAÍDA' bata com 'SAIDA', 'saída' bata com 'SAIDA', etc. NUNCA compare texto cru."
    : dbType === "mysql"
    ? language === "en"
      ? "CRITICAL - Text comparison: ALL string comparisons (=, IN, LIKE) MUST be accent-insensitive AND case-insensitive. " +
        "Use COLLATE utf8mb4_unicode_ci on the column or comparison (e.g., column COLLATE utf8mb4_unicode_ci LIKE '%text%'). " +
        "This ensures accented and unaccented characters match. NEVER compare raw text."
      : language === "es"
        ? "CRITICO - Comparacion de texto: TODAS las comparaciones de strings (=, IN, LIKE) DEBEN ser accent-insensitive Y case-insensitive. " +
          "Usa COLLATE utf8mb4_unicode_ci en la columna o comparacion (ej., columna COLLATE utf8mb4_unicode_ci LIKE '%texto%'). " +
          "NUNCA compares texto sin normalizar."
        : "CRITICO - Comparacao de texto: TODAS as comparacoes de strings (=, IN, LIKE) DEVEM ser accent-insensitive E case-insensitive. " +
          "Use COLLATE utf8mb4_unicode_ci na coluna ou comparacao (ex., coluna COLLATE utf8mb4_unicode_ci LIKE '%texto%'). " +
          "NUNCA compare texto cru."
    : dbType === "postgresql"
    ? language === "en"
      ? "CRITICAL - Text comparison: ALL string comparisons (=, IN, LIKE) MUST be case-insensitive. " +
        "Use ILIKE instead of LIKE, and LOWER() for = and IN comparisons (e.g., LOWER(column) = LOWER('text')). " +
        "For accent-insensitive search use unaccent() extension if available. NEVER compare raw text."
      : language === "es"
        ? "CRITICO - Comparacion de texto: TODAS las comparaciones de strings (=, IN, LIKE) DEBEN ser case-insensitive. " +
          "Usa ILIKE en vez de LIKE, y LOWER() para = e IN (ej., LOWER(columna) = LOWER('texto')). " +
          "Para busqueda accent-insensitive usa unaccent() si esta disponible. NUNCA compares texto sin normalizar."
        : "CRITICO - Comparacao de texto: TODAS as comparacoes de strings (=, IN, LIKE) DEVEM ser case-insensitive. " +
          "Use ILIKE em vez de LIKE, e LOWER() para = e IN (ex., LOWER(coluna) = LOWER('texto')). " +
          "Para busca accent-insensitive use unaccent() se disponivel. NUNCA compare texto cru."
    : language === "en"
      ? "CRITICAL - Text comparison: ALL string comparisons (=, IN, LIKE) MUST be accent-insensitive AND case-insensitive. " +
        "Use COLLATE Latin1_General_CI_AI on the column (e.g., column COLLATE Latin1_General_CI_AI LIKE '%text%'). " +
        "This ensures accented and unaccented characters match. NEVER compare raw text."
      : language === "es"
        ? "CRITICO - Comparacion de texto: TODAS las comparaciones de strings (=, IN, LIKE) DEBEN ser accent-insensitive Y case-insensitive. " +
          "Usa COLLATE Latin1_General_CI_AI en la columna (ej., columna COLLATE Latin1_General_CI_AI LIKE '%texto%'). " +
          "NUNCA compares texto sin normalizar."
        : "CRITICO - Comparacao de texto: TODAS as comparacoes de strings (=, IN, LIKE) DEVEM ser accent-insensitive E case-insensitive. " +
          "Use COLLATE Latin1_General_CI_AI na coluna (ex., coluna COLLATE Latin1_General_CI_AI LIKE '%texto%'). " +
          "NUNCA compare texto cru.";

  const base = dbType === "oracle"
    ? language === "en"
      ? "You are an Oracle SQL expert. Output only SELECT statements, no markdown or comments. " +
        "Rules: use FETCH FIRST n ROWS ONLY or ROWNUM <= n; no SELECT *; forbid DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
        seasonRule + " " + textCompareRule
      : language === "es"
        ? "Eres un experto en Oracle SQL. Devuelve solo sentencias SELECT, sin markdown ni comentarios. " +
          "Reglas: usa FETCH FIRST n ROWS ONLY o ROWNUM <= n; no SELECT *; prohibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
          seasonRule + " " + textCompareRule
        : "Voce e um especialista em Oracle SQL. Retorne apenas sentencas SELECT, sem markdown ou comentarios. " +
          "Regras: use FETCH FIRST n ROWS ONLY ou ROWNUM <= n; nao use SELECT *; proibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
          seasonRule + " " + textCompareRule
    : dbType === "mysql"
    ? language === "en"
      ? "You are a MySQL expert. Output only SELECT statements, no markdown or comments. " +
        "Rules: use LIMIT 100; no SELECT *; forbid DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
        seasonRule + " " + textCompareRule
      : language === "es"
        ? "Eres un experto en MySQL. Devuelve solo sentencias SELECT, sin markdown ni comentarios. " +
          "Reglas: usa LIMIT 100; no SELECT *; prohibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
          seasonRule + " " + textCompareRule
        : "Voce e um especialista em MySQL. Retorne apenas sentencas SELECT, sem markdown ou comentarios. " +
          "Regras: use LIMIT 100; nao use SELECT *; proibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
          seasonRule + " " + textCompareRule
    : dbType === "postgresql"
    ? language === "en"
      ? "You are a PostgreSQL expert. Output only SELECT statements, no markdown or comments. " +
        "Rules: use LIMIT 100; no SELECT *; forbid DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
        seasonRule + " " + textCompareRule
      : language === "es"
        ? "Eres un experto en PostgreSQL. Devuelve solo sentencias SELECT, sin markdown ni comentarios. " +
          "Reglas: usa LIMIT 100; no SELECT *; prohibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
          seasonRule + " " + textCompareRule
        : "Voce e um especialista em PostgreSQL. Retorne apenas sentencas SELECT, sem markdown ou comentarios. " +
          "Regras: use LIMIT 100; nao use SELECT *; proibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
          seasonRule + " " + textCompareRule
    : language === "en"
      ? "You are a SQL Server expert. Output only T-SQL SELECT, no markdown or comments. " +
        "Rules: TOP (100); no SELECT *; forbid DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
        seasonRule + " " + textCompareRule
      : language === "es"
        ? "Eres un experto en SQL Server. Devuelve solo T-SQL SELECT, sin markdown ni comentarios. " +
          "Reglas: TOP (100); no SELECT *; prohibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
          seasonRule + " " + textCompareRule
        : "Voce e um especialista em SQL Server. Retorne apenas T-SQL SELECT, sem markdown ou comentarios. " +
          "Regras: TOP (100); nao use SELECT *; proibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_. " +
          seasonRule + " " + textCompareRule;

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

// ============== SELF-REFLECTION ==============

export const reflectOnError = async (
  failedSql: string,
  error: ClassifiedError,
  question: string,
  language: "pt" | "en" | "es"
): Promise<{ reflection: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }> => {
  const client = await getOpenAI();
  const model = await getSqlModelMini();

  const systemPrompts: Record<"pt" | "en" | "es", string> = {
    pt: "Voce e um analista de SQL. Sua tarefa e explicar de forma concisa (maximo 3 frases) por que o SQL abaixo falhou e o que precisa mudar para corrigir. Nao gere SQL, apenas a analise.",
    en: "You are a SQL analyst. Your task is to concisely explain (max 3 sentences) why the SQL below failed and what needs to change to fix it. Do not generate SQL, only the analysis.",
    es: "Eres un analista de SQL. Tu tarea es explicar de forma concisa (maximo 3 frases) por que el SQL a continuacion fallo y que necesita cambiar para corregirlo. No generes SQL, solo el analisis."
  };

  const userPrompt = [
    `SQL: ${failedSql}`,
    `Error [${error.category}]: ${error.originalMessage}`,
    `Hint: ${error.hint}`,
    `Question: ${question}`
  ].join("\n");

  logPrompt("sql-reflection", { system: systemPrompts[language], user: userPrompt, meta: { model, language } });

  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompts[language] },
      { role: "user", content: userPrompt }
    ]
  });

  const reflection = completion.choices[0]?.message?.content ?? "";
  logPrompt("sql-reflection-response", { user: reflection, meta: { model, language } });

  if (shouldLogPrompts() && completion.usage) {
    console.info(`[tokens] reflection (${model}) | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`);
  }

  return { reflection, usage: completion.usage };
};

// ============== CORRECTION SYSTEM PROMPT ==============

const buildCorrectionSystemContent = (
  instructionText: string,
  language: "pt" | "en" | "es",
  dbType: DbType,
  error: ClassifiedError,
  reflection: string
): string => {
  const correctionIntro: Record<"pt" | "en" | "es", string> = {
    pt: "Voce e um especialista em correcao de SQL. Um SQL anterior falhou e voce deve gerar uma versao CORRIGIDA. " +
      "Analise cuidadosamente o erro, a reflexao e o schema antes de gerar o novo SQL. " +
      "Retorne APENAS o SQL corrigido, sem markdown ou comentarios.",
    en: "You are a SQL correction specialist. A previous SQL failed and you must generate a CORRECTED version. " +
      "Carefully analyze the error, the reflection and the schema before generating the new SQL. " +
      "Return ONLY the corrected SQL, no markdown or comments.",
    es: "Eres un especialista en correccion de SQL. Un SQL anterior fallo y debes generar una version CORREGIDA. " +
      "Analiza cuidadosamente el error, la reflexion y el esquema antes de generar el nuevo SQL. " +
      "Devuelve SOLO el SQL corregido, sin markdown ni comentarios."
  };

  const dbRules: Record<DbType, Record<"pt" | "en" | "es", string>> = {
    sqlserver: {
      pt: "Regras SQL Server: TOP (n); sem SELECT *; proibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_.",
      en: "SQL Server rules: TOP (n); no SELECT *; forbid DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_.",
      es: "Reglas SQL Server: TOP (n); sin SELECT *; prohibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_."
    },
    oracle: {
      pt: "Regras Oracle: FETCH FIRST n ROWS ONLY ou ROWNUM <= n; sem SELECT *; proibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_.",
      en: "Oracle rules: FETCH FIRST n ROWS ONLY or ROWNUM <= n; no SELECT *; forbid DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_.",
      es: "Reglas Oracle: FETCH FIRST n ROWS ONLY o ROWNUM <= n; sin SELECT *; prohibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_."
    },
    mysql: {
      pt: "Regras MySQL: LIMIT n; sem SELECT *; proibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_.",
      en: "MySQL rules: LIMIT n; no SELECT *; forbid DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_.",
      es: "Reglas MySQL: LIMIT n; sin SELECT *; prohibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_."
    },
    postgresql: {
      pt: "Regras PostgreSQL: LIMIT n; sem SELECT *; proibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_.",
      en: "PostgreSQL rules: LIMIT n; no SELECT *; forbid DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_.",
      es: "Reglas PostgreSQL: LIMIT n; sin SELECT *; prohibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_."
    }
  };

  const reflectionLabel: Record<"pt" | "en" | "es", string> = {
    pt: "Analise do erro anterior",
    en: "Previous error analysis",
    es: "Analisis del error anterior"
  };

  const hintLabel: Record<"pt" | "en" | "es", string> = {
    pt: "Dica de correcao",
    en: "Correction hint",
    es: "Pista de correccion"
  };

  const parts = [
    correctionIntro[language],
    dbRules[dbType][language],
    `${reflectionLabel[language]}: ${reflection}`,
    `${hintLabel[language]} [${error.category}]: ${error.hint}`
  ];

  const instructionsLabel =
    language === "en" ? "Additional instructions:" : language === "es" ? "Instrucciones adicionales:" : "Instrucoes adicionais:";

  if (instructionText.trim()) {
    parts.push(`${instructionsLabel}\n${instructionText}`);
  }

  return parts.join("\n");
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
  const model = useMini ? await getSqlModelMini() : await getSqlModel();
  const agentsCfg = await getAgentsConfig();
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
  const temperature = agentsCfg.sql.temperature;
  const completion = await client.chat.completions.create({
    model,
    ...(temperature !== undefined && temperature !== null ? { temperature } : {}),
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

export const generateCorrectedSql = async (
  prompt: string,
  instructionText: string,
  language: "pt" | "en" | "es",
  dbType: DbType,
  error: ClassifiedError,
  reflection: string
): Promise<GenerateSqlResult> => {
  const model = await getSqlModel();
  const agentsCfg = await getAgentsConfig();
  const system = buildCorrectionSystemContent(instructionText, language, dbType, error, reflection);

  logPrompt("sql-correction", {
    system,
    user: prompt,
    meta: { model, language, errorCategory: error.category }
  });

  const client = await getOpenAI();
  const temperature = agentsCfg.sql.temperature;
  const completion = await client.chat.completions.create({
    model,
    ...(temperature !== undefined && temperature !== null ? { temperature } : {}),
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt }
    ]
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  logPrompt("sql-correction-response", {
    user: raw,
    meta: { model, language, errorCategory: error.category }
  });

  if (shouldLogPrompts() && completion.usage) {
    console.info(`[tokens] sql-correction (${model}) | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`);
  }

  return { sql: stripSql(raw), usage: completion.usage };
};
