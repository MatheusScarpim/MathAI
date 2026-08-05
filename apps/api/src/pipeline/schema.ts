import type { ColumnInfo, ForeignKeyInfo, TableChunk } from "@auraia/shared";
import { getOpenAI, EMBEDDING_MODEL } from "../core/openai.js";
import {
  qdrant,
  ensureSchemaCollection,
  getSchemaCollectionName,
  VECTOR_SIZE_BY_MODEL
} from "../core/qdrant.js";
import { createHash } from "crypto";
import type { DbAdapter } from "../core/db.js";

type TableInfo = {
  schema: string;
  name: string;
  fullName: string;
  objectId: number;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  tags: string[];
};

const tagForTable = (name: string, objectType: "U" | "V"): string[] => {
  const tags: string[] = [];
  if (/^fat_/i.test(name)) tags.push("Fat");
  if (/^dim_/i.test(name)) tags.push("Dim");
  if (objectType === "V") tags.push("View");
  return tags;
};

// ================== SQL Server Schema ==================

type SqlServerTableRow = { schema_name: string; table_name: string; object_id: number; object_type: "U" | "V" };
type SqlServerColumnRow = { object_id: number; column_name: string; data_type: string };
type SqlServerPkRow = { object_id: number; column_name: string };
type SqlServerFkRow = { parent_object_id: number; referenced_object_id: number; parent_column: string; referenced_column: string };

const loadSchemaFromSqlServer = async (adapter: DbAdapter): Promise<TableInfo[]> => {
  const tablesResult = await adapter.query<SqlServerTableRow>(`
    SELECT s.name AS schema_name, o.name AS table_name, o.object_id, o.type AS object_type
    FROM sys.objects o
    INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
    WHERE o.type IN ('U','V')
    AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
    AND o.is_ms_shipped = 0
  `);

  const tablesById = new Map<number, TableInfo>();
  for (const row of tablesResult.recordset) {
    const fullName = `${row.schema_name}.${row.table_name}`;
    tablesById.set(row.object_id, {
      schema: row.schema_name,
      name: row.table_name,
      fullName,
      objectId: row.object_id,
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      tags: tagForTable(row.table_name, row.object_type)
    });
  }

  const columnsResult = await adapter.query<SqlServerColumnRow>(`
    SELECT c.object_id, c.name AS column_name, ty.name AS data_type
    FROM sys.columns c
    INNER JOIN sys.types ty ON c.user_type_id = ty.user_type_id
  `);

  for (const row of columnsResult.recordset) {
    const table = tablesById.get(row.object_id);
    if (!table) continue;
    table.columns.push({ name: row.column_name, type: row.data_type });
  }

  const pkResult = await adapter.query<SqlServerPkRow>(`
    SELECT ic.object_id, c.name AS column_name
    FROM sys.indexes i
    INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE i.is_primary_key = 1
  `);

  for (const row of pkResult.recordset) {
    const table = tablesById.get(row.object_id);
    if (!table) continue;
    table.primaryKey.push(row.column_name);
  }

  const fkResult = await adapter.query<SqlServerFkRow>(`
    SELECT
      fkc.parent_object_id,
      fkc.referenced_object_id,
      cp.name AS parent_column,
      cr.name AS referenced_column
    FROM sys.foreign_keys fk
    INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
    INNER JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
    INNER JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
  `);

  for (const row of fkResult.recordset) {
    const parent = tablesById.get(row.parent_object_id);
    const referenced = tablesById.get(row.referenced_object_id);
    if (!parent || !referenced) continue;

    parent.foreignKeys.push({
      fromTable: parent.fullName,
      fromColumn: row.parent_column,
      toTable: referenced.fullName,
      toColumn: row.referenced_column
    });
  }

  return Array.from(tablesById.values());
};

// ================== Oracle Schema ==================

type OracleTableRow = { OWNER: string; TABLE_NAME: string; TABLE_TYPE: string };
type OracleColumnRow = { OWNER: string; TABLE_NAME: string; COLUMN_NAME: string; DATA_TYPE: string };
type OraclePkRow = { OWNER: string; TABLE_NAME: string; COLUMN_NAME: string };
type OracleFkRow = { OWNER: string; TABLE_NAME: string; COLUMN_NAME: string; R_OWNER: string; R_TABLE_NAME: string; R_COLUMN_NAME: string };

const loadSchemaFromOracle = async (adapter: DbAdapter): Promise<TableInfo[]> => {
  // Get tables and views
  const tablesResult = await adapter.query<OracleTableRow>(`
    SELECT owner AS "OWNER", table_name AS "TABLE_NAME", 'U' AS "TABLE_TYPE"
    FROM all_tables
    WHERE owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
    UNION ALL
    SELECT owner AS "OWNER", view_name AS "TABLE_NAME", 'V' AS "TABLE_TYPE"
    FROM all_views
    WHERE owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
  `);

  let objectCounter = 1;
  const tablesByFullName = new Map<string, TableInfo>();
  for (const row of tablesResult.recordset) {
    const fullName = `${row.OWNER}.${row.TABLE_NAME}`;
    const objectType = row.TABLE_TYPE === "V" ? "V" as const : "U" as const;
    tablesByFullName.set(fullName, {
      schema: row.OWNER,
      name: row.TABLE_NAME,
      fullName,
      objectId: objectCounter++,
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      tags: tagForTable(row.TABLE_NAME, objectType)
    });
  }

  // Get columns
  const columnsResult = await adapter.query<OracleColumnRow>(`
    SELECT owner AS "OWNER", table_name AS "TABLE_NAME", column_name AS "COLUMN_NAME", data_type AS "DATA_TYPE"
    FROM all_tab_columns
    WHERE owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
    ORDER BY owner, table_name, column_id
  `);

  for (const row of columnsResult.recordset) {
    const fullName = `${row.OWNER}.${row.TABLE_NAME}`;
    const table = tablesByFullName.get(fullName);
    if (!table) continue;
    table.columns.push({ name: row.COLUMN_NAME, type: row.DATA_TYPE });
  }

  // Get primary keys
  const pkResult = await adapter.query<OraclePkRow>(`
    SELECT ac.owner AS "OWNER", ac.table_name AS "TABLE_NAME", acc.column_name AS "COLUMN_NAME"
    FROM all_constraints ac
    INNER JOIN all_cons_columns acc ON ac.constraint_name = acc.constraint_name AND ac.owner = acc.owner
    WHERE ac.constraint_type = 'P'
    AND ac.owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
  `);

  for (const row of pkResult.recordset) {
    const fullName = `${row.OWNER}.${row.TABLE_NAME}`;
    const table = tablesByFullName.get(fullName);
    if (!table) continue;
    table.primaryKey.push(row.COLUMN_NAME);
  }

  // Get foreign keys
  const fkResult = await adapter.query<OracleFkRow>(`
    SELECT
      ac.owner AS "OWNER",
      ac.table_name AS "TABLE_NAME",
      acc.column_name AS "COLUMN_NAME",
      rc.owner AS "R_OWNER",
      rc.table_name AS "R_TABLE_NAME",
      rcc.column_name AS "R_COLUMN_NAME"
    FROM all_constraints ac
    INNER JOIN all_cons_columns acc ON ac.constraint_name = acc.constraint_name AND ac.owner = acc.owner
    INNER JOIN all_constraints rc ON ac.r_constraint_name = rc.constraint_name AND ac.r_owner = rc.owner
    INNER JOIN all_cons_columns rcc ON rc.constraint_name = rcc.constraint_name AND rc.owner = rcc.owner AND acc.position = rcc.position
    WHERE ac.constraint_type = 'R'
    AND ac.owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
  `);

  for (const row of fkResult.recordset) {
    const fullName = `${row.OWNER}.${row.TABLE_NAME}`;
    const table = tablesByFullName.get(fullName);
    if (!table) continue;

    const refFullName = `${row.R_OWNER}.${row.R_TABLE_NAME}`;
    table.foreignKeys.push({
      fromTable: fullName,
      fromColumn: row.COLUMN_NAME,
      toTable: refFullName,
      toColumn: row.R_COLUMN_NAME
    });
  }

  return Array.from(tablesByFullName.values());
};

// ================== MySQL Schema ==================

type MySQLTableRow = { TABLE_SCHEMA: string; TABLE_NAME: string; TABLE_TYPE: string };
type MySQLColumnRow = { TABLE_SCHEMA: string; TABLE_NAME: string; COLUMN_NAME: string; DATA_TYPE: string };
type MySQLPkRow = { TABLE_SCHEMA: string; TABLE_NAME: string; COLUMN_NAME: string };
type MySQLFkRow = { TABLE_SCHEMA: string; TABLE_NAME: string; COLUMN_NAME: string; REFERENCED_TABLE_SCHEMA: string; REFERENCED_TABLE_NAME: string; REFERENCED_COLUMN_NAME: string };

const loadSchemaFromMySQL = async (adapter: DbAdapter): Promise<TableInfo[]> => {
  const tablesResult = await adapter.query<MySQLTableRow>(`
    SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
  `);

  let objectCounter = 1;
  const tablesByFullName = new Map<string, TableInfo>();
  for (const row of tablesResult.recordset) {
    const fullName = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
    const objectType = row.TABLE_TYPE === "VIEW" ? "V" as const : "U" as const;
    tablesByFullName.set(fullName, {
      schema: row.TABLE_SCHEMA,
      name: row.TABLE_NAME,
      fullName,
      objectId: objectCounter++,
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      tags: tagForTable(row.TABLE_NAME, objectType)
    });
  }

  const columnsResult = await adapter.query<MySQLColumnRow>(`
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
  `);

  for (const row of columnsResult.recordset) {
    const fullName = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
    const table = tablesByFullName.get(fullName);
    if (!table) continue;
    table.columns.push({ name: row.COLUMN_NAME, type: row.DATA_TYPE });
  }

  const pkResult = await adapter.query<MySQLPkRow>(`
    SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
      ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
      AND tc.TABLE_NAME = kcu.TABLE_NAME
    WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
    AND tc.TABLE_SCHEMA = DATABASE()
  `);

  for (const row of pkResult.recordset) {
    const fullName = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
    const table = tablesByFullName.get(fullName);
    if (!table) continue;
    table.primaryKey.push(row.COLUMN_NAME);
  }

  const fkResult = await adapter.query<MySQLFkRow>(`
    SELECT
      kcu.TABLE_SCHEMA,
      kcu.TABLE_NAME,
      kcu.COLUMN_NAME,
      kcu.REFERENCED_TABLE_SCHEMA,
      kcu.REFERENCED_TABLE_NAME,
      kcu.REFERENCED_COLUMN_NAME
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
    WHERE kcu.REFERENCED_TABLE_NAME IS NOT NULL
    AND kcu.TABLE_SCHEMA = DATABASE()
  `);

  for (const row of fkResult.recordset) {
    const fullName = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
    const table = tablesByFullName.get(fullName);
    if (!table) continue;

    const refFullName = `${row.REFERENCED_TABLE_SCHEMA}.${row.REFERENCED_TABLE_NAME}`;
    table.foreignKeys.push({
      fromTable: fullName,
      fromColumn: row.COLUMN_NAME,
      toTable: refFullName,
      toColumn: row.REFERENCED_COLUMN_NAME
    });
  }

  return Array.from(tablesByFullName.values());
};

// ================== PostgreSQL Schema ==================

type PgTableRow = { table_schema: string; table_name: string; table_type: string };
type PgColumnRow = { table_schema: string; table_name: string; column_name: string; data_type: string };
type PgPkRow = { table_schema: string; table_name: string; column_name: string };
type PgFkRow = { table_schema: string; table_name: string; column_name: string; foreign_table_schema: string; foreign_table_name: string; foreign_column_name: string };

const loadSchemaFromPostgreSQL = async (adapter: DbAdapter): Promise<TableInfo[]> => {
  const tablesResult = await adapter.query<PgTableRow>(`
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    AND table_type IN ('BASE TABLE', 'VIEW')
  `);

  let objectCounter = 1;
  const tablesByFullName = new Map<string, TableInfo>();
  for (const row of tablesResult.recordset) {
    const fullName = `${row.table_schema}.${row.table_name}`;
    const objectType = row.table_type === "VIEW" ? "V" as const : "U" as const;
    tablesByFullName.set(fullName, {
      schema: row.table_schema,
      name: row.table_name,
      fullName,
      objectId: objectCounter++,
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      tags: tagForTable(row.table_name, objectType)
    });
  }

  const columnsResult = await adapter.query<PgColumnRow>(`
    SELECT table_schema, table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name, ordinal_position
  `);

  for (const row of columnsResult.recordset) {
    const fullName = `${row.table_schema}.${row.table_name}`;
    const table = tablesByFullName.get(fullName);
    if (!table) continue;
    table.columns.push({ name: row.column_name, type: row.data_type });
  }

  const pkResult = await adapter.query<PgPkRow>(`
    SELECT kcu.table_schema, kcu.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
    AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
  `);

  for (const row of pkResult.recordset) {
    const fullName = `${row.table_schema}.${row.table_name}`;
    const table = tablesByFullName.get(fullName);
    if (!table) continue;
    table.primaryKey.push(row.column_name);
  }

  const fkResult = await adapter.query<PgFkRow>(`
    SELECT
      kcu.table_schema,
      kcu.table_name,
      kcu.column_name,
      ccu.table_schema AS foreign_table_schema,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
  `);

  for (const row of fkResult.recordset) {
    const fullName = `${row.table_schema}.${row.table_name}`;
    const table = tablesByFullName.get(fullName);
    if (!table) continue;

    const refFullName = `${row.foreign_table_schema}.${row.foreign_table_name}`;
    table.foreignKeys.push({
      fromTable: fullName,
      fromColumn: row.column_name,
      toTable: refFullName,
      toColumn: row.foreign_column_name
    });
  }

  return Array.from(tablesByFullName.values());
};

// ================== Unified ==================

export const loadSchema = async (adapter: DbAdapter): Promise<TableInfo[]> => {
  if (adapter.getDbType() === "oracle") {
    return loadSchemaFromOracle(adapter);
  }
  if (adapter.getDbType() === "mysql") {
    return loadSchemaFromMySQL(adapter);
  }
  if (adapter.getDbType() === "postgresql") {
    return loadSchemaFromPostgreSQL(adapter);
  }
  return loadSchemaFromSqlServer(adapter);
};

// ================== Qdrant Ingestion (unchanged) ==================

const MAX_COLUMNS = 160;
const MAX_FOREIGN_KEYS = 80;
const MAX_CHUNK_CHARS = 24000;

const truncateText = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;

const buildChunkText = (table: TableInfo): string => {
  const columnsList = table.columns
    .slice(0, MAX_COLUMNS)
    .map((col) => `${col.name} (${col.type})`);
  const columnsSuffix =
    table.columns.length > MAX_COLUMNS
      ? ` ... +${table.columns.length - MAX_COLUMNS} more`
      : "";
  const columns = columnsList.join(", ") + columnsSuffix;
  const pk = table.primaryKey.length ? table.primaryKey.join(", ") : "none";
  const fkList = table.foreignKeys
    .slice(0, MAX_FOREIGN_KEYS)
    .map((fk) => `${fk.fromTable}.${fk.fromColumn} -> ${fk.toTable}.${fk.toColumn}`);
  const fkSuffix =
    table.foreignKeys.length > MAX_FOREIGN_KEYS
      ? ` ... +${table.foreignKeys.length - MAX_FOREIGN_KEYS} more`
      : "";
  const fks = fkList.length ? fkList.join("; ") + fkSuffix : "none";
  const tags = table.tags.length ? table.tags.join(", ") : "none";

  const text = [
    `Table: ${table.fullName}`,
    `Columns: ${columns}`,
    `Primary Key: ${pk}`,
    `Foreign Keys: ${fks}`,
    `Tags: ${tags}`
  ].join("\n");

  return truncateText(text, MAX_CHUNK_CHARS);
};

export const ingestSchemaToQdrant = async (
  tables: TableInfo[],
  environmentId?: string
): Promise<number> => {
  await ensureSchemaCollection(environmentId);
  const collectionName = getSchemaCollectionName(environmentId);

  const vectorSize = VECTOR_SIZE_BY_MODEL[EMBEDDING_MODEL] ?? 1536;
  const zeroVector = (): number[] => new Array<number>(vectorSize).fill(0);
  let embeddingsUnavailable = false;

  const batchSize = 20;
  for (let i = 0; i < tables.length; i += batchSize) {
    const batch = tables.slice(i, i + batchSize);
    const texts = batch.map(buildChunkText);

    // Providers such as DeepSeek expose chat completions but no /embeddings.
    // Aborting the whole ingest there would leave Qdrant empty, which also
    // kills the lexical fallback in searchRelevantTables (it scrolls the same
    // collection). Indexing with placeholder vectors keeps schema retrieval
    // working in lexical-only mode.
    let vectors: number[][];
    if (embeddingsUnavailable) {
      vectors = texts.map(zeroVector);
    } else {
      try {
        const client = await getOpenAI();
        const embeddings = await client.embeddings.create({
          model: EMBEDDING_MODEL,
          input: texts
        });
        vectors = texts.map((_, index) => embeddings.data[index]?.embedding ?? zeroVector());
      } catch (error) {
        const status = (error as { status?: number })?.status;
        const message = (error as { message?: string })?.message ?? String(error);
        console.warn(
          `[ingest-embedding-unavailable] modelo=${EMBEDDING_MODEL} status=${status ?? "?"} — indexando sem vetores, busca sera lexical: ${message}`
        );
        embeddingsUnavailable = true;
        vectors = texts.map(zeroVector);
      }
    }

    const points = batch.map((table, index) => {
      const payload: TableChunk = {
        tableFullName: table.fullName,
        columns: table.columns,
        primaryKey: table.primaryKey,
        foreignKeys: table.foreignKeys,
        tags: table.tags
      };

      return {
        id: toUuid(table.fullName),
        vector: vectors[index] ?? zeroVector(),
        payload
      };
    });

    await qdrant.upsert(collectionName, {
      wait: true,
      points
    });
  }

  return tables.length;
};

const toUuid = (value: string): string => {
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
};

export const deleteTableFromQdrant = async (
  tableFullName: string,
  environmentId?: string
): Promise<void> => {
  await ensureSchemaCollection(environmentId);
  const collectionName = getSchemaCollectionName(environmentId);
  const id = toUuid(tableFullName);
  await qdrant.delete(collectionName, { wait: true, points: [id] });
  clearSchemaCache(environmentId);
};

const schemaCacheByEnv = new Map<string, { tables: TableChunk[]; loadedAt: number }>();

export const clearSchemaCache = (environmentId?: string): void => {
  if (environmentId) {
    schemaCacheByEnv.delete(environmentId);
  } else {
    schemaCacheByEnv.clear();
  }
};

export const loadSchemaGraph = async (environmentId?: string): Promise<TableChunk[]> => {
  const cacheKey = environmentId ?? "__legacy__";
  const cached = schemaCacheByEnv.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < 5 * 60 * 1000) {
    return cached.tables;
  }

  await ensureSchemaCollection(environmentId);
  const collectionName = getSchemaCollectionName(environmentId);

  const tables: TableChunk[] = [];
  let offset: string | number | undefined;

  do {
    const result = await qdrant.scroll(collectionName, {
      limit: 100,
      offset,
      with_payload: true,
      with_vector: false
    });

    for (const point of result.points) {
      if (!point.payload) continue;
      const payload = point.payload as TableChunk;
      tables.push(payload);
    }

    const next = result.next_page_offset;
    offset = typeof next === "string" || typeof next === "number" ? next : undefined;
  } while (offset !== undefined);

  schemaCacheByEnv.set(cacheKey, { tables, loadedAt: Date.now() });
  return tables;
};
