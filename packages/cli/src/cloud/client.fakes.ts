import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credentials } from "./credentials.js";
import type { CloudDeps } from "./deps.js";

export const SERVER = "https://cloud.test";
export const NOW = 1_000_000;

export type Answer = Response | (() => Response);

/** A fake ocra Cloud answering by path, in order when given a list; calls recorded. */
export function machine(routes: Record<string, Answer | Answer[]>, saved?: Partial<Credentials>) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-session-"));
  const credentialsPath = join(dir, "ocra", "credentials.json");
  if (saved) {
    mkdirSync(join(dir, "ocra"));
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        server: SERVER,
        login: "octo",
        access_token: "ocra_cli_a1",
        refresh_token: "ocra_ref_r1",
        expires_at: NOW + 3_600_000,
        ...saved,
      }),
    );
  }
  const calls: { path: string; auth: string | null }[] = [];
  const deps: CloudDeps = {
    env: { OCRA_CLOUD_URL: SERVER },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, auth: new Headers(init?.headers).get("authorization") });
      let answer = routes[path];
      if (Array.isArray(answer)) answer = answer.length > 1 ? answer.shift() : answer[0];
      if (!answer) return new Response("{}", { status: 404 });
      return typeof answer === "function" ? answer() : answer.clone();
    }) as typeof fetch,
    now: () => NOW,
    sleep: async () => {},
    openBrowser: () => {},
    credentialsPath,
    clientName: "t",
  };
  const saved_ = () => JSON.parse(readFileSync(credentialsPath, "utf8")) as Credentials;
  return { deps, calls, saved: saved_, credentialsPath };
}

// An ocra Cloud answer far longer than any it gives, for the read limits.

/** A JSON answer of `entries` that go on for `mb` megabytes; `read` counts the bytes pulled. */
export function endlessMemory(mb: number) {
  const chunk = new TextEncoder().encode(`${JSON.stringify({ fingerprint: "f".repeat(1000) })},`);
  const total = (mb * 1024 * 1024) / chunk.byteLength;
  const counter = { read: 0 };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"entries":['));
    },
    pull(controller) {
      if (sent >= total) {
        controller.enqueue(new TextEncoder().encode("{}]}"));
        controller.close();
        return;
      }
      sent += 1;
      counter.read += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { answer: () => new Response(body), counter };
}
