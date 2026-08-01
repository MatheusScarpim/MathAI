import { runOpenClaude } from "../orchestrator/integrations/openclaude.js";

const run = async (): Promise<void> => {
  const start = Date.now();
  try {
    const r = await runOpenClaude("Reply with exactly the single word: PONG", {
      workingDirectory: "/tmp",
      model: "",
      grpcUrl: "openclaude-codex:50051",
      autoApprove: true,
      timeoutMs: 40000,
      onEvent: () => {}
    });
    console.log(`OK codex | ${Date.now() - start}ms | in=${r.promptTokens} out=${r.completionTokens} | text="${r.fullText.slice(0, 60)}"`);
  } catch (e) {
    console.log(`FAIL codex | ${Date.now() - start}ms | ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
};

void run();
