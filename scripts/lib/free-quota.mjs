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

/**
 * The error a workflow fails with when the probe's answer means no review on
 * the model can run at all, rather than that today's quota is spent: the
 * model is gone (OpenRouter withdraws free models without notice) or it is
 * zero-priced but served only to accounts with credits. Undefined otherwise.
 * @param {string} model
 * @param {{ status: number } | undefined} response
 */
export function probeFailure(model, response) {
  if (response?.status === 404) {
    return `::error title=Free model gone::OpenRouter no longer serves ${model} (HTTP 404); replace it with a current free model`;
  }
  if (response?.status === 402) {
    return `::error title=Free model needs credits::${model} needs OpenRouter credits on the account (HTTP 402 Payment Required)`;
  }
  return undefined;
}

// The probe needs the error a 429 carries, which is short; the rest of an
// answer is never downloaded. vcs-platform's http.ts reads refusals the same
// way: a script cannot import a workspace package's TypeScript.
const MAX_PROBE_BYTES = 64 * 1024;

/**
 * The answer's first 64 KB as text.
 * @param {Response} response
 * @returns {Promise<string>}
 */
export async function probeBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let left = MAX_PROBE_BYTES;
  try {
    while (left > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, left);
      left -= chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** @param {string} model */
export function probeRequest(model) {
  return { model, max_tokens: 1, messages: [{ role: "user", content: "ok" }] };
}
