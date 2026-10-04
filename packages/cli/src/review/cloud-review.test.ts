import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accountSaltPath } from "../account-salt.js";
import type { CloudDeps } from "../cloud.js";
import { parseAccountMemory } from "./cloud-memory.js";
import { prepareCloudReview } from "./cloud-review.js";
import { repoHash } from "./cloud-upload.js";

const SALT = "5".repeat(64);
const ENTRY = {
  id: "m1",
  repo: "abcdef12",
  repoHash: "f".repeat(64),
  fingerprint: "0123456789abcdef",
  file: "src/a.ts",
  title: "Known",
  reason: "accepted by the team",
  createdAt: "2026-10-01T12:00:00.000Z",
};

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-cr-repo-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/org/repo"]);
  return dir;
}

function machine(routes: Record<string, () => Response>) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-cr-"));
  const credentialsPath = join(dir, "ocra", "credentials.json");
  mkdirSync(join(dir, "ocra"));
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      server: "https://cloud.test",
      login: "o",
      access_token: "ocra_cli_t",
      refresh_token: "r",
      expires_at: Date.now() + 3_600_000,
    }),
  );
  const calls: string[] = [];
  const deps: CloudDeps = {
    env: {},
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      const route = routes[url.pathname];
      return route ? route() : new Response("{}", { status: 404 });
    }) as typeof fetch,
    now: Date.now,
    sleep: async () => {},
    openBrowser: () => {},
    credentialsPath,
    clientName: "t",
  };
  return { deps, calls, credentialsPath };
}

const sharing = {
  "/api/account/salt": () => Response.json({ salt: SALT }),
  "/api/memory": () => Response.json({ entries: [ENTRY] }),
};

describe("prepareCloudReview", () => {
  it("hashes with the account's salt, keeps it beside the credentials, and reads the memory", async () => {
    const root = repo();
    const m = machine(sharing);
    const warnings: string[] = [];
    const ready = await prepareCloudReview(root, m.deps, (w) => warnings.push(w));
    const hash = await repoHash(root, m.credentialsPath, SALT);
    expect(ready).toEqual({
      repoHash: hash,
      shareFindings: true,
      memory: [
        {
          fingerprint: ENTRY.fingerprint,
          file: ENTRY.file,
          title: ENTRY.title,
          reason: ENTRY.reason,
          added: "2026-10-01",
        },
      ],
    });
    expect(m.calls).toEqual(["/api/account/salt", `/api/memory?repo=${hash}`]);
    const saved = accountSaltPath(m.credentialsPath);
    expect(readFileSync(saved, "utf8").trim()).toBe(SALT);
    if (process.platform !== "win32") expect(statSync(saved).mode & 0o777).toBe(0o600);
    expect(warnings).toEqual([]);
    // Another machine of the account hashes the repository alike.
    const other = await prepareCloudReview(root, machine(sharing).deps, () => {});
    expect(other?.repoHash).toBe(hash);
  });

  it("keeps this machine's salt and shares no findings when the account answers none", async () => {
    const root = repo();
    for (const salt of [() => Response.json({ salt: null }), undefined]) {
      const m = machine(salt ? { ...sharing, "/api/account/salt": salt } : {});
      writeFileSync(accountSaltPath(m.credentialsPath), `${SALT}\n`);
      const ready = await prepareCloudReview(root, m.deps, () => {});
      expect(ready?.shareFindings).toBe(false);
      expect(ready?.repoHash).toBe(await repoHash(root, m.credentialsPath));
      expect(existsSync(accountSaltPath(m.credentialsPath))).toBe(false);
    }
  });

  it("on a failure to read the salt, warns once, uses this machine's salt and skips the memory", async () => {
    const root = repo();
    for (const failing of [
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("{}", { status: 503 }),
      () => Response.json({ salt: "not-a-salt" }),
    ]) {
      const m = machine({ ...sharing, "/api/account/salt": failing });
      const warnings: string[] = [];
      const ready = await prepareCloudReview(root, m.deps, (w) => warnings.push(w));
      expect(ready).toEqual({
        repoHash: await repoHash(root, m.credentialsPath),
        shareFindings: false,
        memory: [],
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("this review sends no findings");
      expect(m.calls).toEqual(["/api/account/salt"]);
    }
  });

  it("warns and applies no account memory when the memory cannot be read", async () => {
    const root = repo();
    const m = machine({
      ...sharing,
      "/api/memory": () => new Response("{}", { status: 500 }),
    });
    const warnings: string[] = [];
    const ready = await prepareCloudReview(root, m.deps, (w) => warnings.push(w));
    expect(ready?.shareFindings).toBe(true);
    expect(ready?.memory).toEqual([]);
    expect(warnings).toEqual([
      "could not read your ocra Cloud memory (HTTP 500); the review applies the repository's alone",
    ]);
  });

  it("is undefined when the saved session is gone", async () => {
    const m = machine(sharing);
    writeFileSync(m.credentialsPath, "{}");
    expect(await prepareCloudReview(repo(), m.deps, () => {})).toBeUndefined();
    expect(m.calls).toEqual([]);
  });
});

describe("parseAccountMemory", () => {
  it("keeps the entries it can read and counts the rest", () => {
    const warnings: string[] = [];
    const entries = parseAccountMemory(
      {
        entries: [ENTRY, { ...ENTRY, fingerprint: "../../etc" }, { ...ENTRY, reason: "" }, "junk"],
      },
      (w) => warnings.push(w),
    );
    expect(entries.map((e) => e.fingerprint)).toEqual([ENTRY.fingerprint]);
    expect(warnings).toEqual([
      "ignoring 3 ocra Cloud memory entries this version of ocra cannot read",
    ]);
    expect(parseAccountMemory({ nope: 1 }, (w) => warnings.push(w))).toEqual([]);
    expect(warnings.at(-1)).toContain("has no entries");
  });
});
