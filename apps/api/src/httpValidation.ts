import type { AskErrorResponse, HttpRequestPlan } from "@auraia/shared";

const DESTRUCTIVE_METHODS = ["DELETE", "PUT", "PATCH", "POST"];
const VALID_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const MAX_STEPS = 5;

export const validateHttpRequest = (
  plan: HttpRequestPlan,
  baseUrl: string,
  readOnly: boolean
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

    if (readOnly && DESTRUCTIVE_METHODS.includes(method)) {
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
