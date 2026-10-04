import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capture, critical, deps, removeRepos, repoWithChange, type Script } from "./run.fakes.js";
import { run } from "./run.js";
import { PREFERENCES, signedIn } from "./run-cloud.fakes.js";

// What a signed-in review sends and applies once the account shares
// findings or remembers some (ADR-0028, 2 and 4).

afterEach(removeRepos);

const SALT = "5".repeat(64);
// Built at run time so no secret-shaped literal sits in the repository.
const TOKEN = `ghp_${"Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z".repeat(2)}`;

const leaking: Script = async function* (spec) {
  yield {
    type: "finding",
    taskId: spec.taskId,
    finding: {
      category: "correctness",
      severity: "critical",
      file: "app.ts",
      existingCode: "export const retries = -1;",
      title: "Negative retry count disables retries",
      body: `The retry loop never runs; the token ${TOKEN} is unrelated.`,
      evidence: [],
    },
  };
  yield { type: "done", taskId: spec.taskId };
};

const sharing = {
  "/api/account/salt": () => Response.json({ salt: SALT }),
  "/api/reviews": (_url: URL, body: unknown) => {
    const list = (body as { findingList?: unknown }).findingList;
    return Response.json({ id: "r1", findings: Array.isArray(list) ? list.length : 0 });
  },
};

async function fingerprintOf(cwd: string): Promise<string> {
  const { cloud } = signedIn();
  const out = capture();
  await run(
    ["review", "--format", "json", "--no-upload"],
    out,
    capture(),
    deps(cwd, critical, { cloud }, true),
  );
  return JSON.parse(out.text()).findings[0].fingerprint;
}

describe("findings in ocra Cloud", () => {
  it("sends the findings, redacted, when the account answers a salt", async () => {
    const cwd = repoWithChange();
    const { cloud, calls } = signedIn({}, PREFERENCES, false, sharing);
    const err = capture();
    await run(["review"], capture(), err, deps(cwd, leaking, { cloud }, true));
    const sent = calls.find((c) => c.path === "/api/reviews")?.body as Record<string, unknown>;
    expect(sent.findings).toEqual({ critical: 1, warning: 0, suggestion: 0 });
    expect(sent.findingList).toEqual([
      expect.objectContaining({
        reviewer: "correctness",
        severity: "critical",
        file: "app.ts",
        code: "export const retries = -1;",
        body: "The retry loop never runs; the token [redacted] is unrelated.",
        redacted: true,
      }),
    ]);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
    expect(err.text()).toContain(
      "[ocra] Sent this review's counts and 1 finding(s) to ocra Cloud (--no-upload to skip)",
    );
  });

  it("sends only the counts when the account answers no salt", async () => {
    const cwd = repoWithChange();
    const { cloud, calls } = signedIn({}, PREFERENCES, false, {
      ...sharing,
      "/api/account/salt": () => Response.json({ salt: null }),
    });
    const err = capture();
    await run(["review"], capture(), err, deps(cwd, leaking, { cloud }, true));
    const sent = calls.find((c) => c.path === "/api/reviews")?.body as Record<string, unknown>;
    expect(sent.findings).toEqual({ critical: 1, warning: 0, suggestion: 0 });
    expect(JSON.stringify(calls)).not.toMatch(/app\.ts|retries/);
    expect(err.text()).toContain("[ocra] Sent this review's counts to ocra Cloud");
  });

  it("sends only the counts, with one warning, when the salt cannot be read", async () => {
    const cwd = repoWithChange();
    const { cloud, calls } = signedIn({}, PREFERENCES, false, {
      ...sharing,
      "/api/account/salt": () => new Response("{}", { status: 502 }),
    });
    const err = capture();
    await run(["review"], capture(), err, deps(cwd, leaking, { cloud }, true));
    const sent = calls.find((c) => c.path === "/api/reviews")?.body as Record<string, unknown>;
    expect(sent.findings).toEqual({ critical: 1, warning: 0, suggestion: 0 });
    expect(err.text().match(/sends no findings/g)).toHaveLength(1);
  });

  it("sends nothing with --no-upload, even when the account shares findings", async () => {
    const cwd = repoWithChange();
    const { cloud, calls } = signedIn({}, PREFERENCES, false, sharing);
    await run(["review", "--no-upload"], capture(), capture(), deps(cwd, leaking, { cloud }, true));
    expect(calls.map((c) => c.path)).not.toContain("/api/reviews");
  });
});

describe("the account's memory", () => {
  const remembering = (fingerprint: string) => ({
    ...sharing,
    "/api/memory": () =>
      Response.json({
        entries: [
          {
            id: "m1",
            repo: "55555555",
            repoHash: "f".repeat(64),
            fingerprint,
            file: "app.ts",
            title: "Negative retry count disables retries",
            reason: "intended",
            createdAt: "2026-10-01T00:00:00Z",
          },
        ],
      }),
  });

  it("hides what it remembers, says so, and names the source in the report", async () => {
    const cwd = repoWithChange();
    const fingerprint = await fingerprintOf(cwd);
    const { cloud, calls } = signedIn({}, PREFERENCES, false, remembering(fingerprint));
    const out = capture();
    const err = capture();
    await run(
      ["review", "--format", "json", "--no-upload"],
      out,
      err,
      deps(cwd, critical, { cloud }, true),
    );
    const report = JSON.parse(out.text());
    expect(report.findings).toEqual([]);
    expect(report.remembered).toEqual([
      expect.objectContaining({ fingerprint, reason: "intended", source: "account" }),
    ]);
    expect(err.text()).toContain("[ocra] 1 finding(s) hidden by your ocra Cloud memory");
    const memoryCall = calls.find((c) => c.path === "/api/memory");
    expect(memoryCall?.query).toMatch(/^\?repo=[0-9a-f]{64}$/);
  });

  it("attributes a finding both remember to the repository's file", async () => {
    const cwd = repoWithChange();
    const fingerprint = await fingerprintOf(cwd);
    mkdirSync(join(cwd, ".ocra"), { recursive: true });
    writeFileSync(
      join(cwd, ".ocra", "memory.json"),
      JSON.stringify({
        accepted: [{ fingerprint, file: "app.ts", title: "t", reason: "the team's" }],
      }),
    );
    const { cloud } = signedIn({}, PREFERENCES, false, remembering(fingerprint));
    const out = capture();
    const err = capture();
    await run(
      ["review", "--format", "json", "--no-upload"],
      out,
      err,
      deps(cwd, critical, { cloud }, true),
    );
    expect(JSON.parse(out.text()).remembered).toEqual([
      expect.objectContaining({ fingerprint, reason: "the team's", source: "repository" }),
    ]);
    expect(err.text()).not.toContain("hidden by your ocra Cloud memory");
  });

  it("is never read when the review is not signed in", async () => {
    const cwd = repoWithChange();
    const fingerprint = await fingerprintOf(cwd);
    const off = signedIn({ OCRA_CLOUD: "off" }, PREFERENCES, false, remembering(fingerprint));
    const out = capture();
    await run(
      ["review", "--format", "json"],
      out,
      capture(),
      deps(cwd, critical, { cloud: off.cloud }, true),
    );
    expect(off.calls).toEqual([]);
    expect(JSON.parse(out.text()).findings).toHaveLength(1);
  });
});
