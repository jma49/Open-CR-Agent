import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterAll, describe, expect, it } from "vitest";
import { originRepository } from "../repository-id.js";
import { accountSaltPath } from "./account-salt.js";
import { endlessMemory } from "./client.fakes.js";
import type { CloudDeps } from "./deps.js";
import { parseAccountMemory } from "./memory.js";
import { prepareCloudReview } from "./review.js";
import { repoHash } from "./upload.js";

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

async function hashOf(root: string, credentialsPath: string, salt?: string): Promise<string> {
  return repoHash(await originRepository(root), credentialsPath, salt);
}

const repos = scratchRepos("ocra-cr-repo-");
afterAll(repos.removeAll);
const repo = (origin = "https://github.com/org/repo") => repos.create({ origin }).dir;

// Named in the manual; `ocra login` writes it, with the user present, while
// the account shares findings.
const sharingConsentPath = (credentialsPath: string) =>
  join(dirname(credentialsPath), "share-findings");

// A machine signed in with `ocra login`, which recorded its consent to send
// findings unless `consent` is false.
function machine(routes: Record<string, () => Response>, { consent = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-cr-"));
  const credentialsPath = join(dir, "ocra", "credentials.json");
  mkdirSync(join(dir, "ocra"));
  if (consent) writeFileSync(sharingConsentPath(credentialsPath), "on\n");
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
    const hash = await hashOf(root, m.credentialsPath, SALT);
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
      expect(ready?.memory).toEqual([]);
      expect(ready?.repoHash).toBe(await hashOf(root, m.credentialsPath));
      expect(existsSync(accountSaltPath(m.credentialsPath))).toBe(false);
    }
  });

  it("shares no findings, and says so, when the account shares them but this machine never agreed", async () => {
    const root = repo();
    const m = machine(sharing, { consent: false });
    const warnings: string[] = [];
    const ready = await prepareCloudReview(root, m.deps, (w) => warnings.push(w));
    expect(ready).toMatchObject({
      repoHash: await hashOf(root, m.credentialsPath, SALT),
      shareFindings: false,
    });
    expect(warnings).toEqual([
      "your ocra Cloud account shares findings, but this machine has not agreed to send them since it signed in; this review sends counts only (run ocra login to send findings from this machine)",
    ]);
  });

  it("forgets this machine's consent once the account stops sharing, so turning it on again needs a login", async () => {
    const root = repo();
    const m = machine({ ...sharing, "/api/account/salt": () => Response.json({ salt: null }) });
    expect((await prepareCloudReview(root, m.deps, () => {}))?.shareFindings).toBe(false);
    expect(existsSync(sharingConsentPath(m.credentialsPath))).toBe(false);
    m.deps.fetch = machine(sharing).deps.fetch;
    const warnings: string[] = [];
    expect((await prepareCloudReview(root, m.deps, (w) => warnings.push(w)))?.shareFindings).toBe(
      false,
    );
    expect(warnings).toEqual([expect.stringMatching(/has not agreed to send them/)]);
  });

  it("says once that the account's memory does not apply while it does not share findings", async () => {
    const off = { ...sharing, "/api/account/salt": () => Response.json({ salt: null }) };
    const m = machine(off);
    const warnings: string[] = [];
    await prepareCloudReview(repo(), m.deps, (w) => warnings.push(w));
    expect(m.calls).toEqual(["/api/account/salt", "/api/memory?limit=1"]);
    expect(warnings).toEqual([
      "your ocra Cloud account remembers findings, but applies them only while it shares findings (Settings in ocra Cloud); this review applies the repository's memory alone",
    ]);
    const none = machine({ ...off, "/api/memory": () => Response.json({ entries: [] }) });
    const quiet: string[] = [];
    await prepareCloudReview(repo(), none.deps, (w) => quiet.push(w));
    expect(quiet).toEqual([]);
  });

  it("tells whether the account remembers findings without reading all of them", async () => {
    const memory = endlessMemory(40);
    const m = machine({
      "/api/account/salt": () => Response.json({ salt: null }),
      "/api/memory": memory.answer,
    });
    const warnings: string[] = [];
    await prepareCloudReview(repo(), m.deps, (w) => warnings.push(w));
    expect(warnings).toEqual([expect.stringMatching(/remembers findings/)]);
    expect(memory.counter.read).toBeLessThan(1024 * 1024);
  });

  // Windows ignores the mode, and root reads the file anyway.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "sends nothing, and keeps this machine's salt, when it cannot read that salt, said once",
    async () => {
      // The account shares no findings, or cannot be reached.
      const answers = [
        () => Response.json({ salt: null }),
        () => new Response("", { status: 500 }),
      ];
      for (const answer of answers) {
        const m = machine({ "/api/account/salt": answer });
        const path = join(dirname(m.credentialsPath), "upload-salt");
        writeFileSync(path, `${SALT}\n`, { mode: 0o000 });
        const warnings: string[] = [];
        try {
          expect(await prepareCloudReview(repo(), m.deps, (w) => warnings.push(w))).toBeUndefined();
        } finally {
          chmodSync(path, 0o600);
        }
        expect(readFileSync(path, "utf8")).toBe(`${SALT}\n`);
        expect(warnings).toEqual([
          expect.stringMatching(/cannot be read.*sends nothing to ocra Cloud/),
        ]);
      }
    },
  );

  // Windows ignores the mode, and root writes anyway.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "runs a signed-in review when the config directory cannot be written",
    async () => {
      const root = repo();
      const unwritable = async (m: ReturnType<typeof machine>) => {
        const dir = dirname(m.credentialsPath);
        const warnings: string[] = [];
        chmodSync(dir, 0o500);
        try {
          const ready = await prepareCloudReview(root, m.deps, (w) => warnings.push(w));
          return { ready, warnings };
        } finally {
          chmodSync(dir, 0o700);
        }
      };
      const notKept = /could not keep your ocra Cloud account's salt/;

      // A sharing account: the answer's salt serves this review.
      const shared = machine(sharing);
      const kept = await unwritable(shared);
      expect(kept.ready).toMatchObject({
        repoHash: await hashOf(root, shared.credentialsPath, SALT),
        shareFindings: true,
      });
      expect(kept.ready?.memory).toHaveLength(1);
      expect(kept.warnings).toEqual([expect.stringMatching(notKept)]);

      // An account that answers no salt: this machine's, while account-salt
      // stays behind.
      const off = machine(
        { "/api/account/salt": () => Response.json({ salt: null }) },
        { consent: false },
      );
      writeFileSync(join(dirname(off.credentialsPath), "upload-salt"), `${"6".repeat(64)}\n`);
      writeFileSync(accountSaltPath(off.credentialsPath), `${SALT}\n`);
      const stale = await unwritable(off);
      expect(stale.ready).toMatchObject({
        repoHash: await hashOf(root, off.credentialsPath),
        shareFindings: false,
      });
      expect(stale.warnings).toEqual([
        expect.stringMatching(/could not remove the ocra Cloud account salt this machine kept/),
      ]);

      // No salt to hash with: nothing goes to ocra Cloud.
      for (const answer of [
        () => Response.json({ salt: null }),
        () => new Response("", { status: 500 }),
      ]) {
        const none = await unwritable(machine({ "/api/account/salt": answer }));
        expect(none.ready).toBeUndefined();
        expect(none.warnings.at(-1)).toMatch(/cannot be made.*sends nothing to ocra Cloud/);
      }
    },
  );

  it("hashes one repository alike whatever form its origin URL takes", async () => {
    const m = machine(sharing);
    const forms = [
      "https://github.com/Org/Repo.git",
      "git@github.com:org/repo.git",
      "ssh://git@github.com/org/repo",
      "ssh://git@github.com:22/org/repo.git",
      "https://x-token:ghp_secret@GitHub.com:443/org/repo/",
      "git+ssh://git@ssh.github.com:443/org/Repo.git/",
    ];
    const hashes = new Set<string | undefined>();
    for (const origin of forms) {
      hashes.add((await prepareCloudReview(repo(origin), m.deps, () => {}))?.repoHash);
    }
    expect(hashes.size).toBe(1);
    const other = await prepareCloudReview(repo("git@github.com:org/other.git"), m.deps, () => {});
    expect(hashes.has(other?.repoHash)).toBe(false);
  });

  it("hashes the pull or merge request's repository, not the checkout's origin", async () => {
    const m = machine(sharing);
    const target = await prepareCloudReview(
      repo("git@github.com:org/other.git"),
      m.deps,
      () => {},
      "https://github.com/org/repo",
    );
    const origin = await prepareCloudReview(repo(), m.deps, () => {});
    expect(target?.repoHash).toBe(origin?.repoHash);
  });

  it("hashes with the account's salt kept from the last answer when ocra Cloud cannot be reached", async () => {
    const root = repo();
    const online = await prepareCloudReview(root, machine(sharing).deps, () => {});
    const m = machine({
      "/api/account/salt": () => {
        throw new TypeError("fetch failed");
      },
    });
    writeFileSync(accountSaltPath(m.credentialsPath), `${SALT}\n`);
    const offline = await prepareCloudReview(root, m.deps, () => {});
    expect(offline).toEqual({ repoHash: online?.repoHash, shareFindings: false, memory: [] });
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
        repoHash: await hashOf(root, m.credentialsPath),
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
      [ENTRY, { ...ENTRY, fingerprint: "../../etc" }, { ...ENTRY, reason: "" }, "junk"],
      (w) => warnings.push(w),
    );
    expect(entries.map((e) => e.fingerprint)).toEqual([ENTRY.fingerprint]);
    expect(warnings).toEqual([
      "ignoring 3 ocra Cloud memory entries this version of ocra cannot read",
    ]);
  });
});
