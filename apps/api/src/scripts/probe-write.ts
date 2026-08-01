import { runOpenClaude } from "../orchestrator/integrations/openclaude.js";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";

const url = process.env.PROBE_URL || "openclaude-anthropic:50051";
const model = process.env.PROBE_MODEL || "claude-opus-4-8";
const dir = "/data/auraia-workspaces/scratch/probe-write";
const file = `${dir}/hello.txt`;

async function main() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  console.log(`[probe-write] url=${url} model=${model} dir=${dir}`);
  const events: string[] = [];
  const res = await runOpenClaude(
    `Use the Write tool to create a file at this EXACT absolute path: ${file} with exactly the content: WROTE_OK. Use the absolute path, do not use a relative path. Then stop.`,
    {
      workingDirectory: dir,
      model,
      grpcUrl: url,
      autoApprove: true,
      timeoutMs: 90000,
      onEvent: (e) => {
        if (e.type === "tool_start") events.push(`tool_start:${e.toolName}:${e.args.slice(0, 120)}`);
        if (e.type === "tool_result") events.push(`tool_result:${e.toolName}:isError=${e.isError}:${e.output.slice(0, 120)}`);
        if (e.type === "error") events.push(`error:${e.code}:${e.message}`);
      }
    }
  );
  console.log(`[probe-write] done in=${res.promptTokens} out=${res.completionTokens}`);
  console.log(`[probe-write] events:\n${events.join("\n")}`);
  const exists = existsSync(file);
  console.log(`[probe-write] FILE EXISTS ON DISK: ${exists}`);
  if (exists) console.log(`[probe-write] content=${JSON.stringify(readFileSync(file, "utf8"))}`);
}

main().catch((e) => { console.error("[probe-write] FAIL", e); process.exit(1); });
