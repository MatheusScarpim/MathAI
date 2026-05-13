/**
 * Adapter de AuthenticationState pro Baileys backed por MongoDB.
 *
 * Substitui useMultiFileAuthState (que escreve em filesystem). Vantagens:
 *  - Sobrevive a redeploys sem volume Docker dedicado
 *  - Backup junto do Mongo
 *  - Single source of truth pra status (paired/unpaired/logged_out)
 *
 * Encripta tudo com whatsappCrypto (key derivada de CONFIG_SECRET com salt dedicado).
 */

import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
  type SignalDataSet
} from "@whiskeysockets/baileys";
import {
  getWhatsappAuthCredsCollection,
  getWhatsappAuthKeysCollection
} from "../core/mongo.js";
import { encryptBuffer, decryptBuffer } from "../core/whatsappCrypto.js";

const CREDS_ID = "creds" as const;

/** Serializa qualquer estrutura Baileys (com Buffers) em string JSON. */
const serialize = (value: unknown): string =>
  JSON.stringify(value, BufferJSON.replacer);

/** Desserializa string JSON pra estrutura com Buffers restaurados. */
const deserialize = <T>(raw: string): T =>
  JSON.parse(raw, BufferJSON.reviver) as T;

/**
 * Carrega o auth state inteiro do Mongo (cria fresh se nao existir),
 * retorna { state, saveCreds, markPaired, markLoggedOut, getStatus }.
 *
 * Uso:
 *   const auth = await useMongoAuthState();
 *   const sock = makeWASocket({ auth: auth.state, ... });
 *   sock.ev.on("creds.update", auth.saveCreds);
 */
export const useMongoAuthState = async (): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  markPaired: (phoneNumber: string) => Promise<void>;
  markLoggedOut: () => Promise<void>;
  markConnected: () => Promise<void>;
  clear: () => Promise<void>;
  getStatus: () => Promise<"unpaired" | "paired" | "logged_out">;
}> => {
  const credsCol = await getWhatsappAuthCredsCollection();
  const keysCol = await getWhatsappAuthKeysCollection();

  // ── Load creds (or init fresh) ────────────────────────────────
  const credsDoc = await credsCol.findOne({ _id: CREDS_ID });
  let creds: AuthenticationCreds;
  if (credsDoc?.encrypted && credsDoc.iv) {
    try {
      const plain = decryptBuffer(credsDoc.encrypted, credsDoc.iv).toString("utf8");
      creds = deserialize<AuthenticationCreds>(plain);
    } catch (err) {
      console.warn("[whatsappAuth] failed to decrypt creds, initializing fresh:", err);
      creds = initAuthCreds();
    }
  } else {
    creds = initAuthCreds();
  }

  // ── Keys store ────────────────────────────────────────────────
  const keys = {
    get: async <T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[]
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
      const docIds = ids.map(id => `${type}:${id}`);
      const docs = await keysCol.find({ _id: { $in: docIds } }).toArray();
      const out: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const doc of docs) {
        try {
          const plain = decryptBuffer(doc.encrypted, doc.iv).toString("utf8");
          let value: unknown = deserialize(plain);
          // app-state-sync-key precisa virar AppStateSyncKeyData via fromObject
          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
          }
          out[doc.id] = value as SignalDataTypeMap[T];
        } catch (err) {
          console.warn(`[whatsappAuth] failed to decrypt key ${doc._id}:`, err);
        }
      }
      return out;
    },
    set: async (data: SignalDataSet): Promise<void> => {
      const ops: Array<Promise<unknown>> = [];
      for (const _type in data) {
        const type = _type as keyof SignalDataTypeMap;
        const bucket = data[type];
        if (!bucket) continue;
        for (const id in bucket) {
          const value = bucket[id];
          const docId = `${type}:${id}`;
          if (value === null || value === undefined) {
            ops.push(keysCol.deleteOne({ _id: docId }));
          } else {
            const blob = encryptBuffer(serialize(value));
            ops.push(
              keysCol.updateOne(
                { _id: docId },
                {
                  $set: {
                    type: type as string,
                    id,
                    encrypted: blob.encrypted,
                    iv: blob.iv,
                    updatedAt: new Date()
                  }
                },
                { upsert: true }
              )
            );
          }
        }
      }
      await Promise.all(ops);
    }
  };

  const saveCreds = async (): Promise<void> => {
    const blob = encryptBuffer(serialize(creds));
    await credsCol.updateOne(
      { _id: CREDS_ID },
      {
        $set: {
          encrypted: blob.encrypted,
          iv: blob.iv,
          updatedAt: new Date()
        },
        $setOnInsert: {
          status: "unpaired"
        }
      },
      { upsert: true }
    );
  };

  const markPaired = async (phoneNumber: string): Promise<void> => {
    await credsCol.updateOne(
      { _id: CREDS_ID },
      {
        $set: {
          status: "paired",
          phoneNumber,
          pairedAt: new Date(),
          lastConnectedAt: new Date(),
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
  };

  const markLoggedOut = async (): Promise<void> => {
    await credsCol.updateOne(
      { _id: CREDS_ID },
      { $set: { status: "logged_out", updatedAt: new Date() } }
    );
  };

  const markConnected = async (): Promise<void> => {
    await credsCol.updateOne(
      { _id: CREDS_ID },
      { $set: { lastConnectedAt: new Date(), updatedAt: new Date() } }
    );
  };

  const clear = async (): Promise<void> => {
    await Promise.all([
      credsCol.deleteOne({ _id: CREDS_ID }),
      keysCol.deleteMany({})
    ]);
  };

  const getStatus = async (): Promise<"unpaired" | "paired" | "logged_out"> => {
    const doc = await credsCol.findOne({ _id: CREDS_ID });
    return doc?.status ?? "unpaired";
  };

  return {
    state: { creds, keys },
    saveCreds,
    markPaired,
    markLoggedOut,
    markConnected,
    clear,
    getStatus
  };
};
