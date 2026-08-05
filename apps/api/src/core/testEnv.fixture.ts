/**
 * Preenche o env minimo para importar modulos que puxam `core/config`.
 *
 * `config.ts` faz `process.exit(1)` sem `JWT_SECRET`, no topo do modulo. Isso
 * e certo em producao — subir sem segredo e pior do que nao subir — mas
 * impede que um teste importe qualquer coisa a jusante de `core/openai`.
 *
 * Ate aqui a saida dos testes era desviar: `dictionary.test.ts` documenta que
 * NAO importa `dictionary.ts` por causa disso. Serve para o que aquele arquivo
 * testa, mas nao serve para teste de FIACAO, onde o ponto e justamente
 * atravessar o modulo de verdade em vez de uma copia pura dele.
 *
 * Importe como efeito colateral, ANTES do modulo sob teste — imports estaticos
 * de ESM avaliam na ordem em que aparecem:
 *
 *   import "../core/testEnv.fixture.js";
 *   import { buildPrompt } from "./sql.js";
 *
 * Nao sobrescreve o que ja existe: se a maquina tem `.env`, ele manda.
 */

process.env.JWT_SECRET ||= "test-only-secret-nao-usado-para-assinar-nada";
