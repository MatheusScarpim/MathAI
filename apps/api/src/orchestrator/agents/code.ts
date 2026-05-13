import { runOpenClaude, type OpenClaudeEvent } from "../integrations/openclaude.js";
import { getAgentsConfig } from "../../core/agentConfig.js";
import { config } from "../../core/config.js";

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
  language: "pt" | "en" | "es"
): string => {
  const instructions: Record<"pt" | "en" | "es", string> = {
    pt: `Voce esta em um workspace git na branch "${opts.branchName}". Sua tarefa e:

${description}

⚠️ DISCIPLINA DE DIRETORIO (CRITICO):
- Antes de qualquer edicao, execute \`pwd\` e \`ls\` pra confirmar que voce esta no workspace certo.
- USE APENAS CAMINHOS RELATIVOS (ex: \`frontend/src/main.ts\`, \`./package.json\`).
- NUNCA use caminhos absolutos como \`/openclaude/\`, \`/app/\`, \`/data/\`, \`/etc/\`, \`/root/\`, \`/home/\`, \`/usr/\`, \`/tmp/\`.
- Se uma tool aceitar caminho absoluto, ainda assim escreva relativo ao workspace atual.
- NAO modifique nada fora do diretorio do workspace. Se uma operacao tentar escrever fora, RECUSE e refaca com caminho relativo.

EXECUTE NESTA ORDEM:

1. ANALISE: Explore a estrutura do projeto e entenda os padroes existentes
2. IMPLEMENTE: Faca as alteracoes necessarias nos arquivos
3. REVISE: Revise seu proprio codigo verificando:
   - Bugs logicos ou erros de sintaxe
   - Vulnerabilidades de seguranca (XSS, injection, etc.)
   - Aderencia aos padroes do projeto
   - Imports faltando
   Se encontrar problemas, corrija antes de continuar
4. TESTE: Se o projeto tiver testes, rode-os. Se falharem, corrija
5. COMMIT: Faca \`git add\` e \`git commit\` com mensagem descritiva.

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

⚠️ DIRECTORY DISCIPLINE (CRITICAL):
- Before any edit, run \`pwd\` and \`ls\` to confirm you are in the right workspace.
- USE ONLY RELATIVE PATHS (e.g., \`frontend/src/main.ts\`, \`./package.json\`).
- NEVER use absolute paths like \`/openclaude/\`, \`/app/\`, \`/data/\`, \`/etc/\`, \`/root/\`, \`/home/\`, \`/usr/\`, \`/tmp/\`.
- If a tool accepts an absolute path, still write it relative to the current workspace.
- DO NOT modify anything outside the workspace directory. If an operation tries to write outside, REFUSE and redo with a relative path.

EXECUTE IN THIS ORDER:

1. ANALYZE: Explore the project structure and understand existing patterns
2. IMPLEMENT: Make the necessary file changes
3. REVIEW: Review your own code checking for:
   - Logic bugs or syntax errors
   - Security vulnerabilities (XSS, injection, etc.)
   - Adherence to project patterns
   - Missing imports
   If you find issues, fix them before continuing
4. TEST: If the project has tests, run them. If they fail, fix them
5. COMMIT: Run \`git add\` and \`git commit\` with a descriptive message.

DO NOT RUN \`git push\` OR \`gh pr create\`. The orchestrator will push and open ONE consolidated Pull Request for all subtasks of this task at the end.

RULES:
- Follow existing project patterns and conventions
- Generate clean, secure, and functional code
- Do not introduce security vulnerabilities
- Do not modify files that don't need changes
- Do not create empty folders (git does not track them): include real files in your changes`,

    es: `Estas en un workspace git en la branch "${opts.branchName}". Tu tarea es:

${description}

⚠️ DISCIPLINA DE DIRECTORIO (CRITICO):
- Antes de cualquier edicion, ejecuta \`pwd\` y \`ls\` para confirmar que estas en el workspace correcto.
- USA SOLO RUTAS RELATIVAS (ej: \`frontend/src/main.ts\`, \`./package.json\`).
- NUNCA uses rutas absolutas como \`/openclaude/\`, \`/app/\`, \`/data/\`, \`/etc/\`, \`/root/\`, \`/home/\`, \`/usr/\`, \`/tmp/\`.
- Si una herramienta acepta ruta absoluta, igual escribela relativa al workspace actual.
- NO modifiques nada fuera del directorio del workspace. Si una operacion intenta escribir fuera, RECHAZA y rehazla con ruta relativa.

EJECUTA EN ESTE ORDEN:

1. ANALIZA: Explora la estructura del proyecto y entiende los patrones existentes
2. IMPLEMENTA: Haz los cambios necesarios en los archivos
3. REVISA: Revisa tu propio codigo verificando:
   - Bugs logicos o errores de sintaxis
   - Vulnerabilidades de seguridad (XSS, injection, etc.)
   - Adherencia a los patrones del proyecto
   - Imports faltantes
   Si encuentras problemas, corrigelos antes de continuar
4. TESTEA: Si el proyecto tiene tests, ejecutalos. Si fallan, corrigelos
5. COMMIT: Ejecuta \`git add\` y \`git commit\` con mensaje descriptivo.

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
  codeOpts?: CodeAgentOptions
): Promise<CodeGenerationResult> => {
  const agentsCfg = await getAgentsConfig();
  const cfg = agentsCfg.taskCode;
  const model = cfg?.model || config.openclaude.defaultModel || undefined;

  const opts = codeOpts ?? { branchName: "mathai/auto", taskDescription: description };
  const prompt = buildPrompt(description, opts, language);

  if (shouldLogPrompts()) {
    console.info(`[prompt-log] codeAgent | model=${model ?? "default"} | workspace=${workspacePath}`);
    console.info(`[prompt-log] codeAgent prompt:\n${prompt}`);
  }

  const toolCalls: { toolName: string; args: string; output: string; isError: boolean }[] = [];

  const result = await runOpenClaude(prompt, {
    workingDirectory: workspacePath,
    model,
    autoApprove: true,
    onEvent: (event) => {
      // Track tool calls to extract changes
      if (event.type === "tool_start") {
        toolCalls.push({ toolName: event.toolName, args: event.args, output: "", isError: false });
      }
      if (event.type === "tool_result") {
        const last = toolCalls.find(t => t.toolName === event.toolName && !t.output);
        if (last) {
          last.output = event.output;
          last.isError = event.isError;
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
          for (const file of matches) {
            if (file.startsWith(workspacePath)) continue;
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
