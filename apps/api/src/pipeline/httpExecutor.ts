import type { HttpRequestPlan, ApiAuthConfig } from "@auraia/shared";

/* ── Types ───────────────────────────────────────────────── */

export type HttpExecutionResult = {
  recordset: Record<string, unknown>[];
  columns: string[];
  rawResponses: unknown[];
  /** Scalar envelope fields (total, page, next...) kept out of the row columns. */
  meta?: Record<string, unknown>;
};

/* ── Response envelope unwrapping ─────────────────────────── */

/**
 * Keys that commonly wrap the actual collection in a REST envelope, in the
 * order we trust them. `value` is OData, `d` is legacy ASP.NET/SAP.
 */
const ENVELOPE_KEYS = [
  "data",
  "items",
  "results",
  "records",
  "rows",
  "content",
  "value",
  "list",
  "payload",
  "d"
];

/**
 * Envelope siblings that describe the page rather than the data. Without this,
 * `{ total, page, data: [...] }` flattened into a single row whose columns were
 * `total`, `page` and `data` - so the summarizer answered from pagination
 * metadata instead of the records.
 */
const META_KEYS = new Set([
  "total", "totalcount", "total_count", "totalrecords", "total_records",
  "totalpages", "total_pages", "count", "page", "pagenumber", "page_number",
  "pagesize", "page_size", "per_page", "offset", "limit", "skip",
  "next", "nextpage", "next_page", "nextlink", "previous", "prev",
  "hasnext", "hasnextpage", "hasprevious", "haspreviouspage", "links", "_links",
  "meta", "_meta", "pagination", "paging", "status", "success", "message",
  "code", "errors", "error", "took", "timestamp"
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toRow = (value: unknown): Record<string, unknown> =>
  isPlainObject(value) ? value : { value };

const isScalar = (value: unknown): boolean =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

/** Scalar siblings of the chosen envelope key, reported as meta. */
const collectMeta = (
  envelope: Record<string, unknown>,
  usedKey: string
): Record<string, unknown> => {
  const meta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope)) {
    if (key === usedKey) continue;
    if (isScalar(value) || META_KEYS.has(key.toLowerCase())) meta[key] = value;
  }
  return meta;
};

const resolvePath = (data: unknown, path: string): unknown => {
  let current = data;
  for (const segment of path.split(".")) {
    if (!segment) continue;
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
};

export type ExtractedRows = {
  rows: Record<string, unknown>[];
  meta: Record<string, unknown>;
  /** Envelope key the rows came from. Empty when the payload was already a collection. */
  envelopePath: string;
};

const MAX_ENVELOPE_DEPTH = 2;

const autoExtract = (data: unknown, path: string, depth: number): ExtractedRows => {
  if (Array.isArray(data)) {
    return { rows: data.map(toRow), meta: {}, envelopePath: path };
  }

  if (!isPlainObject(data)) {
    return { rows: [toRow(data)], meta: {}, envelopePath: path };
  }

  if (depth < MAX_ENVELOPE_DEPTH) {
    // An envelope key holding a plain object, kept aside as a last resort: a
    // single-record response like `{ data: { id: 7 } }` is still an envelope,
    // but an array under a later key is the more likely collection, so arrays
    // get first refusal.
    let objectCandidate: { key: string; value: Record<string, unknown> } | null = null;

    // Known envelope keys first, in trust order.
    for (const key of ENVELOPE_KEYS) {
      if (!(key in data)) continue;
      const inner = data[key];
      const childPath = path ? `${path}.${key}` : key;

      if (Array.isArray(inner)) {
        return {
          rows: inner.map(toRow),
          meta: collectMeta(data, key),
          envelopePath: childPath
        };
      }

      // One level deeper: `{ d: { results: [...] } }`.
      if (isPlainObject(inner)) {
        const nested = autoExtract(inner, childPath, depth + 1);
        if (nested.envelopePath !== childPath) {
          return { ...nested, meta: { ...collectMeta(data, key), ...nested.meta } };
        }
        objectCandidate ??= { key, value: inner };
      }
    }

    // No known key matched: a single array-valued property is unambiguous.
    const arrayKeys = Object.keys(data).filter((key) => Array.isArray(data[key]));
    if (arrayKeys.length === 1) {
      const key = arrayKeys[0]!;
      return {
        rows: (data[key] as unknown[]).map(toRow),
        meta: collectMeta(data, key),
        envelopePath: path ? `${path}.${key}` : key
      };
    }

    // No array anywhere: unwrap the single-record envelope. Leaving it wrapped
    // produced one row whose only column was `data`, holding the whole record -
    // the same shape of uselessness as the array case.
    if (objectCandidate) {
      return {
        rows: [objectCandidate.value],
        meta: collectMeta(data, objectCandidate.key),
        envelopePath: path ? `${path}.${objectCandidate.key}` : objectCandidate.key
      };
    }
  }

  // Genuinely a single record.
  return { rows: [data], meta: {}, envelopePath: path };
};

/**
 * Turns an arbitrary JSON response into rows.
 *
 * Replaces `Array.isArray(resp) ? resp : [resp]`, which produced one useless
 * row for every paginated API - the most common shape in the wild.
 *
 * `responsePath` forces an explicit dot-path and skips auto-detection.
 */
export const extractRows = (
  responseData: unknown,
  responsePath?: string
): ExtractedRows => {
  const path = responsePath?.trim();
  if (!path) return autoExtract(responseData, "", 0);

  const resolved = resolvePath(responseData, path);
  if (resolved === undefined) return { rows: [], meta: {}, envelopePath: path };

  const meta = isPlainObject(responseData)
    ? collectMeta(responseData, path.split(".")[0]!)
    : {};

  return {
    rows: Array.isArray(resolved) ? resolved.map(toRow) : [toRow(resolved)],
    meta,
    envelopePath: path
  };
};

/* ── Auth ─────────────────────────────────────────────────── */

const applyAuth = (
  headers: Record<string, string>,
  auth: ApiAuthConfig
): Record<string, string> => {
  switch (auth.type) {
    case "bearer":
      return { ...headers, Authorization: `Bearer ${auth.token}` };
    case "apikey":
      return {
        ...headers,
        [auth.apiKeyHeader ?? "X-API-Key"]: auth.apiKeyValue ?? ""
      };
    case "basic": {
      const encoded = Buffer.from(
        `${auth.username ?? ""}:${auth.password ?? ""}`
      ).toString("base64");
      return { ...headers, Authorization: `Basic ${encoded}` };
    }
    default:
      return headers;
  }
};

/* ── URL helpers ─────────────────────────────────────────── */

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fd/i,
  /^fe80:/i,
  /^localhost$/i
];

const isPrivateHost = (hostname: string): boolean =>
  PRIVATE_IP_RANGES.some((pattern) => pattern.test(hostname));

const resolveUrl = (baseUrl: string, stepUrl: string): string => {
  const resolved = stepUrl.startsWith("http://") || stepUrl.startsWith("https://")
    ? stepUrl
    : `${baseUrl.replace(/\/+$/, "")}/${stepUrl.replace(/^\/+/, "")}`;

  try {
    const parsed = new URL(resolved);
    if (isPrivateHost(parsed.hostname)) {
      throw new Error(`URL bloqueada: acesso a hosts privados nao e permitido (${parsed.hostname})`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("URL bloqueada")) throw err;
    throw new Error(`URL invalida: ${resolved}`);
  }

  return resolved;
};

/* ── Value extraction (simple dot-path) ──────────────────── */

const extractValue = (data: unknown, path: string): unknown => {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

const replacePlaceholder = (
  value: string,
  extracted: unknown
): string => value.replace(/\{extracted\}/g, String(extracted));

/* ── Execute plan ────────────────────────────────────────── */

const REQUEST_TIMEOUT_MS = 30_000;

export const executeHttpPlan = async (
  plan: HttpRequestPlan,
  baseUrl: string,
  auth: ApiAuthConfig
): Promise<HttpExecutionResult> => {
  const stepResults = new Map<number, unknown>();
  const allRows: Record<string, unknown>[] = [];
  const rawResponses: unknown[] = [];
  const allMeta: Record<string, unknown> = {};

  const sorted = [...plan.steps].sort((a, b) => a.stepIndex - b.stepIndex);

  for (const step of sorted) {
    let url = resolveUrl(baseUrl, step.url);
    let body = step.body;

    // Resolve dependencies
    if (step.dependsOn !== undefined && step.extractFrom) {
      const prevResult = stepResults.get(step.dependsOn);
      if (prevResult) {
        const extracted = extractValue(prevResult, step.extractFrom);
        url = replacePlaceholder(url, extracted);
        if (typeof body === "string") {
          body = replacePlaceholder(body, extracted);
        } else if (body && typeof body === "object") {
          body = JSON.parse(
            replacePlaceholder(JSON.stringify(body), extracted)
          );
        }
      }
    }

    // Apply query params
    if (step.queryParams && Object.keys(step.queryParams).length > 0) {
      const params = new URLSearchParams(step.queryParams);
      url += (url.includes("?") ? "&" : "?") + params.toString();
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(step.headers ?? {})
    };
    const authedHeaders = applyAuth(headers, auth);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(url, {
        method: step.method.toUpperCase(),
        headers: authedHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(
          `HTTP ${response.status} de ${step.method} ${url}: ${errorText.slice(0, 500)}`
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      let responseData: unknown;
      if (contentType.includes("application/json")) {
        responseData = await response.json();
      } else {
        responseData = { _raw: await response.text() };
      }

      stepResults.set(step.stepIndex, responseData);
      rawResponses.push(responseData);

      // Flatten response into rows, unwrapping any pagination envelope
      const extracted = extractRows(responseData);
      allRows.push(...extracted.rows);
      Object.assign(allMeta, extracted.meta);
    } finally {
      clearTimeout(timeout);
    }
  }

  // Union of keys, not just the first row's: unwrapped records are often sparse,
  // and keying off row 0 silently dropped every column it happened to omit.
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of allRows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }

  return {
    recordset: allRows,
    columns,
    rawResponses,
    meta: Object.keys(allMeta).length > 0 ? allMeta : undefined
  };
};
