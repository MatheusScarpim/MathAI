import sql from "mssql";
import { config } from "./config.js";

let pool: sql.ConnectionPool | null = null;

export const getPool = async (): Promise<sql.ConnectionPool> => {
  if (pool) {
    return pool;
  }

  pool = await sql.connect({
    user: config.sql.user,
    password: config.sql.password,
    server: config.sql.server,
    port: config.sql.port,
    database: config.sql.database,
    options: {
      encrypt: true,
      trustServerCertificate: true
    },
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000
    },
    connectionTimeout: 15000,
    requestTimeout: 20000
  });

  return pool;
};

export const closePool = async (): Promise<void> => {
  if (pool) {
    await pool.close();
    pool = null;
  }
};
