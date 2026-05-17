/**
 * PR conflict detection — plan #8.
 *
 * Antes de executar uma subtask github, varre OUTRAS tasks executing/awaiting
 * no MESMO repo e ve se ha overlap de paths editados. Se overlap > THRESHOLD,
 * emite warning `conflict_detected`. v1 = warn only, sem hard gate.
 *
 * Heuristica simples:
 *   - Para tasks running: lista changes.file dos subtask.result.changes
 *   - Overlap = |intersect(meu_planned, deles_atual)| / |meu_planned|
 *   - Threshold default 0.3 (30%)
 *
 * Tudo best-effort: erros silenciam (Mongo unavailable -> skip).
 */

import { ObjectId } from "mongodb";
import { getTasksCollection } from "../../core/mongo.js";

export type ConflictReport = {
  /** Outra task com overlap. */
  conflictingTaskId: string;
  /** Status da outra task ("executing" / "awaiting_approval"). */
  conflictingStatus: string;
  /** Arquivos em overlap (max 10). */
  overlappingFiles: string[];
  /** % overlap (0-1). */
  ratio: number;
};

const OVERLAP_RATIO_THRESHOLD = 0.3;

/**
 * Detecta conflitos potenciais antes de uma task ou subtask github.
 *
 * @param myFiles paths que esta task planeja editar (ou pode editar)
 * @param myTaskId taskId atual (excluido da busca)
 * @param repoKey "owner/repo" — escopo da varredura
 */
export const detectPRConflicts = async (
  myFiles: string[],
  myTaskId: string,
  repoKey: string
): Promise<ConflictReport[]> => {
  if (myFiles.length === 0) return [];
  try {
    const col = await getTasksCollection();
    // Tasks ativas no mesmo repo (subtasks com resolvedRepoKey === repoKey)
    const myOid = ObjectId.isValid(myTaskId) ? new ObjectId(myTaskId) : null;
    const candidates = await col.find({
      ...(myOid ? { _id: { $ne: myOid } } : {}),
      status: { $in: ["executing", "planning", "awaiting_approval"] },
      "subtasks.resolvedRepoKey": repoKey
    }).limit(20).toArray().catch(() => []);

    const mySet = new Set(myFiles.map(normalize));
    const reports: ConflictReport[] = [];

    for (const t of candidates) {
      if (t._id?.toString() === myTaskId) continue;
      const theirFiles: string[] = [];
      for (const s of (t.subtasks ?? [])) {
        if (s.resolvedRepoKey !== repoKey) continue;
        const r = s.result as { changes?: Array<{ file?: string }> } | undefined;
        if (r?.changes) {
          for (const c of r.changes) {
            if (typeof c.file === "string") theirFiles.push(normalize(c.file));
          }
        }
      }
      if (theirFiles.length === 0) continue;
      const intersect = theirFiles.filter(f => mySet.has(f));
      if (intersect.length === 0) continue;
      const ratio = intersect.length / mySet.size;
      if (ratio >= OVERLAP_RATIO_THRESHOLD) {
        reports.push({
          conflictingTaskId: t._id!.toString(),
          conflictingStatus: t.status,
          overlappingFiles: Array.from(new Set(intersect)).slice(0, 10),
          ratio
        });
      }
    }

    // Ordena por ratio desc
    reports.sort((a, b) => b.ratio - a.ratio);
    return reports;
  } catch (err) {
    console.warn("[conflict-detect] failed:", err);
    return [];
  }
};

/** Exportado para testes (G10). Backslash -> slash + tira "./" + lowercase. */
export const normalize = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
