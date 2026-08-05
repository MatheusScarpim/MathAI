import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ResultColumnMeta } from "@auraia/shared";
import { resolveColumnFormats, resolveColumnFormatsFromNames } from "../schema/columnFormat.js";

/**
 * A mascara de coluna e derivada duas vezes para a mesma pergunta: uma na
 * resposta fresca, outra quando a resposta volta do Redis — porque a entrada
 * pode ter sido gravada por uma versao anterior da derivacao e a chave de cache
 * nao tem carimbo de versao.
 *
 * As duas derivacoes precisam dar o mesmo resultado, e nao davam. O caminho
 * fresco passa o `columnsMeta` do driver; o caminho de cache so tinha os nomes
 * das colunas, porque `columnsMeta` nao fazia parte do payload guardado. Sem o
 * `scale`, uma coluna de peso caia do `decimal` de 3 casas para o default de 2:
 * a mesma pergunta mostrava `11.956.172,458` na primeira vez e `11.956.172,46`
 * dentro dos 900s de TTL — e a versao rebaixada era a que ia para o history.
 *
 * Os testes de `columnFormat.test.ts` nao alcancam isto: cada derivacao,
 * isolada, esta certa. O defeito e a diferenca ENTRE elas, que so aparece
 * quando o payload de cache atravessa o JSON e volta.
 */

const pipelineDir = dirname(fileURLToPath(import.meta.url));

/** As colunas reais da tela que motivou a correcao. */
const COLUMNS_META: ResultColumnMeta[] = [
  { name: "PesoLiquidoProduzidoKg", type: "numeric", scale: 6 },
  { name: "CaixasProduzidas", type: "numeric", scale: 6 },
  { name: "PacotesProduzidos", type: "numeric", scale: 6 }
];

const ROWS = [
  { PesoLiquidoProduzidoKg: 11956172.458, CaixasProduzidas: 585293, PacotesProduzidos: 3787485 },
  { PesoLiquidoProduzidoKg: 2130.5, CaixasProduzidas: 12, PacotesProduzidos: 90 }
];

/** O que `setCachedValue` grava, depois de passar por `JSON.stringify`. */
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("mascara do hit de cache bate com a da resposta fresca", () => {
  it("o `scale` sobrevive ao round-trip do payload", () => {
    const fresh = resolveColumnFormats(COLUMNS_META, { samples: ROWS });

    const cached = roundTrip({ columns: COLUMNS_META.map((c) => c.name), rows: ROWS, columnsMeta: COLUMNS_META });
    const onHit = resolveColumnFormats(cached.columnsMeta, { samples: cached.rows });

    assert.deepEqual(onHit, fresh);
    assert.deepEqual(fresh.PesoLiquidoProduzidoKg, { kind: "decimal", decimals: 3 });
  });

  it("sem o meta a coluna perde uma casa — e a regressao que o campo evita", () => {
    // Documenta o custo exato de nao carregar o meta. Se um dia a derivacao por
    // nomes passar a acertar as 3 casas sozinha, este teste avisa e o campo
    // extra no payload pode ser reavaliado.
    const byNames = resolveColumnFormatsFromNames(COLUMNS_META.map((c) => c.name), { samples: ROWS });

    assert.deepEqual(byNames.PesoLiquidoProduzidoKg, { kind: "decimal", decimals: 2 });
  });

  it("entrada antiga, sem `columnsMeta`, ainda deriva pelos nomes", () => {
    const legacy = roundTrip({ columns: COLUMNS_META.map((c) => c.name), rows: ROWS }) as {
      columns: string[];
      rows: Record<string, unknown>[];
      columnsMeta?: ResultColumnMeta[];
    };

    const onHit = legacy.columnsMeta?.length
      ? resolveColumnFormats(legacy.columnsMeta, { samples: legacy.rows })
      : resolveColumnFormatsFromNames(legacy.columns, { samples: legacy.rows });

    // A contagem continua certa mesmo sem o meta: quem a corrige e o dado, nao
    // o tipo declarado.
    assert.deepEqual(onHit.CaixasProduzidas, { kind: "integer", decimals: 0 });
  });

  it("contagem sai inteira nos dois caminhos", () => {
    const fresh = resolveColumnFormats(COLUMNS_META, { samples: ROWS });
    for (const name of ["CaixasProduzidas", "PacotesProduzidos"]) {
      assert.deepEqual(fresh[name], { kind: "integer", decimals: 0 }, name);
    }
  });
});

/**
 * A parte estrutural. O teste acima prova que a derivacao acerta QUANDO recebe
 * o meta; nada nele garante que os call-sites o passem — e foi exatamente um
 * call-site esquecido que produziu o defeito. Sao tres pontos de escrita no
 * `ask.ts` e um de leitura, e um esquecido volta a divergir em silencio.
 */
describe("ask.ts carrega o columnsMeta no payload de cache", () => {
  const source = readFileSync(join(pipelineDir, "ask.ts"), "utf8");

  it("todo setCachedValue grava o meta junto", () => {
    const calls = [...source.matchAll(/setCachedValue\(cacheKey,\s*([^)]*)\)/g)].map((m) => m[1] ?? "");

    assert.ok(calls.length >= 3, `so ${calls.length} chamadas de setCachedValue encontradas`);
    for (const args of calls) {
      assert.ok(args.includes("columnsMeta"), `setCachedValue(cacheKey, ${args}) nao grava columnsMeta`);
    }
  });

  it("o hit de cache repassa o meta para a derivacao", () => {
    assert.match(
      source,
      /resolveColumnFormatsForEnvironment\([^)]*cachedMeta\s*\)/,
      "o hit de cache chama a derivacao sem o meta recuperado"
    );
  });

  it("o meta nao vaza na resposta devolvida ao cliente", () => {
    // `...cached` arrastaria o campo para o payload do SSE e do HTTP.
    assert.ok(
      source.includes("const { columnsMeta: cachedMeta, ...cachedResponse } = cached"),
      "o payload do hit nao e desestruturado — columnsMeta vaza para a resposta"
    );
    assert.ok(
      !/data:\s*\{\s*\n\s*(\/\/[^\n]*\n\s*)*\.\.\.cached,/.test(source),
      "a resposta ainda espalha `...cached` cru em vez de `...cachedResponse`"
    );
  });
});
