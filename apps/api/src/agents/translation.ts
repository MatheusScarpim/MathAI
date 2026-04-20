import { getOpenAI, getTranslationModel } from "../core/openai.js";
import { getAgentsConfig } from "../core/agentConfig.js";

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

const languageName = (language: "pt" | "en" | "es"): string =>
  language === "pt" ? "Portuguese" : language === "es" ? "Spanish" : "English";

export const translateText = async (
  text: string,
  targetLanguage: "pt" | "en" | "es",
  label: string
): Promise<string> => {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const system = [
    "You are a translation assistant.",
    `Translate the user text to ${languageName(targetLanguage)}.`,
    "Preserve database identifiers (table/column names), SQL keywords, and code fragments.",
    "Return only the translated text without quotes or markdown."
  ].join(" ");
  const model = await getTranslationModel();
  const agentsCfg = await getAgentsConfig();
  logPrompt(`translate:${label}`, {
    system,
    user: trimmed,
    meta: { model, targetLanguage }
  });
  const client = await getOpenAI();
  const completion = await client.chat.completions.create({
    model,
    temperature: agentsCfg.translation.temperature ?? 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: trimmed }
    ]
  });
  if (shouldLogPrompts() && completion.usage) {
    console.info(`[tokens] translate:${label} | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`);
  }
  const translated = completion.choices[0]?.message?.content?.trim();
  return translated ? translated.replace(/\s+/g, " ") : text;
};

export interface StandaloneResult {
  question: string;
  isNewTopic: boolean;
}

export const buildStandaloneQuestion = async (
  question: string,
  history: string[],
  targetLanguage: "pt" | "en" | "es"
): Promise<StandaloneResult> => {
  const trimmed = question.trim();
  if (!trimmed) return { question, isNewTopic: false };
  const historySection = history.length
    ? history.map((item, index) => `${index + 1}) ${item}`).join("\n")
    : "";
  const system = [
    "You rewrite the user's current question into a single, concrete, standalone question.",
    `Output must be in ${languageName(targetLanguage)}.`,
    "Keep the metrics, dimensions, and filters from the most recent question.",
    "If the current question is a short follow-up (e.g., 'and in 2024?'),",
    "carry over the missing context and only change the time period.",
    "If the current question already includes a year/month/period, keep it unchanged.",
    "If the current question is already concrete, return it as-is.",
    "IMPORTANT: If the current question is about a completely different subject/topic than the history",
    "(e.g., history is about sales but the question is about employees, or history is about revenue but the question is about inventory),",
    "ignore the history entirely and return the question as-is.",
    "Output format: Start with [NEW_TOPIC] if the question is unrelated to the history, otherwise start with [FOLLOW_UP].",
    "Then on a new line, write only the question text without quotes or markdown."
  ].join(" ");
  const user = historySection
    ? `History:\n${historySection}\n\nCurrent question:\n${trimmed}`
    : `Current question:\n${trimmed}`;
  const model = await getTranslationModel();
  logPrompt("standalone-question", {
    system,
    user,
    meta: { model, targetLanguage }
  });
  const client = await getOpenAI();
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
  if (shouldLogPrompts() && completion.usage) {
    console.info(`[tokens] standalone-question | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`);
  }
  const raw = completion.choices[0]?.message?.content?.trim() ?? "";
  const isNewTopic = raw.startsWith("[NEW_TOPIC]");
  const cleaned = raw
    .replace(/^\[NEW_TOPIC\]\s*/i, "")
    .replace(/^\[FOLLOW_UP\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    question: cleaned || question,
    isNewTopic
  };
};
