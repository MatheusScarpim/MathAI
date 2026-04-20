import { getSchemaLanguageSetting, isValidLanguage, type ValidLanguage } from "./settings.js";

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
  const schemaLanguage = isValidLanguage(body.schemaLanguage)
    ? body.schemaLanguage
    : await getSchemaLanguageSetting();
  const questionLanguage = isValidLanguage(body.language) ? body.language : "pt";
  const responseLanguage = isValidLanguage(body.responseLanguage)
    ? body.responseLanguage
    : questionLanguage;

  return {
    question: body.question!.trim(),
    chatId: body.chatId?.trim(),
    questionLanguage,
    schemaLanguage,
    responseLanguage,
    webhookUrl: body.webhookUrl?.trim(),
    environmentId: body.environmentId?.trim()
  };
};
