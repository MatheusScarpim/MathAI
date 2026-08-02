import { getOpenAI, getSqlModel, getSqlModelMini } from "../core/openai.js";
import { getAgentsConfig } from "../core/agentConfig.js";
import type { DbType } from "../core/appConfig.js";
import type { ExpandedContext } from "./schema.js";
import {
  noDecomposition,
  parsePlannerResponse,
  type CombinationStrategy,
  type DecompositionPlan,
  type SubQuestion
} from "./plannerResponse.js";

export { parsePlannerResponse, noDecomposition };
export type { CombinationStrategy, DecompositionPlan, SubQuestion };

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
- Intervalos continuos de periodo (ex: "de 2017 a 2025", "de 2017 ate 2025", "entre 2017 e 2025", "2017-2025"). Isso pede a serie inteira, nao os dois extremos: resolva com UMA query, filtro de intervalo e GROUP BY ano. Decompor descartaria 2018 a 2024.

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
- Questions with "compared to", "versus", "difference between", "growth of X vs Y"
- Questions combining incompatible aggregations (e.g., total + average + ranking)

WHEN NOT TO DECOMPOSE (return needsDecomposition=false):
- Simple questions with a single filter
- Questions involving only normal JOINs between related tables
- Questions with simple GROUP BY
- Questions that can be solved with a single SELECT query
- Continuous period intervals (e.g., "from 2017 to 2025", "from 2017 through 2025", "between 2017 and 2025", "2017-2025"). These ask for the whole series, not the two endpoints: solve with ONE query, a range filter and GROUP BY year. Decomposing would discard 2018 through 2024.

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
- Preguntas con "comparado con", "versus", "diferencia entre", "crecimiento de X vs Y"
- Preguntas que combinan agregaciones incompatibles (ej: total + promedio + ranking)

CUANDO NO DESCOMPONER (retorna needsDecomposition=false):
- Preguntas simples con filtro unico
- Preguntas que solo involucran JOINs normales entre tablas relacionadas
- Preguntas con GROUP BY simple
- Preguntas que se pueden resolver con un solo SELECT
- Intervalos continuos de periodo (ej: "de 2017 a 2025", "desde 2017 hasta 2025", "entre 2017 y 2025", "2017-2025"). Piden la serie completa, no los dos extremos: resuelve con UNA sola query, filtro de rango y GROUP BY ano. Descomponer descartaria 2018 a 2024.

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
- Se as sub-queries cobrem periodos diferentes, o SELECT final DEVE expor a coluna de periodo (ano/mes) e agregar por ela, para que cada periodo apareca como sua propria linha
- Use ${limitClause} no SELECT final
- Aplique o limite por periodo, nunca um limite global que deixe um periodo consumir todas as linhas e ocultar os outros
- Nao use SELECT *
- Retorne APENAS o SQL final, sem markdown ou comentarios
- Proibido DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_`,

    en: `You are a SQL expert. You will receive multiple sub-queries and must combine them into a SINGLE final query using CTEs (WITH).

Rules:
- Each sub-query becomes a named CTE (WITH sq1 AS (...), sq2 AS (...))
- The final SELECT combines the CTEs according to the indicated strategy
- If the sub-queries cover different periods, the final SELECT MUST expose the period column (year/month) and aggregate by it, so each period shows up as its own row
- Use ${limitClause} in the final SELECT
- Apply the limit per period, never a global limit that lets one period consume every row and hide the others
- No SELECT *
- Return ONLY the final SQL, no markdown or comments
- Forbid DELETE/UPDATE/INSERT/MERGE/DROP/TRUNCATE/ALTER/EXEC/xp_`,

    es: `Eres un experto en SQL. Recibiras multiples sub-queries SQL y debes combinarlas en una UNICA query final usando CTEs (WITH).

Reglas:
- Cada sub-query se convierte en un CTE nombrado (WITH sq1 AS (...), sq2 AS (...))
- El SELECT final combina los CTEs segun la estrategia indicada
- Si las sub-queries cubren periodos diferentes, el SELECT final DEBE exponer la columna de periodo (ano/mes) y agregar por ella, para que cada periodo aparezca como su propia fila
- Usa ${limitClause} en el SELECT final
- Aplica el limite por periodo, nunca un limite global que permita a un periodo consumir todas las filas y ocultar los demas
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
    return noDecomposition(question);
  }

  const client = await getOpenAI();
  const fallbackModel = await getSqlModelMini();
  const model = plannerCfg?.model || fallbackModel;
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

  const ask = (target: string) =>
    client.chat.completions.create({
      model: target,
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt }
      ]
    });

  // A misconfigured `planner.model` used to throw straight past this function
  // into an empty catch in the pipeline, so the only symptom of a dead planner
  // was that decomposition silently never happened. Fall back to the model the
  // SQL agent already uses, and say so out loud.
  let completion: Awaited<ReturnType<typeof ask>>;
  let usedModel = model;
  try {
    completion = await ask(model);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (model === fallbackModel) {
      console.warn(`[planner-failed] modelo=${model} erro=${message} - seguindo sem decomposicao`);
      return noDecomposition(question);
    }
    console.warn(`[planner-model-fallback] modelo=${model} erro=${message} - tentando ${fallbackModel}`);
    try {
      completion = await ask(fallbackModel);
      usedModel = fallbackModel;
    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      console.warn(
        `[planner-failed] modelo=${fallbackModel} erro=${fallbackMessage} - seguindo sem decomposicao`
      );
      return noDecomposition(question);
    }
  }

  const raw = completion.choices[0]?.message?.content ?? "{}";
  logPrompt("planner-response", { user: raw, meta: { model: usedModel, language } });

  if (shouldLogPrompts() && completion.usage) {
    console.info(`[tokens] planner (${usedModel}) | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`);
  }

  const parsed = parsePlannerResponse(raw);

  if (!parsed.decompose) {
    // Only a malformed response is a defect; "needsDecomposition=false" is the
    // planner doing its job on a simple question, and stays at debug level.
    const isRefusal = parsed.reason.startsWith("planner respondeu");
    const line = `[planner-no-decomposition] modelo=${usedModel} motivo=${parsed.reason}`;
    if (isRefusal) logPrompt("planner-no-decomposition", { meta: { reason: parsed.reason } });
    else console.warn(line);
    return noDecomposition(question, completion.usage);
  }

  return {
    needsDecomposition: true,
    subQuestions: parsed.subQuestions,
    combinationStrategy: parsed.strategy,
    combinationHint: parsed.hint,
    originalQuestion: question,
    usage: completion.usage
  };
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
