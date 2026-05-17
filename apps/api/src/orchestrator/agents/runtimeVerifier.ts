import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { getClient } from "../../core/openai.js";
import { selectRoute } from "../routing/router.js";
import { ZERO_USAGE, toTokenUsage, type TokenUsage } from "../types.js";
import { execShell } from "../integrations/shell.js";
import { withRetry } from "./withRetry.js";
import type { ReviewComment } from "./reviewer.js";

// ============== TYPES ==============

export type RuntimeVerdict = "PASS" | "FAIL" | "PARTIAL";

export type RuntimeEvidence = {
  kind: "http" | "smoke" | "file" | "console";
  summary: string;
  data?: unknown;
};

export type RuntimeVerifierInput = {
  /** URL publica do preview (tunnel cloudflared) ja resolvido. */
  previewUrl: string;
  /** Descricao da subtask para guiar o verifier. */
  taskDescription: string;
  /** Arquivos modificados pelo code agent — dao pistas de smoke targets. */
  changedFiles: string[];
  /** Worktree absoluto — sandbox para read_file e run_smoke. */
  worktreePath: string;
  language?: "pt" | "en" | "es";
  /** [PROJECT CONTEXT] block ja formatado pra system prompt. */
  projectContextText?: string;
  /** G3 — stack detectada do worktree; injeta comandos validos no system prompt
   *  (run_smoke aceita npm/npx/node/tsc por padrao, mas em Python/Go o LLM
   *  precisa saber o que rodar). */
  stack?: import("../context/stackDetector.js").DetectedStack;
};

export type RuntimeVerifierResult = {
  verdict: RuntimeVerdict;
  evidence: RuntimeEvidence[];
  /** Comments compativeis com o review-loop (FAIL→error, PARTIAL→warning). */
  comments: ReviewComment[];
  usage: TokenUsage;
  iterations: number;
  /** True quando verifier nao rodou (ex: sem preview, LLM offline). */
  skipped: boolean;
  reason?: string;
  /** Trajetoria de tools chamadas (debug). */
  trace: { tool: string; args: unknown; ok: boolean; summary: string }[];
};

// ============== CONFIG ==============

/** Iteracoes do tool-use loop. */
const MAX_ITERATIONS = 10;
/** Timeout hard por tool. */
const TOOL_TIMEOUT_MS = 15_000;
/** Cap de bytes pra read_file. */
const READ_FILE_CAP = 8000;
/** Cap de chars pra response body de curl_*. */
const HTTP_BODY_CAP = 4000;
/** Cap de stdout/stderr pra run_smoke. */
const SMOKE_OUT_CAP = 4000;
/** Smokes permitidos — subconjunto seguro de shell.ts ALLOWED_COMMANDS. */
const ALLOWED_SMOKE = new Set(["npm", "npx", "node", "tsc", "find", "ls", "cat"]);

// ============== PROMPTS ==============

const buildStackHint = (
  stack?: import("../context/stackDetector.js").DetectedStack
): string => {
  if (!stack || stack.primary === "unknown") return "";
  const fw = stack.frameworks.length ? ` (frameworks: ${stack.frameworks.join(", ")})` : "";
  const cmd = stack.staticCheckCmd
    ? ` Static-check rapido: ${stack.staticCheckCmd.command} ${stack.staticCheckCmd.args.join(" ")}.`
    : "";
  const preview = stack.previewBuildCmd
    ? ` Preview build esperado: ${stack.previewBuildCmd}.`
    : "";
  return `\n\n[STACK DETECTED] primary=${stack.primary}${fw}.${cmd}${preview} Adapte os smoke checks pra este stack — nao presuma npm/node se nao for Node.`;
};

const buildSystemPrompt = (
  language: "pt" | "en" | "es",
  projectContextText?: string,
  stack?: import("../context/stackDetector.js").DetectedStack
): string => {
  const base: Record<"pt" | "en" | "es", string> = {
    pt: `Voce e um RUNTIME VERIFIER autonomo. Sua missao: confirmar que o codigo recem-mexido realmente RODA em runtime contra o preview deployado, e detectar bugs de comportamento antes do PR ser aberto.

Voce NAO e revisor de codigo nem critico de UX. Voce e um QA functional smoke-tester: pega a descricao da tarefa + arquivos mudados, formula 2-5 verificacoes objetivas, executa via tools, e emite veredicto PASS/FAIL/PARTIAL com evidencia concreta.

VOCE TEM ACESSO AS TOOLS:
- curl_get(path, headers?) — HTTP GET no preview (ex: "/", "/api/health", "/api/items/1")
- curl_post(path, body?, headers?) — HTTP POST (body = JSON serializavel)
- run_smoke(command, args[]) — comando rapido no worktree. Permitidos: npm, npx, node, tsc, find, ls, cat. NAO use git/gh/destrutivos.
- read_file(path) — le arquivo do worktree (path relativo). Util pra checar config/output.
- finish_verify({ verdict, evidence }) — ENCERRA com veredicto. Apos isto nao chame mais tools.

PROCESSO RECOMENDADO:
1. A partir da descricao + arquivos modificados, escolha 2-5 smoke checks objetivos.
2. Execute na ordem (HTTP primeiro — mais barato; smoke shell so se HTTP nao for suficiente).
3. Acumule evidencia: cada chamada bem-sucedida vira um item de evidence.
4. Quando tiver dados pra decidir: finish_verify.

VEREDICTO:
- "PASS"    = todas as verificacoes essenciais bateram. App responde, rotas existem, contrato funciona.
- "FAIL"    = ha uma quebra concreta (HTTP 5xx, smoke falha, response invalido, runtime error).
- "PARTIAL" = nao foi possivel verificar tudo (timeout, sandbox bloqueou, rota nao existe ainda, etc) MAS o que rodou bate. NAO use PARTIAL quando ha bug — use FAIL.

CADA EVIDENCE TEM:
- kind: "http" | "smoke" | "file" | "console"
- summary: 1 linha objetiva. Ex: "GET /api/items/42 → 200 ok, returned {id:42, name:'...'}".
- data?: payload curto opcional (ex: status code + primeiro snippet).

REGRAS:
- Maximo ${MAX_ITERATIONS} iteracoes. Seja eficiente — 3-5 tools eh o ideal.
- NAO chame finish_verify sem pelo menos 1 tool de evidencia executada com sucesso.
- HTTP 4xx em rota de auth e ESPERADO se voce nao tem token — NAO conte como FAIL.
- Se preview parece nao subir (curl_get / retorna ERR_CONNECTION ou 502), tente uma vez mais; se persistir, finish_verify com PARTIAL e reason no evidence.
- NAO descreva "deveria funcionar" — execute e prove. Sem execucao, NAO ha veredicto.`,

    en: `You are an autonomous RUNTIME VERIFIER. Mission: confirm the just-edited code actually runs at runtime against the deployed preview. NOT a code reviewer; you're a smoke QA.

TOOLS: curl_get, curl_post, run_smoke (npm/npx/node/tsc/find/ls/cat), read_file, finish_verify({verdict, evidence}).

VERDICT:
- PASS: essential checks pass
- FAIL: concrete break (5xx, smoke fail, invalid response, runtime error)
- PARTIAL: couldn't verify everything but what ran passed

Max ${MAX_ITERATIONS} iterations. Be efficient. Don't finish_verify without at least one successful tool. Don't speculate — execute.`,

    es: `Eres un RUNTIME VERIFIER autonomo. Usa tools (curl_get, curl_post, run_smoke, read_file) contra el preview, decide PASS/FAIL/PARTIAL, emite via finish_verify con evidencia concreta. Max ${MAX_ITERATIONS} iteraciones.`
  };
  const root = base[language] + buildStackHint(stack);
  return projectContextText ? `${root}\n\n${projectContextText}` : root;
};

const buildUserPrompt = (
  taskDescription: string,
  changedFiles: string[],
  previewUrl: string,
  language: "pt" | "en" | "es"
): string => {
  const filesBlock = changedFiles.length > 0
    ? changedFiles.slice(0, 30).map(f => `- ${f}`).join("\n") + (changedFiles.length > 30 ? `\n(+${changedFiles.length - 30} mais)` : "")
    : "(nenhum arquivo listado)";

  if (language === "en") {
    return `Task: ${taskDescription}\n\nChanged files:\n${filesBlock}\n\nPreview base URL: ${previewUrl}\n\nFormulate 2-5 smoke checks and execute them. Start with curl_get("/") to confirm the preview is up, then verify the specific behavior described above.`;
  }
  return `Tarefa: ${taskDescription}\n\nArquivos modificados:\n${filesBlock}\n\nURL base do preview: ${previewUrl}\n\nFormule 2-5 smoke checks e execute. Comece com curl_get("/") pra confirmar que o preview esta de pe, depois verifique o comportamento descrito acima.`;
};

// ============== TOOLS SCHEMA (OpenAI function-calling) ==============

const TOOLS_SCHEMA = [
  {
    type: "function" as const,
    function: {
      name: "curl_get",
      description: "HTTP GET no preview. path pode ser absoluto, com host, ou relativo (/api/x).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relativo (ex: /api/items) ou URL absoluta." },
          headers: { type: "object", description: "Headers opcionais (ex: Authorization)." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "curl_post",
      description: "HTTP POST no preview. body sera serializado como JSON.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          body: { type: "object" },
          headers: { type: "object" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "run_smoke",
      description: "Comando rapido no worktree. Permitidos: npm, npx, node, tsc, find, ls, cat.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Le arquivo do worktree (path relativo). Cap 8k chars.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "finish_verify",
      description: "Encerra emitindo veredicto + evidencia. Apos esta chamada nao chame mais tools.",
      parameters: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["PASS", "FAIL", "PARTIAL"] },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["http", "smoke", "file", "console"] },
                summary: { type: "string" },
                data: {}
              },
              required: ["kind", "summary"]
            }
          },
          reason: { type: "string", description: "Texto livre — usado quando PARTIAL/FAIL." }
        },
        required: ["verdict", "evidence"]
      }
    }
  }
];

// ============== TOOL EXECUTORS ==============

const truncate = (s: string, cap: number): string =>
  s.length > cap ? s.slice(0, cap) + `\n[... +${s.length - cap} chars truncados]` : s;

const isInsideWorktree = (worktreePath: string, candidate: string): boolean => {
  const wt = resolve(worktreePath);
  const target = resolve(worktreePath, candidate);
  return target === wt || target.startsWith(wt + sep);
};

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timeout (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const resolveUrl = (previewUrl: string, path: string): string => {
  if (/^https?:\/\//i.test(path)) return path;
  const base = previewUrl.replace(/\/$/, "");
  if (!path.startsWith("/")) return `${base}/${path}`;
  return `${base}${path}`;
};

const execTool = async (
  toolName: string,
  args: Record<string, unknown>,
  previewUrl: string,
  worktreePath: string
): Promise<{ ok: boolean; result: unknown; summary: string }> => {
  switch (toolName) {
    case "curl_get": {
      const path = String(args.path ?? "");
      const url = resolveUrl(previewUrl, path);
      const headers = (args.headers && typeof args.headers === "object")
        ? args.headers as Record<string, string>
        : {};
      try {
        const res = await withTimeout(fetch(url, { method: "GET", headers }), TOOL_TIMEOUT_MS, "curl_get");
        const body = truncate(await res.text(), HTTP_BODY_CAP);
        return {
          ok: true,
          result: { status: res.status, ok: res.ok, body, url },
          summary: `GET ${path} → ${res.status}`
        };
      } catch (e) {
        return {
          ok: false,
          result: { error: e instanceof Error ? e.message : String(e), url },
          summary: `GET ${path} FAIL`
        };
      }
    }

    case "curl_post": {
      const path = String(args.path ?? "");
      const url = resolveUrl(previewUrl, path);
      const headers = (args.headers && typeof args.headers === "object")
        ? { "content-type": "application/json", ...(args.headers as Record<string, string>) }
        : { "content-type": "application/json" };
      const body = args.body !== undefined ? JSON.stringify(args.body) : undefined;
      try {
        const res = await withTimeout(fetch(url, { method: "POST", headers, body }), TOOL_TIMEOUT_MS, "curl_post");
        const text = truncate(await res.text(), HTTP_BODY_CAP);
        return {
          ok: true,
          result: { status: res.status, ok: res.ok, body: text, url },
          summary: `POST ${path} → ${res.status}`
        };
      } catch (e) {
        return {
          ok: false,
          result: { error: e instanceof Error ? e.message : String(e), url },
          summary: `POST ${path} FAIL`
        };
      }
    }

    case "run_smoke": {
      const command = String(args.command ?? "");
      const rawArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      if (!ALLOWED_SMOKE.has(command)) {
        return {
          ok: false,
          result: { error: `comando nao permitido: ${command}. Permitidos: ${Array.from(ALLOWED_SMOKE).join(", ")}` },
          summary: `smoke FAIL (denied ${command})`
        };
      }
      try {
        const r = await execShell(command, rawArgs, worktreePath, TOOL_TIMEOUT_MS);
        return {
          ok: r.exitCode === 0,
          result: {
            exitCode: r.exitCode,
            stdout: truncate(r.stdout, SMOKE_OUT_CAP),
            stderr: truncate(r.stderr, SMOKE_OUT_CAP)
          },
          summary: `smoke ${command} ${rawArgs.slice(0, 2).join(" ")} → exit ${r.exitCode}`
        };
      } catch (e) {
        return {
          ok: false,
          result: { error: e instanceof Error ? e.message : String(e) },
          summary: `smoke ${command} FAIL`
        };
      }
    }

    case "read_file": {
      const path = String(args.path ?? "");
      if (!isInsideWorktree(worktreePath, path)) {
        return {
          ok: false,
          result: { error: "path fora do worktree" },
          summary: `read_file FAIL (escape ${path})`
        };
      }
      try {
        const buf = await readFile(join(worktreePath, path), "utf-8");
        return {
          ok: true,
          result: { path, content: truncate(buf, READ_FILE_CAP), bytes: buf.length },
          summary: `read ${path} (${buf.length}b)`
        };
      } catch (e) {
        return {
          ok: false,
          result: { error: e instanceof Error ? e.message : String(e) },
          summary: `read ${path} FAIL`
        };
      }
    }

    case "finish_verify": {
      const verdict = args.verdict;
      const ev = Array.isArray(args.evidence) ? args.evidence : [];
      const reason = typeof args.reason === "string" ? args.reason : undefined;
      return {
        ok: true,
        result: { verdict, evidence: ev, reason, count: ev.length },
        summary: `finish ${verdict} (${ev.length} evidencias)`
      };
    }

    default:
      return { ok: false, result: { error: `unknown tool: ${toolName}` }, summary: `?? ${toolName}` };
  }
};

// ============== HELPERS ==============

const sanitizeEvidence = (raw: unknown): RuntimeEvidence | null => {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const kind = e.kind;
  if (kind !== "http" && kind !== "smoke" && kind !== "file" && kind !== "console") return null;
  const summary = typeof e.summary === "string" ? e.summary : "";
  if (!summary) return null;
  return { kind, summary, data: e.data };
};

const evidenceToComments = (
  verdict: RuntimeVerdict,
  evidence: RuntimeEvidence[],
  reason?: string
): ReviewComment[] => {
  if (verdict === "PASS") return [];
  const severity: "error" | "warning" = verdict === "FAIL" ? "error" : "warning";
  const out: ReviewComment[] = evidence.map(ev => ({
    file: "<runtime>",
    severity,
    message: `[runtime-verifier:${ev.kind}] ${ev.summary}`
  }));
  if (out.length === 0) {
    out.push({
      file: "<runtime>",
      severity,
      message: `[runtime-verifier] ${verdict}${reason ? `: ${reason}` : " (sem evidencia detalhada)"}`
    });
  }
  return out;
};

// ============== MAIN ==============

/**
 * Runtime Verifier autonomo. Roda 1x por subtask github no round 0 (gate em
 * pipeline). Faz smoke HTTP + shell contra o preview deployado e devolve
 * veredicto PASS/FAIL/PARTIAL + comments compativeis com o review-loop.
 *
 * Falhas (LLM down, preview down, etc) caem em fallback gracioso: skipped:true
 * + verdict:"PARTIAL" + comments vazio. NUNCA bloqueia o pipeline.
 */
export const verifyRuntime = async (input: RuntimeVerifierInput): Promise<RuntimeVerifierResult> => {
  const { previewUrl, taskDescription, changedFiles, worktreePath, language = "pt", projectContextText, stack } = input;
  const trace: RuntimeVerifierResult["trace"] = [];

  if (!previewUrl) {
    return {
      verdict: "PARTIAL",
      evidence: [],
      comments: [],
      usage: ZERO_USAGE,
      iterations: 0,
      skipped: true,
      reason: "no_preview_url",
      trace
    };
  }

  const route = await selectRoute("taskReviewer", { description: taskDescription });
  const client = getClient(route.provider);
  const model = route.model;

  const messages: import("openai/resources/chat/completions.js").ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(language, projectContextText, stack) },
    { role: "user", content: buildUserPrompt(taskDescription, changedFiles, previewUrl, language) }
  ];

  let totalUsage: TokenUsage = ZERO_USAGE;
  let finalVerdict: RuntimeVerdict = "PARTIAL";
  let finalEvidence: RuntimeEvidence[] = [];
  let finalReason: string | undefined;
  let iter = 0;
  let finishedExplicitly = false;

  for (iter = 0; iter < MAX_ITERATIONS; iter++) {
    let completion: Awaited<ReturnType<typeof client.chat.completions.create>> | null = null;
    try {
      completion = await withRetry(
        async () => client.chat.completions.create({
          model,
          temperature: 0.1,
          messages,
          tools: TOOLS_SCHEMA,
          tool_choice: iter === MAX_ITERATIONS - 1
            ? { type: "function", function: { name: "finish_verify" } }
            : "auto"
        }),
        { label: "runtimeVerifier-iter", attempts: 2, baseDelayMs: 500, fallback: () => null }
      );
    } catch (e) {
      return {
        verdict: "PARTIAL",
        evidence: finalEvidence,
        comments: [],
        usage: totalUsage,
        iterations: iter,
        skipped: true,
        reason: `llm_call_failed: ${e instanceof Error ? e.message : String(e)}`,
        trace
      };
    }

    if (!completion) {
      return {
        verdict: "PARTIAL",
        evidence: finalEvidence,
        comments: [],
        usage: totalUsage,
        iterations: iter,
        skipped: true,
        reason: "llm_no_completion",
        trace
      };
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
    if (toolCalls.length === 0) break;

    for (const tc of toolCalls) {
      const fnName = tc.function.name;
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments || "{}");
      } catch {/* invalid args -> treat as empty */}

      const exec = await execTool(fnName, parsedArgs, previewUrl, worktreePath);
      trace.push({ tool: fnName, args: parsedArgs, ok: exec.ok, summary: exec.summary });

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(exec.result)
      } as import("openai/resources/chat/completions.js").ChatCompletionToolMessageParam);

      if (fnName === "finish_verify" && exec.ok) {
        const r = exec.result as { verdict?: unknown; evidence?: unknown; reason?: unknown };
        const v = r.verdict;
        if (v === "PASS" || v === "FAIL" || v === "PARTIAL") finalVerdict = v;
        if (Array.isArray(r.evidence)) {
          finalEvidence = r.evidence
            .map(sanitizeEvidence)
            .filter((e): e is RuntimeEvidence => e !== null)
            .slice(0, 12);
        }
        if (typeof r.reason === "string") finalReason = r.reason;
        finishedExplicitly = true;
        break;
      }
    }

    if (finishedExplicitly) break;
  }

  // Sem evidencia mas com tools executadas → preserva PARTIAL/PASS dado o LLM
  // mas registra que terminou sem evidencia formal.
  if (!finishedExplicitly && finalEvidence.length === 0) {
    finalVerdict = "PARTIAL";
    finalReason = finalReason ?? "max_iterations_or_text_response";
  }

  const comments = evidenceToComments(finalVerdict, finalEvidence, finalReason);

  console.info(
    `[runtimeVerifier] done iter=${iter + (finishedExplicitly ? 1 : 0)} verdict=${finalVerdict} ` +
    `evidence=${finalEvidence.length} comments=${comments.length} tokens=${totalUsage.totalTokens} trace=${trace.length}`
  );

  return {
    verdict: finalVerdict,
    evidence: finalEvidence,
    comments,
    usage: totalUsage,
    iterations: iter + (finishedExplicitly ? 1 : 0),
    skipped: false,
    reason: finalReason,
    trace
  };
};
