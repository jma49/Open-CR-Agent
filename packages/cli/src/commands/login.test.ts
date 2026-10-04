import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accountSaltPath, saveAccountSalt } from "../cloud/account-salt.js";
import { type Credentials, readCredentials } from "../cloud/credentials.js";
import type { CloudDeps } from "../cloud/deps.js";
import { cloudSession } from "../cloud/session.js";
import { loginCommand } from "./login.js";

const SERVER = "https://cloud.test";

type Route = (body: Record<string, unknown>, headers: Headers) => { status: number; body: unknown };

/** A fake ocra Cloud: routes by method and path, and a recorded log of calls. */
function fakeCloud(routes: Record<string, Route | Route[]>) {
  const calls: { path: string; body: Record<string, unknown>; headers: Headers; url: string }[] =
    [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const headers = new Headers(init?.headers);
    calls.push({ path: key, body, headers, url: `${url.origin}${url.pathname}` });
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
    const exit = await loginCommand("login", [], t.io.out, t.io.err, t.deps);
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

  it("opens only a sign-in page on the server in use, and asks the user to open any other", async () => {
    for (const page of ["https://elsewhere.test/device", "-https://cloud.test/device"]) {
      const t = setup({
        "POST /api/device/code": ok({ ...code, verification_uri_complete: page }),
        "POST /api/device/token": ok(tokens),
        "GET /api/me": ok({ login: "octo" }),
      });
      expect(await loginCommand("login", [], t.io.out, t.io.err, t.deps)).toBe(0);
      expect(t.opened).toEqual([]);
      expect(t.err.join("")).toContain(`ocra opens only pages on ${SERVER}`);
    }
  });

  it("keeps the account's salt beside the session, and none when the account answers none", async () => {
    const salt = "5".repeat(64);
    const t = setup({
      "POST /api/device/code": ok(code),
      "POST /api/device/token": ok(tokens),
      "GET /api/me": ok({ login: "octo" }),
      "GET /api/account/salt": ok({ salt }),
    });
    expect(await loginCommand("login", [], t.io.out, t.io.err, t.deps)).toBe(0);
    const path = accountSaltPath(t.deps.credentialsPath);
    expect(readFileSync(path, "utf8").trim()).toBe(salt);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(
      t.cloud.calls.find((c) => c.path === "GET /api/account/salt")?.headers.get("authorization"),
    ).toBe("Bearer ocra_cli_a1");

    t.deps.fetch = fakeCloud({
      "POST /api/device/code": ok(code),
      "POST /api/device/token": ok(tokens),
      "GET /api/me": ok({ login: "octo" }),
      "GET /api/account/salt": ok({ salt: null }),
    }).fetch;
    expect(await loginCommand("login", [], t.io.out, t.io.err, t.deps)).toBe(0);
    expect(existsSync(path)).toBe(false);

    writeFileSync(path, `${salt}\n`);
    t.deps.fetch = fakeCloud({}).fetch;
    expect(await loginCommand("logout", [], t.io.out, t.io.err, t.deps)).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("does not open a browser with --no-browser", async () => {
    const t = setup({
      "POST /api/device/code": ok(code),
      "POST /api/device/token": ok(tokens),
      "GET /api/me": ok({ login: "octo" }),
    });
    expect(await loginCommand("login", ["--no-browser"], t.io.out, t.io.err, t.deps)).toBe(0);
    expect(t.opened).toEqual([]);
  });

  it("stops when the browser denies or the code expires", async () => {
    const denied = setup({
      "POST /api/device/code": ok(code),
      "POST /api/device/token": err("access_denied"),
    });
    expect(await loginCommand("login", [], denied.io.out, denied.io.err, denied.deps)).toBe(1);
    expect(denied.err.join("")).toContain("denied");

    const slow = setup({
      "POST /api/device/code": ok(code),
      "POST /api/device/token": err("authorization_pending"),
    });
    expect(await loginCommand("login", [], slow.io.out, slow.io.err, slow.deps)).toBe(1);
    expect(slow.err.join("")).toContain("expired");
    // Polls about every interval until the code's lifetime is over, no faster.
    const polls = slow.cloud.calls.filter((c) => c.path === "POST /api/device/token").length;
    expect(polls).toBeLessThanOrEqual(600 / 5);
  });

  it("uses app.ocracloud.com by default, and refuses http or ocra Cloud off", async () => {
    const none = setup({ "POST /api/device/code": () => ({ status: 503, body: {} }) }, {});
    expect(await loginCommand("login", [], none.io.out, none.io.err, none.deps)).toBe(2);
    expect(none.cloud.calls[0]?.url).toBe("https://app.ocracloud.com/api/device/code");
    const http = setup({}, { OCRA_CLOUD_URL: "http://cloud.example" });
    await expect(loginCommand("login", [], http.io.out, http.io.err, http.deps)).rejects.toThrow(
      /https/,
    );
    const off = setup({}, { OCRA_CLOUD: "off", OCRA_CLOUD_URL: SERVER });
    expect(await loginCommand("login", [], off.io.out, off.io.err, off.deps)).toBe(2);
    expect(off.cloud.calls).toEqual([]);
  });
});

async function signedIn(t: ReturnType<typeof setup>) {
  t.deps.fetch = fakeCloud({
    "POST /api/device/code": ok(code),
    "POST /api/device/token": ok(tokens),
    "GET /api/me": ok({ login: "octo" }),
  }).fetch;
  await loginCommand("login", [], t.io.out, t.io.err, t.deps);
}

describe("sessions", () => {
  it("whoami answers from a live token without refreshing", async () => {
    const t = setup({});
    await signedIn(t);
    const cloud = fakeCloud({ "GET /api/me": ok({ login: "octo" }) });
    t.deps.fetch = cloud.fetch;
    expect(await loginCommand("whoami", [], t.io.out, t.io.err, t.deps)).toBe(0);
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
    expect(session.kind === "ok" && session.credentials.access_token).toBe("ocra_cli_a2");
    expect(cloud.calls[0]?.body).toEqual({ refresh_token: "ocra_ref_r1" });
    const saved = JSON.parse(readFileSync(t.deps.credentialsPath, "utf8")) as Credentials;
    expect(saved.refresh_token).toBe("ocra_ref_r2");
  });

  it("says a revoked session ended", async () => {
    const t = setup({});
    await signedIn(t);
    t.tick(3_600_000);
    t.deps.fetch = fakeCloud({ "POST /api/device/refresh": err("invalid_grant") }).fetch;
    expect(await loginCommand("whoami", [], t.io.out, t.io.err, t.deps)).toBe(1);
    expect(t.err.at(-1)).toBe("Your ocra Cloud session ended. Run ocra login.\n");
  });

  it("logout ends the session on the server and removes the file", async () => {
    const t = setup({});
    await signedIn(t);
    const cloud = fakeCloud({ "POST /api/auth/logout": ok({ ok: true }) });
    t.deps.fetch = cloud.fetch;
    expect(await loginCommand("logout", [], t.io.out, t.io.err, t.deps)).toBe(0);
    expect(cloud.calls[0]?.headers.get("authorization")).toBe("Bearer ocra_cli_a1");
    expect(() => statSync(t.deps.credentialsPath)).toThrow();
    expect(await loginCommand("logout", [], t.io.out, t.io.err, t.deps)).toBe(0);
    expect(t.out.at(-1)).toBe("Not signed in.\n");
  });
});

describe("the credentials file", () => {
  it("is replaced whole, never rewritten in place, and stays readable only by you", async () => {
    const t = setup({});
    await signedIn(t);
    // A hard link keeps the old file: an in-place rewrite would change it too.
    const before = `${t.deps.credentialsPath}.before`;
    linkSync(t.deps.credentialsPath, before);
    if (process.platform !== "win32") chmodSync(t.deps.credentialsPath, 0o644);
    t.tick(3_600_000);
    const fresh = { access_token: "ocra_cli_a2", refresh_token: "ocra_ref_r2", expires_in: 3600 };
    t.deps.fetch = fakeCloud({ "POST /api/device/refresh": ok(fresh) }).fetch;
    const session = await cloudSession(t.deps);
    expect(session.kind === "ok" && session.credentials.access_token).toBe("ocra_cli_a2");
    expect(JSON.parse(readFileSync(before, "utf8")).access_token).toBe("ocra_cli_a1");
    expect(JSON.parse(readFileSync(t.deps.credentialsPath, "utf8")).access_token).toBe(
      "ocra_cli_a2",
    );
    if (process.platform !== "win32")
      expect(statSync(t.deps.credentialsPath).mode & 0o777).toBe(0o600);
    expect(
      readdirSync(join(t.deps.credentialsPath, "..")).filter((f) => f.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("reads as signed out, with a warning naming it, when it holds no session", async () => {
    const t = setup({});
    await signedIn(t);
    for (const text of ["", "{", '{"server":"https://cloud.test","acc', "null", "[]", "{}"]) {
      writeFileSync(t.deps.credentialsPath, text);
      const warnings: string[] = [];
      expect(
        await readCredentials(t.deps.credentialsPath, (m) => warnings.push(m)),
      ).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(t.deps.credentialsPath);
      expect(await cloudSession(t.deps)).toEqual({ kind: "signed-out" });
    }
  });

  it("ocra logout removes a file it cannot read", async () => {
    const t = setup({});
    await signedIn(t);
    writeFileSync(t.deps.credentialsPath, '{"server":');
    const cloud = fakeCloud({});
    t.deps.fetch = cloud.fetch;
    expect(await loginCommand("logout", [], t.io.out, t.io.err, t.deps)).toBe(0);
    expect(existsSync(t.deps.credentialsPath)).toBe(false);
    expect(t.out.at(-1)).toContain("could not be read");
    expect(cloud.calls).toEqual([]);
  });

  it("keeps the account's salt by replacing the file whole", async () => {
    const t = setup({});
    const path = accountSaltPath(t.deps.credentialsPath);
    await saveAccountSalt(t.deps.credentialsPath, "1".repeat(64));
    linkSync(path, `${path}.before`);
    await saveAccountSalt(t.deps.credentialsPath, "2".repeat(64));
    expect(readFileSync(`${path}.before`, "utf8").trim()).toBe("1".repeat(64));
    expect(readFileSync(path, "utf8").trim()).toBe("2".repeat(64));
  });
});
