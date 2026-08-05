import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractRows } from "./httpExecutor.js";

/**
 * Regression tests for item #7: the old flatten was
 * `Array.isArray(resp) ? resp : [resp]`, which turned every paginated
 * envelope into a single row of pagination metadata.
 */

describe("extractRows - bare collections", () => {
  it("passes through a root array", () => {
    const result = extractRows([{ id: 1 }, { id: 2 }]);
    assert.deepEqual(result.rows, [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(result.meta, {});
    assert.equal(result.envelopePath, "");
  });

  it("wraps scalars in a value column", () => {
    const result = extractRows([1, "a", true]);
    assert.deepEqual(result.rows, [{ value: 1 }, { value: "a" }, { value: true }]);
  });

  it("keeps a genuine single record as one row", () => {
    const result = extractRows({ id: 7, nome: "Ana" });
    assert.deepEqual(result.rows, [{ id: 7, nome: "Ana" }]);
    assert.equal(result.envelopePath, "");
  });

  it("returns an empty row set for an empty collection", () => {
    assert.deepEqual(extractRows([]).rows, []);
    assert.deepEqual(extractRows({ data: [], total: 0 }).rows, []);
  });

  it("handles a non-object, non-array payload", () => {
    assert.deepEqual(extractRows("texto").rows, [{ value: "texto" }]);
    assert.deepEqual(extractRows(null).rows, [{ value: null }]);
  });
});

describe("extractRows - envelope unwrapping", () => {
  it("unwraps { data, total, page } and keeps pagination out of the rows", () => {
    const result = extractRows({
      total: 1234,
      page: 1,
      pageSize: 50,
      data: [{ id: 1, valor: 10 }, { id: 2, valor: 20 }]
    });

    assert.deepEqual(result.rows, [{ id: 1, valor: 10 }, { id: 2, valor: 20 }]);
    assert.equal(result.envelopePath, "data");
    assert.deepEqual(result.meta, { total: 1234, page: 1, pageSize: 50 });
    // The bug: `total` used to become a column.
    assert.ok(!Object.keys(result.rows[0]!).includes("total"));
  });

  it("unwraps OData { value, @odata.count }", () => {
    const result = extractRows({
      "@odata.count": 2,
      value: [{ Nome: "A" }, { Nome: "B" }]
    });

    assert.deepEqual(result.rows, [{ Nome: "A" }, { Nome: "B" }]);
    assert.equal(result.envelopePath, "value");
    assert.deepEqual(result.meta, { "@odata.count": 2 });
  });

  it("unwraps { items } and { records } and { rows } and { results }", () => {
    for (const key of ["items", "records", "rows", "results", "content", "list", "payload"]) {
      const result = extractRows({ [key]: [{ id: 1 }] });
      assert.deepEqual(result.rows, [{ id: 1 }], `falhou para ${key}`);
      assert.equal(result.envelopePath, key);
    }
  });

  it("recurses one level into legacy { d: { results } }", () => {
    const result = extractRows({
      d: { __count: "3", results: [{ Id: 1 }, { Id: 2 }, { Id: 3 }] }
    });

    assert.deepEqual(result.rows, [{ Id: 1 }, { Id: 2 }, { Id: 3 }]);
    assert.equal(result.envelopePath, "d.results");
    assert.deepEqual(result.meta, { __count: "3" });
  });

  it("prefers the higher-trust envelope key when several are present", () => {
    const result = extractRows({
      data: [{ correto: true }],
      list: [{ correto: false }]
    });

    assert.deepEqual(result.rows, [{ correto: true }]);
    assert.equal(result.envelopePath, "data");
  });

  it("falls back to a single array-valued property with an unknown name", () => {
    const result = extractRows({ total: 2, faturas: [{ id: 1 }, { id: 2 }] });
    assert.deepEqual(result.rows, [{ id: 1 }, { id: 2 }]);
    assert.equal(result.envelopePath, "faturas");
    assert.deepEqual(result.meta, { total: 2 });
  });

  it("does not guess when two unknown array properties are ambiguous", () => {
    const payload = { vendas: [{ id: 1 }], clientes: [{ id: 2 }] };
    const result = extractRows(payload);
    assert.deepEqual(result.rows, [payload]);
    assert.equal(result.envelopePath, "");
  });

  it("keeps nested objects inside a row untouched", () => {
    const result = extractRows({ data: [{ id: 1, endereco: { cidade: "SP" } }] });
    assert.deepEqual(result.rows, [{ id: 1, endereco: { cidade: "SP" } }]);
  });

  it("unwraps a single-record envelope { data: { ... } }", () => {
    // Found by the verifier: this used to yield one row whose only column was
    // `data`, holding the whole record - the same uselessness as the array case.
    const result = extractRows({ data: { id: 7, nome: "Ana" }, total: 1 });

    assert.deepEqual(result.rows, [{ id: 7, nome: "Ana" }]);
    assert.equal(result.envelopePath, "data");
    assert.deepEqual(result.meta, { total: 1 });
  });

  it("still prefers an array under a later key over an object under an earlier one", () => {
    const result = extractRows({ data: { id: 1 }, items: [{ id: 2 }, { id: 3 }] });

    assert.deepEqual(result.rows, [{ id: 2 }, { id: 3 }]);
    assert.equal(result.envelopePath, "items");
  });

  it("treats an envelope key holding a scalar as a plain record", () => {
    const result = extractRows({ data: "nenhum resultado", status: "ok" });
    assert.deepEqual(result.rows, [{ data: "nenhum resultado", status: "ok" }]);
    assert.equal(result.envelopePath, "");
  });
});

describe("extractRows - explicit responsePath", () => {
  it("follows a dotted path and skips auto-detection", () => {
    const result = extractRows(
      { data: [{ errado: true }], custom: { deep: [{ certo: true }] } },
      "custom.deep"
    );

    assert.deepEqual(result.rows, [{ certo: true }]);
    assert.equal(result.envelopePath, "custom.deep");
  });

  it("wraps a single object resolved by path", () => {
    const result = extractRows({ envelope: { id: 9 } }, "envelope");
    assert.deepEqual(result.rows, [{ id: 9 }]);
  });

  it("returns no rows when the path does not resolve", () => {
    const result = extractRows({ data: [{ id: 1 }] }, "nao.existe");
    assert.deepEqual(result.rows, []);
    assert.equal(result.envelopePath, "nao.existe");
  });

  it("ignores a blank path and auto-detects instead", () => {
    const result = extractRows({ data: [{ id: 1 }] }, "   ");
    assert.deepEqual(result.rows, [{ id: 1 }]);
    assert.equal(result.envelopePath, "data");
  });
});
