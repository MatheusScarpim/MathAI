import type { ColumnInfo, ForeignKeyInfo, TableChunk } from "@auraia/shared";
import { openai, EMBEDDING_MODEL } from "./openai.js";
import { qdrant, ensureSchemaCollection } from "./qdrant.js";
import { createHash } from "crypto";
import type { DbClient } from "./db.js";
import { config } from "./config.js";

type RawTableRow = {
  schema_name: string;
  table_name: string;
  object_id: number;
};

type RawColumnRow = {
  object_id: number;
  column_name: string;
  data_type: string;
};

type RawPkRow = {
  object_id: number;
  column_name: string;
};

type RawFkRow = {
  parent_object_id: number;
  referenced_object_id: number;
  parent_column: string;
  referenced_column: string;
};

type RawMySqlTableRow = {
  schema_name: string;
  table_name: string;
};

type RawMySqlColumnRow = {
  schema_name: string;
  table_name: string;
  column_name: string;
  data_type: string;
};

type RawMySqlPkRow = {
  schema_name: string;
  table_name: string;
  column_name: string;
};

type RawMySqlFkRow = {
  schema_name: string;
  table_name: string;
  column_name: string;
  referenced_schema: string;
  referenced_table: string;
  referenced_column: string;
};

type TableInfo = {
  schema: string;
  name: string;
  fullName: string;
  objectId?: number;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  tags: string[];
};

const tagForTable = (name: string): string[] => {
  const tags: string[] = [];
  if (/^fat_/i.test(name)) tags.push("Fat");
  if (/^dim_/i.test(name)) tags.push("Dim");
  return tags;
};

const escapeSqlLiteral = (value: string): string => value.replace(/'/g, "''");

export const loadSchemaFromSqlServer = async (db: DbClient): Promise<TableInfo[]> => {
  const tablesResult = await db.query(`
    SELECT s.name AS schema_name, t.name AS table_name, t.object_id
    FROM sys.tables t
    INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
  `);

  const tablesById = new Map<number, TableInfo>();
  for (const row of tablesResult.rows as RawTableRow[]) {
    const fullName = `${row.schema_name}.${row.table_name}`;
    tablesById.set(row.object_id, {
      schema: row.schema_name,
      name: row.table_name,
      fullName,
      objectId: row.object_id,
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      tags: tagForTable(row.table_name)
    });
  }

  const columnsResult = await db.query(`
    SELECT c.object_id, c.name AS column_name, ty.name AS data_type
    FROM sys.columns c
    INNER JOIN sys.types ty ON c.user_type_id = ty.user_type_id
  `);

  for (const row of columnsResult.rows as RawColumnRow[]) {
    const table = tablesById.get(row.object_id);
    if (!table) continue;
    table.columns.push({ name: row.column_name, type: row.data_type });
  }

  const pkResult = await db.query(`
    SELECT ic.object_id, c.name AS column_name
    FROM sys.indexes i
    INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE i.is_primary_key = 1
  `);

  for (const row of pkResult.rows as RawPkRow[]) {
    const table = tablesById.get(row.object_id);
    if (!table) continue;
    table.primaryKey.push(row.column_name);
  }

  const fkResult = await db.query(`
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

  for (const row of fkResult.rows as RawFkRow[]) {
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

export const loadSchemaFromMySql = async (db: DbClient): Promise<TableInfo[]> => {
  const schemaName = escapeSqlLiteral(config.sql.database);
  const tablesResult = await db.query(`
    SELECT table_schema AS schema_name, table_name
    FROM information_schema.tables
    WHERE table_schema = '${schemaName}'
      AND table_type = 'BASE TABLE'
  `);

  const tablesByName = new Map<string, TableInfo>();
  for (const row of tablesResult.rows as RawMySqlTableRow[]) {
    const fullName = `${row.schema_name}.${row.table_name}`;
    tablesByName.set(fullName, {
      schema: row.schema_name,
      name: row.table_name,
      fullName,
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      tags: tagForTable(row.table_name)
    });
  }

  const columnsResult = await db.query(`
    SELECT table_schema AS schema_name, table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = '${schemaName}'
  `);

  for (const row of columnsResult.rows as RawMySqlColumnRow[]) {
    const fullName = `${row.schema_name}.${row.table_name}`;
    const table = tablesByName.get(fullName);
    if (!table) continue;
    table.columns.push({ name: row.column_name, type: row.data_type });
  }

  const pkResult = await db.query(`
    SELECT kcu.table_schema AS schema_name, kcu.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    INNER JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = '${schemaName}'
  `);

  for (const row of pkResult.rows as RawMySqlPkRow[]) {
    const fullName = `${row.schema_name}.${row.table_name}`;
    const table = tablesByName.get(fullName);
    if (!table) continue;
    table.primaryKey.push(row.column_name);
  }

  const fkResult = await db.query(`
    SELECT
      kcu.table_schema AS schema_name,
      kcu.table_name AS table_name,
      kcu.column_name AS column_name,
      kcu.referenced_table_schema AS referenced_schema,
      kcu.referenced_table_name AS referenced_table,
      kcu.referenced_column_name AS referenced_column
    FROM information_schema.key_column_usage kcu
    WHERE kcu.referenced_table_schema IS NOT NULL
      AND kcu.table_schema = '${schemaName}'
  `);

  for (const row of fkResult.rows as RawMySqlFkRow[]) {
    const parent = tablesByName.get(`${row.schema_name}.${row.table_name}`);
    const referenced = tablesByName.get(`${row.referenced_schema}.${row.referenced_table}`);
    if (!parent || !referenced) continue;
    parent.foreignKeys.push({
      fromTable: parent.fullName,
      fromColumn: row.column_name,
      toTable: referenced.fullName,
      toColumn: row.referenced_column
    });
  }

  return Array.from(tablesByName.values());
};

export const loadSchemaFromDatabase = async (db: DbClient): Promise<TableInfo[]> =>
  db.dialect === "mysql" ? loadSchemaFromMySql(db) : loadSchemaFromSqlServer(db);

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
  tables: TableInfo[]
): Promise<number> => {
  await ensureSchemaCollection();

  const toUuid = (value: string): string => {
    const hash = createHash("sha1").update(value).digest("hex").slice(0, 32);
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
  };

  const batchSize = 20;
  for (let i = 0; i < tables.length; i += batchSize) {
    const batch = tables.slice(i, i + batchSize);
    const texts = batch.map(buildChunkText);
    const embeddings = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts
    });

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
        vector: embeddings.data[index]?.embedding ?? [],
        payload
      };
    });

    await qdrant.upsert("schema_chunks", {
      wait: true,
      points
    });
  }

  return tables.length;
};

let cachedSchema: { tables: TableChunk[]; loadedAt: number } | null = null;

export const clearSchemaCache = (): void => {
  cachedSchema = null;
};

export const loadSchemaGraph = async (): Promise<TableChunk[]> => {
  if (cachedSchema && Date.now() - cachedSchema.loadedAt < 5 * 60 * 1000) {
    return cachedSchema.tables;
  }

  await ensureSchemaCollection();

  const tables: TableChunk[] = [];
  let offset: string | number | undefined;

  do {
    const result = await qdrant.scroll("schema_chunks", {
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

  cachedSchema = { tables, loadedAt: Date.now() };
  return tables;
};
