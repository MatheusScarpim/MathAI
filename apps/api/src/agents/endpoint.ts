import type { EndpointChunk } from "@auraia/shared";
import { qdrant } from "../qdrant.js";
import { loadEndpointGraph } from "../swagger.js";

/* ── Types ───────────────────────────────────────────────── */

export type ExpandedEndpointContext = {
  endpoints: EndpointChunk[];
  relatedEndpoints: EndpointChunk[];
};

/* ── Text helpers ────────────────────────────────────────── */

const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_.\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenize = (value: string): string[] =>
  normalizeText(value)
    .split(/[\s.\-_/]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

/* ── Scoring ─────────────────────────────────────────────── */

const scoreEndpointMatch = (
  questionTokens: string[],
  endpoint: EndpointChunk
): number => {
  const endpointTokens = new Set<string>([
    ...tokenize(endpoint.path),
    ...tokenize(endpoint.operationId ?? ""),
    ...tokenize(endpoint.summary ?? ""),
    ...endpoint.tags.flatMap((t) => tokenize(t))
  ]);
  if (!endpointTokens.size || !questionTokens.length) return 0;

  let score = 0;
  for (const token of questionTokens) {
    if (endpointTokens.has(token)) {
      score += 2;
      continue;
    }
    for (const t of endpointTokens) {
      if (t.length < 4 || token.length < 4) continue;
      if (t.includes(token) || token.includes(t)) {
        score += 1;
        break;
      }
    }
  }
  return score;
};

/* ── Search ──────────────────────────────────────────────── */

export const searchRelevantEndpoints = async (
  vector: number[],
  question: string,
  maxEndpoints: number = 8
): Promise<EndpointChunk[]> => {
  const safeMax = Number.isFinite(maxEndpoints)
    ? Math.max(1, Math.min(30, Math.floor(maxEndpoints)))
    : 8;

  const search = await qdrant.search("endpoint_chunks", {
    vector,
    limit: Math.max(3, safeMax + 2),
    with_payload: true
  });

  const semanticResults = search
    .map((point) => point.payload as EndpointChunk)
    .filter((payload) => Boolean(payload?.path));

  const questionTokens = tokenize(question);
  if (!questionTokens.length) return semanticResults;

  const allEndpoints = await loadEndpointGraph();
  const lexicalMatches = allEndpoints
    .map((ep) => ({ ep, score: scoreEndpointMatch(questionTokens, ep) }))
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(3, safeMax))
    .map((item) => item.ep);

  const merged = new Map<string, EndpointChunk>();
  for (const ep of semanticResults) {
    merged.set(`${ep.method}:${ep.path}`, ep);
  }
  for (const ep of lexicalMatches) {
    const key = `${ep.method}:${ep.path}`;
    if (!merged.has(key)) merged.set(key, ep);
  }

  return Array.from(merged.values()).slice(0, safeMax);
};

/* ── Text-based search (for error recovery) ─────────────── */

export const searchEndpointsByText = async (
  text: string,
  max: number = 5
): Promise<EndpointChunk[]> => {
  const tokens = tokenize(text);
  if (!tokens.length) return [];

  const allEndpoints = await loadEndpointGraph();
  return allEndpoints
    .map((ep) => ({ ep, score: scoreEndpointMatch(tokens, ep) }))
    .filter((item) => item.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((item) => item.ep);
};

/* ── Expand (related endpoints by path prefix / tags) ──── */

export const expandEndpoints = async (
  initial: EndpointChunk[]
): Promise<ExpandedEndpointContext> => {
  const allEndpoints = await loadEndpointGraph();
  const initialKeys = new Set(initial.map((e) => `${e.method}:${e.path}`));

  const initialPrefixes = initial.map((ep) => {
    const segments = ep.path.split("/").filter(Boolean);
    return segments.length > 1
      ? "/" + segments.slice(0, -1).join("/")
      : ep.path;
  });

  const initialTags = new Set(initial.flatMap((ep) => ep.tags));

  const related: EndpointChunk[] = [];
  for (const ep of allEndpoints) {
    const key = `${ep.method}:${ep.path}`;
    if (initialKeys.has(key)) continue;

    const sharesPrefix = initialPrefixes.some(
      (prefix) => ep.path.startsWith(prefix) && prefix.length > 1
    );
    const sharesTag =
      ep.tags.length > 0 && ep.tags.some((tag) => initialTags.has(tag));

    if (sharesPrefix || sharesTag) {
      related.push(ep);
    }
  }

  return { endpoints: initial, relatedEndpoints: related.slice(0, 5) };
};
