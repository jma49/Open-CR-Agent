export interface QuotaError {
  // How long the provider asks to wait, when it says. Gemini states a short
  // wait even when a daily limit is spent, which is why waits are capped at
  // QUOTA_RETRIES per model and run.
  retryAfterMs?: number;
  // A per-day limit: waiting inside one run cannot help.
  daily: boolean;
}

// Longest wait for a rate limit inside a run; per-minute limits ask for less.
export const MAX_QUOTA_WAIT_MS = 90_000;
// Waits per model before it counts as out of quota for the rest of the run.
export const QUOTA_RETRIES = 3;

const QUOTA_MESSAGE =
  /exceeded your current quota|quota exceeded|resource[_ ]exhausted|rate limit/i;
const RETRY_IN = /retry in ([\d.]+)\s*(ms|s)\b/i;
const RETRY_DELAY = /"retryDelay"\s*:\s*"([\d.]+)s"/i;
const DAILY = /per ?day|daily/i;

export function parseQuotaError(message: string, statusCode?: number): QuotaError | undefined {
  if (statusCode !== 429 && !QUOTA_MESSAGE.test(message)) return undefined;
  const quota: QuotaError = { daily: DAILY.test(message) };
  const retryIn = RETRY_IN.exec(message);
  const delay = RETRY_DELAY.exec(message);
  if (retryIn) {
    const value = Number(retryIn[1]);
    quota.retryAfterMs = Math.ceil(retryIn[2]?.toLowerCase() === "ms" ? value : value * 1000);
  } else if (delay) {
    quota.retryAfterMs = Math.ceil(Number(delay[1]) * 1000);
  }
  return quota;
}

// Resolves after `ms`, or at once when the signal aborts.
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
