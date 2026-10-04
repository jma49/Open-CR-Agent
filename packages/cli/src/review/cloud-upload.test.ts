import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewReport } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import type { CloudDeps } from "../cloud.js";
import type { SharedFinding } from "./cloud-findings.js";
import { repoHash, uploadOf, uploadReview } from "./cloud-upload.js";

const NOW = 1_000_000_000;

function repo(origin?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-up-repo-"));
  execFileSync("git", ["init", "-q", dir]);
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  return dir;
}

function cloud(answer: (path: string, init?: RequestInit) => Response) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-up-"));
  const credentialsPath = join(dir, "ocra", "credentials.json");
  mkdirSync(join(dir, "ocra"));
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      server: "https://cloud.test",
      login: "o",
      access_token: "ocra_cli_t",
      refresh_token: "r",
      expires_at: NOW + 3_600_000,
    }),
  );
  const calls: { path: string; init?: RequestInit }[] = [];
  const deps: CloudDeps = {
    env: {},
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, ...(init ? { init } : {}) });
      return answer(path, init);
    }) as typeof fetch,
    now: () => NOW,
    sleep: async () => {},
    openBrowser: () => {},
    credentialsPath,
    clientName: "t",
  };
  return { deps, calls, credentialsPath };
}

const report = {
  runId: "run-1",
  tier: "lite",
  verdict: "changes_requested",
  findings: [
    {
      severity: "critical",
      title: "SECRET TITLE",
      file: "src/secret.ts",
      body: "const key = 1",
      reviewer: "security",
      fingerprint: "fp-secret-critical",
      verification: "confirmed",
    },
    {
      severity: "warning",
      title: "t",
      file: "a",
      body: "b",
      reviewer: "security",
      fingerprint: "fp-dismissed",
      verification: "uncertain",
    },
    {
      severity: "warning",
      title: "t",
      file: "a",
      body: "b",
      reviewer: "logic",
      fingerprint: "fp-3",
    },
  ],
  coverage: [
    { path: "src/secret.ts", status: "reviewed" },
    { path: "b.ts", status: "unreviewed" },
    { path: "c.ts", status: "excluded", reason: "generated" },
  ],
  tasks: [
    { reviewer: "security", status: "completed", usage: { costUsd: 0.25 } },
    { reviewer: "logic", status: "failed", usage: { costUsd: 0.1 } },
    { reviewer: "logic", status: "timed_out", usage: { costUsd: 0.05 } },
    { reviewer: "style", status: "cancelled", usage: { costUsd: 0 } },
  ],
  rereview: {
    fixed: [
      { fingerprint: "fp-gone-unknown", title: "FIXED TITLE", file: "src/fixed-path.ts" },
      { fingerprint: "fp-3", title: "t", file: "a" },
      { fingerprint: "fp-dismissed", title: "t", file: "a" },
    ],
    dismissed: [{ fingerprint: "fp-dismissed", title: "DISMISSED TITLE", file: "src/d.ts" }],
    notReproduced: [],
    notRechecked: [],
    unchanged: [],
  },
  usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cachedTokens: 0, costUsd: 0.5 },
} as unknown as ReviewReport;

describe("the review upload", () => {
  it("carries counts only", () => {
    const up = uploadOf(report, "local", "f".repeat(64), 1234.6);
    expect(up).toMatchObject({
      runId: "run-1",
      source: "local",
      verdict: "changes_requested",
      complete: false,
      findings: { critical: 1, warning: 2, suggestion: 0 },
      files: { reviewed: 1, notReviewed: 1 },
      tasks: { completed: 1, failed: 1 },
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.5 },
      durationMs: 1235,
    });
    expect(JSON.stringify(up)).not.toMatch(/SECRET|secret\.ts|const key/);
  });

  it("counts per reviewer, by verification and by outcome", () => {
    const up = uploadOf(report, "local", "f".repeat(64), 1);
    expect(up.reviewers).toEqual({
      logic: {
        tasks: 2,
        failedTasks: 2,
        findings: { critical: 0, warning: 1, suggestion: 0 },
        costUsd: expect.closeTo(0.15, 10),
        fixed: 1,
        dismissed: 0,
      },
      security: {
        tasks: 1,
        failedTasks: 0,
        findings: { critical: 1, warning: 1, suggestion: 0 },
        costUsd: 0.25,
        fixed: 0,
        dismissed: 1,
      },
      style: {
        tasks: 1,
        failedTasks: 0,
        findings: { critical: 0, warning: 0, suggestion: 0 },
        costUsd: 0,
        fixed: 0,
        dismissed: 0,
      },
    });
    expect(up.verification).toEqual({ confirmed: 1, uncertain: 1, unchecked: 1 });
    // The unattributed fix still counts; the dismissed one is not also fixed.
    expect(up.outcomes).toEqual({ fixed: 2, dismissed: 1 });
  });

  it("credits a fix or a dismissal to the reviewer the earlier review recorded", () => {
    // The fixed finding is gone from this report, so only its recorded
    // reviewer can claim it; a recorded reviewer outranks this report's.
    const up = uploadOf(
      {
        ...report,
        rereview: {
          fixed: [{ fingerprint: "fp-gone", title: "t", file: "a", reviewer: "performance" }],
          dismissed: [{ fingerprint: "fp-3", title: "t", file: "a", reviewer: "security" }],
          notReproduced: [],
          notRechecked: [],
          unchanged: [],
        },
      } as unknown as ReviewReport,
      "github",
      "f".repeat(64),
      1,
    );
    expect(up.reviewers?.performance).toMatchObject({ tasks: 0, fixed: 1, dismissed: 0 });
    expect(up.reviewers?.security).toMatchObject({ fixed: 0, dismissed: 1 });
    expect(up.reviewers?.logic).toMatchObject({ fixed: 0, dismissed: 0 });
    expect(up.outcomes).toEqual({ fixed: 1, dismissed: 1 });
  });

  it("never sends a fingerprint, a path or a title from findings or the re-review", () => {
    const up = uploadOf(report, "local", "f".repeat(64), 1);
    // Not vacuous: the re-review's entries are counted, so they were read.
    expect(up.outcomes).toEqual({ fixed: 2, dismissed: 1 });
    const sent = JSON.stringify(up);
    for (const leak of [
      "fp-",
      "TITLE",
      "secret.ts",
      "fixed-path",
      "src/d.ts",
      "const key",
      '"t"',
      '"a"',
    ])
      expect(sent).not.toContain(leak);
  });

  it("hashes the repository with a salt kept on this machine, without credentials in the URL", async () => {
    const a = cloud(() => new Response("{}"));
    const b = cloud(() => new Response("{}"));
    const withToken = repo("https://x-token:ghp_secret@github.com/Org/Repo.git");
    const plain = repo("https://github.com/org/repo");
    const h1 = await repoHash(withToken, a.credentialsPath);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await repoHash(plain, a.credentialsPath)).toBe(h1);
    expect(await repoHash(plain, b.credentialsPath)).not.toBe(h1);
    const saltFile = join(a.credentialsPath, "..", "upload-salt");
    expect(readFileSync(saltFile, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") expect(statSync(saltFile).mode & 0o777).toBe(0o600);
    expect(await repoHash(repo(), a.credentialsPath)).not.toBe(h1);
  });

  it("hashes with the account's salt alike on every machine, and apart from this machine's", async () => {
    const a = cloud(() => new Response("{}"));
    const b = cloud(() => new Response("{}"));
    const plain = repo("https://github.com/org/repo");
    const account = "a".repeat(64);
    const onA = await repoHash(plain, a.credentialsPath, account);
    expect(await repoHash(plain, b.credentialsPath, account)).toBe(onA);
    expect(await repoHash(plain, a.credentialsPath)).not.toBe(onA);
  });

  it("sends the findings beside the counts and answers how many were kept", async () => {
    const ok = cloud(() => Response.json({ id: "x", findings: 1 }));
    const up = uploadOf(report, "local", "f".repeat(64), 1);
    const shared = [{ fingerprint: "fp" } as unknown as SharedFinding];
    expect(await uploadReview(up, ok.deps, () => {}, shared)).toEqual({ findings: 1 });
    const sent = JSON.parse(String(ok.calls[0]?.init?.body));
    expect(sent.findingList).toEqual([{ fingerprint: "fp" }]);
    expect(sent.findings).toEqual(up.findings);
    expect(sent.reviewers).toEqual(up.reviewers);
  });

  it("posts with the session token, and turns a failure into a warning", async () => {
    const ok = cloud(() => Response.json({ id: "x" }));
    const warnings: string[] = [];
    const up = uploadOf(report, "github", "f".repeat(64), 1);
    expect(await uploadReview(up, ok.deps, (m) => warnings.push(m))).toEqual({ findings: 0 });
    expect(ok.calls[0]?.path).toBe("/api/reviews");
    expect(new Headers(ok.calls[0]?.init?.headers).get("authorization")).toBe("Bearer ocra_cli_t");
    expect(JSON.parse(String(ok.calls[0]?.init?.body))).toEqual(up);

    const down = cloud(() => new Response("{}", { status: 503 }));
    expect(await uploadReview(up, down.deps, (m) => warnings.push(m))).toBeUndefined();
    const offline = cloud(() => {
      throw new TypeError("fetch failed");
    });
    expect(await uploadReview(up, offline.deps, (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).not.toContain("ocra_cli_t");
  });
});
