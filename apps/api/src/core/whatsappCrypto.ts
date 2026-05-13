import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

/**
 * Criptografia dedicada do auth state do WhatsApp (Baileys).
 * Usa a mesma key derivation do repoCrypto mas com salt distinto pra
 * separar blast radius — se uma key vazar, a outra continua segura.
 */

const ALGORITHM = "aes-256-cbc";
const SALT_SUFFIX = "whatsapp";

const deriveKey = (): Buffer => {
  const secret = process.env.CONFIG_SECRET;
  if (!secret) {
    throw new Error("[FATAL] Variavel de ambiente obrigatoria nao definida: CONFIG_SECRET");
  }
  const baseSalt = process.env.CONFIG_SALT ?? "auraia-salt";
  return scryptSync(secret, `${baseSalt}-${SALT_SUFFIX}`, 32);
};

let _key: Buffer | null = null;
const KEY = (): Buffer => {
  if (!_key) _key = deriveKey();
  return _key;
};

export type EncryptedBlob = { encrypted: Buffer; iv: string };

/**
 * Normaliza qualquer entrada bytes-like pra Buffer.
 * O driver do Mongo retorna Binary (wrapper) em vez de Buffer puro;
 * Node crypto rejeita Binary, entao precisamos extrair o conteudo cru.
 */
const toBuffer = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  // Mongo BSON Binary: tem .buffer (Buffer) e/ou .value() / .read()
  if (value && typeof value === "object") {
    const v = value as { buffer?: unknown; value?: () => unknown; read?: (start: number, length: number) => unknown; sub_type?: number };
    if (Buffer.isBuffer(v.buffer)) return v.buffer;
    if (v.buffer instanceof Uint8Array) return Buffer.from(v.buffer);
    if (typeof v.value === "function") {
      const result = v.value();
      if (Buffer.isBuffer(result)) return result;
      if (result instanceof Uint8Array) return Buffer.from(result);
      if (typeof result === "string") return Buffer.from(result, "binary");
    }
  }
  throw new TypeError(`Cannot coerce to Buffer: ${typeof value}`);
};

export const encryptBuffer = (plain: Buffer | string): EncryptedBlob => {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, KEY(), iv);
  const buf = typeof plain === "string" ? Buffer.from(plain, "utf8") : plain;
  const encrypted = Buffer.concat([cipher.update(buf), cipher.final()]);
  return { encrypted, iv: iv.toString("hex") };
};

export const decryptBuffer = (encrypted: Buffer | unknown, ivHex: string): Buffer => {
  const buf = toBuffer(encrypted);
  const iv = Buffer.from(ivHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, KEY(), iv);
  return Buffer.concat([decipher.update(buf), decipher.final()]);
};
