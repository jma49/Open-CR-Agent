import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loginCommand } from "../commands/login.js";
import type { Credentials } from "./credentials.js";
import type { CloudDeps } from "./deps.js";
import { cloudFetch, cloudSession } from "./session.js";

const SERVER = "https://cloud.test";
const NOW = 1_000_000;

type Answer = Response | (() => Response);

/** A fake ocra Cloud answering by path, in order when given a list; calls recorded. */
function machine(routes: Record<string, Answer | Answer[]>, saved?: Partial<Credentials>) {
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
  return { deps, calls, saved: saved_ };
}

const pair = () =>
  Response.json({ access_token: "ocra_cli_a2", refresh_token: "ocra_ref_r2", expires_in: 3600 });
const status =
  (n: number, body: unknown = {}) =>
  () =>
    Response.json(body, { status: n });
const offline = () => {
  throw new TypeError("fetch failed");
};
const EXPIRED = { expires_at: NOW - 1 };

describe("cloudSession", () => {
  it("is signed-out without a saved session, and ok with a live one, without a call", async () => {
    const none = machine({});
    expect(await cloudSession(none.deps)).toEqual({ kind: "signed-out" });
    const live = machine({}, {});
    const session = await cloudSession(live.deps);
    expect(session.kind === "ok" && session.credentials.access_token).toBe("ocra_cli_a1");
    expect([...none.calls, ...live.calls]).toEqual([]);
  });

  it("is revoked when the refresh is refused", async () => {
    for (const refused of [status(400, { error: "invalid_grant" }), status(401)]) {
      const m = machine({ "/api/device/refresh": refused }, EXPIRED);
      expect(await cloudSession(m.deps)).toEqual({ kind: "revoked" });
    }
  });

  it("is unreachable, not signed out, on a network error, 5xx or 429", async () => {
    for (const [failing, reason] of [
      [offline, "fetch failed"],
      [status(503), "HTTP 503"],
      [status(429), "HTTP 429"],
    ] as const) {
      const m = machine({ "/api/device/refresh": failing }, EXPIRED);
      expect(await cloudSession(m.deps)).toEqual({ kind: "unreachable", reason });
      // The session stays for the next run.
      expect(m.saved().refresh_token).toBe("ocra_ref_r1");
    }
  });
});

describe("cloudFetch", () => {
  it("on a 401 for a live token, refreshes once and retries once with the new token", async () => {
    const m = machine(
      {
        "/api/preferences": [status(401), () => Response.json({ ok: true })],
        "/api/device/refresh": pair,
      },
      {},
    );
    const answer = await cloudFetch(m.deps, "/api/preferences");
    expect(answer.kind === "answered" && answer.res.status).toBe(200);
    expect(m.calls).toEqual([
      { path: "/api/preferences", auth: "Bearer ocra_cli_a1" },
      { path: "/api/device/refresh", auth: null },
      { path: "/api/preferences", auth: "Bearer ocra_cli_a2" },
    ]);
    expect(m.saved().access_token).toBe("ocra_cli_a2");
  });

  it("retries no more than once, and answers revoked when the refresh is refused", async () => {
    const twice = machine({ "/api/preferences": status(401), "/api/device/refresh": pair }, {});
    const answer = await cloudFetch(twice.deps, "/api/preferences");
    expect(answer.kind === "answered" && answer.res.status).toBe(401);
    expect(twice.calls.map((c) => c.path)).toEqual([
      "/api/preferences",
      "/api/device/refresh",
      "/api/preferences",
    ]);
    const revoked = machine(
      {
        "/api/preferences": status(401),
        "/api/device/refresh": status(400, { error: "invalid_grant" }),
      },
      {},
    );
    expect(await cloudFetch(revoked.deps, "/api/preferences")).toEqual({ kind: "revoked" });
  });
});

describe("ocra login", () => {
  const login = {
    "/api/device/code": () =>
      Response.json({
        device_code: "d",
        user_code: "BCDF-GHJK",
        verification_uri: `${SERVER}/device`,
        verification_uri_complete: `${SERVER}/device?code=BCDF-GHJK`,
      }),
    "/api/device/token": pair,
  };

  it("saves the session when the login cannot be read, and says it is unknown", async () => {
    for (const me of [status(500), offline]) {
      const m = machine({ ...login, "/api/me": me });
      const out: string[] = [];
      const io = { write: (s: string) => out.push(s) };
      expect(await loginCommand("login", ["--no-browser"], io, io, m.deps)).toBe(0);
      expect(m.saved()).toMatchObject({
        access_token: "ocra_cli_a2",
        refresh_token: "ocra_ref_r2",
      });
      expect(out.at(-1)).toMatch(
        /^Signed in; the login is unknown \(.+\): ocra whoami asks again\.\n$/,
      );
    }
  });
});
