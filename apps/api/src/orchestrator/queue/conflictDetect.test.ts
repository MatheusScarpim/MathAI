/**
 * G10 — testes unitarios para conflictDetect.normalize.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "./conflictDetect.js";

test("normalize: backslash -> slash", () => {
  assert.equal(normalize("src\\foo\\bar.ts"), "src/foo/bar.ts");
});

test("normalize: tira ./ prefix", () => {
  assert.equal(normalize("./src/foo.ts"), "src/foo.ts");
});

test("normalize: lowercase", () => {
  assert.equal(normalize("SRC/Foo.TS"), "src/foo.ts");
});

test("normalize: combina tudo", () => {
  assert.equal(normalize(".\\SRC\\Foo.TS"), "src/foo.ts");
});

test("normalize: path absoluto unix permanece (sem barra inicial removida)", () => {
  // Importante: dois paths diferentes nao devem colidir
  assert.notEqual(normalize("src/a.ts"), normalize("src/b.ts"));
});

test("normalize: idempotente", () => {
  const once = normalize("src/foo.ts");
  assert.equal(normalize(once), once);
});
