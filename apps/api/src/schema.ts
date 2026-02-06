import type { ColumnInfo, ForeignKeyInfo, TableChunk } from "@auraia/shared";
import sql from "mssql";
import { openai, EMBEDDING_MODEL } from "./openai.js";
import { qdrant, ensureSchemaCollection } from "./qdrant.js";
import { createHash } from "crypto";

type RawTableRow = {
  schema_name: string;
  table_name: string;
  object_id: number;
  object_type: "U" | "V";
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

export const loadSchemaFromSqlServer = async (
  pool: sql.ConnectionPool
): Promise<TableInfo[]> => {
  const tablesResult = await pool.request().query<RawTableRow>(`
    SELECT s.name AS schema_name, o.name AS table_name, o.object_id, o.type AS object_type
    FROM sys.objects o
    INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
    WHERE o.type IN ('U','V')
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

  const columnsResult = await pool.request().query<RawColumnRow>(`
    SELECT c.object_id, c.name AS column_name, ty.name AS data_type
    FROM sys.columns c
    INNER JOIN sys.types ty ON c.user_type_id = ty.user_type_id
  `);

  for (const row of columnsResult.recordset) {
    const table = tablesById.get(row.object_id);
    if (!table) continue;
    table.columns.push({ name: row.column_name, type: row.data_type });
  }

  const pkResult = await pool.request().query<RawPkRow>(`
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

  const fkResult = await pool.request().query<RawFkRow>(`
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
