import sql from "mssql";
import mysql from "mysql2/promise";
import { config, type SqlDialect } from "./config.js";

export type QueryResult = {
  rows: Record<string, unknown>[];
  columns: string[];
};

export type DbClient = {
  dialect: SqlDialect;
  query: (statement: string) => Promise<QueryResult>;
  close: () => Promise<void>;
};

const CONNECTION_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 20000;
const POOL_MAX = 5;

let client: DbClient | null = null;

const createSqlServerClient = async (): Promise<DbClient> => {
  const pool = await sql.connect({
    user: config.sql.user,
    password: config.sql.password,
    server: config.sql.host,
    port: config.sql.port,
    database: config.sql.database,
    options: {
      encrypt: true,
      trustServerCertificate: true
    },
    pool: {
      max: POOL_MAX,
      min: 0,
      idleTimeoutMillis: 30000
    },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS
  });

  return {
    dialect: "sqlserver",
    query: async (statement: string) => {
      const result = await pool.request().query(statement);
      const rows = (result.recordset ?? []) as Record<string, unknown>[];
      const columns = result.recordset?.columns
        ? Object.keys(result.recordset.columns)
        : rows[0]
          ? Object.keys(rows[0])
          : [];
      return { rows, columns };
    },
    close: async () => {
      await pool.close();
    }
  };
};

const createMySqlClient = async (): Promise<DbClient> => {
  const pool = mysql.createPool({
    host: config.sql.host,
    port: config.sql.port,
    user: config.sql.user,
    password: config.sql.password,
    database: config.sql.database,
    waitForConnections: true,
    connectionLimit: POOL_MAX,
    queueLimit: 0,
    connectTimeout: CONNECTION_TIMEOUT_MS
  });

  return {
    dialect: "mysql",
    query: async (statement: string) => {
      const [rows, fields] = await pool.query({
        sql: statement,
        timeout: REQUEST_TIMEOUT_MS
      });
      const rowArray = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
      const columns =
        Array.isArray(fields) && fields.length
          ? fields.map((field) => field.name)
          : rowArray[0]
            ? Object.keys(rowArray[0])
            : [];
      return { rows: rowArray, columns };
    },
    close: async () => {
      await pool.end();
    }
  };
};

export const getDbClient = async (): Promise<DbClient> => {
  if (client) return client;
  client =
    config.sql.dialect === "mysql"
      ? await createMySqlClient()
      : await createSqlServerClient();
  return client;
};

export const closeDbClient = async (): Promise<void> => {
  if (!client) return;
  await client.close();
  client = null;
};
