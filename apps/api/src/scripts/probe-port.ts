import { runOpenClaude } from "../orchestrator/integrations/openclaude.js";

const grpcUrl = process.env.PROBE_URL ?? "openclaude-anthropic:50055";
const model = process.env.PROBE_MODEL ?? "claude-opus-4-8";

const main = async (): Promise<void> => {
  const events: string[] = [];
  try {
    const r = await runOpenClaude("Reply with exactly the single word: PONG", {
      workingDirectory: "/tmp",
      model,
      grpcUrl,
      autoApprove: true,
      timeoutMs: 30_000,
      onEvent: ev => {
        if (ev.type === "text") events.push(`TEXT(${ev.text.length})`);
        else if (ev.type === "error") events.push(`ERROR:${ev.code}:${ev.message.slice(0, 80)}`);
        else if (ev.type === "done") events.push(`DONE(in=${ev.promptTokens},out=${ev.completionTokens})`);
        else events.push(ev.type);
      }
    });
    console.log(`RESULT ${grpcUrl} ${model} | in=${r.promptTokens} out=${r.completionTokens} | text="${String(r.fullText).slice(0, 50).replace(/\n/g, "\\n")}" | events: ${events.join(" ")}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`FAIL ${grpcUrl} ${model} | ${msg.slice(0, 160)} | events: ${events.join(" ")}`);
  }
};

void main();
