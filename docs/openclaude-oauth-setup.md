# OpenClaude OAuth Setup (multi-provider fleet)

O orchestrator usa um **fleet** de 3 containers OpenClaude, um por provedor
(Anthropic, Codex/OpenAI, DeepSeek). O router determinístico (Settings →
Roteamento de Modelos) escolhe qual container executa cada subtask.

Este documento cobre o **bootstrap one-time** dos OAuth logins. Tokens
persistem nos volumes `openclaude_<provider>_home` e sobrevivem a restarts.

---

## 1. Subir o fleet

```bash
docker compose up -d openclaude-anthropic openclaude-codex openclaude-deepseek
```

Confirme que estão rodando:

```bash
docker ps --filter "name=mathai-openclaude" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

Esperado: 3 containers `mathai-openclaude-{anthropic,codex,deepseek}`.

---

## 2. Login Anthropic (OAuth Claude.ai)

```bash
docker exec -it mathai-openclaude-anthropic bun run cli
```

Dentro do REPL do OpenClaude:

```
/provider
```

- Escolha **Create new provider** → **Anthropic**
- Quando perguntar credencial, digite `/login` → abre `claude.ai` no navegador → autorize
- O OpenClaude grava o token em `/root/.config/openclaude/`
- `/exit`

**Validar:**
```bash
docker exec mathai-openclaude-anthropic ls /root/.config/openclaude/
# espera ver arquivos de credencial
```

---

## 3. Login Codex (OAuth ChatGPT)

```bash
docker exec -it mathai-openclaude-codex bun run cli
```

```
/provider
```

- **Create new provider** → **Codex (ChatGPT OAuth)**
- Segue o fluxo do browser (sign in com sua conta ChatGPT)
- `/exit`

---

## 4. DeepSeek (sem login interativo)

DeepSeek usa API key direto via env. No `.env`:

```ini
DEEPSEEK_API_KEY=sk-...
```

O container `mathai-openclaude-deepseek` já lê isso automaticamente
(via `OPENAI_API_KEY` interno + `OPENAI_BASE_URL=https://api.deepseek.com`).
Nenhum `docker exec` necessário.

---

## 5. Validar fleet

```bash
curl -s http://localhost:3001/api/settings/openclaude-providers/health | jq
```

Esperado:
```json
{
  "anthropic": { "url": "openclaude-anthropic:50051", "status": "ok" },
  "codex":     { "url": "openclaude-codex:50051",     "status": "ok" },
  "deepseek":  { "url": "openclaude-deepseek:50051",  "status": "ok" }
}
```

Em `Settings → Roteamento de Modelos` o painel de status mostra 🟢🟢🟢.

---

## 6. Testar roteamento

No UI:
- **Settings → Roteamento de Modelos → Testar regra**
- Agent: `taskCode`, Type: `github`, Description: `atualizar Calculator.vue`
- Rodar → mostra `{ provider: "anthropic", model: "claude-sonnet-4-5", reason: "rule p=10 ..." }`

Ou via curl:
```bash
curl -X POST http://localhost:3001/api/settings/routing-rules/test \
  -H 'Content-Type: application/json' \
  -d '{"agent":"taskCode","type":"github","description":"atualizar Calculator.vue"}' | jq
```

---

## Troubleshooting

### "OAuth token expirou" ou provedor cai com 401
- Re-rode o passo de login no container correspondente
- Tokens normalmente duram dias/semanas dependendo do provider

### Volume `openclaude_<p>_home` foi deletado
- OAuth é perdido. Refazer login.

### Container não inicializa (build trava)
- 3 containers clonam OpenClaude em paralelo. Em rede lenta, pode demorar ~5min total.
- Veja `docker logs mathai-openclaude-anthropic -f` pra acompanhar.

### Quero rodar planner/reviewer/reporter via OAuth (não só taskCode)
- Não suportado atualmente. Esses agentes usam OpenAI SDK direto (API key, não OAuth).
- Para Anthropic/Codex nos não-código, defina `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` no `.env`.
- Sem essas keys, o router cai automaticamente em DeepSeek pros não-código (regra default).

### Sandbox escape (agente escrevendo em `/openclaude/...`)
- Já mitigado em 4 camadas (ver `memory/feedback_openclaude_worktree_sandbox_escape.md`).
- Se voltar a aparecer em algum provedor específico, abra issue mencionando o nome do container.

---

## Referências

- Plano: `.claude/plans/bubbly-juggling-fiddle.md`
- Memo histórico do escape: `memory/feedback_openclaude_worktree_sandbox_escape.md`
- Memo do boundary OpenClaude: `memory/feedback_openclaude_repo_boundary.md`
