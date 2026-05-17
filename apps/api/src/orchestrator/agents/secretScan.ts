/**
 * Secret scanner deterministico — plan #13.
 *
 * Roda apos o code agent e antes do reviewer LLM. Procura padroes comuns
 * de credenciais em (a) arquivos sensiveis por nome (.env, credentials.*,
 * id_rsa) e (b) regex em qualquer arquivo modificado.
 *
 * Cada hit vira ReviewComment `severity:"error"` — entra como blocking
 * no review-loop. O code agent recebe feedback "remova credencial do
 * arquivo X" no proximo round.
 *
 * 100% local (sem binary externo); regex-based. Cobre os patterns que
 * mais aparecem em vazamentos publicos. Nao substitui um gitleaks/trufflehog
 * completo — eh um gate de bom senso, nao defense-in-depth.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ReviewComment } from "./reviewer.js";

export type SecretScanResult = {
  comments: ReviewComment[];
  scannedFiles: number;
  durationMs: number;
};

// Regexes de padroes publicos comuns. Ordem importa (mais especifico primeiro).
// Cada regex casa o token inteiro pra que linha+coluna sejam reportaveis.
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // OpenAI: sk-proj-... (novo) ou sk-... (legacy)
  { name: "OpenAI API key", re: /sk-(proj-)?[A-Za-z0-9_-]{20,}/g },
  // Anthropic: sk-ant-...
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  // AWS Access Key ID
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/g },
  // GitHub Personal Access Token
  { name: "GitHub PAT", re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  // GitHub Fine-grained PAT
  { name: "GitHub fine-grained PAT", re: /github_pat_[A-Za-z0-9_]{60,}/g },
  // Stripe live keys
  { name: "Stripe live key", re: /sk_live_[A-Za-z0-9]{20,}/g },
  // Google API key
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/g },
  // Slack tokens
  { name: "Slack token", re: /xox[baprs]-[0-9A-Za-z-]{10,}/g },
  // Generic JWT (3 base64 segments) — high FP, so we cap line length
  { name: "JWT-like token", re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // PEM private key markers
  { name: "Private key (PEM)", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g }
];

// Arquivos sensiveis por nome — adicionar qualquer um destes nunca eh esperado
// em um commit normal e levanta flag mesmo sem token detectado.
const SENSITIVE_FILENAMES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "credentials.json",
  "service-account.json",
  "id_rsa",
  "id_dsa",
  "id_ed25519",
  ".pgpass",
  ".npmrc",
  ".pypirc",
  ".dockercfg"
];

// Caps pra evitar inflar review com 200 linhas de erro
const MAX_COMMENTS = 12;
// Skip arquivos > 1MB (binarios, lockfiles, etc)
const MAX_FILE_BYTES = 1_000_000;
// Skip globs comuns (build outputs, lockfiles, binarios)
const SKIP_PATTERNS = [
  /^node_modules\//,
  /^dist\//,
  /^build\//,
  /^\.next\//,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.min\.(js|css)$/,
  /\.(png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf|pdf|zip|gz|tar|svg)$/i
];

const isSensitiveFilename = (file: string): boolean => {
  const base = file.split(/[\\/]/).pop() ?? "";
  return SENSITIVE_FILENAMES.includes(base);
};

const shouldSkip = (file: string): boolean =>
  SKIP_PATTERNS.some(re => re.test(file));

const findLineNumber = (content: string, matchIndex: number): number => {
  return content.slice(0, matchIndex).split("\n").length;
};

/**
 * Escaneia uma lista de arquivos relativos ao worktree. Le cada um (cap
 * 1MB) e busca patterns. Retorna comments compativeis com o review-loop.
 */
export const runSecretScan = async (
  worktreePath: string,
  changedFiles: string[]
): Promise<SecretScanResult> => {
  const t0 = Date.now();
  const comments: ReviewComment[] = [];

  for (const file of changedFiles) {
    if (comments.length >= MAX_COMMENTS) break;
    if (shouldSkip(file)) continue;

    // (a) Arquivo sensivel por nome — flag mesmo sem token visivel
    if (isSensitiveFilename(file)) {
      comments.push({
        file,
        severity: "error",
        message: `[secret-scan] arquivo sensivel commitado (${file.split(/[\\/]/).pop()}). Remova do git e adicione ao .gitignore. Nunca commit credenciais.`
      });
      // Nao continue — ainda queremos escanear conteudo abaixo se ler ok
    }

    const fullPath = join(worktreePath, file);
    if (!existsSync(fullPath)) continue;

    let content: string;
    try {
      const buf = await readFile(fullPath);
      if (buf.length > MAX_FILE_BYTES) continue;
      content = buf.toString("utf-8");
    } catch {
      continue; // arquivo binario/erro de IO -> skip
    }

    // (b) Regex scan
    for (const pattern of SECRET_PATTERNS) {
      if (comments.length >= MAX_COMMENTS) break;
      pattern.re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.re.exec(content)) !== null) {
        if (comments.length >= MAX_COMMENTS) break;
        const line = findLineNumber(content, match.index);
        const masked = match[0].slice(0, 6) + "..." + match[0].slice(-4);
        comments.push({
          file,
          line,
          severity: "error",
          message: `[secret-scan] possivel credencial detectada (${pattern.name}): "${masked}". Remova o token e mova pra variavel de ambiente / secret manager.`
        });
      }
    }
  }

  return {
    comments,
    scannedFiles: changedFiles.length,
    durationMs: Date.now() - t0
  };
};
