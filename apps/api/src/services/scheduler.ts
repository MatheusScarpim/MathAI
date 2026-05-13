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
  type ScheduledRecord
} from "../core/mongo.js";
import { computeNextRun } from "../orchestrator/agents/scheduleParser.js";
import { executeTask } from "../orchestrator/index.js";
import { resolveProjectOptions } from "../helpers/projectOptionsResolver.js";
import { generateIdeas } from "../orchestrator/agents/ideas.js";
import { sendText, isConnected } from "../orchestrator/integrations/whatsapp.js";
import type { TaskExecuteOptions } from "../orchestrator/types.js";

const TICK_MS = 60_000;
/** Lock expira apos 5min — proteção contra processo morto sem liberar. */
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

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

/** Dispatch kind="ideas". Roda generateIdeas e manda resultado via WA. */
const dispatchIdeas = async (rec: ScheduledRecord): Promise<void> => {
  const result = await generateIdeas(rec.userId);

  if (!rec.whatsappJid || !isConnected()) return;

  if (!result.ideas || result.ideas.length === 0) {
    await sendText(rec.whatsappJid, `💡 _Sweep diario:_ nada relevante hoje.`);
    return;
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

  const lines: string[] = [`💡 *Sweep diario — ${result.ideas.length} ideia${result.ideas.length > 1 ? "s" : ""}*`, ""];
  for (let i = 0; i < result.ideas.length; i++) {
    const idea = result.ideas[i]!;
    const cat = categoryLabel[idea.category] ?? "💡";
    const eff = effortIcon[idea.effort] ?? "•";
    lines.push(`*${i + 1}. ${cat}* ${eff} _(${idea.effort})_`);
    lines.push(`📊 ${idea.signal}`);
    lines.push(`👉 ${idea.suggestion}`);
    lines.push("");
  }
  await sendText(rec.whatsappJid, lines.join("\n").trim());
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
