import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseYearRange,
  expandYears,
  formatYearRange,
  isContiguousYearRun,
  findPeriodInText,
  formatPeriodText
} from "./period.js";

/**
 * Regression suite for the "de 2017 a 2025" bug: the pipeline read only the
 * first year in the question and the planner split the interval into its two
 * endpoints, so 2018-2024 never reached the SQL.
 */
describe("parseYearRange — intervalos continuos", () => {
  const positives: Array<[string, number, number]> = [
    ["e de 2017 a 2025", 2017, 2025],
    ["faturamento de 2017 a 2025", 2017, 2025],
    ["producao de 2017 ate 2025", 2017, 2025],
    ["producao de 2017 até 2025", 2017, 2025],
    ["desde 2017 até 2025", 2017, 2025],
    ["entre 2017 e 2025", 2017, 2025],
    ["revenue from 2017 to 2025", 2017, 2025],
    ["revenue from 2017 through 2025", 2017, 2025],
    ["between 2017 and 2025", 2017, 2025],
    ["facturacion entre 2017 y 2025", 2017, 2025],
    ["desde 2017 hasta 2025", 2017, 2025],
    ["faturamento 2017-2025", 2017, 2025],
    ["faturamento 2017 – 2025", 2017, 2025],
    ["vendas 2023 a 2024", 2023, 2024],
    // Trend wording over a wide span asks for the whole series, not the two
    // endpoints. Vetoing these reintroduced the original bug: they fell through
    // to the single-year match and the prompt said "Periodo atual: 2017".
    ["crescimento de 2017 a 2025", 2017, 2025],
    ["growth from 2017 to 2025", 2017, 2025],
    ["crecimiento de 2017 a 2025", 2017, 2025],
    ["crescimento entre 2018 e 2024", 2018, 2024]
  ];

  for (const [question, startYear, endYear] of positives) {
    it(`reconhece "${question}"`, () => {
      assert.deepEqual(parseYearRange(question), { startYear, endYear });
    });
  }

  it("normaliza a ordem invertida", () => {
    assert.deepEqual(parseYearRange("de 2025 a 2017"), { startYear: 2017, endYear: 2025 });
  });
});

/**
 * The real risk of the fix is cannibalising comparisons that already work.
 * "diferenca entre 2023 e 2024" matches the "entre X e Y" shape but must stay a
 * two-point comparison, so the planner keeps decomposing it.
 */
describe("parseYearRange — comparacoes nao viram intervalo", () => {
  const negatives = [
    "2024 vs 2023",
    "2024 vs. 2023",
    "compare o faturamento de 2023 com 2024",
    "2023 versus 2024",
    "diferenca entre 2023 e 2024",
    "diferença entre 2023 e 2024",
    "diferencia entre 2023 y 2024",
    "difference between 2023 and 2024",
    "crescimento de 2023 para 2024",
    // Trend wording over ADJACENT years stays a two-point comparison; the same
    // wording over a wider span is an interval (see the positives above).
    "crecimiento de 2023 a 2024",
    "growth from 2023 to 2024",
    "crescimento de 2023 a 2024",
    // Explicit two-point language vetoes the interval at any span, so a wide
    // "diferenca entre X e Y" must not be swallowed by the "entre X e Y" shape.
    "diferenca entre 2017 e 2025",
    "compare o faturamento de 2017 a 2025",
    "faturamento 2023 x 2024"
  ];

  for (const question of negatives) {
    it(`ignora "${question}"`, () => {
      assert.equal(parseYearRange(question), null);
    });
  }
});

describe("parseYearRange — casos degenerados", () => {
  it("retorna null sem nenhum ano", () => {
    assert.equal(parseYearRange("qual o faturamento total"), null);
  });

  it("retorna null com um unico ano", () => {
    assert.equal(parseYearRange("faturamento em 2024"), null);
  });

  it("retorna null quando inicio e fim sao o mesmo ano", () => {
    assert.equal(parseYearRange("de 2024 a 2024"), null);
  });

  it("retorna null acima do span maximo de 50 anos", () => {
    assert.equal(parseYearRange("de 2001 a 2099"), null);
  });

  it("retorna null para string vazia", () => {
    assert.equal(parseYearRange(""), null);
  });
});

describe("expandYears", () => {
  it("expande o intervalo inteiro, inclusive os extremos", () => {
    assert.deepEqual(
      expandYears({ startYear: 2017, endYear: 2025 }),
      [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]
    );
  });
});

describe("formatYearRange", () => {
  it("usa 'a' em pt e es", () => {
    assert.equal(formatYearRange({ startYear: 2017, endYear: 2025 }, "pt"), "2017 a 2025");
    assert.equal(formatYearRange({ startYear: 2017, endYear: 2025 }, "es"), "2017 a 2025");
  });

  it("usa 'to' em en", () => {
    assert.equal(formatYearRange({ startYear: 2017, endYear: 2025 }, "en"), "2017 to 2025");
  });
});

/**
 * The exact shape the bug produced: findPeriodInText returned { year: 2017 }
 * for "e de 2017 a 2025", and that 2017 was injected into every SQL prompt as
 * "Periodo atual", instructing the agent to ignore the rest of the interval.
 */
describe("findPeriodInText — intervalo vence o ano unico", () => {
  it("le o follow-up cru como intervalo, nao como 2017", () => {
    assert.deepEqual(findPeriodInText("e de 2017 a 2025"), {
      range: { startYear: 2017, endYear: 2025 }
    });
  });

  it("le a pergunta reescrita como intervalo", () => {
    assert.deepEqual(findPeriodInText("faturamento de 2017 a 2025"), {
      range: { startYear: 2017, endYear: 2025 }
    });
  });

  it("nao devolve year quando ha range", () => {
    const period = findPeriodInText("de 2017 a 2025");
    assert.equal(period?.year, undefined);
    assert.equal(period?.month, undefined);
  });

  it("mantem o ano unico intacto", () => {
    assert.deepEqual(findPeriodInText("faturamento em 2024"), { year: 2024 });
  });

  it("mantem mes com ano", () => {
    assert.deepEqual(findPeriodInText("faturamento de marco de 2024"), { month: 3, year: 2024 });
  });

  it("deixa a comparacao como ano unico, para o planner decompor", () => {
    assert.deepEqual(findPeriodInText("compare o faturamento de 2023 com 2024"), { year: 2023 });
  });

  it("retorna null sem periodo", () => {
    assert.equal(findPeriodInText("qual o faturamento total"), null);
  });
});

describe("formatPeriodText", () => {
  it("renderiza o intervalo nos tres idiomas", () => {
    const period = { range: { startYear: 2017, endYear: 2025 } };
    assert.equal(formatPeriodText(period, "pt"), "2017 a 2025");
    assert.equal(formatPeriodText(period, "es"), "2017 a 2025");
    assert.equal(formatPeriodText(period, "en"), "2017 to 2025");
  });

  it("renderiza mes e ano", () => {
    assert.equal(formatPeriodText({ month: 3, year: 2024 }, "pt"), "marco 2024");
  });

  it("renderiza ano sozinho", () => {
    assert.equal(formatPeriodText({ year: 2024 }, "pt"), "2024");
  });

  it("retorna null para periodo vazio", () => {
    assert.equal(formatPeriodText({}, "pt"), null);
  });
});

describe("isContiguousYearRun", () => {
  it("aceita uma sequencia sem buracos de tres ou mais anos", () => {
    assert.equal(isContiguousYearRun([2022, 2023, 2024]), true);
  });

  it("recusa dois anos, que leem como comparacao", () => {
    assert.equal(isContiguousYearRun([2017, 2025]), false);
  });

  it("recusa sequencia com buraco", () => {
    assert.equal(isContiguousYearRun([2017, 2018, 2025]), false);
  });

  it("recusa lista vazia", () => {
    assert.equal(isContiguousYearRun([]), false);
  });
});
