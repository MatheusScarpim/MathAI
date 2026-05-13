import { getOpenAI } from "../../core/openai.js";
import { getAgentsConfig } from "../../core/agentConfig.js";
import { withRetry } from "./withRetry.js";

// ============== TYPES ==============

export type ExecutedSubtask = {
  id: string;
  type: "trello" | "github" | "api" | "custom";
  description: string;
  status: "completed" | "failed" | "skipped";
  result?: unknown;
  error?: string;
};

export type ReportResult = {
  report: string;
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

const buildSystemPrompt = (language: "pt" | "en" | "es"): string => {
  const prompts: Record<"pt" | "en" | "es", string> = {
    pt: `Voce e um reporter de tarefas. Sua funcao e gerar um resumo conciso em markdown do progresso de execucao de uma tarefa.

FORMATO DO RELATORIO:
- Comece com um titulo resumindo o resultado geral
- Liste subtarefas concluidas com check marks
- Liste subtarefas falhadas com X marks e motivo do erro
- Inclua links relevantes (PRs, cards do Trello) quando disponveis nos resultados
- Finalize com um resumo de 1-2 frases

Responda APENAS com o markdown do relatorio, sem blocos de codigo.`,

    en: `You are a task reporter. Your role is to generate a concise markdown summary of task execution progress.

REPORT FORMAT:
- Start with a title summarizing the overall result
- List completed subtasks with check marks
- List failed subtasks with X marks and error reason
- Include relevant links (PRs, Trello cards) when available in results
- End with a 1-2 sentence summary

Respond ONLY with the report markdown, no code blocks.`,

    es: `Eres un reportero de tareas. Tu funcion es generar un resumen conciso en markdown del progreso de ejecucion de una tarea.

FORMATO DEL REPORTE:
- Comienza con un titulo resumiendo el resultado general
- Lista subtareas completadas con check marks
- Lista subtareas fallidas con X marks y razon del error
- Incluye links relevantes (PRs, cards de Trello) cuando esten disponibles en los resultados
- Finaliza con un resumen de 1-2 frases

Responde SOLO con el markdown del reporte, sin bloques de codigo.`
  };

  return prompts[language];
};

// ============== GENERATE REPORT ==============

export const generateReport = async (
  taskDescription: string,
  executedSubtasks: ExecutedSubtask[],
  language: "pt" | "en" | "es" = "pt"
): Promise<ReportResult> => {
  const agentsCfg = await getAgentsConfig();
  const cfg = agentsCfg.taskReporter;

  const client = await getOpenAI();
  const model = cfg?.model || "gpt-4o-mini";
  const temperature = cfg?.temperature ?? 0.2;
  const system = buildSystemPrompt(language);

  const subtasksSummary = executedSubtasks
    .map((st) => {
      const statusIcon = st.status === "completed" ? "OK" : st.status === "failed" ? "FAILED" : "SKIPPED";
      const resultStr = st.result ? ` | Result: ${JSON.stringify(st.result)}` : "";
      const errorStr = st.error ? ` | Error: ${st.error}` : "";
      return `[${statusIcon}] ${st.id} (${st.type}): ${st.description}${resultStr}${errorStr}`;
    })
    .join("\n");

  const completed = executedSubtasks.filter((st) => st.status === "completed").length;
  const failed = executedSubtasks.filter((st) => st.status === "failed").length;
  const total = executedSubtasks.length;

  const userPrompt = [
    `Task: ${taskDescription}`,
    `\nProgress: ${completed}/${total} completed, ${failed} failed`,
    `\nSubtasks:\n${subtasksSummary}`
  ].join("\n");

  logPrompt("reporter", { system, user: userPrompt, meta: { model, language } });

  return withRetry<ReportResult>(
    async () => {
      const completion = await client.chat.completions.create({
        model,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt }
        ]
      });

      const raw = completion.choices[0]?.message?.content ?? "";
      logPrompt("reporter-response", { user: raw, meta: { model, language } });

      if (shouldLogPrompts() && completion.usage) {
        console.info(
          `[tokens] reporter (${model}) | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`
        );
      }

      const report = raw.trim();
      if (!report) throw new Error("reporter returned empty content");
      return { report, usage: completion.usage };
    },
    {
      label: "reporter",
      attempts: 3,
      baseDelayMs: 500,
      fallback: () => ({
        // Fallback deterministico: monta resumo a partir dos dados conhecidos.
        report: buildDeterministicReport(taskDescription, executedSubtasks)
      })
    }
  );
};

const buildDeterministicReport = (
  taskDescription: string,
  executedSubtasks: ExecutedSubtask[]
): string => {
  const completed = executedSubtasks.filter(st => st.status === "completed").length;
  const failed = executedSubtasks.filter(st => st.status === "failed").length;
  const total = executedSubtasks.length;

  const lines: string[] = [];
  lines.push(`# ${taskDescription}`);
  lines.push("");
  lines.push(`**${completed}/${total} subtarefas concluidas** (${failed} falhas)`);
  lines.push("");
  for (const st of executedSubtasks) {
    const icon = st.status === "completed" ? "✅" : st.status === "failed" ? "❌" : "⏭️";
    const err = st.error ? ` — ${st.error}` : "";
    lines.push(`- ${icon} **${st.id}** (${st.type}): ${st.description}${err}`);
  }
  lines.push("");
  lines.push("_(resumo gerado automaticamente — reporter LLM indisponivel)_");
  return lines.join("\n");
};
