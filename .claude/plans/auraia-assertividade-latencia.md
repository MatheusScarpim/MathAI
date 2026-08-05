# AuraIa — Plano: Assertividade, Latência e Multi-Ambiente

> Documento vivo. Marcar status por item conforme entrega: ⏳ pendente · 🟡 em andamento · ✅ concluído.
> Criado 2026-08-01. Todos os 14 itens foram verificados no código antes de virar tarefa (arquivo:linha confirmado).

## Contexto

Auditoria do pipeline `ask` (modo SQL e modo API) apontou 14 itens em três eixos:

- **Correção / assertividade** — pós-processamentos por regex que *falsificam* a resposta, e falta de detecção de idioma.
- **Latência** — o caminho crítico hoje tem 6–9 chamadas sequenciais ao OpenAI.
- **Fundação de qualidade** — não existe conjunto de avaliação, então qualquer mudança de prompt/modelo/chunking é ajuste no escuro.

**Princípio de ordenação:** o conjunto de avaliação (W0) vem antes de qualquer otimização. Com um problema de assertividade em aberto e sem baseline mensurável, não há como saber se uma mudança melhorou ou piorou.

## Mapa do pipeline atual (modo SQL)

```
traduzir pergunta (ask.ts:417)
  → standalone question (ask.ts:431)
    → embedding (ask.ts:457)
      → cache direto + cache semântico
        → gerar SQL (+ até 2 retries com reflection)
          → executar query
            → [chart ‖ summary] em paralelo (ask.ts:991)
              → traduzir resumo (ask.ts:1016)  ← round trip sequencial extra
```

Modo API bifurca em `ask.ts:467` → `answerQuestionApi()`.

---

## Ordem de execução

| Wave | Foco | Itens | Bloqueia |
|------|------|-------|----------|
| **W0** | Fundação de medição | #11 | Todas as outras waves |
| **W1** | Parar de falsificar respostas | #1, #2, #3, #4 | — |
| **W2** | Multi-ambiente e ingest | #5, #6, #7 | — |
| **W3** | Latência e percepção | #8, #9, #10 | W0 (para provar que não regrediu) |
| **W4** | Assertividade estrutural | #12, #13, #14 | W0 |

W1 e W2 são independentes entre si e podem ir em paralelo. W3 e W4 só depois do W0 existir e ter baseline gravado.

---

# W0 — Fundação de medição

## 🟡 #11 — Conjunto de avaliação (o item mais importante da lista)

**Problema.** Não existe suíte de avaliação. Sem ~50 pares `pergunta → resposta esperada` rodando a cada mudança, não é possível afirmar que trocar prompt, modelo ou chunking melhorou. Com assertividade em aberto, isso precede qualquer otimização.

### Estado: harness ✅ construído · baseline ⏳ não gravado · casos 15/50

O maquinário está pronto e verificado. O que falta é **dado**: rodar contra um ambiente configurado e curar os casos de domínio. Entregue em `apps/api/eval/`:

| Arquivo | Papel |
|---|---|
| `types.ts` | `EvalCase`, `CaseExpect`, 14 `FailureCode`s + `FAILURE_HINTS` mapeando cada código a um item deste plano |
| `graders.ts` | Todas as assertivas, **100% determinísticas** — nenhum LLM juiz |
| `run.ts` | CLI: `--tags --only --label --concurrency --env --list --warm --verbose` |
| `diff.ts` | Compara dois runs separando **regressões** de correções |
| `bootstrap.ts` | Rascunha casos do history real, todos `skip: true` |
| `cases/invariants.json` | 15 casos schema-agnósticos |
| `cases/README.md` | Guia de autoria + procedimento de baseline |
| `lib/language.ts` | Wrapper fino sobre `src/helpers/detectLanguage.ts` (#2) |
| `tsconfig.json` | `noEmit`, `rootDir: ".."` para enxergar `eval/` e `src/` |

Scripts: `eval`, `eval:diff`, `eval:bootstrap`, `eval:typecheck`.

**Assertivas implementadas** (superset do escopo original): `shouldSucceed`, `sqlMustMatch`/`sqlMustNotMatch`, `sqlYears`, `minRows`/`maxRows`/`exactRows`, `answerContains`/`answerMustNotContain`, `expectedValue` (+`tolerance`), `summaryYearsSubsetOfSql`, `assertLanguage`, `maxElapsedMs`, e `history[]` para casos multi-turno.

**Os 15 casos invariantes** cobrem as regressões do W1 sem depender do schema: 4 de `ano` (#1), 3 de `idioma` (#2), 4 de `falso-bloqueio` (#3), 3 negativos de recusa, 1 piso de latência.

### O que falta para fechar o #11

1. **Gravar a baseline** — exige `JWT_SECRET` + Mongo/Qdrant/SQL alcançáveis. `npm run eval -- --label baseline`.
2. **Chegar a 50 casos** — `npm run eval:bootstrap -- --favorites --limit 30`, depois revisar um a um (checklist em `cases/README.md`) e remover o `skip`.
3. **Casos de modo API** — os 5 previstos agora estão desbloqueados (#4/#5 fechados).

**Critério de aceite.** `npm run eval` roda os 50 casos, grava baseline, e `eval:diff` mostra delta por caso. Os casos que falhavam por #1/#2/#3 estão no set e servem de regressão para o W1.

**Nota.** O eval consome API paga. `--only <id>`, `--tags` e `--concurrency` já existem; fora do CI por default. `--list` é a exceção: não importa o pipeline, roda sem env nenhum, e serve de lint da suíte no CI.

### Decisões de design do harness

- **Sem LLM juiz.** Um avaliador que é ele mesmo um LLM injeta na medição exatamente a variância que a medição existe para detectar. Todo grader é regex, comparação numérica ou detecção determinística de idioma.
- **Controle de cache sem tocar em `src/`.** O cache semântico é chaveado por `chatId`; cada caso roda com `eval-<id>-<uuid>`, o que garante caminho frio e isola o histórico de conversa. `--warm` reusa o `chatId` para medir o caminho quente.
- **Fronteira de import preguiçosa.** `src/core/config.ts` aborta o processo no import quando falta env. `run.ts` só importa o pipeline dentro de `loadPipeline()`, então `--list` valida a suíte com zero configuração. `graders.ts` entrou na mesma fronteira porque importa `agents/summary.ts` e vazava o config transitivamente.
- **Exceção é resultado, não crash.** Se `answerQuestion` rejeitar, o caso reprova com `PIPELINE_ERROR` — o contrato é devolver `ok: false`, nunca rejeitar.
- **`FALSE_BLOCK` ≠ `SQL_ERROR`.** Nosso validador recusando query legítima (#3) e o banco recusando são consertos diferentes; o grader distingue por regex na mensagem.
- **Rascunho nasce desabilitado.** Um caso gerado de uma resposta passada afirma que aquela resposta *estava correta*, o que ninguém verificou. Habilitar automaticamente congelaria os bugs de hoje na baseline como comportamento esperado — a suíte passaria a defender os defeitos que existe para achar.
- **`shapeKey` no bootstrap** colapsa perguntas que diferem só em espaço, pontuação ou número: 50 variações de "faturamento de \<ano\>" medem um caminho de código 50 vezes.
- **O diff separa regressão de correção.** Delta líquido de taxa de acerto esconde o caso em que a mudança conserta três casos e quebra outros três — o que não é progresso, é churn. Sai com código 1 em qualquer regressão, e avisa quando `cacheEnabled`/`concurrency` divergem (latência incomparável).
- **`lib/language.ts` é wrapper, não cópia.** Escrevi um detector próprio primeiro; quando o #2 entregou `src/helpers/detectLanguage.ts`, joguei o meu fora. Detector privado no eval deixaria um caso passar na medição enquanto a produção segue roteando errado. A checagem é assimétrica de propósito: sinal fraco **nunca** reprova, porque resposta curta e numérica ("R$ 1,2 mi em 2024") não carrega sinal linguístico.

---

# W1 — Parar de falsificar respostas

## ✅ #1 — `enforceSummaryYear` falsifica a resposta

**Arquivo.** `apps/api/src/agents/summary.ts:40-47`, aplicado em `summary.ts:126`.

**Problema.** Se o SQL tem exatamente um ano (`extractYearFromSql`, summary.ts:34), a função reescreve **todo** `20\d{2}` do resumo para esse ano:

```ts
return summary.replace(/\b20\d{2}\b/g, yearText);
```

Consequências:
- "cresceu de 2023 para 2024" com SQL filtrando 2024 vira **"cresceu de 2024 para 2024"**. O usuário recebe um número errado, sem nenhum sinal de erro.
- No modo API é pior: o `sql` passado é o JSON do plano, então qualquer ano que apareça em um `id`, `data` ou string do plano dispara a reescrita.

Isso é um remendo de regex para um problema de prompt.

**Escopo.**
1. Deletar `enforceSummaryYear` e a aplicação em `summary.ts:126` (manter `summary.replace(/\s+/g, " ")`).
2. Deletar `enforceQuestionYear` e sua aplicação em `ask.ts:442` (mesma classe de bug: reescreve anos na pergunta standalone).
3. Resolver no prompt: `periodInstruction` (summary.ts:86-93) já injeta o ano. Endurecer para instruir explicitamente que **todo** período citado deve vir dos dados/SQL, e que não se deve inventar comparativo com período ausente na query.
4. Manter `extractYearsFromSql`/`extractYearFromSql` — continuam úteis para a instrução e para o eval.
5. Substituir a garantia por **detecção, não correção**: se o resumo citar um ano que não está em `extractYearsFromSql(sql)`, logar warning e marcar `summaryYearMismatch: true` no doc de history. Sem reescrever. Isso dá sinal mensurável para o eval em vez de esconder o problema.

**Critério de aceite.** Caso "comparativo entre períodos" do eval passa; nenhum resumo é mutado por regex; `summaryYearMismatch` aparece no history quando o modelo erra.

**Risco.** Sem o remendo, erros de ano do modelo passam a ser visíveis. É o comportamento desejado — visível é melhor que silenciosamente errado — mas pode aumentar a taxa aparente de falha até o prompt estar ajustado. Rodar eval antes/depois.

---

## ✅ #2 — Sem detecção de idioma

**Arquivos.** `apps/api/src/helpers/normalize.ts:56`, `apps/api/src/pipeline/ask.ts:419`.

**Problema.** `normalizeAskPayload` faz default para `"pt"` quando `body.language` não é válido:

```ts
const questionLanguage = isValidLanguage(body.language) ? body.language : "pt";
```

E a tradução em `ask.ts:419` só dispara se `resolvedSchemaLanguage !== language`. Logo: pergunta em inglês com `language: "pt"` (declarado ou defaultado) e schema em `pt` **pula a canonicalização inteira** — a pergunta chega ao gerador de SQL no idioma errado em relação aos chunks de schema.

**Escopo.**
1. Adicionar `detectQuestionLanguage(question)` em `helpers/` — determinístico primeiro (stopwords/diacríticos para pt/en/es é suficiente para 3 idiomas), sem chamada extra ao LLM.
2. Em `normalizeAskPayload`: se `body.language` ausente/inválido, usar a detecção; só cair em `"pt"` se a detecção não tiver confiança.
3. Se `body.language` foi **declarado** mas a detecção discorda com confiança alta: confiar na detecção para a canonicalização e registrar `languageOverride: { declared, detected }` no history. Declaração de cliente errada é a causa raiz aqui — não deve vencer a evidência do texto.
4. Manter `responseLanguage` sempre respeitando o declarado (o usuário pode querer resposta em pt para pergunta em en).

**Critério de aceite.** Os 5 casos multilíngues do eval passam, incluindo o cenário pergunta-em-inglês-com-`language:"pt"`.

---

## ✅ #3 — `validateSql` rejeita query legítima

**Arquivo.** `apps/api/src/core/validation.ts:6-26`, usado em `validateCommon` (`validation.ts:51`).

**Problema.** O blocklist de 28 keywords roda sobre a **string crua**, literais incluídos. Falsos positivos reais:

- `WHERE nome LIKE '%insert%'` → bloqueado por `insert`
- cliente chamado `"Create"` → bloqueado por `create`
- qualquer texto com `set`, `call`, `into`, `declare`, `cursor`, `bulk`

O erro devolvido é `Keyword proibida detectada: insert.` — confuso, e o usuário não tem como agir.

A garantia real de read-only **não é regex**: é usuário de banco somente-leitura na connection string. Com isso no lugar, `validateSql` fica só com as checagens estruturais, que já são boas.

**Escopo.**
1. **Pré-requisito de infra:** confirmar/criar usuário somente-leitura por ambiente e documentar em `.env.example`. Verificar por dialeto o que "somente-leitura" garante (Oracle: sem privilégio DML; SQL Server: `db_datareader`; Postgres: role sem `INSERT/UPDATE/DELETE`; MySQL: grant `SELECT`). Este passo é o que autoriza relaxar o blocklist — **não relaxar antes**.
2. Adicionar `stripSqlLiterals(sql)` — remove `'...'` (com escape `''`) e `"..."`/`` `...` `` antes de qualquer checagem por keyword. Aplicar a checagem no SQL despido.
3. Reduzir o blocklist ao que sobrevive como defesa em profundidade: DML/DDL de verdade (`delete`, `update`, `insert`, `merge`, `drop`, `truncate`, `alter`, `grant`, `revoke`, `create`) e execução (`exec`, `execute`, `xp_`, `sp_`, `dbms_`, `utl_`, `openrowset`, `openquery`, `opendatasource`, `load_file`, `outfile`, `infile`). **Remover** `into`, `set`, `call`, `declare`, `cursor`, `bulk` — geram falso positivo e o read-only já cobre.
   - Atenção: `set` também aparece em `OFFSET`; `into` em `SELECT ... INTO` legítimo de CTE em alguns dialetos.
4. Manter intactas: começa com `SELECT`/`WITH`, sem comentário, statement único, sem `SELECT *`, limite de linhas por dialeto (`checkRowLimit`, validation.ts:113).
5. Mensagens de erro acionáveis: quando bloquear, dizer o que fazer, não só o nome da keyword.

**Critério de aceite.** Os 5 casos de literais suspeitos do eval passam. Teste unitário em `core/validation.test.ts` cobrindo cada falso positivo listado acima e cada keyword que ainda deve bloquear.

---

## ✅ #4 — Modo API ignora o environment

**Arquivo.** `apps/api/src/pipeline/ask.ts:466-479`; assinatura em `apps/api/src/pipeline/askApi.ts:226`.

**Problema.** `ask.ts:466` resolve corretamente `currentConfig` a partir de `resolvedEnvironmentId`, mas a chamada seguinte não repassa o id:

```ts
const currentConfig = resolvedEnvironmentId ? await getEnvironment(resolvedEnvironmentId) : await getAppConfig();
if (currentConfig?.mode === "api") {
  return answerQuestionApi(normalizedQuestion, ..., emit);  // ← sem resolvedEnvironmentId
}
```

Dentro de `answerQuestionApi`, `getAppConfig()` cai em `environments[0]`. Com mais de um ambiente API, as requisições vão para o ambiente errado.

**Escopo.**
1. Adicionar `environmentId?: string` na assinatura de `answerQuestionApi` (askApi.ts:226) e repassar de `ask.ts:468`.
2. Trocar todo `getAppConfig()` dentro de `askApi.ts` por `environmentId ? getEnvironment(environmentId) : getAppConfig()`. Auditar **todas** as ocorrências no arquivo, não só a primeira.
3. Persistir `environmentId` nos docs de history do modo API (askApi.ts:268, 467, 547) — hoje o modo SQL grava, o modo API precisa igualar.
4. Passar `environmentId` também para as buscas Qdrant do modo API (ver #5, mesma raiz).

**Critério de aceite.** Com dois ambientes API cadastrados, uma pergunta com `environmentId` do segundo bate no host do segundo. Verificável nos 5 casos de modo API do eval.

**Nota.** #4 e #5 são a mesma classe de bug (environment não propagado). Fazer no mesmo PR.

**Entregue.**
- `askApi.ts` trocou os 9 parâmetros posicionais por um options object `AnswerQuestionApiOptions` com `environmentId?`. Motivo: o bug em reparo *é* um argumento posicional silenciosamente não passado; um 10º posicional repetiria a armadilha. Só existe 1 call site, então o custo do refactor é zero.
- Resolução do ambiente: `environmentId ? getEnvironment(environmentId) : getAppConfig()`. Ambiente inexistente **falha alto** (`Ambiente <id> nao encontrado.`) em vez de cair no `environments[0]` — o fallback silencioso era o bug.
- Mensagem de modo errado também é específica do ambiente (`Ambiente <id> nao esta configurado no modo API.`).
- `getCacheKey(...)` passou a receber `environmentId`. **A função já aceitava o parâmetro** (`cache.ts` monta `ask:${envKey}:...`) — `askApi.ts` simplesmente nunca passava, então dois ambientes compartilhavam entradas de cache. Bug extra, não listado na review.
- `environmentId` gravado nos 3 inserts de history do modo API (cache-hit, sucesso, fallback). `HistoryRecord.environmentId` já existia em `core/mongo.ts:14`; só o modo SQL preenchia.
- `ask.ts` call site convertido para o options object passando `environmentId: resolvedEnvironmentId`.

---

# W2 — Multi-ambiente e ingest

## ✅ #5 — `endpoint_chunks` hardcoded

**Arquivos.**
- Helper correto já existe: `apps/api/src/core/qdrant.ts:55-56` → `getEndpointCollectionName(envId)` retorna `endpoint_chunks_<id>` ou `endpoint_chunks`.
- Call sites que ignoram o helper:
  - `apps/api/src/agents/endpoint.ts:71` → `qdrant.search("endpoint_chunks", ...)`
  - `apps/api/src/pipeline/swagger.ts:261` → `qdrant.upsert("endpoint_chunks", ...)`
  - `apps/api/src/pipeline/swagger.ts:293` → `qdrant.scroll("endpoint_chunks", ...)`

**Problema.** Ingerir um segundo ambiente API **sobrescreve** os chunks do primeiro. O isolamento por ambiente existe no helper mas nenhum consumidor usa.

**Escopo.**
1. Propagar `environmentId` até os três call sites e trocar a string literal por `getEndpointCollectionName(environmentId)`.
2. Encadear o parâmetro para cima: `ingestEndpointsToQdrant(endpoints)` → `(endpoints, envId)`; `loadEndpointGraph()` → `(envId)`; `clearEndpointCache()` → `(envId)`; e `searchEndpoints` em `agents/endpoint.ts`.
3. Rotas em `routes/schema.ts:51,76,81` passam a aceitar/repassar `environmentId` (o `/api/ingest/swagger` hoje não lê `environmentId` do body — as rotas de schema já leem, seguir o mesmo padrão de `schema.ts:22-23`).
4. `clearEndpointCollection()` (`qdrant.ts`) precisa receber `envId` — conferir se já recebe; `routes/schema.ts:82` chama sem argumento.
5. Ao ligar, garantir que **todos** os N consumidores foram religados na mesma rodada. Ligar só o `search` e deixar `upsert` hardcoded resulta em coleção vazia — pior que o estado atual.

**Critério de aceite.** Ingerir swagger em dois ambientes; `endpoint_chunks_<a>` e `endpoint_chunks_<b>` coexistem no Qdrant com contagens independentes; pergunta em cada ambiente busca só na sua coleção.

**Entregue.** Todos os 14 call sites religados na mesma rodada (regra dos N consumidores):
- `swagger.ts`: `ingestEndpointsToQdrant(endpoints, envId)` → `ensureEndpointCollection(envId)` + `upsert(getEndpointCollectionName(envId))`; `loadEndpointGraph(envId)` → `scroll(getEndpointCollectionName(envId))`.
- `agents/endpoint.ts`: `searchRelevantEndpoints(vector, question, max, envId)` usa `qdrant.search(getEndpointCollectionName(envId))`; `searchEndpointsByText(text, max, envId)` e `expandEndpoints(initial, envId)` repassam para `loadEndpointGraph`.
- `askApi.ts`: as 3 chamadas de busca de endpoint (search inicial, expand, busca-por-erro no retry) passam `environmentId`.
- `routes/schema.ts`: `/api/ingest/swagger` lê `environmentId` do body; `/api/schema/endpoints` da query; `/api/schema/endpoints/clear` do body.
- `core/qdrant.ts` **não precisou de mudança** — `getEndpointCollectionName`, `ensureEndpointCollection` e `clearEndpointCollection` já eram todos environment-aware e exportados. O helper existia; ninguém consumia.

**Bug extra encontrado (vazamento de cache entre ambientes).** `cachedEndpoints` em `swagger.ts` era um único slot module-level. Mesmo depois de ler a coleção certa, o grafo de endpoints do ambiente A responderia perguntas do ambiente B por até 5 min. Virou `Map<collectionName, {endpoints, loadedAt}>`. `clearEndpointCache(undefined)` limpa tudo — semântica correta para os flushes de config/settings (`routes/config.ts:178`, `routes/settings.ts:119`), que por isso não precisaram de edit.

**Gap pré-existente deixado em aberto (fora do escopo, precisa decisão).** `POST /api/settings/reset-environment` (`routes/settings.ts:121-122`) chama `clearSchemaCollection()` e `clearEndpointCollection()` sem argumento, então só derruba as coleções default: `schema_chunks_<id>` e `endpoint_chunks_<id>` de todo ambiente cadastrado **sobrevivem ao reset**. Afeta schema tanto quanto endpoints, e corrigir significa enumerar ambientes para apagar mais coisa do que hoje — ampliar o alcance de um reset destrutivo pede aval explícito.

---

## ⏳ #6 — Ingest de swagger só GET

**Arquivo.** `apps/api/src/routes/schema.ts:65`.

**Problema.** O parser já suporta todos os métodos (`pipeline/swagger.ts:110` — `HTTP_METHODS` com get/post/put/patch/delete/head/options; `swagger.ts:148-172` monta chunk para cada um). A rota descarta tudo que não é GET:

```ts
const endpoints = allEndpoints.filter((e) => e.method.toUpperCase() === "GET");
```

E devolve 400 se sobra zero — um spec só de POST de consulta é rejeitado inteiro.

**Escopo.**
1. Decidir a política de métodos indexáveis. Recomendado: **GET + POST**, com POST tratado como read-only de consulta. `PUT`/`PATCH`/`DELETE` continuam fora — são mutações, e o mesmo raciocínio do #3 (read-only garantido na camada de acesso, não por regex) não se aplica a HTTP arbitrário.
2. Tornar configurável por ambiente: campo `apiIngestMethods?: string[]` no config do ambiente, default `["GET", "POST"]`.
3. Filtrar por essa lista em vez do literal `"GET"`.
4. `pipeline/httpExecutor.ts` precisa saber montar body para POST (verificar se já monta — o `HTTP_METHODS` do parser sugere que o chunk carrega `requestBody`, mas o executor pode estar assumindo query string).
5. Guarda-corpo: mesmo com POST habilitado, bloquear execução se o endpoint escolhido não estiver na lista permitida do ambiente — a permissão é de ingest **e** de execução.
6. Mensagem de erro do 400 (`schema.ts:67`) passa a citar os métodos aceitos.

**Critério de aceite.** Spec com POST de consulta é ingerido e executável; spec com DELETE ignora o DELETE sem falhar o ingest inteiro.

---

## ✅ #7 — Flatten ignora envelope

**Arquivo.** `apps/api/src/pipeline/httpExecutor.ts:170-175`.

**Problema.**

```ts
const rows = Array.isArray(responseData) ? responseData : [responseData];
```

APIs raramente devolvem array na raiz. Respostas comuns viram **uma linha só, com o array inteiro dentro de uma célula**:

- `{ "data": [...] }`
- `{ "items": [...], "total": 120 }`
- `{ "content": [...], "pageable": {...} }` (Spring)
- `{ "results": [...], "next": "..." }`
- `{ "value": [...] }` (OData)
- `{ "d": { "results": [...] } }` (OData v2)

**Escopo.**
1. `extractRows(responseData)` com desembrulho em ordem:
   - array na raiz → usar direto
   - objeto com **exatamente uma** propriedade que é array → usar esse array
   - objeto com chave em lista conhecida (`data`, `items`, `content`, `results`, `records`, `rows`, `value`, `list`, `payload`) cujo valor é array → usar
   - recursão de 1 nível para `{ d: { results: [] } }`
   - objeto escalar (sem array plausível) → `[responseData]`, comportamento atual
2. Preservar metadados de envelope (`total`, `page`, `next`) fora das rows — expor como `meta` no resultado, não como colunas.
3. Permitir override explícito: campo `responsePath` (JSONPath simples, ex. `d.results`) no chunk do endpoint, preenchido no ingest a partir do schema de resposta do swagger quando disponível. Determinístico vence heurística quando existe.
4. Achatar objetos aninhados dentro de cada row em colunas `pai_filho`? **Fora de escopo** — decidir depois com base no eval; evitar explosão de colunas agora.

**Critério de aceite.** Testes unitários em `httpExecutor.test.ts` com os 6 formatos de envelope acima produzindo N rows, não 1. Casos de modo API do eval com `rowCountRange` correto.

---

# W3 — Latência e percepção

Baseline obrigatório do W0 antes e depois de cada item aqui.

## ⏳ #8 — Resumo gerado no idioma errado e traduzido em chamada extra

**Arquivos.** `apps/api/src/pipeline/ask.ts:996` (gera em `resolvedSchemaLanguage`), `ask.ts:1016-1020` (traduz depois).

**Problema.** O resumo é gerado no `schemaLanguage` e só então traduzido para `responseLanguage` numa chamada **sequencial separada**:

```ts
summarizeResult(schemaQuestion, sql, columns, rows, resolvedSchemaLanguage)   // :996
...
if (summary && resolvedSchemaLanguage !== resolvedResponseLanguage && ...) {
  summary = await translateText(summary, resolvedResponseLanguage, "summary"); // :1018
}
```

Não há motivo — `summarizeResult` já recebe `language` e monta prompt/system nos 3 idiomas (`agents/summary.ts:49-70,94-99`). Isso remove um round trip inteiro do caminho crítico.

**Escopo.**
1. Passar `resolvedResponseLanguage` para `summarizeResult` em `ask.ts:996`.
2. Deletar o bloco de tradução `ask.ts:1016-1020`.
3. Atenção ao acoplamento: `summarizeResult` recebe `schemaQuestion` (pergunta canonicalizada, no schemaLanguage) e o SQL. Gerar em `responseLanguage` com entrada em `schemaLanguage` é o caso normal para o modelo — mas reforçar no system prompt que a saída deve estar no idioma pedido, independente do idioma da pergunta/SQL de entrada.
4. Fazer o mesmo em `askApi.ts` (auditar se replica o padrão gerar-depois-traduzir).
5. Idem para o chart: `inferChartWithLLM` já recebe `resolvedResponseLanguage` (`ask.ts:993`) — confirmar que não há tradução redundante de labels em outro ponto.

**Critério de aceite.** Uma chamada a menos ao OpenAI quando `schemaLanguage !== responseLanguage`. Eval mostra `latency_ms` menor nos casos multilíngues e `summary_ok` sem regressão.

---

## ⏳ #9 — Streaming do resumo (maior ganho por linha de código)

**Arquivos.** `apps/api/src/agents/summary.ts:111-118` (chamada não-stream), consumidor SSE em `apps/api/src/routes/ask.ts`, frontend em `frontend/`.

**Problema.** A infra de SSE já existe (`emit?.("step", ...)`, `emit?.("sql", ...)`, `emit?.("rows", ...)`). O resumo é a última coisa a chegar e chega de uma vez. Emitir token a token não deixa mais rápido — muda completamente a percepção.

**Escopo.**
1. `summarizeResult` aceita `onToken?: (delta: string) => void`; quando presente, usar `stream: true` e `stream_options: { include_usage: true }` (necessário para não perder `usage`, que hoje vem de `completion.usage`).
2. Acumular o texto completo para persistir no history e no cache — o streaming é só transporte, o valor gravado não muda.
3. Novo evento SSE `summary_delta` + `summary_done`. Manter o payload final compatível para clientes que não consomem o delta.
4. Frontend: renderizar o parágrafo progressivamente.
5. Interação com #8 e #10: o resumo hoje roda em `Promise.allSettled` junto com o chart (`ask.ts:991-999`). Streaming dentro de `allSettled` funciona, mas o `emit` do delta precisa ser seguro para chamada concorrente com o resultado do chart. Emitir chart quando resolver, independente do stream do resumo.
6. Cache hit não streama — emitir o resumo completo de uma vez (`ask.ts:481`).

**Critério de aceite.** Primeiro token do resumo visível no frontend em < 1s depois do evento `rows`. Resumo persistido idêntico ao modo não-stream.

---

## ⏳ #10 — Chart por LLM sempre roda, tendo fallback determinístico pronto

**Arquivos.** `apps/api/src/pipeline/ask.ts:989-1005`; determinístico `inferChart`, LLM `inferChartWithLLM` (`agents/chart.ts`).

**Problema.** `inferChart` (determinístico) já existe e já é usado como fallback quando o LLM falha (`ask.ts:1004`). Mas o LLM roda **sempre** que `agentsCfg.chart.enabled !== false` — custo e um slot de concorrência em toda pergunta, inclusive nas que o determinístico resolveria igual.

**Escopo.**
1. Inverter o default: determinístico é o caminho padrão; LLM é **opt-in** via `agentsCfg.chart.useLlm` (default `false`).
2. Quando `useLlm: false`, `inferChart` roda síncrono, sai do `Promise.allSettled` e o resumo deixa de compartilhar o bloco de espera.
3. Antes de inverter o default: usar o eval para comparar as duas saídas nos 50 casos e quantificar quantos divergem de forma relevante. Se o determinístico empata na maioria, a inversão é grátis. Este passo é o que justifica a mudança — **não inverter sem o número**.
4. Manter o LLM disponível e documentar quando vale ligar (perguntas com intenção visual explícita).

**Critério de aceite.** Número medido de divergência determinístico-vs-LLM nos 50 casos, registrado neste .md. Com `useLlm: false`, uma chamada a menos ao OpenAI por pergunta e `tokens_total` do eval menor.

---

# W4 — Assertividade estrutural

## 🟡 #12 — Dicionário de tabelas/colunas nos chunks de schema, num idioma só

> **Entregue em grande parte pelo trilho E0–E5** (2026-08-03), por um caminho diferente do previsto aqui. Ver o log de progresso e a seção "Trilho E0–E5" no fim do arquivo.
> **Feito:** passo 1 (store de dicionário — como *seed versionado* + índice em runtime, não coleção Mongo) e passo 5 (injeção no prompt de geração de SQL), que o próprio plano marcava como o de maior retorno.
> **Pendente:** passo 2 (descrição multilíngue `{pt,en,es}` no texto indexado), passo 3 (bootstrap por LLM com `source: inferred|curated`), passo 4 (UI de edição).
> **Não previsto e entregue:** camada de guardas semânticas que bloqueia SQL plausível-porém-errado antes de executar (E3), e catálogo de métricas canônicas (E5).

**Arquivos.** `apps/api/src/pipeline/schema.ts` (construção de chunk), `apps/api/src/agents/schema.ts`.

**Problema.** Os chunks de schema são construídos no `schemaLanguage` — um idioma só. Nomes físicos de coluna em um DW raramente são autoexplicativos, e a busca vetorial depende de o texto do chunk aproximar o vocabulário do usuário. Termo de negócio que não aparece no chunk não é recuperado.

**Escopo.**
1. Store `schema_dictionary` (Mongo), chave `(environmentId, tableFullName, columnName?)`, com: descrição de negócio, sinônimos, unidade, se é métrica ou dimensão, e se é valor absoluto ou taxa percentual (isso ataca direto o erro que o system prompt do resumo já tenta prevenir em `summary.ts:96-99`).
2. Descrição multilíngue: `{ pt, en, es }`. Chunk indexado concatena os idiomas configurados, não só o `schemaLanguage` — o vetor passa a bater com pergunta em qualquer um dos 3.
3. Bootstrap automático: no `/api/ingest/schema`, gerar rascunho de descrição/sinônimos por tabela via LLM a partir de nomes + tipos + amostra, gravar com `source: "inferred"`. Curadoria humana sobrescreve com `source: "curated"`; re-ingest **nunca** sobrescreve `curated`.
4. UI de edição em cima de `/api/schema/tables`.
5. Injetar o dicionário das tabelas selecionadas no prompt de geração de SQL, não só no texto indexado.
6. Ordem de execução: **(1) store + injeção no prompt** primeiro, medir no eval; **(2) bootstrap por LLM** depois; **(3) UI** por último. O item de maior retorno é a injeção no prompt.

**Critério de aceite.** Eval melhora em `tables_ok` nos casos multi-tabela. Um caso novo com termo de negócio que não existe no nome físico da coluna passa a recuperar a tabela certa.

---

## ⏳ #13 — Consultas verificadas como few-shot

**Arquivos.** `apps/api/src/pipeline/ask.ts:135-179` (`loadFewShotExamples`), `apps/api/src/routes/history.ts:163-171` (toggle de favorito).

**Problema.** O mecanismo já existe e funciona: `loadFewShotExamples` filtra `favorite: true` + `sql` não vazio + `embedding` presente, prioriza mesmo `chatId`, ranqueia por similaridade. **Falta curar.** Hoje "favorito" é um marcador de conveniência do usuário no history — não é um conjunto revisado. Um favorito com SQL sutilmente errado se propaga como exemplo para todas as perguntas parecidas.

**Escopo.**
1. Separar os conceitos: `favorite` (marcador pessoal, continua como é) vs. **`verified`** (novo campo booleano + `verifiedBy` + `verifiedAt`). `loadFewShotExamples` passa a filtrar `verified: true`.
2. Migração: nenhuma. `verified` começa vazio e o few-shot degrada para zero exemplos — que é o estado honesto. Popular por curadoria.
3. UI: ação "marcar como verificada" separada da estrela, visível só para quem pode curar. Exigir que a query tenha executado com sucesso.
4. Curar o conjunto inicial: ~15–25 queries cobrindo os padrões recorrentes (agregação por período, top-N, join fato-dimensão, taxa vs. absoluto, comparativo entre períodos).
5. Escopo por ambiente: few-shot de um ambiente não deve vazar para outro. Adicionar `environmentId` ao filtro de `loadFewShotExamples` — mesma raiz do #4/#5.
6. Sobreposição com o #11: os casos do eval e as queries verificadas são conjuntos diferentes com origem comum. Curar juntos, manter separados (eval é teste, few-shot é prompt).

**Critério de aceite.** `loadFewShotExamples` só serve queries `verified`; filtro por ambiente ativo; eval mostra `sql_valid`/`executed_ok` melhor ou igual com o conjunto curado vs. o comportamento anterior de `favorite`.

---

## ⏳ #14 — Views analíticas no DW para perguntas recorrentes

**Escopo fora do repo** (DDL no data warehouse) + integração no repo.

**Problema.** Perguntas recorrentes forçam o modelo a reconstruir joins fato-dimensão e regras de negócio a cada requisição. É a maior fonte de variância: o mesmo pedido em duas formulações gera dois SQLs diferentes, com dois resultados possivelmente diferentes. Uma view move a regra do prompt para o banco, onde é determinística.

**Escopo.**
1. Levantar as perguntas recorrentes a partir do history: agrupar por similaridade de embedding e ranquear por volume. Sair com uma lista priorizada, não com um palpite.
2. Para o top-N: escrever a view no DW com nome legível e colunas em vocabulário de negócio. Cada view resolve joins, filtros de status e a distinção absoluto-vs-taxa.
3. Ingerir as views como tabelas normais no `/api/ingest/schema` — o pipeline não precisa saber que é view. Verificar se `loadSchema` já lista views ou só tabelas base (por dialeto).
4. Preencher o dicionário (#12) das views com prioridade — view sem descrição não é recuperada.
5. Dar preferência às views no prompt de geração de SQL: instrução explícita de preferir view analítica quando ela cobre a pergunta, em vez de reconstruir o join.
6. Adicionar ao eval os casos cobertos por view, para medir o ganho de consistência.

**Critério de aceite.** Lista priorizada de perguntas recorrentes gravada neste .md; views do top-N criadas e ingeridas; casos correspondentes do eval com `sql_valid`/`tables_ok` em 100% e variância de SQL entre formulações reduzida.

**Dependência.** Precisa do #12 para as views serem recuperáveis, e do #11 para provar o ganho. Último item da fila por isso.

---

## Riscos e observações transversais

- **#1 e #2 aumentam a taxa de falha aparente.** Ambos removem remendos que escondiam erros. Isso é o objetivo — mas só é gerenciável com o baseline do W0 gravado antes.
- **#3 não pode ir antes do usuário read-only.** O blocklist é hoje a única barreira de escrita. Relaxar sem a garantia na connection string troca falso positivo por risco real.
- **#4, #5 e #13 (item 5) são a mesma raiz:** `environmentId` não propagado. Vale um passe único no código procurando `getAppConfig()` e strings de coleção literais.
- **Foundational com N consumidores:** #5 e #12 são utilidades com vários call sites. Religar 1 de N é decorativo — os outros N-1 seguem no comportamento antigo em silêncio. Fechar todos os call sites na mesma entrega.
- **Custo do eval.** Rodar os 50 casos gasta API paga. Manter sob demanda com `--sample` e `--only`, fora do CI por default.
- **Hot reload.** Editar `apps/api/src/**` durante uma requisição em voo derruba o pipeline no meio. Conferir se há requisição ativa antes de editar em ambiente de dev compartilhado.

## Log de progresso

| Data | Item | Status | Notas |
|------|------|--------|-------|
| 2026-08-01 | — | 📋 | Plano criado; 14 itens verificados no código (arquivo:linha confirmado) |
| 2026-08-01 | #1 | ✅ | `enforceSummaryYear` e `enforceQuestionYear` deletadas. Detecção substituiu correção. |
| 2026-08-01 | #2 | ✅ | `helpers/detectLanguage.ts` novo (determinístico, sem LLM) + `normalize.ts` religado. |
| 2026-08-01 | #3 | ✅ | Tokenizador `scanSql` por dialeto; checagens rodam no SQL despido de literais/comentários. |
| 2026-08-01 | #7 | ✅ | `extractRows` com `ENVELOPE_KEYS` + `meta` fora das colunas; colunas = união das rows. |
| 2026-08-01 | #4 #5 | ✅ | `environmentId` ponta a ponta: options object em `answerQuestionApi`, 14 call sites de endpoint religados, cache de endpoint keyed por coleção. |
| 2026-08-01 | #11 | 🟡 | Harness **construído e verificado** (`apps/api/eval/**`: runner, graders determinísticos, diff, bootstrap, 15 casos invariantes, README de autoria). Falta **gravar a baseline** (precisa de env configurado) e curar até 50 casos. |
| 2026-08-01 | #6 | ✅ | `apiIngestMethods` por ambiente (opt-in, default `["GET"]`). `resolveAllowedMethods` + `normalizeIngestMethods` em `httpValidation.ts`; ingest do swagger filtra pela allowlist; `validateHttpRequest` ganha gate de allowlist antes do read-only; prompt de `agents/http.ts` espelha a lista. |
| 2026-08-03 | E0 | ✅ | Fronteira domínio↔motor: vocabulário de negócio sai do código e vira **seed versionado** (`apps/api/seeds/avicultura.json`). `vocabulary.test.ts` assegura a fronteira cruzando identificadores do seed contra o código do motor. |
| 2026-08-03 | E1 E2 | ✅ | Dicionário de colunas + fatos de tabela (`schema/dictionary.ts`, `schema/tableFacts.ts`): classificação por nome (natureza meta/realizado, acumulada, sexo, faixa, período, unidade taxa/absoluto) e fatos de nível-tabela (data do evento, datas alternativas, join obrigatório para período, faixas sobrepostas). |
| 2026-08-03 | E3 | ✅ | **6 guardas semânticas** (`agents/sqlGuards.ts`) que bloqueiam SQL plausível-porém-errado *antes* de executar: agregado sobre acumulada, taxa somada, faixas sobrepostas, data de evento errada, período sem join, meta misturada com realizado. Religadas em 4 pontos de `pipeline/ask.ts`. Hint acionável alimenta o retry. |
| 2026-08-03 | E3 | 🔧 | **Verificador reprovou** com 4 falsos positivos; corrigido em `87d6ed9` (+2 casos da mesma família achados na correção). Todos viraram teste de regressão. 59/59 no módulo. |
| 2026-08-03 | E4 | ✅ | Injeção do dicionário no prompt de SQL + poda do contexto de schema (`agents/sqlSemantics.ts`, religado em `agents/sql.ts`). Antes disso o dicionário tinha **um só consumidor** (as guardas) — o motor punia o modelo por não saber o que nunca lhe foi contado. |
| 2026-08-03 | E4 | 🔧 | **Verificador reprovou** com 2 bloqueantes: poda escondia a coluna de join que o próprio cabeçalho mandava usar (3 de 4 tabelas `requires-join`), e aviso por-tabela não cobria guarda cross-table. Corrigido em `638f6ca`, com não-vacuidade provada por neutralização. |
| 2026-08-03 | E5 | ✅ | Catálogo de **métricas canônicas** no seed + `schema/metrics.ts`. Fórmula, grão, sinônimos e armadilhas por métrica, para que a mesma pergunta em duas formulações não gere dois números. |

**Testes.** `npm --workspace apps/api test` → **591 testes, 0 falhas**. Runner é `tsx --test` com `node:test`; **zero dependência nova**. `tsconfig.json` exclui `src/**/*.test.ts` do build.
⚠️ Rodar com `npm test`, **não** com `npx vitest` — o repo não usa vitest, e ele coleta os arquivos e reporta falso vermelho.

### Desvios deliberados do plano

**#3 — o blocklist NÃO foi reduzido (passo 3 do escopo não executado, de propósito).**
O plano previa remover `into`, `set`, `call`, `declare`, `cursor`, `bulk` e ter usuário read-only como pré-requisito de infra. Ao implementar, ficou claro que a causa raiz é outra: as checagens rodavam sobre a **string crua**. Com `scanSql` apagando literais, identificadores citados e comentários (preservando o comprimento, então todos os offsets seguem válidos), **todo** falso positivo relatado desaparece sem tocar no blocklist. Manter a lista inteira passa a custar zero e preserva defesa em profundidade — `into` em particular é perigoso de verdade (`SELECT ... INTO nova_tabela` escreve). Detalhe: `\bset\b` nunca casou dentro de `OFFSET` — é palavra única, sem word boundary ali.
**Consequência para o plano:** o risco transversal "#3 não pode ir antes do usuário read-only" **não se aplica mais a este item**. O usuário read-only continua sendo a garantia correta e deve ser feito, mas deixou de ser bloqueador do #3.

**#1 — a detecção mora dentro de `summarizeResult`, não como campo novo de history.**
O escopo pedia `summaryYearMismatch: true` no doc de history. Implementei como `sqlYears` + `yearMismatch` no retorno de `SummaryResult`, com o warning `[summary-year-mismatch]`. Motivo: gravar no history exigiria editar 6+ literais de objeto inline espalhados, para um campo que nenhum consumidor lê ainda. Dentro de `summarizeResult` é **um** ponto e os 4 call sites herdam. Quando o eval (#11) precisar do campo persistido, ele já vem pronto no retorno — é só passar adiante.

**#7 — `responsePath` existe na função, mas o LLM ainda não o emite (passo 3 parcial).**
`extractRows(data, responsePath?)` já aceita e honra o path explícito, com precedência sobre a heurística. O que ficou de fora é o ingest/prompt preencher esse campo. Motivo: o tipo do step já tem `extractFrom` + `dependsOn` com semântica **diferente** (encadeamento entre steps, não extração de rows) — conflatar os dois seria errado, e um campo novo exigiria mexer em `packages/shared` + prompts de `agents/http.ts` sem eval para validar. Fica para depois do W0.

**#4 — options object em vez de 10º parâmetro posicional.**
O escopo dizia "adicionar `environmentId?: string` na assinatura". `answerQuestionApi` já tinha 9 posicionais; o bug em reparo é exatamente um posicional silenciosamente não passado. Com 1 call site só, converter para `AnswerQuestionApiOptions` custa nada e mata a classe de bug em vez de uma instância dela.

**#4 — ambiente inexistente falha alto em vez de cair no default.**
Não estava no escopo. `getEnvironment(id)` retornando `null` cairia de volta no comportamento antigo (`environments[0]`) — o próprio bug. Agora retorna erro explícito `Ambiente <id> nao encontrado.`

**#5 — `cachedEndpoints` virou `Map` keyed por coleção (não estava no escopo).**
Era um único slot module-level. Religar `search`/`upsert`/`scroll` por ambiente sem isso deixaria o grafo do ambiente A respondendo perguntas do ambiente B por até 5 min — o isolamento pareceria feito e não estaria.

**#6 — default é `["GET"]` (opt-in), não `["GET","POST"]` como o plano recomendava.**
Decisão do usuário depois de eu levantar o tradeoff. O plano sugeria liberar POST de consulta por default, mas `DESTRUCTIVE_METHODS` inclui POST **e** `apiReadOnly` defaulta para `true` — ou seja, o default do plano faria **todo** ambiente read-only pré-existente passar a poder disparar POST sem ninguém pedir. Com opt-in, ambiente legado (sem o campo) resolve para `["GET"]` e se comporta exatamente como hoje; quem quiser POST lista `["GET","POST"]` explicitamente.

**#6 — a isenção de read-only é só para POST, não para todo método allowlistado.**
Primeira versão fazia `isDestructive = DESTRUCTIVE_METHODS.includes(method) && !allowedMethods.includes(method)`, depois de um gate que já garantia pertinência à allowlist — então `isDestructive` era sempre `false` e o branch `readOnly && isDestructive` ficava **inalcançável**: um `DELETE` colocado em `apiIngestMethods` furava o `apiReadOnly` em silêncio. Corrigido para `&& method !== "POST"`. Racional: allowlistar POST é a declaração "POST é consulta nesta API"; PUT/PATCH/DELETE não têm leitura read-only possível, então allowlistá-los (para indexar) não pode torná-los executáveis sob read-only. Coberto por teste de regressão em `httpValidation.test.ts`.

**#6 — o fallback depende de `readOnly` em vez de ser `["GET"]` fixo.**
Consequência de manter compatibilidade: antes do campo existir, `validateHttpRequest` liberava qualquer `VALID_METHODS` quando `readOnly` era `false`. Defaultar para `["GET"]` incondicionalmente quebraria todo ambiente rodando `apiReadOnly: false` de propósito para escrever. Fallback é `readOnly ? ["GET"] : [...VALID_METHODS]`.

**#6 — `apiIngestMethods` ainda não tem UI.** Configurável só via API (`POST/PUT /api/environments`, `POST /api/config`). Falta expor em `frontend/src/types/index.ts` + tela de ambiente.

**#6 — parser e executor não precisaram de mudança.** `parseSwaggerSpec` já varria os 7 métodos e `httpExecutor` já montava body para qualquer método. O passo 4 do escopo era no-op; o bloqueio real era só a política.

**Pendência conhecida (não é desvio de item):** `/api/settings/reset-environment` (`routes/settings.ts:113-122`) chama `clearEndpointCache()`, `clearSchemaCollection()` e `clearEndpointCollection()` **sem argumento**, então as coleções por ambiente sobrevivem a um "reset tudo". Não corrigido de propósito: ampliar uma operação destrutiva é decisão do usuário.

**#7 — colunas passaram a ser a união das chaves de todas as rows** (antes: `Object.keys(allRows[0]!)`). Não estava no escopo, mas é a mesma falha: registro desembrulhado é frequentemente esparso, e chavear pela row 0 descartava em silêncio toda coluna que ela por acaso omitisse. Sem isso o #7 entregaria rows certas com colunas faltando.

---

# Trilho E0–E5 — Assertividade semântica (2026-08-03)

Trilho paralelo à numeração `#1`–`#14`. Nasceu do mesmo diagnóstico do `#12`, mas foi mais fundo: o problema não era só o modelo **não recuperar** a tabela certa, era ele gerar SQL que **roda sem erro e devolve o número errado**. Nenhuma validação estrutural pega isso — `validateSql` checa segurança e forma, não semântica.

| Etapa | Entrega | Arquivos |
|-------|---------|----------|
| E0 | Fronteira domínio↔motor; vocabulário vira seed versionado | `seeds/avicultura.json`, `schema/vocabulary.ts` |
| E1 | Dicionário de colunas (classificação por nome) | `schema/dictionary.ts`, `schema/dictionaryOps.ts` |
| E2 | Fatos de nível-tabela | `schema/tableFacts.ts` |
| E3 | 6 guardas semânticas pré-execução | `agents/sqlGuards.ts` |
| E4 | Injeção no prompt + poda de contexto | `agents/sqlSemantics.ts` |
| E5 | Catálogo de métricas canônicas | `schema/metrics.ts` |

## Desvios e lições

**O dicionário nasceu sem consumidor.** E1/E2 construíram o dicionário e só as guardas (E3) o liam. Ou seja: por duas etapas o sistema **punia o modelo por não saber uma coisa que ninguém contou a ele**. O E4 é que fecha o laço. Isto é o padrão "foundational com N consumidores" já registrado nos riscos transversais deste plano — reincidiu mesmo estando escrito.

**Os dois verificadores reprovaram, e a suíte não pegava nada.** E3 fechou com 42 testes verdes e 4 falsos positivos; E4 com 32 verdes e 2 bloqueantes. Em ambos os casos os testes cobriam o caminho que o autor tinha em mente. Falso positivo em guarda **não tem sintoma visível** — a pergunta certa é rejeitada com uma mensagem convincente.

**Falso positivo de guarda é pior que falta de guarda.** No E3, a guarda de data do evento disparava com qualquer menção a data alternativa (até `IS NULL`) e o hint mandava o modelo *trocar a coluna de data*. Resultado: pergunta certa vira **outra pergunta**, respondida com número bem formatado. Sem guarda, o usuário recebe um número suspeito; com guarda ruim, recebe um número errado com aparência de auditado. Daí a regra escrita no topo do módulo: **silêncio na dúvida** — na incerteza, preferir o falso negativo.

**Guardas raciocinam entre tabelas, o prompt raciocinava por tabela.** Os dois bloqueantes do E4 são a mesma fratura por dois ângulos: a poda decidia por tabela e escondia coluna que outra tabela precisava para o join; o aviso decidia por tabela e silenciava quando meta e realizado ficavam em tabelas diferentes. Qualquer coisa nova injetada no prompt herda essa fratura por default — métrica com numerador e denominador em tabelas distintas é o caso **normal**, não a exceção.

**A fronteira E0 ficou opt-out com catraca, não opt-in.** O teste de fronteira varre todo valor string do seed. Quando o E5 acrescentou prosa (`label`, `pitfalls`), palavras comuns (`que`, `para`, `sum`) viraram "termo de domínio proibido" e 10 testes caíram. A correção instintiva é inverter para opt-in (varrer só campos declarados como identificador) — **e está errada**: opt-in falha calado (campo de identificador novo deixa de ser varrido e a fronteira encolhe sem avisar), opt-out falha alto (campo de prosa novo deixa a suíte vermelha e alguém decide). Para guarda de fronteira, prefere-se o modo que grita. Ficou opt-out + asserção de tamanho em `ENGINE_WORDS` (≤3) e `NON_IDENTIFIER_FIELDS` (≤12), que quebra o build quando a válvula de escape cresce.

**Não-vacuidade tem que ser provada, não afirmada.** A correção do E4 foi validada por neutralização: desliga a correção → caem exatamente 4 testes do D1 e 2 do D2; religa → 32/32. Um dos testes existe só para impedir que o invariante passe por vacuidade (assegura que o schema real tem ao menos uma tabela `requires-join` com 2+ colunas de join). Sem isso, o invariante passaria num schema onde ele nunca é exercido.

## Pendências do trilho

- **Custo do prompt.** O bloco semântico adiciona texto ao prompt de SQL e a poda não compensa integralmente. Medir contra o eval (`#11`) antes de assumir que o ganho de assertividade paga a latência e o token.
- **Dicionário pré-E2 desliga todas as guardas em silêncio.** `factsFromDictionary` devolve 0 registros, `semanticGuards` fica `null`, e o `catch {}` em `ask.ts` não loga. Em produção é indistinguível de "nenhum SQL suspeito". Falta telemetria.
- **`makeResolver` é quase no-op.** `ColumnClass` é derivada do nome, então homônimos em tabelas diferentes recebem a mesma classe e o consenso nunca diverge. Não causa falso positivo; apenas não entrega a proteção que aparenta.
- **`seeds/` nunca foi versionado.** O diretório inteiro está untracked.
- **Nada disso foi medido no eval.** Todo o trilho está validado por teste unitário e por verificação adversarial, não por `#11`. A baseline continua não gravada.
