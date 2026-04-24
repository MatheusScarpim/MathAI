import type { FastifyInstance } from "fastify";
import { getHistoryCollection } from "../core/mongo.js";

export default async function statsRoutes(app: FastifyInstance) {
  app.get("/api/stats", async (request, reply) => {
    const query = request.query as { environmentId?: string; days?: string };
    const days = Math.min(Number(query.days) || 30, 90);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const collection = await getHistoryCollection();
    const envFilter = query.environmentId
      ? { environmentId: query.environmentId }
      : {};

    const baseMatch = {
      createdAt: { $gte: since },
      deletedAt: { $exists: false },
      ...envFilter
    };

    // Run all aggregations in parallel
    const [overview, perDay, topErrors, envBreakdown] = await Promise.all([
      // 1. Overview stats
      collection
        .aggregate<{
          totalQueries: number;
          successCount: number;
          cacheHitCount: number;
          avgElapsedMs: number;
          totalInputTokens: number;
          totalOutputTokens: number;
          sqlInputTokens: number;
          sqlOutputTokens: number;
          summaryInputTokens: number;
          summaryOutputTokens: number;
        }>([
          { $match: baseMatch },
          {
            $group: {
              _id: null,
              totalQueries: { $sum: 1 },
              successCount: {
                $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] }
              },
              cacheHitCount: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ["$success", true] },
                        { $gt: ["$tokenUsage.sql.totalTokens", 0] },
                        { $eq: ["$tokenUsage.sql.totalTokens", 0] }
                      ]
                    },
                    1,
                    0
                  ]
                }
              },
              avgElapsedMs: { $avg: { $ifNull: ["$elapsedMs", 0] } },
              totalInputTokens: { $sum: { $ifNull: ["$tokenUsage.total.inputTokens", 0] } },
              totalOutputTokens: { $sum: { $ifNull: ["$tokenUsage.total.outputTokens", 0] } },
              sqlInputTokens: { $sum: { $ifNull: ["$tokenUsage.sql.inputTokens", 0] } },
              sqlOutputTokens: { $sum: { $ifNull: ["$tokenUsage.sql.outputTokens", 0] } },
              summaryInputTokens: { $sum: { $ifNull: ["$tokenUsage.summary.inputTokens", 0] } },
              summaryOutputTokens: { $sum: { $ifNull: ["$tokenUsage.summary.outputTokens", 0] } }
            }
          }
        ])
        .toArray(),

      // 2. Queries per day
      collection
        .aggregate<{ date: string; count: number; errors: number }>([
          { $match: baseMatch },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$createdAt" }
              },
              count: { $sum: 1 },
              errors: {
                $sum: { $cond: [{ $ne: ["$success", true] }, 1, 0] }
              }
            }
          },
          { $sort: { _id: 1 } },
          {
            $project: {
              _id: 0,
              date: "$_id",
              count: 1,
              errors: 1
            }
          }
        ])
        .toArray(),

      // 3. Top errors
      collection
        .aggregate<{ message: string; count: number }>([
          {
            $match: {
              ...baseMatch,
              success: { $ne: true },
              errorMessage: { $type: "string", $ne: "" }
            }
          },
          {
            $group: {
              _id: "$errorMessage",
              count: { $sum: 1 }
            }
          },
          { $sort: { count: -1 } },
          { $limit: 10 },
          {
            $project: {
              _id: 0,
              message: "$_id",
              count: 1
            }
          }
        ])
        .toArray(),

      // 4. Environment breakdown
      collection
        .aggregate<{ envId: string; count: number }>([
          {
            $match: {
              ...baseMatch,
              environmentId: { $type: "string", $ne: "" }
            }
          },
          {
            $group: {
              _id: "$environmentId",
              count: { $sum: 1 }
            }
          },
          { $sort: { count: -1 } },
          {
            $project: {
              _id: 0,
              envId: "$_id",
              count: 1
            }
          }
        ])
        .toArray()
    ]);

    const stats = overview[0];
    const totalQueries = stats?.totalQueries ?? 0;
    const successCount = stats?.successCount ?? 0;
    const cacheHitCount = stats?.cacheHitCount ?? 0;

    reply.send({
      totalQueries,
      successRate: totalQueries > 0 ? Math.round((successCount / totalQueries) * 100) : 0,
      cacheHitRate: totalQueries > 0 ? Math.round((cacheHitCount / totalQueries) * 100) : 0,
      avgElapsedMs: Math.round(stats?.avgElapsedMs ?? 0),
      totalTokens: {
        input: stats?.totalInputTokens ?? 0,
        output: stats?.totalOutputTokens ?? 0,
        total: (stats?.totalInputTokens ?? 0) + (stats?.totalOutputTokens ?? 0)
      },
      tokenBreakdown: {
        sql: {
          input: stats?.sqlInputTokens ?? 0,
          output: stats?.sqlOutputTokens ?? 0,
          total: (stats?.sqlInputTokens ?? 0) + (stats?.sqlOutputTokens ?? 0)
        },
        summary: {
          input: stats?.summaryInputTokens ?? 0,
          output: stats?.summaryOutputTokens ?? 0,
          total: (stats?.summaryInputTokens ?? 0) + (stats?.summaryOutputTokens ?? 0)
        }
      },
      queriesPerDay: perDay,
      topErrors: topErrors,
      environmentBreakdown: envBreakdown,
      days
    });
  });
}
