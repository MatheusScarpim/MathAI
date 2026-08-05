import { getSchemaLanguageSetting, isValidLanguage, type ValidLanguage } from "./settings.js";
import { detectLanguage } from "./detectLanguage.js";

export type AskBody = {
  question?: string;
  chatId?: string;
  language?: string;
  schemaLanguage?: string;
  responseLanguage?: string;
  async?: boolean;
  webhookUrl?: string;
  environmentId?: string;
};

export type NormalizedAskPayload = {
  question: string;
  chatId?: string;
  questionLanguage: ValidLanguage;
  schemaLanguage: ValidLanguage;
  responseLanguage: ValidLanguage;
  /** What the detector read from the question text, null when undecidable. */
  detectedLanguage: ValidLanguage | null;
  /** What the caller claimed, if anything valid. */
  declaredLanguage?: ValidLanguage;
  /** True when a confident detection disagreed with the declared language. */
  languageOverride: boolean;
  webhookUrl?: string;
  environmentId?: string;
};

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fd/i,
  /^fe80:/i,
  /^localhost$/i
];

const isPrivateHost = (hostname: string): boolean =>
  PRIVATE_IP_RANGES.some((pattern) => pattern.test(hostname));

export const isValidWebhookUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (isPrivateHost(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
};

export const normalizeAskPayload = async (body: AskBody): Promise<NormalizedAskPayload> => {
  const question = body.question!.trim();
  const schemaLanguage = isValidLanguage(body.schemaLanguage)
    ? body.schemaLanguage
    : await getSchemaLanguageSetting();

  const declaredLanguage = isValidLanguage(body.language) ? body.language : undefined;
  const detection = detectLanguage(question);

  // A confident detection wins over the declared language for canonicalization.
  // Defaulting to "pt" whenever `language` was absent meant an English question
  // was declared Portuguese, matched the Portuguese schema, and so skipped
  // translation altogether - the question reached the SQL agent in a language
  // the schema chunks were never written in.
  const questionLanguage: ValidLanguage =
    detection.confident && detection.language
      ? detection.language
      : declaredLanguage ?? detection.language ?? "pt";

  // The answer still comes back in whatever the caller asked for. Detection
  // decides how we *read* the question, not how we reply to it.
  const responseLanguage = isValidLanguage(body.responseLanguage)
    ? body.responseLanguage
    : declaredLanguage ?? questionLanguage;

  const languageOverride = Boolean(
    declaredLanguage && detection.confident && detection.language !== declaredLanguage
  );

  if (languageOverride) {
    console.info(
      `[language-override] declarado=${declaredLanguage} detectado=${detection.language} ` +
        `confianca=${detection.confidence.toFixed(2)} scores=${JSON.stringify(detection.scores)}`
    );
  }

  return {
    question,
    chatId: body.chatId?.trim(),
    questionLanguage,
    schemaLanguage,
    responseLanguage,
    detectedLanguage: detection.language,
    declaredLanguage,
    languageOverride,
    webhookUrl: body.webhookUrl?.trim(),
    environmentId: body.environmentId?.trim()
  };
};
