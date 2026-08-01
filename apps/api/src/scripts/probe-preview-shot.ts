/**
 * Testa o captureUrl (Playwright + seed de localStorage) contra um tunnel vivo.
 *
 * Roda dentro do api container:
 *   docker exec mathai-api tsx /app/apps/api/src/scripts/probe-preview-shot.ts <tunnelUrl> <route>
 *
 * NAO faz parte do build de runtime — script standalone diagnostico.
 * Arquivo nao-importado em src/scripts NAO triggera tsx watch reload.
 */
import { captureUrl } from "../services/previewScreenshot.js";
import { writeFile } from "node:fs/promises";

const main = async (): Promise<void> => {
  const url = process.argv[2];
  const route = process.argv[3] ?? "/admin/dashboard";
  if (!url) {
    console.error("uso: probe-preview-shot.ts <tunnelUrl> [route]");
    process.exit(1);
  }
  console.log(`[probe-shot] capturando ${url} rota=${route}`);
  const result = await captureUrl({ url, route, fullPage: false });
  if (!result.ok) {
    console.log(`FAIL: ${result.reason}`);
    process.exit(2);
  }
  const out = "/tmp/probe-shot.png";
  await writeFile(out, result.buffer);
  console.log(
    `OK bytes=${result.bytes} durMs=${result.durationMs} finalUrl=${result.finalUrl} -> ${out}`
  );
};

void main();
