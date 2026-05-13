/**
 * Metricas operacionais in-memory do bot WhatsApp.
 *
 * Reset no boot — proposito: saude do numero pareado AGORA, nao auditoria
 * historica. Pra historico, usar logs estruturados.
 *
 * Janela de 10min implementada como dois snapshots (current + windowStart).
 * Diff = atividade na janela. Sem array de timestamps, sem leak.
 */

const WINDOW_MS = 10 * 60 * 1000;

type Counters = {
  messagesSent: number;
  messagesReceived: number;
  reactionsSent: number;
  documentsSent: number;
  sendErrors: number;
  reconnects: number;
};

const zero = (): Counters => ({
  messagesSent: 0,
  messagesReceived: 0,
  reactionsSent: 0,
  documentsSent: 0,
  sendErrors: 0,
  reconnects: 0
});

const current: Counters = zero();
/** Snapshot do inicio da janela atual — diff = atividade na janela. */
let windowStart: Counters = zero();
let windowStartedAt = new Date();

const bootAt = new Date();
let lastErrorAt: Date | undefined;
let lastErrorMessage: string | undefined;
let lastReconnectAt: Date | undefined;

/** Roda toda 10min: marca o snapshot atual como novo windowStart. */
const rotateWindow = (): void => {
  windowStart = { ...current };
  windowStartedAt = new Date();
};

setInterval(rotateWindow, WINDOW_MS).unref?.();

// ── Incrementos ──────────────────────────────────────────────────

export const incSent = (): void => { current.messagesSent++; };
export const incReceived = (): void => { current.messagesReceived++; };
export const incReactionsSent = (): void => { current.reactionsSent++; };
export const incDocumentsSent = (): void => { current.documentsSent++; };

export const incSendError = (msg?: string): void => {
  current.sendErrors++;
  lastErrorAt = new Date();
  if (msg) lastErrorMessage = msg.slice(0, 300);
};

export const incReconnect = (): void => {
  current.reconnects++;
  lastReconnectAt = new Date();
};

// ── Snapshot publico ─────────────────────────────────────────────

export type MetricsSnapshot = Counters & {
  bootAt: Date;
  uptimeMs: number;
  lastErrorAt?: Date;
  lastErrorMessage?: string;
  lastReconnectAt?: Date;
  windowStartedAt: Date;
  inWindow: Counters;
};

export const snapshot = (): MetricsSnapshot => {
  const inWindow: Counters = {
    messagesSent: current.messagesSent - windowStart.messagesSent,
    messagesReceived: current.messagesReceived - windowStart.messagesReceived,
    reactionsSent: current.reactionsSent - windowStart.reactionsSent,
    documentsSent: current.documentsSent - windowStart.documentsSent,
    sendErrors: current.sendErrors - windowStart.sendErrors,
    reconnects: current.reconnects - windowStart.reconnects
  };
  return {
    ...current,
    bootAt,
    uptimeMs: Date.now() - bootAt.getTime(),
    lastErrorAt,
    lastErrorMessage,
    lastReconnectAt,
    windowStartedAt,
    inWindow
  };
};

// ── Saude derivada ───────────────────────────────────────────────

export type Health = "ok" | "degraded" | "warning";

/**
 * Regra:
 *  - paired mas desconectado agora    → "warning" (deveria estar online)
 *  - >=3 reconnects nos ultimos 10min → "degraded"
 *  - >=5 sendErrors nos ultimos 10min → "degraded"
 *  - senao                            → "ok"
 */
export const computeHealth = (
  connected: boolean,
  pairingStatus: "unpaired" | "paired" | "logged_out"
): Health => {
  if (pairingStatus === "paired" && !connected) return "warning";
  const snap = snapshot();
  if (snap.inWindow.reconnects >= 3) return "degraded";
  if (snap.inWindow.sendErrors >= 5) return "degraded";
  return "ok";
};
