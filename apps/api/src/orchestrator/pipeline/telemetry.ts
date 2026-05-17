/**
 * Telemetria de agent calls — plan W1 #3.
 *
 * recordAgentCall e o chokepoint unico chamado nos 6 sites do pipeline
 * (planner, planValidator, code, reviewer, uxCritic, reporter). Persiste:
 *   1. Uma linha em task_executions com provider/model/costUsd alem dos campos existentes
 *   2. Update atomico em TaskRecord.tokenUsage.byProvider[provider] via $inc
 *
 * Tudo wrapped em try/catch — telemetria nunca pode quebrar o pipeline.
 */

import type { ObjectId } from "mongodb";
import { getTasksCollection, getTaskExecutionsCollection } from "../../core/mongo.js";
import type { TokenUsage } from "../types.js";
import { computeCost } from "../routing/pricing.js";
import type { ProviderName } from "../routing/types.js";

export type AgentRole =
  | "planner"
  | "planValidator"
  | "code"
  | "reviewer"
  | "uxCritic"
  | "runtimeVerifier"
  | "reporter";

export type RecordAgentCallParams = {
  taskId: ObjectId;
  subtaskId: string;
  agent: AgentRole;
  provider?: string;
  model?: string;
  usage: TokenUsage;
  durationMs: number;
  success: boolean;
  error?: string;
  input?: unknown;
  output?: unknown;
};

/**
 * Persist one telemetry row + bump byProvider aggregate on TaskRecord.
 *
 * Best-effort: failures here log a warning and return — they never bubble up.
 * Returns the computed costUsd so callers can also attach it to their own
 * structures (e.g., SubTask.costUsd accumulator).
 */
export const recordAgentCall = async (params: RecordAgentCallParams): Promise<number> => {
  const costUsd = computeCost(params.provider as ProviderName | undefined, params.model, params.usage);

  // 1) task_executions row
  try {
    const execCol = await getTaskExecutionsCollection();
    await execCol.insertOne({
      taskId: params.taskId,
      subtaskId: params.subtaskId,
      agent: params.agent,
      input: params.input ?? null,
      output: params.output ?? null,
      success: params.success,
      error: params.error,
      tokenUsage: params.usage,
      elapsedMs: params.durationMs,
      createdAt: new Date(),
      provider: params.provider,
      model: params.model,
      costUsd
    });
  } catch (err) {
    console.warn("[telemetry] recordAgentCall insert failed:", err);
  }

  // 2) bump byProvider aggregate (atomic $inc)
  if (params.provider && (params.usage.inputTokens > 0 || params.usage.outputTokens > 0)) {
    try {
      const tasksCol = await getTasksCollection();
      const providerKey = params.provider;
      await tasksCol.updateOne(
        { _id: params.taskId },
        {
          $inc: {
            [`tokenUsage.byProvider.${providerKey}.tokensIn`]: params.usage.inputTokens,
            [`tokenUsage.byProvider.${providerKey}.tokensOut`]: params.usage.outputTokens,
            [`tokenUsage.byProvider.${providerKey}.costUsd`]: costUsd
          },
          $set: { updatedAt: new Date() }
        }
      );
    } catch (err) {
      console.warn("[telemetry] byProvider $inc failed:", err);
    }
  }

  return costUsd;
};
