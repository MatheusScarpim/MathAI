/**
 * Subtasks atomicas pra setup de MSW (preview deploys).
 *
 * Cada subtask tem prompt curto + conteudo literal dos arquivos — minimiza
 * exploracao do agent e respeita o timeout de 5min por subtask. Bypassa o
 * planner (passado via TaskExecuteOptions.presetSubtasks).
 */

import type { TaskExecuteOptions } from "../orchestrator/types.js";

type PresetSubtask = NonNullable<TaskExecuteOptions["presetSubtasks"]>[number];

/** Conteudos literais — ja sao validos sem ajuste. */
const BROWSER_TS = `import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

export const worker = setupWorker(...handlers);
`;

const HANDLERS_TS = `import { http, HttpResponse } from 'msw';

/**
 * Handlers MSW pro modo preview.
 * O code agent vai adicionar handlers aqui automaticamente quando
 * a task adicionar chamadas /api/* novas.
 */
export const handlers: Parameters<typeof import('msw').setupServer>[number][] = [];

// Exemplo (descomente pra testar):
// http.get('/api/example', () => HttpResponse.json({ ok: true })),
`;

/**
 * Retorna 3 subtasks atomicas que setup MSW + build:preview no projeto.
 * Cada uma e pequena o suficiente pra rodar bem dentro do timeout de 5min.
 */
export const getMswSetupSubtasks = (): PresetSubtask[] => [
  {
    id: "msw-deps",
    type: "github",
    description: [
      "Adicione MSW como devDependency e o script build:preview no package.json do frontend.",
      "",
      "CAMINHO DO ARQUIVO (tente nesta ORDEM, use o PRIMEIRO que existir):",
      "  1. frontend/package.json",
      "  2. apps/web/package.json",
      "  3. apps/frontend/package.json",
      "  4. web/package.json",
      "  5. package.json (raiz, só se nenhum dos acima existir)",
      "",
      "PROCESSO OBRIGATORIO:",
      "1. LEIA o package.json escolhido inteiro.",
      "2. ESCREVA-O DE VOLTA na mesma path com EXATAMENTE estas 2 mudancas (preservando todo o resto, incluindo formatacao, indentacao, ordem de chaves, trailing commas):",
      "   a) Em \"devDependencies\" adicione (ou atualize) a chave:",
      "      \"msw\": \"^2.6.0\"",
      "      Se \"devDependencies\" nao existir, crie a seção.",
      "   b) Em \"scripts\" adicione (ou atualize) a chave:",
      "      \"build:preview\": \"<scripts.build atual> --mode preview\"",
      "      Substitua <scripts.build atual> pelo valor LITERAL de scripts.build do arquivo.",
      "      Exemplos: se scripts.build = \"vite build\", build:preview = \"vite build --mode preview\".",
      "                 se scripts.build = \"tsc && vite build\", build:preview = \"tsc && vite build --mode preview\".",
      "      Se scripts.build NAO existir, use \"vite build --mode preview\".",
      "3. Commit com mensagem: 'chore: add msw devDep + build:preview script'.",
      "",
      "REGRAS CRITICAS DE CAMINHO — descumprir = SUBTASK REJEITADA:",
      "- Use APENAS caminhos RELATIVOS a raiz do projeto que vc esta editando. Exemplos VALIDOS:",
      "    frontend/package.json",
      "    apps/web/package.json",
      "    package.json",
      "- NUNCA use caminhos absolutos. Exemplos PROIBIDOS (vao ser rejeitados pelo sandbox):",
      "    /openclaude/package.json",
      "    /data/.../package.json",
      "    /app/.../package.json",
      "    C:/.../package.json",
      "- Se o seu caminho começa com '/' ou letra-de-drive, vc errou — re-emita usando caminho relativo.",
      "- Vc NAO esta no diretorio do agent. Vc esta operando no worktree do projeto-alvo. Nao toque em arquivos do proprio OpenClaude ou da infra.",
      "",
      "REGRAS CRITICAS DE OUTPUT — descumprir = FALHA:",
      "- Vc DEVE retornar pelo menos 1 entrada em changes (action 'modify' ou 'create') apontando para o package.json escolhido.",
      "- Se ao ler o arquivo as 2 chaves ja existirem com os valores corretos, AINDA ASSIM regrave o arquivo (changes nao pode ser vazio) — o pipeline depende desse sinal.",
      "- NAO toque em outros arquivos. NAO rode npm/yarn/pnpm install. NAO altere outras dependencias.",
      "- NAO use diff parcial; emita o conteudo INTEIRO do package.json final."
    ].join("\n"),
    priority: 1,
    dependsOn: []
  },
  {
    id: "msw-files",
    type: "github",
    description: [
      "Crie EXATAMENTE 2 arquivos novos no diretorio src/mocks/preview/ (caminho relativo a raiz do frontend).",
      "Se o frontend esta em um subdir do monorepo (ex: frontend/, apps/web/), use src/mocks/preview/ DENTRO daquele subdir.",
      "",
      "ARQUIVO 1: src/mocks/preview/browser.ts (conteudo LITERAL abaixo, sem alterar):",
      "```ts",
      BROWSER_TS,
      "```",
      "",
      "ARQUIVO 2: src/mocks/preview/handlers.ts (conteudo LITERAL abaixo, sem alterar):",
      "```ts",
      HANDLERS_TS,
      "```",
      "",
      "Commit com mensagem: 'chore: scaffold msw mock handlers'.",
      "",
      "NAO LEIA outros arquivos. Apenas crie os 2 arquivos acima."
    ].join("\n"),
    priority: 2,
    dependsOn: ["msw-deps"]
  },
  {
    id: "msw-bootstrap",
    type: "github",
    description: [
      "Inicialize o worker MSW condicionalmente no arquivo de entrada do frontend.",
      "",
      "DESCOBERTA DO ARQUIVO DE ENTRADA — FACA NESTA ORDEM:",
      "1. PRIMEIRO liste o diretorio do frontend para descobrir o que EXISTE de verdade. Tente em ordem:",
      "     ls frontend/src/",
      "     ls apps/web/src/",
      "     ls apps/frontend/src/",
      "     ls src/  (so se nenhum dos acima existir)",
      "   Use o PRIMEIRO diretorio que existe e tem um arquivo de entrada.",
      "2. Identifique o arquivo de entrada DENTRO desse diretorio. Procure por (nesta ordem):",
      "     main.ts  (Vue, Solid, Svelte com Vite)",
      "     main.tsx (React+Vite)",
      "     index.tsx (React+CRA)",
      "     index.ts",
      "   IMPORTANTE: so use o nome que APARECEU no listing. NUNCA chute extensoes — se o listing mostrou 'main.ts', vc DEVE usar 'main.ts', NUNCA tente 'main.tsx'.",
      "3. Confirme abrindo o arquivo e vendo uma chamada mount/render/createRoot. Se nao tiver, ele nao é o entrypoint — volte ao passo 2 e tente o proximo.",
      "",
      "O CAMINHO FINAL que vc usa em changes deve ser exatamente <diretorio escolhido>/<arquivo escolhido>, RELATIVO a raiz do worktree.",
      "Exemplos validos: frontend/src/main.ts | apps/web/src/main.tsx | src/main.ts",
      "",
      "PROCESSO OBRIGATORIO:",
      "1. LEIA o arquivo de entrada inteiro.",
      "2. ESCREVA-O DE VOLTA na mesma path com APENAS esta mudanca: injete o bloco abaixo IMEDIATAMENTE antes da PRIMEIRA chamada de mount/render/createRoot do arquivo.",
      "   Preserve todos os imports, comentarios, ordem de statements, e qualquer outra logica intocada.",
      "",
      "BLOCO LITERAL (cole exatamente como esta — nao reformate, nao adicione await/async externo):",
      "  if (import.meta.env.MODE === 'preview') {",
      "    const { worker } = await import('./mocks/preview/browser');",
      "    await worker.start({ onUnhandledRequest: 'bypass' });",
      "  }",
      "",
      "AJUSTES PERMITIDOS:",
      "- Se o arquivo NAO suporta top-level await (CommonJS ou compilador antigo), envolva APENAS o seu novo bloco + a chamada de mount existente em um IIFE async no final do arquivo. Nao mova imports.",
      "- Se o caminho relativo './mocks/preview/browser' nao resolve da localizacao do arquivo de entrada, ajuste para o caminho relativo correto ate src/mocks/preview/browser (mantendo a estrutura criada pelo subtask anterior).",
      "- Erros de ts/eslint sobre `import.meta.env` podem ser ignorados — Vite trata em build.",
      "",
      "3. Commit com mensagem: 'feat: bootstrap MSW worker in preview mode'.",
      "",
      "REGRAS CRITICAS DE CAMINHO — descumprir = SUBTASK REJEITADA:",
      "- Use APENAS caminhos RELATIVOS a raiz do projeto. Exemplos VALIDOS:",
      "    frontend/src/main.ts",
      "    apps/web/src/main.tsx",
      "    src/main.ts",
      "- NUNCA use caminhos absolutos. Exemplos PROIBIDOS (sandbox rejeita):",
      "    /openclaude/src/main.ts",
      "    /data/.../src/main.ts",
      "    /app/.../src/main.ts",
      "    C:/.../src/main.ts",
      "- Se o seu caminho começa com '/' ou letra-de-drive, vc errou — re-emita usando caminho relativo.",
      "- Vc NAO esta no diretorio do agent. Vc esta no worktree do projeto-alvo. Nao escreva em arquivos do OpenClaude ou da infra.",
      "",
      "REGRAS CRITICAS DE OUTPUT — descumprir = FALHA:",
      "- Vc DEVE retornar exatamente 1 entrada em changes (action 'modify') para o arquivo de entrada escolhido. changes vazio = falha.",
      "- Emita o conteudo INTEIRO do arquivo final (nao diff parcial).",
      "- NAO crie arquivos novos. NAO renomeie. NAO toque em outros arquivos. NAO mexa na logica de mount/render alem do bloco condicional acima."
    ].join("\n"),
    priority: 3,
    dependsOn: ["msw-files"]
  }
];
