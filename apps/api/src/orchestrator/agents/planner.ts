import { getClient } from "../../core/openai.js";
import { getAgentsConfig } from "../../core/agentConfig.js";
import { selectRoute } from "../routing/router.js";
import { withRetry } from "./withRetry.js";

// ============== TYPES ==============

export type PlannedSubTask = {
  id: string;
  type: "trello" | "github" | "api" | "custom";
  description: string;
  priority: number;
  dependsOn: string[];
  repo?: string;
};

export type TaskPlannerContext = {
  repos?: { name: string; owner: string; repo: string; tree?: string }[];
  repoTree?: string;
  trelloBoardLists?: { id: string; name: string }[];
  existingCards?: { name: string }[];
  /** Lista de tipos de subtask disponiveis (baseado nas integracoes configuradas) */
  availableTypes?: string[];
};

/**
 * Snapshot da tentativa anterior, alimentado pelo pipeline quando dispara replan.
 * Permite o planner ajustar a estrategia sem repetir o que ja funcionou.
 */
export type PreviousAttempt = {
  /** IDs de subtasks que completaram com sucesso — reaproveite no novo plano sem mudar. */
  succeededSubtaskIds: string[];
  /** Subtasks que falharam ou completaram mal — reformule/divida usando os errors abaixo. */
  failedSubtasks: Array<{
    id: string;
    type: "trello" | "github" | "api" | "custom";
    description: string;
    /** Resumo do que deu errado (erro do agent, comments do reviewer, verdict do verifier). */
    errorSummary: string;
    /** Provider/model que falhou — evite (sem hard skip; eh soft bias). */
    provider?: string;
    repo?: string;
  }>;
  /** Providers a evitar (markProviderDown ja cuida de health; isto eh bias semantico). */
  downedProviders?: string[];
};

export type TaskPlanResult = {
  subtasks: PlannedSubTask[];
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

const TYPE_LABELS: Record<string, { pt: string; en: string; es: string }> = {
  trello: {
    pt: "gerenciamento de projeto (criar cards, checklists, mover cards)",
    en: "project management (create cards, checklists, move cards)",
    es: "gestion de proyecto (crear cards, checklists, mover cards)"
  },
  github: {
    pt: "alteracoes de codigo (criar/editar arquivos, commits, PRs)",
    en: "code changes (create/edit files, commits, PRs)",
    es: "cambios de codigo (crear/editar archivos, commits, PRs)"
  },
  api: {
    pt: "chamadas HTTP externas",
    en: "external HTTP calls",
    es: "llamadas HTTP externas"
  },
  custom: {
    pt: "outras acoes",
    en: "other actions",
    es: "otras acciones"
  }
};

const typeListStr = (types: string[], lang: "pt" | "en" | "es"): string =>
  types
    .filter(t => TYPE_LABELS[t] !== undefined)
    .map(t => `  - "${t}" = ${TYPE_LABELS[t]![lang]}`)
    .join("\n");

const buildSystemPrompt = (language: "pt" | "en" | "es", availableTypes?: string[]): string => {
  const types = availableTypes?.length ? availableTypes : ["custom"];
  const tlist = typeListStr(types, language);

  const prompts: Record<"pt" | "en" | "es", string> = {
    pt: `Voce e um planejador de tarefas. Sua funcao e decompor pedidos do usuario em subtarefas executaveis.

Cada subtarefa deve ter:
- "id": identificador unico (ex: "st1", "st2")
- "type": tipo da subtarefa (USE APENAS OS TIPOS LISTADOS ABAIXO):
${tlist}
- "description": descricao clara do que fazer
- "priority": 1 (mais alta) a 5 (mais baixa)
- "dependsOn": array de IDs de subtarefas que devem ser concluidas antes
- "repo": (OBRIGATORIO para type "github") nome do repositorio onde a mudanca deve ser feita

REGRAS:
- Maximo de 10 subtarefas
- Subtarefas devem ser granulares o suficiente para execucao automatica
- Ordene logicamente as dependencias
- Para subtarefas "github", SEMPRE especifique o campo "repo" com o nome do repositorio
- Se ha multiplos repos, distribua as subtarefas no repo correto
- USE SOMENTE os tipos de subtask listados acima
- Se o tipo desejado nao estiver disponivel, use "custom"
- IMPORTANTE: Para subtasks "github", NAO crie subtasks separadas para "criar pasta", "criar arquivo vazio" ou "fazer commit". Pastas vazias nao existem em git. Sempre agrupe operacoes de filesystem relacionadas em uma unica subtask github.
- IMPORTANTE: Para subtasks "github" no MESMO repositorio, prefira UMA UNICA subtask que descreva o conjunto completo de mudancas relacionadas. Todas as subtasks github do mesmo repo serao consolidadas em UM unico Pull Request. Nao fragmente uma feature em multiplas subtasks pequenas (ex: "criar HTML", "adicionar CSS", "adicionar JS" -> fazer uma so).

ATERRAMENTO (anti-alucinacao — CRITICO):
- Para subtasks "github", referencie SOMENTE caminhos de arquivos/pastas que aparecem na "Repository structure"/"Available repositories" fornecida no contexto.
- NUNCA invente caminhos convencionais de framework (ex: "src/views/", "router/index.ts", "AdminLayout.vue", "KioskView.vue") sem confirmar que existem no tree. Estruturas variam entre projetos (pages/ vs views/, roteamento inline em main.ts vs router/index.ts).
- Se nao souber o arquivo exato, descreva pela INTENCAO (ex: "adicionar link no componente de layout/navegacao principal") e instrua o agente a LOCALIZAR o arquivo certo no repo — nao prescreva um path inventado. Um path errado faz o agente retornar zero mudancas.
- Se o tree estiver truncado, NAO assuma que o que nao apareceu inexiste.

RESPONDA SEMPRE em JSON valido:
{
  "subtasks": [
    { "id": "st1", "type": "custom", "description": "...", "priority": 1, "dependsOn": [] }
  ]
}`,

    en: `You are a task planner. Your role is to decompose user requests into executable subtasks.

Each subtask must have:
- "id": unique identifier (e.g., "st1", "st2")
- "type": subtask type (USE ONLY THE TYPES LISTED BELOW):
${tlist}
- "description": clear description of what to do
- "priority": 1 (highest) to 5 (lowest)
- "dependsOn": array of subtask IDs that must complete first
- "repo": (REQUIRED for type "github") repository name where the change should be made

RULES:
- Maximum 10 subtasks
- Subtasks must be granular enough for automated execution
- Order dependencies logically
- For "github" subtasks, ALWAYS specify the "repo" field with the repository name
- If there are multiple repos, distribute subtasks to the correct repo
- USE ONLY the subtask types listed above
- If the desired type is not available, use "custom"
- IMPORTANT: For "github" subtasks, do NOT create separate subtasks for "create folder", "create empty file" or "make commit". Empty folders do not exist in git. Always group related filesystem operations into a single github subtask.
- IMPORTANT: For "github" subtasks in the SAME repository, prefer ONE SINGLE subtask describing the full set of related changes. All github subtasks in the same repo will be consolidated into ONE Pull Request. Do not fragment a feature into multiple small subtasks (e.g., "create HTML", "add CSS", "add JS" -> make it one).

GROUNDING (anti-hallucination — CRITICAL):
- For "github" subtasks, reference ONLY file/folder paths that appear in the provided "Repository structure"/"Available repositories" context.
- NEVER invent conventional framework paths (e.g., "src/views/", "router/index.ts", "AdminLayout.vue", "KioskView.vue") without confirming they exist in the tree. Structures vary between projects (pages/ vs views/, inline routing in main.ts vs router/index.ts).
- If you don't know the exact file, describe by INTENT (e.g., "add a nav link in the main layout/navigation component") and instruct the agent to LOCATE the right file in the repo — do not prescribe an invented path. A wrong path makes the agent return zero changes.
- If the tree is truncated, do NOT assume what didn't appear doesn't exist.

ALWAYS respond in valid JSON:
{
  "subtasks": [
    { "id": "st1", "type": "custom", "description": "...", "priority": 1, "dependsOn": [] }
  ]
}`,

    es: `Eres un planificador de tareas. Tu funcion es descomponer las solicitudes del usuario en subtareas ejecutables.

Cada subtarea debe tener:
- "id": identificador unico (ej: "st1", "st2")
- "type": tipo de subtarea (USA SOLO LOS TIPOS LISTADOS ABAJO):
${tlist}
- "description": descripcion clara de que hacer
- "priority": 1 (mas alta) a 5 (mas baja)
- "dependsOn": array de IDs de subtareas que deben completarse antes
- "repo": (OBLIGATORIO para type "github") nombre del repositorio donde hacer el cambio

REGLAS:
- Maximo 10 subtareas
- Las subtareas deben ser lo suficientemente granulares para ejecucion automatica
- Ordena las dependencias logicamente
- Para subtareas "github", SIEMPRE especifica el campo "repo" con el nombre del repositorio
- Si hay multiples repos, distribuye las subtareas al repo correcto
- USA SOLO los tipos de subtarea listados arriba
- Si el tipo deseado no esta disponible, usa "custom"
- IMPORTANTE: Para subtareas "github", NO crees subtareas separadas para "crear carpeta", "crear archivo vacio" o "hacer commit". Las carpetas vacias no existen en git. Siempre agrupa operaciones de filesystem relacionadas en una sola subtarea github.
- IMPORTANTE: Para subtareas "github" en el MISMO repositorio, prefiere UNA SOLA subtarea que describa el conjunto completo de cambios relacionados. Todas las subtareas github del mismo repo se consolidaran en UN solo Pull Request. No fragmentes una feature en multiples subtareas pequeñas.

ATERRIZAJE (anti-alucinacion — CRITICO):
- Para subtareas "github", referencia SOLO rutas de archivos/carpetas que aparecen en la "Repository structure"/"Available repositories" del contexto.
- NUNCA inventes rutas convencionales de framework (ej: "src/views/", "router/index.ts", "AdminLayout.vue", "KioskView.vue") sin confirmar que existen en el tree. Las estructuras varian entre proyectos (pages/ vs views/, ruteo inline en main.ts vs router/index.ts).
- Si no sabes el archivo exacto, describe por INTENCION (ej: "agregar link en el componente de layout/navegacion principal") e instruye al agente a LOCALIZAR el archivo correcto — no prescribas una ruta inventada. Una ruta incorrecta hace que el agente retorne cero cambios.
- Si el tree esta truncado, NO asumas que lo que no aparecio no existe.

RESPONDE SIEMPRE en JSON valido:
{
  "subtasks": [
    { "id": "st1", "type": "custom", "description": "...", "priority": 1, "dependsOn": [] }
  ]
}`
  };

  return prompts[language];
};

// ============== PLAN TASK ==============

/**
 * Formata um bloco [PREVIOUS ATTEMPT] que entra no user prompt quando o pipeline
 * dispara replan. O planner deve usar isto pra: (a) reaproveitar IDs que ja
 * funcionaram, (b) reformular os que falharam, (c) evitar providers semanticamente
 * ruins. NUNCA fazemos hard-pin no plano novo — eh apenas guidance.
 */
const formatPreviousAttempt = (prev: PreviousAttempt, language: "pt" | "en" | "es"): string => {
  const lines: string[] = [];
  const header = language === "en"
    ? "[PREVIOUS ATTEMPT — replan triggered]"
    : language === "es"
      ? "[INTENTO ANTERIOR — replan disparado]"
      : "[TENTATIVA ANTERIOR — replan disparado]";
  lines.push(header);

  if (prev.succeededSubtaskIds.length > 0) {
    const succLabel = language === "en"
      ? "Already-succeeded subtask IDs (REUSE these IDs unchanged):"
      : language === "es"
        ? "IDs de subtareas ya exitosas (REUTILIZA estos IDs sin cambios):"
        : "IDs de subtarefas ja completadas (REUTILIZE estes IDs sem mudar):";
    lines.push(succLabel);
    lines.push(`- ${prev.succeededSubtaskIds.join(", ")}`);
  }

  if (prev.failedSubtasks.length > 0) {
    const failLabel = language === "en"
      ? "Failed/poor subtasks (REPLACE or SPLIT using the error guidance):"
      : language === "es"
        ? "Subtareas fallidas o malas (REEMPLAZA o DIVIDE usando los errores):"
        : "Subtarefas que falharam ou completaram mal (SUBSTITUA ou DIVIDA usando os erros):";
    lines.push(failLabel);
    for (const f of prev.failedSubtasks) {
      lines.push(`- id=${f.id} type=${f.type}${f.repo ? ` repo=${f.repo}` : ""}${f.provider ? ` provider=${f.provider}` : ""}`);
      lines.push(`  desc: ${f.description.slice(0, 300)}`);
      lines.push(`  erro: ${f.errorSummary.slice(0, 500)}`);
    }
  }

  if (prev.downedProviders && prev.downedProviders.length > 0) {
    const dpLabel = language === "en"
      ? "Providers that misbehaved last attempt (avoid if possible; soft bias):"
      : language === "es"
        ? "Providers que fallaron antes (evita si puedes; soft bias):"
        : "Providers que falharam na tentativa anterior (evite quando possivel; soft bias):";
    lines.push(dpLabel);
    lines.push(`- ${prev.downedProviders.join(", ")}`);
  }

  const instr = language === "en"
    ? "RULES: keep succeeded IDs verbatim. For each failed subtask, either rewrite the description with more concrete paths/steps, or split it into 2+ smaller subtasks. Do NOT just copy the failed description verbatim."
    : language === "es"
      ? "REGLAS: manten los IDs exitosos. Para cada subtarea fallida, reescribe con paths/pasos mas concretos o divide en 2+ subtareas menores. NO copies la descripcion fallida tal cual."
      : "REGRAS: mantenha os IDs que ja completaram intactos. Para cada subtarefa que falhou, reescreva com paths/passos mais concretos ou divida em 2+ subtarefas menores. NAO copie a descricao falhada como esta.";
  lines.push(instr);
  return lines.join("\n");
};

const VALID_SUBTASK_TYPES = new Set(["trello", "github", "api", "custom"]);

/**
 * Normaliza o plano cru do LLM antes de devolver ao pipeline. Dois problemas
 * recorrentes que derrubavam a task inteira:
 *  1. Tipo alucinado (ex: "edit", "write", "file") — o dispatcher lanca
 *     "Unknown subtask type" e marca a task como failed. Coagimos para um tipo
 *     valido: "github" quando ha repo referenciado e github esta disponivel,
 *     senao "custom" (sempre aceito downstream).
 *  2. IDs duplicados (o planner as vezes emite dois "st1"). Mantemos o primeiro
 *     e renomeamos os seguintes pra nao colidir na agregacao/dependsOn.
 */
const normalizeSubtasks = (
  subtasks: PlannedSubTask[],
  availableTypes?: string[]
): PlannedSubTask[] => {
  const available = new Set(availableTypes?.length ? availableTypes : ["custom"]);
  const fallbackType: PlannedSubTask["type"] = available.has("custom")
    ? "custom"
    : ((availableTypes?.[0] as PlannedSubTask["type"]) ?? "custom");
  const seenIds = new Set<string>();
  const result: PlannedSubTask[] = [];

  for (const st of subtasks) {
    if (!st || typeof st !== "object") continue;

    let type = st.type;
    if (!VALID_SUBTASK_TYPES.has(type) || !available.has(type)) {
      const coerced: PlannedSubTask["type"] =
        st.repo && available.has("github") ? "github" : fallbackType;
      console.warn(
        `[planner] coercing invalid/unavailable subtask type "${st.type}" (id=${st.id}) -> "${coerced}"`
      );
      type = coerced;
    }

    let id = st.id || `st${result.length + 1}`;
    if (seenIds.has(id)) {
      let n = 2;
      while (seenIds.has(`${id}_${n}`)) n++;
      const renamed = `${id}_${n}`;
      console.warn(`[planner] duplicate subtask id "${id}" -> "${renamed}"`);
      id = renamed;
    }
    seenIds.add(id);

    result.push({ ...st, id, type });
  }

  return result;
};

export const planTask = async (
  description: string,
  context: TaskPlannerContext,
  language: "pt" | "en" | "es" = "pt",
  /** Bloco de project context (stack, convencoes) ja formatado. Opcional. */
  projectContextText?: string,
  /** Quando setado, planner roda em modo "replan" e usa snapshot da tentativa anterior. */
  previousAttempt?: PreviousAttempt
): Promise<TaskPlanResult> => {
  const agentsCfg = await getAgentsConfig();
  const cfg = agentsCfg.taskPlanner;

  if (cfg?.enabled === false) {
    return { subtasks: [] };
  }

  // Router chooses provider + model; agentsCfg.taskPlanner.model is the
  // legacy fallback used inside the router when no rule matches.
  const route = await selectRoute("taskPlanner", { description });
  const client = getClient(route.provider);
  const model = route.model || cfg?.model || "gpt-4o";
  const temperature = cfg?.temperature ?? 0;
  const baseSystem = buildSystemPrompt(language, context.availableTypes);
  const system = projectContextText ? `${baseSystem}\n\n${projectContextText}` : baseSystem;

  const contextParts: string[] = [];
  if (context.repos?.length) {
    const repoDescriptions = context.repos.map(r => {
      const header = `Repository: ${r.name} (${r.owner}/${r.repo})`;
      return r.tree ? `${header}\n${r.tree}` : header;
    }).join("\n\n");
    contextParts.push(`Available repositories:\n${repoDescriptions}`);
  } else if (context.repoTree) {
    contextParts.push(`Repository structure:\n${context.repoTree}`);
  }
  if (context.trelloBoardLists?.length) {
    contextParts.push(
      `Trello board lists:\n${context.trelloBoardLists.map((l) => `- ${l.name} (${l.id})`).join("\n")}`
    );
  }
  if (context.existingCards?.length) {
    contextParts.push(
      `Existing cards:\n${context.existingCards.map((c) => `- ${c.name}`).join("\n")}`
    );
  }

  const previousAttemptBlock = previousAttempt
    ? `\n${formatPreviousAttempt(previousAttempt, language)}`
    : "";

  const userPrompt = [
    `Task: ${description}`,
    contextParts.length ? `\nContext:\n${contextParts.join("\n\n")}` : "",
    previousAttemptBlock
  ]
    .filter(Boolean)
    .join("\n");

  logPrompt("taskPlanner", { system, user: userPrompt, meta: { model, language } });

  return withRetry<TaskPlanResult>(
    async () => {
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
      logPrompt("taskPlanner-response", { user: raw, meta: { model, language } });

      if (shouldLogPrompts() && completion.usage) {
        console.info(
          `[tokens] taskPlanner (${model}) | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`
        );
      }

      const parsed = JSON.parse(raw) as { subtasks?: PlannedSubTask[] };
      const subtasks = normalizeSubtasks(
        (parsed.subtasks ?? []).slice(0, 10),
        context.availableTypes
      );
      if (subtasks.length === 0) {
        // Trata vazio como falha pra acionar retry
        throw new Error("planner returned empty subtask list");
      }
      return { subtasks, usage: completion.usage };
    },
    {
      label: "taskPlanner",
      attempts: 3,
      baseDelayMs: 500,
      fallback: () => ({
        // Fallback degradado: 1 subtask custom contendo a descricao original.
        // Pipeline ainda roda, gera reporter, e o usuario ve a falha do planner como degradacao.
        subtasks: [
          {
            id: "st1",
            type: "custom",
            description,
            priority: 1,
            dependsOn: []
          }
        ]
      })
    }
  );
};
