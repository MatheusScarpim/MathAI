/**
 * Wrapper sobre Baileys (@whiskeysockets/baileys).
 * Mantem o socket atual, expoe API simples (sendText, editText, reactTo, logout, etc),
 * e aplica rate limiter antes de cada send.
 *
 * NAO contem logica de comando ou bind — isso fica no whatsappBot.ts.
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
  type WAMessage,
  type WAMessageKey,
  type AuthenticationState
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { whatsappLimiter } from "../../services/whatsappRateLimiter.js";
import {
  incSent,
  incReceived,
  incReactionsSent,
  incDocumentsSent,
  incSendError
} from "../../services/whatsappMetrics.js";

export type ConnectionStatus = "starting" | "connecting" | "open" | "close";
export type QrListener = (qr: string) => void;
export type StatusListener = (status: ConnectionStatus, info?: { reason?: number; loggedOut?: boolean }) => void;
export type IncomingListener = (msg: WAMessage) => void | Promise<void>;

let sock: WASocket | null = null;
let currentStatus: ConnectionStatus = "starting";

const qrListeners = new Set<QrListener>();
const statusListeners = new Set<StatusListener>();
const incomingListeners = new Set<IncomingListener>();

/** Subscribe ao QR string (string base64 que renderiza pra QR no frontend). */
export const onQr = (cb: QrListener): (() => void) => {
  qrListeners.add(cb);
  return () => qrListeners.delete(cb);
};

export const onStatusChange = (cb: StatusListener): (() => void) => {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
};

export const onIncoming = (cb: IncomingListener): (() => void) => {
  incomingListeners.add(cb);
  return () => incomingListeners.delete(cb);
};

export const getStatus = (): ConnectionStatus => currentStatus;
export const isConnected = (): boolean => currentStatus === "open" && sock !== null;
export const getSocket = (): WASocket | null => sock;

const emitStatus = (status: ConnectionStatus, info?: { reason?: number; loggedOut?: boolean }): void => {
  currentStatus = status;
  for (const cb of statusListeners) {
    try { cb(status, info); } catch (err) { console.warn("[whatsapp] status listener error:", err); }
  }
};

/**
 * Inicializa o socket Baileys com o auth state fornecido.
 * Listeners ja registrados (onQr, onStatusChange, onIncoming) recebem os eventos.
 */
export const startSocket = async (
  auth: AuthenticationState,
  onCredsUpdate: () => Promise<void>
): Promise<WASocket> => {
  if (sock) {
    console.warn("[whatsapp] startSocket called but socket already exists; closing previous");
    try { sock.end(undefined); } catch { /* ignore */ }
    sock = null;
  }

  emitStatus("connecting");

  // Fetch versao atual do WhatsApp Web (evita "Connection Failure" no handshake
  // por causa de versao hardcoded obsoleta no Baileys).
  let version: [number, number, number] | undefined;
  try {
    const r = await fetchLatestBaileysVersion();
    version = r.version;
    console.log(`[whatsapp] using WA Web version ${version.join(".")} (isLatest=${r.isLatest})`);
  } catch (err) {
    console.warn("[whatsapp] fetchLatestBaileysVersion failed, falling back to default:", err);
  }

  sock = makeWASocket({
    auth,
    version,
    printQRInTerminal: false,
    browser: ["MathAI Cockpit", "Chrome", "1.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false
  });

  sock.ev.on("creds.update", () => {
    void onCredsUpdate().catch(err =>
      console.warn("[whatsapp] saveCreds failed:", err)
    );
  });

  sock.ev.on("connection.update", update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      for (const cb of qrListeners) {
        try { cb(qr); } catch (err) { console.warn("[whatsapp] qr listener error:", err); }
      }
    }

    if (connection === "close") {
      const reason = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = reason === DisconnectReason.loggedOut;
      emitStatus("close", { reason, loggedOut });
    } else if (connection === "open") {
      emitStatus("open");
    } else if (connection === "connecting") {
      emitStatus("connecting");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.key.remoteJid || msg.key.fromMe) continue;
      incReceived();
      for (const cb of incomingListeners) {
        try { await cb(msg); } catch (err) { console.warn("[whatsapp] incoming listener error:", err); }
      }
    }
  });

  return sock;
};

/** Encerra o socket atual sem invalidar credenciais (apenas desconecta). */
export const closeSocket = async (): Promise<void> => {
  if (!sock) return;
  try { sock.end(undefined); } catch { /* ignore */ }
  sock = null;
  whatsappLimiter.reset();
  emitStatus("close");
};

/** Faz logout (invalida sessao no WhatsApp e limpa state local — caller limpa Mongo). */
export const performLogout = async (): Promise<void> => {
  if (!sock) return;
  try { await sock.logout(); } catch (err) { console.warn("[whatsapp] logout error:", err); }
  sock = null;
  whatsappLimiter.reset();
  emitStatus("close", { loggedOut: true });
};

/** Pareamento por codigo de 8 digitos (alternativa ao QR). */
export const requestPairingCode = async (phoneNumber: string): Promise<string> => {
  if (!sock) throw new Error("Socket nao iniciado");
  return sock.requestPairingCode(phoneNumber.replace(/\D/g, ""));
};

// ── Senders ───────────────────────────────────────────────────────────────

export const sendText = async (
  jid: string,
  text: string,
  opts?: { quoted?: WAMessage }
): Promise<WAMessage | undefined> => {
  if (!sock || currentStatus !== "open") {
    throw new Error("WhatsApp nao conectado");
  }
  await whatsappLimiter.wait(jid);
  try {
    const res = await sock.sendMessage(jid, { text }, opts?.quoted ? { quoted: opts.quoted } : undefined);
    incSent();
    return res;
  } catch (err) {
    incSendError(err instanceof Error ? err.message : String(err));
    throw err;
  }
};

export const editText = async (
  jid: string,
  msgKey: WAMessageKey,
  text: string
): Promise<WAMessage | undefined> => {
  if (!sock || currentStatus !== "open") {
    throw new Error("WhatsApp nao conectado");
  }
  await whatsappLimiter.wait(jid);
  try {
    const res = await sock.sendMessage(jid, { text, edit: msgKey });
    incSent();
    return res;
  } catch (err) {
    incSendError(err instanceof Error ? err.message : String(err));
    throw err;
  }
};

export const reactTo = async (
  jid: string,
  msgKey: WAMessageKey,
  emoji: string
): Promise<WAMessage | undefined> => {
  if (!sock || currentStatus !== "open") {
    throw new Error("WhatsApp nao conectado");
  }
  // Reactions nao precisam de rate limit pesado (sao leves no protocolo),
  // mas mantemos consistencia
  await whatsappLimiter.wait(jid);
  try {
    const res = await sock.sendMessage(jid, { react: { text: emoji, key: msgKey } });
    incReactionsSent();
    return res;
  } catch (err) {
    incSendError(err instanceof Error ? err.message : String(err));
    throw err;
  }
};

/** Envia documento como anexo (uso pra reports longos). */
export const sendDocument = async (
  jid: string,
  buffer: Buffer,
  filename: string,
  mimetype = "text/markdown"
): Promise<WAMessage | undefined> => {
  if (!sock || currentStatus !== "open") {
    throw new Error("WhatsApp nao conectado");
  }
  await whatsappLimiter.wait(jid);
  try {
    const res = await sock.sendMessage(jid, {
      document: buffer,
      fileName: filename,
      mimetype
    });
    incDocumentsSent();
    return res;
  } catch (err) {
    incSendError(err instanceof Error ? err.message : String(err));
    throw err;
  }
};

/**
 * Envia uma imagem (PNG/JPEG) como mensagem.
 * Usado pra screenshots do preview no comando !test.
 */
export const sendImage = async (
  jid: string,
  buffer: Buffer,
  caption?: string
): Promise<WAMessage | undefined> => {
  if (!sock || currentStatus !== "open") {
    throw new Error("WhatsApp nao conectado");
  }
  await whatsappLimiter.wait(jid);
  try {
    const res = await sock.sendMessage(jid, {
      image: buffer,
      caption
    });
    incSent();
    return res;
  } catch (err) {
    incSendError(err instanceof Error ? err.message : String(err));
    throw err;
  }
};

/**
 * Envia video (webm/mp4) como mensagem.
 * Usado pra gravacao da rotina de teste no comando !test.
 * WhatsApp converte webm internamente pra mp4 ao receber em dispositivos
 * que nao suportam — funciona em iOS/Android modernos.
 */
export const sendVideo = async (
  jid: string,
  buffer: Buffer,
  caption?: string,
  mimetype = "video/mp4"
): Promise<WAMessage | undefined> => {
  if (!sock || currentStatus !== "open") {
    throw new Error("WhatsApp nao conectado");
  }
  await whatsappLimiter.wait(jid);
  try {
    const res = await sock.sendMessage(jid, {
      video: buffer,
      caption,
      mimetype
    });
    incSent();
    return res;
  } catch (err) {
    incSendError(err instanceof Error ? err.message : String(err));
    throw err;
  }
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extrai texto plano de uma mensagem WhatsApp (cobre conversation, extendedTextMessage, ephemeral). */
export const extractText = (msg: WAMessage): string | null => {
  const m = msg.message;
  if (!m) return null;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.ephemeralMessage?.message?.conversation) return m.ephemeralMessage.message.conversation;
  if (m.ephemeralMessage?.message?.extendedTextMessage?.text) {
    return m.ephemeralMessage.message.extendedTextMessage.text;
  }
  return null;
};

/** Extrai phone do JID "5511...@s.whatsapp.net" → "5511...". */
export const jidToPhone = (jid: string): string => jid.split("@")[0]?.split(":")[0] ?? jid;

export const isPrivateChat = (jid: string): boolean => jid.endsWith("@s.whatsapp.net");
export const isGroupChat = (jid: string): boolean => jid.endsWith("@g.us");
