import { getOpenAI } from "../../core/openai.js";
import { getAgentsConfig } from "../../core/agentConfig.js";
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

export const planTask = async (
  description: string,
  context: TaskPlannerContext,
  language: "pt" | "en" | "es" = "pt"
): Promise<TaskPlanResult> => {
  const agentsCfg = await getAgentsConfig();
  const cfg = agentsCfg.taskPlanner;

  if (cfg?.enabled === false) {
    return { subtasks: [] };
  }

  const client = await getOpenAI();
  const model = cfg?.model || "gpt-4o";
  const temperature = cfg?.temperature ?? 0;
  const system = buildSystemPrompt(language, context.availableTypes);

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

  const userPrompt = [
    `Task: ${description}`,
    contextParts.length ? `\nContext:\n${contextParts.join("\n\n")}` : ""
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
      const subtasks = (parsed.subtasks ?? []).slice(0, 10);
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
