import sql from "mssql";
import OracleDB from "oracledb";
import mysql from "mysql2/promise";
import { getAppConfig, type DbType } from "./appConfig.js";

let oracleClientInitialized = false;

const ensureOracleDriverMode = (): void => {
  if (oracleClientInitialized) return;

  const mode = (process.env.ORACLE_DRIVER_MODE ?? "thin").toLowerCase();
  if (mode !== "thick") {
    oracleClientInitialized = true;
    return;
  }

  const libDir = process.env.ORACLE_CLIENT_LIB_DIR?.trim();
  try {
    if (libDir) {
      OracleDB.initOracleClient({ libDir });
    } else {
      OracleDB.initOracleClient();
    }
    oracleClientInitialized = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Falha ao iniciar Oracle thick mode. Defina ORACLE_CLIENT_LIB_DIR corretamente. Detalhe: ${message}`
    );
  }
};

export type QueryResult<T = Record<string, unknown>> = {
  recordset: T[];
  columns: string[];
};

export interface DbAdapter {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(sqlText: string): Promise<QueryResult<T>>;
  close(): Promise<void>;
  getDbType(): DbType;
}

// ================== SQL Server Adapter ==================

class SqlServerAdapter implements DbAdapter {
  private pool: sql.ConnectionPool | null = null;
  private host: string;
  private port: number;
  private database: string;
  private user: string;
  private password: string;

  constructor(host: string, port: number, database: string, user: string, password: string) {
    this.host = host;
    this.port = port;
    this.database = database;
    this.user = user;
    this.password = password;
  }

  async connect(): Promise<void> {
    if (this.pool) return;
    this.pool = await sql.connect({
      user: this.user,
      password: this.password,
      server: this.host,
      port: this.port,
      database: this.database,
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
  }

  async query<T = Record<string, unknown>>(sqlText: string): Promise<QueryResult<T>> {
    if (!this.pool) await this.connect();
    const result = await this.pool!.request().query<T>(sqlText);
    const columns = result.recordset?.columns
      ? Object.keys(result.recordset.columns)
      : result.recordset?.[0]
        ? Object.keys(result.recordset[0] as Record<string, unknown>)
        : [];
    return { recordset: result.recordset ?? [], columns };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }

  getDbType(): DbType {
    return "sqlserver";
  }
}

// ================== Oracle Adapter ==================

class OracleAdapter implements DbAdapter {
  private pool: OracleDB.Pool | null = null;
  private host: string;
  private port: number;
  private serviceName: string;
  private user: string;
  private password: string;

  constructor(host: string, port: number, serviceName: string, user: string, password: string) {
    this.host = host;
    this.port = port;
    this.serviceName = serviceName;
    this.user = user;
    this.password = password;
  }

  async connect(): Promise<void> {
    if (this.pool) return;
    ensureOracleDriverMode();
    OracleDB.outFormat = OracleDB.OUT_FORMAT_OBJECT;
    OracleDB.autoCommit = true;
    OracleDB.fetchAsString = [OracleDB.CLOB];

    this.pool = await OracleDB.createPool({
      user: this.user,
      password: this.password,
      connectString: `${this.host}:${this.port}/${this.serviceName}`,
      poolMin: 0,
      poolMax: 5,
      poolIncrement: 1,
      poolTimeout: 60
    });
  }

  async query<T = Record<string, unknown>>(sqlText: string): Promise<QueryResult<T>> {
    if (!this.pool) await this.connect();
    let connection: OracleDB.Connection | null = null;
    try {
      connection = await this.pool!.getConnection();
      const result = await connection.execute<T>(sqlText, [], {
        outFormat: OracleDB.OUT_FORMAT_OBJECT,
        fetchArraySize: 500
      });

      const rows = (result.rows ?? []) as T[];
      const columns = result.metaData
        ? result.metaData.map((col: { name: string }) => col.name)
        : rows.length > 0
          ? Object.keys(rows[0] as Record<string, unknown>)
          : [];

      return { recordset: rows, columns };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNneError =
        message.includes("NJS-533") ||
        message.includes("ORA-12660") ||
        message.toLowerCase().includes("native network encryption");
      if (isNneError) {
        throw new Error(
          "Oracle exige Native Network Encryption/Data Integrity. Configure ORACLE_DRIVER_MODE=thick e Oracle Instant Client (ORACLE_CLIENT_LIB_DIR), ou desative NNE no servidor Oracle."
        );
      }
      throw error;
    } finally {
      if (connection) {
        await connection.close();
      }
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.close(0);
      this.pool = null;
    }
  }

  getDbType(): DbType {
    return "oracle";
  }
}

// ================== MySQL Adapter ==================

class MySQLAdapter implements DbAdapter {
  private pool: mysql.Pool | null = null;
  private host: string;
  private port: number;
  private database: string;
  private user: string;
  private password: string;

  constructor(host: string, port: number, database: string, user: string, password: string) {
    this.host = host;
    this.port = port;
    this.database = database;
    this.user = user;
    this.password = password;
  }

  async connect(): Promise<void> {
    if (this.pool) return;
    this.pool = mysql.createPool({
      host: this.host,
      port: this.port,
      database: this.database,
      user: this.user,
      password: this.password,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 15000
    });
  }

  async query<T = Record<string, unknown>>(sqlText: string): Promise<QueryResult<T>> {
    if (!this.pool) await this.connect();
    const [rows, fields] = await this.pool!.query(sqlText);
    const recordset = Array.isArray(rows) ? (rows as T[]) : [];
    const columns = Array.isArray(fields)
      ? fields.map((f) => f.name)
      : recordset.length > 0
        ? Object.keys(recordset[0] as Record<string, unknown>)
        : [];
    return { recordset, columns };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  getDbType(): DbType {
    return "mysql";
  }
}

// ================== Factory ==================

let currentAdapter: DbAdapter | null = null;
let currentConfigHash: string | null = null;

const buildConfigHash = (
  dbType: string,
  host: string,
  port: number,
  name: string,
  user: string,
  password: string
): string => `${dbType}:${host}:${port}:${name}:${user}:${password}`;

export const getAdapter = async (): Promise<DbAdapter> => {
  const appConfig = await getAppConfig();
  if (!appConfig) {
    throw new Error("App not configured. Please complete setup first.");
  }

  const dbType = appConfig.dbType ?? "sqlserver";
  const dbHost = appConfig.dbHost ?? "localhost";
  const dbPort = appConfig.dbPort ?? 1433;
  const dbName = appConfig.dbName ?? "";
  const dbUser = appConfig.dbUser ?? "";
  const dbPassword = appConfig.dbPassword ?? "";

  const hash = buildConfigHash(
    dbType,
    dbHost,
    dbPort,
    dbName,
    dbUser,
    dbPassword
  );

  if (currentAdapter && currentConfigHash === hash) {
    return currentAdapter;
  }

  if (currentAdapter) {
    await currentAdapter.close();
  }

  if (dbType === "oracle") {
    currentAdapter = new OracleAdapter(
      dbHost,
      dbPort,
      dbName,
      dbUser,
      dbPassword
    );
  } else if (dbType === "mysql") {
    currentAdapter = new MySQLAdapter(
      dbHost,
      dbPort,
      dbName,
      dbUser,
      dbPassword
    );
  } else {
    currentAdapter = new SqlServerAdapter(
      dbHost,
      dbPort,
      dbName,
      dbUser,
      dbPassword
    );
  }

  await currentAdapter.connect();
  currentConfigHash = hash;
  return currentAdapter;
};

export const closeAdapter = async (): Promise<void> => {
  if (currentAdapter) {
    await currentAdapter.close();
    currentAdapter = null;
    currentConfigHash = null;
  }
};

/** Test a database connection without persisting it */
export const testConnection = async (
  dbType: DbType,
  host: string,
  port: number,
  name: string,
  user: string,
  password: string
): Promise<{ ok: true } | { ok: false; error: string }> => {
  let adapter: DbAdapter;
  if (dbType === "oracle") {
    adapter = new OracleAdapter(host, port, name, user, password);
  } else if (dbType === "mysql") {
    adapter = new MySQLAdapter(host, port, name, user, password);
  } else {
    adapter = new SqlServerAdapter(host, port, name, user, password);
  }

  try {
    await adapter.connect();
    const testSql = dbType === "oracle" ? "SELECT 1 FROM DUAL" : "SELECT 1 AS ok";
    await adapter.query(testSql);
    await adapter.close();
    return { ok: true };
  } catch (error) {
    try { await adapter.close(); } catch { /* ignore */ }
    const message = error instanceof Error ? error.message : "Connection failed";
    return { ok: false, error: message };
  }
};
