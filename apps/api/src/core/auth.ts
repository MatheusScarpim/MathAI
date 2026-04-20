import { type Collection, type ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import { getMongoClient, getSettingsCollection } from "./mongo.js";
import { config } from "./config.js";

export type UserRecord = {
  _id?: ObjectId;
  username: string;
  passwordHash: string;
  createdAt: Date;
};

const getUsersCollection = async (): Promise<Collection<UserRecord>> => {
  const mongo = await getMongoClient();
  return mongo.db(config.mongo.db).collection<UserRecord>("users");
};

export const ensureUsersIndex = async (): Promise<void> => {
  const col = await getUsersCollection();
  await col.createIndex({ username: 1 }, { unique: true });
};

export const registerUser = async (
  username: string,
  password: string
): Promise<{ id: string; username: string }> => {
  if (!username || username.length < 3) {
    throw new Error("Username deve ter pelo menos 3 caracteres");
  }
  if (!password || password.length < 8) {
    throw new Error("Senha deve ter pelo menos 8 caracteres");
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new Error("Senha deve conter pelo menos 1 letra e 1 numero");
  }

  const col = await getUsersCollection();

  const existing = await col.findOne({ username });
  if (existing) {
    throw new Error("Username já está em uso");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = await col.insertOne({
    username,
    passwordHash,
    createdAt: new Date()
  });

  return { id: result.insertedId.toHexString(), username };
};

export const isAuthEnabled = async (): Promise<boolean> => {
  const col = await getSettingsCollection();
  const doc = await col.findOne({ key: "auth_enabled" });
  return doc?.value === true;
};

export const setAuthEnabled = async (enabled: boolean): Promise<void> => {
  const col = await getSettingsCollection();
  await col.updateOne(
    { key: "auth_enabled" },
    { $set: { value: enabled, updatedAt: new Date() } },
    { upsert: true }
  );
};

export const hasAnyUser = async (): Promise<boolean> => {
  const col = await getUsersCollection();
  const user = await col.findOne({}, { projection: { _id: 1 } });
  return user !== null;
};

export const authenticateUser = async (
  username: string,
  password: string
): Promise<{ id: string; username: string } | null> => {
  const col = await getUsersCollection();
  const user = await col.findOne({ username });
  if (!user) return null;

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;

  return { id: user._id!.toHexString(), username: user.username };
};
