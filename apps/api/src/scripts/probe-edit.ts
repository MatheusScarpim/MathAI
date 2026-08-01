import { runOpenClaude } from "../orchestrator/integrations/openclaude.js";
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const url = process.env.PROBE_URL || "openclaude-anthropic:50051";
const model = process.env.PROBE_MODEL || "claude-opus-4-8";
const dir = "/data/auraia-workspaces/scratch/probe-edit";
const file = `${dir}/EXISTING.txt`;

async function main() {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Pre-create the file so Edit has something to modify.
  writeFileSync(file, "ORIGINAL_LINE_ONE\nORIGINAL_LINE_TWO\n", "utf8");
  console.log(`[probe-edit] url=${url} model=${model} file=${file}`);
  console.log(`[probe-edit] pre-content=${JSON.stringify(readFileSync(file, "utf8"))}`);

  const events: string[] = [];
  const res = await runOpenClaude(
    `There is an existing file at this EXACT absolute path: ${file}. ` +
    `First use the Read tool to read it (use the absolute path). ` +
    `Then use the Edit tool to replace the text ORIGINAL_LINE_ONE with EDITED_OK (use the same absolute path). ` +
    `Do not use relative paths. Then stop.`,
    {
      workingDirectory: dir,
      model,
      grpcUrl: url,
      autoApprove: true,
      timeoutMs: 90000,
      onEvent: (e) => {
        if (e.type === "tool_start") events.push(`tool_start:${e.toolName}:${e.args.slice(0, 200)}`);
        if (e.type === "tool_result") events.push(`tool_result:${e.toolName}:isError=${e.isError}:${e.output.slice(0, 200)}`);
        if (e.type === "error") events.push(`error:${e.code}:${e.message}`);
      }
    }
  );
  console.log(`[probe-edit] done in=${res.promptTokens} out=${res.completionTokens}`);
  console.log(`[probe-edit] events:\n${events.join("\n")}`);
  const exists = existsSync(file);
  console.log(`[probe-edit] FILE EXISTS ON DISK: ${exists}`);
  if (exists) {
    const content = readFileSync(file, "utf8");
    console.log(`[probe-edit] post-content=${JSON.stringify(content)}`);
    console.log(`[probe-edit] EDIT PERSISTED: ${content.includes("EDITED_OK")}`);
  }
}

main().catch((e) => { console.error("[probe-edit] FAIL", e); process.exit(1); });
