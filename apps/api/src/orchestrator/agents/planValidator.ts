import { runOpenClaude } from "../integrations/openclaude.js";
import { getClient } from "../../core/openai.js";
import { getAgentsConfig } from "../../core/agentConfig.js";
import { selectRoute, markProviderDown } from "../routing/router.js";
import { ZERO_USAGE, toTokenUsage, addTokenUsage, type TokenUsage } from "../types.js";
import { withRetry } from "./withRetry.js";
import type { PlannedSubTask } from "./planner.js";
import type { Route } from "../routing/types.js";

// ============== TYPES ==============

export type PlanValidationInput = {
  taskDescription: string;
  draftSubtasks: PlannedSubTask[];
  /**
   * Caminho do clone base do repo principal (read-only — NAO um worktree
   * de task). O validator usa pra explorar com Read/Grep/Glob. Se ausente,
   * validator e pulado e o draft passa direto.
   */
  worktreePath?: string;
  language?: "pt" | "en" | "es";
  /** Bloco [PROJECT CONTEXT] ja formatado pra incluir nos prompts. */
  projectContextText?: string;
  /** Route opcional pra OpenClaude exploration (default usa selectRoute). */
  explorationRoute?: Route;
};

export type PlanValidationResult = {
  /** Plano refinado. Mesmo formato do planner. */
  refinedSubtasks: PlannedSubTask[];
  /** Soma exploration (OpenClaude) + refine (LLM). */
  usage: TokenUsage;
  /** Markdown emitido pelo OpenClaude (debug). */
  exploration: string;
  /** True se o validator mudou alguma coisa em relacao ao draft. */
  changed: boolean;
  /** True se o validator foi pulado (sem worktree / draft vazio / falha). */
  skipped: boolean;
  /** Motivo do skip ou da falha (pra telemetria). */
  reason?: string;
};

// ============== CONFIG ==============

/** Hard cap pra exploration — validator nao pode passar dessa janela. */
const EXPLORATION_TIMEOUT_MS = 120_000;
/** Max chars do relatorio markdown que vai pro refine LLM. */
const REPORT_CAP_CHARS = 6000;
/** Tools de WRITE que se detectadas durante exploration disparam fallback. */
const FORBIDDEN_TOOLS = new Set([
  "Write", "Edit", "MultiEdit", "NotebookEdit", "write", "edit", "multiedit", "notebookedit"
]);
/** Bash commands considerados "write" — disparam fallback se detectados. */
const BASH_WRITE_RE = /(?:^|[\s;|&])(?:cat\s*>|cat\s*>>|tee\s|sed\s+-i|mv\s|cp\s|rm\s|truncate\s|git\s+add|git\s+commit|git\s+push|>\s*\S+|>>\s*\S+)/;

// ============== PROMPTS ==============

const buildExplorationPrompt = (
  taskDescription: string,
  draftSubtasks: PlannedSubTask[],
  language: "pt" | "en" | "es",
  projectContextText?: string
): string => {
  const draftStr = draftSubtasks
    .map(st => `- ${st.id} [${st.type}] (priority=${st.priority}, dependsOn=[${st.dependsOn.join(",") || "-"}]): ${st.description}`)
    .join("\n");

  const prompts: Record<"pt" | "en" | "es", string> = {
    pt: `Voce e um VALIDADOR DE PLANO. NAO e um implementador.

⚠️ REGRAS CRITICAS (NUNCA QUEBRE):
1. Voce SO PODE USAR tools de LEITURA: Read, Grep, Glob, e Bash com comandos READ-ONLY (ls, cat, find, head, tree).
2. PROIBIDO usar Write, Edit, MultiEdit, NotebookEdit, ou Bash com qualquer operacao de write (>, >>, sed -i, mv, cp, rm, tee, git add, git commit).
3. NAO faca commits. NAO modifique nada. Se uma tool tentar escrever, RECUSE.
4. Use SOMENTE caminhos relativos ao workspace atual.

OBJETIVO:
Analise as subtasks abaixo contra o codigo REAL deste repositorio e produza um RELATORIO MARKDOWN respondendo:

(a) Os paths/arquivos mencionados em cada subtask EXISTEM ou fazem sentido na estrutura?
(b) Algum subtask pede algo que JA ESTA IMPLEMENTADO?
(c) Tem subtasks redundantes ou sobrepostas (que poderiam ser uma so)?
(d) Tem dependencias (dependsOn) incorretas? Alguma subtask precisa de outra que nao depende dela?
(e) Paths concretos onde a mudanca deve realmente acontecer (corrigir vagos como "modifique main.ts" -> "modifique frontend/src/main.ts").

PROCESSO RECOMENDADO:
1. \`ls\` na raiz pra entender estrutura
2. \`Glob\` ou \`find\` pelos paths mencionados nas subtasks
3. \`Read\` ou \`cat\` parcial dos arquivos relevantes (NAO leia repo inteiro — 5-10 arquivos no maximo)
4. \`Grep\` pra detectar se a funcionalidade ja existe

TAREFA DO USUARIO:
${taskDescription}

DRAFT DE SUBTASKS (a validar):
${draftStr}

SAIDA OBRIGATORIA (escreva no final, em markdown):

# Relatorio de Validacao

## Por subtask
- **st1**: status (ok / paths corrigir / redundante / merge com X)
  - Paths reais: ...
  - Observacoes: ...
- **st2**: ...

## Sugestoes globais
- Merges propostos: ...
- Splits propostos: ...
- Dependencias incorretas: ...
- Subtasks adicionais que faltam: ...

## Resumo
1-2 frases.

NAO emita JSON. NAO escreva codigo. Apenas o relatorio em markdown.`,

    en: `You are a PLAN VALIDATOR. You are NOT an implementer.

⚠️ CRITICAL RULES (NEVER BREAK):
1. You may ONLY use READ tools: Read, Grep, Glob, and Bash with READ-ONLY commands (ls, cat, find, head, tree).
2. FORBIDDEN: Write, Edit, MultiEdit, NotebookEdit, or Bash with any write operation (>, >>, sed -i, mv, cp, rm, tee, git add, git commit).
3. Do NOT commit. Do NOT modify anything. If a tool tries to write, refuse.
4. Use ONLY paths relative to current workspace.

GOAL:
Analyze the subtasks below against the REAL code in this repo and produce a MARKDOWN REPORT answering:

(a) Do paths/files referenced in each subtask exist or make sense in the structure?
(b) Does any subtask request something ALREADY IMPLEMENTED?
(c) Are there redundant or overlapping subtasks that could be merged?
(d) Are dependsOn incorrect? Does any subtask need another it doesn't list?
(e) Concrete paths where changes should actually happen (fix vague "modify main.ts" -> "modify frontend/src/main.ts").

User task:
${taskDescription}

Subtask draft:
${draftStr}

OUTPUT (write at the end, markdown):

# Validation Report

## Per subtask
- **st1**: status (ok / fix paths / redundant / merge with X)
  - Real paths: ...
  - Notes: ...
- **st2**: ...

## Global suggestions
- Merges proposed: ...
- Splits proposed: ...
- Incorrect dependencies: ...
- Missing subtasks: ...

## Summary
1-2 sentences.

DO NOT emit JSON. DO NOT write code. Only the markdown report.`,

    es: `Eres un VALIDADOR DE PLAN. NO eres un implementador.

⚠️ REGLAS CRITICAS (NUNCA ROMPAS):
1. Solo puedes USAR tools de LECTURA: Read, Grep, Glob, y Bash con comandos READ-ONLY.
2. PROHIBIDO: Write, Edit, MultiEdit, NotebookEdit, o Bash con cualquier write (>, >>, sed -i, mv, cp, rm, tee, git add, git commit).
3. NO hagas commits. NO modifiques nada.

(Resto identico al PT con traducoes...)

Tarea: ${taskDescription}
Subtasks: ${draftStr}

Salida: reporte markdown sin JSON.`
  };

  const base = prompts[language];
  return projectContextText
    ? `${projectContextText}\n\n---\n\n${base}`
    : base;
};

const buildRefineSystem = (language: "pt" | "en" | "es"): string => {
  const prompts: Record<"pt" | "en" | "es", string> = {
    pt: `Voce e um REFINADOR DE PLANO. Recebe (a) draft de subtasks original, (b) relatorio de validacao gerado por um explorador do repo real. Sua funcao: emitir uma versao REFINADA do plano que incorpora os achados do relatorio.

REGRAS:
- Mantenha o MESMO formato JSON do draft (id, type, description, priority, dependsOn, repo).
- Pode MERGE subtasks redundantes em uma unica.
- Pode SPLIT subtask que ficou ampla demais.
- Pode REORDENAR dependsOn.
- Pode CORRIGIR paths vagos com paths concretos do relatorio.
- Pode REMOVER subtasks que o relatorio diz que ja estao implementadas.
- NUNCA invente paths que nao apareceram nem no draft nem no relatorio.
- Se o relatorio nao recomendar mudancas, retorne o draft INTACTO.

SAIDA: APENAS JSON valido, formato { "subtasks": [...] }. Nada antes ou depois.`,

    en: `You are a PLAN REFINER. You receive (a) original subtasks draft, (b) validation report from an explorer of the real repo. Emit a REFINED plan that incorporates report findings.

RULES:
- Keep the SAME JSON format as draft (id, type, description, priority, dependsOn, repo).
- May MERGE redundant subtasks.
- May SPLIT overly broad ones.
- May REORDER dependsOn.
- May FIX vague paths using concrete ones from the report.
- May REMOVE subtasks the report says are already implemented.
- NEVER invent paths not in either draft or report.
- If report recommends no changes, return draft INTACT.

OUTPUT: ONLY valid JSON, format { "subtasks": [...] }. Nothing before or after.`,

    es: `Eres un REFINADOR. Recibes draft + reporte. Emite plan refinado en JSON identico al draft. No inventes paths. Si no hay cambios sugeridos, devuelve draft intacto. Salida: solo JSON.`
  };
  return prompts[language];
};

const buildRefineUser = (
  taskDescription: string,
  draftSubtasks: PlannedSubTask[],
  explorationReport: string
): string => {
  const report = explorationReport.length > REPORT_CAP_CHARS
    ? explorationReport.slice(0, REPORT_CAP_CHARS) + "\n[... truncado]"
    : explorationReport;
  return [
    `Task description: ${taskDescription}`,
    "",
    "Draft subtasks (JSON):",
    JSON.stringify({ subtasks: draftSubtasks }, null, 2),
    "",
    "Validation report (markdown, from repo exploration):",
    report,
    "",
    "Emit refined JSON now. Format: { \"subtasks\": [...] } — same shape as draft."
  ].join("\n");
};

// ============== MAIN ==============

/**
 * Roda exploration read-only (OpenClaude) + refine (LLM) pra produzir um
 * plano refinado a partir do draft. Falhas (qualquer tipo) caem no fallback:
 * retorna draft inalterado.
 *
 * Custo tipico: ~30-90s + ~US$0.05 (OpenClaude exploration) + centavos (refine).
 * Vale a pena pra tasks complexas onde o planner cheap halucina paths.
 */
export const validatePlan = async (input: PlanValidationInput): Promise<PlanValidationResult> => {
  const { taskDescription, draftSubtasks, worktreePath, language = "pt", projectContextText } = input;

  // Skip 1: sem worktree -> nao tem repo pra explorar
  if (!worktreePath) {
    return { refinedSubtasks: draftSubtasks, usage: ZERO_USAGE, exploration: "", changed: false, skipped: true, reason: "no_worktree" };
  }
  // Skip 2: draft vazio -> nada pra refinar
  if (draftSubtasks.length === 0) {
    return { refinedSubtasks: draftSubtasks, usage: ZERO_USAGE, exploration: "", changed: false, skipped: true, reason: "empty_draft" };
  }

  // 1. EXPLORATION via OpenClaude — retry loop sobre providers OpenClaude.
  // Validator DEVE rodar via OpenClaude (contrato do projeto). Empty stream em
  // um provider marca-o down e re-seleciona route, esgotando todos antes de
  // skip. Cap=4 cobre os 3 providers configurados + 1 folga.
  const EXPLORATION_PROVIDER_ATTEMPTS = 4;
  let exploration = "";
  let explorationUsage: TokenUsage = ZERO_USAGE;
  let writeAttempted = false;
  const triedRoutes: { provider: string; grpcUrl?: string }[] = [];
  const errorsByProvider: string[] = [];
  let explorationSucceeded = false;
  let lastErrorMsg = "";

  for (let attempt = 0; attempt < EXPLORATION_PROVIDER_ATTEMPTS && !explorationSucceeded; attempt++) {
    // Na primeira tentativa usa explorationRoute do input (se houver);
    // depois re-seleciona via router (que pula providers marcados down).
    const explorationRoute = (attempt === 0 && input.explorationRoute)
      ? input.explorationRoute
      : await selectRoute("taskCode", {
          type: "github",
          description: `[PLAN VALIDATION] ${taskDescription}`
        });

    // Detecta esgotamento: router caiu pra fallback deepseek que ja tentamos.
    const alreadyTried = triedRoutes.some(r =>
      r.provider === explorationRoute.provider && r.grpcUrl === explorationRoute.grpcUrl
    );
    if (alreadyTried) {
      console.info(`[planValidator] all OpenClaude providers exhausted after ${attempt} attempts`);
      break;
    }
    triedRoutes.push({ provider: explorationRoute.provider, grpcUrl: explorationRoute.grpcUrl });

    try {
      const result = await runOpenClaude(
        buildExplorationPrompt(taskDescription, draftSubtasks, language, projectContextText),
        {
          workingDirectory: worktreePath,
          model: explorationRoute.model,
          grpcUrl: explorationRoute.grpcUrl,
          autoApprove: true,
          timeoutMs: EXPLORATION_TIMEOUT_MS,
          onEvent: (event) => {
            // Detect write attempts — confirma que validator NAO esta mutando o repo
            if (event.type === "tool_start") {
              if (FORBIDDEN_TOOLS.has(event.toolName)) {
                writeAttempted = true;
              }
              if (event.toolName === "Bash" || event.toolName === "bash") {
                try {
                  const args = JSON.parse(event.args);
                  const cmd: string = args.command ?? "";
                  if (BASH_WRITE_RE.test(cmd)) writeAttempted = true;
                } catch {/* noop */}
              }
            }
          }
        }
      );
      exploration = result.fullText;
      explorationUsage = toTokenUsage({
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
        total_tokens: result.promptTokens + result.completionTokens
      });
      explorationSucceeded = true;
      if (attempt > 0) {
        console.info(`[planValidator] exploration recovered on attempt ${attempt + 1} via ${explorationRoute.provider}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastErrorMsg = msg;
      errorsByProvider.push(`${explorationRoute.provider}: ${msg.slice(0, 80)}`);
      // Provider falhou — marca down e re-seleciona na proxima iteracao.
      if (/empty|EMPTY_STREAM|stream ended without result|truncated|rate-limit|auth/i.test(msg)) {
        markProviderDown(explorationRoute.grpcUrl, 60_000);
        console.info(`[planValidator] attempt ${attempt + 1}/${EXPLORATION_PROVIDER_ATTEMPTS} FAILED → markProviderDown(${explorationRoute.provider}) | ${msg.slice(0, 120)}`);
        // continua loop pra proxima route
      } else {
        // Erro nao-recuperavel (network, config) — para o loop
        console.info(`[planValidator] attempt ${attempt + 1} FAILED (non-retryable) | ${msg.slice(0, 200)}`);
        break;
      }
    }
  }

  if (!explorationSucceeded) {
    return {
      refinedSubtasks: draftSubtasks,
      usage: ZERO_USAGE,
      exploration: "",
      changed: false,
      skipped: true,
      reason: `exploration_failed_all_providers (tried=${triedRoutes.map(r => r.provider).join(",")}): ${lastErrorMsg.slice(0, 160)}`
    };
  }

  if (writeAttempted) {
    // Validator violou contrato read-only. Usa draft sem refinar — seguranca.
    return {
      refinedSubtasks: draftSubtasks,
      usage: explorationUsage,
      exploration,
      changed: false,
      skipped: true,
      reason: "write_attempt_detected"
    };
  }

  if (!exploration || exploration.trim().length < 50) {
    // Relatorio vazio/muito curto — nada util pra refinar
    return {
      refinedSubtasks: draftSubtasks,
      usage: explorationUsage,
      exploration,
      changed: false,
      skipped: true,
      reason: "exploration_empty"
    };
  }

  // 2. REFINE via cheap LLM com response_format JSON
  const agentsCfg = await getAgentsConfig();
  const cfg = agentsCfg.taskPlanner;
  const refineRoute = await selectRoute("taskPlanner", { description: taskDescription });
  const client = getClient(refineRoute.provider);
  const model = refineRoute.model || cfg?.model || "gpt-4o-mini";
  const temperature = cfg?.temperature ?? 0;

  const refineSystem = buildRefineSystem(language);
  const refineUser = buildRefineUser(taskDescription, draftSubtasks, exploration);

  let refineUsage: TokenUsage = ZERO_USAGE;
  let refinedSubtasks: PlannedSubTask[] = draftSubtasks;
  let changed = false;

  try {
    const completion = await withRetry(
      async () => client.chat.completions.create({
        model,
        temperature,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: refineSystem },
          { role: "user", content: refineUser }
        ]
      }),
      { label: "planValidator-refine", attempts: 2, baseDelayMs: 500, fallback: () => null }
    );

    if (!completion) {
      return {
        refinedSubtasks: draftSubtasks,
        usage: explorationUsage,
        exploration,
        changed: false,
        skipped: true,
        reason: "refine_failed"
      };
    }

    const raw = completion.choices[0]?.message?.content ?? "{}";
    refineUsage = toTokenUsage(completion.usage);

    const parsed = JSON.parse(raw) as { subtasks?: unknown };
    if (!Array.isArray(parsed.subtasks)) {
      return {
        refinedSubtasks: draftSubtasks,
        usage: addTokenUsage(explorationUsage, refineUsage),
        exploration,
        changed: false,
        skipped: true,
        reason: "refine_invalid_shape"
      };
    }

    // Sanitiza: aceita so subtasks que tem id/type/description.
    refinedSubtasks = (parsed.subtasks as unknown[])
      .map((raw): PlannedSubTask | null => {
        if (!raw || typeof raw !== "object") return null;
        const r = raw as Record<string, unknown>;
        if (typeof r.id !== "string" || typeof r.type !== "string" || typeof r.description !== "string") return null;
        return {
          id: r.id,
          type: r.type as PlannedSubTask["type"],
          description: r.description,
          priority: typeof r.priority === "number" ? r.priority : 3,
          dependsOn: Array.isArray(r.dependsOn) ? r.dependsOn.filter((d): d is string => typeof d === "string") : [],
          repo: typeof r.repo === "string" ? r.repo : undefined
        };
      })
      .filter((s): s is PlannedSubTask => s !== null);

    // Se sanitizacao zerou tudo, fallback pra draft
    if (refinedSubtasks.length === 0) {
      return {
        refinedSubtasks: draftSubtasks,
        usage: addTokenUsage(explorationUsage, refineUsage),
        exploration,
        changed: false,
        skipped: true,
        reason: "refine_empty_after_sanitize"
      };
    }

    // Detecta mudanca: descricao OU dependsOn OU contagem
    changed = refinedSubtasks.length !== draftSubtasks.length
      || refinedSubtasks.some((r, i) => {
        const d = draftSubtasks[i];
        if (!d) return true;
        return r.description !== d.description
          || r.dependsOn.join(",") !== d.dependsOn.join(",")
          || r.id !== d.id;
      });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      refinedSubtasks: draftSubtasks,
      usage: addTokenUsage(explorationUsage, refineUsage),
      exploration,
      changed: false,
      skipped: true,
      reason: `refine_parse_failed: ${msg.slice(0, 200)}`
    };
  }

  console.info(
    `[planValidator] done changed=${changed} drafts=${draftSubtasks.length} refined=${refinedSubtasks.length} ` +
    `tokens=${explorationUsage.totalTokens}+${refineUsage.totalTokens}=${explorationUsage.totalTokens + refineUsage.totalTokens}`
  );

  return {
    refinedSubtasks,
    usage: addTokenUsage(explorationUsage, refineUsage),
    exploration,
    changed,
    skipped: false
  };
};
