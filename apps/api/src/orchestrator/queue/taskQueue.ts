/**
 * Task concurrency semaphore — plan #7.
 *
 * Limita quantas tasks rodam em paralelo. Gate fica DENTRO de executeTask
 * (acquireSlot no inicio, releaseSlot no finally), entao todos os call
 * sites (rotas, bot, scheduler) sao cobertos automaticamente sem mudar API.
 *
 * Estado in-memory. Reboot perde a fila; tasks em Mongo viram orphan
 * candidate (orphan watchdog #6 cuida).
 *
 * Prioridade: high pula a fila. Default normal.
 */

import { randomUUID } from "node:crypto";

export type QueuePriority = "low" | "normal" | "high";

type Slot = {
  /** ID estavel pra inspecao (queue snapshot). */
  id: string;
  /** TaskId (ObjectId string) se setado pelo caller. */
  taskId?: string;
  /** Provider deduced from planner route — gate por-provider (G2). Pode ser
   * setado depois via setSlotProvider quando o caller ainda nao sabe. */
  provider?: string;
  description: string;
  priority: QueuePriority;
  enqueuedAt: Date;
  startedAt?: Date;
  status: "pending" | "running";
  /** Resolver chamado quando o slot fica disponivel. */
  resolve: () => void;
};

// ============== CONFIG ==============

const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS ?? 3);

/**
 * G2 — per-provider semaphore. Cada provider tem cap proprio; sem cap setado
 * cai no fallback global. Lidos do env (defaults conservadores baseados em
 * rate-limits tipicos: Anthropic mais restrito, DeepSeek mais generoso).
 */
const providerCaps: Record<string, number> = {
  anthropic: Number(process.env.MAX_CONCURRENT_ANTHROPIC ?? 2),
  deepseek: Number(process.env.MAX_CONCURRENT_DEEPSEEK ?? 3),
  codex: Number(process.env.MAX_CONCURRENT_CODEX ?? 1)
};

const capForProvider = (p?: string): number => {
  if (!p) return MAX_CONCURRENT_TASKS;
  const v = providerCaps[p.toLowerCase()];
  return v && v > 0 ? v : MAX_CONCURRENT_TASKS;
};

// ============== STATE ==============

const slots: Slot[] = [];
let running = 0;
const runningByProvider: Map<string, number> = new Map();

const incProvider = (p?: string): void => {
  if (!p) return;
  runningByProvider.set(p, (runningByProvider.get(p) ?? 0) + 1);
};
const decProvider = (p?: string): void => {
  if (!p) return;
  const cur = runningByProvider.get(p) ?? 0;
  if (cur <= 1) runningByProvider.delete(p);
  else runningByProvider.set(p, cur - 1);
  // Acorda 1 waiter desse provider (se houver) na proxima tick.
  setImmediate(() => wakeProviderWaiter(p));
};

// ============== PROVIDER WAITERS (G2 fix) ==============
// Fila de waiters por-provider. Cada waiter eh uma funcao que re-checa se
// o cap permite avancar; se sim, conta e resolve; se nao, re-enfileira.
const providerWaiters: Map<string, Array<() => void>> = new Map();

const enqueueProviderWaiter = (provider: string, fn: () => void): void => {
  const arr = providerWaiters.get(provider) ?? [];
  arr.push(fn);
  providerWaiters.set(provider, arr);
};

const wakeProviderWaiter = (provider: string): void => {
  const arr = providerWaiters.get(provider);
  if (!arr || arr.length === 0) return;
  const fn = arr.shift()!;
  if (arr.length === 0) providerWaiters.delete(provider);
  fn();
};

const priorityWeight = (p: QueuePriority): number =>
  p === "high" ? 0 : p === "normal" ? 1 : 2;

const sortPending = (): void => {
  slots.sort((a, b) => {
    // Running primeiro (nao mexer), depois pending ordenado por prioridade+FIFO.
    if (a.status === "running" && b.status === "pending") return -1;
    if (a.status === "pending" && b.status === "running") return 1;
    const pa = priorityWeight(a.priority);
    const pb = priorityWeight(b.priority);
    if (pa !== pb) return pa - pb;
    return a.enqueuedAt.getTime() - b.enqueuedAt.getTime();
  });
};

const canRunSlot = (s: Slot): boolean => {
  if (s.provider) {
    const cap = capForProvider(s.provider);
    const cur = runningByProvider.get(s.provider) ?? 0;
    if (cur >= cap) return false;
  }
  return true;
};

const drain = (): void => {
  while (running < MAX_CONCURRENT_TASKS) {
    sortPending();
    // Procura primeiro pending que cabe (global ja garantido + per-provider).
    const next = slots.find(s => s.status === "pending" && canRunSlot(s));
    if (!next) break;
    next.status = "running";
    next.startedAt = new Date();
    running++;
    incProvider(next.provider);
    const provInfo = next.provider ? ` provider=${next.provider}(${runningByProvider.get(next.provider)}/${capForProvider(next.provider)})` : "";
    console.info(`[queue] dispatch id=${next.id} pri=${next.priority}${provInfo} running=${running}/${MAX_CONCURRENT_TASKS}`);
    next.resolve();
  }
};

// ============== PUBLIC API ==============

/**
 * Aguarda um slot livre. Retorna handle pra release. Idempotente — release
 * pode ser chamado mais de uma vez sem efeito colateral.
 *
 * Use no comeco de executeTask:
 *   const slot = await acquireSlot({ description, priority, taskId });
 *   try { ... } finally { slot.release(); }
 */
export const acquireSlot = async (params: {
  description: string;
  priority?: QueuePriority;
  taskId?: string;
  /** G2 — quando conhecido na hora do acquire (raro; geralmente vem depois). */
  provider?: string;
}): Promise<{ release: () => void; queueId: string }> => {
  const id = randomUUID().slice(0, 8);
  const priority = params.priority ?? "normal";
  return new Promise<{ release: () => void; queueId: string }>(resolve => {
    const slot: Slot = {
      id,
      taskId: params.taskId,
      provider: params.provider,
      description: params.description,
      priority,
      enqueuedAt: new Date(),
      status: "pending",
      resolve: () => {
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          running = Math.max(0, running - 1);
          decProvider(slot.provider);
          const idx = slots.indexOf(slot);
          if (idx >= 0) slots.splice(idx, 1);
          console.info(`[queue] release id=${id} running=${running}/${MAX_CONCURRENT_TASKS}`);
          setImmediate(() => drain());
        };
        resolve({ release, queueId: id });
      }
    };
    slots.push(slot);
    const pending = slots.filter(s => s.status === "pending").length;
    console.info(`[queue] enqueue id=${id} pri=${priority} pending=${pending} running=${running}/${MAX_CONCURRENT_TASKS}`);
    drain();
  });
};

/** Atualiza taskId de um slot ja running (caso o caller so o descubra depois). */
export const setSlotTaskId = (queueId: string, taskId: string): void => {
  const s = slots.find(x => x.id === queueId);
  if (s) s.taskId = taskId;
};

/**
 * G2 (sincrono, best-effort) — atualiza o campo provider de um slot sem gate.
 * Mantido pra compatibilidade com call-sites que so querem rotular pra
 * telemetria. NAO bloqueia se o cap foi excedido — para essa semantica use
 * `awaitProviderSlot`.
 */
export const setSlotProvider = (queueId: string, provider: string): void => {
  const s = slots.find(x => x.id === queueId);
  if (!s) return;
  if (s.provider === provider) return;
  if (s.status === "running") {
    decProvider(s.provider);
    s.provider = provider;
    incProvider(s.provider);
  } else {
    s.provider = provider;
  }
};

/**
 * G2 fix — atribui provider a um slot ja running E bloqueia se o cap do
 * provider foi excedido. Caso de uso: pipeline acquireSlot() antes do
 * planner (provider desconhecido); apos planner retornar a rota, chamar
 * `await awaitProviderSlot(queueId, provider)` antes de despachar code
 * agents. Se 2 tasks anthropic ja rodando (cap=2), a 3a fica em waitpoint
 * ate uma das outras dar release.
 *
 * Idempotente: chamar com mesmo provider novamente resolve imediato.
 * Race-safe: usa fila FIFO `providerWaiters[provider]`, drainada por
 * `decProvider` no release.
 */
export const awaitProviderSlot = (queueId: string, provider: string): Promise<void> => {
  const s = slots.find(x => x.id === queueId);
  if (!s) return Promise.resolve();
  if (s.provider === provider) return Promise.resolve(); // ja conta — idempotente
  // Se slot ja tinha outro provider rotulado (raro), tira do counter primeiro
  // pra nao vazar contagem velha.
  const oldProvider = s.provider;
  if (oldProvider && oldProvider !== provider) {
    decProvider(oldProvider);
    s.provider = undefined;
  }

  return new Promise<void>(resolve => {
    const tryAcquire = (): void => {
      const cap = capForProvider(provider);
      const cur = runningByProvider.get(provider) ?? 0;
      if (cur < cap) {
        s.provider = provider;
        incProvider(provider);
        const totalRunningProv = runningByProvider.get(provider);
        console.info(`[queue] provider-slot granted id=${s.id} provider=${provider}(${totalRunningProv}/${cap})`);
        resolve();
      } else {
        // Cap atingido — re-enfileira waiter pra ser acordado por release.
        console.info(`[queue] provider-slot wait id=${s.id} provider=${provider}(${cur}/${cap}, queue=${(providerWaiters.get(provider)?.length ?? 0) + 1})`);
        enqueueProviderWaiter(provider, tryAcquire);
      }
    };
    tryAcquire();
  });
};

export const queueSnapshot = (): {
  running: number;
  capacity: number;
  pending: number;
  byProvider: Record<string, { running: number; cap: number }>;
  items: Array<{
    id: string;
    taskId?: string;
    provider?: string;
    description: string;
    priority: QueuePriority;
    status: Slot["status"];
    enqueuedAt: Date;
    startedAt?: Date;
    waitMs?: number;
  }>;
} => {
  sortPending();
  const byProvider: Record<string, { running: number; cap: number }> = {};
  for (const [p, run] of runningByProvider.entries()) {
    byProvider[p] = { running: run, cap: capForProvider(p) };
  }
  // Expor providers conhecidos mesmo sem rodar nenhum no momento
  for (const p of Object.keys(providerCaps)) {
    if (!byProvider[p]) byProvider[p] = { running: 0, cap: capForProvider(p) };
  }
  return {
    running,
    capacity: MAX_CONCURRENT_TASKS,
    pending: slots.filter(s => s.status === "pending").length,
    byProvider,
    items: slots.map(s => ({
      id: s.id,
      taskId: s.taskId,
      provider: s.provider,
      description: s.description.slice(0, 200),
      priority: s.priority,
      status: s.status,
      enqueuedAt: s.enqueuedAt,
      startedAt: s.startedAt,
      waitMs: s.startedAt
        ? s.startedAt.getTime() - s.enqueuedAt.getTime()
        : Date.now() - s.enqueuedAt.getTime()
    }))
  };
};

/** Cancela slot pendente (running nao cancelavel aqui). */
export const cancelQueueItem = (id: string): boolean => {
  const idx = slots.findIndex(s => s.id === id && s.status === "pending");
  if (idx < 0) return false;
  const s = slots[idx]!;
  slots.splice(idx, 1);
  // Nao chama resolve — efetivamente "stuck pending" da perspectiva do caller.
  // O caller deve ter um timeout proprio. Para v1 isto eh ok pois cancellation
  // de pending eh raro.
  void s;
  return true;
};
