import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudClient, type CloudSession } from "./client.js";
import type { Credentials } from "./credentials.js";
import type { CloudDeps } from "./deps.js";

const SERVER = "https://cloud.test";
const NOW = 1_000_000;

/** The session's access token, or the kind of session there is instead. */
const tokenOf = (s: CloudSession) => (s.kind === "ok" ? s.credentials.access_token : s.kind);

/**
 * ocra Cloud's refresh as the server does it: the refresh token rotates by
 * compare-and-set, so a second refresh with the same token is refused. The
 * answers wait for `network` when given.
 */
function rotatingCloud(onRefresh?: (token: string) => void, network?: Promise<unknown>) {
  let current = "ocra_ref_r1";
  let issued = 1;
  const refreshes: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname !== "/api/device/refresh") {
      return new Response("{}", { status: 404 });
    }
    const token = (JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token;
    refreshes.push(token);
    onRefresh?.(token);
    // The network's delay: long enough for a second caller to start.
    await (network ?? new Promise((resolve) => setTimeout(resolve, 30)));
    if (token !== current) return Response.json({ error: "invalid_grant" }, { status: 400 });
    issued += 1;
    current = `ocra_ref_r${issued}`;
    return Response.json({
      access_token: `ocra_cli_a${issued}`,
      refresh_token: current,
      expires_in: 3600,
    });
  }) as typeof globalThis.fetch;
  return { fetch, refreshes, rotate: (to: string) => (current = to) };
}

function signedIn(fetch: typeof globalThis.fetch, expiresAt = NOW - 1) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-refresh-"));
  const credentialsPath = join(dir, "ocra", "credentials.json");
  mkdirSync(join(dir, "ocra"));
  const write = (c: Partial<Credentials>) =>
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        server: SERVER,
        login: "octo",
        access_token: "ocra_cli_a1",
        refresh_token: "ocra_ref_r1",
        expires_at: expiresAt,
        ...c,
      }),
    );
  write({});
  const notices: string[] = [];
  const deps: CloudDeps = {
    env: {},
    fetch,
    now: () => NOW,
    sleep: async () => {},
    openBrowser: () => {},
    credentialsPath,
    clientName: "t",
    notice: (message) => notices.push(message),
  };
  const saved = () => JSON.parse(readFileSync(credentialsPath, "utf8")) as Credentials;
  return { deps, write, saved, credentialsPath, notices };
}

const realTime = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Another process holding the lock, which saves `pair` and lets go after a moment. */
function heldElsewhere(t: ReturnType<typeof signedIn>, pair: Partial<Credentials>): Promise<void> {
  writeFileSync(`${t.credentialsPath}.lock`, JSON.stringify({ token: "x", at: Date.now() }));
  return realTime(100).then(() => {
    t.write(pair);
    rmSync(`${t.credentialsPath}.lock`);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("refreshing the ocra Cloud session", () => {
  it("refreshes once for two callers at once, and both get the new token", async () => {
    const cloud = rotatingCloud();
    const t = signedIn(cloud.fetch);
    const [a, b] = await Promise.all([
      new CloudClient(t.deps).session(),
      new CloudClient(t.deps).session(),
    ]);
    expect(cloud.refreshes).toEqual(["ocra_ref_r1"]);
    expect(tokenOf(a)).toBe("ocra_cli_a2");
    expect(tokenOf(b)).toBe("ocra_cli_a2");
    expect(t.saved().refresh_token).toBe("ocra_ref_r2");
    expect(existsSync(`${t.credentialsPath}.lock`)).toBe(false);
  });

  it("takes the pair another process stored when its own refresh is refused", async () => {
    // Another process, which did not wait for the lock, rotated first.
    let t: ReturnType<typeof signedIn> | undefined;
    const cloud = rotatingCloud((token) => {
      if (token !== "ocra_ref_r1") return;
      cloud.rotate("ocra_ref_other");
      t?.write({
        access_token: "ocra_cli_other",
        refresh_token: "ocra_ref_other",
        expires_at: NOW + 3_600_000,
      });
    });
    t = signedIn(cloud.fetch);
    const session = await new CloudClient(t.deps).session();
    expect(tokenOf(session)).toBe("ocra_cli_other");
    expect(cloud.refreshes).toEqual(["ocra_ref_r1"]);
  });

  it("refreshes with the other process's token when its access token is due too", async () => {
    let t: ReturnType<typeof signedIn> | undefined;
    const cloud = rotatingCloud((token) => {
      if (token !== "ocra_ref_r1") return;
      cloud.rotate("ocra_ref_other");
      t?.write({ access_token: "ocra_cli_other", refresh_token: "ocra_ref_other" });
    });
    t = signedIn(cloud.fetch);
    const session = await new CloudClient(t.deps).session();
    expect(cloud.refreshes).toEqual(["ocra_ref_r1", "ocra_ref_other"]);
    expect(tokenOf(session)).toBe("ocra_cli_a2");
    expect(t.saved().refresh_token).toBe("ocra_ref_r2");
  });

  it("is signed out when the refresh is refused and no other process stored a pair", async () => {
    const cloud = rotatingCloud();
    cloud.rotate("ocra_ref_elsewhere");
    const t = signedIn(cloud.fetch);
    expect(await new CloudClient(t.deps).session()).toEqual({ kind: "revoked" });
    expect(cloud.refreshes).toEqual(["ocra_ref_r1"]);
  });

  it("does not refresh a token another process refreshed while it waited", async () => {
    const cloud = rotatingCloud();
    const t = signedIn(cloud.fetch);
    const other = heldElsewhere(t, { access_token: "ocra_cli_new", expires_at: NOW + 3_600_000 });
    expect(tokenOf(await new CloudClient(t.deps).session())).toBe("ocra_cli_new");
    await other;
    expect(cloud.refreshes).toEqual([]);
  });

  it("takes the pair another process saved while it waited, though it asked for a longer-lived token", async () => {
    // Longer than any token lives: a second refresh would only rotate the pair again.
    const cloud = rotatingCloud();
    const t = signedIn(cloud.fetch);
    const other = heldElsewhere(t, {
      access_token: "ocra_cli_other",
      refresh_token: "ocra_ref_other",
      expires_at: NOW + 3_600_000,
    });
    const session = await new CloudClient(t.deps).session(2 * 3_600_000);
    await other;
    expect(tokenOf(session)).toBe("ocra_cli_other");
    expect(cloud.refreshes).toEqual([]);
  });

  it("waits out another process's refresh as long as the network may take, without refreshing the same token", async () => {
    let answer = () => {};
    const cloud = rotatingCloud(undefined, new Promise<void>((resolve) => (answer = resolve)));
    const t = signedIn(cloud.fetch);
    const first = new CloudClient(t.deps).session();
    for (let i = 0; i < 100 && cloud.refreshes.length === 0; i += 1) await realTime(10);
    const second = new CloudClient(t.deps).session();
    await realTime(100);
    // The first refresh has been out for nearly two request timeouts.
    vi.setSystemTime(Date.now() + 55_000);
    await realTime(200);
    answer();
    expect(tokenOf(await first)).toBe("ocra_cli_a2");
    expect(tokenOf(await second)).toBe("ocra_cli_a2");
    expect(cloud.refreshes).toEqual(["ocra_ref_r1"]);
    expect(t.saved().refresh_token).toBe("ocra_ref_r2");
    expect(t.notices).toEqual([
      "Waiting for another ocra process to renew the ocra Cloud session...",
    ]);
  });

  it("does not save over a session another process saved during its refresh", async () => {
    let t: ReturnType<typeof signedIn> | undefined;
    const cloud = rotatingCloud(() =>
      t?.write({
        access_token: "ocra_cli_login",
        refresh_token: "ocra_ref_login",
        expires_at: NOW + 3_600_000,
      }),
    );
    t = signedIn(cloud.fetch);
    // Its own new pair still serves this process.
    expect(tokenOf(await new CloudClient(t.deps).session())).toBe("ocra_cli_a2");
    expect(t.saved().refresh_token).toBe("ocra_ref_login");
  });

  it("breaks a lock left by a process that died", async () => {
    const cloud = rotatingCloud();
    const t = signedIn(cloud.fetch);
    writeFileSync(
      `${t.credentialsPath}.lock`,
      JSON.stringify({ token: "dead", at: Date.now() - 10 * 60_000 }),
    );
    const started = Date.now();
    expect(tokenOf(await new CloudClient(t.deps).session())).toBe("ocra_cli_a2");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(`${t.credentialsPath}.lock`)).toBe(false);
  });
});
