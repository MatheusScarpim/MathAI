import type { HttpRequestPlan } from "@auraia/shared";
import { getOpenAI } from "../core/openai.js";
import { getAgentsConfig } from "../core/agentConfig.js";
import type { ExpandedEndpointContext } from "./endpoint.js";

/* ── Types ───────────────────────────────────────────────── */

type FewShotExample = {
  question: string;
  httpRequest: string;
  tags: string[];
  similarity: number;
};

export type GenerateHttpResult = {
  plan: HttpRequestPlan;
  escalated?: boolean;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

/* ── Helpers ─────────────────────────────────────────────── */

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

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

const stripJson = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.includes("```")) return trimmed;
  return trimmed.replace(/```json/gi, "```").replace(/```/g, "").trim();
};

/* ── Few-Shot ────────────────────────────────────────────── */

const buildFewShotSection = (
  examples: FewShotExample[],
  language: "pt" | "en" | "es"
): string | null => {
  if (!examples.length) return null;
  const label =
    language === "en" ? "Examples:" : language === "es" ? "Ejemplos:" : "Exemplos:";
  const exLabel = language === "en" ? "Ex" : language === "es" ? "Ej" : "Ex";

  const lines = examples.map((item, index) => {
    const question = truncate(item.question, 300);
    const request = truncate(item.httpRequest, 900);
    return [`${exLabel} ${index + 1}`, `Q: ${question}`, `Request: ${request}`]
      .join("\n");
  });

  return [label, ...lines].join("\n\n");
};

/* ── Prompt ──────────────────────────────────────────────── */

export const buildHttpPrompt = (
  question: string,
  context: ExpandedEndpointContext,
  historySnippet: string | null,
  fewShotExamples: FewShotExample[],
  errorContext: string | null,
  previousRequest: string | null,
  language: "pt" | "en" | "es",
  baseUrl: string
): string => {
  const endpointDetails = context.endpoints
    .map((ep) => {
      const params = ep.parameters
        .map(
          (p) =>
            `${p.name}(${p.in},${p.type}${p.required ? ",required" : ""})`
        )
        .join(", ");
      const parts = [
        `${ep.method} ${ep.path}`,
        ep.summary ? `Summary: ${ep.summary}` : null,
        params ? `Params: ${params}` : null,
        ep.requestBodySchema
          ? `Body: ${ep.requestBodySchema.slice(0, 500)}`
          : null,
        ep.responseSchema
          ? `Response: ${ep.responseSchema.slice(0, 500)}`
          : null,
        ep.tags.length ? `Tags: ${ep.tags.join(", ")}` : null
      ]
        .filter(Boolean)
        .join(" | ");
      return parts;
    })
    .join("\n\n");

  const relatedDetails = context.relatedEndpoints.length
    ? context.relatedEndpoints
        .map((ep) => `${ep.method} ${ep.path}: ${ep.summary ?? ""}`)
        .join("\n")
    : null;

  const fewShotSection = buildFewShotSection(fewShotExamples, language);

  const labels =
    language === "en"
      ? {
          history: "History:",
          endpoints: "Endpoints:",
          related: "Related Endpoints (for chaining):",
          error: "Error:",
          previous: "Previous Request:",
          question: "Question:"
        }
      : language === "es"
        ? {
            history: "Historial:",
            endpoints: "Endpoints:",
            related: "Endpoints relacionados (para encadenamiento):",
            error: "Error:",
            previous: "Solicitud anterior:",
            question: "Pregunta:"
          }
        : {
            history: "Historico:",
            endpoints: "Endpoints:",
            related: "Endpoints relacionados (para encadeamento):",
            error: "Erro:",
            previous: "Requisicao anterior:",
            question: "Pergunta:"
          };

  const lines: Array<string | null> = [];
  lines.push(`Base URL: ${baseUrl}`);
  if (historySnippet) lines.push(labels.history, historySnippet);
  if (fewShotSection) lines.push(fewShotSection);
  lines.push(labels.endpoints, endpointDetails);
  if (relatedDetails) lines.push(labels.related, relatedDetails);
  if (errorContext) lines.push(labels.error, errorContext);
  if (previousRequest) lines.push(labels.previous, previousRequest);
  lines.push(labels.question, question);

  return lines.filter(Boolean).join("\n");
};

/* ── System Prompt ───────────────────────────────────────── */

const buildHttpSystemContent = (
  instructionText: string,
  language: "pt" | "en" | "es",
  readOnly: boolean
): string => {
  const methodRule = readOnly
    ? language === "en"
      ? "You MUST only use GET requests. Never use POST, PUT, PATCH, or DELETE."
      : language === "es"
        ? "SOLO puedes usar solicitudes GET. Nunca uses POST, PUT, PATCH o DELETE."
        : "Voce DEVE usar apenas requisicoes GET. Nunca use POST, PUT, PATCH ou DELETE."
    : language === "en"
      ? "You may use any HTTP method as needed."
      : language === "es"
        ? "Puedes usar cualquier metodo HTTP segun sea necesario."
        : "Voce pode usar qualquer metodo HTTP conforme necessario.";

  const base =
    language === "en"
      ? `You are an API integration expert. Output ONLY a valid JSON object representing an HTTP request plan. No markdown, no comments. ${methodRule} ` +
        'The JSON must follow this schema: { "steps": [{ "stepIndex": number, "method": string, "url": string, "headers"?: object, "queryParams"?: object, "body"?: any, "description": string, "dependsOn"?: number, "extractFrom"?: string }] }. ' +
        "For chained requests, use dependsOn to reference a previous step's stepIndex, and extractFrom to specify a dot-path expression for extracting data from that step's response. Use {extracted} as placeholder in url or body of the dependent step."
      : language === "es"
        ? `Eres un experto en integracion de APIs. Devuelve SOLO un objeto JSON valido representando un plan de peticion HTTP. Sin markdown, sin comentarios. ${methodRule} ` +
          'El JSON debe seguir este esquema: { "steps": [{ "stepIndex": number, "method": string, "url": string, "headers"?: object, "queryParams"?: object, "body"?: any, "description": string, "dependsOn"?: number, "extractFrom"?: string }] }. ' +
          "Para solicitudes encadenadas, usa dependsOn para referenciar un stepIndex anterior, y extractFrom para especificar una expresion dot-path."
        : `Voce e um especialista em integracao de APIs. Retorne APENAS um objeto JSON valido representando um plano de requisicao HTTP. Sem markdown, sem comentarios. ${methodRule} ` +
          'O JSON deve seguir este schema: { "steps": [{ "stepIndex": number, "method": string, "url": string, "headers"?: object, "queryParams"?: object, "body"?: any, "description": string, "dependsOn"?: number, "extractFrom"?: string }] }. ' +
          "Para requisicoes encadeadas, use dependsOn para referenciar o stepIndex de um passo anterior, e extractFrom para especificar uma expressao dot-path para extrair dados da resposta daquele passo. Use {extracted} como placeholder na url ou body do passo dependente.";

  const instructionsLabel =
    language === "en"
      ? "Additional instructions:"
      : language === "es"
        ? "Instrucciones adicionales:"
        : "Instrucoes adicionais:";

  if (!instructionText.trim()) return base;
  return `${base}\n${instructionsLabel}\n${instructionText}`;
};

/* ── Generation ──────────────────────────────────────────── */

export const generateHttpRequest = async (
  prompt: string,
  instructionText: string,
  language: "pt" | "en" | "es",
  readOnly: boolean,
  useMini: boolean,
  allowEscalation: boolean
): Promise<GenerateHttpResult> => {
  const agentsCfg = await getAgentsConfig();
  const model = useMini
    ? (agentsCfg.sql.modelMini ?? agentsCfg.http.model)
    : agentsCfg.http.model;

  const system = buildHttpSystemContent(instructionText, language, readOnly);
  const systemWithEscalation = allowEscalation
    ? `${system}\nIf unsure you can produce a correct request plan, reply with only: ESCALATE`
    : system;

  logPrompt("http", {
    system: systemWithEscalation,
    user: prompt,
    meta: { model, language }
  });

  const client = await getOpenAI();
  const temperature = agentsCfg.http.temperature;
  const completion = await client.chat.completions.create({
    model,
    ...(temperature !== undefined && temperature !== null ? { temperature } : {}),
    messages: [
      { role: "system", content: systemWithEscalation },
      { role: "user", content: prompt }
    ]
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  logPrompt("http-response", {
    user: raw,
    meta: { model, language }
  });

  if (shouldLogPrompts() && completion.usage) {
    console.info(
      `[tokens] http (${model}) | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`
    );
  }

  if (allowEscalation && raw.trim().toUpperCase() === "ESCALATE") {
    return { plan: { steps: [] }, escalated: true, usage: completion.usage };
  }

  const cleaned = stripJson(raw);
  const plan = JSON.parse(cleaned) as HttpRequestPlan;
  return { plan, usage: completion.usage };
};
