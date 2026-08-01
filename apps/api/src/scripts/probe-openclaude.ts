/**
 * Probe direto dos containers OpenClaude pra diagnosticar o empty-stream do anthropic.
 *
 * Roda dentro do api container via:
 *   docker exec mathai-api tsx /app/apps/api/src/scripts/probe-openclaude.ts
 *
 * NAO faz parte do build de runtime — script standalone diagnostico.
 * Adicionar arquivo nao-importado em src/scripts NAO triggera tsx watch reload.
 */
import { runOpenClaude } from "../orchestrator/integrations/openclaude.js";

type ProbeTarget = {
  label: string;
  grpcUrl: string;
  model: string;
};

const TARGETS: ProbeTarget[] = [
  { label: "anthropic / opus-4-8", grpcUrl: "openclaude-anthropic:50051", model: "claude-opus-4-8" },
  { label: "anthropic / sonnet-4-6", grpcUrl: "openclaude-anthropic:50051", model: "claude-sonnet-4-6" },
  { label: "anthropic / opus-4-7", grpcUrl: "openclaude-anthropic:50051", model: "claude-opus-4-7" },
  { label: "anthropic / opus-4-7[1m]", grpcUrl: "openclaude-anthropic:50051", model: "claude-opus-4-7[1m]" },
  { label: "anthropic / sonnet-4-5", grpcUrl: "openclaude-anthropic:50051", model: "claude-sonnet-4-5" },
  { label: "anthropic / (no model)", grpcUrl: "openclaude-anthropic:50051", model: "" },
  { label: "deepseek / deepseek-chat", grpcUrl: "openclaude-deepseek:50051", model: "deepseek-chat" },
  { label: "deepseek / deepseek-v4-flash", grpcUrl: "openclaude-deepseek:50051", model: "deepseek-v4-flash" },
  { label: "deepseek / (no model)", grpcUrl: "openclaude-deepseek:50051", model: "" }
];

const PROMPT = "Reply with exactly the single word: PONG";

const probe = async (t: ProbeTarget): Promise<void> => {
  const events: string[] = [];
  const start = Date.now();
  try {
    const result = await runOpenClaude(PROMPT, {
      workingDirectory: "/tmp",
      model: t.model,
      grpcUrl: t.grpcUrl,
      autoApprove: true,
      timeoutMs: 30_000,
      onEvent: ev => {
        if (ev.type === "text") events.push(`TEXT(${ev.text.length}c)`);
        else if (ev.type === "tool_start") events.push(`TOOL_START:${ev.toolName}`);
        else if (ev.type === "tool_result") events.push(`TOOL_RESULT:${ev.toolName}${ev.isError ? "(err)" : ""}`);
        else if (ev.type === "error") events.push(`ERROR:${ev.code}:${ev.message.slice(0, 80)}`);
        else if (ev.type === "done") events.push(`DONE(in=${ev.promptTokens},out=${ev.completionTokens})`);
        else events.push(ev.type);
      }
    });
    const dur = Date.now() - start;
    console.log(
      `OK   ${t.label.padEnd(32)} | ${dur}ms | in=${result.promptTokens} out=${result.completionTokens} | text="${result.fullText.slice(0, 60).replace(/\n/g, "\\n")}"` +
      `\n     events: ${events.join(" ")}`
    );
  } catch (err) {
    const dur = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `FAIL ${t.label.padEnd(32)} | ${dur}ms | ${msg.slice(0, 140)}` +
      `\n     events: ${events.join(" ")}`
    );
  }
};

const main = async (): Promise<void> => {
  console.log(`[probe] firing ${TARGETS.length} sequential probes (prompt="${PROMPT}")\n`);
  for (const t of TARGETS) await probe(t);
  console.log("\n[probe] done");
};

void main();
