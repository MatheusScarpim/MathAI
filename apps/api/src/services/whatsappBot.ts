/**
 * Bot lifecycle + dispatcher de comandos WhatsApp.
 *
 * - Conecta via Baileys (auth state em Mongo)
 * - Reconnect com backoff exponencial em queda
 * - Whitelist estrita: so processa msg de chat vinculado (chat_bindings)
 *   ou que comece com "!start <token>"
 * - Comandos do MVP: !start, !help, !task, !now
 *
 * SEM resposta a chat nao-whitelistado (ignora silenciosamente — anti-bot detection).
 */

import { randomBytes } from "crypto";
import {
  startSocket,
  closeSocket,
  performLogout,
  sendText,
  sendImage,
  sendVideo,
  extractText,
  onIncoming,
  onStatusChange,
  isConnected,
  getSocket,
  jidToPhone,
  type ConnectionStatus
} from "../orchestrator/integrations/whatsapp.js";
import { captureUrl } from "./previewScreenshot.js";
import { planNavigation, planActions } from "../orchestrator/agents/previewNavigator.js";
import { useMongoAuthState } from "./whatsappAuthState.js";
import { whatsappLimiter } from "./whatsappRateLimiter.js";
import { incReconnect, snapshot as metricsSnapshot, computeHealth } from "./whatsappMetrics.js";
import { startPreview, stopPreview } from "./previewManager.js";
import { getMswSetupSubtasks } from "../helpers/mswSetup.js";
import { retrySubtask } from "./subtaskRetry.js";
import { getIntegrationsSettings } from "../helpers/settings.js";
import {
  getChatBindingsCollection,
  getProjectsCollection,
  getTasksCollection,
  getPendingPlansCollection,
  type ChatBindingRecord,
  type TaskRecord,
  type PendingPlanRecord
} from "../core/mongo.js";
import { ObjectId } from "mongodb";
import { executeTask } from "../orchestrator/index.js";
import { resolveProjectOptions } from "../helpers/projectOptionsResolver.js";
import { planTaskOnly } from "../helpers/planTaskOnly.js";
import { generateIdeas } from "../orchestrator/agents/ideas.js";
import { parseSchedule, describeCron } from "../orchestrator/agents/scheduleParser.js";
import {
  createSchedule,
  listSchedules,
  removeScheduleByIdOrSuffix
} from "./scheduler.js";

// ── Lifecycle state ─────────────────────────────────────────────

let auth: Awaited<ReturnType<typeof useMongoAuthState>> | null = null;
let started = false;
let reconnectAttempts = 0;
const RECONNECT_DELAYS_MS = [1000, 3000, 10_000, 30_000, 60_000];

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const scheduleReconnect = async (): Promise<void> => {
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)]!;
  reconnectAttempts++;
  console.log(`[whatsappBot] reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  await sleep(delay);
  if (started) {
    incReconnect();
    await openSocket();
  }
};

const openSocket = async (): Promise<void> => {
  if (!auth) auth = await useMongoAuthState();
  await startSocket(auth.state, auth.saveCreds);
};

/**
 * Inicializa o bot. No-op se whatsappEnabled === false nas settings.
 * Chamado uma vez no boot do API.
 */
export const startWhatsappBot = async (): Promise<void> => {
  const settings = await getIntegrationsSettings();
  if (!settings.whatsappEnabled) {
    console.log("[whatsappBot] disabled in settings, skipping");
    return;
  }

  if (started) {
    console.warn("[whatsappBot] already started");
    return;
  }
  started = true;

  // Aplica config de rate limit
  if (typeof settings.whatsappRateLimitMs === "number") {
    whatsappLimiter.setPerChatGap(settings.whatsappRateLimitMs);
  }

  auth = await useMongoAuthState();

  // Status listener: reconnect logic + paired marking
  onStatusChange(async (status: ConnectionStatus, info) => {
    if (status === "open") {
      reconnectAttempts = 0;
      // Marca paired + extrai phone do socket
      // socket.user.id format: "5511...:42@s.whatsapp.net"
      try {
        const sock = getSocket();
        const userId = sock?.user?.id;
        if (userId && auth) {
          const phone = jidToPhone(userId);
          await auth.markPaired(phone);
        } else if (auth) {
          await auth.markConnected();
        }
      } catch (err) {
        console.warn("[whatsappBot] mark paired failed:", err);
      }
    } else if (status === "close") {
      if (info?.loggedOut) {
        if (auth) await auth.markLoggedOut();
        // Nao tenta reconectar — precisa novo pareamento
        console.warn("[whatsappBot] logged out by WhatsApp; awaiting re-pair");
      } else if (started) {
        void scheduleReconnect();
      }
    }
  });

  // Incoming message → router de comandos
  onIncoming(handleIncoming);

  await openSocket();
};

/** Para o bot (uso em logout via API ou shutdown). */
export const stopWhatsappBot = async (): Promise<void> => {
  started = false;
  await closeSocket();
};

/** Logout completo (revoga sessao no WA + limpa Mongo). */
export const logoutWhatsappBot = async (): Promise<void> => {
  started = false;
  await performLogout();
  if (auth) await auth.clear();
  auth = null;
};

// ── Bind token (one-shot pra parear chat com user) ───────────────

/**
 * Cria registro pendente de bind. Frontend chama pra gerar token,
 * usuario manda "!start <token>" no bot.
 * Retorna o token pra exibir na UI.
 */
export const createBindToken = async (userId?: string, defaultProjectId?: string): Promise<{
  token: string;
  expiresAt: Date;
}> => {
  const col = await getChatBindingsCollection();
  const token = randomBytes(8).toString("hex"); // 16 chars
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  await col.insertOne({
    userId,
    transport: "whatsapp",
    chatId: "",                  // preenchido apos !start
    bindToken: token,
    bindTokenExpiresAt: expiresAt,
    defaultProjectId,
    active: false,
    createdAt: new Date()
  });

  return { token, expiresAt };
};

const findBinding = async (jid: string): Promise<ChatBindingRecord | null> => {
  const col = await getChatBindingsCollection();
  return col.findOne({ transport: "whatsapp", chatId: jid, active: true });
};

const isAllowedJid = async (jid: string): Promise<boolean> => {
  // 1. Bind ativo?
  const bound = await findBinding(jid);
  if (bound) return true;

  // 2. Whitelist estatica das settings?
  const settings = await getIntegrationsSettings();
  if (settings.whatsappAllowedJids?.includes(jid)) return true;

  return false;
};

// ── Test routine builder ─────────────────────────────────────────

/**
 * Gera um checklist em markdown do que o usuario deve verificar no preview.
 * Heuristica: classifica os arquivos mudados pela task (paginas/componentes/
 * services/stores/styles) e emite ate 6 bullets. Sem LLM, instantaneo.
 */
const buildTestRoutine = (task: TaskRecord): string => {
  // Coleta TODOS os arquivos mudados em subtasks do tipo github.
  const allFiles: string[] = [];
  for (const sub of task.subtasks ?? []) {
    if (sub.type !== "github") continue;
    const r = sub.result as { changes?: { file?: string }[] } | undefined;
    for (const c of r?.changes ?? []) {
      if (typeof c.file === "string" && c.file.length > 0) allFiles.push(c.file);
    }
  }
  const uniqueFiles = Array.from(new Set(allFiles));

  // Classifica
  const pages = new Set<string>();
  const components = new Set<string>();
  const services = new Set<string>();
  const stores = new Set<string>();
  const styles = new Set<string>();
  const other = new Set<string>();
  let hasFrontend = false;

  for (const f of uniqueFiles) {
    if (f.startsWith("apps/api/") || f.startsWith("backend/") || f.startsWith("packages/api/") || f.startsWith("server/")) continue;
    hasFrontend = true;

    const mPage = /pages\/([^/]+)\.(vue|tsx?|jsx?)$/i.exec(f);
    if (mPage) { pages.add(mPage[1]!); continue; }
    const mComp = /components\/([^/]+)\.(vue|tsx?|jsx?)$/i.exec(f);
    if (mComp) { components.add(mComp[1]!); continue; }
    const mSvc = /services\/([^/]+)\.(ts|js)$/i.exec(f);
    if (mSvc) { services.add(mSvc[1]!); continue; }
    const mStore = /(stores?|pinia)\/([^/]+)\.(ts|js)$/i.exec(f);
    if (mStore) { stores.add(mStore[2]!); continue; }
    if (/\.(css|scss|sass|less)$/i.test(f)) { styles.add(f.split("/").pop() ?? f); continue; }
    other.add(f);
  }

  const lines: string[] = [];
  lines.push(`📋 *Rotina de teste — \`${shortId(task._id)}\`*`);
  if (task.description) {
    const desc = task.description.length > 110 ? task.description.slice(0, 107) + "…" : task.description;
    lines.push(`_${desc}_`);
  }
  lines.push("");
  lines.push("🔍 *Verificar:*");

  let checks = 0;
  const MAX = 6;

  for (const p of pages) {
    if (checks >= MAX) break;
    lines.push(`• Abrir página *${p}* — confirma que renderiza sem erro (console limpo)`);
    checks++;
  }
  if (components.size && checks < MAX) {
    const list = Array.from(components).slice(0, 3).join(", ");
    const more = components.size > 3 ? ` (+${components.size - 3})` : "";
    lines.push(`• Componente(s) *${list}*${more} — UI bate com o pedido?`);
    checks++;
  }
  if (services.size && checks < MAX) {
    const list = Array.from(services).slice(0, 2).join(", ");
    lines.push(`• DevTools → Network: chamadas via *${list}* devem retornar 200 (mockadas)`);
    checks++;
  }
  if (stores.size && checks < MAX) {
    const list = Array.from(stores).slice(0, 2).join(", ");
    lines.push(`• Store(s) *${list}* — estado popula corretamente no boot?`);
    checks++;
  }
  if (styles.size && checks < MAX) {
    lines.push(`• Estilos atualizados (${styles.size} arquivo${styles.size > 1 ? "s" : ""}) — visual confere?`);
    checks++;
  }
  if (other.size && checks < MAX) {
    const sample = Array.from(other).slice(0, 2).join(", ");
    const more = other.size > 2 ? ` (+${other.size - 2})` : "";
    lines.push(`• Outros: \`${sample}\`${more}`);
    checks++;
  }

  if (!hasFrontend) {
    lines.push("• ⚠️ Task tocou só backend — sem mudança visual direta no preview");
  }

  if (checks < MAX) {
    lines.push("• Login deve ser bypassado automaticamente (se a tela de login aparecer, reportar)");
  }

  lines.push("");
  lines.push("_⚠️ Backend mockado: cadastros e edits não persistem entre reloads._");

  return lines.join("\n");
};

// ── Incoming dispatcher ──────────────────────────────────────────

const handleIncoming = async (msg: import("@whiskeysockets/baileys").WAMessage): Promise<void> => {
  const jid = msg.key.remoteJid;
  if (!jid) return;
  // Ignora grupos no MVP — aceita @s.whatsapp.net (PN) e @lid (Linked ID, novo formato).
  // Grupos sao @g.us, broadcasts @broadcast etc.
  if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid")) return;

  const text = extractText(msg);
  if (!text) return;
  const trimmed = text.trim();

  // !start <token> — caminho de bind, EXCECAO da whitelist
  if (trimmed.startsWith("!start ") || trimmed.startsWith("mathai start ")) {
    const token = trimmed.replace(/^(!start |mathai start )/, "").trim();
    return handleStart(jid, token);
  }

  // Whitelist
  if (!await isAllowedJid(jid)) {
    // Silencioso por design — nao vaza que e bot
    return;
  }

  const binding = await findBinding(jid);
  if (!binding) {
    await safeSend(jid, "🔒 Vincule este chat primeiro: gere um token nas Configuracoes do MathAI e envie *!start <token>*");
    return;
  }

  // ── Intercept: se ha plano pendente e mensagem parece resposta, processa aqui ──
  const pending = await findPendingPlan(jid);
  if (pending && isApprovalResponse(trimmed)) {
    return handlePlanApprovalResponse(jid, binding, pending, trimmed);
  }

  // Aliases mathai → !
  const cmd = trimmed.replace(/^mathai\s+/, "!").trim();

  if (cmd === "!help" || cmd === "!ajuda") return handleHelp(jid);
  if (cmd === "!health" || cmd === "!saude" || cmd === "!saúde") return handleHealth(jid);
  if (cmd === "!now") return handleNow(jid, binding);
  if (cmd === "!today" || cmd === "!hoje") return handleToday(jid, binding);
  if (cmd === "!prs") return handlePrs(jid, binding);
  if (cmd === "!ideas" || cmd === "!ideias") return handleIdeas(jid, binding);
  if (cmd === "!scheduled" || cmd === "!agendados") return handleListScheduled(jid, binding);
  if (cmd.startsWith("!schedule ") || cmd.startsWith("!agendar ")) {
    const arg = cmd.replace(/^(!schedule |!agendar )/, "").trim();
    return handleSchedule(jid, binding, arg);
  }
  if (cmd === "!schedule" || cmd === "!agendar") {
    return safeSend(jid, "Uso: *!schedule <quando> <descricao>*\nEx: !schedule diariamente 9h ideias\nEx: !schedule toda terca 14h rodar smoke test");
  }
  if (cmd.startsWith("!unschedule ") || cmd.startsWith("!desagendar ")) {
    const arg = cmd.replace(/^(!unschedule |!desagendar )/, "").trim();
    return handleUnschedule(jid, binding, arg);
  }
  if (cmd === "!unschedule" || cmd === "!desagendar") {
    return safeSend(jid, "Uso: *!unschedule <id>*");
  }
  if (cmd === "!projects" || cmd === "!projetos") return handleListProjects(jid, binding);
  if (cmd.startsWith("!project ") || cmd.startsWith("!projeto ")) {
    const arg = cmd.replace(/^(!project |!projeto )/, "").trim();
    return handleSetProject(jid, binding, arg);
  }
  if (cmd.startsWith("!approve ") || cmd.startsWith("!aprovacao ")) {
    const arg = cmd.replace(/^(!approve |!aprovacao )/, "").trim();
    return handleApproveToggle(jid, binding, arg);
  }
  if (cmd === "!approve" || cmd === "!aprovacao") {
    const cur = binding.requirePlanApproval !== false;
    return safeSend(jid, `Gate de aprovacao: *${cur ? "ON" : "OFF"}*\nUse *!approve on* ou *!approve off*.`);
  }
  if (cmd.startsWith("!status ")) return handleStatus(jid, binding, cmd.slice(8).trim());
  if (cmd === "!status") {
    return safeSend(jid, "Uso: *!status <id>*\nID pode ser o ObjectId completo ou prefixo (>= 6 chars).");
  }
  if (cmd.startsWith("!cancel ") || cmd.startsWith("!cancelar ")) {
    const arg = cmd.replace(/^(!cancel |!cancelar )/, "").trim();
    return handleCancel(jid, binding, arg);
  }
  if (cmd === "!cancel" || cmd === "!cancelar") {
    return safeSend(jid, "Uso: *!cancel <id>*");
  }
  if (cmd.startsWith("!retry ") || cmd.startsWith("!repetir ")) {
    const arg = cmd.replace(/^(!retry |!repetir )/, "").trim();
    return handleRetry(jid, binding, arg);
  }
  if (cmd === "!retry" || cmd === "!repetir") {
    return safeSend(jid, "Uso: *!retry <id>* — dispara nova task com a mesma descricao");
  }
  if (cmd.startsWith("!test ") || cmd.startsWith("!testar ")) {
    const arg = cmd.replace(/^(!test |!testar )/, "").trim();
    return handleTest(jid, binding, arg);
  }
  if (cmd === "!test" || cmd === "!testar") {
    return safeSend(jid, "Uso: *!test <id>* — sobe preview efemero (URL publica).");
  }
  if (cmd.startsWith("!testend ") || cmd.startsWith("!parartest ")) {
    const arg = cmd.replace(/^(!testend |!parartest )/, "").trim();
    return handleTestEnd(jid, binding, arg);
  }
  if (cmd === "!testend" || cmd === "!parartest") {
    return safeSend(jid, "Uso: *!testend <id>* — encerra o preview");
  }
  if (cmd.startsWith("!setup-preview ") || cmd.startsWith("!setuppreview ") || cmd.startsWith("!configurar-preview ")) {
    const arg = cmd.replace(/^(!setup-preview |!setuppreview |!configurar-preview )/, "").trim();
    return handleSetupPreview(jid, binding, arg);
  }
  if (cmd === "!setup-preview" || cmd === "!setuppreview" || cmd === "!configurar-preview") {
    return safeSend(jid, "Uso: *!setup-preview <id|nome>* — configura MSW no projeto automaticamente");
  }
  if (cmd.startsWith("!retrysub ") || cmd.startsWith("!retentar ")) {
    const arg = cmd.replace(/^(!retrysub |!retentar )/, "").trim();
    return handleRetrySub(jid, binding, arg);
  }
  if (cmd === "!retrysub" || cmd === "!retentar") {
    return safeSend(jid, "Uso: *!retrysub <taskId> <subtaskId>* — re-executa subtask falha");
  }
  if (cmd.startsWith("!task ")) return handleTask(jid, binding, cmd.slice(6).trim());
  if (cmd === "!task") {
    return safeSend(jid, "Uso: *!task <descricao>*\nExemplo: !task corrigir bug do login");
  }

  // Comando vinculado mas nao reconhecido — usa help curto (chat e trusted)
  await safeSend(jid, `❓ Comando nao reconhecido. Envie *!help* pra lista.`);
};

// ── Command handlers ─────────────────────────────────────────────

const handleStart = async (jid: string, token: string): Promise<void> => {
  if (!token) {
    await safeSend(jid, "Uso: *!start <token>*\nGere um token nas Configuracoes do MathAI.");
    return;
  }

  const col = await getChatBindingsCollection();
  const pending = await col.findOne({
    transport: "whatsapp",
    bindToken: token,
    active: false
  });

  if (!pending) {
    await safeSend(jid, "❌ Token invalido ou ja usado.");
    return;
  }

  if (pending.bindTokenExpiresAt && pending.bindTokenExpiresAt < new Date()) {
    await safeSend(jid, "⏰ Token expirado. Gere outro nas Configuracoes.");
    await col.deleteOne({ _id: pending._id });
    return;
  }

  await col.updateOne(
    { _id: pending._id },
    {
      $set: {
        chatId: jid,
        active: true,
        displayName: jidToPhone(jid)
      },
      $unset: { bindToken: "", bindTokenExpiresAt: "" }
    }
  );

  await safeSend(
    jid,
    `✅ *Vinculado!*\n\nVoce ja pode usar:\n• *!task <desc>* — disparar nova task\n• *!now* — o que esta rodando\n• *!help* — ajuda completa`
  );
};

const handleHelp = async (jid: string): Promise<void> => {
  await safeSend(
    jid,
    `*MathAI Bot — Comandos*\n\n` +
    `*Tasks*\n` +
    `🚀 *!task <descricao>* — dispara nova task\n` +
    `🔄 *!now* — tasks rodando agora\n` +
    `📅 *!today* — agenda de hoje\n` +
    `📋 *!status <id>* — detalhes de uma task\n` +
    `🛑 *!cancel <id>* — cancela em execucao\n` +
    `🔁 *!retry <id>* — repete uma task antiga\n` +
    `🔁 *!retrysub <taskId> <subId>* — re-executa subtask falha (PR atualiza)\n` +
    `🌐 *!test <id>* — sobe preview efemero (URL publica)\n` +
    `🛑 *!testend <id>* — encerra preview\n` +
    `🔗 *!prs* — pull requests recentes\n` +
    `💡 *!ideas* — sugestoes de melhoria baseadas no uso\n\n` +
    `*Agendamento*\n` +
    `⏰ *!schedule <quando> <descricao>* — agendar recorrente\n` +
    `📋 *!scheduled* — lista agendados\n` +
    `🗑 *!unschedule <id>* — remove agendado\n\n` +
    `*Projetos*\n` +
    `📁 *!projects* — lista disponiveis\n` +
    `📌 *!project <id|nome>* — define default deste chat\n` +
    `🪄 *!setup-preview <id|nome>* — configura MSW automaticamente\n\n` +
    `*Comportamento*\n` +
    `🛂 *!approve on|off* — aprovar plano antes de executar\n\n` +
    `*Saude*\n` +
    `🩺 *!health* — status, metricas e saude do bot\n\n` +
    `❓ *!help* — esta mensagem\n` +
    `_Aliases:_ \`mathai <cmd>\` tambem funciona.`
  );
};

const formatUptime = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

const handleHealth = async (jid: string): Promise<void> => {
  const settings = await getIntegrationsSettings();
  const credsCol = await (await import("../core/mongo.js")).getWhatsappAuthCredsCollection();
  const creds = await credsCol.findOne({ _id: "creds" });
  const pairingStatus = creds?.status ?? "unpaired";
  const connected = isConnected();
  const health = computeHealth(connected, pairingStatus);
  const m = metricsSnapshot();

  const healthIcon = health === "ok" ? "🟢" : health === "degraded" ? "🟡" : "🔴";
  const connIcon = connected ? "🟢 conectado" : "🔴 offline";
  const pairLabel = pairingStatus === "paired"
    ? `📱 +${creds?.phoneNumber ?? "?"}`
    : pairingStatus === "logged_out"
      ? "⚠️ sessao revogada"
      : "⏳ nao pareado";

  const lines = [
    `${healthIcon} *Saude: ${health}*`,
    "",
    `${connIcon}  ·  ${pairLabel}`,
    `⏱ uptime: ${formatUptime(m.uptimeMs)}  ·  rate: ${settings.whatsappRateLimitMs ?? 2500}ms`,
    "",
    `*Total desde boot*`,
    `↑ enviadas: ${m.messagesSent}  ·  ↓ recebidas: ${m.messagesReceived}`,
    `😀 reactions: ${m.reactionsSent}  ·  📎 docs: ${m.documentsSent}`,
    `❌ send-errors: ${m.sendErrors}  ·  ⟳ reconnects: ${m.reconnects}`,
    "",
    `*Janela 10min (atual)*`,
    `↑${m.inWindow.messagesSent} ↓${m.inWindow.messagesReceived} 😀${m.inWindow.reactionsSent} ❌${m.inWindow.sendErrors} ⟳${m.inWindow.reconnects}`
  ];

  if (m.lastErrorAt) {
    const ago = Math.floor((Date.now() - new Date(m.lastErrorAt).getTime()) / 60000);
    lines.push("");
    lines.push(`_Ultimo erro: ${ago}min atras_`);
    if (m.lastErrorMessage) lines.push(`_${m.lastErrorMessage.slice(0, 150)}_`);
  }

  await safeSend(jid, lines.join("\n"));
};

const handleListProjects = async (jid: string, binding: ChatBindingRecord): Promise<void> => {
  const projectsCol = await getProjectsCollection();
  const filter: Record<string, unknown> = {};
  if (binding.userId) filter.userId = binding.userId;
  const projects = await projectsCol.find(filter).sort({ isInbox: -1, createdAt: 1 }).toArray();

  if (projects.length === 0) {
    await safeSend(jid, "📁 Nenhum projeto cadastrado. Crie pelo frontend MathAI.");
    return;
  }

  const lines: string[] = [`📁 *Projetos disponiveis*`, ""];
  for (const p of projects) {
    const id = p._id?.toString() ?? "";
    const isDefault = binding.defaultProjectId === id;
    const repos = (p.repoIds ?? []).length;
    const trelloOk = p.trelloBoardId ? "✓" : "✗";
    const githubOk = repos > 0 ? `✓ ${repos} repo${repos > 1 ? "s" : ""}` : "✗";
    lines.push(`${isDefault ? "⭐ " : "• "}*${p.name}* ${p.isInbox ? "_(inbox)_" : ""}`);
    lines.push(`   ID: \`${id}\``);
    lines.push(`   GitHub: ${githubOk} · Trello: ${trelloOk}`);
    lines.push("");
  }
  lines.push("Use *!project <id>* ou *!project <nome>* pra definir o default.");
  await safeSend(jid, lines.join("\n").trim());
};

const handleSetProject = async (jid: string, binding: ChatBindingRecord, arg: string): Promise<void> => {
  if (!arg) {
    await safeSend(jid, "Uso: *!project <id|nome>*\nUse *!projects* pra ver os disponiveis.");
    return;
  }

  const projectsCol = await getProjectsCollection();
  const userFilter = binding.userId ? { userId: binding.userId } : {};

  // 1. tenta por ObjectId direto
  let project = ObjectId.isValid(arg)
    ? await projectsCol.findOne({ _id: new ObjectId(arg), ...userFilter })
    : null;

  // 2. fallback por nome (case-insensitive)
  if (!project) {
    project = await projectsCol.findOne({
      name: { $regex: `^${arg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
      ...userFilter
    });
  }

  if (!project) {
    await safeSend(jid, `❌ Projeto nao encontrado: \`${arg}\`\nUse *!projects* pra ver a lista.`);
    return;
  }

  const projectId = project._id!.toString();
  const bindingsCol = await getChatBindingsCollection();
  await bindingsCol.updateOne(
    { _id: binding._id },
    { $set: { defaultProjectId: projectId } }
  );

  await safeSend(jid, `📌 Projeto default definido: *${project.name}*\n_${projectId}_\n\nAgora *!task <desc>* vai usar este projeto.`);
};

const handleNow = async (jid: string, binding: ChatBindingRecord): Promise<void> => {
  const tasksCol = await getTasksCollection();
  const filter: Record<string, unknown> = {
    status: { $in: ["planning", "executing"] }
  };
  if (binding.userId) filter.userId = binding.userId;

  const tasks = await tasksCol.find(filter).sort({ createdAt: -1 }).limit(10).toArray();

  if (tasks.length === 0) {
    await safeSend(jid, "💤 Nada rodando agora.");
    return;
  }

  const stageIcon: Record<string, string> = {
    planning: "🧠",
    coding: "✏️",
    reviewing: "🔍",
    reporting: "📝",
    done: "✅"
  };

  const lines: string[] = [`🔄 *${tasks.length} task${tasks.length > 1 ? "s" : ""} ativa${tasks.length > 1 ? "s" : ""}*`, ""];
  for (const t of tasks) {
    const stage = t.currentStage ?? t.status;
    const icon = stageIcon[stage] ?? "⚙️";
    const desc = t.description.split(/\r?\n/)[0]!.slice(0, 80);
    const ageMin = Math.floor((Date.now() - new Date(t.createdAt).getTime()) / 60000);
    lines.push(`${icon} _${stage}_ · "${desc}"`);
    lines.push(`    🆔 \`${shortId(t._id)}\` · ${ageMin} min atras`);
    lines.push("");
  }

  lines.push("_Use *!status <id>* ou *!cancel <id>* pra agir._");

  await safeSend(jid, lines.join("\n").trim());
};

const handleTask = async (jid: string, binding: ChatBindingRecord, description: string): Promise<void> => {
  if (!description) {
    await safeSend(jid, "Uso: *!task <descricao>*");
    return;
  }

  // Sem projeto default → guia o user pra setar
  if (!binding.defaultProjectId) {
    await safeSend(
      jid,
      `❌ Este chat nao tem projeto default.\n\n` +
      `Use *!projects* pra ver a lista e *!project <id|nome>* pra definir.`
    );
    return;
  }

  // Resolve repos + Trello a partir do projeto
  const resolved = await resolveProjectOptions(binding.defaultProjectId);
  if (!resolved) {
    await safeSend(jid, `❌ Projeto default nao existe mais. Use *!project <id>* pra trocar.`);
    return;
  }

  const { project, github, trello } = resolved;
  const requireApproval = binding.requirePlanApproval !== false; // default true

  if (!requireApproval) {
    // Direto, sem gate
    return fireTaskExecution(jid, binding, description, project.name, github, trello);
  }

  // ── Gate de aprovacao: planeja, salva pending, manda preview ──
  await safeSend(jid, `🧠 _Planejando "${description.slice(0, 80)}"..._`);

  let plan;
  try {
    plan = await planTaskOnly({
      description,
      language: "pt",
      github,
      trello
    });
  } catch (err) {
    await safeSend(jid, `❌ *Erro ao planejar:* ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (plan.subtasks.length === 0) {
    await safeSend(jid, `❌ Planner nao retornou subtasks viaveis. Verifique integracoes do projeto.`);
    return;
  }

  // Limpa qualquer plano pendente antigo deste chat (so 1 ativo por vez)
  const pendingsCol = await getPendingPlansCollection();
  await pendingsCol.deleteMany({ jid, transport: "whatsapp" });

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const { insertedId } = await pendingsCol.insertOne({
    jid,
    userId: binding.userId,
    transport: "whatsapp",
    description,
    language: "pt",
    projectId: binding.defaultProjectId,
    plannedSubtasks: plan.subtasks,
    resolvedGithub: plan.resolvedGithub,
    resolvedTrello: plan.resolvedTrello,
    createdAt: new Date(),
    expiresAt
  });

  await safeSend(jid, formatPlanPreview(description, project.name, plan.subtasks, plan.warnings, insertedId.toString()));
};

/** Dispara execucao direta (sem gate). Reutilizado pra approve. */
const fireTaskExecution = async (
  jid: string,
  binding: ChatBindingRecord,
  description: string,
  projectName: string,
  github: import("../orchestrator/types.js").GithubRepoConfig[] | undefined,
  trello: { boardId: string; listId?: string; doneListId?: string } | undefined,
  presetSubtasks?: PendingPlanRecord["plannedSubtasks"]
): Promise<void> => {
  const lines: string[] = [
    presetSubtasks ? `🚀 *Iniciando (plano aprovado)*` : `🚀 *Iniciando*`,
    `📁 ${projectName}`,
    description
  ];
  const facts: string[] = [];
  if (github && github.length > 0) facts.push(`GitHub: ${github.map(r => r.repo).join(", ")}`);
  if (trello?.boardId) facts.push("Trello: card");
  if (facts.length > 0) {
    lines.push("");
    lines.push(`_${facts.join(" · ")}_`);
  }
  await safeSend(jid, lines.join("\n"));

  // Carrega previewMocksDir do project (opt-in)
  const projectsCol = await getProjectsCollection();
  const projectDoc = binding.defaultProjectId && ObjectId.isValid(binding.defaultProjectId)
    ? await projectsCol.findOne({ _id: new ObjectId(binding.defaultProjectId) })
    : null;

  void executeTask(description, {
    userId: binding.userId,
    projectId: binding.defaultProjectId,
    github,
    trello,
    whatsapp: { jid },
    presetSubtasks,
    previewMocksDir: projectDoc?.previewMocksDir
  } as import("../orchestrator/types.js").TaskExecuteOptions).catch(err => {
    console.error("[whatsappBot] executeTask error:", err);
    void safeSend(jid, `❌ *Erro ao disparar task:* ${err instanceof Error ? err.message : String(err)}`);
  });
};

const TYPE_ICONS: Record<string, string> = {
  github: "✏️",
  trello: "📌",
  api: "🌐",
  custom: "🤖"
};

const formatPlanPreview = (
  description: string,
  projectName: string,
  subtasks: PendingPlanRecord["plannedSubtasks"],
  warnings: string[],
  pendingId: string
): string => {
  const lines: string[] = [
    `📋 *Plano da task*`,
    "",
    `📁 ${projectName}`,
    `_"${description.slice(0, 200)}"_`,
    "",
    `*${subtasks.length} subtask${subtasks.length > 1 ? "s" : ""}:*`
  ];
  for (let i = 0; i < subtasks.length; i++) {
    const st = subtasks[i]!;
    const icon = TYPE_ICONS[st.type] ?? "•";
    const repoTag = st.repo ? ` _[${st.repo}]_` : "";
    lines.push(`${i + 1}. ${icon} ${st.description}${repoTag}`);
  }
  if (warnings.length > 0) {
    lines.push("");
    lines.push("⚠️ _Avisos:_");
    for (const w of warnings) lines.push(`• ${w}`);
  }
  lines.push("");
  lines.push(`Responda *1* (aprovar) ou *2* (cancelar).`);
  lines.push(`_Plano \`${pendingId.slice(-8)}\` expira em 10min._`);
  return lines.join("\n");
};

const findPendingPlan = async (jid: string): Promise<PendingPlanRecord | null> => {
  const col = await getPendingPlansCollection();
  return col.findOne({ jid, transport: "whatsapp", expiresAt: { $gt: new Date() } });
};

const APPROVE_RX = /^(1|sim|s|aprovar|aprovo|ok|yes|y)\b/i;
const REJECT_RX = /^(2|n[ãa]o|nao|n|cancelar|cancel|no)\b/i;

const isApprovalResponse = (text: string): boolean =>
  APPROVE_RX.test(text) || REJECT_RX.test(text);

const handlePlanApprovalResponse = async (
  jid: string,
  binding: ChatBindingRecord,
  pending: PendingPlanRecord,
  text: string
): Promise<void> => {
  const col = await getPendingPlansCollection();
  // Pega projectName pra display
  let projectName = "?";
  if (pending.projectId) {
    try {
      const projectsCol = await getProjectsCollection();
      const p = await projectsCol.findOne({ _id: new ObjectId(pending.projectId) });
      if (p) projectName = p.name;
    } catch { /* ignore */ }
  }

  if (REJECT_RX.test(text)) {
    await col.deleteOne({ _id: pending._id });
    await safeSend(jid, `❌ Plano cancelado.`);
    return;
  }

  if (APPROVE_RX.test(text)) {
    await col.deleteOne({ _id: pending._id });
    await fireTaskExecution(
      jid,
      binding,
      pending.description,
      projectName,
      pending.resolvedGithub,
      pending.resolvedTrello,
      pending.plannedSubtasks
    );
    return;
  }
};

const handleApproveToggle = async (
  jid: string,
  binding: ChatBindingRecord,
  arg: string
): Promise<void> => {
  const lower = arg.toLowerCase();
  let value: boolean;
  if (lower === "on" || lower === "true" || lower === "sim" || lower === "1") {
    value = true;
  } else if (lower === "off" || lower === "false" || lower === "nao" || lower === "não" || lower === "0") {
    value = false;
  } else {
    await safeSend(jid, "Uso: *!approve on* ou *!approve off*");
    return;
  }
  const col = await getChatBindingsCollection();
  await col.updateOne({ _id: binding._id }, { $set: { requirePlanApproval: value } });
  await safeSend(jid, `✅ Gate de aprovacao: *${value ? "ON" : "OFF"}*\n_${value ? "Vou pedir aprovacao antes de cada !task." : "Vou executar !task direto, sem perguntar."}_`);
};

// ── Resolucao de TaskId (full ObjectId ou prefixo >= 6 chars) ────

/**
 * Resolve um arg de comando (`<id>`) pra TaskRecord. Aceita:
 *   - ObjectId completo (24 chars hex)
 *   - Sufixo do ObjectId (>= 6 chars hex) — mesmo formato que o display em `shortId`.
 *
 * Por que sufixo e nao prefixo: o prefixo do ObjectId e o timestamp,
 * entao varias tasks criadas no mesmo segundo compartilham o prefixo.
 * O sufixo (random + counter) e bem mais unico.
 */
const resolveTaskByIdArg = async (
  arg: string,
  binding: ChatBindingRecord
): Promise<{ ok: true; task: TaskRecord } | { ok: false; reason: string }> => {
  const tasksCol = await getTasksCollection();
  const filter: Record<string, unknown> = {};
  if (binding.userId) filter.userId = binding.userId;

  // Caso 1: ObjectId completo
  if (ObjectId.isValid(arg) && arg.length === 24) {
    const task = await tasksCol.findOne({ ...filter, _id: new ObjectId(arg) });
    if (!task) return { ok: false, reason: "Task nao encontrada." };
    return { ok: true, task };
  }

  // Caso 2: sufixo (>= 6 chars hex)
  if (!/^[0-9a-fA-F]{6,23}$/.test(arg)) {
    return { ok: false, reason: "ID invalido. Use ObjectId completo ou sufixo de 6+ chars hex." };
  }

  const lower = arg.toLowerCase();
  // Mongo nao tem regex em ObjectId direto — usa $expr + $regexMatch sobre $toString
  const matches = await tasksCol
    .find({
      ...filter,
      $expr: {
        $regexMatch: {
          input: { $toString: "$_id" },
          regex: `${lower}$`
        }
      }
    } as Record<string, unknown>)
    .sort({ createdAt: -1 })
    .limit(2)
    .toArray();

  if (matches.length === 0) return { ok: false, reason: "Nenhuma task com esse sufixo." };
  if (matches.length > 1) return { ok: false, reason: "Sufixo ambiguo — use mais caracteres." };
  return { ok: true, task: matches[0]! };
};

/**
 * Formata ObjectId como string curta (ultimos 8 chars hex).
 * Sufixo e mais unico que prefixo porque carrega counter+random,
 * enquanto prefixo e o timestamp em segundos.
 */
const shortId = (id: ObjectId | undefined): string => id ? id.toString().slice(-8) : "?";

// ── Handlers do pacote dia-a-dia ─────────────────────────────────

const handleToday = async (jid: string, binding: ChatBindingRecord): Promise<void> => {
  const tasksCol = await getTasksCollection();
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

  const filter: Record<string, unknown> = {
    $or: [
      { createdAt: { $gte: dayStart, $lte: dayEnd } },
      { completedAt: { $gte: dayStart, $lte: dayEnd } }
    ]
  };
  if (binding.userId) filter.userId = binding.userId;

  const tasks = await tasksCol.find(filter).sort({ createdAt: 1 }).toArray();

  if (tasks.length === 0) {
    await safeSend(jid, "📅 Nada hoje ainda.");
    return;
  }

  const dateLabel = now.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
  const lines: string[] = [`📅 *${dateLabel}*`, ""];

  // Agrupa por hora baseado em createdAt
  const byHour = new Map<number, typeof tasks>();
  for (const t of tasks) {
    const h = new Date(t.createdAt).getHours();
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h)!.push(t);
  }

  const statusIcon: Record<string, string> = {
    completed: "✅",
    failed: "❌",
    cancelled: "⛔",
    executing: "🔄",
    planning: "🧠",
    pending: "⏳"
  };

  const sortedHours = [...byHour.keys()].sort((a, b) => a - b);
  for (const h of sortedHours) {
    const items = byHour.get(h)!;
    for (const t of items) {
      const icon = statusIcon[t.status] ?? "•";
      const desc = t.description.split(/\r?\n/)[0]!.slice(0, 60);
      const elapsed = t.completedAt
        ? Math.max(0, Math.floor((new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime()) / 60000))
        : null;
      const tag = elapsed !== null ? `(${elapsed}min)` : t.status === "executing" ? "[agora]" : "";
      lines.push(`${String(h).padStart(2, "0")}h ${icon} \`${shortId(t._id)}\` "${desc}" ${tag}`.trim());
    }
  }

  const completedCount = tasks.filter(t => t.status === "completed").length;
  const failedCount = tasks.filter(t => t.status === "failed" || t.status === "cancelled").length;
  const activeCount = tasks.filter(t => t.status === "planning" || t.status === "executing").length;
  lines.push("");
  lines.push(`_${completedCount} concluida(s) · ${activeCount} ativa(s) · ${failedCount} falha(s)_`);

  await safeSend(jid, lines.join("\n"));
};

const handleStatus = async (jid: string, binding: ChatBindingRecord, arg: string): Promise<void> => {
  if (!arg) {
    await safeSend(jid, "Uso: *!status <id>*");
    return;
  }

  const result = await resolveTaskByIdArg(arg, binding);
  if (!result.ok) {
    await safeSend(jid, `❌ ${result.reason}`);
    return;
  }
  const task = result.task;

  const stageIcon: Record<string, string> = {
    planning: "🧠", coding: "✏️", reviewing: "🔍", reporting: "📝", done: "✅"
  };
  const statusIcon: Record<string, string> = {
    completed: "✅", failed: "❌", cancelled: "⛔", executing: "🔄", planning: "🧠", pending: "⏳"
  };

  const stage = task.currentStage ?? task.status;
  const sIcon = statusIcon[task.status] ?? stageIcon[stage] ?? "•";

  const subDone = task.subtasks.filter(s => s.status === "completed").length;
  const subTotal = task.subtasks.length;
  const elapsed = task.completedAt
    ? Math.max(0, Math.floor((new Date(task.completedAt).getTime() - new Date(task.createdAt).getTime()) / 60000))
    : Math.max(0, Math.floor((Date.now() - new Date(task.createdAt).getTime()) / 60000));

  const lines: string[] = [
    `${sIcon} *${task.status}*${task.currentStage ? ` (${stage})` : ""}`,
    "",
    task.description.split(/\r?\n/)[0]!.slice(0, 200),
    "",
    `🆔 \`${shortId(task._id)}\``,
    `📊 Subtasks: ${subDone}/${subTotal}`,
    `⏱ ${elapsed} min`
  ];
  if (task.githubPrUrls && task.githubPrUrls.length > 0) {
    lines.push("");
    lines.push("🔗 *PRs*");
    for (const url of task.githubPrUrls) lines.push(url);
  }
  if (task.summary && task.status !== "executing" && task.status !== "planning") {
    lines.push("");
    lines.push("📝 *Resumo*");
    lines.push(task.summary.slice(0, 1000));
  }
  await safeSend(jid, lines.join("\n"));
};

const handleCancel = async (jid: string, binding: ChatBindingRecord, arg: string): Promise<void> => {
  if (!arg) {
    await safeSend(jid, "Uso: *!cancel <id>*");
    return;
  }
  const result = await resolveTaskByIdArg(arg, binding);
  if (!result.ok) {
    await safeSend(jid, `❌ ${result.reason}`);
    return;
  }
  const task = result.task;

  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    await safeSend(jid, `⚠️ Task ja esta *${task.status}*. Nada a cancelar.`);
    return;
  }

  const tasksCol = await getTasksCollection();
  await tasksCol.updateOne(
    { _id: task._id },
    { $set: { status: "cancelled", updatedAt: new Date() } }
  );
  await safeSend(jid, `🛑 Task \`${shortId(task._id)}\` marcada como cancelada.\n_O cancelamento e detectado no proximo ciclo do pipeline._`);
};

const handleRetry = async (jid: string, binding: ChatBindingRecord, arg: string): Promise<void> => {
  if (!arg) {
    await safeSend(jid, "Uso: *!retry <id>*");
    return;
  }
  const result = await resolveTaskByIdArg(arg, binding);
  if (!result.ok) {
    await safeSend(jid, `❌ ${result.reason}`);
    return;
  }
  const original = result.task;

  // Reusa projeto da task original (ou default do binding como fallback)
  const projectId = original.projectId ?? binding.defaultProjectId;
  if (!projectId) {
    await safeSend(jid, "❌ Task original sem projeto e chat sem default. Use *!project* primeiro.");
    return;
  }

  const resolved = await resolveProjectOptions(projectId);
  if (!resolved) {
    await safeSend(jid, "❌ Projeto da task original nao existe mais.");
    return;
  }

  await safeSend(jid, `🔁 *Repetindo*\n📁 ${resolved.project.name}\n${original.description.slice(0, 200)}`);

  void executeTask(original.description, {
    userId: binding.userId,
    projectId,
    github: resolved.github,
    trello: resolved.trello,
    whatsapp: { jid }
  } as import("../orchestrator/types.js").TaskExecuteOptions).catch(err => {
    void safeSend(jid, `❌ *Erro ao repetir:* ${err instanceof Error ? err.message : String(err)}`);
  });
};

const handleTest = async (jid: string, binding: ChatBindingRecord, arg: string): Promise<void> => {
  if (!arg) {
    await safeSend(jid, "Uso: *!test <id>* — sobe preview efemero (URL publica)");
    return;
  }
  const result = await resolveTaskByIdArg(arg, binding);
  if (!result.ok) {
    await safeSend(jid, `❌ ${result.reason}`);
    return;
  }
  const task = result.task;

  await safeSend(jid, `🚀 _Subindo preview da task \`${shortId(task._id)}\`... isso leva ~60s._`);

  const preview = await startPreview(task._id!.toString(), binding.userId);
  if (!preview.ok) {
    await safeSend(jid, `❌ ${preview.reason}`);
    return;
  }

  const expiresIn = Math.round((new Date(preview.preview.expiresAt).getTime() - Date.now()) / 60000);
  const routine = buildTestRoutine(task);
  await safeSend(
    jid,
    `🌐 *Preview pronto*\n` +
    `${preview.preview.tunnelUrl}\n\n` +
    `${routine}\n\n` +
    `⏰ expira em ${expiresIn}min\n` +
    `Use *!testend ${shortId(task._id)}* pra encerrar antes.\n\n` +
    `_⚠️ Link publico — nao compartilhe se tem dado sensivel._`
  );

  // Screenshot best-effort — manda em background pra nao bloquear retorno do handler.
  // Fluxo:
  //   1. previewNavigator (LLM) decide qual rota abrir + acoes pra mostrar a feature
  //   2. Playwright navega + executa acoes + captura
  //   3. Envia imagem com caption explicando o que foi capturado
  void (async () => {
    try {
      // Coleta arquivos mudados pra contextualizar o navigator
      const changedFiles: string[] = [];
      for (const sub of task.subtasks ?? []) {
        if (sub.type !== "github") continue;
        const r = sub.result as { changes?: { file?: string }[] } | undefined;
        for (const c of r?.changes ?? []) {
          if (typeof c.file === "string" && c.file.length > 0) changedFiles.push(c.file);
        }
      }

      // 1. Navigator decide rota + acoes
      const plan = await planNavigation(task, Array.from(new Set(changedFiles)));
      console.info(
        `[handleTest] nav plan task=${shortId(task._id)}: route=${plan.route} actions=${plan.actions.length} reason="${plan.reasoning}"`
      );

      // Nao precisa de wait aqui — captureUrl ja espera tunel responder via HEAD probe.

      // 2. Screenshot + gravacao de video navegando pra rota planejada
      //    inspectAndPlan = 2-pass: o LLM ve o DOM real antes de gerar acoes
      //    (evita selectors invented como name='num1' que nao existem).
      const dedupedFiles = Array.from(new Set(changedFiles));
      const shot = await captureUrl({
        url: preview.preview.tunnelUrl,
        route: plan.route,
        actions: plan.actions, // fallback se inspectAndPlan falhar
        viewport: { width: 1280, height: 800 },
        fullPage: false,
        recordVideo: true,
        onTunnelWait: async (elapsedMs, attempts) => {
          // Avisa usuario que ainda esta esperando DNS propagar
          await safeSend(
            jid,
            `⏳ Aguardando tunel propagar (${Math.round(elapsedMs / 1000)}s, ${attempts} tentativas)...`
          ).catch(() => {});
        },
        inspectAndPlan: async (inspection) => {
          const ap = await planActions(task, dedupedFiles, inspection);
          console.info(
            `[handleTest] planActions task=${shortId(task._id)}: ${ap.actions.length} acoes — "${ap.reasoning}"`
          );
          return ap.actions;
        }
      });
      if (!shot.ok) {
        console.warn(`[handleTest] screenshot falhou task=${shortId(task._id)}: ${shot.reason}`);
        return;
      }

      // 3. Caption da foto: rota + razao + sumario de acoes + status video
      const actionsLine = shot.actionResults.length > 0
        ? `\n🎯 Acoes: ${shot.actionResults.map(a => `${a.type}${a.ok ? "✓" : "✗"}`).join(" ")}`
        : "";
      const videoLine = shot.videoBuffer
        ? `\n🎬 Video da rotina chegando...`
        : "";
      const caption =
        `📸 *Preview — \`${shortId(task._id)}\`*\n` +
        `📍 ${plan.route}\n` +
        (plan.reasoning ? `_${plan.reasoning}_\n` : "") +
        `⏱ ${shot.durationMs}ms · ${(shot.bytes / 1024).toFixed(0)} KB` +
        actionsLine +
        videoLine;

      console.info(`[handleTest] sending image task=${shortId(task._id)} (${shot.bytes} bytes)`);
      await sendImage(jid, shot.buffer, caption);
      console.info(`[handleTest] image sent task=${shortId(task._id)}`);

      // 4. Envia video se foi gravado. WA tem limite ~16MB — pulamos se passar.
      if (shot.videoBuffer && shot.videoBytes && shot.videoBytes < 16 * 1024 * 1024) {
        const mime = shot.videoMime ?? "video/webm";
        console.info(
          `[handleTest] sending video task=${shortId(task._id)} (${shot.videoBytes} bytes, ${mime})`
        );
        try {
          await sendVideo(
            jid,
            shot.videoBuffer,
            `🎬 Rotina executada (${(shot.videoBytes / 1024).toFixed(0)} KB)`,
            mime
          );
          console.info(`[handleTest] video sent task=${shortId(task._id)}`);
        } catch (err) {
          console.warn(
            `[handleTest] sendVideo falhou task=${shortId(task._id)}:`,
            err instanceof Error ? err.message : err
          );
        }
      } else if (shot.videoBytes && shot.videoBytes >= 16 * 1024 * 1024) {
        console.warn(
          `[handleTest] video muito grande task=${shortId(task._id)}: ${shot.videoBytes} bytes — pulando envio`
        );
      } else {
        console.warn(
          `[handleTest] no video to send task=${shortId(task._id)}: videoBuffer=${!!shot.videoBuffer} videoBytes=${shot.videoBytes}`
        );
      }
    } catch (err) {
      console.warn(
        `[handleTest] screenshot exception task=${shortId(task._id)}:`,
        err instanceof Error ? err.message : err
      );
    }
  })();
};

const handleTestEnd = async (jid: string, binding: ChatBindingRecord, arg: string): Promise<void> => {
  if (!arg) {
    await safeSend(jid, "Uso: *!testend <id>*");
    return;
  }
  const result = await resolveTaskByIdArg(arg, binding);
  if (!result.ok) {
    await safeSend(jid, `❌ ${result.reason}`);
    return;
  }
  const task = result.task;
  await stopPreview(task._id!.toString());
  await safeSend(jid, `🛑 Preview da task \`${shortId(task._id)}\` encerrado.`);
};

const handleRetrySub = async (jid: string, binding: ChatBindingRecord, arg: string): Promise<void> => {
  const parts = arg.split(/\s+/);
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    await safeSend(jid, "Uso: *!retrysub <taskId> <subtaskId>*\nExemplo: !retrysub 8a3f4e21 msw-files");
    return;
  }
  const [taskArg, subId] = parts;
  const resolved = await resolveTaskByIdArg(taskArg!, binding);
  if (!resolved.ok) {
    await safeSend(jid, `❌ ${resolved.reason}`);
    return;
  }
  const task = resolved.task;

  await safeSend(jid, `🔁 _Retentando subtask \`${subId}\` da task \`${shortId(task._id)}\`..._`);

  const result = await retrySubtask(task._id!.toString(), subId!);
  if (!result.ok) {
    await safeSend(jid, `❌ ${result.reason}`);
    return;
  }

  const lines: string[] = [`✅ *Subtask retomada com sucesso*`, "", `🆔 \`${shortId(task._id)}\` · subtask \`${subId}\``];
  if (result.prUrl) {
    lines.push("");
    lines.push("🔗 PR atualizado:");
    lines.push(result.prUrl);
  }
  await safeSend(jid, lines.join("\n"));
};

const handleSetupPreview = async (jid: string, binding: ChatBindingRecord, arg: string): Promise<void> => {
  if (!arg) {
    await safeSend(jid, "Uso: *!setup-preview <id|nome>* — projeto a configurar");
    return;
  }

  // Resolve projeto (id ou nome) — mesma logica do handleSetProject
  const projectsCol = await getProjectsCollection();
  const userFilter = binding.userId ? { userId: binding.userId } : {};

  let project = ObjectId.isValid(arg)
    ? await projectsCol.findOne({ _id: new ObjectId(arg), ...userFilter })
    : null;

  if (!project) {
    project = await projectsCol.findOne({
      name: { $regex: `^${arg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
      ...userFilter
    });
  }

  if (!project) {
    await safeSend(jid, `❌ Projeto nao encontrado: \`${arg}\``);
    return;
  }

  // Permite re-execucao — usuario pode querer refazer o scaffold.
  if (project.previewBuildCmd) {
    await safeSend(jid, `🔄 *${project.name}* ja tem preview configurado — vou re-executar o setup mesmo assim.`);
  }

  const resolved = await resolveProjectOptions(project._id!.toString());
  if (!resolved?.github || resolved.github.length === 0) {
    await safeSend(jid, `❌ Projeto sem repos GitHub. Adicione um antes de configurar preview.`);
    return;
  }

  await safeSend(
    jid,
    `🪄 *Configurando MSW no ${project.name}*\n\n` +
    `Disparei task que vai abrir PR adicionando msw + script build:preview + bootstrap.\n` +
    `Quando mergeares, o preview fica pronto pra qualquer task futura desse projeto.`
  );

  // Bypassa planner — subtasks atomicas (3 commits sequenciais) pra respeitar timeout de 5min/subtask.
  void executeTask("Setup MSW pra preview deploys", {
    userId: binding.userId,
    projectId: project._id!.toString(),
    github: resolved.github,
    trello: resolved.trello,
    whatsapp: { jid },
    setupPreviewForProjectId: project._id!.toString(),
    presetSubtasks: getMswSetupSubtasks()
  } as import("../orchestrator/types.js").TaskExecuteOptions).catch(err => {
    console.error("[whatsappBot] setup-preview task error:", err);
    void safeSend(jid, `❌ Falha ao disparar task: ${err instanceof Error ? err.message : String(err)}`);
  });
};

const handleSchedule = async (jid: string, binding: ChatBindingRecord, arg: string): Promise<void> => {
  if (!arg) {
    await safeSend(jid, "Uso: *!schedule <quando> <descricao>*");
    return;
  }

  await safeSend(jid, "⏰ _Interpretando agendamento..._");

  let parsed;
  try {
    parsed = await parseSchedule(arg);
  } catch (err) {
    await safeSend(jid, `❌ Falha no parser: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (parsed.error || !parsed.cron) {
    await safeSend(jid, `❌ ${parsed.error ?? "Nao consegui entender o horario."}\n\nExemplos:\n• \`!schedule diariamente 9h ideias\`\n• \`!schedule toda terca 14h rodar smoke test\`\n• \`!schedule 0 9 * * * <descricao>\` (cron direto)`);
    return;
  }

  // Pra kind=task, exige projeto default
  let projectId: string | undefined;
  if (parsed.kind === "task") {
    if (!binding.defaultProjectId) {
      await safeSend(jid, "❌ Pra agendar uma task voce precisa de projeto default.\nUse *!project <id>* primeiro.");
      return;
    }
    projectId = binding.defaultProjectId;
  }

  const created = await createSchedule({
    userId: binding.userId,
    description: parsed.description,
    kind: parsed.kind,
    cron: parsed.cron,
    projectId,
    whatsappJid: jid
  });

  const idShort = shortId(created._id);
  const human = describeCron(created.cron);
  const next = created.nextRunAt ? new Date(created.nextRunAt).toLocaleString("pt-BR") : "?";
  const kindLabel = parsed.kind === "ideas" ? "💡 Ideias" : "🚀 Task";

  await safeSend(
    jid,
    `✅ *Agendado*\n\n` +
    `${kindLabel}: "${parsed.description}"\n` +
    `⏱ ${human}\n` +
    `📅 Proximo: ${next}\n` +
    `🆔 \`${idShort}\`\n\n` +
    `_Use *!unschedule ${idShort}* pra remover._`
  );
};

const handleListScheduled = async (jid: string, binding: ChatBindingRecord): Promise<void> => {
  const list = await listSchedules(binding.userId);
  if (list.length === 0) {
    await safeSend(jid, "📋 Nada agendado. Use *!schedule <quando> <desc>*.");
    return;
  }

  const lines: string[] = [`📋 *${list.length} agendamento${list.length > 1 ? "s" : ""}*`, ""];
  for (const s of list) {
    const idShort = shortId(s._id);
    const kindIcon = s.kind === "ideas" ? "💡" : "🚀";
    const enabled = s.enabled ? "" : " _(off)_";
    const next = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString("pt-BR") : "?";
    const lastResult = s.lastFireResult
      ? ` · ultimo: ${s.lastFireResult === "ok" ? "✅" : "❌"}`
      : "";
    lines.push(`${kindIcon} *${s.description}*${enabled}`);
    lines.push(`   🆔 \`${idShort}\` · ${describeCron(s.cron)}`);
    lines.push(`   📅 ${next}${lastResult}`);
    lines.push("");
  }
  lines.push("_Remover: *!unschedule <id>*_");
  await safeSend(jid, lines.join("\n").trim());
};

const handleUnschedule = async (jid: string, binding: ChatBindingRecord, arg: string): Promise<void> => {
  if (!arg) {
    await safeSend(jid, "Uso: *!unschedule <id>*");
    return;
  }
  const result = await removeScheduleByIdOrSuffix(arg, binding.userId);
  if (!result.ok) {
    await safeSend(jid, `❌ ${result.reason}`);
    return;
  }
  await safeSend(jid, `🗑 Removido: "${result.removed.description}"`);
};

const handleIdeas = async (jid: string, binding: ChatBindingRecord): Promise<void> => {
  await safeSend(jid, "💡 _Analisando sinais... pode levar uns segundos._");

  let result;
  try {
    result = await generateIdeas(binding.userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await safeSend(jid, `❌ Erro ao gerar ideias: ${msg}`);
    return;
  }

  if (!result.ideas || result.ideas.length === 0) {
    await safeSend(jid, "💡 Nada relevante pra sugerir agora. Continue usando — ideias acordam quando houver sinal real (tasks recorrentes, falhas em padrao, PRs parados, etc).");
    return;
  }

  const categoryLabel: Record<string, string> = {
    "task-flaky": "🔥 Task instavel",
    "recurring-pattern": "🔁 Padrao recorrente",
    "stale-config": "⚙️ Config incompleta",
    "missing-automation": "🤖 Automacao faltando",
    "stuck-pr": "📦 PR parado",
    "inactive-project": "💤 Projeto inativo",
    "performance": "⏱ Performance",
    "other": "💡 Outra"
  };
  const effortIcon: Record<string, string> = {
    small: "🟢", medium: "🟡", large: "🔴"
  };

  const lines: string[] = [`💡 *${result.ideas.length} ideia${result.ideas.length > 1 ? "s" : ""}*`, ""];
  for (let i = 0; i < result.ideas.length; i++) {
    const idea = result.ideas[i]!;
    const cat = categoryLabel[idea.category] ?? "💡";
    const eff = effortIcon[idea.effort] ?? "•";
    lines.push(`*${i + 1}. ${cat}* ${eff} _(${idea.effort})_`);
    lines.push(`📊 ${idea.signal}`);
    lines.push(`👉 ${idea.suggestion}`);
    lines.push("");
  }
  lines.push("_Quer transformar uma ideia em task? Use *!task <descricao baseada na sugestao>*._");

  await safeSend(jid, lines.join("\n").trim());
};

const handlePrs = async (jid: string, binding: ChatBindingRecord): Promise<void> => {
  const tasksCol = await getTasksCollection();
  const filter: Record<string, unknown> = {
    githubPrUrls: { $exists: true, $not: { $size: 0 } }
  };
  if (binding.userId) filter.userId = binding.userId;

  const tasks = await tasksCol.find(filter).sort({ completedAt: -1, createdAt: -1 }).limit(10).toArray();
  if (tasks.length === 0) {
    await safeSend(jid, "🔗 Nenhum PR aberto pelo bot ainda.");
    return;
  }

  const lines: string[] = [`🔗 *PRs recentes (${tasks.length})*`, ""];
  for (const t of tasks) {
    const desc = t.description.split(/\r?\n/)[0]!.slice(0, 60);
    const icon = t.status === "completed" ? "✅" : t.status === "failed" ? "❌" : "🔄";
    lines.push(`${icon} \`${shortId(t._id)}\` "${desc}"`);
    for (const url of t.githubPrUrls) lines.push(`   ${url}`);
    lines.push("");
  }
  await safeSend(jid, lines.join("\n").trim());
};

// ── Helpers ───────────────────────────────────────────────────────

/** Send que nao throwa — bot nao deve crashar por falha de envio. */
const safeSend = async (jid: string, text: string): Promise<void> => {
  try {
    if (!isConnected()) {
      console.warn("[whatsappBot] cannot send, socket not connected");
      return;
    }
    await sendText(jid, text);
  } catch (err) {
    console.warn("[whatsappBot] safeSend failed:", err);
  }
};

export { safeSend as sendBotMessage };
