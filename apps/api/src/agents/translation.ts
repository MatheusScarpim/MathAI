import { getOpenAI, SUMMARY_MODEL } from "../openai.js";

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
  logPrompt(`translate:${label}`, {
    system,
    user: trimmed,
    meta: { model: SUMMARY_MODEL, targetLanguage }
  });
  const client = await getOpenAI();
  const completion = await client.chat.completions.create({
    model: SUMMARY_MODEL,
    temperature: 0,
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

export const buildStandaloneQuestion = async (
  question: string,
  history: string[],
  targetLanguage: "pt" | "en" | "es"
): Promise<string> => {
  const trimmed = question.trim();
  if (!trimmed) return question;
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
    "Return only the question text without quotes or markdown."
  ].join(" ");
  const user = historySection
    ? `History:\n${historySection}\n\nCurrent question:\n${trimmed}`
    : `Current question:\n${trimmed}`;
  logPrompt("standalone-question", {
    system,
    user,
    meta: { model: SUMMARY_MODEL, targetLanguage }
  });
  const client = await getOpenAI();
  const completion = await client.chat.completions.create({
    model: SUMMARY_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
  if (shouldLogPrompts() && completion.usage) {
    console.info(`[tokens] standalone-question | input=${completion.usage.prompt_tokens} output=${completion.usage.completion_tokens} total=${completion.usage.total_tokens}`);
  }
  const rewritten = completion.choices[0]?.message?.content?.trim();
  return rewritten ? rewritten.replace(/\s+/g, " ") : question;
};
