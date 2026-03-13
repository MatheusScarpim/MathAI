import type { EndpointChunk, EndpointParameter } from "@auraia/shared";
import { getOpenAI, EMBEDDING_MODEL } from "./openai.js";
import { qdrant, ensureEndpointCollection } from "./qdrant.js";
import { createHash } from "crypto";
import YAML from "js-yaml";

/* ── Types ───────────────────────────────────────────────── */

type ParsedEndpoint = {
  operationId: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  parameters: EndpointParameter[];
  requestBodySchema?: object;
  responseSchema?: object;
  tags: string[];
};

type OpenApiSpec = {
  openapi?: string;
  swagger?: string;
  basePath?: string;
  servers?: Array<{ url: string }>;
  paths?: Record<string, Record<string, OpenApiOperation>>;
};

type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    content?: Record<string, { schema?: object }>;
  };
  responses?: Record<string, { content?: Record<string, { schema?: object }> }>;
};

type OpenApiParameter = {
  name: string;
  in: string;
  required?: boolean;
  schema?: { type?: string };
  type?: string;
  description?: string;
};

/* ── Fetch ───────────────────────────────────────────────── */

/**
 * Common spec paths to try when the user provides a Swagger UI URL
 * instead of the raw JSON/YAML spec.
 */
const SPEC_PATH_CANDIDATES = [
  "/swagger/v1/swagger.json",
  "/swagger/v2/swagger.json",
  "/swagger.json",
  "/openapi.json",
  "/v2/api-docs",
  "/v3/api-docs",
  "/api-docs",
  "/api/swagger.json",
];

const isHtml = (text: string): boolean =>
  text.trimStart().startsWith("<!") || text.trimStart().startsWith("<html");

const tryFetchSpec = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const text = await response.text();
    if (isHtml(text)) return null;
    return text;
  } catch {
    return null;
  }
};

export const fetchSwaggerSpec = async (url: string): Promise<string> => {
  // First, try the URL as given
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch swagger spec: HTTP ${response.status}`);
  }
  const text = await response.text();

  // If it's not HTML, return as-is (it's already JSON/YAML)
  if (!isHtml(text)) return text;

  // The URL returned HTML (Swagger UI page). Try to find the real spec.
  const parsed = new URL(url);
  const baseOrigin = parsed.origin;

  for (const candidate of SPEC_PATH_CANDIDATES) {
    const specText = await tryFetchSpec(`${baseOrigin}${candidate}`);
    if (specText) return specText;
  }

  throw new Error(
    `A URL fornecida retornou uma página HTML (Swagger UI), não a spec JSON/YAML. ` +
    `Tente usar a URL direta da spec, ex: ${baseOrigin}/swagger/v1/swagger.json`
  );
};

/* ── Parse ───────────────────────────────────────────────── */

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

const resolveSchemaType = (param: OpenApiParameter): string => {
  if (param.schema?.type) return param.schema.type;
  if (param.type) return param.type;
  return "string";
};

const getSuccessResponseSchema = (
  responses?: Record<string, { content?: Record<string, { schema?: object }> }>
): object | undefined => {
  if (!responses) return undefined;
  for (const code of ["200", "201", "default"]) {
    const resp = responses[code];
    if (!resp?.content) continue;
    const json =
      resp.content["application/json"] ??
      resp.content["*/*"] ??
      Object.values(resp.content)[0];
    if (json?.schema) return json.schema;
  }
  return undefined;
};

export const parseSwaggerSpec = (specContent: string): ParsedEndpoint[] => {
  let spec: OpenApiSpec;
  try {
    spec = JSON.parse(specContent) as OpenApiSpec;
  } catch {
    spec = YAML.load(specContent) as OpenApiSpec;
  }

  if (!spec?.paths) return [];

  const endpoints: ParsedEndpoint[] = [];
  let autoId = 0;

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!HTTP_METHODS.includes(method.toLowerCase())) continue;

      const op = operation as OpenApiOperation;
      const parameters: EndpointParameter[] = (op.parameters ?? []).map((p) => ({
        name: p.name,
        in: p.in as EndpointParameter["in"],
        required: p.required ?? false,
        type: resolveSchemaType(p),
        description: p.description
      }));

      let requestBodySchema: object | undefined;
      if (op.requestBody?.content) {
        const json =
          op.requestBody.content["application/json"] ??
          Object.values(op.requestBody.content)[0];
        requestBodySchema = json?.schema;
      }

      const responseSchema = getSuccessResponseSchema(op.responses);

      endpoints.push({
        operationId: op.operationId ?? `${method}_${path.replace(/[^a-zA-Z0-9]/g, "_")}_${autoId++}`,
        method: method.toUpperCase(),
        path,
        summary: op.summary,
        description: op.description,
        parameters,
        requestBodySchema,
        responseSchema,
        tags: op.tags ?? []
      });
    }
  }

  return endpoints;
};

/* ── Qdrant Ingestion ────────────────────────────────────── */

const MAX_CHUNK_CHARS = 24_000;

const buildEndpointChunkText = (endpoint: ParsedEndpoint): string => {
  const params = endpoint.parameters
    .map((p) => `${p.name} (${p.in}, ${p.type}${p.required ? ", required" : ""})`)
    .join(", ");

  const text = [
    `Endpoint: ${endpoint.method.toUpperCase()} ${endpoint.path}`,
    endpoint.summary ? `Summary: ${endpoint.summary}` : null,
    endpoint.description ? `Description: ${endpoint.description}` : null,
    params ? `Parameters: ${params}` : null,
    endpoint.requestBodySchema
      ? `Request Body: ${JSON.stringify(endpoint.requestBodySchema).slice(0, 2000)}`
      : null,
    endpoint.responseSchema
      ? `Response: ${JSON.stringify(endpoint.responseSchema).slice(0, 2000)}`
      : null,
    endpoint.tags.length ? `Tags: ${endpoint.tags.join(", ")}` : null
  ]
    .filter(Boolean)
    .join("\n");

  return text.length > MAX_CHUNK_CHARS
    ? text.slice(0, MAX_CHUNK_CHARS) + "..."
    : text;
};

const toUuid = (value: string): string => {
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
};

export const ingestEndpointsToQdrant = async (
  endpoints: ParsedEndpoint[]
): Promise<number> => {
  await ensureEndpointCollection();

  const batchSize = 20;
  for (let i = 0; i < endpoints.length; i += batchSize) {
    const batch = endpoints.slice(i, i + batchSize);
    const texts = batch.map(buildEndpointChunkText);
    const client = await getOpenAI();
    const embeddings = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts
    });

    const points = batch.map((endpoint, index) => {
      const payload: EndpointChunk = {
        operationId: endpoint.operationId,
        method: endpoint.method.toUpperCase() as EndpointChunk["method"],
        path: endpoint.path,
        summary: endpoint.summary,
        description: endpoint.description,
        parameters: endpoint.parameters,
        requestBodySchema: endpoint.requestBodySchema
          ? JSON.stringify(endpoint.requestBodySchema)
          : undefined,
        responseSchema: endpoint.responseSchema
          ? JSON.stringify(endpoint.responseSchema)
          : undefined,
        tags: endpoint.tags
      };

      return {
        id: toUuid(`${endpoint.method}:${endpoint.path}`),
        vector: embeddings.data[index]?.embedding ?? [],
        payload
      };
    });

    await qdrant.upsert("endpoint_chunks", {
      wait: true,
      points
    });
  }

  return endpoints.length;
};

/* ── Endpoint Graph (from Qdrant) ────────────────────────── */

let cachedEndpoints: { endpoints: EndpointChunk[]; loadedAt: number } | null =
  null;

export const clearEndpointCache = (): void => {
  cachedEndpoints = null;
};

export const loadEndpointGraph = async (): Promise<EndpointChunk[]> => {
  if (
    cachedEndpoints &&
    Date.now() - cachedEndpoints.loadedAt < 5 * 60 * 1000
  ) {
    return cachedEndpoints.endpoints;
  }

  await ensureEndpointCollection();

  const endpoints: EndpointChunk[] = [];
  let offset: string | number | undefined;

  do {
    const result = await qdrant.scroll("endpoint_chunks", {
      limit: 100,
      offset,
      with_payload: true,
      with_vector: false
    });

    for (const point of result.points) {
      if (!point.payload) continue;
      endpoints.push(point.payload as EndpointChunk);
    }

    const next = result.next_page_offset;
    offset =
      typeof next === "string" || typeof next === "number" ? next : undefined;
  } while (offset !== undefined);

  cachedEndpoints = { endpoints, loadedAt: Date.now() };
  return endpoints;
};
