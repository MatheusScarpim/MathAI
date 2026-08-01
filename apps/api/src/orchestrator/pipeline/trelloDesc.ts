// Builds the Trello completion COMMENT posted on the task card when a task
// reaches a terminal status (completed or failed). Posted as a comment (not a
// description overwrite) so the card's original description + `mathai:<taskId>`
// marker stay intact for findCardByMarker dedup on re-runs.
//
// Sections (markdown):
//   ✅ Completed | ❌ Failed   (status header)
//   ## 🔗 Pull Requests
//   ## 📝 Resumo (if available)
//   _By MathAI_

import type { TaskStatus } from "../types.js";

export type BuildTrelloCompletionCommentInput = {
  finalStatus: TaskStatus;
  summary?: string;
  prUrls: string[];
};

const STATUS_HEADER: Partial<Record<TaskStatus, string>> = {
  completed: "✅ **Completed**",
  failed: "❌ **Failed**",
  cancelled: "⛔ **Cancelled**"
};

export const buildTrelloCompletionComment = (input: BuildTrelloCompletionCommentInput): string => {
  const { finalStatus, summary, prUrls } = input;
  const sections: string[] = [];

  sections.push(STATUS_HEADER[finalStatus] ?? `• **${finalStatus}**`);
  sections.push("");

  sections.push("## 🔗 Pull Requests");
  sections.push("");
  if (prUrls.length > 0) {
    for (const url of prUrls) sections.push(`- ${url}`);
  } else {
    sections.push("_Nenhum PR aberto_");
  }
  sections.push("");

  const trimmedSummary = summary?.trim();
  if (trimmedSummary) {
    sections.push("## 📝 Resumo");
    sections.push("");
    sections.push(trimmedSummary);
    sections.push("");
  }

  sections.push("_By MathAI_");

  // Comentarios do Trello aceitam ate 16384 chars.
  return sections.join("\n").slice(0, 16384);
};
