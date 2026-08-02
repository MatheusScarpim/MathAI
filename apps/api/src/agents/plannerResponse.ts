/**
 * Shapes and response parsing for the planner agent, kept apart from planner.ts
 * because that module pulls the OpenAI client and the app config at import time.
 * These functions are pure, so living here is what lets them be unit tested
 * offline.
 */

export type SubQuestion = {
  id: string;
  question: string;
  focus: string;
};

export type CombinationStrategy = "cte" | "join" | "union" | "single";

export type DecompositionPlan = {
  needsDecomposition: boolean;
  subQuestions: SubQuestion[];
  combinationStrategy: CombinationStrategy;
  combinationHint: string;
  originalQuestion: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

const MAX_SUB_QUESTIONS = 4;

const STRATEGIES: CombinationStrategy[] = ["cte", "join", "union", "single"];

/**
 * Why this returns a reason instead of just a plan: every non-decomposition
 * outcome used to look identical from the outside — a malformed JSON response
 * and a model that deliberately answered "this is a simple question" both
 * degraded to `needsDecomposition: false` with no trace. A broken planner was
 * therefore indistinguishable from an idle one.
 */
export type PlannerParse =
  | { decompose: true; subQuestions: SubQuestion[]; strategy: CombinationStrategy; hint: string }
  | { decompose: false; reason: string };

const isSubQuestion = (value: unknown): value is SubQuestion => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.question === "string" && item.question.trim().length > 0;
};

export const parsePlannerResponse = (raw: string): PlannerParse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { decompose: false, reason: `json invalido: ${message}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { decompose: false, reason: "resposta nao e um objeto json" };
  }

  const body = parsed as Record<string, unknown>;

  if (body.needsDecomposition !== true) {
    return { decompose: false, reason: "planner respondeu needsDecomposition=false" };
  }

  const rawSubQuestions = Array.isArray(body.subQuestions) ? body.subQuestions : [];
  const subQuestions = rawSubQuestions
    .filter(isSubQuestion)
    .slice(0, MAX_SUB_QUESTIONS)
    .map((item, index) => ({
      id: typeof item.id === "string" && item.id.trim() ? item.id : `sq${index + 1}`,
      question: item.question,
      focus: typeof item.focus === "string" ? item.focus : ""
    }));

  // A single sub-question is not a decomposition, it is the original question
  // with extra latency, so it degrades on purpose.
  if (subQuestions.length < 2) {
    return {
      decompose: false,
      reason: `needsDecomposition=true com ${subQuestions.length} subpergunta(s) validas de ${rawSubQuestions.length}`
    };
  }

  const declared = body.combinationStrategy;
  const strategy = STRATEGIES.includes(declared as CombinationStrategy)
    ? (declared as CombinationStrategy)
    : "cte";

  return {
    decompose: true,
    subQuestions,
    // "single" contradicts a decomposition, so it is read as an unset value.
    strategy: strategy === "single" ? "cte" : strategy,
    hint: typeof body.combinationHint === "string" ? body.combinationHint : ""
  };
};

/** The shape every degradation path returns: answer the question as-is. */
export const noDecomposition = (
  question: string,
  usage?: DecompositionPlan["usage"]
): DecompositionPlan => ({
  needsDecomposition: false,
  subQuestions: [],
  combinationStrategy: "single",
  combinationHint: "",
  originalQuestion: question,
  usage
});
