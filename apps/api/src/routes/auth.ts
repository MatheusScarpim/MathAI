import type { FastifyInstance } from "fastify";
import {
  registerUser,
  authenticateUser,
  ensureUsersIndex,
  isAuthEnabled,
  setAuthEnabled,
  hasAnyUser
} from "../core/auth.js";

export default async function authRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] ?? request.url;

    if (
      url === "/api/auth/login" ||
      url === "/api/auth/status" ||
      url === "/api/auth/logout" ||
      url === "/docs" ||
      url.startsWith("/docs/")
    ) {
      return;
    }

    // Register: allow without token only when auth is disabled OR no users exist yet
    if (url === "/api/auth/register") {
      const enabled = await isAuthEnabled();
      if (!enabled) return;
      const usersExist = await hasAnyUser();
      if (!usersExist) return;
      // Otherwise fall through to JWT verification below
    }

    // Auth toggle: if auth is currently off, allow (user is enabling it).
    // If auth is currently on, require JWT (user is disabling it).
    if (url === "/api/auth/toggle") {
      const currentlyEnabled = await isAuthEnabled();
      if (!currentlyEnabled) return;
      // Auth is on — disabling requires authentication, fall through to JWT check
    }

    if (!url.startsWith("/api/")) {
      return;
    }

    const enabled = await isAuthEnabled();
    if (!enabled) return;

    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ errorMessage: "Unauthorized" });
    }
  });

  app.get("/api/auth/status", { schema: { tags: ["auth"] } }, async () => {
    const enabled = await isAuthEnabled();
    return { enabled };
  });

  app.put<{ Body: { enabled: boolean } }>(
    "/api/auth/toggle",
    {
      schema: {
        tags: ["auth"],
        body: {
          type: "object",
          required: ["enabled"],
          properties: {
            enabled: { type: "boolean" }
          }
        }
      }
    },
    async (request) => {
      await setAuthEnabled(request.body.enabled);
      if (request.body.enabled) {
        await ensureUsersIndex();
      }
      return { ok: true, enabled: request.body.enabled };
    }
  );

  app.post<{ Body: { username: string; password: string } }>(
    "/api/auth/register",
    {
      config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        body: {
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string" },
            password: { type: "string" }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const { username, password } = request.body;
        const user = await registerUser(username, password);
        const token = app.jwt.sign({ sub: user.id, username: user.username });
        reply
          .setCookie("auraia_token", token, {
            httpOnly: true,
            secure: request.protocol === "https",
            sameSite: "lax",
            path: "/api",
            maxAge: 7 * 24 * 60 * 60
          })
          .send({ ok: true, token });
      } catch (err: any) {
        reply.code(400).send({ errorMessage: err.message });
      }
    }
  );

  app.post<{ Body: { username: string; password: string } }>(
    "/api/auth/login",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        body: {
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string" },
            password: { type: "string" }
          }
        }
      }
    },
    async (request, reply) => {
      const { username, password } = request.body;
      const user = await authenticateUser(username, password);
      if (!user) {
        reply.code(401).send({ errorMessage: "Credenciais inválidas" });
        return;
      }
      const token = app.jwt.sign({ sub: user.id, username: user.username });
      reply
        .setCookie("auraia_token", token, {
          httpOnly: true,
          secure: request.protocol === "https",
          sameSite: "lax",
          path: "/api",
          maxAge: 7 * 24 * 60 * 60 // 7 days
        })
        .send({ ok: true, token });
    }
  );

  app.post("/api/auth/logout", { schema: { tags: ["auth"] } }, async (_request, reply) => {
    reply
      .clearCookie("auraia_token", { path: "/api" })
      .send({ ok: true });
  });
}
