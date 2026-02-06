# AuraIA SQL (MVP)

Aplicacao completa para consultas em SQL Server usando IA com seguranca, RAG por tabela e expansao por Foreign Keys.

## Stack
- Backend: Node.js + TypeScript + Fastify (`apps/api`)
- Vector DB: Qdrant (Docker)
- SQL Server: pacote `mssql`
- LLM: OpenAI API
- MongoDB: armazenamento de instrucoes

## Requisitos
- Node.js 20+
- Docker (para Qdrant)
- Acesso a um SQL Server externo
- Acesso a um MongoDB externo

## Subir tudo com Docker (API + Qdrant + Mongo)
```bash
docker compose -f infra/docker-compose.yml up -d --build
```

## Subir apenas o Qdrant
```bash
docker compose -f infra/docker-compose.yml up -d
```

## Configurar variaveis de ambiente
Copie `.env.example` e ajuste os valores:
```bash
copy .env.example .env
```

Variaveis importantes:
- `OPENAI_API_KEY`
- `SQL_SERVER_HOST`
- `SQL_SERVER_PORT` (padrao `1433`)
- `SQL_SERVER_DB`
- `SQL_SERVER_USER`
- `SQL_SERVER_PASSWORD`
- `QDRANT_URL` (padrao `http://localhost:6333`)
- `MONGO_URL` (padrao `mongodb://localhost:27017`)
- `MONGO_DB` (padrao `auraia`)
- `REDIS_URL` (padrao `redis://localhost:6379`)
- `REDIS_TTL_SECONDS` (padrao `900`)
- `PORT` (API, padrao `3001`)

## Rodar a API
```bash
npm install
npm run dev:api
```

## Criar usuario read-only no SQL Server
Execute como admin no seu SQL Server (ajuste nomes):
```sql
CREATE LOGIN auraia_ro WITH PASSWORD = 'SenhaForteAqui!';
CREATE USER auraia_ro FOR LOGIN auraia_ro;
ALTER ROLE db_datareader ADD MEMBER auraia_ro;
DENY INSERT, UPDATE, DELETE, ALTER, EXECUTE TO auraia_ro;
```

## Indexar schema
Chame o endpoint:
```bash
curl -X POST http://localhost:3001/api/ingest/schema
```

## Salvar instrucoes
```bash
curl -X POST http://localhost:3001/api/instructions ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"Nao usar tabela de testes\"}"
```

## Listar instrucoes salvas
```bash
curl http://localhost:3001/api/instructions
```

## Historico de perguntas (Mongo)
Listar:
```bash
curl http://localhost:3001/api/history
```

Favoritar e adicionar tags:
```bash
curl -X PATCH http://localhost:3001/api/history/ID_AQUI ^
  -H "Content-Type: application/json" ^
  -d "{\"favorite\":true,\"tags\":[\"financeiro\",\"mensal\"]}"
```

O historico registra: sucesso/erro, tempo (ms), contagem de linhas e linguagem. Entradas favoritas sao usadas como exemplos (few-shot) quando uma pergunta parecida aparecer.

## Perguntar
```bash
curl -X POST http://localhost:3001/api/ask ^
  -H "Content-Type: application/json" ^
  -d "{\"question\":\"vendas dos ultimos 30 dias por cliente\",\"chatId\":\"cliente-01\",\"language\":\"pt\"}"
```

O response inclui `historyId` para facilitar o like/dislike no frontend.

## Observacoes de seguranca
- O usuario do SQL Server deve ser read-only.
- A API valida SQL (apenas SELECT, sem keywords destrutivas).
- Sempre exige TOP e limita a 500 linhas.
- Timeout de query configurado para 20s.
- Rate limit simples em `/api/ask` por IP.

## Estrutura
- `apps/api` backend Fastify
- `packages/shared` tipos e utilitarios
- `infra/docker-compose.yml` Qdrant
