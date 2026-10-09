import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, OcraError, withoutSecrets } from "@open-cr-agent/core";
import { z } from "zod";

// Where the direct runtime writes every model exchange, for replaying a run
// without a model (tests) or reading what a model was sent and answered.
export const RECORD_DIR_ENV = "OCRA_RECORD_DIR";

// One file per distinct request, named by exchangeKey(): the request as sent
// and each answer it got, in order (a request sent again after a transient
// failure gets a second answer). Headers and the endpoint's address are not
// kept, and every key is replaced by "<key>".
export const recordingSchema = z.object({
  version: z.literal(1),
  request: z.record(z.string(), z.unknown()),
  answers: z.array(z.object({ status: z.number().int(), body: z.string() })),
});
export type Recording = z.infer<typeof recordingSchema>;

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
// `secrets` is asked at each write: a key renewed during the run (the ocra
// Cloud token) is taken out as well. A recording that cannot be written is
// a warning, never a failed request: the answer was paid for, and a thrown
// error here would read as a network failure and send the request again.
export function recordingFetch(
  base: typeof fetch,
  dir: string,
  secrets: () => readonly string[],
  warn: (message: string) => void,
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
    try {
      // Synchronous, so two answers to the same request cannot interleave.
      append(
        dir,
        JSON.parse(init.body) as Record<string, unknown>,
        response.status,
        body,
        secrets(),
      );
    } catch (error) {
      warn(`could not record a model exchange in ${RECORD_DIR_ENV}: ${errorMessage(error)}`);
    }
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
    ? recordingSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    : { version: 1, request: sent, answers: [] };
  recording.answers.push({ status, body });
  const text = `${JSON.stringify(redacted(recording, withEscaped(secrets)), null, 2)}\n`;
  writeFileSync(path, text, { mode: 0o600 });
}

// Each secret as it is and as it reads inside a JSON string: an answer's body
// is the endpoint's JSON text, where a key with a quote or backslash is
// escaped.
function withEscaped(secrets: readonly string[]): string[] {
  const forms = secrets.flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]);
  return [...new Set(forms.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
}

// Redacted string by string before serializing, since JSON.stringify escapes
// a secret with a quote or backslash out of its plain form.
function redacted<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") return withoutSecrets(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redacted(v, secrets)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [withoutSecrets(k, secrets), redacted(v, secrets)]),
    ) as T;
  }
  return value;
}
