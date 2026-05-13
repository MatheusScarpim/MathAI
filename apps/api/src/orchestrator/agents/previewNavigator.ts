/**
 * Preview navigator agent — analisa a task + arquivos mudados e decide
 * QUAL ROTA do app abrir antes do screenshot + QUAIS interacoes executar
 * pra deixar a tela no estado que comprova a feature.
 *
 * Usado pelo comando `!test` do bot WhatsApp: antes de capturar a print,
 * o agente diz "essa task adicionou /calculadora, navega la e clica em X".
 *
 * Sem isso, o Playwright captura sempre a homepage — que pode nao mostrar
 * a feature implementada (foi o caso reportado pelo usuario).
 */

import { getOpenAI } from "../../core/openai.js";
import { withRetry } from "./withRetry.js";
import type { TaskRecord } from "../../core/mongo.js";

// ─── Types ──────────────────────────────────────────────────────────────

export type NavAction =
  | { type: "wait"; ms: number }
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "goto"; path: string };

export type NavPlan = {
  /** Path relativo (sempre comeca com "/"). */
  route: string;
  /** Justificativa curta — vai pra caption do WhatsApp. */
  reasoning: string;
  /** Acoes a executar apos navegar pra route. Max 5. */
  actions: NavAction[];
};

/**
 * Snapshot dos elementos interativos visiveis numa pagina,
 * extraido via Playwright `page.evaluate`. Serve de "ground truth"
 * pro LLM gerar selectors reais (sem alucinacao).
 */
export type PageInspection = {
  title: string;
  url: string;
  inputs: Array<{
    tag: string;            // 'input' | 'textarea' | 'select'
    name: string | null;
    id: string | null;
    type: string | null;    // 'text' | 'number' | 'email' | etc
    placeholder: string | null;
    ariaLabel: string | null;
    label: string | null;   // texto do <label for=> ou pai
  }>;
  buttons: Array<{
    tag: string;            // 'button' | 'a' | etc
    text: string | null;
    id: string | null;
    ariaLabel: string | null;
    dataTestid: string | null;
    type: string | null;    // 'submit' | 'button'
  }>;
};

// ─── Prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Voce e um agente de navegacao automatica pra previews de apps web.
Dado uma TASK descrita pelo usuario + lista de ARQUIVOS MODIFICADOS no PR, decida:
1. QUAL ROTA abrir (path relativo, ex: "/calculadora", "/settings", "/")
2. QUAIS ACOES executar antes do screenshot pra deixar a tela no estado FINAL que comprova a feature

CONVENCOES DE ROTEAMENTO (Vue Router, React Router, Next.js):
- "pages/Foo.vue" ou "pages/Foo.tsx" -> rota "/foo" (lowercase, sem extensao)
- "pages/index.vue" -> "/"
- "pages/User/Profile.vue" -> "/user/profile"
- "src/views/Calculadora.vue" -> "/calculadora"
- "components/X" NAO sao rotas — sao usados dentro de paginas
- "services/" / "stores/" / "utils/" / "composables/" nao tem rota
- Se a task menciona uma feature especifica (calculadora, login, dashboard, kanban, etc), prioriza a rota com nome correspondente

REGRAS DE ACOES:
- Use selectors CSS simples e estaveis: [data-testid=...], button[type=submit], input[name=...], #id, .class
- Evite selectors fragies: ":nth-child", path-dependent
- Maximo 8 acoes (eh gravado em video — historia interessante > minimalismo)
- IDEAL: gere uma SEQUENCIA narrada de 3-6 acoes que conta a historia da feature:
  1. wait pra deixar tela montar (~400ms)
  2. fill em algum input se a feature usa
  3. wait curto (~300ms) pra UI reagir
  4. click no botao de acao
  5. wait pra resultado aparecer (~500-800ms)
  6. (opcional) click em outro elemento secundario
- Use "wait" entre acoes UI pra video ficar legivel (humanos veem cada passo)
- Use "fill" pra preencher inputs antes de clicar em submit
- Se nao for obvio que tem interacao, retorna actions: [] (so navegacao)
- Acoes erradas SAO TOLERADAS (best-effort) — prefira tentar a deixar tela vazia
- TASK MENCIONA CALCULADORA? Tente preencher dois inputs + click em + ou =
- TASK MENCIONA LOGIN/CADASTRO? Preencha email/senha mock + click submit
- TASK MENCIONA LISTA/CRUD? Click em "+ Novo" ou primeiro item da lista

DECISAO DE ROTA:
- Se a task adiciona/modifica pagina Foo: route = "/foo"
- Se mexe em multiplas paginas: escolhe a mais relacionada ao texto da task
- Se mexe so em backend/services/components: route = "/" (homepage)
- Se a task fala explicitamente "rota /xxx", usa "/xxx"

SAIDA JSON ESTRITA (sem markdown, sem comentarios):
{
  "route": "/<path>",
  "reasoning": "<1 frase curta dizendo por que essa rota>",
  "actions": [
    { "type": "wait", "ms": 500 },
    { "type": "click", "selector": "..." },
    { "type": "fill", "selector": "...", "value": "..." }
  ]
}`;

// ─── Public API ─────────────────────────────────────────────────────────

export const planNavigation = async (
  task: TaskRecord,
  changedFiles: string[]
): Promise<NavPlan> => {
  // Filtra arquivos frontend (descarta backend pra reduzir ruido).
  const frontendFiles = changedFiles.filter(f =>
    !f.startsWith("apps/api/") &&
    !f.startsWith("backend/") &&
    !f.startsWith("packages/api/") &&
    !f.startsWith("server/")
  );

  const userPrompt =
    `TASK: ${task.description}\n\n` +
    `ARQUIVOS MODIFICADOS (frontend):\n` +
    (frontendFiles.length > 0
      ? frontendFiles.slice(0, 30).map(f => `- ${f}`).join("\n")
      : "(nenhum arquivo frontend — task pode ser backend-only)") +
    `\n\nRetorne o JSON de navegacao.`;

  return withRetry<NavPlan>(
    async () => {
      const client = await getOpenAI();
      const completion = await client.chat.completions.create({
        model: "deepseek-chat",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ]
      });

      const raw = completion.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(raw) as Partial<NavPlan> & { actions?: unknown };

      const route = sanitizeRoute(parsed.route);
      const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 200) : "";
      const actions = Array.isArray(parsed.actions) ? validateActions(parsed.actions).slice(0, 8) : [];

      return { route, reasoning, actions };
    },
    {
      label: "previewNavigator",
      attempts: 2,
      baseDelayMs: 500,
      fallback: () => ({ route: "/", reasoning: "fallback — navigator falhou", actions: [] })
    }
  );
};

// ─── Validation helpers ─────────────────────────────────────────────────

const sanitizeRoute = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  // Garante prefixo "/" e remove trailing slash duplicado.
  let r = raw.startsWith("/") ? raw : `/${raw}`;
  // Tira query string ou hash (perigoso e nao precisamos)
  r = r.split("?")[0]!.split("#")[0]!;
  // Limita comprimento absurdo
  if (r.length > 200) r = r.slice(0, 200);
  return r;
};

// ─── DOM-grounded action planner ────────────────────────────────────────

const ACTIONS_SYSTEM_PROMPT = `Voce e um agente de UI automation. Recebe a TASK do usuario + o DOM REAL da pagina (lista de inputs e botoes que EXISTEM agora) e gera a sequencia de acoes pra demonstrar a feature.

REGRA DE OURO: use APENAS selectors que correspondem aos elementos LISTADOS abaixo. NUNCA invente name=, id=, data-testid= que nao esta na lista. Se o elemento ideal nao existe, use o mais proximo OU retorne acoes vazias.

PRIORIDADE DE SELECTORS (mais robusto -> menos):
1. text=<texto exato do botao>          (ex: text=Somar)
2. [data-testid="<valor real>"]         (so se aparecer na lista)
3. #<id-real>                           (so se aparecer na lista)
4. input[name="<nome-real>"]            (so se aparecer na lista)
5. input[placeholder="<placeholder-real>"]  (so se aparecer na lista)
6. button[type="submit"]                (se houver um botao submit visivel)

VALORES SUGERIDOS PARA FILL:
- input type=number ou name contendo "num"/"valor" -> use numeros tipo "7" e "5"
- input type=email -> "user@preview.dev"
- input type=password -> "preview123"
- input type=text com label "nome"/"name" -> "Preview User"
- textarea -> "Texto de teste preview"

REGRAS DE SEQUENCIA:
- 3-8 acoes totais
- wait 300-800ms entre fill e click (UI reagir)
- Acabe com um click no botao principal (submit / acao da feature)
- Wait 500-800ms ao final pra resultado aparecer
- Se nao tem input nem botao relevante, retorne actions: [] (so screenshot)

SAIDA JSON ESTRITA:
{
  "reasoning": "<1 frase>",
  "actions": [
    { "type": "wait", "ms": 400 },
    { "type": "fill", "selector": "input[name='valorReal']", "value": "7" },
    { "type": "click", "selector": "text=Somar" }
  ]
}`;

export type ActionsPlan = {
  reasoning: string;
  actions: NavAction[];
};

/**
 * Segunda passada do agente: ja temos a pagina aberta e sabemos quais
 * elementos existem. Gera acoes ANCORADAS no DOM real — sem alucinacao.
 */
export const planActions = async (
  task: TaskRecord,
  changedFiles: string[],
  inspection: PageInspection
): Promise<ActionsPlan> => {
  const frontendFiles = changedFiles.filter(f =>
    !f.startsWith("apps/api/") &&
    !f.startsWith("backend/") &&
    !f.startsWith("packages/api/") &&
    !f.startsWith("server/")
  );

  // Formata DOM compacto pro LLM. Limites pra evitar context bloat.
  const inputLines = inspection.inputs.slice(0, 20).map(i =>
    `  - <${i.tag}>` +
    (i.name ? ` name="${i.name}"` : "") +
    (i.type ? ` type="${i.type}"` : "") +
    (i.id ? ` id="${i.id}"` : "") +
    (i.placeholder ? ` placeholder="${i.placeholder}"` : "") +
    (i.label ? ` label="${i.label}"` : "") +
    (i.ariaLabel ? ` aria-label="${i.ariaLabel}"` : "")
  ).join("\n") || "  (nenhum input visivel)";

  const buttonLines = inspection.buttons.slice(0, 30).map(b =>
    `  - <${b.tag}>` +
    (b.text ? ` text="${b.text}"` : "") +
    (b.dataTestid ? ` data-testid="${b.dataTestid}"` : "") +
    (b.id ? ` id="${b.id}"` : "") +
    (b.type ? ` type="${b.type}"` : "") +
    (b.ariaLabel ? ` aria-label="${b.ariaLabel}"` : "")
  ).join("\n") || "  (nenhum botao visivel)";

  const userPrompt =
    `TASK: ${task.description}\n\n` +
    `ARQUIVOS MODIFICADOS:\n${frontendFiles.slice(0, 20).map(f => `  - ${f}`).join("\n") || "  (nenhum)"}\n\n` +
    `PAGINA ABERTA: ${inspection.title || "(sem titulo)"}\n` +
    `URL: ${inspection.url}\n\n` +
    `INPUTS VISIVEIS:\n${inputLines}\n\n` +
    `BOTOES VISIVEIS:\n${buttonLines}\n\n` +
    `Retorne o JSON de acoes usando APENAS estes elementos.`;

  return withRetry<ActionsPlan>(
    async () => {
      const client = await getOpenAI();
      const completion = await client.chat.completions.create({
        model: "deepseek-chat",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: ACTIONS_SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ]
      });
      const raw = completion.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(raw) as Partial<ActionsPlan> & { actions?: unknown };
      const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 200) : "";
      const actions = Array.isArray(parsed.actions) ? validateActions(parsed.actions).slice(0, 8) : [];
      return { reasoning, actions };
    },
    {
      label: "previewNavigator.planActions",
      attempts: 2,
      baseDelayMs: 500,
      fallback: () => ({ reasoning: "fallback — planActions falhou", actions: [] })
    }
  );
};

// ─── Validation helpers ─────────────────────────────────────────────────

const validateActions = (arr: unknown[]): NavAction[] => {
  const out: NavAction[] = [];
  for (const a of arr) {
    if (!a || typeof a !== "object") continue;
    const x = a as Record<string, unknown>;
    if (x.type === "wait" && typeof x.ms === "number" && x.ms > 0) {
      out.push({ type: "wait", ms: Math.min(x.ms, 10_000) });
    } else if (x.type === "click" && typeof x.selector === "string" && x.selector.length > 0) {
      out.push({ type: "click", selector: x.selector });
    } else if (
      x.type === "fill" &&
      typeof x.selector === "string" &&
      typeof x.value === "string" &&
      x.selector.length > 0
    ) {
      out.push({ type: "fill", selector: x.selector, value: x.value });
    } else if (x.type === "goto" && typeof x.path === "string") {
      out.push({ type: "goto", path: sanitizeRoute(x.path) });
    }
  }
  return out;
};
