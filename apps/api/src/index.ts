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
import taskRoutes from "./routes/task.js";
import reposRoutes from "./routes/repos.js";
import projectsRoutes from "./routes/projects.js";
import trelloWebhookRoutes from "./routes/trelloWebhook.js";
import trelloRoutes from "./routes/trello.js";
import whatsappRoutes from "./routes/whatsapp.js";
import previewRoutes from "./routes/preview.js";
import { ensureInboxProject } from "./helpers/projectsBootstrap.js";
import { startWhatsappBot } from "./services/whatsappBot.js";
import { startScheduler } from "./services/scheduler.js";
import { startPreviewCleanup, releaseOrphanedPreviews } from "./services/previewCleanup.js";

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
await app.register(taskRoutes);
await app.register(reposRoutes);
await app.register(projectsRoutes);
await app.register(trelloWebhookRoutes);
await app.register(trelloRoutes);
await app.register(whatsappRoutes);
await app.register(previewRoutes);

// ── Startup ────────────────────────────────────────────────────────
await ensureDefaultSettings();
await ensureUsersIndex();
await ensureInboxProject();

// Boot do bot WhatsApp — no-op se whatsappEnabled=false. Nao bloqueia listen.
void startWhatsappBot().catch(err => app.log.warn({ err }, "whatsapp bot disabled"));

// Boot do scheduler (tick 60s, dispara tarefas/jobs agendados).
void startScheduler().catch(err => app.log.warn({ err }, "scheduler failed to start"));

// Preview deploys: limpa orphans + inicia loop de TTL.
void releaseOrphanedPreviews().catch(err => app.log.warn({ err }, "releaseOrphanedPreviews failed"));
startPreviewCleanup();

app.listen({ port: config.port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
