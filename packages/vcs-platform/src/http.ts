import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import { retryDecision } from "./retry.js";

const USER_AGENT = "open-cr-agent";
// How much of a refused request's answer an error quotes.
const MAX_DETAIL_CHARS = 500;

// One platform's API, as a client sets it up once.
export interface PlatformApi {
  // The platform's name, as errors give it.
  platform: string;
  // Authentication, accepted media type, API version.
  headers: Record<string, string>;
  fetch: typeof fetch;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  timeoutMs: (method: string, path: string) => number;
  toError: (status: number, message: string) => Error;
}

export interface PlatformCall {
  method: string;
  url: string;
  // The path as errors give it; a query string is left out.
  path: string;
  body?: unknown;
  // Whether repeating the request after the platform may have acted on it is
  // safe (retryDecision); by default everything but a POST.
  idempotent?: boolean;
}

// Sends a JSON request to a platform's API, retrying rate limits, outages
// and lost connections a bounded number of times; resolves to the parsed
// answer, or undefined for a 204.
export async function sendWithRetry(api: PlatformApi, call: PlatformCall): Promise<unknown> {
  const { method, url, path, body } = call;
  const idempotent = call.idempotent ?? method !== "POST";
  const sleep = api.sleep ?? ((ms: number) => wait(ms));
  for (let attempt = 1; ; attempt += 1) {
    const init: RequestInit = {
      method,
      headers: {
        ...api.headers,
        "User-Agent": USER_AGENT,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: AbortSignal.timeout(api.timeoutMs(method, path)),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let response: Response;
    try {
      response = await api.fetch(url, init);
    } catch (error) {
      const next = retryDecision(method, idempotent, "network_error", attempt);
      if (!next.retry) throw error;
      await sleep(next.waitMs);
      continue;
    }
    if (response.ok) return response.status === 204 ? undefined : response.json();
    const detail = (await response.text().catch(() => "")).slice(0, MAX_DETAIL_CHARS);
    const next = retryDecision(
      method,
      idempotent,
      { status: response.status, headers: response.headers, body: detail },
      attempt,
    );
    if (!next.retry) {
      const where = `${api.platform} ${method} ${path.split("?")[0]}`;
      throw api.toError(response.status, `${where} failed with ${response.status}: ${detail}`);
    }
    await sleep(next.waitMs);
  }
}

// Both platforms' GraphQL APIs page connections the same way.
export const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
