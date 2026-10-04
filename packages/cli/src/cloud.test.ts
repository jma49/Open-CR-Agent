import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CloudDeps, type Credentials, cloudCommand, cloudSession } from "./cloud.js";

const SERVER = "https://cloud.test";

type Route = (body: Record<string, unknown>, headers: Headers) => { status: number; body: unknown };

/** A fake ocra Cloud: routes by method and path, and a recorded log of calls. */
function fakeCloud(routes: Record<string, Route | Route[]>) {
  const calls: { path: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const headers = new Headers(init?.headers);
    calls.push({ path: key, body, headers });
    let route = routes[key];
    if (Array.isArray(route)) route = route.length > 1 ? route.shift() : route[0];
    if (!route) return new Response("{}", { status: 404 });
    const answer = route(body, headers);
    return Response.json(answer.body, { status: answer.status });
  }) as typeof globalThis.fetch;
  return { fetch: fakeFetch, calls };
}

function setup(
  routes: Record<string, Route | Route[]>,
  env: Record<string, string> = { OCRA_CLOUD_URL: SERVER },
) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-cloud-"));
  const cloud = fakeCloud(routes);
  let clock = 1_000_000;
  const opened: string[] = [];
  const deps: CloudDeps = {
    env,
    fetch: cloud.fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    openBrowser: (url) => opened.push(url),
    credentialsPath: join(dir, "ocra", "credentials.json"),
    clientName: "test-host (ocra 0.0.0)",
  };
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    out: { write: (s: string) => out.push(s) },
    err: { write: (s: string) => err.push(s) },
  };
  return { deps, cloud, opened, io, out, err, tick: (ms: number) => (clock += ms) };
}

const code = {
  device_code: "ocra_dev_secret",
  user_code: "BCDF-GHJK",
  verification_uri: `${SERVER}/device`,
  verification_uri_complete: `${SERVER}/device?code=BCDF-GHJK`,
  expires_in: 600,
  interval: 5,
};
const tokens = {
  access_token: "ocra_cli_a1",
  refresh_token: "ocra_ref_r1",
  expires_in: 3600,
  token_type: "Bearer",
};
const ok = (body: unknown) => () => ({ status: 200, body });
const err =
  (error: string, extra = {}) =>
  () => ({ status: 400, body: { error, ...extra } });

describe("ocra login", () => {
  it("shows the code, opens the browser, polls, and saves the session only for its owner", async () => {
    const t = setup({
      "POST /api/device/code": ok(code),
      "POST /api/device/token": [
        err("authorization_pending"),
        err("slow_down", { interval: 10 }),
        ok(tokens),
      ],
      "GET /api/me": ok({ login: "octo" }),
    });
    const exit = await cloudCommand("login", [], t.io.out, t.io.err, t.deps);
    expect(exit).toBe(0);
    expect(t.out.join("")).toContain("BCDF-GHJK");
    expect(t.out.join("")).toContain("Signed in as octo.");
    expect(t.opened).toEqual([code.verification_uri_complete]);
    expect(t.cloud.calls[0]?.body).toEqual({ client_name: "test-host (ocra 0.0.0)" });
    expect(t.cloud.calls.filter((c) => c.path === "POST /api/device/token")).toHaveLength(3);

    const saved = JSON.parse(readFileSync(t.deps.credentialsPath, "utf8")) as Credentials;
    expect(saved).toMatchObject({ server: SERVER, login: "octo", access_token: "ocra_cli_a1" });
    if (process.platform !== "win32")
      expect(statSync(t.deps.credentialsPath).mode & 0o777).toBe(0o600);
    // The device code and tokens never reach the terminal.
    for (const secret of ["ocra_dev_secret", "ocra_cli_a1", "ocra_ref_r1"]) {
      expect([...t.out, ...t.err].join("")).not.toContain(secret);
    }
  });

  it("does not open a browser with --no-browser", async () => {
    const t = setup({
      "POST /api/device/code": ok(code),
      "POST /api/device/token": ok(tokens),
      "GET /api/me": ok({ login: "octo" }),
    });
    expect(await cloudCommand("login", ["--no-browser"], t.io.out, t.io.err, t.deps)).toBe(0);
    expect(t.opened).toEqual([]);
  });

  it("stops when the browser denies or the code expires", async () => {
    const denied = setup({
      "POST /api/device/code": ok(code),
      "POST /api/device/token": err("access_denied"),
    });
    expect(await cloudCommand("login", [], denied.io.out, denied.io.err, denied.deps)).toBe(1);
    expect(denied.err.join("")).toContain("denied");

    const slow = setup({
      "POST /api/device/code": ok(code),
      "POST /api/device/token": err("authorization_pending"),
    });
    expect(await cloudCommand("login", [], slow.io.out, slow.io.err, slow.deps)).toBe(1);
    expect(slow.err.join("")).toContain("expired");
    // Polls about every interval until the code's lifetime is over, no faster.
    const polls = slow.cloud.calls.filter((c) => c.path === "POST /api/device/token").length;
    expect(polls).toBeLessThanOrEqual(600 / 5);
  });

  it("refuses to run without a server, or with ocra Cloud off", async () => {
    const none = setup({}, {});
    await expect(cloudCommand("login", [], none.io.out, none.io.err, none.deps)).rejects.toThrow(
      /OCRA_CLOUD_URL/,
    );
    const http = setup({}, { OCRA_CLOUD_URL: "http://cloud.example" });
    await expect(cloudCommand("login", [], http.io.out, http.io.err, http.deps)).rejects.toThrow(
      /https/,
    );
    const off = setup({}, { OCRA_CLOUD: "off", OCRA_CLOUD_URL: SERVER });
    expect(await cloudCommand("login", [], off.io.out, off.io.err, off.deps)).toBe(2);
    expect(off.cloud.calls).toEqual([]);
  });
});

async function signedIn(t: ReturnType<typeof setup>) {
  t.deps.fetch = fakeCloud({
    "POST /api/device/code": ok(code),
    "POST /api/device/token": ok(tokens),
    "GET /api/me": ok({ login: "octo" }),
  }).fetch;
  await cloudCommand("login", [], t.io.out, t.io.err, t.deps);
}

describe("sessions", () => {
  it("whoami answers from a live token without refreshing", async () => {
    const t = setup({});
    await signedIn(t);
    const cloud = fakeCloud({ "GET /api/me": ok({ login: "octo" }) });
    t.deps.fetch = cloud.fetch;
    expect(await cloudCommand("whoami", [], t.io.out, t.io.err, t.deps)).toBe(0);
    expect(t.out.at(-1)).toBe(`octo on ${SERVER}\n`);
    expect(cloud.calls.map((c) => c.path)).toEqual(["GET /api/me"]);
    expect(cloud.calls[0]?.headers.get("authorization")).toBe("Bearer ocra_cli_a1");
  });

  it("refreshes an expired token and saves the new pair", async () => {
    const t = setup({});
    await signedIn(t);
    t.tick(3_600_000);
    const fresh = { access_token: "ocra_cli_a2", refresh_token: "ocra_ref_r2", expires_in: 3600 };
    const cloud = fakeCloud({ "POST /api/device/refresh": ok(fresh) });
    t.deps.fetch = cloud.fetch;
    const session = await cloudSession(t.deps);
    expect(session?.access_token).toBe("ocra_cli_a2");
    expect(cloud.calls[0]?.body).toEqual({ refresh_token: "ocra_ref_r1" });
    const saved = JSON.parse(readFileSync(t.deps.credentialsPath, "utf8")) as Credentials;
    expect(saved.refresh_token).toBe("ocra_ref_r2");
  });

  it("treats a revoked session as signed out", async () => {
    const t = setup({});
    await signedIn(t);
    t.tick(3_600_000);
    t.deps.fetch = fakeCloud({ "POST /api/device/refresh": err("invalid_grant") }).fetch;
    expect(await cloudCommand("whoami", [], t.io.out, t.io.err, t.deps)).toBe(1);
    expect(t.err.at(-1)).toContain("Not signed in");
  });

  it("logout ends the session on the server and removes the file", async () => {
    const t = setup({});
    await signedIn(t);
    const cloud = fakeCloud({ "POST /api/auth/logout": ok({ ok: true }) });
    t.deps.fetch = cloud.fetch;
    expect(await cloudCommand("logout", [], t.io.out, t.io.err, t.deps)).toBe(0);
    expect(cloud.calls[0]?.headers.get("authorization")).toBe("Bearer ocra_cli_a1");
    expect(() => statSync(t.deps.credentialsPath)).toThrow();
    expect(await cloudCommand("logout", [], t.io.out, t.io.err, t.deps)).toBe(0);
    expect(t.out.at(-1)).toBe("Not signed in.\n");
  });
});
