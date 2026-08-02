import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyError, isRetriableError } from "./sqlErrors.js";

/**
 * Regression suite for the incident where a live Oracle outage
 * (ORA-12170, TCP connect timeout) was classified as a *query* timeout.
 *
 * Two things went wrong as a result:
 *  1. the pipeline burned three full connect timeouts plus reflection tokens
 *     rewriting a SQL statement that was never the problem, and
 *  2. the user was told to "reformular a pergunta" for an outage they could
 *     not possibly fix by rephrasing.
 */
describe("classifyError — falhas de conexao nao sao timeout de query", () => {
  const connectionErrors: Array<[string, string]> = [
    [
      "ORA-12170 (connect timeout)",
      "ORA-12170: Cannot connect. TCP connect timeout of 20s for host 137.131.136.78 port 1521."
    ],
    ["ORA-12541 (no listener)", "ORA-12541: TNS:no listener"],
    ["ORA-12514 (service unknown)", "ORA-12514: TNS:listener does not currently know of service"],
    ["ORA-01034 (instance down)", "ORA-01034: ORACLE not available"],
    ["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432"],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND auraia-testdb"],
    ["EHOSTUNREACH", "connect EHOSTUNREACH 10.0.0.5:1521"],
    ["SQL Server network error", "A network-related or instance-specific error occurred"]
  ];

  for (const [label, message] of connectionErrors) {
    it(`classifica ${label} como connection_error`, () => {
      assert.equal(classifyError(message, false).category, "connection_error");
    });
  }

  it("nao confunde um timeout real de query com falha de conexao", () => {
    assert.equal(
      classifyError("Query timeout expired after 30000ms", false).category,
      "timeout"
    );
  });

  it("da uma dica que aponta para infraestrutura, nao para o SQL", () => {
    const hint = classifyError("ORA-12170: Cannot connect.", false).hint.toLowerCase();
    assert.ok(
      hint.includes("conectar") || hint.includes("conexao"),
      `hint deveria falar de conexao, veio: ${hint}`
    );
    assert.ok(
      !hint.includes("simplifique"),
      "hint nao deve mandar simplificar a query numa falha de conexao"
    );
  });
});

describe("isRetriableError — o loop de retry nao insiste em banco fora do ar", () => {
  it("nao retenta connection_error", () => {
    assert.equal(isRetriableError("connection_error"), false);
  });

  it("retenta erros que uma reescrita de SQL pode corrigir", () => {
    for (const category of [
      "syntax_error",
      "table_not_found",
      "column_not_found",
      "type_mismatch",
      "timeout",
      "unknown"
    ] as const) {
      assert.equal(isRetriableError(category), true, `${category} deveria ser retentavel`);
    }
  });
});
