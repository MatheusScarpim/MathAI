import { generateCodeChanges } from "../orchestrator/agents/code.js";
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { simpleGit } from "simple-git";
import type { Route } from "../orchestrator/routing/types.js";

const grpcUrl = process.env.PROBE_URL || "openclaude-deepseek:50051";
const model = process.env.PROBE_MODEL || "deepseek-v4-flash";
const provider = process.env.PROBE_PROVIDER || "deepseek";
const wt = "/data/auraia-workspaces/scratch/probe-codeagent";
const readme = `${wt}/README.md`;

async function main() {
  const base = "/data/auraia-workspaces/repos/MatheusScarpim-ScarlatMercadinho";
  const baseGit = simpleGit(base);
  await baseGit.raw(["worktree", "remove", wt, "--force"]).catch(() => {});
  rmSync(wt, { recursive: true, force: true });
  await baseGit.raw(["branch", "-D", "probe-wt"]).catch(() => {});
  // Real git WORKTREE (.git is a pointer file) — exact pipeline condition.
  await baseGit.raw(["worktree", "add", "-b", "probe-wt", wt, "HEAD"]);

  const git = simpleGit(wt);
  await git.addConfig("user.name", "Probe Bot");
  await git.addConfig("user.email", "probe@noreply.local");

  console.log(`[probe-codeagent] grpc=${grpcUrl} model=${model} wt=${wt}`);
  console.log(`[probe-codeagent] pre README head: ${JSON.stringify(readFileSync(readme, "utf8").split("\n")[0])}`);

  const route: Route = {
    provider: provider as Route["provider"],
    model,
    grpcUrl,
    reason: "probe"
  } as Route;

  const events: string[] = [];
  const res = await generateCodeChanges(
    "Adicione um comentario HTML de uma unica linha no topo do arquivo README.md em portugues dizendo que este e o repositorio do sistema ScarlatMercadinho. Nao altere mais nada.",
    wt,
    "pt",
    (e) => {
      if (e.type === "tool_start") events.push(`tool_start:${e.toolName}:${e.args.slice(0, 160)}`);
      if (e.type === "tool_result") events.push(`tool_result:${e.toolName}:isError=${e.isError}:${e.output.slice(0, 160)}`);
      if (e.type === "error") events.push(`error:${e.code}:${e.message}`);
    },
    { branchName: "probe", baseBranch: "master", taskDescription: "probe" },
    route
  );

  console.log(`[probe-codeagent] changes=${JSON.stringify(res.changes)}`);
  console.log(`[probe-codeagent] events:\n${events.join("\n")}`);

  const content = existsSync(readme) ? readFileSync(readme, "utf8") : "<MISSING>";
  console.log(`[probe-codeagent] README on disk head: ${JSON.stringify(content.split("\n").slice(0, 2))}`);
  console.log(`[probe-codeagent] COMMENT PERSISTED ON DISK: ${content.includes("ScarlatMercadinho") && content.includes("<!--")}`);

  const status = await git.status();
  console.log(`[probe-codeagent] git isClean=${status.isClean()} modified=${JSON.stringify(status.modified)} not_added=${JSON.stringify(status.not_added)}`);
  const log = await git.log().catch(() => null);
  console.log(`[probe-codeagent] git last commit: ${log?.latest?.message ?? "<none>"}`);
}

main().catch((e) => { console.error("[probe-codeagent] FAIL", e); process.exit(1); });
