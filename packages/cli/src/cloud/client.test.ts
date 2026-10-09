import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage, isOcraError } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { loginCommand } from "../commands/login.js";
import { CloudClient } from "./client.js";
import type { Credentials } from "./credentials.js";
import type { CloudDeps } from "./deps.js";

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
  return { deps, calls, saved: saved_, credentialsPath };
}

/**
 * Another process in the middle of refreshing the saved session: it holds
 * the lock, then saves its new pair and lets go.
 */
function refreshingElsewhere(credentialsPath: string): Promise<void> {
  writeFileSync(`${credentialsPath}.lock`, JSON.stringify({ token: "x", at: Date.now() }));
  return new Promise<void>((resolve) => setTimeout(resolve, 100)).then(() => {
    const saved = JSON.parse(readFileSync(credentialsPath, "utf8")) as Credentials;
    writeFileSync(
      credentialsPath,
      JSON.stringify({ ...saved, access_token: "ocra_cli_old2", refresh_token: "ocra_ref_old2" }),
    );
    rmSync(`${credentialsPath}.lock`);
  });
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

describe("the session", () => {
  it("is signed-out without a saved session, and ok with a live one, without a call", async () => {
    const none = machine({});
    expect(await new CloudClient(none.deps).session()).toEqual({ kind: "signed-out" });
    const live = machine({}, {});
    const session = await new CloudClient(live.deps).session();
    expect(session.kind === "ok" && session.credentials.access_token).toBe("ocra_cli_a1");
    expect([...none.calls, ...live.calls]).toEqual([]);
  });

  it("is revoked when the refresh is refused", async () => {
    for (const refused of [status(400, { error: "invalid_grant" }), status(401)]) {
      const m = machine({ "/api/device/refresh": refused }, EXPIRED);
      expect(await new CloudClient(m.deps).session()).toEqual({ kind: "revoked" });
    }
  });

  it("is unreachable, not signed out, on a network error, 5xx or 429", async () => {
    for (const [failing, reason] of [
      [offline, "fetch failed"],
      [status(503), "HTTP 503"],
      [status(429), "HTTP 429"],
    ] as const) {
      const m = machine({ "/api/device/refresh": failing }, EXPIRED);
      expect(await new CloudClient(m.deps).session()).toEqual({ kind: "unreachable", reason });
      // The session stays for the next run.
      expect(m.saved().refresh_token).toBe("ocra_ref_r1");
    }
  });
});

describe("a call for the account", () => {
  it("on a 401 for a live token, refreshes once and retries once with the new token", async () => {
    const m = machine(
      {
        "/api/preferences": [status(401), () => Response.json({ ok: true })],
        "/api/device/refresh": pair,
      },
      {},
    );
    const answer = await new CloudClient(m.deps).preferences();
    expect(answer).toEqual({ kind: "ok", value: { ok: true } });
    expect(m.calls).toEqual([
      { path: "/api/preferences", auth: "Bearer ocra_cli_a1" },
      { path: "/api/device/refresh", auth: null },
      { path: "/api/preferences", auth: "Bearer ocra_cli_a2" },
    ]);
    expect(m.saved().access_token).toBe("ocra_cli_a2");
  });

  it("retries no more than once, and answers revoked when the refresh is refused", async () => {
    const twice = machine({ "/api/preferences": status(401), "/api/device/refresh": pair }, {});
    const answer = await new CloudClient(twice.deps).preferences();
    expect(answer).toEqual({ kind: "status", status: 401 });
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
    expect(await new CloudClient(revoked.deps).preferences()).toEqual({ kind: "revoked" });
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

  it("waits for another process's refresh, so the new session is the one saved", async () => {
    const m = machine({ ...login, "/api/me": () => Response.json({ login: "octo" }) }, {});
    const other = refreshingElsewhere(m.credentialsPath);
    const io = { write: () => {} };
    expect(await loginCommand("login", ["--no-browser"], io, io, m.deps)).toBe(0);
    await other;
    expect(m.saved()).toMatchObject({ access_token: "ocra_cli_a2", refresh_token: "ocra_ref_r2" });
  });
});

describe("ocra logout", () => {
  it("waits for another process's refresh, so no session is left saved", async () => {
    const m = machine({}, {});
    const other = refreshingElsewhere(m.credentialsPath);
    const io = { write: () => {} };
    expect(await loginCommand("logout", [], io, io, m.deps)).toBe(0);
    await other;
    expect(existsSync(m.credentialsPath)).toBe(false);
  });
});

describe("an answer that is not one", () => {
  const json = (body: unknown) => () => Response.json(body);
  const text = (body: string) => () => new Response(body);

  it("does not start a login, and polls as an answer without tokens", async () => {
    const m = machine({
      "/api/device/code": json({ device_code: 7, user_code: "A" }),
      "/api/device/token": json({ access_token: 5, refresh_token: "r", expires_in: 60 }),
    });
    const client = new CloudClient(m.deps);
    expect(await client.startLogin(SERVER)).toEqual({ kind: "refused", status: 200 });
    expect(await client.pollLogin(SERVER, "d")).toEqual({ status: 200 });
  });

  it("is a server that could not be used when it answers a refresh", async () => {
    const m = machine({ "/api/device/refresh": text("<html>") }, EXPIRED);
    expect(await new CloudClient(m.deps).session()).toEqual({
      kind: "unreachable",
      reason: "HTTP 200",
    });
  });

  it("names no account, with ocra Cloud's error code", async () => {
    const m = machine({ "/api/me": json({ name: "octo" }) });
    const error = await new CloudClient(m.deps).account(SERVER, "t").catch((e: unknown) => e);
    expect(isOcraError(error, "CLOUD_API_FAILED")).toBe(true);
  });

  it("is malformed for the account's salt, settings and memory", async () => {
    const m = machine(
      {
        "/api/account/salt": json({ salt: "not-hex" }),
        "/api/preferences": json(["models"]),
        "/api/memory": json({ entries: 3 }),
      },
      {},
    );
    const client = new CloudClient(m.deps);
    expect(await client.accountSalt()).toEqual({ kind: "malformed" });
    expect(await client.preferences()).toEqual({ kind: "malformed" });
    expect(await client.memory("f".repeat(64))).toEqual({ kind: "malformed" });
  });

  it("counts no kept finding for an upload answered without a count", async () => {
    for (const answer of [text("ok"), json({ findings: "12" }), json({ findings: -1 })]) {
      const m = machine({ "/api/reviews": answer }, {});
      expect(await new CloudClient(m.deps).uploadReview({})).toEqual({
        kind: "ok",
        value: { findings: 0 },
      });
    }
  });

  it("throws ocra Cloud's error code for a call that could not be sent", async () => {
    const m = machine({ "/api/preferences": offline }, {});
    const error = await new CloudClient(m.deps).preferences().catch((e: unknown) => e);
    expect(isOcraError(error, "CLOUD_API_FAILED")).toBe(true);
    expect(errorMessage(error)).toBe("fetch failed");
  });
});
