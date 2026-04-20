import type { HttpRequestPlan, ApiAuthConfig } from "@auraia/shared";

/* ── Types ───────────────────────────────────────────────── */

export type HttpExecutionResult = {
  recordset: Record<string, unknown>[];
  columns: string[];
  rawResponses: unknown[];
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

      // Flatten response into rows
      const rows = Array.isArray(responseData)
        ? responseData
        : [responseData];
      for (const row of rows) {
        if (typeof row === "object" && row !== null) {
          allRows.push(row as Record<string, unknown>);
        } else {
          allRows.push({ value: row });
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  const columns =
    allRows.length > 0 ? Object.keys(allRows[0]!) : [];
  return { recordset: allRows, columns, rawResponses };
};
