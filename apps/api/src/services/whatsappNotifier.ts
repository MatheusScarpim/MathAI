/**
 * Callbacks chamados do pipeline pra notificar tasks via WhatsApp.
 *
 * Design anti-ban:
 *  - 1 msg de inicio + 1 msg de fim (sem live edit por stage no MVP)
 *  - Falha no envio NUNCA quebra a task — try/catch + log
 *  - Reports > 3500 chars enviados como documento .md
 *
 * Robustez:
 *  - Se o socket nao esta conectado no momento da notificacao,
 *    aguarda ate 10s pra reconectar antes de desistir.
 *  - Logs explicitos em todos os caminhos pra facilitar debug.
 */

import {
  sendText,
  sendDocument,
  reactTo,
  isConnected
} from "../orchestrator/integrations/whatsapp.js";
import type { TaskStatus, TaskStage } from "../orchestrator/types.js";
import { getTasksCollection } from "../core/mongo.js";
import { ObjectId } from "mongodb";

export type WhatsappMsgKey = { id: string; remoteJid: string; fromMe: boolean };

const MAX_INLINE_REPORT = 3500; // limite seguro abaixo do hard cap de 4096 do WA
const CONNECT_WAIT_MS = 10_000; // espera ate 10s pelo socket reconectar

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Aguarda ate `timeoutMs` pelo socket abrir. Retorna true se conectou. */
const waitForConnection = async (timeoutMs = CONNECT_WAIT_MS): Promise<boolean> => {
  if (isConnected()) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isConnected()) return true;
    await sleep(500);
  }
  return isConnected();
};

/**
 * Envia "🚀 Iniciando task" e retorna a key da msg pra ser usada em reactions
 * subsequentes (stage transitions). Retorna `null` se o socket nao conectar
 * ou o envio falhar — caller deve tratar como skip silencioso.
 */
export const notifyTaskStart = async (
  jid: string,
  description: string
): Promise<WhatsappMsgKey | null> => {
  console.info(`[whatsappNotifier] notifyTaskStart jid=${jid} connected=${isConnected()}`);
  const ok = await waitForConnection();
  if (!ok) {
    console.warn(`[whatsappNotifier] notifyTaskStart skipped — socket not connected after ${CONNECT_WAIT_MS}ms`);
    return null;
  }
  try {
    const firstLine = description.split(/\r?\n/)[0]?.slice(0, 200) ?? description.slice(0, 200);
    const msg = await sendText(jid, `🚀 *Iniciando task*\n${firstLine}`);
    console.info(`[whatsappNotifier] notifyTaskStart sent`);
    const key = msg?.key;
    if (key?.id && key?.remoteJid) {
      return { id: key.id, remoteJid: key.remoteJid, fromMe: key.fromMe ?? true };
    }
    return null;
  } catch (err) {
    console.warn("[whatsappNotifier] notifyTaskStart failed:", err);
    return null;
  }
};

const STAGE_EMOJI: Record<TaskStage, string> = {
  planning: "🧠",
  coding: "✏️",
  reviewing: "🔍",
  reporting: "📝",
  done: "✅"
};

/**
 * Reage com o emoji do stage na msg "🚀 Iniciando" da task.
 * Le `whatsappStartMsgKey` do task record. No-op se ausente.
 * Fire-and-forget — nunca throw.
 */
export const notifyStageChange = async (
  jid: string,
  taskId: string,
  stage: TaskStage
): Promise<void> => {
  const emoji = STAGE_EMOJI[stage];
  if (!emoji) return;
  if (!isConnected()) {
    // Stage transitions sao baratas — nao vale esperar reconnect.
    return;
  }
  try {
    const tasksCol = await getTasksCollection();
    const task = await tasksCol.findOne(
      { _id: new ObjectId(taskId) },
      { projection: { whatsappStartMsgKey: 1 } }
    );
    const key = task?.whatsappStartMsgKey;
    if (!key?.id || !key?.remoteJid) {
      console.info(`[whatsappNotifier] notifyStageChange task=${taskId.slice(-8)} skip — no start msg key`);
      return;
    }
    await reactTo(jid, { id: key.id, remoteJid: key.remoteJid, fromMe: key.fromMe }, emoji);
    console.info(`[whatsappNotifier] notifyStageChange task=${taskId.slice(-8)} stage=${stage} reacted ${emoji}`);
  } catch (err) {
    console.warn("[whatsappNotifier] notifyStageChange failed:", err);
  }
};

export const notifyTaskDone = async (
  jid: string,
  taskId: string,
  finalStatus: TaskStatus,
  prUrls: string[],
  summary: string | undefined
): Promise<void> => {
  console.info(`[whatsappNotifier] notifyTaskDone task=${taskId.slice(-8)} status=${finalStatus} jid=${jid} connected=${isConnected()}`);
  const ok = await waitForConnection();
  if (!ok) {
    console.warn(`[whatsappNotifier] notifyTaskDone task=${taskId.slice(-8)} SKIPPED — socket not connected after ${CONNECT_WAIT_MS}ms`);
    return;
  }

  try {
    const icon = finalStatus === "completed" ? "✅" : finalStatus === "failed" ? "❌" : "⛔";
    const statusLabel: Record<string, string> = {
      completed: "Completed",
      failed: "Failed",
      cancelled: "Cancelled"
    };
    const label = statusLabel[finalStatus] ?? finalStatus;

    const sections: string[] = [`${icon} *${label}*`];

    if (prUrls.length > 0) {
      sections.push("");
      sections.push("🔗 *Pull Requests*");
      for (const url of prUrls) sections.push(url);
    }

    if (summary) {
      sections.push("");
      sections.push("📝 *Resumo*");
      const truncated = summary.length > MAX_INLINE_REPORT
        ? summary.slice(0, MAX_INLINE_REPORT) + "\n\n_(continua no anexo)_"
        : summary;
      sections.push(truncated);
    }

    await sendText(jid, sections.join("\n"));
    console.info(`[whatsappNotifier] notifyTaskDone task=${taskId.slice(-8)} sent`);

    // Anexa report completo se passar do limite
    if (summary && summary.length > MAX_INLINE_REPORT) {
      try {
        await sendDocument(
          jid,
          Buffer.from(summary, "utf8"),
          `task-${taskId}-report.md`,
          "text/markdown"
        );
      } catch (err) {
        console.warn("[whatsappNotifier] sendDocument failed:", err);
      }
    }
  } catch (err) {
    console.warn("[whatsappNotifier] notifyTaskDone failed:", err);
  }
};
