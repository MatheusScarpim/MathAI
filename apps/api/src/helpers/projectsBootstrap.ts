import {
  getProjectsCollection,
  getTasksCollection,
  type ProjectRecord
} from "../core/mongo.js";

/**
 * Garante que existe um projeto Inbox global (sem userId) e migra
 * tasks existentes sem `projectId` para ele.
 *
 * Idempotente — pode rodar em todo startup.
 */
export const ensureInboxProject = async (): Promise<string> => {
  const projectsCol = await getProjectsCollection();
  const tasksCol = await getTasksCollection();

  let inbox = await projectsCol.findOne({ isInbox: true, userId: { $exists: false } });
  if (!inbox) {
    const now = new Date();
    const doc: ProjectRecord = {
      name: "Inbox",
      description: "Tarefas sem projeto especifico",
      repoIds: [],
      isInbox: true,
      createdAt: now,
      updatedAt: now
    };
    const { insertedId } = await projectsCol.insertOne(doc);
    inbox = { ...doc, _id: insertedId };
  }

  const inboxId = inbox._id!.toString();

  // Migracao one-shot: associa tasks legadas (sem projectId) ao Inbox
  const result = await tasksCol.updateMany(
    { projectId: { $exists: false } },
    { $set: { projectId: inboxId, updatedAt: new Date() } }
  );
  if (result.modifiedCount > 0) {
    console.info(`[projects] migrated ${result.modifiedCount} legacy task(s) to Inbox`);
  }

  return inboxId;
};
