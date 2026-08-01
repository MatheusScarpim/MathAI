/**
 * Captura screenshot de uma URL via Playwright (Chromium headless).
 *
 * Usado pelo comando `!test` do bot WhatsApp pra mostrar uma preview visual
 * da app junto com a URL — o usuario nem precisa abrir o link.
 *
 * Fluxo:
 *   1. Sobe browser headless (compartilhado entre chamadas, lazy-init)
 *   2. Cria contexto novo (cookies/localStorage isolados por capture)
 *   3. Navega com waitUntil: 'networkidle' + timeout
 *   4. Pequena espera adicional pra animacoes settle
 *   5. Captura PNG (viewport 1280x800 por default)
 *
 * Erros sao retornados como `null` — caller decide se segue sem imagem.
 */

import type { Browser, Page } from "playwright";
import type {
  NavAction,
  PageInspection
} from "../orchestrator/agents/previewNavigator.js";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * Espera ate o tunel cloudflared estar globalmente resolvivel + respondendo.
 * Cloudflared `trycloudflare` cria subdominios random que podem demorar 5-30s
 * pra propagar no DNS global, mesmo apos a stdout dizer "ready".
 *
 * Faz HEAD request com timeout curto, retry a cada 2s ate TUNNEL_READY_MAX_MS.
 * Retorna true se respondeu, false se timeout.
 */
const waitForTunnelReady = async (
  url: string,
  onWait?: (elapsedMs: number, attempts: number) => void | Promise<void>
): Promise<boolean> => {
  const startedAt = Date.now();
  let attempt = 0;
  let nextNotifyAt = 30_000; // primeiro aviso aos 30s
  while (Date.now() - startedAt < TUNNEL_READY_MAX_MS) {
    attempt++;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TUNNEL_PROBE_TIMEOUT_MS);
      const res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
      clearTimeout(timer);
      // Qualquer resposta HTTP (mesmo 4xx) significa que DNS resolveu + tunel ativo.
      if (res.status < 600) {
        console.info(
          `[previewScreenshot] tunnel pronto apos ${attempt} tentativas (${Date.now() - startedAt}ms, status=${res.status})`
        );
        return true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === 1 || attempt % 5 === 0) {
        console.info(`[previewScreenshot] tunnel probe ${attempt}: ${msg.slice(0, 100)}`);
      }
    }

    const elapsed = Date.now() - startedAt;
    // Notifica via callback a cada ~30s
    if (onWait && elapsed >= nextNotifyAt) {
      try { await onWait(elapsed, attempt); } catch { /* ignore */ }
      nextNotifyAt += 30_000;
    }

    await new Promise(r => setTimeout(r, TUNNEL_PROBE_INTERVAL_MS));
  }
  console.warn(
    `[previewScreenshot] tunnel ${url} nao respondeu em ${TUNNEL_READY_MAX_MS}ms (${attempt} tentativas)`
  );
  return false;
};

// Localiza o binario do chromium COMPLETO (nao o headless-shell, que nao
// suporta gravacao de video). Procura em locais conhecidos do Playwright:
//   /ms-playwright/chromium-<rev>/chrome-linux64/chrome
//   /ms-playwright/chromium-<rev>/chrome-linux/chrome
const findFullChromium = async (): Promise<string | null> => {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/ms-playwright";
  const candidates = [
    join(base, "chromium-1223/chrome-linux64/chrome"),
    join(base, "chromium-1223/chrome-linux/chrome"),
    join(base, "chromium-1155/chrome-linux/chrome"),
    join(base, "chromium-1155/chrome-linux64/chrome")
  ];
  for (const path of candidates) {
    try {
      const s = await stat(path);
      if (s.isFile()) return path;
    } catch { /* segue tentando */ }
  }
  // Fallback dinamico: listar dirs e procurar o mais recente
  try {
    const entries = await readdir(base);
    const chromiumDirs = entries.filter(e => e.startsWith("chromium-") && !e.includes("headless"));
    chromiumDirs.sort().reverse(); // mais recente primeiro
    for (const dir of chromiumDirs) {
      for (const sub of ["chrome-linux64", "chrome-linux"]) {
        const path = join(base, dir, sub, "chrome");
        try {
          const s = await stat(path);
          if (s.isFile()) return path;
        } catch { /* segue */ }
      }
    }
  } catch { /* fallback final */ }
  return null;
};

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const NAV_TIMEOUT_MS = 20_000;
const SETTLE_DELAY_MS = 1500;
const ACTION_TIMEOUT_MS = 5_000;
const SCREENSHOT_TIMEOUT_MS = 10_000;
const POST_ACTIONS_SETTLE_MS = 600;
const TUNNEL_READY_MAX_MS = 120_000; // cloudflared trycloudflare DNS pode levar 1-2min pra propagar
const TUNNEL_PROBE_INTERVAL_MS = 3_000;
const TUNNEL_PROBE_TIMEOUT_MS = 4_000;

/** Browser compartilhado (lazy). Reusa entre chamadas pra evitar boot de 1-2s. */
let sharedBrowser: Browser | null = null;
let initLock: Promise<Browser> | null = null;

const getBrowser = async (): Promise<Browser> => {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  if (initLock) return initLock;

  initLock = (async () => {
    const { chromium } = await import("playwright");
    // IMPORTANTE: Playwright v1.49+ usa `chrome-headless-shell` por default,
    // que NAO suporta gravacao de video. Forcamos o chromium COMPLETO via
    // executablePath. Os bins ficam em /ms-playwright/chromium-<rev>/chrome-linux*/chrome.
    const chromiumExe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      || await findFullChromium();
    const browser = await chromium.launch({
      headless: true,
      ...(chromiumExe ? { executablePath: chromiumExe } : {}),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", // evita /dev/shm pequeno no container
        "--disable-gpu"
      ]
    });
    console.info(
      `[previewScreenshot] chromium launched ${chromiumExe ? `via ${chromiumExe}` : "(default headless-shell)"}`
    );
    // Reset shared se browser desconectar (chrome crash, etc).
    browser.on("disconnected", () => {
      if (sharedBrowser === browser) sharedBrowser = null;
    });
    sharedBrowser = browser;
    return browser;
  })();

  try {
    const b = await initLock;
    return b;
  } finally {
    initLock = null;
  }
};

export type ScreenshotOptions = {
  url: string;
  /** Rota a navegar apos abrir a URL base (ex: "/calculadora"). Default "/". */
  route?: string;
  /** Sequencia de acoes pra executar antes da captura (best-effort). */
  actions?: NavAction[];
  /** Viewport. Default 1280x800. */
  viewport?: { width: number; height: number };
  /** Full page (true) ou apenas viewport (false). Default false. */
  fullPage?: boolean;
  /**
   * Se true, grava video webm de toda a sessao (navegacao + acoes).
   * Default false. Custo: ~5-10MB extra de output + ~500ms overhead.
   */
  recordVideo?: boolean;
  /**
   * Callback chamado APOS o page load + settle com o snapshot do DOM real.
   * Retorna acoes finais (substituem `actions` estatica). Se retornar [] ou
   * lancar, segue com `actions` estatica como fallback.
   *
   * Usado pelo `!test` pra fazer 2-pass: navigator decide rota com base nos
   * arquivos -> page abre -> inspecionamos DOM real -> LLM gera acoes
   * ancoradas em selectors observados (sem alucinacao).
   */
  inspectAndPlan?: (inspection: PageInspection) => Promise<NavAction[]>;
  /**
   * Chamado periodicamente enquanto esperamos o tunel propagar (~a cada 30s).
   * Usado pelo handleTest pra avisar usuario no WhatsApp que ainda esta esperando.
   */
  onTunnelWait?: (elapsedMs: number, attempts: number) => void | Promise<void>;
};

export type ActionResult = { type: string; ok: boolean; reason?: string };

export type VideoMime = "video/mp4" | "video/webm";

export type ScreenshotResult =
  | {
      ok: true;
      buffer: Buffer;
      bytes: number;
      durationMs: number;
      finalUrl: string;
      actionResults: ActionResult[];
      /** Buffer do video (mp4 se conversao OK, webm caso contrario). */
      videoBuffer?: Buffer;
      /** Tamanho do video em bytes. */
      videoBytes?: number;
      /** Mimetype do video (sempre mp4 quando ffmpeg disponivel, webm como fallback). */
      videoMime?: VideoMime;
    }
  | { ok: false; reason: string };

/**
 * Captura PNG da URL. Best-effort: erros viram `ok: false` (nao lanca).
 */
export const captureUrl = async (
  opts: ScreenshotOptions
): Promise<ScreenshotResult> => {
  const startedAt = Date.now();
  const viewport = opts.viewport ?? DEFAULT_VIEWPORT;

  // 0. Espera tunel propagar DNS antes de gastar recurso no browser.
  //    cloudflared trycloudflare pode levar 30s-2min pra ficar globalmente resolvivel.
  const tunnelReady = await waitForTunnelReady(opts.url, opts.onTunnelWait);
  if (!tunnelReady) {
    return {
      ok: false,
      reason: `tunnel ${opts.url} nao ficou pronto em ${TUNNEL_READY_MAX_MS}ms`
    };
  }

  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    return {
      ok: false,
      reason: `playwright launch falhou: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  // Setup video recording se solicitado.
  // Playwright grava webm continuo do moment do newContext ate context.close.
  let videoDir: string | null = null;
  if (opts.recordVideo) {
    try {
      videoDir = await mkdtemp(join(tmpdir(), "mathai-rec-"));
      console.info(`[previewScreenshot] video dir criado: ${videoDir}`);
    } catch (err) {
      console.warn(`[previewScreenshot] mkdtemp falhou (sem video):`, err);
    }
  }

  const context = await browser.newContext({
    viewport,
    recordVideo: videoDir ? { dir: videoDir, size: viewport } : undefined
  });

  // Seed de auth no localStorage ANTES de qualquer JS do app rodar. Muitos SPAs
  // (ex: ScarlatMercadinho) hidratam o auth store SO do localStorage no boot e
  // NAO chamam /auth/me — entao mockar HTTP via MSW nao basta: sem token+user o
  // router guard redireciona a rota protegida (/admin/dashboard) pra /login e o
  // preview nunca mostra a feature. Semeamos as chaves comuns com um usuario
  // ADMIN full-permission. Roda em toda pagina do context (persiste no goto).
  const previewUser = {
    id: "preview-user",
    name: "Preview User",
    email: "preview@mathai.dev",
    role: "ADMIN",
    permissions: ["*"]
  };
  const previewToken = "preview-fake-token";
  await context.addInitScript(
    ([user, token]: [typeof previewUser, string]) => {
      try {
        const userJson = JSON.stringify(user);
        // Chaves de token comuns (string crua).
        for (const k of ["token", "accessToken", "access_token", "authToken", "auth_token", "jwt", "id_token"]) {
          window.localStorage.setItem(k, token);
        }
        // Chaves de usuario comuns (JSON).
        for (const k of ["user", "currentUser", "auth", "authUser", "profile"]) {
          window.localStorage.setItem(k, userJson);
        }
      } catch { /* localStorage indisponivel — ignora */ }
    },
    [previewUser, previewToken] as [typeof previewUser, string]
  );

  const page = await context.newPage();

  // 1. Navegacao inicial — combina url base + route opcional.
  //    URL base ja pode ter path, entao mergeamos respeitando o "/".
  const target = combineUrlRoute(opts.url, opts.route);
  try {
    await page.goto(target, {
      waitUntil: "networkidle",
      timeout: NAV_TIMEOUT_MS
    });
  } catch (err) {
    // Mesmo com timeout de navegacao, tenta capturar o que tiver renderizado.
    console.warn(
      `[previewScreenshot] goto incompleto pra ${target}:`,
      err instanceof Error ? err.message : err
    );
  }

  // Pequena espera pra animacoes settle.
  await page.waitForTimeout(SETTLE_DELAY_MS);

  // 2a. Inspeciona DOM real e re-planeja acoes via callback (2-pass).
  //     Se callback faltar/falhar/voltar vazio, usa opts.actions como fallback.
  let resolvedActions: NavAction[] = opts.actions ?? [];
  if (opts.inspectAndPlan) {
    try {
      const inspection = await inspectPage(page);
      const planned = await opts.inspectAndPlan(inspection);
      if (Array.isArray(planned) && planned.length > 0) {
        resolvedActions = planned;
        console.info(
          `[previewScreenshot] inspectAndPlan: ${inspection.inputs.length} inputs, ${inspection.buttons.length} botoes -> ${planned.length} acoes`
        );
      } else {
        console.info(`[previewScreenshot] inspectAndPlan retornou vazio — usando fallback (${resolvedActions.length} acoes)`);
      }
    } catch (err) {
      console.warn(
        `[previewScreenshot] inspectAndPlan falhou — usando fallback:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // 2b. Executa acoes (best-effort — erro nao bloqueia screenshot).
  const actionResults: ActionResult[] = [];
  for (const action of resolvedActions) {
    const result = await executeAction(page, action, opts.url);
    actionResults.push(result);
    if (!result.ok) {
      console.warn(
        `[previewScreenshot] acao ${action.type} falhou:`,
        result.reason
      );
    }
  }

  // Settle pos-acoes pra deixar o ultimo frame estavel no video.
  if (opts.recordVideo) {
    await page.waitForTimeout(POST_ACTIONS_SETTLE_MS);
  }

  // 3. Captura screenshot
  let buffer: Buffer;
  try {
    buffer = await page.screenshot({
      type: "png",
      fullPage: opts.fullPage ?? false,
      timeout: SCREENSHOT_TIMEOUT_MS
    });
  } catch (err) {
    await closeAndCleanup(context, videoDir);
    return {
      ok: false,
      reason: `screenshot falhou: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  const finalUrl = page.url();

  // 4. Le video usando a API explicita do Playwright.
  //    page.video() retorna o objeto Video; saveAs/path() resolve apos context.close.
  let videoBuffer: Buffer | undefined;
  const video = videoDir ? page.video() : null;
  if (video) {
    console.info(`[previewScreenshot] page.video() = ${video ? "obj" : "null"}`);
  }

  await page.close().catch(() => {});
  await context.close().catch(() => {});

  let videoWebmPath: string | null = null;
  if (videoDir) {
    try {
      // Tenta primeiro via API do Playwright (mais confiavel).
      if (video) {
        try {
          const p: string = await video.path();
          videoWebmPath = p;
          console.info(`[previewScreenshot] video.path() = ${p}`);
          videoBuffer = await readFile(p);
          console.info(`[previewScreenshot] video lido: ${videoBuffer.length} bytes via API`);
        } catch (err) {
          console.warn(`[previewScreenshot] video.path() falhou, fallback pra readdir:`, err);
        }
      }
      // Fallback: listar o diretorio
      if (!videoBuffer) {
        const files = await readdir(videoDir);
        console.info(`[previewScreenshot] arquivos em videoDir: ${JSON.stringify(files)}`);
        const webm = files.find(f => f.endsWith(".webm"));
        if (webm) {
          videoWebmPath = join(videoDir, webm);
          videoBuffer = await readFile(videoWebmPath);
          console.info(`[previewScreenshot] video lido: ${videoBuffer.length} bytes via readdir`);
        } else {
          console.warn(`[previewScreenshot] nenhum .webm em ${videoDir}`);
        }
      }
    } catch (err) {
      console.warn(`[previewScreenshot] le video falhou:`, err);
    }
  }

  // Converte webm -> mp4 pra WhatsApp tocar nativo (webm tem suporte limitado).
  let videoMime: VideoMime = "video/webm";
  if (videoBuffer && videoWebmPath && videoDir) {
    try {
      const mp4Path = join(videoDir, "page.mp4");
      const converted = await convertWebmToMp4(videoWebmPath, mp4Path);
      if (converted) {
        const mp4Buffer = await readFile(mp4Path);
        console.info(`[previewScreenshot] convertido webm(${videoBuffer.length})->mp4(${mp4Buffer.length})`);
        videoBuffer = mp4Buffer;
        videoMime = "video/mp4";
      } else {
        console.warn(`[previewScreenshot] conversao mp4 falhou — enviando webm`);
      }
    } catch (err) {
      console.warn(`[previewScreenshot] erro na conversao mp4:`, err instanceof Error ? err.message : err);
    }
  }

  // Cleanup do dir tmp depois de tudo.
  if (videoDir) {
    await rm(videoDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    ok: true,
    buffer,
    bytes: buffer.length,
    durationMs: Date.now() - startedAt,
    finalUrl,
    actionResults,
    videoBuffer,
    videoBytes: videoBuffer?.length,
    videoMime: videoBuffer ? videoMime : undefined
  };
};

/** Fecha context + remove dir de video. Usado em paths de erro. */
const closeAndCleanup = async (
  context: Awaited<ReturnType<Browser["newContext"]>>,
  videoDir: string | null
): Promise<void> => {
  await context.close().catch(() => {});
  if (videoDir) {
    await rm(videoDir, { recursive: true, force: true }).catch(() => {});
  }
};

// ─── Action executor ────────────────────────────────────────────────────

/**
 * Executa uma NavAction com timeout. Erros sao capturados — caller decide
 * se continua ou nao (no caso de screenshot, continuamos sempre).
 */
const executeAction = async (
  page: Page,
  action: NavAction,
  baseUrl: string
): Promise<ActionResult> => {
  try {
    switch (action.type) {
      case "wait":
        await page.waitForTimeout(action.ms);
        return { type: "wait", ok: true };
      case "click":
        await page.click(action.selector, { timeout: ACTION_TIMEOUT_MS });
        return { type: "click", ok: true };
      case "fill":
        await page.fill(action.selector, action.value, { timeout: ACTION_TIMEOUT_MS });
        return { type: "fill", ok: true };
      case "goto": {
        const target = combineUrlRoute(baseUrl, action.path);
        await page.goto(target, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
        return { type: "goto", ok: true };
      }
    }
  } catch (err) {
    return {
      type: action.type,
      ok: false,
      reason: err instanceof Error ? err.message : String(err)
    };
  }
};

/**
 * Combina uma URL base (ex: "https://x.trycloudflare.com") com uma rota
 * (ex: "/calculadora"). Tolerante a barras duplicadas.
 */
const combineUrlRoute = (base: string, route?: string): string => {
  if (!route || route === "/") return base;
  const baseClean = base.endsWith("/") ? base.slice(0, -1) : base;
  const routeClean = route.startsWith("/") ? route : `/${route}`;
  return `${baseClean}${routeClean}`;
};

/**
 * Script (JS puro) executado no contexto do browser pra extrair inputs/botoes
 * visiveis. Passamos como STRING propositalmente — tsx/esbuild injeta um
 * helper `__name` em funcoes TS que NAO existe no contexto do browser, causando
 * "ReferenceError: __name is not defined" quando `page.evaluate` recebe uma
 * arrow function transpilada.
 */
const INSPECT_SCRIPT = `(() => {
  function isVisible(el) {
    if (!el.getClientRects || !el.getClientRects().length) return false;
    var s = window.getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }
  function getLabelText(input) {
    var id = input.id;
    if (id) {
      var lbl = document.querySelector('label[for="' + id.replace(/"/g, '\\\\"') + '"]');
      if (lbl) {
        var t = (lbl.textContent || "").trim().slice(0, 60);
        return t || null;
      }
    }
    var parent = input.closest && input.closest("label");
    if (parent) {
      var clone = parent.cloneNode(true);
      var nested = clone.querySelectorAll("input, textarea, select");
      for (var i = 0; i < nested.length; i++) nested[i].remove();
      var t2 = (clone.textContent || "").trim().slice(0, 60);
      return t2 || null;
    }
    return null;
  }

  var inputs = [];
  var inputEls = document.querySelectorAll("input, textarea, select");
  for (var i = 0; i < inputEls.length && inputs.length < 30; i++) {
    var el = inputEls[i];
    if (!isVisible(el)) continue;
    inputs.push({
      tag: el.tagName.toLowerCase(),
      name: el.getAttribute("name") || null,
      id: el.id || null,
      type: el.getAttribute("type") || null,
      placeholder: el.getAttribute("placeholder") || null,
      ariaLabel: el.getAttribute("aria-label") || null,
      label: getLabelText(el)
    });
  }

  var buttons = [];
  var btnEls = document.querySelectorAll('button, [role="button"], a[href], input[type="submit"]');
  for (var j = 0; j < btnEls.length && buttons.length < 50; j++) {
    var bel = btnEls[j];
    if (!isVisible(bel)) continue;
    var txt = (bel.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 60);
    buttons.push({
      tag: bel.tagName.toLowerCase(),
      text: txt || null,
      id: bel.id || null,
      ariaLabel: bel.getAttribute("aria-label") || null,
      dataTestid: bel.getAttribute("data-testid") || null,
      type: bel.getAttribute("type") || null
    });
  }

  return {
    title: document.title || "",
    url: window.location.href,
    inputs: inputs,
    buttons: buttons
  };
})()`;

/**
 * Extrai inputs/botoes visiveis da pagina pra LLM gerar selectors REAIS.
 * Roda no contexto do browser via page.evaluate (com script string — ver INSPECT_SCRIPT).
 */
const inspectPage = async (page: Page): Promise<PageInspection> => {
  return (await page.evaluate(INSPECT_SCRIPT)) as PageInspection;
};

/**
 * Localiza o binario ffmpeg. Prefere o instalado via apt (FULL build com libx264),
 * o bundle do Playwright e ultimo fallback (e minimo, sem libx264).
 */
const findFfmpeg = async (): Promise<string | null> => {
  const candidates = [
    "/usr/bin/ffmpeg",        // apt install — full build, tem libx264 + libfdk_aac
    "/usr/local/bin/ffmpeg",  // compilado manualmente, geralmente full
    "/ms-playwright/ffmpeg-1011/ffmpeg-linux", // Playwright bundle (minimal, fallback)
    "/ms-playwright/ffmpeg/ffmpeg-linux"
  ];
  for (const p of candidates) {
    try {
      const s = await stat(p);
      if (s.isFile()) return p;
    } catch { /* segue */ }
  }
  return null;
};

/**
 * Converte webm -> mp4 H.264 + AAC pra compatibilidade com WhatsApp.
 * Retorna true se conversao ok, false em qualquer falha.
 *
 * Preset "faster" + crf 28 = arquivo pequeno (~mesma ordem do webm) e rapido.
 * yuv420p + faststart sao requisitos de mobile players (incluindo WA).
 */
const convertWebmToMp4 = async (
  webmPath: string,
  mp4Path: string
): Promise<boolean> => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    console.warn("[previewScreenshot] ffmpeg nao encontrado — pulando conversao mp4");
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const args = [
      "-y",
      "-i", webmPath,
      "-c:v", "libx264",
      "-preset", "faster",
      "-crf", "28",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an", // sem audio (preview nao tem som)
      mp4Path
    ];
    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", chunk => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      console.warn("[previewScreenshot] ffmpeg timeout 30s");
      resolve(false);
    }, 30_000);
    proc.on("exit", code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(true);
      } else {
        console.warn(`[previewScreenshot] ffmpeg exit=${code} stderr=${stderr.slice(-300)}`);
        resolve(false);
      }
    });
    proc.on("error", err => {
      clearTimeout(timer);
      console.warn(`[previewScreenshot] ffmpeg spawn err:`, err.message);
      resolve(false);
    });
  });
};

/** Fecha o browser compartilhado (cleanup no shutdown). */
export const closeBrowser = async (): Promise<void> => {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
  }
};
