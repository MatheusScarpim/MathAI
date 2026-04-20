import { sanitizeErrorMessage } from "@auraia/shared";
import { getProcessingJobsCollection } from "../core/mongo.js";
import { ObjectId } from "mongodb";

export const sendWebhookNotification = async (
  processingId: string,
  payload: {
    status: "completed" | "failed";
    result?: unknown;
    error?: unknown;
  }
): Promise<string | null> => {
  const collection = await getProcessingJobsCollection();
  const job = await collection.findOne({ _id: new ObjectId(processingId) });
  const webhookUrl = job?.webhookUrl?.trim();
  if (!webhookUrl) return null;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "ask.processing.finished",
        processingId,
        status: payload.status,
        finishedAt: new Date().toISOString(),
        result: payload.result,
        error: payload.error
      })
    });

    if (!response.ok) {
      const message = `Webhook HTTP ${response.status}`;
      await collection.updateOne(
        { _id: new ObjectId(processingId) },
        { $set: { webhookError: message, updatedAt: new Date() } }
      );
      return message;
    }

    await collection.updateOne(
      { _id: new ObjectId(processingId) },
      {
        $set: {
          webhookNotifiedAt: new Date(),
          webhookError: "",
          updatedAt: new Date()
        }
      }
    );
    return null;
  } catch (error) {
    const message = sanitizeErrorMessage(
      (error as { message?: string })?.message ?? "Erro ao enviar webhook."
    );
    await collection.updateOne(
      { _id: new ObjectId(processingId) },
      { $set: { webhookError: message, updatedAt: new Date() } }
    );
    return message;
  }
};
