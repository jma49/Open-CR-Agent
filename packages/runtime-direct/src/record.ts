import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, OcraError, withoutSecrets } from "@open-cr-agent/core";

// Where the direct runtime writes every model exchange, for replaying a run
// without a model (tests) or reading what a model was sent and answered.
export const RECORD_DIR_ENV = "OCRA_RECORD_DIR";

// One file per distinct request, named by exchangeKey(): the request as sent
// and each answer it got, in order (a request sent again after a transient
// failure gets a second answer). Headers and the endpoint's address are not
// kept, and every key is replaced by "<key>".
export interface Recording {
  version: 1;
  request: Record<string, unknown>;
  answers: { status: number; body: string }[];
}

// What makes two requests the same exchange: the conversation and the tools
// offered. The model and sampling settings are recorded but do not count, so
// a replay of a run does not depend on which model of the chain served it.
export function exchangeKey(request: { messages?: unknown; tools?: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify([request.messages ?? [], request.tools ?? []]))
    .digest("hex")
    .slice(0, 32);
}

// Wraps fetch so every chat completion it sends is recorded in `dir`. The
// directory is created, private to its owner, before any request, so a path
// that cannot be one fails the run at once rather than every request.
export function recordingFetch(
  base: typeof fetch,
  dir: string,
  secrets: readonly string[],
): typeof fetch {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new OcraError(
      "CONFIG_INVALID",
      `${RECORD_DIR_ENV} names a directory ocra cannot create: ${errorMessage(error)}`,
    );
  }
  return async (input, init) => {
    const response = await base(input, init);
    if (typeof init?.body !== "string") return response;
    const body = await response.text();
    // Synchronous, so two answers to the same request cannot interleave.
    append(dir, JSON.parse(init.body) as Record<string, unknown>, response.status, body, secrets);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function append(
  dir: string,
  request: Record<string, unknown>,
  status: number,
  body: string,
  secrets: readonly string[],
): void {
  const path = join(dir, `${exchangeKey(request)}.json`);
  const { stream: _, ...sent } = request;
  const recording: Recording = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Recording)
    : { version: 1, request: sent, answers: [] };
  recording.answers.push({ status, body });
  const text = withoutSecrets(`${JSON.stringify(recording, null, 2)}\n`, secrets);
  writeFileSync(path, text, { mode: 0o600 });
}
