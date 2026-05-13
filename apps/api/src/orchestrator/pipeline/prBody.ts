// Builds the rich Pull Request description body that the orchestrator publishes
// after consolidating all github subtasks of a task into a single PR.
//
// Sections (markdown):
//   ## 📋 Tarefa
//   ## 📝 Modificações (table: action | file | subtask)
//   ## ⚙️ Como funcionou (reporter markdown)
//   ## ✅ Subtarefas executadas neste repositório
//   ## 🔗 Outras subtarefas (if any non-github or other-repo subtasks)
//   ---
//   _By MathAI_

import type { SubTask } from "../types.js";

export type ChangeRow = {
  file: string;
  action: string;
  subtaskId: string;
};

export type BuildPrBodyInput = {
  taskDescription: string;
  /** "owner/repo" key identifying which repo this PR is for. */
  repoKey: string;
  /** Github subtasks belonging to THIS repo (ordered as executed). */
  githubSubs: SubTask[];
  /** All other subtasks (non-github, or github of other repo). */
  otherSubs: SubTask[];
  /** Aggregated changes (file + action + subtaskId) for THIS repo. */
  changes: ChangeRow[];
  /** Markdown produced by the reporter (LLM or fallback). */
  reporterMarkdown: string;
};

const STATUS_ICON: Record<string, string> = {
  completed: "✅",
  failed: "❌",
  cancelled: "⛔",
  skipped: "⏭️"
};

const iconFor = (status: string): string => STATUS_ICON[status] ?? "•";

/** Primeira linha da descricao, max 72 chars, sem prefixo emoji. */
export const derivePrTitle = (taskDescription: string): string => {
  const first = (taskDescription.split(/\r?\n/)[0] ?? "").trim();
  const cleaned = first.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const out = cleaned.length ? cleaned : taskDescription.trim();
  return out.length > 72 ? `${out.slice(0, 69).trimEnd()}...` : out;
};

const escapeCell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export const buildPrBody = (input: BuildPrBodyInput): string => {
  const { taskDescription, repoKey, githubSubs, otherSubs, changes, reporterMarkdown } = input;

  const sections: string[] = [];

  // 1) Tarefa
  sections.push(`## 📋 Tarefa`);
  sections.push("");
  sections.push(taskDescription.trim());
  sections.push("");

  // 2) Modificacoes
  if (changes.length > 0) {
    sections.push(`## 📝 Modificações (${changes.length} ${changes.length === 1 ? "arquivo" : "arquivos"})`);
    sections.push("");
    sections.push("| Ação | Arquivo | Subtarefa |");
    sections.push("| --- | --- | --- |");
    for (const c of changes) {
      sections.push(`| \`${escapeCell(c.action)}\` | \`${escapeCell(c.file)}\` | ${escapeCell(c.subtaskId)} |`);
    }
    sections.push("");
  }

  // 3) Como funcionou (reporter markdown)
  const reporter = reporterMarkdown.trim();
  if (reporter) {
    sections.push(`## ⚙️ Como funcionou`);
    sections.push("");
    sections.push(reporter);
    sections.push("");
  }

  // 4) Subtarefas deste repositorio
  if (githubSubs.length > 0) {
    sections.push(`## ✅ Subtarefas executadas neste repositório (\`${repoKey}\`)`);
    sections.push("");
    for (const s of githubSubs) {
      const err = s.error ? ` — ${s.error}` : "";
      sections.push(`- ${iconFor(s.status)} **${s.id}**: ${s.description}${err}`);
    }
    sections.push("");
  }

  // 5) Outras subtarefas (contexto)
  if (otherSubs.length > 0) {
    sections.push(`## 🔗 Outras subtarefas desta tarefa`);
    sections.push("");
    for (const s of otherSubs) {
      const err = s.error ? ` — ${s.error}` : "";
      sections.push(`- ${iconFor(s.status)} **${s.id}** (${s.type}): ${s.description}${err}`);
    }
    sections.push("");
  }

  // 6) Footer fixo
  sections.push("---");
  sections.push("");
  sections.push("_By MathAI_");

  return sections.join("\n");
};
