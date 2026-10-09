import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import { retryDecision } from "./retry.js";

const USER_AGENT = "open-cr-agent";
// How much of a refused request's answer an error quotes, and how much of
// it is read: enough for the rate-limit message retryDecision looks for.
const MAX_DETAIL_CHARS = 500;
const MAX_REFUSAL_BYTES = 64 * 1024;

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
  // Stops a request and the wait before its retry; the abort's reason is thrown.
  signal?: AbortSignal | undefined;
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
  const { signal } = api;
  const idempotent = call.idempotent ?? method !== "POST";
  const sleep = async (ms: number) => {
    try {
      await (api.sleep ? api.sleep(ms) : wait(ms, undefined, signal ? { signal } : {}));
    } finally {
      signal?.throwIfAborted();
    }
  };
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(api.timeoutMs(method, path));
    const init: RequestInit = {
      method,
      headers: {
        ...api.headers,
        "User-Agent": USER_AGENT,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let response: Response;
    try {
      response = await api.fetch(url, init);
    } catch (error) {
      signal?.throwIfAborted();
      const next = retryDecision(method, idempotent, "network_error", attempt);
      if (!next.retry) throw error;
      await sleep(next.waitMs);
      continue;
    }
    if (response.ok) return response.status === 204 ? undefined : response.json();
    const answer = await readCapped(response, MAX_REFUSAL_BYTES).catch(() => "");
    const detail = answer.slice(0, MAX_DETAIL_CHARS);
    const next = retryDecision(
      method,
      idempotent,
      { status: response.status, headers: response.headers, body: answer },
      attempt,
    );
    if (!next.retry) {
      const where = `${api.platform} ${method} ${path.split("?")[0]}`;
      throw api.toError(response.status, `${where} failed with ${response.status}: ${detail}`);
    }
    await sleep(next.waitMs);
  }
}

// The answer's first `maxBytes` bytes as text; the rest is never downloaded.
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let left = maxBytes;
  try {
    while (left > 0) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      const chunk = value.subarray(0, left);
      left -= chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Both platforms' GraphQL APIs page connections the same way.
export const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
