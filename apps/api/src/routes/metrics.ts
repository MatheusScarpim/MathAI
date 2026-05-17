/**
 * Quality metrics endpoint — plan #11.
 *
 * Agrega `task_executions` + `tasks` em metricas operacionais que respondem:
 *   - Agente esta piorando ou melhorando?
 *   - Qual provider gera mais retry / mais custo / mais erro?
 *   - Tempo medio por stage do pipeline?
 *
 * Janela default: 7d. Configuravel via ?since=Nd ou ?since=Nh.
 */

import type { FastifyInstance } from "fastify";
import { getTasksCollection, getTaskExecutionsCollection } from "../core/mongo.js";

type SinceUnit = "h" | "d";

const parseSince = (s: string | undefined): Date => {
  const fallback = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  if (!s) return fallback;
  const m = /^(\d+)([hd])$/.exec(s.trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = m[2] as SinceUnit;
  const mult = unit === "h" ? 60 * 60_000 : 24 * 60 * 60_000;
  return new Date(Date.now() - n * mult);
};

export default async function metricsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { since?: string } }>(
    "/api/metrics/quality",
    {
      schema: {
        tags: ["metrics"],
        summary: "Metricas de qualidade do orquestrador (taxa de sucesso, retry, custo por provider).",
        querystring: {
          type: "object",
          properties: {
            since: { type: "string", description: "Janela (ex: 7d, 24h). Default: 7d." }
          }
        }
      }
    },
    async (request, reply) => {
      const since = parseSince(request.query.since);
      const tasksCol = await getTasksCollection();
      const execCol = await getTaskExecutionsCollection();

      // 1) Tasks no periodo — outcome (success/failed/orphaned/cancelled) + counts
      const tasksAgg = await tasksCol.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $project: {
            status: 1,
            error: 1,
            replanCount: { $ifNull: ["$replanCount", 0] },
            subtaskCount: { $size: { $ifNull: ["$subtasks", []] } },
            failedSubtasks: {
              $size: {
                $filter: {
                  input: { $ifNull: ["$subtasks", []] },
                  as: "s",
                  cond: { $eq: ["$$s.status", "failed"] }
                }
              }
            },
            cancelledSubtasks: {
              $size: {
                $filter: {
                  input: { $ifNull: ["$subtasks", []] },
                  as: "s",
                  cond: { $eq: ["$$s.status", "cancelled"] }
                }
              }
            },
            durationMs: {
              $cond: [
                { $and: [{ $ne: ["$completedAt", null] }, { $ne: ["$createdAt", null] }] },
                { $subtract: ["$completedAt", "$createdAt"] },
                null
              ]
            }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
            orphaned: {
              $sum: { $cond: [{ $eq: ["$error", "orphaned_by_reload"] }, 1, 0] }
            },
            cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
            replanned: { $sum: { $cond: [{ $gt: ["$replanCount", 0] }, 1, 0] } },
            avgDurationMs: { $avg: "$durationMs" },
            totalSubtasks: { $sum: "$subtaskCount" },
            totalFailedSubtasks: { $sum: "$failedSubtasks" },
            totalCancelledSubtasks: { $sum: "$cancelledSubtasks" }
          }
        }
      ]).toArray();

      const t = tasksAgg[0] ?? {
        total: 0, completed: 0, failed: 0, orphaned: 0, cancelled: 0,
        replanned: 0, avgDurationMs: 0, totalSubtasks: 0,
        totalFailedSubtasks: 0, totalCancelledSubtasks: 0
      };

      // G4: reverted_rate via task_executions.reverted=true (set por rollback)
      const revertedTaskIds = await execCol.distinct("taskId", {
        createdAt: { $gte: since },
        reverted: true
      }).catch(() => []);
      const revertedCount = revertedTaskIds.length;
      const revertedRate = t.completed > 0 ? revertedCount / t.completed : 0;

      const successRate = t.total > 0 ? t.completed / t.total : 0;
      const orphanRate = t.total > 0 ? t.orphaned / t.total : 0;
      const replanRate = t.total > 0 ? t.replanned / t.total : 0;
      const subtaskSuccessRate = t.totalSubtasks > 0
        ? (t.totalSubtasks - t.totalFailedSubtasks - t.totalCancelledSubtasks) / t.totalSubtasks
        : 0;

      // 2) Breakdown por (agent, provider) — calls + cost + duration medio
      const agentAgg = await execCol.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { agent: "$agent", provider: { $ifNull: ["$provider", "unknown"] } },
            calls: { $sum: 1 },
            failures: { $sum: { $cond: ["$success", 0, 1] } },
            tokensIn: { $sum: { $ifNull: ["$tokenUsage.inputTokens", 0] } },
            tokensOut: { $sum: { $ifNull: ["$tokenUsage.outputTokens", 0] } },
            costUsd: { $sum: { $ifNull: ["$costUsd", 0] } },
            avgDurationMs: { $avg: "$elapsedMs" }
          }
        },
        { $sort: { costUsd: -1 } },
        { $limit: 50 }
      ]).toArray();

      const byAgentProvider = agentAgg.map(r => ({
        agent: r._id.agent,
        provider: r._id.provider,
        calls: r.calls,
        failures: r.failures,
        failureRate: r.calls > 0 ? r.failures / r.calls : 0,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        costUsd: r.costUsd,
        avgDurationMs: Math.round(r.avgDurationMs ?? 0)
      }));

      // 3) Total agregado por provider (independente do agent)
      const providerAgg = await execCol.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $ifNull: ["$provider", "unknown"] },
            calls: { $sum: 1 },
            failures: { $sum: { $cond: ["$success", 0, 1] } },
            costUsd: { $sum: { $ifNull: ["$costUsd", 0] } }
          }
        },
        { $sort: { costUsd: -1 } }
      ]).toArray();

      const byProvider = providerAgg.map(r => ({
        provider: r._id,
        calls: r.calls,
        failures: r.failures,
        failureRate: r.calls > 0 ? r.failures / r.calls : 0,
        costUsd: r.costUsd
      }));

      // 4) Top errors — agrupa por error message slice(:80) das tasks failed
      const topErrors = await tasksCol.aggregate([
        { $match: { createdAt: { $gte: since }, status: "failed", error: { $exists: true } } },
        { $project: { errKey: { $substrCP: [{ $ifNull: ["$error", ""] }, 0, 80] } } },
        { $group: { _id: "$errKey", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]).toArray();

      reply.send({
        since: since.toISOString(),
        windowDays: Math.round((Date.now() - since.getTime()) / (24 * 60 * 60_000) * 10) / 10,
        tasks: {
          total: t.total,
          completed: t.completed,
          failed: t.failed,
          orphaned: t.orphaned,
          cancelled: t.cancelled,
          replanned: t.replanned,
          reverted: revertedCount,
          successRate,
          orphanRate,
          replanRate,
          revertedRate,
          avgDurationMs: Math.round(t.avgDurationMs ?? 0)
        },
        subtasks: {
          total: t.totalSubtasks,
          failed: t.totalFailedSubtasks,
          cancelled: t.totalCancelledSubtasks,
          successRate: subtaskSuccessRate
        },
        byAgentProvider,
        byProvider,
        topErrors: topErrors.map(e => ({ message: e._id || "(empty)", count: e.count }))
      });
    }
  );
}
