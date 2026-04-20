import type { FastifyInstance } from "fastify";
import { isNonEmptyString } from "@auraia/shared";
import { ObjectId } from "mongodb";
import { getInstructionsCollection } from "../core/mongo.js";

export default async function instructionsRoutes(app: FastifyInstance) {
  app.post("/api/instructions", async (request, reply) => {
    const body = request.body as { text?: string; tableFullName?: string };
    if (!isNonEmptyString(body?.text)) {
      reply.status(400).send({ errorMessage: "Campo text obrigatorio." });
      return;
    }
    const trimmed = body.text!.trim();
    if (trimmed.length > 2000) {
      reply.status(400).send({ errorMessage: "Instrucao muito longa (max 2000)." });
      return;
    }

    const collection = await getInstructionsCollection();
    const createdAt = new Date();
    const tableFullName = body.tableFullName?.trim() || undefined;

    const result = await collection.insertOne({
      text: trimmed,
      tableFullName,
      createdAt
    });

    reply.send({
      id: result.insertedId.toString(),
      text: trimmed,
      tableFullName,
      createdAt: createdAt.toISOString()
    });
  });

  app.get("/api/instructions", async (_request, reply) => {
    const collection = await getInstructionsCollection();
    const docs = await collection
      .find({})
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    reply.send(
      docs.map((doc) => ({
        id: doc._id?.toString() ?? "",
        text: doc.text,
        tableFullName: doc.tableFullName,
        createdAt: doc.createdAt.toISOString()
      }))
    );
  });

  app.delete("/api/instructions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    if (!id || !ObjectId.isValid(id)) {
      reply.status(400).send({ errorMessage: "Id invalido." });
      return;
    }

    const collection = await getInstructionsCollection();
    const result = await collection.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      reply.status(404).send({ errorMessage: "Instrucao nao encontrada." });
      return;
    }

    reply.send({ ok: true });
  });
}
