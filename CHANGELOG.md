# Changelog

## 2026-05-17 — Post-roadmap gaps (G2–G14)

Fechamento dos 14 gaps levantados em `.claude/plans/gaps-pos-roadmap.md` apos
shipping do roadmap dos 14 itens estrategicos. Detalhes por gap abaixo.

### Fixes silenciosos

- **G4** — `services/rollback.ts` agora marca `task_executions.reverted=true`
  apos abrir revert PR. Tipo `TaskExecutionRecord.reverted` ja estava em
  `core/mongo.ts` + `orchestrator/types.ts`; `routes/metrics.ts` agrega
  `revertedRate` baseado nesta flag.
- **G8** — `POST /api/projects` e `PATCH /api/projects/:id` disparam
  introspect (`inferDecisionsFromWorktree` + `detectStack`) em background ao
  criar projeto / mudar `repoIds`. Implementacao via novo
  `runIntrospectInBackground` helper.
- **G11** — `pipeline/index.ts` chama `inferDecisionsFromWorktree`
  fire-and-forget apos `createOrGetPullRequest` bem-sucedido, mantendo
  `project_decisions` em dia sem requer comando manual.

### Concorrencia + isolamento

- **G2** — `queue/taskQueue.ts` ganhou semaforo por-provider.
  Caps por env: `MAX_CONCURRENT_ANTHROPIC=2`, `MAX_CONCURRENT_DEEPSEEK=3`,
  `MAX_CONCURRENT_CODEX=1`. `queueSnapshot()` agora retorna `byProvider`.
  IMPORTANTE: a primeira versao (setSlotProvider sincrono) era decorativa —
  pipeline adquire slot ANTES do planner saber o provider, entao quando
  setSlotProvider rodava o slot ja estava dispatched. Fix shipped na
  segunda iteracao: `awaitProviderSlot(queueId, provider)` async que
  BLOQUEIA via fila FIFO `providerWaiters[provider]` ate `decProvider`
  drenar 1 waiter no release. Pipeline chama `await awaitProviderSlot()`
  apos `selectRoute("taskPlanner")` retornar — antes de despachar code
  agents (a parte cara). Validado por unit test que prova: 3a anthropic
  task com cap=2 fica em wait ate s1 dar release.
- **G7** — `services/orphanWatchdog.ts` ganhou `requeuePendingTasks`,
  rodado no boot. Tasks em `status:"pending"` (sobreviventes de reboot)
  voltam pro `executeTask` via `existingTaskId` reuse (depende do G6).
- **G6** — `executeTask` aceita `existingTaskId?: string` em
  `TaskExecuteOptions`. `approve-plan` route passa o `_id` original, evitando
  doc duplicado e contagens infladas em `/api/metrics`.

### Stack agnostic

- **G3** — `runStaticChecks(worktree, stack?)` aceita `DetectedStack`. Quando
  stack nao-Node (python/go/rust), roda `stack.staticCheckCmd` ao inves de
  `tsc/eslint`. `runtimeVerifier` injeta `[STACK DETECTED]` block no system
  prompt — LLM sabe nao sugerir `npm test` num Go. `previewManager` faz
  fallback `stack.previewBuildCmd` quando `project.previewBuildCmd`
  ausente.

### Plan approval

- **G9** — 3o trigger de gate: `estimated_cost > $0.50`. Estimativa via
  `subtaskCount × avg(costUsd)` dos ultimos 50 `task_executions` com
  `agent:"code"` no mesmo provider. Sem historico, fallback heuristico
  ($0.10 Anthropic, $0.01 DeepSeek, $0.05 Codex). Threshold configuravel
  via `PLAN_APPROVAL_COST_THRESHOLD_USD`.

### Integracoes

- **G5** — `integrations/trello.ts` ganhou `setupTrelloWebhook(boardId,
  callbackUrl)` idempotente + `listWebhooksForToken()`. Disparado em
  background no POST/PATCH `/api/projects` quando `trelloBoardId` muda.
  Precisa `PUBLIC_API_URL` no env — sem isso, log warn e skip.

### Polish

- **G13** — `.env.example` documenta `MAX_CONCURRENT_TASKS`,
  `MAX_CONCURRENT_<provider>`, `PLAN_APPROVAL_COST_THRESHOLD_USD`,
  `PUBLIC_API_URL`, `TRELLO_WEBHOOK_SECRET` (este ja estava). Este
  CHANGELOG.

### Pendente

- **G1** — Validacao E2E real (precisa LLM + GitHub credenciais reais).
- **G10** — Testes unitarios minimos. Modulos puros (`pricing.computeCost`,
  `taskQueue.sortPending`, `conflictDetect.normalize`, regexes de
  `secretScan`, `inferDecisionsFromWorktree`) ainda sem coverage.
- **G12** — UI: pagina /queue, decisions editor, botao Revert, stack badge,
  Trello comments render. Backend pronto, frontend ainda nao.
- **G14** — Memorias de feedback do ciclo de fechamento.
