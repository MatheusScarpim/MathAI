/**
 * Rate limiter conservador pra WhatsApp.
 *
 * Anti-ban: nunca enviar duas mensagens pro mesmo chat em janela < perChatGapMs.
 * Tambem aplica gap global pra evitar burst de "muitos chats em paralelo".
 * Jitter aleatorio (+/-20%) faz parecer humano.
 */

type Resolver = () => void;

export type RateLimiterOptions = {
  perChatGapMs?: number;     // default 2500
  globalGapMs?: number;      // default 800
  jitterRatio?: number;      // default 0.2 (20%)
};

export class WhatsappRateLimiter {
  private perChatGapMs: number;
  private globalGapMs: number;
  private jitterRatio: number;

  private lastSentByChat = new Map<string, number>();
  private lastSentGlobal = 0;

  /** Fila por chat — preserva ordem de envio. Map<jid, Promise>. */
  private chains = new Map<string, Promise<void>>();
  private globalChain: Promise<void> = Promise.resolve();

  constructor(opts: RateLimiterOptions = {}) {
    this.perChatGapMs = opts.perChatGapMs ?? 2500;
    this.globalGapMs = opts.globalGapMs ?? 800;
    this.jitterRatio = opts.jitterRatio ?? 0.2;
  }

  /** Atualiza config em runtime (lido das settings). */
  setPerChatGap(ms: number): void {
    this.perChatGapMs = Math.max(0, ms);
  }

  /**
   * Aguarda o slot ficar livre pro chat. Encadeia com mensagens previas
   * pro mesmo jid — garante ordem.
   */
  async wait(jid: string): Promise<void> {
    // Encadeia na fila do chat
    const prev = this.chains.get(jid) ?? Promise.resolve();
    let release: Resolver = () => {};
    const next = new Promise<void>(r => { release = r; });
    this.chains.set(jid, prev.then(() => next));

    await prev;

    // Calcula delay necessario por chat
    const now = Date.now();
    const lastChat = this.lastSentByChat.get(jid) ?? 0;
    const elapsedChat = now - lastChat;
    const chatDelay = Math.max(0, this.perChatGapMs - elapsedChat);

    // Calcula delay global
    const elapsedGlobal = now - this.lastSentGlobal;
    const globalDelay = Math.max(0, this.globalGapMs - elapsedGlobal);

    const baseDelay = Math.max(chatDelay, globalDelay);
    const jittered = baseDelay * (1 + (Math.random() * 2 - 1) * this.jitterRatio);
    const finalDelay = Math.max(0, Math.round(jittered));

    if (finalDelay > 0) {
      await new Promise<void>(r => setTimeout(r, finalDelay));
    }

    // Marca timestamps. release() solta o proximo.
    this.lastSentByChat.set(jid, Date.now());
    this.lastSentGlobal = Date.now();

    // Limpa fila quando esvazia
    setTimeout(() => {
      release();
      if (this.chains.get(jid) === prev.then(() => next)) {
        // se ninguem encadeou depois, remove pra evitar memory leak
        this.chains.delete(jid);
      }
    }, 0);
  }

  /** Limpa estado (uso em logout/reset). */
  reset(): void {
    this.lastSentByChat.clear();
    this.lastSentGlobal = 0;
    this.chains.clear();
  }
}

/** Singleton global usado pelo wrapper Baileys. */
export const whatsappLimiter = new WhatsappRateLimiter();
