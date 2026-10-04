import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CloudDeps, type CloudSession, type Credentials, cloudSession } from "./cloud.js";

const SERVER = "https://cloud.test";
const NOW = 1_000_000;

/** The session's access token, or the kind of session there is instead. */
const tokenOf = (s: CloudSession) => (s.kind === "ok" ? s.credentials.access_token : s.kind);

/**
 * ocra Cloud's refresh as the server does it: the refresh token rotates by
 * compare-and-set, so a second refresh with the same token is refused.
 */
function rotatingCloud(onRefresh?: (token: string) => void) {
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
    await new Promise((resolve) => setTimeout(resolve, 30));
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
  const deps: CloudDeps = {
    env: {},
    fetch,
    now: () => NOW,
    sleep: async () => {},
    openBrowser: () => {},
    credentialsPath,
    clientName: "t",
  };
  const saved = () => JSON.parse(readFileSync(credentialsPath, "utf8")) as Credentials;
  return { deps, write, saved, credentialsPath };
}

describe("refreshing the ocra Cloud session", () => {
  it("refreshes once for two callers at once, and both get the new token", async () => {
    const cloud = rotatingCloud();
    const t = signedIn(cloud.fetch);
    const [a, b] = await Promise.all([cloudSession(t.deps), cloudSession(t.deps)]);
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
    const session = await cloudSession(t.deps);
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
    const session = await cloudSession(t.deps);
    expect(cloud.refreshes).toEqual(["ocra_ref_r1", "ocra_ref_other"]);
    expect(tokenOf(session)).toBe("ocra_cli_a2");
    expect(t.saved().refresh_token).toBe("ocra_ref_r2");
  });

  it("is signed out when the refresh is refused and no other process stored a pair", async () => {
    const cloud = rotatingCloud();
    cloud.rotate("ocra_ref_elsewhere");
    const t = signedIn(cloud.fetch);
    expect(await cloudSession(t.deps)).toEqual({ kind: "revoked" });
    expect(cloud.refreshes).toEqual(["ocra_ref_r1"]);
  });

  it("does not refresh a token another process refreshed while it waited", async () => {
    const cloud = rotatingCloud();
    const t = signedIn(cloud.fetch);
    // Held by another process, which stores a fresh pair and lets go.
    writeFileSync(`${t.credentialsPath}.lock`, JSON.stringify({ token: "x", at: Date.now() }));
    setTimeout(() => {
      t.write({ access_token: "ocra_cli_new", expires_at: NOW + 3_600_000 });
      rmSync(`${t.credentialsPath}.lock`);
    }, 100);
    expect(tokenOf(await cloudSession(t.deps))).toBe("ocra_cli_new");
    expect(cloud.refreshes).toEqual([]);
  });

  it("breaks a lock left by a process that died more than 30 seconds ago", async () => {
    const cloud = rotatingCloud();
    const t = signedIn(cloud.fetch);
    writeFileSync(
      `${t.credentialsPath}.lock`,
      JSON.stringify({ token: "dead", at: Date.now() - 31_000 }),
    );
    const started = Date.now();
    expect(tokenOf(await cloudSession(t.deps))).toBe("ocra_cli_a2");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(`${t.credentialsPath}.lock`)).toBe(false);
  });
});
