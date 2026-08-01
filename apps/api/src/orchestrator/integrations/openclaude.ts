import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { config } from "../../core/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Procura proto: em dev esta em src/, em build esta em dist/
let PROTO_PATH = join(__dirname, "..", "proto", "openclaude.proto");
if (!existsSync(PROTO_PATH)) {
  // Fallback para src quando o proto nao foi copiado para dist/
  PROTO_PATH = join("/app/apps/api/src/orchestrator/proto/openclaude.proto");
}

// ============== TYPES ==============

export type OpenClaudeEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; toolName: string; args: string; toolUseId: string }
  | { type: "tool_result"; toolName: string; output: string; isError: boolean; toolUseId: string }
  | { type: "action_required"; promptId: string; question: string; actionType: "confirm" | "info" }
  | { type: "done"; fullText: string; promptTokens: number; completionTokens: number }
  | { type: "error"; message: string; code: string };

export type OpenClaudeOptions = {
  workingDirectory: string;
  model?: string;
  sessionId?: string;
  onEvent?: (event: OpenClaudeEvent) => void;
  autoApprove?: boolean;
  timeoutMs?: number;
  /** Override the default gRPC endpoint (used by the router to pick provider-specific containers). */
  grpcUrl?: string;
};

// ============== GRPC CLIENT ==============

const loadProto = () => {
  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  });
  return grpc.loadPackageDefinition(packageDef);
};

const createClient = (address?: string) => {
  const proto = loadProto() as Record<string, unknown>;
  const openclaudeV1 = (proto.openclaude as Record<string, unknown>).v1 as Record<string, unknown>;
  const AgentService = openclaudeV1.AgentService as new (
    addr: string,
    credentials: grpc.ChannelCredentials
  ) => grpc.Client;

  const resolved = address ?? config.openclaude.grpcUrl;
  return new AgentService(resolved, grpc.credentials.createInsecure());
};

// ============== MAIN FUNCTION ==============

/**
 * Envia um prompt para o OpenClaude via gRPC e retorna o resultado.
 * O OpenClaude navega o workspace, edita arquivos, roda comandos autonomamente.
 */
export const runOpenClaude = (
  prompt: string,
  options: OpenClaudeOptions
): Promise<{ fullText: string; promptTokens: number; completionTokens: number }> => {
  return new Promise((resolve, reject) => {
    // Cria um novo cliente por chamada para evitar race condition no stream.
    // O grpcUrl override vem do router (multi-provider fleet).
    const client = createClient(options.grpcUrl);
    const stub = client as unknown as Record<string, (...args: unknown[]) => unknown>;
    const chatFn = stub["Chat"] as ((...args: unknown[]) => unknown) | undefined;
    if (!chatFn) return reject(new Error("OpenClaude gRPC: Chat method not found"));
    // Bind para preservar o this do metodo (checkMetadataAndOptions)
    const call = chatFn.call(client) as grpc.ClientDuplexStream<unknown, unknown>;

    const timeout = options.timeoutMs ?? config.workspace.commandTimeoutMs;
    let settled = false;
    const finish = (result: { fullText: string; promptTokens: number; completionTokens: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { call.end(); } catch { /* noop */ }
      resolve(result);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { call.cancel(); } catch { /* noop */ }
      reject(err);
    };
    const timer = setTimeout(() => {
      fail(new Error(`OpenClaude timeout (${timeout}ms)`));
    }, timeout);

    // Send the chat request
    call.write({
      request: {
        message: prompt,
        workingDirectory: options.workingDirectory,
        model: options.model ?? config.openclaude.defaultModel ?? undefined,
        sessionId: options.sessionId ?? `task-${Date.now()}`
      }
    });

    let finalResult: { fullText: string; promptTokens: number; completionTokens: number } | null = null;
    // Contadores pra detectar streams "vazios" — done chega mas o agente
    // nao emitiu nada de util (sem text, sem tool). Sintoma observado em
    // 2026-05-13 (task calculadora): 5.5s, 0 tokens, sem eventos -> done.
    let textEventCount = 0;
    let toolEventCount = 0;

    call.on("data", (msg: Record<string, unknown>) => {
      const event = msg.event as string;

      if (!event) return;

      // Parse server events
      if (msg.textChunk) {
        const chunk = msg.textChunk as { text: string };
        if (chunk.text && chunk.text.length > 0) textEventCount++;
        options.onEvent?.({ type: "text", text: chunk.text });
      }

      if (msg.toolStart) {
        const ts = msg.toolStart as { toolName: string; argumentsJson: string; toolUseId: string };
        toolEventCount++;
        options.onEvent?.({
          type: "tool_start",
          toolName: ts.toolName,
          args: ts.argumentsJson,
          toolUseId: ts.toolUseId
        });
      }

      if (msg.toolResult) {
        const tr = msg.toolResult as { toolName: string; output: string; isError: boolean; toolUseId: string };
        options.onEvent?.({
          type: "tool_result",
          toolName: tr.toolName,
          output: tr.output,
          isError: tr.isError,
          toolUseId: tr.toolUseId
        });
      }

      if (msg.actionRequired) {
        const ar = msg.actionRequired as { promptId: string; question: string; type: string };
        if (options.autoApprove) {
          // Auto-approve tool calls
          call.write({
            input: {
              reply: "yes",
              promptId: ar.promptId
            }
          });
        } else {
          options.onEvent?.({
            type: "action_required",
            promptId: ar.promptId,
            question: ar.question,
            actionType: ar.type === "CONFIRM_COMMAND" ? "confirm" : "info"
          });
        }
      }

      if (msg.done) {
        const d = msg.done as { fullText: string; promptTokens: number; completionTokens: number };
        finalResult = {
          fullText: d.fullText,
          promptTokens: d.promptTokens ?? 0,
          completionTokens: d.completionTokens ?? 0
        };
        options.onEvent?.({
          type: "done",
          ...finalResult
        });

        // Hard-assert: done sem nenhum text/tool event = stream vazio.
        // Sintoma classico: provider retornou 200 mas stream fechou cedo
        // (rate-limit silencioso, auth expirado, payload mal formado).
        // Tratamos como erro pra evitar que upstream consuma um resultado
        // fantasma e marque a subtask como completed.
        if (textEventCount === 0 && toolEventCount === 0) {
          options.onEvent?.({
            type: "error",
            message: "OpenClaude stream returned no text or tool events",
            code: "EMPTY_STREAM"
          });
          fail(new Error(
            `OpenClaude stream empty: done event with 0 text + 0 tool events ` +
            `(in=${finalResult.promptTokens} out=${finalResult.completionTokens}). ` +
            `Provavel falha silenciosa no provider (rate-limit, auth, ou stream truncado).`
          ));
          return;
        }

        // Resolve imediato: o servidor gRPC nao fecha o stream apos done
        // (so fecha em cancel/error), entao nao podemos esperar call.on('end').
        finish(finalResult);
      }

      if (msg.error) {
        const e = msg.error as { message: string; code: string };
        options.onEvent?.({ type: "error", message: e.message, code: e.code });
      }
    });

    call.on("end", () => {
      if (finalResult) {
        finish(finalResult);
      } else {
        fail(new Error("OpenClaude stream ended without result"));
      }
    });

    call.on("error", (err: Error) => {
      fail(new Error(`OpenClaude gRPC error: ${err.message}`));
    });

    // NOTE: call.end() é chamado dentro do handler msg.done,
    // após receber a resposta final do servidor. Não fechar
    // antes permite que mensagens de auto-approval cheguem ao servidor.
  });
};

/**
 * TCP-level reachability check against a gRPC endpoint. Used by
 * /api/settings/openclaude-providers/health to surface fleet status in UI.
 * Returns "ok" if the channel reaches READY within timeoutMs, else "down".
 */
export const pingOpenClaude = (address: string, timeoutMs = 1500): Promise<"ok" | "down"> =>
  new Promise(resolve => {
    let settled = false;
    const done = (v: "ok" | "down") => {
      if (settled) return;
      settled = true;
      try { channel.close(); } catch { /* noop */ }
      resolve(v);
    };
    const timer = setTimeout(() => done("down"), timeoutMs);
    const channel = new grpc.Channel(address, grpc.credentials.createInsecure(), {});
    const deadline = Date.now() + timeoutMs;
    channel.watchConnectivityState(channel.getConnectivityState(true), deadline, (err) => {
      clearTimeout(timer);
      if (err) return done("down");
      const state = channel.getConnectivityState(false);
      // READY = 2, CONNECTING = 1, IDLE = 0 → consider IDLE/READY/CONNECTING as reachable enough.
      if (state === grpc.connectivityState.READY || state === grpc.connectivityState.IDLE || state === grpc.connectivityState.CONNECTING) {
        done("ok");
      } else {
        done("down");
      }
    });
  });

/**
 * Deep gRPC health check: issues a minimal Chat request and verifies the
 * stream returns non-empty text. Unlike pingOpenClaude (TCP-level), this
 * detects the "port open but pipeline dead" case — the empty-stream
 * (in=0 out=0) failure where the container is listening but emits a done
 * event with zero text/tool events. More expensive (one tiny LLM round-trip),
 * so callers MUST cache the result (see router deepHealthCache, 60s TTL).
 */
export const deepPingOpenClaude = async (
  address: string,
  timeoutMs = 8000
): Promise<"ok" | "down"> => {
  try {
    const res = await runOpenClaude("Reply with exactly the single word: PONG", {
      grpcUrl: address,
      workingDirectory: "/tmp",
      timeoutMs
    });
    return res.fullText.trim().length > 0 ? "ok" : "down";
  } catch {
    return "down";
  }
};
