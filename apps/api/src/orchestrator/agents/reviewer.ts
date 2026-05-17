import { getClient } from "../../core/openai.js";
import { getAgentsConfig } from "../../core/agentConfig.js";
import { selectRoute } from "../routing/router.js";
import type { CodeChange } from "./code.js";
import { withRetry } from "./withRetry.js";

// ============== TYPES ==============

export type ReviewComment = {
  file: string;
  line?: number;
  severity: "error" | "warning" | "info";
  message: string;
};

export type ReviewResult = {
  approved: boolean;
  comments: ReviewComment[];
  suggestion?: string;
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
    pt: `Voce e um revisor de codigo. Sua funcao e analisar mudancas propostas e verificar qualidade, seguranca e corretude.

VERIFIQUE:
- Bugs logicos ou erros de sintaxe
- Vulnerabilidades de seguranca (XSS, injection, exposicao de dados)
- Aderencia aos padroes do projeto
- Imports faltando ou incorretos
- Tratamento de erros adequado
- Performance (loops desnecessarios, queries N+1)

RESPONDA em JSON valido:
{
  "approved": true/false,
  "comments": [
    { "file": "src/example.ts", "line": 42, "severity": "error", "message": "Descricao do problema" }
  ],
  "suggestion": "Sugestao geral opcional para melhoria"
}

Se nao houver problemas, retorne approved=true e comments=[].
Severidades: "error" (bloqueia aprovacao), "warning" (recomendacao forte), "info" (observacao).
Retorne approved=false se houver qualquer comment com severity "error".`,

    en: `You are a code reviewer. Your role is to analyze proposed changes and verify quality, security, and correctness.

CHECK FOR:
- Logic bugs or syntax errors
- Security vulnerabilities (XSS, injection, data exposure)
- Adherence to project patterns
- Missing or incorrect imports
- Proper error handling
- Performance (unnecessary loops, N+1 queries)

RESPOND in valid JSON:
{
  "approved": true/false,
  "comments": [
    { "file": "src/example.ts", "line": 42, "severity": "error", "message": "Problem description" }
  ],
  "suggestion": "Optional general improvement suggestion"
}

If no issues found, return approved=true and comments=[].
Severities: "error" (blocks approval), "warning" (strong recommendation), "info" (observation).
Return approved=false if any comment has severity "error".`,

    es: `Eres un revisor de codigo. Tu funcion es analizar cambios propuestos y verificar calidad, seguridad y correccion.

VERIFICA:
- Bugs logicos o errores de sintaxis
- Vulnerabilidades de seguridad (XSS, injection, exposicion de datos)
- Adherencia a los patrones del proyecto
- Imports faltantes o incorrectos
- Manejo de errores adecuado
- Performance (loops innecesarios, queries N+1)

RESPONDE en JSON valido:
{
  "approved": true/false,
  "comments": [
    { "file": "src/example.ts", "line": 42, "severity": "error", "message": "Descripcion del problema" }
  ],
  "suggestion": "Sugerencia general opcional para mejora"
}

Si no hay problemas, retorna approved=true y comments=[].
Severidades: "error" (bloquea aprobacion), "warning" (recomendacion fuerte), "info" (observacion).
Retorna approved=false si hay algun comment con severity "error".`
  };

  return prompts[language];
};

// ============== REVIEW CODE CHANGES ==============

export const reviewCodeChanges = async (
  description: string,
  changes: CodeChange[],
  originalFiles: { path: string; content: string }[],
  language: "pt" | "en" | "es" = "pt",
  /** Bloco de project context (stack, convencoes) ja formatado. Opcional. */
  projectContextText?: string
): Promise<ReviewResult> => {
  const agentsCfg = await getAgentsConfig();
  const cfg = agentsCfg.taskReviewer;

  if (cfg?.enabled === false) {
    return { approved: true, comments: [] };
  }

  const route = await selectRoute("taskReviewer", { description });
  const client = getClient(route.provider);
  const model = route.model || cfg?.model || "gpt-4o";
  const temperature = cfg?.temperature ?? 0;
  const baseSystem = buildSystemPrompt(language);
  const system = projectContextText ? `${baseSystem}\n\n${projectContextText}` : baseSystem;

  const changesSections = changes
    .map((c) => {
      if (c.action === "delete") return `[DELETE] ${c.file}`;
      return `[${c.action.toUpperCase()}] ${c.file}\n${c.content ?? ""}`;
    })
    .join("\n\n");

  const originalSections = originalFiles
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join("\n\n");

  const userPrompt = [
    `Task description: ${description}`,
    `\nProposed changes:\n${changesSections}`,
    originalFiles.length ? `\nOriginal files:\n${originalSections}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  logPrompt("reviewer", { system, user: userPrompt, meta: { model, language } });

  return withRetry<ReviewResult>(
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
      logPrompt("reviewer-response", { user: raw, meta: { model, language } });

      if (shouldLogPrompts() && completion.usage) {
        console.info(
          `[tokens] reviewer (${model}) | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`
        );
      }

      const parsed = JSON.parse(raw) as {
        approved?: boolean;
        comments?: ReviewComment[];
        suggestion?: string;
      };
      return {
        approved: parsed.approved ?? true,
        comments: parsed.comments ?? [],
        suggestion: parsed.suggestion,
        usage: completion.usage
      };
    },
    {
      label: "reviewer",
      attempts: 3,
      baseDelayMs: 500,
      fallback: () => ({
        // Fallback: aprovar com warning explicito. Nao bloqueia o pipeline.
        approved: true,
        comments: [
          {
            file: "<reviewer>",
            severity: "warning",
            message: "Reviewer indisponivel — prosseguindo sem revisao automatica."
          }
        ]
      })
    }
  );
};
