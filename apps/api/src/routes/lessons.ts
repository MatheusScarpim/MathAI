import type { FastifyInstance } from "fastify";
import {
  createLesson,
  listLessons,
  deleteLesson,
  reindexAllLessons,
  searchLessons,
  type LessonCreateInput
} from "../orchestrator/memory/lessons.js";

export default async function lessonsRoutes(app: FastifyInstance) {
  app.post("/api/lessons", async (request, reply) => {
    const body = request.body as Partial<LessonCreateInput>;
    if (!body?.title || typeof body.title !== "string" || body.title.trim().length === 0) {
      reply.status(400).send({ errorMessage: "title obrigatorio." });
      return;
    }
    if (!body?.body || typeof body.body !== "string" || body.body.trim().length === 0) {
      reply.status(400).send({ errorMessage: "body obrigatorio." });
      return;
    }
    if (body.title.length > 200) {
      reply.status(400).send({ errorMessage: "title muito longo (max 200)." });
      return;
    }
    if (body.body.length > 10_000) {
      reply.status(400).send({ errorMessage: "body muito longo (max 10000)." });
      return;
    }
    const lesson = await createLesson({
      title: body.title.trim(),
      body: body.body.trim(),
      tags: Array.isArray(body.tags) ? body.tags.filter(t => typeof t === "string").slice(0, 10) : undefined,
      repoKey: typeof body.repoKey === "string" && body.repoKey.length > 0 ? body.repoKey : undefined
    });
    reply.send(lesson);
  });

  app.get("/api/lessons", async (request, reply) => {
    const q = request.query as { repoKey?: string };
    const lessons = await listLessons(q?.repoKey ? { repoKey: q.repoKey } : undefined);
    reply.send(lessons);
  });

  app.delete("/api/lessons/:lessonId", async (request, reply) => {
    const params = request.params as { lessonId?: string };
    if (!params?.lessonId) {
      reply.status(400).send({ errorMessage: "lessonId obrigatorio." });
      return;
    }
    const ok = await deleteLesson(params.lessonId);
    if (!ok) {
      reply.status(404).send({ errorMessage: "Licao nao encontrada." });
      return;
    }
    reply.send({ ok: true });
  });

  app.post("/api/lessons/reindex", async (_request, reply) => {
    const res = await reindexAllLessons();
    reply.send(res);
  });

  // Search endpoint pra debug/UI (mostra o que o pipeline veria)
  app.get("/api/lessons/search", async (request, reply) => {
    const q = request.query as { q?: string; repoKey?: string; k?: string };
    if (!q?.q || q.q.trim().length === 0) {
      reply.status(400).send({ errorMessage: "Parametro q obrigatorio." });
      return;
    }
    const k = q.k ? Math.max(1, Math.min(10, Number(q.k))) : 3;
    const results = await searchLessons(q.q, {
      k,
      repoKey: q.repoKey
    });
    reply.send(results);
  });
}
