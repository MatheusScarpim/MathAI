import { getOpenAI, getSqlModel, getSqlModelMini } from "../core/openai.js";
import { getAgentsConfig } from "../core/agentConfig.js";
import type { DbType } from "../core/appConfig.js";
import type { ExpandedContext } from "./schema.js";

// ============== TYPES ==============

export type SubQuestion = {
  id: string;
  question: string;
  focus: string;
};

export type CombinationStrategy = "cte" | "join" | "union" | "single";

export type DecompositionPlan = {
  needsDecomposition: boolean;
  subQuestions: SubQuestion[];
  combinationStrategy: CombinationStrategy;
  combinationHint: string;
  originalQuestion: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

// ============== HELPERS ==============

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
  if (payload.meta) console.info(`${header} meta=${JSON.stringify(payload.meta)}`);
  if (payload.system) console.info(`${header} system:\n${payload.system}`);
  if (payload.user) console.info(`${header} user:\n${payload.user}`);
};

// ============== SYSTEM PROMPTS ==============

const buildPlannerSystemPrompt = (
  language: "pt" | "en" | "es",
  dbType: DbType
): string => {
  const prompts: Record<"pt" | "en" | "es", string> = {
    pt: `Voce e um planejador de queries SQL. Sua tarefa e analisar uma pergunta do usuario e decidir se ela precisa ser decomposta em sub-consultas independentes.

QUANDO DECOMPOR:
- Perguntas que comparam periodos diferentes (ex: "faturamento de 2024 vs 2023")
- Perguntas que pedem metricas de fontes/dimensoes distintas no mesmo resultado
- Perguntas com "comparado a", "versus", "diferenca entre", "crescimento de X para Y"
- Perguntas que combinam agregacoes incompativeis (ex: total + media + ranking)

QUANDO NAO DECOMPOR (retorne needsDecomposition=false):
- Perguntas simples com filtro unico
- Perguntas que envolvem apenas JOINs normais entre tabelas relacionadas
- Perguntas com GROUP BY simples
- Perguntas que podem ser resolvidas com uma unica query SELECT

RESPONDA SEMPRE em JSON valido com esta estrutura:
{
  "needsDecomposition": true/false,
  "subQuestions": [
    { "id": "sq1", "question": "pergunta da sub-consulta", "focus": "o que esta sub-consulta busca" },
    { "id": "sq2", "question": "pergunta da sub-consulta", "focus": "o que esta sub-consulta busca" }
  ],
  "combinationStrategy": "cte" | "join" | "union",
  "combinationHint": "instrucao de como combinar os resultados"
}

Se needsDecomposition=false, retorne subQuestions=[] e combinationStrategy="single".

Banco de dados: ${dbType === "sqlserver" ? "SQL Server" : dbType === "oracle" ? "Oracle" : "MySQL"}.
Maximo de 4 sub-consultas.`,

    en: `You are a SQL query planner. Your task is to analyze a user question and decide if it needs to be decomposed into independent sub-queries.

WHEN TO DECOMPOSE:
- Questions comparing different periods (e.g., "revenue 2024 vs 2023")
- Questions asking for metrics from distinct sources/dimensions in the same result
- Questions with "compared to", "versus", "difference between", "growth from X to Y"
- Questions combining incompatible aggregations (e.g., total + average + ranking)

WHEN NOT TO DECOMPOSE (return needsDecomposition=false):
- Simple questions with a single filter
- Questions involving only normal JOINs between related tables
- Questions with simple GROUP BY
- Questions that can be solved with a single SELECT query

ALWAYS respond in valid JSON with this structure:
{
  "needsDecomposition": true/false,
  "subQuestions": [
    { "id": "sq1", "question": "sub-query question", "focus": "what this sub-query retrieves" },
    { "id": "sq2", "question": "sub-query question", "focus": "what this sub-query retrieves" }
  ],
  "combinationStrategy": "cte" | "join" | "union",
  "combinationHint": "instruction on how to combine results"
}

If needsDecomposition=false, return subQuestions=[] and combinationStrategy="single".

Database: ${dbType === "sqlserver" ? "SQL Server" : dbType === "oracle" ? "Oracle" : "MySQL"}.
Maximum 4 sub-queries.`,

    es: `Eres un planificador de queries SQL. Tu tarea es analizar una pregunta del usuario y decidir si necesita ser descompuesta en sub-consultas independientes.

CUANDO DESCOMPONER:
- Preguntas que comparan periodos diferentes (ej: "facturacion de 2024 vs 2023")
- Preguntas que piden metricas de fuentes/dimensiones distintas en el mismo resultado
- Preguntas con "comparado con", "versus", "diferencia entre", "crecimiento de X a Y"
- Preguntas que combinan agregaciones incompatibles (ej: total + promedio + ranking)

CUANDO NO DESCOMPONER (retorna needsDecomposition=false):
- Preguntas simples con filtro unico
- Preguntas que solo involucran JOINs normales entre tablas relacionadas
- Preguntas con GROUP BY simple
- Preguntas que se pueden resolver con un solo SELECT

RESPONDE SIEMPRE en JSON valido con esta estructura:
{
  "needsDecomposition": true/false,
  "subQuestions": [
    { "id": "sq1", "question": "pregunta de la sub-consulta", "focus": "lo que busca esta sub-consulta" },
    { "id": "sq2", "question": "pregunta de la sub-consulta", "focus": "lo que busca esta sub-consulta" }
  ],
  "combinationStrategy": "cte" | "join" | "union",
  "combinationHint": "instruccion de como combinar los resultados"
}

Si needsDecomposition=false, retorna subQuestions=[] y combinationStrategy="single".

Base de datos: ${dbType === "sqlserver" ? "SQL Server" : dbType === "oracle" ? "Oracle" : "MySQL"}.
Maximo de 4 sub-consultas.`
  };

  return prompts[language];
};

// ============== COMBINATION PROMPT ==============

const buildCombinationSystemPrompt = (
  language: "pt" | "en" | "es",
  dbType: DbType
): string => {
  const limitClause =
    dbType === "sqlserver"
      ? "TOP (100)"
      : dbType === "oracle"
        ? "FETCH FIRST 100 ROWS ONLY"
        : "LIMIT 100";

  const prompts: Record<"pt" | "en" | "es", string> = {
    pt: `Voce e um especialista em SQL. Recebera multiplas sub-queries SQL e deve combina-las em uma UNICA query final usando CTEs (WITH).

Regras:
- Cada sub-query vira um CTE nomeado (WITH sq1 AS (...), sq2 AS (...))
- O SELECT final combina os CTEs conforme a estrategia indicada
- Use ${limitClause} no SELECT final
- Nao use SELECT *
- Retorne APENAS o SQL final, sem markdown ou comentarios
- Proibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_`,

    en: `You are a SQL expert. You will receive multiple sub-queries and must combine them into a SINGLE final query using CTEs (WITH).

Rules:
- Each sub-query becomes a named CTE (WITH sq1 AS (...), sq2 AS (...))
- The final SELECT combines the CTEs according to the indicated strategy
- Use ${limitClause} in the final SELECT
- No SELECT *
- Return ONLY the final SQL, no markdown or comments
- Forbid DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_`,

    es: `Eres un experto en SQL. Recibiras multiples sub-queries SQL y debes combinarlas en una UNICA query final usando CTEs (WITH).

Reglas:
- Cada sub-query se convierte en un CTE nombrado (WITH sq1 AS (...), sq2 AS (...))
- El SELECT final combina los CTEs segun la estrategia indicada
- Usa ${limitClause} en el SELECT final
- No uses SELECT *
- Devuelve SOLO el SQL final, sin markdown ni comentarios
- Prohibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_`
  };

  return prompts[language];
};

// ============== DECOMPOSE QUESTION ==============

export const decomposeQuestion = async (
  question: string,
  context: ExpandedContext,
  language: "pt" | "en" | "es",
  dbType: DbType
): Promise<DecompositionPlan> => {
  const agentsCfg = await getAgentsConfig();
  const plannerCfg = agentsCfg.planner;

  if (plannerCfg?.enabled === false) {
    return {
      needsDecomposition: false,
      subQuestions: [],
      combinationStrategy: "single",
      combinationHint: "",
      originalQuestion: question
    };
  }

  const client = await getOpenAI();
  const model = plannerCfg?.model || await getSqlModelMini();
  const temperature = plannerCfg?.temperature ?? 0;
  const system = buildPlannerSystemPrompt(language, dbType);

  // Build context summary for the planner
  const tableNames = context.tables.map((t) => t.tableFullName).join(", ");
  const userPrompt = [
    `Tables: ${tableNames}`,
    `Joins: ${context.joins.length ? context.joins.join("; ") : "none"}`,
    `Question: ${question}`
  ].join("\n");

  logPrompt("planner", { system, user: userPrompt, meta: { model, language } });

  const completion = await client.chat.completions.create({
    model,
    temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPrompt }
    ]
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  logPrompt("planner-response", { user: raw, meta: { model, language } });

  if (shouldLogPrompts() && completion.usage) {
    console.info(`[tokens] planner (${model}) | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`);
  }

  try {
    const parsed = JSON.parse(raw) as {
      needsDecomposition?: boolean;
      subQuestions?: SubQuestion[];
      combinationStrategy?: string;
      combinationHint?: string;
    };

    const needsDecomposition = parsed.needsDecomposition === true;
    const subQuestions = (parsed.subQuestions ?? []).slice(0, 4);
    const strategy = (parsed.combinationStrategy ?? "single") as CombinationStrategy;

    if (!needsDecomposition || subQuestions.length < 2) {
      return {
        needsDecomposition: false,
        subQuestions: [],
        combinationStrategy: "single",
        combinationHint: "",
        originalQuestion: question,
        usage: completion.usage
      };
    }

    return {
      needsDecomposition: true,
      subQuestions,
      combinationStrategy: strategy === "single" ? "cte" : strategy,
      combinationHint: parsed.combinationHint ?? "",
      originalQuestion: question,
      usage: completion.usage
    };
  } catch {
    return {
      needsDecomposition: false,
      subQuestions: [],
      combinationStrategy: "single",
      combinationHint: "",
      originalQuestion: question,
      usage: completion.usage
    };
  }
};

// ============== COMBINE SUB-QUERIES ==============

export const combineSubQueries = async (
  plan: DecompositionPlan,
  subSqls: Array<{ id: string; sql: string; question: string }>,
  language: "pt" | "en" | "es",
  dbType: DbType,
  instructionText: string
): Promise<{ sql: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }> => {
  const client = await getOpenAI();
  const model = await getSqlModel();
  const agentsCfg = await getAgentsConfig();
  const temperature = agentsCfg.planner?.temperature ?? 0;

  const system = buildCombinationSystemPrompt(language, dbType);
  const systemWithInstructions = instructionText.trim()
    ? `${system}\n${language === "en" ? "Additional instructions" : language === "es" ? "Instrucciones adicionales" : "Instrucoes adicionais"}:\n${instructionText}`
    : system;

  const subQueryDetails = subSqls
    .map((sq) => `-- ${sq.id}: ${sq.question}\n${sq.sql}`)
    .join("\n\n");

  const strategyLabel: Record<CombinationStrategy, Record<"pt" | "en" | "es", string>> = {
    cte: {
      pt: "Combine usando CTEs (WITH ... AS) e um SELECT final que cruza os resultados",
      en: "Combine using CTEs (WITH ... AS) and a final SELECT that joins the results",
      es: "Combina usando CTEs (WITH ... AS) y un SELECT final que cruza los resultados"
    },
    join: {
      pt: "Combine usando JOINs entre os resultados das sub-queries",
      en: "Combine using JOINs between the sub-query results",
      es: "Combina usando JOINs entre los resultados de las sub-queries"
    },
    union: {
      pt: "Combine usando UNION ALL entre os resultados",
      en: "Combine using UNION ALL between the results",
      es: "Combina usando UNION ALL entre los resultados"
    },
    single: {
      pt: "Use a query diretamente",
      en: "Use the query directly",
      es: "Usa la query directamente"
    }
  };

  const questionLabel = language === "en" ? "Original question" : language === "es" ? "Pregunta original" : "Pergunta original";
  const strategyText = strategyLabel[plan.combinationStrategy]?.[language] ?? strategyLabel.cte[language];

  const userPrompt = [
    `${questionLabel}: ${plan.originalQuestion}`,
    `Strategy: ${strategyText}`,
    plan.combinationHint ? `Hint: ${plan.combinationHint}` : null,
    "",
    "Sub-queries:",
    subQueryDetails
  ].filter((l) => l !== null).join("\n");

  logPrompt("planner-combine", { system: systemWithInstructions, user: userPrompt, meta: { model, language } });

  const completion = await client.chat.completions.create({
    model,
    temperature,
    messages: [
      { role: "system", content: systemWithInstructions },
      { role: "user", content: userPrompt }
    ]
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  logPrompt("planner-combine-response", { user: raw, meta: { model, language } });

  if (shouldLogPrompts() && completion.usage) {
    console.info(`[tokens] planner-combine (${model}) | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`);
  }

  const sql = raw.trim().replace(/```sql/gi, "```").replace(/```/g, "").trim();
  return { sql, usage: completion.usage };
};
