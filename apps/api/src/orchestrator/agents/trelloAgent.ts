/**
 * Agente Trello — a cada stage do pipeline, um LLM ve as colunas do board + o
 * estado atual do card e decide autonomamente o que fazer: mover pra outra
 * coluna, comentar o progresso, aplicar um label. Padrao de tool-use loop
 * (espelha uxCritic): tools contra a Trello API + finish_trello terminator.
 *
 * Best-effort: chamado fire-and-forget do setStage; qualquer falha e swallowed
 * (so loga). Nunca quebra o pipeline.
 */

import type { ObjectId } from "mongodb";
import { getClient } from "../../core/openai.js";
import { getTasksCollection } from "../../core/mongo.js";
import { selectRoute, markProviderDown } from "../routing/router.js";
import { ZERO_USAGE, toTokenUsage, type TokenUsage, type TaskStage } from "../types.js";
import { withRetry } from "./withRetry.js";
import { recordAgentCall } from "../pipeline/telemetry.js";
import {
  getBoardLists,
  getBoardCards,
  getBoardLabels,
  getCard,
  getCardChecklists,
  moveCard,
  addComment,
  addLabelToCard,
  createCard,
  updateCard,
  createChecklist,
  addChecklistItem
} from "../integrations/trello.js";

export type TrelloAgentInput = {
  taskId: ObjectId;
  stage: TaskStage;
  taskDescription: string;
  boardId: string;
  cardId: string;
  /** Se true, o agente pode criar NOVOS cards no board (default false — evita flood). */
  allowCreateCards?: boolean;
  language?: "pt" | "en" | "es";
};

export type TrelloAgentResult = {
  actions: { tool: string; ok: boolean; summary: string }[];
  usage: TokenUsage;
  skipped: boolean;
  reason?: string;
  iterations: number;
};

const MAX_ITERATIONS = 4;
const MAX_PROVIDER_ATTEMPTS = 3;
const MAX_CARDS_CREATED = 5; // teto POR-TASK (acumulado entre stages) — nunca floodar o board
const CHECKLIST_NAME = "MathAI Progresso";

type ToolSchema = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

const buildToolsSchema = (allowCreateCards: boolean): ToolSchema[] => {
  const tools: ToolSchema[] = [
    {
      type: "function",
      function: {
        name: "move_card",
        description: "Move o card pra outra coluna (lista) do board. Use quando o stage atual corresponder melhor a outra coluna.",
        parameters: {
          type: "object",
          properties: { listId: { type: "string", description: "id da coluna destino (das colunas fornecidas)" } },
          required: ["listId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "comment_card",
        description: "Adiciona um comentario curto ao card informando o progresso do stage atual.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "texto do comentario (1-2 frases)" } },
          required: ["text"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "apply_label",
        description: "Aplica um label existente ao card. Use so se um label fizer sentido pro stage.",
        parameters: {
          type: "object",
          properties: { labelId: { type: "string", description: "id do label (dos labels fornecidos)" } },
          required: ["labelId"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "append_card_desc",
        description: "Anexa um trecho ao final da descricao do card (nao sobrescreve o conteudo existente). Use pra registrar contexto/decisoes/novos requisitos que surgiram.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "texto a anexar (markdown curto)" } },
          required: ["text"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "add_checklist_item",
        description: `Adiciona um item na checklist "${CHECKLIST_NAME}" do card (cria a checklist se nao existir). Use pra registrar sub-passos/pendencias como itens marcaveis. NAO duplique itens ja existentes.`,
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "texto do item de checklist" },
            checked: { type: "boolean", description: "true se ja esta concluido" }
          },
          required: ["text"]
        }
      }
    }
  ];

  if (allowCreateCards) {
    tools.push({
      type: "function",
      function: {
        name: "create_card",
        description: "Cria um NOVO card no board. Use APENAS quando surgir um trabalho/escopo claramente separado que merece card proprio (ex: um bug descoberto, uma subtarefa grande). NAO crie card pra cada detalhe — prefira checklist/comentario. Teto de 5 cards por task.",
        parameters: {
          type: "object",
          properties: {
            listId: { type: "string", description: "id da coluna onde criar (das colunas fornecidas)" },
            name: { type: "string", description: "titulo do card (curto)" },
            desc: { type: "string", description: "descricao do card (opcional)" }
          },
          required: ["listId", "name"]
        }
      }
    });
  }

  tools.push({
    type: "function",
    function: {
      name: "finish_trello",
      description: "Encerra — nenhuma acao adicional necessaria neste stage.",
      parameters: { type: "object", properties: {} }
    }
  });

  return tools;
};

const STAGE_HINT: Record<TaskStage, string> = {
  planning: "planejamento (planner analisando/decompondo a task)",
  coding: "codificacao (agentes implementando as subtasks)",
  reviewing: "revisao de codigo (reviewer/critic avaliando)",
  reporting: "geracao do relatorio final + PR",
  done: "task concluida"
};

const buildSystemPrompt = (language: string, allowCreateCards: boolean): string =>
  `Voce e um gerente de board Trello autonomo do orquestrador MathAI. ` +
  `A cada etapa do pipeline voce recebe as colunas do board, o estado atual do card, suas checklists e o stage corrente. ` +
  `Sua funcao: manter o card refletindo o progresso real. Aja com parcimonia — ` +
  `mova o card SO se houver uma coluna claramente mais adequada ao stage atual (ex: coluna "Doing"/"Em progresso" durante coding, "Review" durante reviewing, "Done" quando done). ` +
  `Comente SO informacoes uteis e curtas. Use append_card_desc pra registrar contexto/decisoes/novos requisitos duradouros, e add_checklist_item pra sub-passos/pendencias marcaveis. ` +
  `NAO repita acoes ja feitas (veja as checklists e o card atual) nem duplique itens de checklist. ` +
  (allowCreateCards
    ? `Voce PODE criar novos cards (create_card) SO quando surgir um trabalho claramente separado que merece card proprio; prefira checklist/comentario pra detalhes. ` +
      `ANTES de criar, confira a lista "CARDS JA EXISTENTES NO BOARD": se ja existe um card com proposito equivalente (mesmo que o titulo seja diferente), NAO crie outro — voce provavelmente ja o criou num stage anterior. `
    : `Voce NAO pode criar novos cards neste board. `) +
  `Se nada for necessario, chame finish_trello imediatamente. ` +
  `Responda sempre em ${language === "en" ? "ingles" : language === "es" ? "espanhol" : "portugues"}.`;

const buildUserPrompt = (
  input: TrelloAgentInput,
  columns: { id: string; name: string }[],
  labels: { id: string; name: string; color: string }[],
  card: { name: string; currentListName?: string; currentListId?: string },
  checklists: { name: string; checkItems: { name: string; state: string }[] }[],
  boardCards: { name: string; listName: string }[]
): string => {
  const cols = columns.map(c => `- ${c.name} (id: ${c.id})`).join("\n") || "(nenhuma)";
  const existing = boardCards.length
    ? boardCards.map(c => `- "${c.name}" [${c.listName}]`).join("\n")
    : "(board vazio)";
  const labs = labels.length
    ? labels.map(l => `- ${l.name || "(sem nome)"} [${l.color}] (id: ${l.id})`).join("\n")
    : "(nenhum label no board)";
  const cls = checklists.length
    ? checklists
        .map(cl => {
          const items = cl.checkItems.length
            ? cl.checkItems.map(i => `    - [${i.state === "complete" ? "x" : " "}] ${i.name}`).join("\n")
            : "    (vazia)";
          return `- ${cl.name}:\n${items}`;
        })
        .join("\n")
    : "(nenhuma checklist no card)";
  return [
    `STAGE ATUAL: ${input.stage} — ${STAGE_HINT[input.stage]}`,
    ``,
    `TASK: ${input.taskDescription.slice(0, 400)}`,
    ``,
    `CARD: "${card.name}"`,
    `COLUNA ATUAL: ${card.currentListName ?? "(desconhecida)"} (id: ${card.currentListId ?? "?"})`,
    ``,
    `CHECKLISTS ATUAIS DO CARD:`,
    cls,
    ``,
    `COLUNAS DISPONIVEIS:`,
    cols,
    ``,
    `LABELS DISPONIVEIS:`,
    labs,
    ``,
    `CARDS JA EXISTENTES NO BOARD (NAO crie um card com proposito equivalente a nenhum destes):`,
    existing,
    ``,
    `Decida as acoes necessarias pra este stage e execute (nao repita o que ja esta feito). Encerre com finish_trello.`
  ].join("\n");
};

type ExecCtx = {
  taskId: ObjectId;
  cardId: string;
  boardId: string;
  columns: { id: string; name: string }[];
  allowCreateCards: boolean;
  state: { createdCards: number; checklistId?: string };
};

const execTool = async (
  fnName: string,
  args: Record<string, unknown>,
  ctx: ExecCtx
): Promise<{ ok: boolean; summary: string; result: unknown }> => {
  const { cardId, columns } = ctx;
  try {
    switch (fnName) {
      case "move_card": {
        const listId = String(args.listId ?? "");
        if (!listId || !columns.some(c => c.id === listId)) {
          return { ok: false, summary: `listId invalido: ${listId}`, result: { error: "invalid_listId" } };
        }
        await moveCard(cardId, listId);
        const name = columns.find(c => c.id === listId)?.name ?? listId;
        return { ok: true, summary: `moveu pra "${name}"`, result: { moved: true } };
      }
      case "comment_card": {
        const text = String(args.text ?? "").slice(0, 500);
        if (!text) return { ok: false, summary: "texto vazio", result: { error: "empty_text" } };
        await addComment(cardId, text);
        return { ok: true, summary: `comentou: ${text.slice(0, 60)}`, result: { commented: true } };
      }
      case "apply_label": {
        const labelId = String(args.labelId ?? "");
        if (!labelId) return { ok: false, summary: "labelId vazio", result: { error: "empty_labelId" } };
        await addLabelToCard(cardId, labelId);
        return { ok: true, summary: `aplicou label ${labelId}`, result: { labeled: true } };
      }
      case "append_card_desc": {
        const text = String(args.text ?? "").slice(0, 800);
        if (!text) return { ok: false, summary: "texto vazio", result: { error: "empty_text" } };
        // Le o desc atual e anexa — preserva conteudo + marker de reuso do card.
        const current = await getCard(cardId);
        const base = (current.desc ?? "").trimEnd();
        const newDesc = (base ? `${base}\n\n${text}` : text).slice(0, 16000);
        await updateCard(cardId, { desc: newDesc });
        return { ok: true, summary: `anexou ao desc: ${text.slice(0, 60)}`, result: { appended: true } };
      }
      case "add_checklist_item": {
        const text = String(args.text ?? "").slice(0, 300);
        if (!text) return { ok: false, summary: "texto vazio", result: { error: "empty_text" } };
        const checked = args.checked === true;
        // Resolve (uma vez) a checklist "MathAI Progresso": reusa ou cria.
        if (!ctx.state.checklistId) {
          const existing = await getCardChecklists(cardId).catch(() => []);
          const found = existing.find(cl => cl.name === CHECKLIST_NAME);
          ctx.state.checklistId = found?.id ?? (await createChecklist(cardId, CHECKLIST_NAME)).id;
        }
        await addChecklistItem(ctx.state.checklistId, text, checked);
        return { ok: true, summary: `checklist +item: ${text.slice(0, 60)}`, result: { itemAdded: true } };
      }
      case "create_card": {
        if (!ctx.allowCreateCards) {
          return { ok: false, summary: "criar cards desabilitado", result: { error: "create_disabled" } };
        }
        if (ctx.state.createdCards >= MAX_CARDS_CREATED) {
          return { ok: false, summary: "limite de cards atingido", result: { error: "create_limit" } };
        }
        const listId = String(args.listId ?? "");
        if (!listId || !columns.some(c => c.id === listId)) {
          return { ok: false, summary: `listId invalido: ${listId}`, result: { error: "invalid_listId" } };
        }
        const name = String(args.name ?? "").slice(0, 200);
        if (!name) return { ok: false, summary: "nome vazio", result: { error: "empty_name" } };
        const desc = String(args.desc ?? "").slice(0, 2000);
        const card = await createCard(listId, name, desc || undefined);
        ctx.state.createdCards++;
        // Rastreia o card na task: entra em trelloCardIds (movido pra "done" no fim)
        // + trelloAgentCardIds (mede o teto por-task entre stages). Best-effort.
        try {
          const col = await getTasksCollection();
          await col.updateOne(
            { _id: ctx.taskId },
            {
              $addToSet: { trelloCardIds: card.id, trelloAgentCardIds: card.id },
              $set: { updatedAt: new Date() }
            }
          );
        } catch {/* persistencia best-effort — nao quebra o agente */}
        return { ok: true, summary: `criou card "${name}"`, result: { created: true, cardId: card.id, url: card.url } };
      }
      case "finish_trello":
        return { ok: true, summary: "finish", result: { done: true } };
      default:
        return { ok: false, summary: `tool desconhecida: ${fnName}`, result: { error: "unknown_tool" } };
    }
  } catch (e) {
    return { ok: false, summary: `erro: ${e instanceof Error ? e.message : String(e)}`, result: { error: "exec_failed" } };
  }
};

export const runTrelloAgent = async (input: TrelloAgentInput): Promise<TrelloAgentResult> => {
  const started = Date.now();
  const language = input.language ?? "pt";
  const actions: TrelloAgentResult["actions"] = [];
  let totalUsage: TokenUsage = ZERO_USAGE;

  const allowCreateCards = input.allowCreateCards === true;

  // 1. Pre-busca o estado do board (paralelo). Se falhar, pula.
  let columns: { id: string; name: string }[];
  let labels: { id: string; name: string; color: string }[];
  let card: { name: string; currentListName?: string; currentListId?: string };
  let checklists: { name: string; checkItems: { name: string; state: string }[] }[];
  let boardCards: { name: string; listName: string }[];
  const state: ExecCtx["state"] = { createdCards: 0 };
  try {
    const [lists, boardLabels, cardDoc, cardChecklists, allCards] = await Promise.all([
      getBoardLists(input.boardId),
      getBoardLabels(input.boardId).catch(() => []),
      getCard(input.cardId),
      getCardChecklists(input.cardId).catch(() => []),
      getBoardCards(input.boardId).catch(() => [])
    ]);
    columns = lists.map(l => ({ id: l.id, name: l.name }));
    const listNameById = new Map(lists.map(l => [l.id, l.name] as const));
    // Exclui o card da propria task da lista de "existentes" (nao e duplicata dele mesmo).
    boardCards = allCards
      .filter(c => c.id !== input.cardId)
      .map(c => ({ name: c.name, listName: listNameById.get(c.idList) ?? "?" }));
    labels = boardLabels.map(l => ({ id: l.id, name: l.name, color: l.color }));
    const currentList = lists.find(l => l.id === cardDoc.idList);
    card = { name: cardDoc.name, currentListName: currentList?.name, currentListId: cardDoc.idList };
    checklists = cardChecklists.map(cl => ({
      name: cl.name,
      checkItems: cl.checkItems.map(i => ({ name: i.name, state: i.state }))
    }));
    // Pre-resolve a checklist de progresso se ja existir (evita recriar).
    state.checklistId = cardChecklists.find(cl => cl.name === CHECKLIST_NAME)?.id;
    // Teto POR-TASK: inicializa o contador com os cards que o agente ja criou
    // em stages anteriores (persistidos em trelloAgentCardIds).
    if (allowCreateCards) {
      try {
        const col = await getTasksCollection();
        const doc = await col.findOne({ _id: input.taskId }, { projection: { trelloAgentCardIds: 1 } });
        state.createdCards = doc?.trelloAgentCardIds?.length ?? 0;
      } catch {/* best-effort — mantem 0 */}
    }
  } catch (e) {
    return { actions, usage: totalUsage, skipped: true, reason: `trello_fetch_failed: ${e instanceof Error ? e.message : String(e)}`, iterations: 0 };
  }

  const tools = buildToolsSchema(allowCreateCards);
  const execCtx: ExecCtx = { taskId: input.taskId, cardId: input.cardId, boardId: input.boardId, columns, allowCreateCards, state };

  // 2. LLM setup — provider barato (taskReporter). Rotaciona em erro/empty.
  let route = await selectRoute("taskReporter", { description: input.taskDescription });
  let providerAttempts = 0;

  const messages: import("openai/resources/chat/completions.js").ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(language, allowCreateCards) },
    { role: "user", content: buildUserPrompt(input, columns, labels, card, checklists, boardCards) }
  ];

  let iter = 0;
  let finished = false;

  for (iter = 0; iter < MAX_ITERATIONS; iter++) {
    const client = getClient(route.provider);
    let completion: Awaited<ReturnType<typeof client.chat.completions.create>> | null = null;
    try {
      completion = await withRetry(
        async () => client.chat.completions.create({
          model: route.model,
          temperature: 0.2,
          messages,
          tools,
          tool_choice: iter === MAX_ITERATIONS - 1
            ? { type: "function", function: { name: "finish_trello" } }
            : "auto"
        }),
        { label: "trelloAgent-iter", attempts: 2, baseDelayMs: 400, fallback: () => null }
      );
    } catch {
      completion = null;
    }

    // Empty/erro → marca provider down e re-seleciona (rotacao). Cap de tentativas.
    if (!completion) {
      markProviderDown(route.grpcUrl);
      providerAttempts++;
      if (providerAttempts >= MAX_PROVIDER_ATTEMPTS) {
        await record(input, totalUsage, started, false, "llm_no_completion", actions);
        return { actions, usage: totalUsage, skipped: true, reason: "llm_no_completion", iterations: iter };
      }
      route = await selectRoute("taskReporter", { description: input.taskDescription });
      iter--; // nao conta essa iteracao
      continue;
    }

    if (completion.usage) {
      const u = toTokenUsage(completion.usage);
      totalUsage = {
        inputTokens: totalUsage.inputTokens + u.inputTokens,
        outputTokens: totalUsage.outputTokens + u.outputTokens,
        totalTokens: totalUsage.totalTokens + u.totalTokens
      };
    }

    const msg = completion.choices[0]?.message;
    if (!msg) break;
    messages.push(msg);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) break; // sem tool = terminou

    for (const tc of toolCalls) {
      const fnName = tc.function.name;
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(tc.function.arguments || "{}"); } catch {/* empty */}

      const exec = await execTool(fnName, parsedArgs, execCtx);
      actions.push({ tool: fnName, ok: exec.ok, summary: exec.summary });

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(exec.result)
      } as import("openai/resources/chat/completions.js").ChatCompletionToolMessageParam);

      if (fnName === "finish_trello") { finished = true; break; }
    }
    if (finished) break;
  }

  await record(input, totalUsage, started, true, undefined, actions);

  console.info(
    `[trelloAgent] stage=${input.stage} iter=${iter} finished=${finished} ` +
    `actions=${actions.filter(a => a.ok && a.tool !== "finish_trello").length} tokens=${totalUsage.totalTokens}`
  );

  return { actions, usage: totalUsage, skipped: false, reason: finished ? undefined : "max_iterations", iterations: iter };
};

const record = async (
  input: TrelloAgentInput,
  usage: TokenUsage,
  started: number,
  success: boolean,
  error: string | undefined,
  actions: TrelloAgentResult["actions"]
): Promise<void> => {
  try {
    await recordAgentCall({
      taskId: input.taskId,
      subtaskId: `trello-agent-${input.stage}`,
      agent: "trelloAgent",
      usage,
      durationMs: Date.now() - started,
      success,
      error,
      output: actions
    });
  } catch {/* telemetria best-effort */}
};
