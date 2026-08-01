/**
 * Setup MSW + build:preview DIRETAMENTE no worktree, sem agent LLM.
 *
 * Substitui o fluxo antigo baseado em getMswSetupSubtasks() + executeTask() —
 * o agente OpenClaude estava escapando do worktree e escrevendo em /openclaude/...
 * O conteudo de cada arquivo e literal/deterministico, entao agente e overkill.
 *
 * Este helper:
 *   1. Cria worktree na branch mathai/setup-preview-<timestamp>
 *   2. Detecta diretorio do frontend (frontend/, apps/web/, apps/frontend/, raiz)
 *   3. Patch package.json (msw devDep + build:preview script)
 *   4. Cria src/mocks/preview/browser.ts + handlers.ts
 *   5. Detecta entrypoint (main.ts, main.tsx, index.tsx, index.ts) e injeta
 *      bloco condicional de bootstrap do worker
 *   6. Commit + push + PR
 *
 * Idempotente: re-rodar nao quebra. Se o PR ja existe, atualiza body e devolve.
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { simpleGit } from "simple-git";
import {
  createWorktree,
  branchHasCommits,
  pushBranch,
  createOrGetPullRequest,
  removeWorktree
} from "../orchestrator/integrations/github.js";
import type { GithubRepoConfig } from "../orchestrator/types.js";
import { MOCK_SERVICE_WORKER_JS } from "./mockServiceWorkerStatic.js";

const MSW_VERSION = "^2.6.0";

/**
 * Marcador de versao do scaffold — incrementar quando BROWSER_TS/HANDLERS_TS mudar.
 * Se o arquivo em master tem versao < atual, o setup reescreve em vez de pular.
 */
const SCAFFOLD_VERSION = 5;
const SCAFFOLD_TAG = `@mathai-preview-scaffold-v${SCAFFOLD_VERSION}`;

/**
 * browser.ts — seedea localStorage com sessao fake ANTES de start do worker.
 * Cobre as chaves mais comuns (token, user, accessToken, auth_token) com defaults
 * razoaveis pra apps Vue/React que checam essas chaves no boot pra pular login.
 */
const BROWSER_TS = `// ${SCAFFOLD_TAG}
import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

/** Sessao fake injetada antes do worker subir — mata redirects pra tela de login. */
const PREVIEW_USER = {
  id: 'preview-user',
  name: 'Preview User',
  email: 'preview@mathai.dev',
  role: 'ADMIN',
  permissions: ['*']
};
const PREVIEW_TOKEN = 'preview-fake-token';

try {
  // Chaves mais comuns — apps diferentes usam nomes diferentes.
  localStorage.setItem('token', PREVIEW_TOKEN);
  localStorage.setItem('accessToken', PREVIEW_TOKEN);
  localStorage.setItem('auth_token', PREVIEW_TOKEN);
  localStorage.setItem('authToken', PREVIEW_TOKEN);
  localStorage.setItem('user', JSON.stringify(PREVIEW_USER));
  localStorage.setItem('currentUser', JSON.stringify(PREVIEW_USER));
  localStorage.setItem('auth', JSON.stringify({ token: PREVIEW_TOKEN, user: PREVIEW_USER }));
} catch { /* ignore — localStorage pode estar bloqueado */ }

export const worker = setupWorker(...handlers);
`;

// handlers.ts — handlers genericos com wildcards de origem (*-slash-auth-slash-login)
// pra intercepter independente de baseURL. Cobrir:
//  - login/logout/refresh
//  - GET /me ou /auth/me ou /user
//  - catch-all (last) pra evitar 404 em endpoints desconhecidos
const HANDLERS_TS = `// ${SCAFFOLD_TAG}
import { http, HttpResponse } from 'msw';

/**
 * Handlers MSW pro modo preview.
 * Cobre auth-bypass generico — substitua/adicione conforme a app evolui.
 */

const PREVIEW_USER = {
  id: 'preview-user',
  name: 'Preview User',
  email: 'preview@mathai.dev',
  role: 'ADMIN',
  permissions: ['*']
};
const PREVIEW_TOKEN = 'preview-fake-token';

export const handlers = [
  // ─── Auth status / config (apps com auth-toggle) ────────
  // Estes handlers fazem o router guard pular o redirect pra /login.
  http.get('*/auth/status', () => HttpResponse.json({ enabled: false })),
  http.get('*/api/auth/status', () => HttpResponse.json({ enabled: false })),
  http.get('*/auth/check', () =>
    HttpResponse.json({ ok: true, authenticated: true, user: PREVIEW_USER })
  ),
  http.get('*/auth/session', () =>
    HttpResponse.json({ token: PREVIEW_TOKEN, user: PREVIEW_USER, authenticated: true })
  ),
  http.get('*/health', () => HttpResponse.json({ ok: true })),
  http.get('*/api/health', () => HttpResponse.json({ ok: true })),

  // ─── Auth ───────────────────────────────────────────────
  http.post('*/auth/login', () =>
    HttpResponse.json({ token: PREVIEW_TOKEN, user: PREVIEW_USER })
  ),
  http.post('*/api/auth/login', () =>
    HttpResponse.json({ token: PREVIEW_TOKEN, user: PREVIEW_USER })
  ),
  http.post('*/login', () =>
    HttpResponse.json({ token: PREVIEW_TOKEN, user: PREVIEW_USER })
  ),
  http.post('*/auth/logout', () => HttpResponse.json({ ok: true })),
  http.post('*/auth/refresh', () =>
    HttpResponse.json({ token: PREVIEW_TOKEN, user: PREVIEW_USER })
  ),
  http.get('*/auth/me', () => HttpResponse.json(PREVIEW_USER)),
  http.get('*/me', () => HttpResponse.json(PREVIEW_USER)),
  http.get('*/api/me', () => HttpResponse.json(PREVIEW_USER)),
  http.get('*/user', () => HttpResponse.json(PREVIEW_USER)),
  http.get('*/api/user', () => HttpResponse.json(PREVIEW_USER)),
  http.get('*/profile', () => HttpResponse.json(PREVIEW_USER)),
  http.get('*/api/profile', () => HttpResponse.json(PREVIEW_USER)),

  // ─── Catch-all final ────────────────────────────────────
  // Qualquer GET /api/* ou /api/v1/* desconhecido devolve lista/objeto vazio
  // pra app nao crashar na ausencia de backend. Adicione handlers especificos
  // ACIMA deste catch-all conforme features novas precisarem de mock.
  http.get('*/api/*', ({ request }) => {
    const url = new URL(request.url);
    // Heuristica: se a path termina com /list ou /items ou tem query de pagination,
    // devolve array; senao, objeto vazio.
    const looksLikeList = /\\/(list|items|all)$/i.test(url.pathname) || url.searchParams.has('page');
    return HttpResponse.json(looksLikeList ? [] : {});
  }),
  http.post('*/api/*', () => HttpResponse.json({ ok: true })),
  http.put('*/api/*', () => HttpResponse.json({ ok: true })),
  http.patch('*/api/*', () => HttpResponse.json({ ok: true })),
  http.delete('*/api/*', () => HttpResponse.json({ ok: true }))
];
`;

// IMPORTANTE: usar "/" (truthy) e nao "" (falsy). Apps geralmente fazem
// `import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000'` — string vazia
// cai no fallback. Com "/" todas as chamadas viram same-origin e MSW intercepta.
const ENV_PREVIEW = `# ${SCAFFOLD_TAG}
# Mode preview — same-origin, MSW intercepta tudo.
VITE_API_BASE_URL=/
`;

/**
 * Script injetado no <head> do index.html — roda ANTES do bundle do app evaluating.
 *
 * Por que isso? Apps usam chaves customizadas no localStorage (ex: `auraia_token`,
 * `myapp_session`, etc) que o seed em browser.ts nao conhece. Esse bloco:
 *   1. Pre-popula chaves comuns (token, accessToken, auth, user, ...).
 *   2. Monkey-patcha localStorage.getItem: se a chave bater /token|auth|user|session/i
 *      e nao tiver valor, devolve um token fake. Cobre QUALQUER chave custom
 *      sem precisar configurar por projeto.
 *
 * Marcador @mathai-preview-bypass usado pra detectar e nao re-injetar.
 */
const INDEX_BYPASS_SCRIPT = `<script data-mathai-preview-bypass="v${SCAFFOLD_VERSION}">
// @mathai-preview-bypass-v${SCAFFOLD_VERSION} — bypass de login em mode preview.
// Roda sincronamente antes de qualquer modulo ESM ser avaliado.
(function(){
  try {
    var FAKE_TOKEN = 'preview-fake-token';
    var FAKE_USER_OBJ = {
      id: 'preview-user',
      name: 'Preview User',
      email: 'preview@mathai.dev',
      role: 'ADMIN',
      permissions: ['*']
    };
    var FAKE_USER = JSON.stringify(FAKE_USER_OBJ);
    var FAKE_AUTH = JSON.stringify({ token: FAKE_TOKEN, user: FAKE_USER_OBJ, authenticated: true });

    // Seed: nomes comuns + heuristica de naming custom (prefix do hostname).
    // Ex: hostname auraia.dev -> tenta 'auraia_token' tambem.
    var hostKey = (location.hostname.split('.')[0] || 'app').toLowerCase().replace(/[^a-z0-9]/g, '');
    var seeds = {
      token: FAKE_TOKEN, accessToken: FAKE_TOKEN, auth_token: FAKE_TOKEN, authToken: FAKE_TOKEN,
      jwt: FAKE_TOKEN, jwtToken: FAKE_TOKEN, bearerToken: FAKE_TOKEN, idToken: FAKE_TOKEN,
      apiToken: FAKE_TOKEN, session: FAKE_TOKEN, sessionToken: FAKE_TOKEN,
      user: FAKE_USER, currentUser: FAKE_USER, userInfo: FAKE_USER, profile: FAKE_USER,
      auth: FAKE_AUTH, authState: FAKE_AUTH,
      isAuthenticated: 'true', isLoggedIn: 'true', loggedIn: 'true'
    };
    // Chaves heuristicas com prefix do host (auraia_token, myapp_session, etc).
    seeds[hostKey + '_token'] = FAKE_TOKEN;
    seeds[hostKey + '_auth'] = FAKE_AUTH;
    seeds[hostKey + '_user'] = FAKE_USER;
    seeds[hostKey + '_session'] = FAKE_TOKEN;
    for (var k in seeds) {
      try { if (localStorage.getItem(k) === null) localStorage.setItem(k, seeds[k]); } catch (e) {}
    }

    // Monkey-patch getItem: cobre QUALQUER chave custom que match /token|auth|user|session|login/i.
    var origGet = localStorage.getItem.bind(localStorage);
    Storage.prototype.getItem = function(key) {
      var v = origGet(key);
      if (v !== null) return v;
      if (typeof key !== 'string') return null;
      if (/user|profile/i.test(key)) return FAKE_USER;
      if (/auth$|^auth|authstate/i.test(key)) return FAKE_AUTH;
      if (/token|session|jwt|bearer|login/i.test(key)) return FAKE_TOKEN;
      if (/isauthenticated|isloggedin|loggedin/i.test(key)) return 'true';
      return null;
    };

    // Mesmo trick em sessionStorage por seguranca.
    var origSessionGet = sessionStorage.getItem.bind(sessionStorage);
    var realSessionGet = Storage.prototype.getItem;
    // (Storage.prototype.getItem ja foi sobrescrito acima — aplica pra sessionStorage tambem)
  } catch (e) { /* ignora qualquer erro pra nao quebrar o app */ }
})();
</script>
`;

const BOOTSTRAP_MARKER = "import.meta.env.MODE === 'preview'";

/** Candidatos de subdir do frontend, em ordem de preferencia. */
const FRONTEND_DIR_CANDIDATES = ["frontend", "apps/web", "apps/frontend", "web", "."];

/** Candidatos de arquivo de entrada, em ordem de preferencia. */
const ENTRY_FILE_CANDIDATES = [
  "src/main.ts",
  "src/main.tsx",
  "src/index.tsx",
  "src/index.ts"
];

/** Candidatos de index.html (Vite costuma ter na raiz do frontend; CRA em public/). */
const INDEX_HTML_CANDIDATES = ["index.html", "public/index.html"];

const INDEX_BYPASS_TAG = `@mathai-preview-bypass-v${SCAFFOLD_VERSION}`;
const INDEX_BYPASS_LEGACY_RE = /<script[^>]*data-mathai-preview-bypass[^>]*>[\s\S]*?<\/script>\s*/i;

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** Acha o primeiro diretorio de frontend que tem package.json. */
const detectFrontendDir = async (worktreePath: string): Promise<string | null> => {
  for (const candidate of FRONTEND_DIR_CANDIDATES) {
    const pkgPath = join(worktreePath, candidate, "package.json");
    if (await fileExists(pkgPath)) return candidate;
  }
  return null;
};

/** Acha o primeiro arquivo de entrada que existe dentro de frontendDir. */
const detectEntryFile = async (
  worktreePath: string,
  frontendDir: string
): Promise<string | null> => {
  for (const candidate of ENTRY_FILE_CANDIDATES) {
    const fullPath = join(worktreePath, frontendDir, candidate);
    if (await fileExists(fullPath)) return candidate;
  }
  return null;
};

/** Detecta indent do JSON original (default 2 spaces). */
const detectJsonIndent = (raw: string): number | string => {
  const match = raw.match(/^[\s\S]*?\n( +|\t)/);
  const indent = match?.[1];
  if (!indent) return 2;
  if (indent.startsWith("\t")) return "\t";
  return indent.length;
};

type PackageJsonShape = {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [k: string]: unknown;
};

/** Adiciona msw devDep + build:preview script. Devolve `true` se mudou algo. */
const patchPackageJson = async (pkgPath: string): Promise<boolean> => {
  const raw = await readFile(pkgPath, "utf-8");
  const indent = detectJsonIndent(raw);
  const pkg = JSON.parse(raw) as PackageJsonShape;

  const before = JSON.stringify(pkg);

  // devDependencies
  pkg.devDependencies = pkg.devDependencies ?? {};
  if (pkg.devDependencies.msw !== MSW_VERSION) {
    pkg.devDependencies.msw = MSW_VERSION;
  }

  // build:preview script
  pkg.scripts = pkg.scripts ?? {};
  const existingBuild = pkg.scripts.build ?? "vite build";
  const desiredPreview = `${existingBuild} --mode preview`;
  if (pkg.scripts["build:preview"] !== desiredPreview) {
    pkg.scripts["build:preview"] = desiredPreview;
  }

  const after = JSON.stringify(pkg);
  if (before === after) return false;

  const serialized = JSON.stringify(pkg, null, indent) + (raw.endsWith("\n") ? "\n" : "");
  await writeFile(pkgPath, serialized, "utf-8");
  return true;
};

/**
 * Devolve `true` se o conteudo do arquivo precisa ser regravado.
 * Criterio: arquivo nao existe OU nao contem a tag de versao atual do scaffold.
 */
const needsRewrite = async (path: string): Promise<boolean> => {
  if (!(await fileExists(path))) return true;
  try {
    const current = await readFile(path, "utf-8");
    return !current.includes(SCAFFOLD_TAG);
  } catch {
    return true;
  }
};

/**
 * Cria/atualiza os arquivos de mock + .env.preview.
 * Idempotente: so escreve quando o arquivo nao tem a tag de versao atual.
 */
const writeMockFiles = async (
  worktreePath: string,
  frontendDir: string
): Promise<string[]> => {
  const dir = join(worktreePath, frontendDir, "src/mocks/preview");
  await mkdir(dir, { recursive: true });

  const browserPath = join(dir, "browser.ts");
  const handlersPath = join(dir, "handlers.ts");
  const envPath = join(worktreePath, frontendDir, ".env.preview");
  const written: string[] = [];

  if (await needsRewrite(browserPath)) {
    await writeFile(browserPath, BROWSER_TS, "utf-8");
    written.push(relative(worktreePath, browserPath).replace(/\\/g, "/"));
  }
  if (await needsRewrite(handlersPath)) {
    await writeFile(handlersPath, HANDLERS_TS, "utf-8");
    written.push(relative(worktreePath, handlersPath).replace(/\\/g, "/"));
  }
  // .env.preview — regrava se a versao do scaffold mudou (corrige config bugada anterior).
  if (await needsRewrite(envPath)) {
    await writeFile(envPath, ENV_PREVIEW, "utf-8");
    written.push(relative(worktreePath, envPath).replace(/\\/g, "/"));
  }
  // public/mockServiceWorker.js — sem isso o service worker nao registra
  // e o MSW worker nao intercepta NADA (requests vao direto pra rede).
  const publicDir = join(worktreePath, frontendDir, "public");
  await mkdir(publicDir, { recursive: true });
  const swPath = join(publicDir, "mockServiceWorker.js");
  if (!(await fileExists(swPath))) {
    await writeFile(swPath, MOCK_SERVICE_WORKER_JS, "utf-8");
    written.push(relative(worktreePath, swPath).replace(/\\/g, "/"));
  }
  return written;
};

/**
 * Injeta o bloco de bootstrap no arquivo de entrada.
 * Devolve `true` se modificou (false se o bloco ja estava la).
 */
const patchEntryFile = async (
  worktreePath: string,
  frontendDir: string,
  entryRel: string
): Promise<boolean> => {
  const entryPath = join(worktreePath, frontendDir, entryRel);
  const raw = await readFile(entryPath, "utf-8");

  if (raw.includes(BOOTSTRAP_MARKER)) return false; // ja patched

  // Caminho relativo do entry pro src/mocks/preview/browser
  const entryDirAbs = dirname(entryPath);
  const browserAbs = join(worktreePath, frontendDir, "src/mocks/preview/browser");
  let rel = relative(entryDirAbs, browserAbs).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;

  // IIFE async — evita top-level await (Vite target chrome87/es2020 nao suporta).
  // Fire-and-forget OK porque o auth-bypass ja eh feito pelo script no index.html
  // (que pre-popula localStorage antes do bundle rodar).
  const bootstrapBlock = `if (import.meta.env.MODE === 'preview') {
  (async () => {
    const { worker } = await import('${rel}');
    await worker.start({ onUnhandledRequest: 'bypass' });
  })();
}
`;

  // Tenta injetar antes da primeira chamada que monta a app.
  // Padroes: .mount(  | createRoot(  | createApp(  | render(  | ReactDOM.render(
  const mountRegex = /^([ \t]*)([^\n]*?(?:\.mount\(|createRoot\(|createApp\(|ReactDOM\.render\(|^\s*render\())/m;
  const match = raw.match(mountRegex);

  let patched: string;
  if (match) {
    const indent = match[1] ?? "";
    const indented = bootstrapBlock
      .split("\n")
      .map((line, i) => (i === 0 ? indent + line : line ? indent + line : line))
      .join("\n");
    const startIdx = match.index ?? raw.length;
    patched = `${raw.slice(0, startIdx)}${indented}\n${raw.slice(startIdx)}`;
  } else {
    // Fallback: anexa no fim, dentro de um IIFE async (caso top-level await nao seja suportado)
    patched = `${raw.replace(/\s*$/, "")}\n\n${bootstrapBlock}`;
  }

  await writeFile(entryPath, patched, "utf-8");
  return true;
};

/**
 * Detecta index.html dentro do frontendDir.
 * Vite tipicamente: <frontendDir>/index.html
 * CRA tipicamente: <frontendDir>/public/index.html
 */
const detectIndexHtml = async (
  worktreePath: string,
  frontendDir: string
): Promise<string | null> => {
  for (const candidate of INDEX_HTML_CANDIDATES) {
    const fullPath = join(worktreePath, frontendDir, candidate);
    if (await fileExists(fullPath)) return candidate;
  }
  return null;
};

/**
 * Injeta o script de bypass no <head> do index.html.
 * - Se ja tem a tag de versao atual: no-op.
 * - Se tem versao antiga (bumpada): remove o bloco velho e injeta o novo.
 * - Se nao tem nada: injeta logo apos <head> (ou no topo se nao achar).
 *
 * O script roda ANTES de qualquer modulo ESM avaliar — chave pra batter o race
 * com Pinia/router que leem localStorage no boot.
 *
 * Retorna `true` se modificou.
 */
const patchIndexHtml = async (
  worktreePath: string,
  frontendDir: string,
  indexRel: string
): Promise<boolean> => {
  const indexPath = join(worktreePath, frontendDir, indexRel);
  const raw = await readFile(indexPath, "utf-8");

  // Ja tem versao atual?
  if (raw.includes(INDEX_BYPASS_TAG)) return false;

  // Remove versao antiga (se houver) — qualquer <script data-mathai-preview-bypass...>
  let cleaned = raw.replace(INDEX_BYPASS_LEGACY_RE, "");

  // Injeta logo apos <head> (case-insensitive). Fallback: topo do arquivo.
  const headOpenMatch = cleaned.match(/<head[^>]*>/i);
  let patched: string;
  if (headOpenMatch) {
    const idx = (headOpenMatch.index ?? 0) + headOpenMatch[0].length;
    patched = `${cleaned.slice(0, idx)}\n  ${INDEX_BYPASS_SCRIPT.trim()}\n${cleaned.slice(idx)}`;
  } else {
    patched = `${INDEX_BYPASS_SCRIPT}${cleaned}`;
  }

  await writeFile(indexPath, patched, "utf-8");
  return true;
};

const PR_TITLE = "chore: setup MSW + build:preview pra preview deploys";

const buildPrBody = (
  modifications: string[],
  entryRel: string | null
): string => {
  const lines: string[] = [];
  lines.push("## 📝 Modificações");
  lines.push("");
  modifications.forEach(m => lines.push(`- ${m}`));
  lines.push("");
  lines.push("## ⚙️ Como funcionou");
  lines.push("");
  lines.push("- `package.json`: adicionado `msw` (^2.6.0) como devDependency e script `build:preview` (build atual + `--mode preview`).");
  lines.push("- `src/mocks/preview/browser.ts` + `handlers.ts`: scaffold do worker MSW (handlers de auth + catch-all `/api/*`).");
  if (entryRel) {
    lines.push(`- \`${entryRel}\`: bloco condicional inicializa o worker apenas quando \`import.meta.env.MODE === 'preview'\`.`);
  }
  lines.push("- `index.html`: script de bypass injetado no `<head>` — pre-popula localStorage com token fake e monkey-patcha `getItem` pra cobrir chaves custom (`auraia_token`, etc). Roda **antes** do bundle ESM, batendo o race com Pinia/router.");
  lines.push("");
  lines.push("Fluxo deterministico, sem LLM — evita escapes de worktree.");
  lines.push("");
  lines.push("By MathAI");
  return lines.join("\n");
};

export type SetupPreviewRepoResult = {
  owner: string;
  repo: string;
  status: "pr-opened" | "pr-updated" | "no-changes" | "no-frontend" | "error";
  prUrl?: string;
  prNumber?: number;
  message?: string;
  modifications: string[];
};

export type SetupPreviewResult = {
  results: SetupPreviewRepoResult[];
};

export type ScaffoldResult = { modifications: string[]; entryDisplay: string | null };

/**
 * Aplica o scaffold deterministico do preview (package.json + mocks + entry +
 * index.html) num worktree JA criado. Idempotente. NAO faz git/commit/PR — so
 * muta arquivos. Reusado por:
 *   - runSetupPreviewDirect (abre PR no repo alvo)
 *   - previewManager (worktree efemero de cada `!test`, pra MSW valer mesmo sem
 *     o PR de setup ter sido mergeado na branch da task)
 */
export const applyPreviewScaffold = async (
  worktreePath: string,
  frontendDir: string
): Promise<ScaffoldResult> => {
  const modifications: string[] = [];

  // 1. package.json — msw devDep + build:preview
  const pkgPath = join(worktreePath, frontendDir, "package.json");
  if (await patchPackageJson(pkgPath)) {
    modifications.push(`${frontendDir}/package.json — msw devDep + build:preview script`);
  }

  // 2. mocks (browser.ts + handlers.ts + .env.preview + mockServiceWorker.js)
  const createdMocks = await writeMockFiles(worktreePath, frontendDir);
  createdMocks.forEach(m => modifications.push(`${m} — scaffold MSW`));

  // 3. entry file — bootstrap condicional do worker
  const entryRel = await detectEntryFile(worktreePath, frontendDir);
  let entryDisplay: string | null = null;
  if (entryRel) {
    const patched = await patchEntryFile(worktreePath, frontendDir, entryRel);
    entryDisplay = `${frontendDir}/${entryRel}`;
    if (patched) modifications.push(`${entryDisplay} — bootstrap MSW worker em modo preview`);
  } else {
    modifications.push("(entrypoint nao encontrado — pulei bootstrap; adicione manualmente)");
  }

  // 4. index.html — script de bypass de login (roda antes do bundle ESM)
  const indexRel = await detectIndexHtml(worktreePath, frontendDir);
  if (indexRel) {
    const patchedIndex = await patchIndexHtml(worktreePath, frontendDir, indexRel);
    if (patchedIndex) {
      modifications.push(`${frontendDir}/${indexRel} — script de bypass de login (pre-bundle)`);
    }
  } else {
    modifications.push("(index.html nao encontrado — pulei script de bypass)");
  }

  return { modifications, entryDisplay };
};

/**
 * Roda o setup-preview em cada repo do projeto. Cada repo gera 1 PR.
 */
export const runSetupPreviewDirect = async (
  github: GithubRepoConfig[]
): Promise<SetupPreviewResult> => {
  const results: SetupPreviewRepoResult[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const branchName = `mathai/setup-preview-${stamp}`;
  const worktreeId = `setup-preview-${stamp}`;

  for (const repo of github) {
    const acc: SetupPreviewRepoResult = {
      owner: repo.owner,
      repo: repo.repo,
      status: "no-changes",
      modifications: []
    };
    let workspacePath: string | null = null;

    try {
      if (!repo.token) {
        acc.status = "error";
        acc.message = "token GitHub ausente — configure em Settings → Integracoes";
        results.push(acc);
        continue;
      }
      const repoToken: string = repo.token;
      const ws = await createWorktree(
        repo.owner,
        repo.repo,
        branchName,
        worktreeId,
        repoToken,
        repo.baseBranch
      );
      workspacePath = ws.worktreePath;

      const frontendDir = await detectFrontendDir(ws.worktreePath);
      if (!frontendDir) {
        acc.status = "no-frontend";
        acc.message = "Nenhum package.json encontrado em frontend/, apps/web/, apps/frontend/, web/ ou raiz.";
        results.push(acc);
        continue;
      }

      // 1-4. scaffold deterministico (package.json + mocks + entry + index.html)
      const scaffold = await applyPreviewScaffold(ws.worktreePath, frontendDir);
      acc.modifications.push(...scaffold.modifications);
      const entryDisplay = scaffold.entryDisplay;

      if (acc.modifications.filter(m => !m.startsWith("(")).length === 0) {
        acc.status = "no-changes";
        acc.message = "Tudo ja estava configurado.";
        results.push(acc);
        continue;
      }

      // 4. commit
      const git = simpleGit(ws.worktreePath);
      await git.add(".");
      const status = await git.status();
      if (status.files.length === 0) {
        acc.status = "no-changes";
        acc.message = "Diferencas zeradas apos add (provavel race com worktree previo).";
        results.push(acc);
        continue;
      }
      await git.commit("chore: setup MSW + build:preview");

      // 5. push
      await pushBranch(ws.worktreePath, repo.owner, repo.repo, branchName, repoToken);

      // 6. PR
      const hasCommits = await branchHasCommits(ws.worktreePath, ws.baseBranch, branchName);
      if (!hasCommits) {
        acc.status = "no-changes";
        acc.message = "Branch sem commits adiante da base apos push.";
        results.push(acc);
        continue;
      }

      const pr = await createOrGetPullRequest({
        token: repoToken,
        owner: repo.owner,
        repo: repo.repo,
        head: branchName,
        base: ws.baseBranch,
        title: PR_TITLE,
        body: buildPrBody(acc.modifications, entryDisplay)
      });
      acc.status = pr.created ? "pr-opened" : "pr-updated";
      acc.prUrl = pr.url;
      acc.prNumber = pr.number;
      results.push(acc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      acc.status = "error";
      acc.message = msg.slice(0, 500);
      results.push(acc);
    } finally {
      if (workspacePath) {
        await removeWorktree(repo.owner, repo.repo, worktreeId).catch(() => {});
      }
    }
  }

  return { results };
};
