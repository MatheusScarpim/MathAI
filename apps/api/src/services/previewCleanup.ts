/**
 * Loop de cleanup pra previews vencidos.
 *
 * Mongo TTL (`expireAfterSeconds: 0`) apaga o doc, mas nao mata os processos.
 * Esse loop roda 60s e mata os processos antes do TTL natural pegar.
 *
 * Tambem expoe `releaseOrphanedPreviews` pra rodar no boot — marca como
 * stopped qualquer preview que ficou "ready" do container anterior.
 */

import { killExpired } from "./previewManager.js";

const TICK_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

export const startPreviewCleanup = (): void => {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      await killExpired();
    } catch (err) {
      console.warn("[previewCleanup] tick failed:", err);
    }
  }, TICK_MS);
  timer.unref?.();
  console.info(`[previewCleanup] started (tick=${TICK_MS / 1000}s)`);
};

export const stopPreviewCleanup = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

export { releaseOrphanedPreviews } from "./previewManager.js";
