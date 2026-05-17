import { mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getClient } from "../../core/openai.js";
import { selectRoute } from "../routing/router.js";
import { ZERO_USAGE, toTokenUsage, type TokenUsage } from "../types.js";
import { withRetry } from "./withRetry.js";
import type { ReviewComment } from "./reviewer.js";

// ============== TYPES ==============

export type UxCriticInput = {
  /** URL publica do preview (tunnel cloudflared). */
  previewUrl: string;
  /** Descricao da task original — orienta o que critic foca. */
  taskDescription: string;
  /** Lista de arquivos modificados (file:string). Usado pra mapear critica -> source. */
  changedFiles: string[];
  language?: "pt" | "en" | "es";
  /** [PROJECT CONTEXT] block ja formatado. */
  projectContextText?: string;
};

export type UxCriticResult = {
  /** Comments compativeis com o review-loop (severity error/warning/info). */
  comments: ReviewComment[];
  usage: TokenUsage;
  /** Trajetoria do agent (debug): cada ferramenta chamada + resultado curto. */
  trace: { tool: string; args: unknown; ok: boolean; summary: string }[];
  /** True se critic foi pulado ou abortado. */
  skipped: boolean;
  reason?: string;
  /** Iteracoes consumidas. */
  iterations: number;
};

// ============== CONFIG ==============

/** Iteracoes do tool-use loop. Cada uma = 1 LLM call + 1+ tool exec. */
const MAX_ITERATIONS = 12;
/** Timeout hard pra cada tool individual. */
const TOOL_TIMEOUT_MS = 15_000;
/** Cap em chars do DOM retornado por get_dom (evita inflar contexto). */
const DOM_SNIPPET_CAP = 4000;
/** Cap em chars do texto retornado por get_text. */
const TEXT_SNIPPET_CAP = 2000;
/** Cap em quantos console errors retornar por call. */
const CONSOLE_ERRORS_CAP = 20;

// ============== HELPERS ==============

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Localiza chromium full (mesmo padrao do previewScreenshot.ts). */
const findFullChromium = (): string | null => {
  const base = "/ms-playwright";
  if (!existsSync(base)) return null;
  try {
    const dirs = readdirSync(base).filter(d => d.startsWith("chromium-") && !d.includes("headless"));
    dirs.sort().reverse();
    for (const d of dirs) {
      for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const p = join(base, d, sub);
        if (existsSync(p)) return p;
      }
    }
  } catch {/* noop */}
  return null;
};

/** Aproxima file:component a partir da lista de changedFiles + texto da critica. */
const mapCommentToFile = (raw: { file?: string; message: string }, changedFiles: string[]): string => {
  if (raw.file && typeof raw.file === "string" && raw.file.length > 0) {
    // Se o LLM ja sugeriu file, mantem
    if (changedFiles.some(f => f.endsWith(raw.file!) || raw.file!.includes(f))) return raw.file!;
    return raw.file;
  }
  // Heuristica: extrai nome de componente do message ("LoginForm.vue", etc.)
  const compMatch = raw.message.match(/[A-Z][A-Za-z0-9_]*\.(vue|tsx|jsx|svelte)/);
  if (compMatch) {
    const candidate = changedFiles.find(f => f.endsWith(compMatch[0]!));
    if (candidate) return candidate;
    return compMatch[0]!;
  }
  return "<ui>";
};

// ============== PROMPTS ==============

const buildSystemPrompt = (language: "pt" | "en" | "es", projectContextText?: string): string => {
  const base: Record<"pt" | "en" | "es", string> = {
    pt: `Voce e um CRITICO DE UX/UI autonomo. Sua missao DUPLA:
(1) caçar BUGS visiveis e problemas de usabilidade
(2) propor MELHORIAS VISUAIS concretas pra deixar a UI mais polida e profissional

Voce dirige um navegador real (Playwright via tools) sobre a aplicacao em preview, interage, observa, e emite uma critica que o code agent vai aplicar SEM voce precisar revisar de novo. Pense como designer senior + product engineer.

VOCE TEM ACESSO AS TOOLS:
- navigate(url) — vai pra uma URL ou path relativo
- click(selector) — clica (use text="...", role="...", data-testid="..." ou CSS)
- fill(selector, value) — preenche input
- get_dom(selector?) — retorna HTML (cap 4k)
- get_text(selector?) — retorna texto visivel (cap 2k)
- get_console_errors() — drena erros/warnings do console
- wait(ms) — pausa (max 5000ms)
- finish_critique({ comments: [...] }) — ENCERRA emitindo a critica final

PROCESSO RECOMENDADO:
1. navigate na rota mais relevante das mudancas
2. get_dom pra entender o layout
3. INTERAJA: clica, preenche, hover, navega — sente como user usaria
4. get_console_errors pra pegar bugs silenciosos
5. Reflita sobre o conjunto: o que melhoraria a experiencia visual e funcional?
6. finish_critique com a lista

O QUE VOCE DEVE CRITICAR (ativamente sugerir melhoria, nao so apontar bug):

A) Espacamento e hierarquia visual:
   - Padding inconsistente entre cards/secoes
   - Margins sem ritmo (8/16/24 etc)
   - Tamanho de fonte sem hierarquia clara (h1 deve dominar)
   - Elementos amontoados ou esparsos demais

B) Estados interativos:
   - Botoes sem hover/active feedback
   - Inputs sem focus visivel ou ring de foco
   - Loading invisivel (clicou, nada acontece visivelmente)
   - Empty states sem placeholder/illustration
   - Error states crus (alert() do browser, mensagem em vermelho sem contexto)
   - Success states sem confirmacao visual

C) Cor e contraste:
   - Texto cinza claro em fundo branco (contraste WCAG AA falha)
   - Cor de erro = cor de aviso = cor de info (sem distincao)
   - Botao primario indistinguivel do secundario

D) Copy e clareza:
   - "Submit" vs "Salvar alteracoes" (CTAs vagos)
   - Mensagens de erro tecnicas ("ERR_500") em vez de humanas ("Nao foi possivel salvar. Tente de novo.")
   - Labels ambiguos
   - Texto em ingles misturado com pt sem motivo

E) Hierarquia de informacao:
   - Acoes destrutivas (delete) com mesmo peso visual das construtivas (save)
   - Info critica perdida no meio do conteudo
   - Sem progressive disclosure (mostra tudo de uma vez)

F) Responsividade e layout:
   - Quebra visivel em viewport menor (se tiver media query suspeita)
   - Conteudo sobrepondo
   - Scroll horizontal indesejado

G) Acessibilidade pragmatica:
   - Botao sem texto (so icon, sem aria-label)
   - Forms sem <label>
   - Tab order absurdo
   - Imagens decorativas sem alt=""

H) Bugs e quebras (priorizar):
   - Console error grave
   - Click sem nenhum feedback (parece travado)
   - Form que nao submita ou nao valida
   - Layout sobrepoe ou some

CADA COMMENT TEM:
- file: provavel componente/arquivo (ex: "frontend/src/views/LoginView.vue"). Se nao sabe, "<ui>".
- severity:
  * "error"   = quebra ou bloqueia user (categoria H)
  * "warning" = polish IMPORTANTE (categorias B, C, D, F, G — afetam percepcao de qualidade)
  * "info"    = melhoria nice-to-have (categoria A, E em casos sutis)
- message: descricao + ACAO concreta. NAO "o botao podia ser melhor". SIM "Aumente padding do botao Salvar pra py-2 px-4 e adicione hover:bg-blue-600 — hoje fica colado no input."

REGRAS:
- Minimo 3 comments quando tem frontend mudado — sempre da pra polir alguma coisa, mesmo que UI esteja OK.
- Maximo 10 comments. Priorize impacto.
- TODA sugestao deve ter ACAO concreta (cor, tamanho, classe utility, label exata). Vago = inutil.
- NAO bikeshed: nao reclama de cor sem motivo objetivo (contraste real, conflito semantico).
- Pode chamar de "info" coisas que sao opcionais, mas TUDO que voce listar VAI ser implementado pelo code agent — entao so liste o que voce DEFENDERIA.
- finish_critique encerra. Nao chame mais tools depois.
- Max ${MAX_ITERATIONS} iteracoes. Seja eficiente.`,

    en: `You are an autonomous UX/UI CRITIC. Mission: drive the browser (Playwright via tools) to interact with the app preview, find real usability/a11y/copy/visual-hierarchy/error-state issues + visible bugs. Emit structured critique that flows back to the code agent.

TOOLS:
- navigate(url), click(selector), fill(selector,value), get_dom(selector?), get_text(selector?), get_console_errors(), wait(ms), finish_critique({comments:[...]})

PROCESS:
1. Navigate the most relevant route.
2. Inspect DOM + console.
3. Interact: click buttons, fill forms, navigate.
4. Notice what breaks, looks broken, confuses, has bad copy.
5. Call finish_critique with the list.

COMMENT SHAPE: { file, line?, severity: "error"|"warning"|"info", message }
LIMITS: max 10 comments, max ${MAX_ITERATIONS} iterations. Be efficient.`,

    es: `Eres un CRITICO autonomo de UX/UI. Usa el navegador via tools para interactuar con el preview, identificar problemas y emitir una critica estructurada via finish_critique. Max 10 comments, ${MAX_ITERATIONS} iteraciones.`
  };
  const root = base[language];
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
    return `Task: ${taskDescription}\n\nChanged files:\n${filesBlock}\n\nPreview base URL: ${previewUrl}\n\nNavigate the most relevant routes given the changed files. Start by calling navigate("${previewUrl}/").`;
  }
  return `Tarefa: ${taskDescription}\n\nArquivos modificados:\n${filesBlock}\n\nURL base do preview: ${previewUrl}\n\nComece com navigate("${previewUrl}/") e depois explore as rotas mais relevantes dado os arquivos modificados acima.`;
};

// ============== TOOLS SCHEMA (OpenAI function-calling) ==============

const TOOLS_SCHEMA = [
  {
    type: "function" as const,
    function: {
      name: "navigate",
      description: "Navega o browser pra URL absoluta ou path relativo.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "URL absoluta ou path tipo /login" } },
        required: ["url"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "click",
      description: "Clica em elemento. Selector pode ser CSS, text=\"...\", role=\"...\", ou data-testid.",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "fill",
      description: "Preenche um input com valor.",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" }, value: { type: "string" } },
        required: ["selector", "value"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_dom",
      description: "Retorna HTML do elemento (ou body). Cap 4k chars.",
      parameters: {
        type: "object",
        properties: { selector: { type: "string", description: "CSS selector. Omitir = body." } }
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_text",
      description: "Texto visivel do elemento (ou body). Cap 2k chars.",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } }
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_console_errors",
      description: "Lista de errors/warnings do console do browser desde o ultimo call.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "wait",
      description: "Pausa (max 5000ms). Pra esperar animacao/transicao.",
      parameters: {
        type: "object",
        properties: { ms: { type: "number" } },
        required: ["ms"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "finish_critique",
      description: "Encerra emitindo a critica final estruturada. Apos esta chamada nao chame mais tools.",
      parameters: {
        type: "object",
        properties: {
          comments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: "number" },
                severity: { type: "string", enum: ["error", "warning", "info"] },
                message: { type: "string" }
              },
              required: ["severity", "message"]
            }
          }
        },
        required: ["comments"]
      }
    }
  }
];

// ============== TOOL EXECUTORS ==============

// Playwright types nao resolvem em tsc do api/ (mesmo padrao de previewScreenshot.ts).
// Runtime resolve via /app/node_modules/playwright (workspace root). Tipamos como
// any pra evitar tsc failure sem perder a estrutura do codigo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any;

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timeout (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
};

const resolveSelector = (sel: string): string => {
  // Aceita formato "text=...", "role=...", "data-testid=...", ou CSS direto
  if (sel.startsWith("text=") || sel.startsWith("role=") || sel.startsWith("data-testid=")) {
    return sel;
  }
  return sel;
};

const truncate = (s: string, cap: number): string =>
  s.length > cap ? s.slice(0, cap) + `\n[... +${s.length - cap} chars truncados]` : s;

const execTool = async (
  page: Page,
  toolName: string,
  args: Record<string, unknown>,
  previewUrl: string,
  consoleBuffer: string[]
): Promise<{ ok: boolean; result: unknown; summary: string }> => {
  switch (toolName) {
    case "navigate": {
      let url = String(args.url ?? "");
      if (url.startsWith("/")) url = previewUrl.replace(/\/$/, "") + url;
      else if (!/^https?:\/\//.test(url)) url = previewUrl.replace(/\/$/, "") + "/" + url;
      try {
        await withTimeout(page.goto(url, { waitUntil: "domcontentloaded", timeout: TOOL_TIMEOUT_MS }), TOOL_TIMEOUT_MS, "navigate");
        await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {/* best-effort */});
        return { ok: true, result: { url, title: await page.title().catch(() => "") }, summary: `→ ${url}` };
      } catch (e) {
        return { ok: false, result: { error: e instanceof Error ? e.message : String(e) }, summary: `navigate FAIL ${url}` };
      }
    }

    case "click": {
      const selector = resolveSelector(String(args.selector ?? ""));
      try {
        await withTimeout(page.locator(selector).first().click({ timeout: TOOL_TIMEOUT_MS }), TOOL_TIMEOUT_MS, "click");
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
        return { ok: true, result: { clicked: selector }, summary: `click ${selector}` };
      } catch (e) {
        return { ok: false, result: { error: e instanceof Error ? e.message : String(e) }, summary: `click FAIL ${selector}` };
      }
    }

    case "fill": {
      const selector = resolveSelector(String(args.selector ?? ""));
      const value = String(args.value ?? "");
      try {
        await withTimeout(page.locator(selector).first().fill(value, { timeout: TOOL_TIMEOUT_MS }), TOOL_TIMEOUT_MS, "fill");
        return { ok: true, result: { filled: selector, value }, summary: `fill ${selector}="${value.slice(0, 30)}"` };
      } catch (e) {
        return { ok: false, result: { error: e instanceof Error ? e.message : String(e) }, summary: `fill FAIL ${selector}` };
      }
    }

    case "get_dom": {
      const selector = typeof args.selector === "string" && args.selector.length > 0 ? args.selector : "body";
      try {
        // Cast pra string: playwright types nao resolvem em tsc do api/, mesma
        // situacao de previewScreenshot.ts. Runtime ok (page eh real).
        const html = await withTimeout(
          page.locator(selector).first().evaluate(((el: { outerHTML: string }) => el.outerHTML) as never),
          TOOL_TIMEOUT_MS,
          "get_dom"
        ) as string;
        return { ok: true, result: { html: truncate(html, DOM_SNIPPET_CAP) }, summary: `dom ${selector} (${html.length}c)` };
      } catch (e) {
        return { ok: false, result: { error: e instanceof Error ? e.message : String(e) }, summary: `dom FAIL ${selector}` };
      }
    }

    case "get_text": {
      const selector = typeof args.selector === "string" && args.selector.length > 0 ? args.selector : "body";
      try {
        const text = await withTimeout(
          page.locator(selector).first().innerText({ timeout: TOOL_TIMEOUT_MS }),
          TOOL_TIMEOUT_MS,
          "get_text"
        ) as string;
        return { ok: true, result: { text: truncate(text, TEXT_SNIPPET_CAP) }, summary: `text ${selector} (${text.length}c)` };
      } catch (e) {
        return { ok: false, result: { error: e instanceof Error ? e.message : String(e) }, summary: `text FAIL ${selector}` };
      }
    }

    case "get_console_errors": {
      const drained = consoleBuffer.splice(0, CONSOLE_ERRORS_CAP);
      return { ok: true, result: { errors: drained, drained: drained.length }, summary: `console (${drained.length} errs)` };
    }

    case "wait": {
      const ms = Math.min(Math.max(Number(args.ms ?? 500), 0), 5000);
      await page.waitForTimeout(ms);
      return { ok: true, result: { waited: ms }, summary: `wait ${ms}ms` };
    }

    case "finish_critique": {
      const comments = Array.isArray(args.comments) ? args.comments : [];
      return { ok: true, result: { comments, count: comments.length }, summary: `finish (${comments.length} comments)` };
    }

    default:
      return { ok: false, result: { error: `unknown tool: ${toolName}` }, summary: `?? ${toolName}` };
  }
};

// ============== MAIN ==============

/**
 * UX Critic autonomo. Lanca Playwright contra um preview, deixa um LLM
 * dirigir o browser via tool-calling, captura observacoes (DOM, console,
 * texto), emite ReviewComment[] compativel com o review-loop existente.
 *
 * Falhas (qualquer tipo) caem em fallback gracioso: retorna skipped:true e
 * comments vazio. NUNCA bloqueia o pipeline.
 */
export const criticizeUI = async (input: UxCriticInput): Promise<UxCriticResult> => {
  const { previewUrl, taskDescription, changedFiles, language = "pt", projectContextText } = input;
  const trace: UxCriticResult["trace"] = [];

  if (!previewUrl) {
    return { comments: [], usage: ZERO_USAGE, trace, skipped: true, reason: "no_preview_url", iterations: 0 };
  }

  // 1. Launch chromium (full, nao headless-shell)
  // Tipados como any: ver comentario em `type Page = any` no topo deste arquivo.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let context: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any = null;
  const consoleBuffer: string[] = [];

  try {
    // playwright resolve em /app/node_modules/playwright (workspace root),
    // mas tsc do api/ nao encontra. Mesmo padrao de previewScreenshot.ts.
    // @ts-expect-error -- runtime ok, tsc nao acha types da playwright aqui
    const { chromium } = await import("playwright");
    const chromiumExe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || findFullChromium();
    browser = await chromium.launch({
      headless: true,
      ...(chromiumExe ? { executablePath: chromiumExe } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true
    });
    page = await context.newPage();

    page.on("console", (msg: { type: () => string; text: () => string }) => {
      const t = msg.type();
      if (t === "error" || t === "warning") {
        consoleBuffer.push(`[${t}] ${msg.text().slice(0, 300)}`);
      }
    });
    page.on("pageerror", (err: { message: string }) => {
      consoleBuffer.push(`[pageerror] ${err.message.slice(0, 300)}`);
    });
  } catch (e) {
    return {
      comments: [],
      usage: ZERO_USAGE,
      trace,
      skipped: true,
      reason: `chromium_launch_failed: ${e instanceof Error ? e.message : String(e)}`,
      iterations: 0
    };
  }

  const cleanup = async () => {
    try { await context?.close(); } catch {/* noop */}
    try { await browser?.close(); } catch {/* noop */}
  };

  // 2. LLM setup
  const route = await selectRoute("taskReviewer", { description: taskDescription });
  const client = getClient(route.provider);
  const model = route.model;

  const messages: import("openai/resources/chat/completions.js").ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(language, projectContextText) },
    { role: "user", content: buildUserPrompt(taskDescription, changedFiles, previewUrl, language) }
  ];

  let totalUsage: TokenUsage = ZERO_USAGE;
  let finalComments: { file?: string; line?: number; severity: "error" | "warning" | "info"; message: string }[] = [];
  let iter = 0;
  let finishedExplicitly = false;

  // 3. Tool-use loop
  for (iter = 0; iter < MAX_ITERATIONS; iter++) {
    let completion: Awaited<ReturnType<typeof client.chat.completions.create>> | null = null;
    try {
      completion = await withRetry(
        async () => client.chat.completions.create({
          model,
          temperature: 0.2,
          messages,
          tools: TOOLS_SCHEMA,
          tool_choice: iter === MAX_ITERATIONS - 1
            ? { type: "function", function: { name: "finish_critique" } }
            : "auto"
        }),
        { label: "uxCritic-iter", attempts: 2, baseDelayMs: 500, fallback: () => null }
      );
    } catch (e) {
      await cleanup();
      return {
        comments: [],
        usage: totalUsage,
        trace,
        skipped: true,
        reason: `llm_call_failed: ${e instanceof Error ? e.message : String(e)}`,
        iterations: iter
      };
    }

    if (!completion) {
      await cleanup();
      return { comments: [], usage: totalUsage, trace, skipped: true, reason: "llm_no_completion", iterations: iter };
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
    if (toolCalls.length === 0) {
      // LLM resolveu nao chamar tool — assumimos que terminou (mesmo sem finish_critique).
      break;
    }

    for (const tc of toolCalls) {
      const fnName = tc.function.name;
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments || "{}");
      } catch {/* invalid args -> treat as empty */}

      const exec = await execTool(page, fnName, parsedArgs, previewUrl, consoleBuffer);
      trace.push({ tool: fnName, args: parsedArgs, ok: exec.ok, summary: exec.summary });

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(exec.result)
      } as import("openai/resources/chat/completions.js").ChatCompletionToolMessageParam);

      if (fnName === "finish_critique" && exec.ok) {
        const r = exec.result as { comments?: unknown };
        if (Array.isArray(r.comments)) {
          finalComments = (r.comments as unknown[])
            .map((raw): typeof finalComments[number] | null => {
              if (!raw || typeof raw !== "object") return null;
              const c = raw as Record<string, unknown>;
              const sev = c.severity;
              if (sev !== "error" && sev !== "warning" && sev !== "info") return null;
              if (typeof c.message !== "string" || c.message.length === 0) return null;
              return {
                file: typeof c.file === "string" ? c.file : undefined,
                line: typeof c.line === "number" ? c.line : undefined,
                severity: sev,
                message: c.message
              };
            })
            .filter((c): c is NonNullable<typeof c> => c !== null);
        }
        finishedExplicitly = true;
        break;
      }
    }

    if (finishedExplicitly) break;
  }

  await cleanup();

  // Mapeia file pra paths do changedFiles quando possivel
  const comments: ReviewComment[] = finalComments.slice(0, 10).map(c => ({
    file: mapCommentToFile(c, changedFiles),
    line: c.line,
    severity: c.severity,
    message: `[ux-critic] ${c.message}`
  }));

  console.info(
    `[uxCritic] done iter=${iter + (finishedExplicitly ? 1 : 0)} finishedExplicitly=${finishedExplicitly} ` +
    `comments=${comments.length} tokens=${totalUsage.totalTokens} trace=${trace.length} tools`
  );

  return {
    comments,
    usage: totalUsage,
    trace,
    skipped: false,
    reason: finishedExplicitly ? undefined : "max_iterations_or_text_response",
    iterations: iter + (finishedExplicitly ? 1 : 0)
  };
};

// Force mkdir reference to avoid unused-import in case build strips
void mkdir;
void __dirname;
