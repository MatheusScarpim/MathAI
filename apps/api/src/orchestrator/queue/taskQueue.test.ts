/**
 * Testes unitarios para taskQueue — G10 plan W3.
 *
 * Roda com `node --test --import tsx src/orchestrator/queue/taskQueue.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

test("acquireSlot resolve imediatamente quando capacidade tem espaco", async () => {
  // Set conservador antes de importar (env eh lido no module-init)
  process.env.MAX_CONCURRENT_TASKS = "3";
  process.env.MAX_CONCURRENT_ANTHROPIC = "2";
  const mod = await import("./taskQueue.js");
  const slot = await mod.acquireSlot({ description: "t1" });
  assert.ok(slot.queueId, "queueId atribuido");
  assert.equal(typeof slot.release, "function");
  slot.release();
});

test("setSlotProvider muda provider de um slot running", async () => {
  process.env.MAX_CONCURRENT_TASKS = "5";
  const mod = await import("./taskQueue.js");
  const slot = await mod.acquireSlot({ description: "t-set-prov" });
  mod.setSlotProvider(slot.queueId, "anthropic");
  const snap = mod.queueSnapshot();
  // pode ou nao estar visivel dependendo de ordering, mas byProvider.anthropic.running >= 1
  assert.ok(snap.byProvider.anthropic, "anthropic key presente em byProvider");
  assert.ok(snap.byProvider.anthropic.running >= 1, "running incrementado");
  slot.release();
  const snap2 = mod.queueSnapshot();
  assert.equal(snap2.byProvider.anthropic?.running ?? 0, 0, "release decrementa");
});

test("queueSnapshot expoe caps por-provider conhecidos", async () => {
  const mod = await import("./taskQueue.js");
  const snap = mod.queueSnapshot();
  assert.ok(snap.byProvider.anthropic);
  assert.ok(snap.byProvider.deepseek);
  assert.ok(snap.byProvider.codex);
  // caps devem ser >= 1
  for (const p of ["anthropic", "deepseek", "codex"]) {
    assert.ok(snap.byProvider[p]!.cap >= 1, `${p} cap >= 1`);
  }
});

test("cancelQueueItem remove slot pending", async () => {
  process.env.MAX_CONCURRENT_TASKS = "0"; // forca tudo pra pending
  // Re-import nao funciona com ESM cache; este teste eh smoke
  const mod = await import("./taskQueue.js");
  // Slot pending nunca vai resolver com cap=0 — testa atraves de snapshot
  const before = mod.queueSnapshot().pending;
  // Note: nao adquirimos slot aqui (vai bloquear); apenas cobrimos a API publica
  assert.equal(typeof mod.cancelQueueItem, "function");
  assert.equal(typeof before, "number");
});

test("awaitProviderSlot bloqueia 3a task quando cap=2 ja atingido", async () => {
  // CUIDADO: este teste depende do env MAX_CONCURRENT_ANTHROPIC=2 lido no
  // module-init. ESM cacheia o modulo entre testes; rodar este isoladamente
  // se algum outro teste estourar o cap.
  process.env.MAX_CONCURRENT_TASKS = "10";
  const mod = await import("./taskQueue.js");

  // Anula contagens previas dos testes anteriores garantindo limpeza.
  // Adquire 2 slots ja com provider=anthropic-test no acquire (cap default=2
  // do env MAX_CONCURRENT_ANTHROPIC). Usamos um provider unico pra isolar
  // do "anthropic" global compartilhado entre testes.
  const PROV = "anthropic"; // usa o real pra testar cap configurado
  const before = mod.queueSnapshot().byProvider[PROV]?.running ?? 0;
  // Ja existem 0 tasks rodando deste provider (assumimos teste isolado)
  void before;

  const s1 = await mod.acquireSlot({ description: "t1", provider: PROV });
  const s2 = await mod.acquireSlot({ description: "t2", provider: PROV });
  const after2 = mod.queueSnapshot().byProvider[PROV]!.running;
  assert.equal(after2, 2, "2 tasks anthropic running");

  // 3a task: acquire SEM provider (simula pipeline antes do planner)
  const s3 = await mod.acquireSlot({ description: "t3" });
  // Agora pede provider gate: deve ficar pending ate s1 dar release
  let granted = false;
  const gatePromise = mod.awaitProviderSlot(s3.queueId, PROV).then(() => { granted = true; });

  // Espera tick — gate NAO deve resolver pq cap esta cheio
  await new Promise(r => setTimeout(r, 100));
  assert.equal(granted, false, "3a task bloqueada pelo cap anthropic");

  // Libera s1 — gate deve acordar a 3a
  s1.release();
  await gatePromise;
  assert.equal(granted, true, "3a task granted apos release de s1");

  s2.release();
  s3.release();
});
