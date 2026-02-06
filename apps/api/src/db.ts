import sql from "mssql";
import OracleDB from "oracledb";
import { getAppConfig, type DbType } from "./appConfig.js";

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

  const hash = buildConfigHash(
    appConfig.dbType,
    appConfig.dbHost,
    appConfig.dbPort,
    appConfig.dbName,
    appConfig.dbUser,
    appConfig.dbPassword
  );

  if (currentAdapter && currentConfigHash === hash) {
    return currentAdapter;
  }

  if (currentAdapter) {
    await currentAdapter.close();
  }

  if (appConfig.dbType === "oracle") {
    currentAdapter = new OracleAdapter(
      appConfig.dbHost,
      appConfig.dbPort,
      appConfig.dbName,
      appConfig.dbUser,
      appConfig.dbPassword
    );
  } else {
    currentAdapter = new SqlServerAdapter(
      appConfig.dbHost,
      appConfig.dbPort,
      appConfig.dbName,
      appConfig.dbUser,
      appConfig.dbPassword
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
