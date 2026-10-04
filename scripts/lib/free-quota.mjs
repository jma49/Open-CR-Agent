// What one probe request says of OpenRouter's free requests left today
// (scripts/free-quota.mjs).

/**
 * The count the answer gives: its X-RateLimit-Remaining header, or, when a
 * 429 refuses the request for the day, the header copied into its error.
 * Undefined when OpenRouter does not say.
 * @param {Headers} headers
 * @param {string} body
 * @returns {string | undefined}
 */
export function freeRequestsLeft(headers, body) {
  const header = headers.get("x-ratelimit-remaining");
  if (header) return lastValue(header);
  /** @type {unknown} */
  let answer;
  try {
    answer = JSON.parse(body);
  } catch {
    return undefined;
  }
  const error =
    /** @type {{ error?: { message?: unknown, metadata?: { headers?: Record<string, unknown> } } }} */ (
      answer
    )?.error;
  if (typeof error?.message !== "string" || !error.message.includes("per-day")) return undefined;
  const left = error.metadata?.headers?.["X-RateLimit-Remaining"];
  return left === undefined || left === null ? undefined : String(left);
}

// A header sent twice reads as "a, b"; the last one counts.
/** @param {string} value */
function lastValue(value) {
  return value.split(",").at(-1)?.trim() || undefined;
}

/**
 * The line the probe logs: the status and every rate-limit header.
 * @param {{ status: number, statusText: string } | undefined} response
 * @param {Headers} headers
 * @param {string | undefined} left
 */
export function probeLine(response, headers, left) {
  const status = response ? `HTTP ${response.status} ${response.statusText}`.trim() : "no answer";
  const limits = [...headers]
    .filter(([name]) => name.startsWith("x-ratelimit"))
    .map(([name, value]) => `${name}: ${value} `)
    .join("");
  return `Free model probe: ${status}; ${limits}left: ${left ?? "not reported"}`;
}

/** @param {string} model */
export function probeRequest(model) {
  return { model, max_tokens: 1, messages: [{ role: "user", content: "ok" }] };
}
