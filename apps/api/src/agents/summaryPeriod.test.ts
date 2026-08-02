import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractYearsFromSql,
  buildPeriodInstruction,
  findSummaryYearMismatch
} from "./summaryPeriod.js";

/**
 * The compact-literal cases are the ones that used to return [] and silence the
 * period guard: `'20170101'` has no word boundary before `0101`, so the plain
 * \b20\d{2}\b pattern skipped it entirely.
 */
describe("extractYearsFromSql", () => {
  it("le anos em literais compactos entre aspas", () => {
    assert.deepEqual(
      extractYearsFromSql("SELECT 1 FROM t WHERE d >= '20170101' AND d < '20260101'"),
      [2017, 2026]
    );
  });

  it("le literais compactos sem aspas", () => {
    assert.deepEqual(extractYearsFromSql("WHERE DataKey >= 20230101"), [2023]);
  });

  it("le BETWEEN com literais compactos", () => {
    assert.deepEqual(
      extractYearsFromSql("WHERE d BETWEEN '20170101' AND '20251231'"),
      [2017, 2025]
    );
  });

  it("continua lendo anos soltos", () => {
    assert.deepEqual(extractYearsFromSql("WHERE YEAR(d) IN (2023, 2024)"), [2023, 2024]);
  });

  it("mistura literal compacto e ano solto sem duplicar", () => {
    assert.deepEqual(
      extractYearsFromSql("WHERE d >= '20240101' AND DATEPART(YEAR, d) = 2024"),
      [2024]
    );
  });

  it("retorna vazio sem nenhuma data", () => {
    assert.deepEqual(extractYearsFromSql("SELECT COUNT(*) FROM dbo.Fat"), []);
  });
});

describe("buildPeriodInstruction — ano unico", () => {
  it("proibe outros anos", () => {
    const instruction = buildPeriodInstruction([2024], "pt");
    assert.match(instruction, /apenas 2024/);
    assert.doesNotMatch(instruction, /intervalo/);
  });
});

describe("buildPeriodInstruction — comparacao", () => {
  it("mantem o texto de comparacao para dois anos nao contiguos", () => {
    const instruction = buildPeriodInstruction([2017, 2025], "pt");
    assert.match(instruction, /compara estes periodos/);
  });

  it("mantem comparacao para dois anos vizinhos", () => {
    const instruction = buildPeriodInstruction([2023, 2024], "pt");
    assert.match(instruction, /compara estes periodos/);
  });
});

/**
 * The interval branch is the fix for the logged summary "A consulta compara
 * estes periodos: 2017 e 2025", which faithfully described a SQL that had
 * already lost 2018-2024.
 */
describe("buildPeriodInstruction — intervalo continuo", () => {
  it("usa o range explicito mesmo quando o SQL expoe o limite exclusivo", () => {
    const instruction = buildPeriodInstruction([2017, 2026], "pt", {
      startYear: 2017,
      endYear: 2025
    });
    assert.match(instruction, /intervalo continuo de 2017 a 2025/);
    assert.doesNotMatch(instruction, /2026/);
    assert.doesNotMatch(instruction, /compara estes periodos/);
  });

  it("infere o intervalo de uma corrida contigua no SQL", () => {
    const instruction = buildPeriodInstruction([2022, 2023, 2024], "pt");
    assert.match(instruction, /intervalo continuo de 2022 a 2024/);
  });

  it("usa o range mesmo sem nenhum ano no SQL", () => {
    const instruction = buildPeriodInstruction([], "pt", { startYear: 2017, endYear: 2025 });
    assert.match(instruction, /intervalo continuo de 2017 a 2025/);
  });

  it("renderiza en e es", () => {
    const range = { startYear: 2017, endYear: 2025 };
    assert.match(buildPeriodInstruction([], "en", range), /continuous interval 2017 to 2025/);
    assert.match(buildPeriodInstruction([], "es", range), /intervalo continuo 2017 a 2025/);
  });

  it("retorna vazio sem anos e sem range", () => {
    assert.equal(buildPeriodInstruction([], "pt"), "");
  });
});

describe("findSummaryYearMismatch", () => {
  it("acusa ano citado que o SQL nao filtrou", () => {
    assert.deepEqual(findSummaryYearMismatch("cresceu em 2022", [2023, 2024]), [2022]);
  });

  it("nao acusa nada quando consistente", () => {
    assert.deepEqual(findSummaryYearMismatch("de 2023 para 2024", [2023, 2024]), []);
  });
});
