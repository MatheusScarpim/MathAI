import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSeed, SeedError, type DomainSeed } from "./seed.js";

/**
 * Seeds de exemplo que acompanham o repositorio. Sao DADOS, nao codigo: nada
 * aqui e importado pelo motor: quem quiser um deles instala por
 * `PUT /api/schema/seed`.
 */
export const SEEDS_DIR = fileURLToPath(new URL("../../seeds/", import.meta.url));

export const loadBundledSeed = (name: string): DomainSeed =>
  loadSeedFile(join(SEEDS_DIR, `${name}.json`));

/**
 * Le um seed de disco.
 *
 * Modulo separado de `seedStore.ts` de proposito, pelo mesmo motivo que
 * `dictionaryOps.ts` e separado de `dictionary.ts`: aquele importa
 * `core/config`, que encerra o processo se `JWT_SECRET` nao existir. Carregar
 * um arquivo de vocabulario nao pode exigir ambiente montado — nem no teste,
 * nem num script de instalacao.
 */
export const loadSeedFile = (path: string): DomainSeed => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new SeedError(`nao consegui ler ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // JSON quebrado tem que dizer QUAL arquivo — um seed costuma ser editado
    // a mao e a mensagem crua do parser nao diz de onde veio.
    throw new SeedError(`${path} nao e JSON valido: ${(err as Error).message}`);
  }

  return parseSeed(parsed);
};
