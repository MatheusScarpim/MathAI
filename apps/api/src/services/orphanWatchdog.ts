/**
 * Orphan task watchdog — plan #6.
 *
 * tsx watch reload mid-pipeline orfaniza tasks em `status="executing"`
 * (memory feedback_hot_reload_kills_inflight_tasks). Este watchdog:
 *
 *   1. Boot scan: ao subir o servidor, marca como `failed` qualquer task
 *      `executing` cujo `heartbeatAt` esta mais velho que ORPHAN_THRESHOLD_MS.
 *   2. Runtime tick: a cada WATCHDOG_TICK_MS, repete o scan.
 *
 * A coluna `heartbeatAt` e atualizada pelo pipeline em cada `setStage` +
 * em cada `executing_subtask` emit. Se o processo morre, ela para de subir
 * e o watchdog detecta.
 */

import { getTasksCollection } from "../core/mongo.js";

const ORPHAN_THRESHOLD_MS = 5 * 60_000;   // 5min sem heartbeat
const WATCHDOG_TICK_MS = 60_000;          // re-scan a cada 1min

const ORPHAN_ERROR = "orphaned_by_reload";

/**
 * Varre tasks executing/planning sem heartbeat fresh. Marca como failed.
 * Retorna quantas foram marcadas.
 */
export const scanOrphans = async (): Promise<number> => {
  try {
    const col = await getTasksCollection();
    const cutoff = new Date(Date.now() - ORPHAN_THRESHOLD_MS);
    const result = await col.updateMany(
      {
        status: { $in: ["executing", "planning"] },
        $or: [
          { heartbeatAt: { $lt: cutoff } },
          // Tasks antigas pre-feature #6 nao tem heartbeatAt — usa createdAt
          // como fallback (>5min sem nenhum sinal = orfa).
          { heartbeatAt: { $exists: false }, createdAt: { $lt: cutoff } }
        ]
      },
      {
        $set: {
          status: "failed",
          currentStage: "done",
          error: ORPHAN_ERROR,
          completedAt: new Date(),
          updatedAt: new Date()
        }
      }
    );
    if (result.modifiedCount > 0) {
      console.warn(`[orphan-watchdog] marcou ${result.modifiedCount} task(s) como failed (orphaned)`);
    }
    return result.modifiedCount ?? 0;
  } catch (err) {
    console.warn("[orphan-watchdog] scan failed:", err);
    return 0;
  }
};

let watchdogTimer: NodeJS.Timeout | null = null;

/**
 * G7 — re-enfileira tasks que ficaram em status="pending" depois de um reboot.
 * Sem isto, o queue in-memory perde a fila e tasks ficam invisivelmente paradas.
 *
 * Estrategia: para cada task pending, dispara executeTask em background com
 * presetSubtasks=[] (vai re-rodar planner naturalmente) — mas via existingTaskId
 * pra reusar o _id (depende do G6). Reuso defensivo: tasks ja com subtasks
 * persistidas viram preset; sem subtasks, replannamos.
 */
export const requeuePendingTasks = async (): Promise<number> => {
  try {
    const col = await getTasksCollection();
    const pendings = await col.find({ status: "pending" }).limit(50).toArray();
    if (pendings.length === 0) return 0;

    // Lazy import pra evitar ciclo (pipeline importa orphanWatchdog indiretamente).
    const { executeTask } = await import("../orchestrator/pipeline/index.js");

    let dispatched = 0;
    for (const t of pendings) {
      const taskId = t._id!.toString();
      const presetSubtasks = (t.subtasks ?? []).map(s => ({
        id: s.id,
        type: s.type,
        description: s.description,
        priority: s.priority,
        dependsOn: s.dependsOn ?? [],
        repo: s.repo
      }));
      const opts: Parameters<typeof executeTask>[1] = {
        userId: t.userId,
        projectId: t.projectId,
        language: t.language,
        existingTaskId: taskId,
        ...(presetSubtasks.length > 0 ? { presetSubtasks } : {})
      };
      void executeTask(t.description, opts).catch(err => {
        console.warn(`[orphan-watchdog] requeue task=${taskId} failed:`, err);
      });
      dispatched++;
    }
    if (dispatched > 0) {
      console.info(`[orphan-watchdog] re-enfileirou ${dispatched} task(s) pending no boot`);
    }
    return dispatched;
  } catch (err) {
    console.warn("[orphan-watchdog] requeuePendingTasks failed:", err);
    return 0;
  }
};

/**
 * Inicia o watchdog (boot scan + interval). Idempotente — chamado uma vez no boot.
 */
export const startOrphanWatchdog = (): void => {
  if (watchdogTimer) return;
  // Boot scan: orfaos + re-enfileira pendings (G7)
  void scanOrphans().catch(() => {/* swallow */});
  void requeuePendingTasks().catch(() => {/* swallow */});
  // Interval
  watchdogTimer = setInterval(() => {
    void scanOrphans().catch(() => {/* swallow */});
  }, WATCHDOG_TICK_MS);
  // Evita o interval bloquear shutdown
  if (typeof watchdogTimer.unref === "function") watchdogTimer.unref();
  console.info(`[orphan-watchdog] started (tick=${WATCHDOG_TICK_MS / 1000}s, threshold=${ORPHAN_THRESHOLD_MS / 1000}s)`);
};

export const stopOrphanWatchdog = (): void => {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
};
