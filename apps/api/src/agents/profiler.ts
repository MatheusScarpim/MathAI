import type { TableChunk } from "@auraia/shared";
import type { DbAdapter } from "../core/db.js";
import type { DbType } from "../core/appConfig.js";

export type ColumnProfile = {
  name: string;
  values?: string[];
  range?: string;
};

export type TableProfileMap = Map<string, ColumnProfile[]>;

const cache = new Map<string, { profiles: ColumnProfile[]; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const SAMPLE_ROWS = 200;
const MAX_CARDINALITY = 15;
const MAX_VALUES = 10;

const buildSampleQuery = (tableFullName: string, dbType: DbType): string => {
  if (dbType === "oracle") return `SELECT * FROM ${tableFullName} FETCH FIRST ${SAMPLE_ROWS} ROWS ONLY`;
  if (dbType === "sqlserver") return `SELECT TOP (${SAMPLE_ROWS}) * FROM ${tableFullName}`;
  return `SELECT * FROM ${tableFullName} LIMIT ${SAMPLE_ROWS}`;
};

const isNumericColumn = (values: string[]): boolean => {
  if (!values.length) return false;
  return values.every(v => !Number.isNaN(Number(v)));
};

const profileColumns = (
  rows: Record<string, unknown>[],
  columns: string[]
): ColumnProfile[] => {
  return columns.map(col => {
    const strValues = rows
      .map(row => row[col])
      .filter(v => v !== null && v !== undefined && String(v).trim() !== "")
      .map(v => String(v).trim());

    if (!strValues.length) return { name: col };

    const uniqueValues = [...new Set(strValues)];

    if (uniqueValues.length <= MAX_CARDINALITY) {
      const freq = new Map<string, number>();
      for (const v of strValues) freq.set(v, (freq.get(v) ?? 0) + 1);
      const topValues = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_VALUES)
        .map(([v]) => v);
      return { name: col, values: topValues };
    }

    if (isNumericColumn(strValues)) {
      const nums = strValues.map(Number);
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      if (min !== max) return { name: col, range: `${min}..${max}` };
    }

    return { name: col };
  });
};

export const profileTable = async (
  table: TableChunk,
  adapter: DbAdapter,
  dbType: DbType,
  environmentId?: string
): Promise<ColumnProfile[]> => {
  const cacheKey = `${environmentId ?? "default"}:${table.tableFullName}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.profiles;

  try {
    const querySql = buildSampleQuery(table.tableFullName, dbType);
    const result = await adapter.query<Record<string, unknown>>(querySql);
    const profiles = profileColumns(result.recordset, result.columns);
    cache.set(cacheKey, { profiles, expiresAt: Date.now() + CACHE_TTL_MS });
    return profiles;
  } catch {
    return [];
  }
};

export const profileTables = async (
  tables: TableChunk[],
  adapter: DbAdapter,
  dbType: DbType,
  environmentId?: string
): Promise<TableProfileMap> => {
  const results = await Promise.allSettled(
    tables.map(t => profileTable(t, adapter, dbType, environmentId))
  );

  const map: TableProfileMap = new Map();
  for (let i = 0; i < tables.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      map.set(tables[i].tableFullName, result.value);
    }
  }
  return map;
};
