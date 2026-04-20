import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastifyCookie from "@fastify/cookie";
import fastifyJwt from "@fastify/jwt";
import { config } from "./core/config.js";
import { sanitizeErrorMessage } from "@auraia/shared";
import { ensureDefaultSettings } from "./helpers/settings.js";
import { ensureUsersIndex } from "./core/auth.js";

// Route modules
import authRoutes from "./routes/auth.js";
import configRoutes from "./routes/config.js";
import askRoutes from "./routes/ask.js";
import historyRoutes from "./routes/history.js";
import schemaRoutes from "./routes/schema.js";
import environmentsRoutes from "./routes/environments.js";
import settingsRoutes from "./routes/settings.js";
import instructionsRoutes from "./routes/instructions.js";
import statsRoutes from "./routes/stats.js";

const app = Fastify({
  logger: true,
  bodyLimit: 1_000_000
});

// ── Plugins ────────────────────────────────────────────────────────
await app.register(cors, {
  origin: config.corsOrigin === "*" ? true : config.corsOrigin.split(",").map(s => s.trim()),
  credentials: true
});
await app.register(rateLimit, { global: false });
await app.register(swagger, {
  openapi: {
    info: {
      title: "MathAI API",
      description: "Documentacao da API do MathAI",
      version: "1.0.0"
    }
  }
});
await app.register(swaggerUi, {
  routePrefix: "/docs",
  uiConfig: { docExpansion: "list", deepLinking: false },
  staticCSP: false
});
await app.register(fastifyCookie);
await app.register(fastifyJwt, {
  secret: config.jwt.secret,
  sign: { expiresIn: config.jwt.expiresIn },
  cookie: { cookieName: "auraia_token", signed: false }
});

// ── Error handler ──────────────────────────────────────────────────
app.setErrorHandler((error, _request, reply) => {
  app.log.error({ err: error }, "request failed");
  const message = sanitizeErrorMessage(
    typeof error?.message === "string" ? error.message : "Erro interno."
  );
  reply.status(500).send({ errorMessage: message });
});

// ── Routes ─────────────────────────────────────────────────────────
await app.register(authRoutes);
await app.register(configRoutes);
await app.register(askRoutes);
await app.register(historyRoutes);
await app.register(schemaRoutes);
await app.register(environmentsRoutes);
await app.register(settingsRoutes);
await app.register(instructionsRoutes);
await app.register(statsRoutes);

// ── Startup ────────────────────────────────────────────────────────
await ensureDefaultSettings();
await ensureUsersIndex();

app.listen({ port: config.port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
