import { isUnsafeCodePoint } from "@open-cr-agent/core/internal";
import type { InstanceResult } from "./results.js";

// Why the provider refused a review's tasks: its rate limit or capacity
// (rate_limit), which a later attempt can get past, or credit, a spend limit
// or a daily quota (quota), which refuses every later PR too. Read from the
// text of ocra's report: eval sees the report, not the runtime's types.
export type ProviderLimit = "rate_limit" | "quota";

// A provider refusing for money: Anthropic's credit balance (HTTP 400
// invalid_request_error, or 402 billing_error) and its organization or
// workspace spend limit, OpenAI's insufficient_quota, OpenRouter's credits.
const BILLING =
  /credit balance is too low|billing_error|specified (?:workspace )?API usage limits?|insufficient[_ ](?:quota|credits)|requires more credits/i;
// A rate limit, a quota or a provider out of capacity (HTTP 429, 529), in
// the provider's words or the runtime's. The runtime has already waited out
// per-minute limits (#500) when a task fails on one; "out of quota for this
// run" only says it stopped waiting, not that the quota is spent.
const LIMIT = /quota|rate[ _-]?limit|resource[_ ]exhausted|too many requests|HTTP 429|overloaded/i;
const DAILY = /per[ _-]?day|daily/i;
// OpenAI's spent credit, and Gemini's words for any of its limits; Gemini
// names a per-minute one in its quota id.
const CURRENT_QUOTA = /exceeded your current quota/i;
const PER_MINUTE = /per[ _-]?minute/i;

export function providerLimit(message: string): ProviderLimit | undefined {
  if (BILLING.test(message)) return "quota";
  if (!LIMIT.test(message)) return undefined;
  if (DAILY.test(message)) return "quota";
  return CURRENT_QUOTA.test(message) && !PER_MINUTE.test(message) ? "quota" : "rate_limit";
}

export interface LostTasks {
  limit: ProviderLimit;
  error: string;
}

// What a review lost tasks to at the provider, a spent quota before a rate
// limit, and the error saying so. A review that ran no task is read from
// ocra's error output instead.
export function lostTo(result: Pick<InstanceResult, "tasks" | "error">): LostTasks | undefined {
  const errors =
    result.tasks.length > 0
      ? result.tasks.flatMap((t) => (t.status === "failed" && t.error ? [t.error] : []))
      : result.error
        ? [result.error]
        : [];
  let lost: LostTasks | undefined;
  for (const error of errors) {
    const limit = providerLimit(error);
    if (limit === "quota") return { limit, error };
    if (limit && !lost) lost = { limit, error };
  }
  return lost;
}

// A provider's error on one line for the log, without what a terminal acts on.
export function logLine(text: string, max = 300): string {
  const line = [...text.replace(/\s+/g, " ").trim()]
    .filter((char) => !isUnsafeCodePoint(char.codePointAt(0) ?? 0))
    .join("");
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
