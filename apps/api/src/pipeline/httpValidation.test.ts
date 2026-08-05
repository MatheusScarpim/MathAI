import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeIngestMethods,
  resolveAllowedMethods,
  validateHttpRequest
} from "./httpValidation.js";

/**
 * Tests for item #6: swagger ingest and HTTP execution are no longer GET-only.
 * The policy is opt-in per environment via `apiIngestMethods`, so the matrix
 * that matters is: what an absent field does (must reproduce the old
 * behaviour exactly), what an allowlisted POST unlocks, and what an
 * allowlisted DELETE must still NOT unlock while `apiReadOnly` is on.
 */

const plan = (method: string, url = "/pedidos") => ({
  steps: [{ stepIndex: 0, method, url, description: "d" }]
});

describe("resolveAllowedMethods - absent config", () => {
  it("read-only environment falls back to GET only", () => {
    assert.deepEqual(resolveAllowedMethods(undefined, true), ["GET"]);
  });

  it("non-read-only environment falls back to every valid method", () => {
    // Defaulting to ["GET"] here would have silently broken every
    // environment deliberately running apiReadOnly:false to write.
    const allowed = resolveAllowedMethods(undefined, false);
    assert.deepEqual(allowed, ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
  });
});

describe("resolveAllowedMethods - configured", () => {
  it("normalizes case and whitespace", () => {
    assert.deepEqual(resolveAllowedMethods([" get ", "post"], true), ["GET", "POST"]);
  });

  it("dedupes", () => {
    assert.deepEqual(resolveAllowedMethods(["GET", "get", "GET"], true), ["GET"]);
  });

  it("drops unknown method names instead of failing", () => {
    assert.deepEqual(resolveAllowedMethods(["GET", "TRACE", "FETCH"], true), ["GET"]);
  });

  it("falls back when the list reduces to nothing", () => {
    // An all-garbage list must not become an empty allowlist, which would
    // block every request in the environment.
    assert.deepEqual(resolveAllowedMethods(["TRACE"], true), ["GET"]);
    assert.deepEqual(resolveAllowedMethods([], true), ["GET"]);
  });
});

describe("normalizeIngestMethods", () => {
  it("returns undefined for a non-array so 'not configured' survives", () => {
    assert.equal(normalizeIngestMethods(undefined), undefined);
  });

  it("returns undefined for an empty result rather than []", () => {
    // Storing [] would be indistinguishable from an explicit empty allowlist.
    assert.equal(normalizeIngestMethods([]), undefined);
    assert.equal(normalizeIngestMethods(["TRACE"]), undefined);
  });

  it("canonicalizes to upper-case deduped known methods", () => {
    assert.deepEqual(normalizeIngestMethods([" post ", "get", "POST"]), ["POST", "GET"]);
  });
});

describe("validateHttpRequest - allowlist gate", () => {
  const baseUrl = "https://api.example.com";

  it("allows GET under the default read-only allowlist", () => {
    const result = validateHttpRequest(plan("GET"), baseUrl, true, ["GET"]);
    assert.equal(result.ok, true);
  });

  it("blocks a method outside the allowlist even when not read-only", () => {
    // The allowlist outranks read-only: never-indexable means never-executable.
    const result = validateHttpRequest(plan("DELETE"), baseUrl, false, ["GET"]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error.errorMessage!, /nao esta habilitado neste ambiente/);
    assert.match(result.error.errorMessage!, /GET/);
  });

  it("blocks POST when the environment has not opted in", () => {
    const result = validateHttpRequest(plan("POST"), baseUrl, true, ["GET"]);
    assert.equal(result.ok, false);
  });

  it("allows POST under read-only once allowlisted", () => {
    // Listing POST is the opt-in that declares "POST is a query in this API".
    const result = validateHttpRequest(plan("POST"), baseUrl, true, ["GET", "POST"]);
    assert.equal(result.ok, true);
  });

  it("still blocks an allowlisted DELETE under read-only", () => {
    // Regression guard: an earlier draft exempted every allowlisted method
    // from the read-only rule, which let DELETE bypass apiReadOnly entirely.
    const result = validateHttpRequest(plan("DELETE"), baseUrl, true, ["GET", "DELETE"]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error.errorMessage!, /somente-leitura/);
  });

  it("still blocks allowlisted PUT and PATCH under read-only", () => {
    for (const method of ["PUT", "PATCH"]) {
      const result = validateHttpRequest(plan(method), baseUrl, true, ["GET", method]);
      assert.equal(result.ok, false, `${method} should stay blocked`);
    }
  });

  it("allows an allowlisted DELETE when not read-only", () => {
    const result = validateHttpRequest(plan("DELETE"), baseUrl, false, ["GET", "DELETE"]);
    assert.equal(result.ok, true);
  });

  it("rejects an invalid method before consulting the allowlist", () => {
    const result = validateHttpRequest(plan("TRACE"), baseUrl, false, ["TRACE"]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error.errorMessage!, /Metodo HTTP invalido/);
  });

  it("defaults the allowlist from readOnly when the argument is omitted", () => {
    assert.equal(validateHttpRequest(plan("GET"), baseUrl, true).ok, true);
    assert.equal(validateHttpRequest(plan("POST"), baseUrl, true).ok, false);
    assert.equal(validateHttpRequest(plan("DELETE"), baseUrl, false).ok, true);
  });
});
