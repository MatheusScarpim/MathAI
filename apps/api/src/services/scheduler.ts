/**
 * Scheduler — tick loop que dispara tarefas/jobs agendados.
 *
 * Design:
 *  - 60s tick (setInterval), tambem dispara imediatamente no boot
 *  - Lock leve via findOneAndUpdate atomico (evita double-fire entre replicas)
 *  - Dispatcher por kind:
 *      "task"  -> executeTask(description, opts) com WhatsApp notify
 *      "ideas" -> generateIdeas + envia resultado direto via WhatsApp
 *  - Atualiza nextRunAt apos disparo (cron-parser)
 *  - Falha em um job nao quebra o loop
 *
 * Idempotencia cross-restart:
 *  - lockedAt sobreviveu ao restart? Em teoria sim, mas no boot tem cleanup.
 *  - nextRunAt no passado dispara imediatamente no proximo tick.
 */

import { ObjectId } from "mongodb";
import {
  getScheduledCollection,
  getIdeaDeliveriesCollection,
  getTasksCollection,
  getChatBindingsCollection,
  type ScheduledRecord
} from "../core/mongo.js";
import { computeNextRun } from "../orchestrator/agents/scheduleParser.js";
import { executeTask } from "../orchestrator/index.js";
import { resolveProjectOptions } from "../helpers/projectOptionsResolver.js";
import { generateIdeas, type IdeasResult } from "../orchestrator/agents/ideas.js";
import { buildIdleSuggestions } from "../orchestrator/agents/idleSuggestions.js";
import { sendText, isConnected, onStatusChange } from "../orchestrator/integrations/whatsapp.js";
import type { TaskExecuteOptions, TaskStatus } from "../orchestrator/types.js";

const TICK_MS = 60_000;
/** Lock expira apos 5min — proteção contra processo morto sem liberar. */
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

// ─── Idle-watchdog (pergunta no WhatsApp quando o sistema fica ocioso) ─────
/** Sem nenhuma task ativa por este tempo -> considera ocioso. */
const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2h
/** Nao repergunta ao mesmo chat dentro deste intervalo (anti-spam). */
const NUDGE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h
/** So incomoda dentro desta janela de horas locais (America/Sao_Paulo). */
const ACTIVE_HOUR_START = 8;
const ACTIVE_HOUR_END = 21;
const IDLE_TZ = "America/Sao_Paulo";
/** Status que contam como "task ativa" (sistema ocupado). */
const ACTIVE_TASK_STATUSES: TaskStatus[] = ["pending", "planning", "awaiting_approval", "executing"];

let started = false;
let tickHandle: NodeJS.Timeout | null = null;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Dispatcher principal: pega 1 job due (lock atomico) e executa. */
const tick = async (): Promise<void> => {
  const col = await getScheduledCollection();
  const now = new Date();
  const lockExpiry = new Date(now.getTime() - LOCK_TIMEOUT_MS);

  // Loop ate nao haver mais due
  while (true) {
    const lockResult = await col.findOneAndUpdate(
      {
        enabled: true,
        nextRunAt: { $lte: now },
        $or: [
          { lockedAt: { $exists: false } },
          { lockedAt: { $lt: lockExpiry } } // lock expirado de processo morto
        ]
      } as Record<string, unknown>,
      { $set: { lockedAt: now } },
      { returnDocument: "after", sort: { nextRunAt: 1 } }
    );

    const due = lockResult as ScheduledRecord | null;
    if (!due) break;

    // Dispara em background — proximo job pode ser pego pelo loop while em paralelo
    void fireScheduled(due).finally(async () => {
      try {
        await col.updateOne(
          { _id: due._id },
          { $unset: { lockedAt: "" } }
        );
      } catch (err) {
        console.warn("[scheduler] failed to release lock:", err);
      }
    });
  }

  // Watchdog de ociosidade — best-effort, nunca quebra o tick.
  await checkIdleAndNudge().catch(err => console.warn("[scheduler] idle-watchdog error:", err));
};

/** Hora local (America/Sao_Paulo) 0-23, robusto a fuso do host. */
const localHour = (): number => {
  const s = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: IDLE_TZ
  }).format(new Date());
  const h = parseInt(s, 10);
  return Number.isNaN(h) ? new Date().getHours() : h % 24;
};

/**
 * Watchdog de ociosidade: se nao ha nenhuma task ativa e o sistema ficou parado
 * por >= IDLE_THRESHOLD_MS, pergunta no WhatsApp se pode rodar algo. Gates anti-spam:
 * cooldown por chat, janela de horario, WA conectado, chat privado com projeto default.
 */
const checkIdleAndNudge = async (): Promise<void> => {
  if (!isConnected()) return;

  const hour = localHour();
  if (hour < ACTIVE_HOUR_START || hour >= ACTIVE_HOUR_END) return;

  const tasksCol = await getTasksCollection();
  const activeCount = await tasksCol.countDocuments({ status: { $in: ACTIVE_TASK_STATUSES } });
  if (activeCount > 0) return; // sistema ocupado

  // Última atividade = task mais recente por updatedAt.
  const [lastTask] = await tasksCol.find({}).sort({ updatedAt: -1 }).limit(1).toArray();
  if (!lastTask) return; // nunca rodou nada — nada pra sugerir contexto
  const lastActivity = lastTask.updatedAt ?? lastTask.createdAt;
  if (!lastActivity || Date.now() - new Date(lastActivity).getTime() < IDLE_THRESHOLD_MS) return;

  // Bindings elegiveis: WhatsApp, ativos, privados, com projeto default, toggle on,
  // fora do cooldown.
  const bindingsCol = await getChatBindingsCollection();
  const cooldownCutoff = new Date(Date.now() - NUDGE_COOLDOWN_MS);
  const eligible = await bindingsCol
    .find({
      transport: "whatsapp",
      active: true,
      isGroup: { $ne: true },
      defaultProjectId: { $exists: true, $ne: null },
      idleNudgeEnabled: { $ne: false },
      $or: [
        { lastIdleNudgeAt: { $exists: false } },
        { lastIdleNudgeAt: { $lt: cooldownCutoff } }
      ]
    } as Record<string, unknown>)
    .toArray();

  if (eligible.length === 0) return;

  // Dedup por chatId — pode haver bindings duplicados pro mesmo chat; envia 1x so.
  const seenChats = new Set<string>();
  const uniqueBindings = eligible.filter(b => {
    if (!b.chatId || seenChats.has(b.chatId)) return false;
    seenChats.add(b.chatId);
    return true;
  });

  const idleHours = Math.round((Date.now() - new Date(lastActivity).getTime()) / (60 * 60 * 1000));

  for (const b of uniqueBindings) {
    // Coleta sugestoes concretas: cards Trello (projeto default) + ideias de melhoria (codex).
    let suggestions: Awaited<ReturnType<typeof buildIdleSuggestions>> = [];
    try {
      if (b.defaultProjectId) {
        suggestions = await buildIdleSuggestions(b.defaultProjectId, b.userId ?? undefined);
      }
    } catch (err) {
      console.warn("[scheduler] buildIdleSuggestions falhou:", err instanceof Error ? err.message : err);
    }

    let msg: string;
    let persisted: Array<{ n: number; kind: "card" | "idea"; description: string }> = [];

    if (suggestions.length > 0) {
      const lines = suggestions.map((s, i) => {
        const icon = s.kind === "card" ? "🃏" : "💡";
        return `${i + 1}. ${icon} ${s.label}`;
      });
      persisted = suggestions.map((s, i) => ({ n: i + 1, kind: s.kind, description: s.description }));
      msg =
        `💤 Parado há ~${idleHours}h. Posso adiantar algo?\n\n` +
        `${lines.join("\n")}\n\n` +
        `Responda o *número* pra eu rodar (no claude), ou mande sua própria descrição.\n` +
        `*!ideas* pra mais · *!projects* pra trocar de projeto.\n\n` +
        `_(Pra desligar: *!idle off*)_`;
    } else {
      // Fallback: aviso generico (Trello off e/ou generateIdeas vazio/falho).
      msg =
        `💤 Nenhuma task rodando há ~${idleHours}h.\n` +
        `Quer que eu rode algo agora?\n\n` +
        `Responda com a descrição (ex: *corrigir bug do login*),\n` +
        `ou *!ideas* pra sugestões, ou *!projects* pra trocar de projeto.\n\n` +
        `_(Pra desligar estes avisos: *!idle off*)_`;
    }

    try {
      await sendText(b.chatId, msg);
      // Marca cooldown + persiste sugestoes em TODOS os bindings desse chat (evita dup no proximo tick).
      await bindingsCol.updateMany(
        { chatId: b.chatId },
        { $set: { lastIdleNudgeAt: new Date(), idleSuggestions: persisted } }
      );
      console.info(
        `[scheduler] idle-nudge enviado (jid=${b.chatId.slice(0, 8)}..., idle=${idleHours}h, sugestoes=${persisted.length})`
      );
    } catch (err) {
      console.warn("[scheduler] falha ao enviar idle-nudge:", err);
    }
  }
};

/** Executa um job e atualiza nextRunAt + last fields. */
const fireScheduled = async (rec: ScheduledRecord): Promise<void> => {
  const col = await getScheduledCollection();
  const idShort = rec._id?.toString().slice(-8) ?? "?";
  console.info(`[scheduler] firing kind=${rec.kind} id=${idShort} desc="${rec.description}"`);

  let result: "ok" | "failed" | "skipped" = "ok";
  let lastFireTaskId: string | undefined;

  try {
    if (rec.kind === "task") {
      const taskId = await dispatchTask(rec);
      lastFireTaskId = taskId;
    } else if (rec.kind === "ideas") {
      await dispatchIdeas(rec);
    }
  } catch (err) {
    console.error(`[scheduler] fire kind=${rec.kind} id=${idShort} ERROR:`, err);
    result = "failed";
    if (rec.whatsappJid && isConnected()) {
      try {
        await sendText(rec.whatsappJid, `❌ *Job agendado falhou*\n${rec.description}\n\n_${err instanceof Error ? err.message : String(err)}_`);
      } catch { /* swallow */ }
    }
  }

  const nextRunAt = computeNextRun(rec.cron, rec.timezone);
  const update: Record<string, unknown> = {
    lastFiredAt: new Date(),
    lastFireResult: result,
    updatedAt: new Date()
  };
  if (lastFireTaskId) update.lastFireTaskId = lastFireTaskId;
  if (nextRunAt) update.nextRunAt = nextRunAt;

  await col.updateOne({ _id: rec._id }, { $set: update });
};

/** Dispatch kind="task". Retorna taskId. */
const dispatchTask = async (rec: ScheduledRecord): Promise<string> => {
  let github: TaskExecuteOptions["github"];
  let trello: TaskExecuteOptions["trello"];

  if (rec.projectId) {
    const resolved = await resolveProjectOptions(rec.projectId);
    if (resolved) {
      github = resolved.github;
      trello = resolved.trello;
    }
  }

  const opts: TaskExecuteOptions = {
    userId: rec.userId,
    projectId: rec.projectId,
    github,
    trello
  };
  if (rec.whatsappJid) opts.whatsapp = { jid: rec.whatsappJid };

  // Aviso de inicio (proativo) — notifyTaskStart no pipeline tambem dispara, mas avisa
  // que a origem foi o scheduler e nao o user
  if (rec.whatsappJid && isConnected()) {
    try {
      await sendText(rec.whatsappJid, `⏰ *Job agendado disparado*\n${rec.description}`);
    } catch { /* swallow */ }
  }

  const r = await executeTask(rec.description, opts);
  return r.taskId;
};

/**
 * Dispatch kind="ideas". Roda generateIdeas e manda resultado via WA.
 * #2: se a geracao FALHOU (nao "vazio"), lanca erro -> fireScheduled marca
 *     lastFireResult="failed" e avisa "job falhou" em vez de "nada relevante".
 * #1: se o WhatsApp estiver offline, persiste a mensagem pra reenviar no
 *     reconnect em vez de descartar silenciosamente.
 */
const dispatchIdeas = async (rec: ScheduledRecord): Promise<void> => {
  const result = await generateIdeas(rec.userId);

  if (result.failed) {
    throw new Error(result.error ?? "geracao de ideias falhou (LLM/parse)");
  }

  if (!rec.whatsappJid) return; // schedule silencioso, sem destino

  const text = formatIdeasMessage(result);

  if (isConnected()) {
    await sendText(rec.whatsappJid, text);
    return;
  }

  // WA offline — enfileira pra reenviar no reconnect (#1).
  const col = await getIdeaDeliveriesCollection();
  await col.insertOne({
    whatsappJid: rec.whatsappJid,
    userId: rec.userId,
    text,
    status: "pending",
    attempts: 0,
    createdAt: new Date()
  });
  console.info(`[scheduler] WA offline — ideia enfileirada pra reenvio (jid=${rec.whatsappJid.slice(0, 8)}...)`);
};

/** Formata o resultado das ideias em texto pronto pra WhatsApp. */
const formatIdeasMessage = (result: IdeasResult): string => {
  if (!result.ideas || result.ideas.length === 0) {
    return `💡 _Sweep de ideias:_ nada relevante desta vez.`;
  }

  const categoryLabel: Record<string, string> = {
    "task-flaky": "🔥 Task instavel",
    "recurring-pattern": "🔁 Padrao recorrente",
    "stale-config": "⚙️ Config incompleta",
    "missing-automation": "🤖 Automacao faltando",
    "stuck-pr": "📦 PR parado",
    "inactive-project": "💤 Projeto inativo",
    "performance": "⏱ Performance",
    "other": "💡 Outra"
  };
  const effortIcon: Record<string, string> = { small: "🟢", medium: "🟡", large: "🔴" };

  const lines: string[] = [`💡 *Sweep de ideias — ${result.ideas.length} ideia${result.ideas.length > 1 ? "s" : ""}*`, ""];
  for (let i = 0; i < result.ideas.length; i++) {
    const idea = result.ideas[i]!;
    const cat = categoryLabel[idea.category] ?? "💡";
    const eff = effortIcon[idea.effort] ?? "•";
    lines.push(`*${i + 1}. ${cat}* ${eff} _(${idea.effort})_`);
    lines.push(`📊 ${idea.signal}`);
    lines.push(`👉 ${idea.suggestion}`);
    lines.push("");
  }
  return lines.join("\n").trim();
};

/**
 * #1: reenvia entregas de ideias que ficaram pendentes (WA offline na hora).
 * Chamado no boot do scheduler e sempre que o WhatsApp reconecta.
 * Best-effort — nao lanca; falhas individuais so incrementam attempts.
 */
export const flushPendingIdeaDeliveries = async (): Promise<number> => {
  if (!isConnected()) return 0;
  const col = await getIdeaDeliveriesCollection();
  const pending = await col.find({ status: "pending" }).sort({ createdAt: 1 }).limit(50).toArray();
  let sent = 0;
  for (const d of pending) {
    try {
      await sendText(d.whatsappJid, d.text);
      await col.updateOne(
        { _id: d._id },
        { $set: { status: "sent", sentAt: new Date() }, $inc: { attempts: 1 } }
      );
      sent++;
    } catch (err) {
      await col.updateOne({ _id: d._id }, { $inc: { attempts: 1 } });
      console.warn("[scheduler] falha ao reenviar ideia pendente:", err);
    }
  }
  if (sent > 0) console.info(`[scheduler] reenviou ${sent} entrega(s) de ideias pendentes`);
  return sent;
};

/** Cleanup de locks orfaos no boot (caso processo tenha morrido segurando lock). */
const releaseStaleLocks = async (): Promise<void> => {
  const col = await getScheduledCollection();
  const expiry = new Date(Date.now() - LOCK_TIMEOUT_MS);
  const r = await col.updateMany(
    { lockedAt: { $lt: expiry } },
    { $unset: { lockedAt: "" } }
  );
  if (r.modifiedCount > 0) {
    console.info(`[scheduler] released ${r.modifiedCount} stale lock(s) on boot`);
  }
};

/** Inicia o tick loop. Idempotente — chamadas repetidas no-op. */
export const startScheduler = async (): Promise<void> => {
  if (started) return;
  started = true;
  await releaseStaleLocks();

  console.info("[scheduler] started (tick=60s)");

  // #1: reenvia entregas pendentes quando o WhatsApp reconectar + tentativa no boot.
  onStatusChange((status) => {
    if (status === "open") {
      void flushPendingIdeaDeliveries().catch(err => console.warn("[scheduler] flush error:", err));
    }
  });
  void flushPendingIdeaDeliveries().catch(err => console.warn("[scheduler] flush boot error:", err));

  // Dispara imediato + a cada minuto
  void tick().catch(err => console.warn("[scheduler] tick error:", err));
  tickHandle = setInterval(() => {
    void tick().catch(err => console.warn("[scheduler] tick error:", err));
  }, TICK_MS);
}

/** Para o loop (uso em teste / shutdown). */
export const stopScheduler = (): void => {
  started = false;
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
};

// ─── CRUD utilitarios pros bot handlers ──────────────────────────

export type CreateScheduleInput = {
  userId?: string;
  description: string;
  kind: "task" | "ideas";
  cron: string;
  timezone?: string;
  projectId?: string;
  whatsappJid?: string;
};

export const createSchedule = async (input: CreateScheduleInput): Promise<ScheduledRecord> => {
  const col = await getScheduledCollection();
  const tz = input.timezone ?? "America/Sao_Paulo";
  const nextRunAt = computeNextRun(input.cron, tz);
  const now = new Date();

  const doc: ScheduledRecord = {
    userId: input.userId,
    description: input.description,
    kind: input.kind,
    cron: input.cron,
    timezone: tz,
    projectId: input.projectId,
    whatsappJid: input.whatsappJid,
    enabled: true,
    nextRunAt: nextRunAt ?? undefined,
    createdAt: now,
    updatedAt: now
  };
  const { insertedId } = await col.insertOne(doc);
  return { ...doc, _id: insertedId };
};

export const listSchedules = async (userId?: string): Promise<ScheduledRecord[]> => {
  const col = await getScheduledCollection();
  const filter: Record<string, unknown> = {};
  if (userId) filter.userId = userId;
  return col.find(filter).sort({ createdAt: -1 }).toArray();
};

/** Remove (ou desabilita) por id ou sufixo. */
export const removeScheduleByIdOrSuffix = async (
  arg: string,
  userId?: string
): Promise<{ ok: true; removed: ScheduledRecord } | { ok: false; reason: string }> => {
  const col = await getScheduledCollection();
  const filter: Record<string, unknown> = {};
  if (userId) filter.userId = userId;

  // Caso 1: ObjectId completo
  if (ObjectId.isValid(arg) && arg.length === 24) {
    const doc = await col.findOneAndDelete({ ...filter, _id: new ObjectId(arg) }, { includeResultMetadata: false });
    if (!doc) return { ok: false, reason: "Schedule nao encontrado." };
    return { ok: true, removed: doc };
  }

  // Caso 2: sufixo
  if (!/^[0-9a-fA-F]{6,23}$/.test(arg)) {
    return { ok: false, reason: "ID invalido." };
  }
  const lower = arg.toLowerCase();
  const matches = await col
    .find({
      ...filter,
      $expr: { $regexMatch: { input: { $toString: "$_id" }, regex: `${lower}$` } }
    } as Record<string, unknown>)
    .limit(2)
    .toArray();
  if (matches.length === 0) return { ok: false, reason: "Nenhum schedule com esse sufixo." };
  if (matches.length > 1) return { ok: false, reason: "Sufixo ambiguo — use mais caracteres." };
  const target = matches[0]!;
  await col.deleteOne({ _id: target._id });
  return { ok: true, removed: target };
};
