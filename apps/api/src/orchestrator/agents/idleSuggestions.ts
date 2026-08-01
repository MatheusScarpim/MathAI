/**
 * Coletor de sugestoes para o idle-nudge.
 *
 * Junta duas fontes e faz um "sorteio" (mix variado) pro aviso de ociosidade:
 *  1. Cards Trello EXISTENTES do projeto default do chat (menos os ja concluidos).
 *  2. Ideias de MELHORIA do sistema — analise via codex (generateIdeas preferProvider).
 *
 * Best-effort: se Trello estiver off ou generateIdeas falhar, usa o que tiver.
 * Se nada, retorna [] e o scheduler cai no aviso generico.
 */

import { resolveProjectOptions } from "../../helpers/projectOptionsResolver.js";
import { getBoardCards } from "../integrations/trello.js";
import { generateIdeas } from "./ideas.js";

export type IdleSuggestion = {
  kind: "card" | "idea";
  label: string;
  description: string;
};

/** Embaralhamento leve (Fisher-Yates) pra variar entre avisos. */
const shuffle = <T>(arr: T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

const N = 4;
const MAX_CARDS = 2;
const MAX_IDEAS = 2;

export const buildIdleSuggestions = async (
  projectId: string,
  userId?: string
): Promise<IdleSuggestion[]> => {
  const cards: IdleSuggestion[] = [];
  const ideas: IdleSuggestion[] = [];

  // ── Fonte 1: cards Trello do projeto default ──
  try {
    const opts = await resolveProjectOptions(projectId);
    const boardId = opts?.trello?.boardId;
    const doneListId = opts?.trello?.doneListId;
    if (boardId) {
      const boardCards = await getBoardCards(boardId);
      for (const c of boardCards) {
        if (doneListId && c.idList === doneListId) continue; // pula concluidos
        const name = c.name?.trim();
        if (!name) continue;
        cards.push({
          kind: "card",
          label: name,
          description: `Trabalhar no card do Trello: ${name}`
        });
      }
    }
  } catch (err) {
    console.warn("[idleSuggestions] Trello falhou:", err instanceof Error ? err.message : err);
  }

  // ── Fonte 2: ideias de melhoria (analise via codex) ──
  try {
    const result = await generateIdeas(userId, { preferProvider: "codex" });
    if (!result.failed) {
      for (const idea of result.ideas) {
        const suggestion = idea.suggestion?.trim();
        if (!suggestion) continue;
        ideas.push({
          kind: "idea",
          label: suggestion.length > 60 ? `${suggestion.slice(0, 57)}...` : suggestion,
          description: suggestion
        });
      }
    }
  } catch (err) {
    console.warn("[idleSuggestions] generateIdeas falhou:", err instanceof Error ? err.message : err);
  }

  // ── Sorteio: mix variado, teto ~2 cards + ~2 ideias, corta em N ──
  const pickedCards = shuffle(cards).slice(0, MAX_CARDS);
  const pickedIdeas = shuffle(ideas).slice(0, MAX_IDEAS);
  const mixed = shuffle([...pickedCards, ...pickedIdeas]).slice(0, N);
  return mixed;
};
