import OpenAI from "openai";
import { config } from "./config.js";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const SQL_MODEL = "gpt-5";
export const SQL_MODEL_MINI = "gpt-5-mini";
export const SUMMARY_MODEL = "gpt-4o-mini";

export const openai = new OpenAI({
  apiKey: config.openAiApiKey
});
