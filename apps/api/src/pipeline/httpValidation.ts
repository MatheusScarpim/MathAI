import type { AskErrorResponse, HttpRequestPlan } from "@auraia/shared";

const DESTRUCTIVE_METHODS = ["DELETE", "PUT", "PATCH", "POST"];
const VALID_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const MAX_STEPS = 5;

/**
 * The set of HTTP methods an environment may index and execute.
 *
 * When `apiIngestMethods` is absent the fallback reproduces the exact behaviour
 * from before the field existed, which depends on `readOnly`: a read-only
 * environment allowed GET only, while a non-read-only one allowed every valid
 * method. Defaulting unconditionally to `["GET"]` would have quietly broken
 * every environment deliberately running with `apiReadOnly: false` to write.
 *
 * Unknown method names are dropped rather than failing the call, so one typo in
 * config cannot take an environment offline - but a list that reduces to
 * nothing falls back instead of ending up empty (which would block everything).
 */
export const resolveAllowedMethods = (
  configured: string[] | undefined,
  readOnly: boolean
): string[] => {
  const fallback = readOnly ? ["GET"] : [...VALID_METHODS];
  if (!Array.isArray(configured)) return fallback;

  const normalized = configured
    .filter((m): m is string => typeof m === "string")
    .map((m) => m.trim().toUpperCase())
    .filter((m) => VALID_METHODS.includes(m));

  const unique = Array.from(new Set(normalized));
  return unique.length > 0 ? unique : fallback;
};

/**
 * Canonicalizes an inbound allowlist (upper-case, deduped, known methods only)
 * so the persisted document is already in the shape `resolveAllowedMethods`
 * wants. `undefined` means "not configured" and must survive as such: storing
 * `[]` would be indistinguishable from an explicit empty allowlist, and an
 * all-garbage list must not silently become a real restriction either.
 */
export const normalizeIngestMethods = (value?: string[]): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const normalized = Array.from(
    new Set(
      value
        .filter((m): m is string => typeof m === "string")
        .map((m) => m.trim().toUpperCase())
        .filter((m) => VALID_METHODS.includes(m))
    )
  );

  return normalized.length > 0 ? normalized : undefined;
};

export const validateHttpRequest = (
  plan: HttpRequestPlan,
  baseUrl: string,
  readOnly: boolean,
  allowedMethods: string[] = readOnly ? ["GET"] : [...VALID_METHODS]
): { ok: true } | { ok: false; error: AskErrorResponse } => {
  if (!plan.steps || plan.steps.length === 0) {
    return {
      ok: false,
      error: { errorMessage: "Plano de requisicao HTTP vazio." }
    };
  }

  if (plan.steps.length > MAX_STEPS) {
    return {
      ok: false,
      error: {
        errorMessage: `Plano excede o maximo de ${MAX_STEPS} steps.`
      }
    };
  }

  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const stepIndices = new Set(plan.steps.map((s) => s.stepIndex));

  for (const step of plan.steps) {
    const method = step.method.toUpperCase();

    if (!VALID_METHODS.includes(method)) {
      return {
        ok: false,
        error: {
          errorMessage: `Metodo HTTP invalido: ${step.method}.`
        }
      };
    }

    // The environment's allowlist outranks every other method rule: a method
    // that was never indexable must never be executable either, read-only or
    // not. Checked before the read-only rule so the message names the real
    // reason (not on the list) instead of blaming read-only mode.
    if (!allowedMethods.includes(method)) {
      return {
        ok: false,
        error: {
          errorMessage:
            `Metodo ${step.method} nao esta habilitado neste ambiente. ` +
            `Metodos permitidos: ${allowedMethods.join(", ")}.`
        }
      };
    }

    // Allowlisting POST is the opt-in that declares "POST is a query in this
    // API", so it stops counting as destructive. The exemption is POST-only on
    // purpose: PUT/PATCH/DELETE have no read-only reading, so allowlisting one
    // of those (to index it) still must not make it executable here.
    const isDestructive =
      DESTRUCTIVE_METHODS.includes(method) && method !== "POST";

    if (readOnly && isDestructive) {
      return {
        ok: false,
        error: {
          errorMessage: `Metodo ${step.method} nao permitido em modo somente-leitura.`
        }
      };
    }

    // URL must match base URL or be a relative path
    const isRelative = step.url.startsWith("/");
    const matchesBase =
      step.url.startsWith(normalizedBase + "/") ||
      step.url === normalizedBase;

    if (!isRelative && !matchesBase) {
      return {
        ok: false,
        error: {
          errorMessage: `URL ${step.url} nao corresponde a base URL configurada (${baseUrl}).`
        }
      };
    }

    // Validate dependsOn references
    if (step.dependsOn !== undefined) {
      if (!stepIndices.has(step.dependsOn)) {
        return {
          ok: false,
          error: {
            errorMessage: `Step ${step.stepIndex} depende do step inexistente ${step.dependsOn}.`
          }
        };
      }
      if (step.dependsOn >= step.stepIndex) {
        return {
          ok: false,
          error: {
            errorMessage: `Step ${step.stepIndex} nao pode depender de um step futuro (${step.dependsOn}).`
          }
        };
      }
    }
  }

  return { ok: true };
};
