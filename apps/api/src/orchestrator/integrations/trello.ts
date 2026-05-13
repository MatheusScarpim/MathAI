import { config } from "../../core/config.js";
import { getIntegrationsSettings } from "../../helpers/settings.js";

const TRELLO_BASE = "https://api.trello.com/1";

type TrelloParams = Record<string, string>;

/**
 * Resolve as credenciais do Trello: prefere o que foi salvo via UI (MongoDB,
 * em integrations settings) e cai pro env como fallback. Sem cache — toda
 * chamada relê pra refletir mudancas em tempo real.
 */
export const getTrelloCredentials = async (): Promise<{ apiKey: string; apiToken: string }> => {
  const settings = await getIntegrationsSettings().catch(() => null);
  return {
    apiKey: settings?.trelloApiKey || config.trello.apiKey,
    apiToken: settings?.trelloApiToken || config.trello.apiToken
  };
};

const trelloFetch = async <T = unknown>(
  method: string,
  path: string,
  params?: TrelloParams,
  body?: unknown
): Promise<T> => {
  const { apiKey, apiToken } = await getTrelloCredentials();
  if (!apiKey || !apiToken) {
    throw new Error("Trello nao configurado (apiKey/apiToken ausentes).");
  }
  const url = new URL(`${TRELLO_BASE}${path}`);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("token", apiToken);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trello API ${method} ${path} falhou (${res.status}): ${text}`);
  }

  return res.json() as Promise<T>;
};

/* ── Boards ──────────────────────────────────────────────────────── */

export type TrelloBoard = { id: string; name: string; url: string };
export type TrelloList = { id: string; name: string; idBoard: string };
export type TrelloCard = {
  id: string;
  name: string;
  desc: string;
  url: string;
  idList: string;
  idBoard?: string;
};

export const getBoards = (): Promise<TrelloBoard[]> =>
  trelloFetch("GET", "/members/me/boards", { fields: "name,url" });

export const getBoardLists = (boardId: string): Promise<TrelloList[]> =>
  trelloFetch("GET", `/boards/${boardId}/lists`);

/** Marker pra card de subtask (1 por subtask github separada que o planner gerar). */
export const buildCardMarker = (taskId: string, subtaskId: string): string =>
  `mathai:${taskId}/${subtaskId}`;

/** Marker pra card que representa a TASK inteira (toggle Trello on cria 1 desses por task). */
export const buildTaskCardMarker = (taskId: string): string =>
  `mathai:${taskId}`;

/**
 * findOrCreate: garante que existe um card no Trello representando a task.
 * Se ja existir (re-run), reusa. Senao cria na primeira lista do board (ou listId override).
 *
 * Retorna { id, url } do card. Lanca em erro de rede/credencial.
 */
export const ensureTaskCard = async (input: {
  boardId: string;
  listId?: string;
  taskId: string;
  name: string;
  desc: string;
}): Promise<{ id: string; url: string }> => {
  const marker = buildTaskCardMarker(input.taskId);

  // 1) Tentar encontrar card existente
  const existing = await findCardByMarker(input.boardId, marker).catch(() => null);
  if (existing) {
    return { id: existing.id, url: existing.url };
  }

  // 2) Resolver lista alvo
  let targetListId = input.listId;
  if (!targetListId) {
    const lists = await getBoardLists(input.boardId);
    targetListId = lists[0]?.id;
    if (!targetListId) throw new Error("Board sem listas — nao da pra criar card");
  }

  // 3) Criar card com marker discreto no desc
  const desc = [
    input.desc.trim(),
    "",
    "---",
    `🤖 ${marker}`
  ].join("\n");

  const card = await createCard(targetListId, input.name, desc);
  return { id: card.id, url: card.url };
};

/**
 * Busca um card que contenha o marker no desc, em qualquer lista do board.
 * Retorna null se nao encontrar.
 *
 * Usa a search API do Trello e re-valida o desc client-side, pois search
 * faz match parcial e pode trazer falsos positivos.
 */
export const findCardByMarker = async (
  boardId: string,
  marker: string
): Promise<TrelloCard | null> => {
  const res = await trelloFetch<{ cards?: TrelloCard[] }>("GET", "/search", {
    query: marker,
    modelTypes: "cards",
    idBoards: boardId,
    card_fields: "name,desc,url,idList,idBoard",
    cards_limit: "10"
  });
  for (const c of res.cards ?? []) {
    if (typeof c.desc === "string" && c.desc.includes(marker)) {
      return c;
    }
  }
  return null;
};

/* ── Cards ───────────────────────────────────────────────────────── */

export const createCard = (
  listId: string,
  name: string,
  desc?: string,
  labelIds?: string[],
  dueDate?: string
): Promise<TrelloCard> =>
  trelloFetch("POST", "/cards", {
    idList: listId,
    name,
    ...(desc ? { desc } : {}),
    ...(labelIds?.length ? { idLabels: labelIds.join(",") } : {}),
    ...(dueDate ? { due: dueDate } : {})
  });

export const updateCard = (
  cardId: string,
  updates: TrelloParams
): Promise<TrelloCard> =>
  trelloFetch("PUT", `/cards/${cardId}`, updates);

export const moveCard = (cardId: string, listId: string): Promise<TrelloCard> =>
  updateCard(cardId, { idList: listId });

/* ── Checklists ──────────────────────────────────────────────────── */

export type TrelloChecklist = { id: string; name: string; idCard: string };

export const createChecklist = (
  cardId: string,
  name: string
): Promise<TrelloChecklist> =>
  trelloFetch("POST", "/checklists", { idCard: cardId, name });

export const addChecklistItem = (
  checklistId: string,
  name: string,
  checked?: boolean
): Promise<{ id: string; name: string; state: string }> =>
  trelloFetch("POST", `/checklists/${checklistId}/checkItems`, {
    name,
    ...(checked ? { checked: "true" } : {})
  });

/* ── Labels ──────────────────────────────────────────────────────── */

export type TrelloLabel = { id: string; name: string; color: string };

export const getBoardLabels = (boardId: string): Promise<TrelloLabel[]> =>
  trelloFetch("GET", `/boards/${boardId}/labels`);

/* ── Webhooks ────────────────────────────────────────────────────── */

export type TrelloWebhook = { id: string; callbackURL: string; idModel: string };

export const createWebhook = (
  modelId: string,
  callbackUrl: string,
  description?: string
): Promise<TrelloWebhook> =>
  trelloFetch("POST", "/webhooks", {
    idModel: modelId,
    callbackURL: callbackUrl,
    ...(description ? { description } : {})
  });

export const deleteWebhook = (webhookId: string): Promise<void> =>
  trelloFetch("DELETE", `/webhooks/${webhookId}`);
