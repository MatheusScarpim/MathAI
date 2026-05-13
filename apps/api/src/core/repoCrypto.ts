import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

/**
 * Criptografia de tokens GitHub armazenados em github_repos.
 * Reusa o mesmo padrao de appConfig.ts: AES-256-CBC + scrypt(CONFIG_SECRET, CONFIG_SALT).
 * IV gerado por registro (nao reaproveitado entre repos).
 */

const ALGORITHM = "aes-256-cbc";

const getEncryptionKey = (): Buffer => {
  const secret = process.env.CONFIG_SECRET;
  if (!secret) {
    throw new Error("[FATAL] Variavel de ambiente obrigatoria nao definida: CONFIG_SECRET");
  }
  const salt = process.env.CONFIG_SALT ?? "auraia-salt";
  return scryptSync(secret, salt, 32);
};

let _encryptionKey: Buffer | null = null;
const ENCRYPTION_KEY = (): Buffer => {
  if (!_encryptionKey) _encryptionKey = getEncryptionKey();
  return _encryptionKey;
};

export const encryptToken = (plain: string): { encrypted: string; iv: string } => {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, ENCRYPTION_KEY(), iv);
  let encrypted = cipher.update(plain, "utf8", "hex");
  encrypted += cipher.final("hex");
  return { encrypted, iv: iv.toString("hex") };
};

export const decryptToken = (encrypted: string, ivHex: string): string => {
  const iv = Buffer.from(ivHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, ENCRYPTION_KEY(), iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
};
