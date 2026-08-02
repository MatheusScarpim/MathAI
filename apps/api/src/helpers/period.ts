export type YearRange = { startYear: number; endYear: number };

/**
 * Wider spans are almost always noise (an id, a phone number, two unrelated
 * years in the same sentence) rather than a period the user wants aggregated.
 */
const MAX_RANGE_SPAN = 50;

const stripAccents = (value: string): string =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/**
 * Explicit two-point language. These win over the range patterns at any span
 * because the two readings overlap: "diferenca entre 2023 e 2024" matches
 * "entre X e Y" but asks for a delta, not for the years in between.
 */
const HARD_COMPARISON_PATTERNS: RegExp[] = [
  /\bvs\.?\b/,
  /\bversus\b/,
  /\bcompar\w*/,
  /\bdiferenc\w*/,
  /\bdifferenc\w*/,
  /\b20\d{2}\s*x\s*20\d{2}\b/,
  /\bde\s+20\d{2}\s+para\s+20\d{2}\b/
];

/**
 * Trend words, which only imply a two-point reading over adjacent years. Over a
 * wider span they mean the opposite: "crescimento de 2017 a 2025" asks for the
 * whole series, and vetoing it here reintroduced the original bug (the text fell
 * through to the single-year match and the prompt said "Periodo atual: 2017").
 */
const TREND_PATTERNS: RegExp[] = [/\bcrescimento\b/, /\bcrecimiento\b/, /\bgrowth\b/];

/**
 * Continuous-interval phrasings in pt/en/es. Each must capture exactly two
 * four-digit years. Text is accent-stripped and lowercased first, so "até"
 * arrives here as "ate".
 */
const RANGE_PATTERNS: RegExp[] = [
  /\bde\s+(20\d{2})\s+(?:a|ate)\s+(20\d{2})\b/,
  /\bdesde\s+(20\d{2})\s+(?:ate|hasta|a)\s+(20\d{2})\b/,
  /\bentre\s+(20\d{2})\s+(?:e|y|and)\s+(20\d{2})\b/,
  /\bfrom\s+(20\d{2})\s+(?:to|through|thru|until)\s+(20\d{2})\b/,
  /\bbetween\s+(20\d{2})\s+and\s+(20\d{2})\b/,
  /\b(20\d{2})\s*[-–—]\s*(20\d{2})\b/,
  /\b(20\d{2})\s+(?:a|ate|to)\s+(20\d{2})\b/
];

/**
 * Reads a continuous year interval out of a question.
 *
 * Returns null when the text describes a comparison of two points instead of an
 * interval, when only one year is present, or when the span is implausible.
 * Callers treat a non-null result as "one query covering every year in the
 * range", never as "one sub-query per endpoint".
 */
export const parseYearRange = (text: string): YearRange | null => {
  if (!text) return null;
  const normalized = stripAccents(text).toLowerCase();

  if (HARD_COMPARISON_PATTERNS.some((pattern) => pattern.test(normalized))) return null;
  const trendWorded = TREND_PATTERNS.some((pattern) => pattern.test(normalized));

  for (const pattern of RANGE_PATTERNS) {
    const match = normalized.match(pattern);
    if (!match?.[1] || !match[2]) continue;

    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    const startYear = Math.min(first, second);
    const endYear = Math.max(first, second);

    if (startYear === endYear) return null;
    if (endYear - startYear > MAX_RANGE_SPAN) return null;
    if (trendWorded && endYear - startYear === 1) return null;

    return { startYear, endYear };
  }

  return null;
};

export const expandYears = (range: YearRange): number[] => {
  const years: number[] = [];
  for (let year = range.startYear; year <= range.endYear; year += 1) {
    years.push(year);
  }
  return years;
};

export const formatYearRange = (
  range: YearRange,
  language: "pt" | "en" | "es"
): string => {
  const connector = language === "en" ? "to" : "a";
  return `${range.startYear} ${connector} ${range.endYear}`;
};

/**
 * True when the years form an unbroken run of at least three, which reads as an
 * interval rather than a handful of cherry-picked periods.
 */
export const isContiguousYearRun = (years: number[]): boolean => {
  if (years.length < 3) return false;
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  if (sorted.length < 3) return false;
  return sorted.every((year, index) => index === 0 || year === sorted[index - 1]! + 1);
};

// ============== PERIOD DETECTION IN QUESTION TEXT ==============

const monthMap: Array<{ key: string; value: number }> = [
  { key: "janeiro", value: 1 }, { key: "jan", value: 1 },
  { key: "february", value: 2 }, { key: "feb", value: 2 }, { key: "fevereiro", value: 2 }, { key: "fev", value: 2 },
  { key: "march", value: 3 }, { key: "mar", value: 3 }, { key: "marco", value: 3 }, { key: "março", value: 3 },
  { key: "abril", value: 4 }, { key: "apr", value: 4 }, { key: "april", value: 4 },
  { key: "mayo", value: 5 }, { key: "may", value: 5 }, { key: "maio", value: 5 },
  { key: "junho", value: 6 }, { key: "jun", value: 6 }, { key: "june", value: 6 },
  { key: "julho", value: 7 }, { key: "jul", value: 7 }, { key: "july", value: 7 },
  { key: "agosto", value: 8 }, { key: "aug", value: 8 }, { key: "august", value: 8 },
  { key: "septiembre", value: 9 }, { key: "sept", value: 9 }, { key: "september", value: 9 }, { key: "setembro", value: 9 },
  { key: "outubro", value: 10 }, { key: "oct", value: 10 }, { key: "october", value: 10 },
  { key: "novembro", value: 11 }, { key: "nov", value: 11 }, { key: "november", value: 11 },
  { key: "dezembro", value: 12 }, { key: "dec", value: 12 }, { key: "december", value: 12 }, { key: "diciembre", value: 12 }
];

export type DetectedPeriod = { month?: number; year?: number; range?: YearRange };

/**
 * A continuous interval is checked before the single-year match: the bare
 * `/\b(20\d{2})\b/` below has no `/g` flag, so "de 2017 a 2025" would collapse
 * to `{ year: 2017 }` and the prompt would tell the agent to use 2017 only.
 */
export const findPeriodInText = (text: string): DetectedPeriod | null => {
  const lowered = text.toLowerCase();
  const range = parseYearRange(text);
  if (range) return { range };

  const yearMatch = lowered.match(/\b(20\d{2})\b/);
  const year = yearMatch?.[1] ? Number.parseInt(yearMatch[1], 10) : undefined;
  for (const item of monthMap) {
    const pattern = new RegExp(`\\b${item.key}\\b`, "i");
    if (pattern.test(lowered)) {
      return { month: item.value, year };
    }
  }
  return year ? { year } : null;
};

export const formatMonth = (month: number, language: "pt" | "en" | "es"): string => {
  const names =
    language === "en"
      ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
      : language === "es"
        ? ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
        : ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  return names[month - 1] ?? `${month}`;
};

export const formatPeriodText = (
  period: DetectedPeriod,
  language: "pt" | "en" | "es"
): string | null => {
  if (period.range) return formatYearRange(period.range, language);
  if (!period.month && !period.year) return null;
  const monthLabel = period.month ? formatMonth(period.month, language) : null;
  if (monthLabel && period.year) return `${monthLabel} ${period.year}`;
  if (monthLabel) return monthLabel;
  if (period.year) return String(period.year);
  return null;
};