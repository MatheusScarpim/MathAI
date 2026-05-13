/**
 * scheduleParser — converte linguagem natural ("toda terca 9h", "diariamente as 14:30")
 * em uma cron expression de 5 campos validavel.
 *
 * Tambem aceita cron crua direta. Determina automaticamente se eh
 * uma agenda de "task" ou "ideas" pelo conteudo da descricao.
 */

import { getOpenAI } from "../../core/openai.js";
import { withRetry } from "./withRetry.js";
import { CronExpressionParser } from "cron-parser";
import type { ScheduledKind } from "../../core/mongo.js";

export type ScheduleParseResult = {
  /** Cron de 5 campos validavel. */
  cron: string;
  /** Description curta (display + task description). */
  description: string;
  /** "task" (default) ou "ideas" (quando user pediu sugestoes recorrentes). */
  kind: ScheduledKind;
  /** Erro humano se nao foi possivel parsear. */
  error?: string;
};

const SYSTEM_PROMPT = `Voce converte pedidos de agendamento em portugues para cron expression.

INPUT: texto livre do usuario (ex: "rodar smoke test toda terca 9h", "ideias diarias 8 da manha")
OUTPUT: JSON com:
  - "cron": expressao cron de 5 campos (M H DoM Mon DoW). Use 0-6 pra dia da semana (0=domingo).
  - "description": descricao curta da tarefa (sem horario — so o que vai ser feito)
  - "kind": "ideas" se o pedido e sobre receber sugestoes/ideias do sistema; "task" caso contrario
  - "error": (opcional) string com motivo se input ambiguo

EXEMPLOS:
- "rodar smoke test seg-sex 8h" -> { cron: "0 8 * * 1-5", description: "rodar smoke test", kind: "task" }
- "ideias todo dia 9h" -> { cron: "0 9 * * *", description: "ideias diarias", kind: "ideas" }
- "deploy toda quinta 14:30" -> { cron: "30 14 * * 4", description: "deploy", kind: "task" }
- "a cada hora rodar X" -> { cron: "0 * * * *", description: "rodar X", kind: "task" }
- "vamos almocar" -> { cron: "", description: "", kind: "task", error: "Nao parece um agendamento" }

REGRAS:
- Cron sempre 5 campos separados por espaco
- Se o usuario nao disser horario, default 9h
- Se "ideias"/"sugestoes"/"melhorias" aparece, kind = "ideas"
- Em ambiguidade, retorne error pra usuario corrigir

Responda SEMPRE em JSON valido.`;

export const parseSchedule = async (input: string): Promise<ScheduleParseResult> => {
  const trimmed = input.trim();

  // Path 1: cron expression direta (5 campos numericos/wildcards)
  const cronDirectMatch = trimmed.match(/^([\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+)\s+(.*)$/);
  if (cronDirectMatch) {
    const [, cronCandidate, rest] = cronDirectMatch;
    if (cronCandidate && validateCron(cronCandidate)) {
      const description = rest!.trim() || "tarefa agendada";
      const kind: ScheduledKind = /\b(ideias?|sugestoes?|melhorias?)\b/i.test(description) ? "ideas" : "task";
      return { cron: cronCandidate, description, kind };
    }
  }

  // Path 2: chama LLM
  return withRetry<ScheduleParseResult>(
    async () => {
      const client = await getOpenAI();
      const completion = await client.chat.completions.create({
        model: "deepseek-chat",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: trimmed }
        ]
      });

      const raw = completion.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(raw) as Partial<ScheduleParseResult>;

      if (parsed.error) {
        return { cron: "", description: "", kind: "task", error: parsed.error };
      }

      const cron = typeof parsed.cron === "string" ? parsed.cron.trim() : "";
      const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
      const kind: ScheduledKind = parsed.kind === "ideas" ? "ideas" : "task";

      if (!cron || !validateCron(cron)) {
        return {
          cron: "",
          description: description || trimmed,
          kind,
          error: `Nao consegui entender o horario. Tente: "diariamente 9h" ou cron "0 9 * * *"`
        };
      }
      if (!description) {
        return {
          cron,
          description: trimmed,
          kind,
          error: "Sem descricao clara — diga o que vai ser feito."
        };
      }

      return { cron, description, kind };
    },
    {
      label: "scheduleParser",
      attempts: 2,
      baseDelayMs: 300,
      fallback: () => ({
        cron: "",
        description: trimmed,
        kind: "task" as ScheduledKind,
        error: "Falha ao parsear — tente formato cron direto: \"0 9 * * *\" <descricao>"
      })
    }
  );
};

/** Valida cron de 5 campos via cron-parser. */
export const validateCron = (cron: string): boolean => {
  try {
    CronExpressionParser.parse(cron, { tz: "America/Sao_Paulo" });
    return true;
  } catch {
    return false;
  }
};

/** Calcula proxima ocorrencia da cron a partir de "agora". */
export const computeNextRun = (cron: string, timezone = "America/Sao_Paulo"): Date | null => {
  try {
    const interval = CronExpressionParser.parse(cron, { tz: timezone });
    return interval.next().toDate();
  } catch {
    return null;
  }
};

/** Render humano de cron pra display. */
export const describeCron = (cron: string): string => {
  // Render simples — nao depende de lib externa pra evitar I18n
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [m, h, dom, mon, dow] = parts;

  const fmtTime = () => {
    if (h === "*") return m === "0" ? "a cada hora cheia" : `a cada hora (min ${m})`;
    return `${h!.padStart(2, "0")}:${m!.padStart(2, "0")}`;
  };

  const dayParts: string[] = [];
  if (dow !== "*") {
    const days = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
    if (dow === "1-5") dayParts.push("seg a sex");
    else if (dow === "0,6" || dow === "6,0") dayParts.push("fim de semana");
    else if (/^\d$/.test(dow!)) dayParts.push(days[Number(dow)]!);
    else dayParts.push(`dia da semana: ${dow}`);
  }
  if (dom !== "*") dayParts.push(`dia ${dom} do mes`);
  if (mon !== "*") dayParts.push(`mes ${mon}`);
  if (dayParts.length === 0) dayParts.push("todo dia");

  return `${dayParts.join(", ")} as ${fmtTime()}`;
};
