import { execFile, type ExecFileException } from "node:child_process";
import { config } from "../../core/config.js";

const ALLOWED_COMMANDS = new Set([
  "git", "gh", "npm", "npx", "node", "tsc", "find", "tree", "ls", "cat"
]);

export type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * Executa um comando shell com sandbox basico:
 * - Whitelist de comandos permitidos
 * - Timeout configuravel
 * - cwd obrigatorio (workspace isolado)
 */
export const execShell = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs?: number
): Promise<ShellResult> => {
  const bin = command.split("/").pop() ?? command;
  if (!ALLOWED_COMMANDS.has(bin)) {
    return Promise.reject(new Error(`Comando nao permitido: ${bin}`));
  }

  const timeout = timeoutMs ?? config.workspace.commandTimeoutMs;

  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as ExecFileException).killed) {
        return reject(new Error(`Comando excedeu timeout de ${timeout}ms: ${command} ${args.join(" ")}`));
      }
      resolve({
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        exitCode: error?.code !== undefined ? (typeof error.code === "number" ? error.code : 1) : 0
      });
    });
  });
};
