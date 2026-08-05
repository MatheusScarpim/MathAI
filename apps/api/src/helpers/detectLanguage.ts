import type { ValidLanguage } from "./settings.js";

/**
 * Deterministic pt/en/es detector for the incoming question.
 *
 * Why not an LLM call: this runs on every request, before anything else, and a
 * round trip here would sit on the critical path for a decision that stopwords
 * settle correctly the overwhelming majority of the time. It is also free and
 * testable.
 *
 * The word lists below only contain terms that are *distinctive* between the
 * three languages. Anything shared is deliberately absent, because a shared
 * token contributes noise to every score equally and only dilutes the margin:
 *   - "para", "total", "clientes", "por", "mes" (es "mes" == pt "mes")
 *   - "dos" (pt "of the" vs es "two")
 *   - "ultimos" (identical unaccented in pt and es)
 */

type Scores = Record<ValidLanguage, number>;

export type LanguageDetection = {
  /** Best guess, or null when the text is too short/ambiguous to call. */
  language: ValidLanguage | null;
  /** 0..1 margin between the winner and the runner-up. */
  confidence: number;
  /**
   * True when the margin is wide enough to override a caller-declared language.
   * Deliberately stricter than `language !== null`.
   */
  confident: boolean;
  scores: Scores;
};

const PT_WORDS = new Set([
  "nao", "sao", "voce", "qual", "quais", "quantos", "quantas", "quanto", "quanta",
  "em", "com", "das", "num", "numa", "pelo", "pela", "ate", "entao", "tambem",
  "vendas", "faturamento", "produtos", "ano", "anos", "mostre", "liste", "media",
  "maior", "melhores", "piores", "cresceu", "crescimento", "receita",
  "quantidade", "faturou", "vendeu", "versus", "ontem",
  "hoje", "acima", "abaixo", "soma", "contagem",
  "porcentagem", "estoque", "fornecedores", "filiais", "loja", "lojas"
]);

const ES_WORDS = new Set([
  "cuantos", "cuantas", "cuanto", "cuanta", "cual", "cuales", "como", "donde",
  "los", "las", "del", "una", "unos", "unas", "esta", "estan", "muy", "tambien",
  "ventas", "facturacion", "productos", "anio", "anios", "muestra", "listar",
  "promedio", "mayor", "mejores", "peores", "crecio", "crecimiento",
  "ingresos", "cantidad", "factura", "vendio", "ayer",
  "hoy", "arriba", "abajo", "suma", "conteo",
  "porcentaje", "inventario", "proveedores", "sucursales", "tienda"
]);

const EN_WORDS = new Set([
  "how", "many", "much", "what", "which", "who", "where", "when", "the", "of",
  "and", "in", "for", "by", "with", "from", "was", "were", "are", "is", "did",
  "sales", "revenue", "products", "year", "years", "month", "last", "top",
  "show", "list", "count", "average", "grew", "growth", "compared", "between",
  "highest", "lowest", "best", "worst", "total", "amount", "orders", "sold",
  "yesterday", "today", "week", "quarter", "above", "below", "sum", "each",
  "percentage", "users", "inventory", "suppliers", "branches", "store", "stores"
]);

/**
 * Exposed so a test can assert the lists stay disjoint. A word present in two
 * lists adds the same weight to both, so it never changes which language wins -
 * it just shrinks the margin, and the margin is what `confident` is computed
 * from. Enough shared words and a genuinely Spanish question stops being
 * confident and silently falls back to the declared language.
 */
export const WORD_LISTS = { pt: PT_WORDS, en: EN_WORDS, es: ES_WORDS };

/** Characters that only one of the three languages uses. */
const PT_ONLY_CHARS = /[\u00e3\u00f5\u00e7]/; // a-tilde, o-tilde, c-cedilla
const ES_ONLY_CHARS = /[\u00f1\u00bf\u00a1]/; // n-tilde, inverted ? and !

const stripAccents = (value: string): string =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const tokenize = (value: string): string[] => {
  const matches = stripAccents(value.toLowerCase()).match(/[a-z0-9_]+/g);
  return matches ?? [];
};

export const detectLanguage = (text: string): LanguageDetection => {
  const scores: Scores = { pt: 0, en: 0, es: 0 };
  const raw = text.toLowerCase();

  // Unique tokens only: a question repeating "vendas" five times is not five
  // times more Portuguese, and counting occurrences lets one word bury the rest.
  for (const token of new Set(tokenize(text))) {
    if (PT_WORDS.has(token)) scores.pt += 1;
    if (ES_WORDS.has(token)) scores.es += 1;
    if (EN_WORDS.has(token)) scores.en += 1;
  }

  // Orthography outweighs a single stopword but must not outvote two of them:
  // "sales for Sao Paulo" (a-tilde) is English text carrying a Portuguese name,
  // and a +3 bonus here would confidently mislabel it.
  if (PT_ONLY_CHARS.test(raw)) scores.pt += 2;
  if (ES_ONLY_CHARS.test(raw)) scores.es += 2;

  const ranked = (Object.keys(scores) as ValidLanguage[]).sort(
    (a, b) => scores[b] - scores[a]
  );
  const winner = ranked[0]!;
  const top = scores[winner];
  const second = scores[ranked[1]!];

  if (top < 2 || top === second) {
    return { language: null, confidence: 0, confident: false, scores };
  }

  const confidence = (top - second) / top;
  // Two independent signals for the winner and a clear gap to the runner-up.
  const confident = top >= 2 && top - second >= 2;

  return { language: winner, confidence, confident, scores };
};
