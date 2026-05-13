// Builds the Trello card description used when a task reaches a terminal status
// (completed or failed). Preserves the `mathai:<taskId>` marker at the end so
// `findCardByMarker` continues to dedupe on re-runs.
//
// Sections (markdown):
//   ✅ Completed | ❌ Failed   (status header)
//   <taskDescription>
//   ## 🔗 Pull Requests
//   ## 📝 Resumo (if available)
//   ---
//   🤖 mathai:<taskId>
//   _By MathAI_

import type { TaskStatus } from "../types.js";
import { buildTaskCardMarker } from "../integrations/trello.js";

export type BuildTrelloCompletionDescInput = {
  description: string;
  finalStatus: TaskStatus;
  summary?: string;
  prUrls: string[];
  taskId: string;
};

const STATUS_HEADER: Partial<Record<TaskStatus, string>> = {
  completed: "✅ **Completed**",
  failed: "❌ **Failed**",
  cancelled: "⛔ **Cancelled**"
};

export const buildTrelloCompletionDesc = (input: BuildTrelloCompletionDescInput): string => {
  const { description, finalStatus, summary, prUrls, taskId } = input;
  const sections: string[] = [];

  // 1) Status header
  sections.push(STATUS_HEADER[finalStatus] ?? `• **${finalStatus}**`);
  sections.push("");

  // 2) Task description
  sections.push(description.trim());
  sections.push("");

  // 3) Pull Requests
  sections.push("## 🔗 Pull Requests");
  sections.push("");
  if (prUrls.length > 0) {
    for (const url of prUrls) {
      sections.push(`- ${url}`);
    }
  } else {
    sections.push("_Nenhum PR aberto_");
  }
  sections.push("");

  // 4) Resumo (opcional)
  const trimmedSummary = summary?.trim();
  if (trimmedSummary) {
    sections.push("## 📝 Resumo");
    sections.push("");
    sections.push(trimmedSummary);
    sections.push("");
  }

  // 5) Footer com marker (preserva idempotencia do findCardByMarker)
  sections.push("---");
  sections.push("");
  sections.push(`🤖 ${buildTaskCardMarker(taskId)}`);
  sections.push("");
  sections.push("_By MathAI_");

  return sections.join("\n");
};
