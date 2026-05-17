/**
 * Pre-load para `npm test`. Garante env vars dummies pra config.ts nao crashar
 * ao subir Mongo/core imports nos testes unitarios. Idempotente: nao sobrescreve
 * env real (CI/prod) caso ja exista.
 */

process.env.JWT_SECRET ??= "test-only-dummy-secret-min-32-chars-please";
process.env.CONFIG_SECRET ??= "test-only-config-secret-min-32-chars-x";
process.env.NODE_ENV ??= "test";
