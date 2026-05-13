// Generic retry-with-fallback wrapper for LLM agent calls.
// Goal: planner / reviewer / reporter must NEVER throw — they always
// return a value (degraded if necessary), so the pipeline keeps running.

export type RetryOptions<T> = {
  /** Total attempts including the first try. Default 3. */
  attempts?: number;
  /** Base delay in ms; subsequent attempts use exponential backoff (base, base*2, base*4...). Default 500. */
  baseDelayMs?: number;
  /** Label used in console.warn logs. */
  label: string;
  /** Called once if all attempts fail. Must return a usable fallback value. */
  fallback: (lastError: unknown) => T | Promise<T>;
  /** Override which errors trigger a retry. Default: every error except AbortError. */
  isRetryable?: (err: unknown) => boolean;
};

const defaultIsRetryable = (err: unknown): boolean => {
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: unknown }).name;
    if (name === "AbortError") return false;
  }
  return true;
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const withRetry = async <T>(
  fn: () => Promise<T>,
  opts: RetryOptions<T>
): Promise<T> => {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseDelay = Math.max(0, opts.baseDelayMs ?? 500);
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;

  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[withRetry] ${opts.label} attempt ${i + 1}/${attempts} failed: ${message}`);

      if (i === attempts - 1) break;
      if (!isRetryable(err)) break;

      const delay = baseDelay * Math.pow(2, i);
      await sleep(delay);
    }
  }

  console.warn(`[withRetry] ${opts.label} exhausted retries — using fallback`);
  return await opts.fallback(lastError);
};
