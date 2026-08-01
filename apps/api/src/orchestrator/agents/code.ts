import { runOpenClaude, type OpenClaudeEvent } from "../integrations/openclaude.js";
import { getAgentsConfig } from "../../core/agentConfig.js";
import { config } from "../../core/config.js";
import type { Route } from "../routing/types.js";

// ============== TYPES ==============

export type CodeChange = {
  file: string;
  action: "create" | "edit" | "delete";
  content?: string;
};

export type CodeGenerationResult = {
  changes: CodeChange[];
  commitMessage: string;
  prUrl?: string;
  fullText: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export type CodeAgentOptions = {
  branchName: string;
  baseBranch?: string;
  taskDescription: string;
  /**
   * Se setado, o agent recebe instrucao extra pra gerar handlers MSW
   * em <previewMocksDir> quando adicionar/modificar chamadas /api/*.
   * Habilita preview deploy via build estatico mockado.
   */
  previewMocksDir?: string;
};

export type CodeAgentEvent = OpenClaudeEvent;

// ============== HELPERS ==============

const shouldLogPrompts = (): boolean => {
  const flag = process.env.LOG_PROMPTS?.toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
};

const buildPrompt = (
  description: string,
  opts: CodeAgentOptions,
  language: "pt" | "en" | "es",
  workspacePath: string
): string => {
  const wt = workspacePath;
  const instructions: Record<"pt" | "en" | "es", string> = {
    pt: `Voce esta em um workspace git na branch "${opts.branchName}". Sua tarefa e:

${description}

⚠️ DISCIPLINA DE DIRETORIO (CRITICO — LEIA COM ATENCAO):
- O diretorio do workspace (o repositorio git desta task) e EXATAMENTE:
    ${wt}
- O shell NAO comeca dentro do workspace (o cwd padrao e \`/openclaude\`, um diretorio DIFERENTE). Por isso caminhos relativos NAO funcionam e se perdem.
- USE SEMPRE CAMINHOS ABSOLUTOS com o prefixo do workspace acima para TODA operacao de arquivo (Read, Write, Edit, MultiEdit). Ex:
    ${wt}/frontend/src/main.ts
    ${wt}/package.json
- Para QUALQUER comando de shell/git, entre no workspace na MESMA linha (o cwd reseta entre comandos): \`cd ${wt} && <comando>\`. Ex: \`cd ${wt} && ls\`, \`cd ${wt} && git add -A && git commit -m "..."\`.
- Alternativa para git: use \`git -C ${wt} <subcomando>\`.
- NUNCA escreva FORA de ${wt} (nada em \`/openclaude/\`, \`/app/\`, \`/etc/\`, \`/root/\`, \`/home/\`, \`/usr/\`, \`/tmp/\`). Escrever fora do workspace faz o trabalho ser perdido e nao entra no PR.

EXECUTE NESTA ORDEM:

1. ANALISE: Explore a estrutura do projeto (ex: \`cd ${wt} && ls -R\` limitado) e entenda os padroes existentes
2. IMPLEMENTE: Faca as alteracoes necessarias nos arquivos usando caminhos absolutos sob ${wt}
3. REVISE: Revise seu proprio codigo verificando:
   - Bugs logicos ou erros de sintaxe
   - Vulnerabilidades de seguranca (XSS, injection, etc.)
   - Aderencia aos padroes do projeto
   - Imports faltando
   Se encontrar problemas, corrija antes de continuar
4. TESTE: Se o projeto tiver testes, rode-os (\`cd ${wt} && <cmd de teste>\`). Se falharem, corrija
5. COMMIT: Rode \`cd ${wt} && git add -A && git commit -m "<mensagem descritiva>"\`.

NAO EXECUTE \`git push\` NEM \`gh pr create\`. O orquestrador fara o push e abrira UM unico Pull Request consolidando todas as subtarefas desta task no final.

REGRAS:
- Siga os padroes e convencoes existentes no projeto
- Gere codigo limpo, seguro e funcional
- Nao introduza vulnerabilidades de seguranca
- Nao altere arquivos que nao precisam ser modificados
- Nao crie pasta vazia (git nao trackeia): inclua arquivos reais nas mudancas${opts.previewMocksDir ? `

## PREVIEW MOCKS (MSW)

Este projeto suporta preview com API mockada. Se voce adicionar ou modificar
chamadas \`fetch('/api/...')\` (ou wrappers tipo axios.get/api.get), gere
TAMBEM um handler MSW em \`${opts.previewMocksDir}/<recurso>.ts\` retornando
fixture coerente com o tipo TypeScript usado na UI. Cubra:
- caminho de sucesso (status 200, dados realistas, 3-5 itens se for lista)
- 1 caminho de erro relevante (404 ou 500) so como exemplo comentado

Use os tipos existentes do projeto; nao invente schemas novos. Se o tipo
nao estiver claro, leia o arquivo da pagina/componente pra inferir.

Se a chamada ja tem handler nesse diretorio, ajuste o handler existente
em vez de duplicar.` : ""}`,

    en: `You are in a git workspace on branch "${opts.branchName}". Your task is:

${description}

⚠️ DIRECTORY DISCIPLINE (CRITICAL — READ CAREFULLY):
- The workspace directory (the git repo for this task) is EXACTLY:
    ${wt}
- The shell does NOT start inside the workspace (the default cwd is \`/openclaude\`, a DIFFERENT directory). Relative paths therefore do NOT work and get lost.
- ALWAYS USE ABSOLUTE PATHS prefixed with the workspace above for EVERY file operation (Read, Write, Edit, MultiEdit). E.g.:
    ${wt}/frontend/src/main.ts
    ${wt}/package.json
- For ANY shell/git command, enter the workspace on the SAME line (cwd resets between commands): \`cd ${wt} && <command>\`. E.g. \`cd ${wt} && ls\`, \`cd ${wt} && git add -A && git commit -m "..."\`.
- Git alternative: use \`git -C ${wt} <subcommand>\`.
- NEVER write OUTSIDE ${wt} (nothing under \`/openclaude/\`, \`/app/\`, \`/etc/\`, \`/root/\`, \`/home/\`, \`/usr/\`, \`/tmp/\`). Writing outside the workspace loses the work and it never reaches the PR.

EXECUTE IN THIS ORDER:

1. ANALYZE: Explore the project structure (e.g. \`cd ${wt} && ls -R\` scoped) and understand existing patterns
2. IMPLEMENT: Make the necessary file changes using absolute paths under ${wt}
3. REVIEW: Review your own code checking for:
   - Logic bugs or syntax errors
   - Security vulnerabilities (XSS, injection, etc.)
   - Adherence to project patterns
   - Missing imports
   If you find issues, fix them before continuing
4. TEST: If the project has tests, run them (\`cd ${wt} && <test cmd>\`). If they fail, fix them
5. COMMIT: Run \`cd ${wt} && git add -A && git commit -m "<descriptive message>"\`.

DO NOT RUN \`git push\` OR \`gh pr create\`. The orchestrator will push and open ONE consolidated Pull Request for all subtasks of this task at the end.

RULES:
- Follow existing project patterns and conventions
- Generate clean, secure, and functional code
- Do not introduce security vulnerabilities
- Do not modify files that don't need changes
- Do not create empty folders (git does not track them): include real files in your changes`,

    es: `Estas en un workspace git en la branch "${opts.branchName}". Tu tarea es:

${description}

⚠️ DISCIPLINA DE DIRECTORIO (CRITICO — LEE CON ATENCION):
- El directorio del workspace (el repo git de esta task) es EXACTAMENTE:
    ${wt}
- El shell NO empieza dentro del workspace (el cwd por defecto es \`/openclaude\`, un directorio DIFERENTE). Por eso las rutas relativas NO funcionan y se pierden.
- USA SIEMPRE RUTAS ABSOLUTAS con el prefijo del workspace de arriba para TODA operacion de archivo (Read, Write, Edit, MultiEdit). Ej:
    ${wt}/frontend/src/main.ts
    ${wt}/package.json
- Para CUALQUIER comando de shell/git, entra al workspace en la MISMA linea (el cwd se resetea entre comandos): \`cd ${wt} && <comando>\`. Ej: \`cd ${wt} && ls\`, \`cd ${wt} && git add -A && git commit -m "..."\`.
- Alternativa para git: usa \`git -C ${wt} <subcomando>\`.
- NUNCA escribas FUERA de ${wt} (nada en \`/openclaude/\`, \`/app/\`, \`/etc/\`, \`/root/\`, \`/home/\`, \`/usr/\`, \`/tmp/\`). Escribir fuera del workspace pierde el trabajo y no llega al PR.

EJECUTA EN ESTE ORDEN:

1. ANALIZA: Explora la estructura del proyecto (ej: \`cd ${wt} && ls -R\` acotado) y entiende los patrones existentes
2. IMPLEMENTA: Haz los cambios necesarios en los archivos usando rutas absolutas bajo ${wt}
3. REVISA: Revisa tu propio codigo verificando:
   - Bugs logicos o errores de sintaxis
   - Vulnerabilidades de seguridad (XSS, injection, etc.)
   - Adherencia a los patrones del proyecto
   - Imports faltantes
   Si encuentras problemas, corrigelos antes de continuar
4. TESTEA: Si el proyecto tiene tests, ejecutalos (\`cd ${wt} && <cmd de test>\`). Si fallan, corrigelos
5. COMMIT: Ejecuta \`cd ${wt} && git add -A && git commit -m "<mensaje descriptivo>"\`.

NO EJECUTES \`git push\` NI \`gh pr create\`. El orquestador hara el push y abrira UN unico Pull Request consolidando todas las subtareas de esta task al final.

REGLAS:
- Sigue los patrones y convenciones existentes del proyecto
- Genera codigo limpio, seguro y funcional
- No introduzcas vulnerabilidades de seguridad
- No modifiques archivos que no necesitan cambios
- No crees carpetas vacias (git no las trackea): incluye archivos reales en tus cambios`
  };

  return instructions[language];
};

// ============== GENERATE CODE CHANGES (via OpenClaude) ==============

/**
 * Usa o OpenClaude para gerar e aplicar mudancas de codigo diretamente no workspace.
 * O OpenClaude navega o repo, le arquivos, edita, e faz commit autonomamente.
 */
export const generateCodeChanges = async (
  description: string,
  workspacePath: string,
  language: "pt" | "en" | "es" = "pt",
  onEvent?: (event: CodeAgentEvent) => void,
  codeOpts?: CodeAgentOptions,
  route?: Route,
  /** Bloco de project context (stack, convencoes) ja formatado. Opcional. */
  projectContextText?: string
): Promise<CodeGenerationResult> => {
  // Route (when provided by the pipeline) selects gRPC endpoint + model.
  // Falls back to agentsConfig.taskCode.model when no route is passed.
  const agentsCfg = await getAgentsConfig();
  const cfg = agentsCfg.taskCode;
  const model = route?.model || cfg?.model || config.openclaude.defaultModel || undefined;
  const grpcUrl = route?.grpcUrl;

  const opts = codeOpts ?? { branchName: "mathai/auto", taskDescription: description };
  const basePrompt = buildPrompt(description, opts, language, workspacePath);
  // Project context vai NO COMECO do prompt: o agent le antes de explorar o
  // repo, ja sabendo stack/convencoes. Reduz tempo de descoberta e evita
  // padroes inconsistentes com o resto da base.
  const prompt = projectContextText
    ? `${projectContextText}\n\n---\n\n${basePrompt}`
    : basePrompt;

  if (shouldLogPrompts()) {
    console.info(`[prompt-log] codeAgent | model=${model ?? "default"} | workspace=${workspacePath}`);
    console.info(`[prompt-log] codeAgent prompt:\n${prompt}`);
  }

  const toolCalls: { toolName: string; args: string; output: string; isError: boolean; hasResult: boolean }[] = [];

  const result = await runOpenClaude(prompt, {
    workingDirectory: workspacePath,
    model,
    grpcUrl,
    autoApprove: true,
    // Fluxo completo de codigo (implementar+review+testar+push) precisa de mais
    // que os 300s do commandTimeoutMs default — senao backend/refactors morrem.
    timeoutMs: config.openclaude.codeTimeoutMs,
    onEvent: (event) => {
      // Track tool calls to extract changes
      if (event.type === "tool_start") {
        // hasResult=false ate chegar o tool_result. CRITICO: se o stream truncar
        // (janela de rebuild do container, gRPC cortado, rate-limit no meio) o
        // tool_start chega mas o tool_result NAO — sem esse flag, a mudanca era
        // contada como sucesso (isError default=false) mesmo sem tocar o disco,
        // gerando "phantom changes": changes preenchido mas worktree limpo ->
        // sem commit -> sem PR. Ver code.ts changes-building abaixo.
        toolCalls.push({ toolName: event.toolName, args: event.args, output: "", isError: false, hasResult: false });
      }
      if (event.type === "tool_result") {
        const last = toolCalls.find(t => t.toolName === event.toolName && !t.hasResult);
        if (last) {
          last.output = event.output;
          last.isError = event.isError;
          last.hasResult = true;
        }
      }
      // Forward events to caller
      onEvent?.(event);
    }
  });

  if (shouldLogPrompts()) {
    console.info(`[tokens] codeAgent | input=${result.promptTokens} output=${result.completionTokens}`);
  }

  // Extract changes from tool calls. Aliases lowercase/camelcase variantes.
  // Cobertura ampliada: Write, Edit, MultiEdit, NotebookEdit, e Bash com
  // redirects / sed -i / mv / cp / tee escrevendo em paths absolutos.
  const changes: CodeChange[] = [];

  const writeNames = new Set(["Write", "write", "WriteFile", "writefile"]);
  const editNames = new Set(["Edit", "edit", "MultiEdit", "multiedit"]);
  const notebookNames = new Set(["NotebookEdit", "notebookedit"]);

  // Heuristica: detecta path absoluto escrito por Bash. So aciona
  // se for path absoluto (comeca com /); paths relativos a cwd estao OK.
  const ABS_PATH_RE = /(?<![\w./-])(\/[A-Za-z0-9._\-]+(?:\/[A-Za-z0-9._\-]+)+)/g;
  const BASH_WRITE_RE = /(?:^|[\s;|&])(?:cat\s*>|cat\s*>>|tee\s|sed\s+-i|mv\s|cp\s|echo\s+[^|]*?>|printf\s+[^|]*?>|rm\s|truncate\s|install\s+-[Dm])/;

  for (const tc of toolCalls) {
    if (tc.isError) continue;
    // Sem tool_result confirmado = mudanca nao executada no disco (stream
    // truncado). Nao conta como change — deixa o empty-changes guard do
    // pipeline disparar retry em outro provider em vez de "sucesso" fantasma.
    if (!tc.hasResult) continue;

    try {
      const args = JSON.parse(tc.args);

      if (writeNames.has(tc.toolName)) {
        changes.push({
          file: args.file_path ?? args.path ?? "",
          action: "create",
          content: args.content ?? ""
        });
        continue;
      }

      if (editNames.has(tc.toolName)) {
        // MultiEdit usa args.edits[]; pegamos o file_path (compartilhado).
        changes.push({
          file: args.file_path ?? args.path ?? "",
          action: "edit",
          content: args.new_string ?? args.edits?.[0]?.new_string ?? ""
        });
        continue;
      }

      if (notebookNames.has(tc.toolName)) {
        changes.push({
          file: args.notebook_path ?? args.file_path ?? args.path ?? "",
          action: "edit",
          content: args.new_source ?? ""
        });
        continue;
      }

      if (tc.toolName === "Bash" || tc.toolName === "bash") {
        const cmd: string = args.command ?? "";
        if (!BASH_WRITE_RE.test(cmd)) continue;
        // So emitir como "change" se o path absoluto cair FORA do workspace.
        // Bash legitimo dentro do worktree (git add /data/.../foo) e ignorado
        // pra nao poluir o PR body.
        const matches = cmd.match(ABS_PATH_RE);
        if (matches) {
          // Devices Unix legitimos pra descarte/streaming — `cmd > /dev/null`
          // e padrao pra silenciar saida, NAO uma tentativa de escrever fora
          // do worktree. Sem essa excecao, escape filter ataca falso positivo.
          const EPHEMERAL_DEVICES = new Set([
            "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/zero", "/dev/tty"
          ]);
          for (const file of matches) {
            if (file.startsWith(workspacePath)) continue;
            if (EPHEMERAL_DEVICES.has(file)) continue;
            changes.push({ file, action: "edit", content: "[bash-side write outside workspace]" });
          }
        }
      }
    } catch {
      // skip unparseable tool calls
    }
  }

  // Extract commit message from git commit tool call
  let commitMessage = "chore: automated code changes by OpenClaude";
  const commitCall = toolCalls.find(tc =>
    tc.toolName === "Bash" && tc.args.includes("git commit")
  );
  if (commitCall) {
    try {
      const args = JSON.parse(commitCall.args);
      const cmd = args.command ?? "";
      const match = cmd.match(/-m\s+["']([^"']+)["']/);
      if (match) commitMessage = match[1];
    } catch {
      // use default
    }
  }

  // PR URL is no longer extracted here — orchestrator opens ONE consolidated PR
  // per task per repo after all subtasks finish (see pipeline/index.ts).
  return {
    changes,
    commitMessage,
    fullText: result.fullText,
    usage: {
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
      total_tokens: result.promptTokens + result.completionTokens
    }
  };
};
