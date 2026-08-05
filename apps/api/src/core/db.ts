import { createHash } from "crypto";
import sql from "mssql";
import OracleDB from "oracledb";
import mysql from "mysql2/promise";
import pg from "pg";
import type { ResultColumnMeta } from "@auraia/shared";
import { getEnvironment, type DbType } from "./appConfig.js";

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
  /**
   * Tipo declarado de cada coluna, quando o driver informa. Opcional porque a
   * maioria dos consumidores le so `recordset` — quem precisa de mascara de
   * exibicao usa isto, e degrada para classificacao por nome quando falta.
   */
  columnsMeta?: ResultColumnMeta[];
};

export interface DbAdapter {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(sqlText: string): Promise<QueryResult<T>>;
  close(): Promise<void>;
  getDbType(): DbType;
}

/**
 * Colunas de um resultado quando o driver nao entrega metadata: sobra o nome
 * das chaves da primeira linha, e nenhum tipo. A mascara de exibicao ainda
 * funciona por nome, so perde o refino de casas decimais.
 */
const metaFromNames = (columns: readonly string[]): ResultColumnMeta[] =>
  columns.map((name) => ({ name, type: "" }));

// ================== SQL Server Adapter ==================

/**
 * `recordset.columns` do mssql traz o tipo como a CLASSE do driver
 * (`sql.Decimal`), nao como string — `declaration` e o nome SQL dela.
 */
const mssqlColumns = (
  recordset: { columns?: Record<string, unknown> } | undefined,
  firstRow: Record<string, unknown> | undefined
): { columns: string[]; columnsMeta: ResultColumnMeta[] } => {
  const declared = recordset?.columns;
  if (declared) {
    const columnsMeta = Object.entries(declared).map(([name, raw]) => {
      const col = raw as { type?: { declaration?: string }; scale?: number };
      return {
        name,
        type: col?.type?.declaration ?? "",
        ...(typeof col?.scale === "number" ? { scale: col.scale } : {})
      };
    });
    return { columns: columnsMeta.map((c) => c.name), columnsMeta };
  }
  const columns = firstRow ? Object.keys(firstRow) : [];
  return { columns, columnsMeta: metaFromNames(columns) };
};

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
    this.pool = new sql.ConnectionPool({
      user: this.user,
      password: this.password,
      server: this.host,
      port: this.port,
      database: this.database,
      options: {
        encrypt: true,
        trustServerCertificate: true,
        // `DATE`/`DATETIME` do SQL Server nao carregam fuso: sao data de
        // calendario. O default do driver (`useUTC: true`) le esses valores como
        // se fossem UTC, entao 2026-03-04 volta como meia-noite UTC e qualquer
        // formatacao local em fuso negativo imprime 03/03. Lendo no fuso do
        // processo o dia atravessa intacto.
        useUTC: false
      },
      pool: {
        max: 5,
        min: 0,
        idleTimeoutMillis: 30000
      },
      connectionTimeout: 15000,
      requestTimeout: 20000
    });
    await this.pool.connect();
  }

  async query<T = Record<string, unknown>>(sqlText: string): Promise<QueryResult<T>> {
    if (!this.pool) await this.connect();
    try {
      const result = await this.pool!.request().query<T>(sqlText);
      const { columns, columnsMeta } = mssqlColumns(
        result.recordset,
        result.recordset?.[0] as Record<string, unknown> | undefined
      );
      return { recordset: result.recordset ?? [], columns, columnsMeta };
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code === "ECONNCLOSED" || code === "ENOTOPEN") {
        this.pool = null;
        await this.connect();
        const result = await this.pool!.request().query<T>(sqlText);
        const { columns, columnsMeta } = mssqlColumns(
          result.recordset,
          result.recordset?.[0] as Record<string, unknown> | undefined
        );
        return { recordset: result.recordset ?? [], columns, columnsMeta };
      }
      throw error;
    }
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
      connection.callTimeout = 20000;
      const result = await connection.execute<T>(sqlText, [], {
        outFormat: OracleDB.OUT_FORMAT_OBJECT,
        fetchArraySize: 500
      });

      const rows = (result.rows ?? []) as T[];
      // Unico driver da casa que informa `scale`. `scale: 0` prova coluna
      // inteira e e mais confiavel que qualquer palpite pelo nome.
      const columnsMeta: ResultColumnMeta[] = result.metaData
        ? result.metaData.map((col) => ({
            name: col.name,
            type: col.dbTypeName ?? "",
            ...(typeof col.scale === "number" ? { scale: col.scale } : {})
          }))
        : metaFromNames(rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : []);

      return { recordset: rows, columns: columnsMeta.map((c) => c.name), columnsMeta };
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
    await this.pool!.query("SET SESSION MAX_EXECUTION_TIME=20000");
    const [rows, fields] = await this.pool!.query(sqlText);
    const recordset = Array.isArray(rows) ? (rows as T[]) : [];
    // `columnType` do mysql2 e um codigo numerico, nao nome de tipo — passar
    // como string mentiria para o lexico. Fica so o nome; a classificacao por
    // nome nao depende do tipo.
    const columnsMeta: ResultColumnMeta[] = Array.isArray(fields)
      ? fields.map((f) => ({ name: f.name, type: "" }))
      : metaFromNames(recordset.length > 0 ? Object.keys(recordset[0] as Record<string, unknown>) : []);
    return { recordset, columns: columnsMeta.map((c) => c.name), columnsMeta };
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

// ================== PostgreSQL Adapter ==================

class PostgreSQLAdapter implements DbAdapter {
  private pool: pg.Pool | null = null;
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
    this.pool = new pg.Pool({
      host: this.host,
      port: this.port,
      database: this.database,
      user: this.user,
      password: this.password,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      statement_timeout: 20000
    });
  }

  async query<T = Record<string, unknown>>(sqlText: string): Promise<QueryResult<T>> {
    if (!this.pool) await this.connect();
    const result = await this.pool!.query(sqlText);
    const recordset = (result.rows ?? []) as T[];
    // `dataTypeID` do pg e um OID, que so vira nome de tipo consultando
    // `pg_type`. Nao vale uma ida ao banco por consulta: o nome basta.
    const columnsMeta: ResultColumnMeta[] = result.fields
      ? result.fields.map((f) => ({ name: f.name, type: "" }))
      : metaFromNames(recordset.length > 0 ? Object.keys(recordset[0] as Record<string, unknown>) : []);
    return { recordset, columns: columnsMeta.map((c) => c.name), columnsMeta };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  getDbType(): DbType {
    return "postgresql";
  }
}

// ================== Adapter Pool (per environment) ==================

type AdapterEntry = {
  adapter: DbAdapter;
  configHash: string;
};

const adapterPool = new Map<string, AdapterEntry>();

const buildConfigHash = (
  dbType: string,
  host: string,
  port: number,
  name: string,
  user: string,
  password: string
): string =>
  createHash("sha256")
    .update(`${dbType}:${host}:${port}:${name}:${user}:${password}`)
    .digest("hex");

const createAdapter = (
  dbType: DbType,
  host: string,
  port: number,
  name: string,
  user: string,
  password: string
): DbAdapter => {
  if (dbType === "oracle") {
    return new OracleAdapter(host, port, name, user, password);
  }
  if (dbType === "mysql") {
    return new MySQLAdapter(host, port, name, user, password);
  }
  if (dbType === "postgresql") {
    return new PostgreSQLAdapter(host, port, name, user, password);
  }
  return new SqlServerAdapter(host, port, name, user, password);
};

export const getAdapter = async (environmentId?: string): Promise<DbAdapter> => {
  if (!environmentId) {
    // Legacy fallback: use first environment
    const { getAppConfig } = await import("./appConfig.js");
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

    const hash = buildConfigHash(dbType, dbHost, dbPort, dbName, dbUser, dbPassword);
    const key = "__legacy__";
    const existing = adapterPool.get(key);

    if (existing && existing.configHash === hash) {
      return existing.adapter;
    }
    if (existing) {
      await existing.adapter.close();
    }

    const adapter = createAdapter(dbType, dbHost, dbPort, dbName, dbUser, dbPassword);
    await adapter.connect();
    adapterPool.set(key, { adapter, configHash: hash });
    return adapter;
  }

  const envConfig = await getEnvironment(environmentId);
  if (!envConfig) {
    throw new Error(`Environment "${environmentId}" not found.`);
  }

  const dbType = envConfig.dbType ?? "sqlserver";
  const dbHost = envConfig.dbHost ?? "localhost";
  const dbPort = envConfig.dbPort ?? 1433;
  const dbName = envConfig.dbName ?? "";
  const dbUser = envConfig.dbUser ?? "";
  const dbPassword = envConfig.dbPassword ?? "";

  const hash = buildConfigHash(dbType, dbHost, dbPort, dbName, dbUser, dbPassword);
  const existing = adapterPool.get(environmentId);

  if (existing && existing.configHash === hash) {
    return existing.adapter;
  }
  if (existing) {
    await existing.adapter.close();
  }

  const adapter = createAdapter(dbType, dbHost, dbPort, dbName, dbUser, dbPassword);
  await adapter.connect();
  adapterPool.set(environmentId, { adapter, configHash: hash });
  return adapter;
};

export const closeAdapter = async (environmentId?: string): Promise<void> => {
  if (environmentId) {
    const entry = adapterPool.get(environmentId);
    if (entry) {
      await entry.adapter.close();
      adapterPool.delete(environmentId);
    }
    return;
  }

  // Close all adapters
  for (const [key, entry] of adapterPool) {
    await entry.adapter.close();
    adapterPool.delete(key);
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
  const adapter = createAdapter(dbType, host, port, name, user, password);

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
