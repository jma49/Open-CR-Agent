// Platforms answer bursts with a rate limit (429 on both; GitHub also a 403
// "secondary rate limit") and have short 5xx outages. One such answer during
// publish used to throw away a paid review, so requests are retried a
// bounded number of times.
export const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 60_000;

export interface RetryDecision {
  retry: boolean;
  waitMs: number;
}

// A request the platform refused without acting on it (rate limits) can
// always be repeated. A 5xx or a lost connection may have happened after the
// platform acted, so only requests that are safe to repeat retry then: POST
// would post the same comment or review twice.
export function retryDecision(
  method: string,
  idempotent: boolean,
  outcome: { status: number; headers: Headers; body: string } | "network_error",
  attempt: number,
  now = Date.now(),
): RetryDecision {
  const stop = { retry: false, waitMs: 0 };
  if (attempt >= MAX_ATTEMPTS) return stop;
  const backoff = 1_000 * 2 ** (attempt - 1);
  const safe = idempotent || method === "GET";
  if (outcome === "network_error") return safe ? { retry: true, waitMs: backoff } : stop;

  const { status, headers, body } = outcome;
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (headers.get("x-ratelimit-remaining") === "0" || /secondary rate limit/i.test(body)));
  if (rateLimited) return { retry: true, waitMs: rateLimitWait(headers, now) ?? backoff };
  if (safe && status >= 500) return { retry: true, waitMs: backoff };
  return stop;
}

function rateLimitWait(headers: Headers, now: number): number | undefined {
  const after = Number(headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1_000, MAX_WAIT_MS);
  // GitHub's header, then GitLab's; both carry epoch seconds.
  const reset = Number(headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(reset * 1_000 - now, 0), MAX_WAIT_MS);
  }
  return undefined;
}
