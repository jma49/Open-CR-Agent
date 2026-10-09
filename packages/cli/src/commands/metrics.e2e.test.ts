import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { collectMetrics, metricsCommand } from "./metrics.js";

const repos = scratchRepos("ocra-metrics-");
afterEach(repos.removeAll);

function capture() {
  let text = "";
  return { write: (chunk: string) => (text += chunk), text: () => text };
}

const CHANGE = {
  id: "ws",
  title: "t",
  description: "",
  baseSha: "b".repeat(40),
  headSha: "c".repeat(40),
};

function finding(fingerprint: string, reviewer: string, severity = "warning") {
  return {
    fingerprint,
    reviewer,
    category: reviewer,
    severity,
    verification: "confirmed",
    file: "src/a.ts",
    lines: { start: 1, end: 1 },
    inDiff: true,
    status: "new",
    title: `finding ${fingerprint}`,
    body: "b",
    evidence: [],
    code: "x",
  };
}

function task(taskId: string, reviewer: string, costUsd: number, status = "completed") {
  return {
    taskId,
    reviewer,
    bundle: "b",
    files: ["src/a.ts"],
    status,
    findings: 0,
    durationMs: 1,
    usage: { inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cachedTokens: 0, costUsd },
  };
}

function report(overrides: Record<string, unknown>) {
  return {
    version: 1,
    runId: "20261002T070000Z-aaaaaa",
    changeRequest: CHANGE,
    tier: "lite",
    verdict: "approved",
    summary: "s",
    coverage: [{ path: "src/a.ts", status: "reviewed" }],
    findings: [],
    unverifiedCriticals: 0,
    refuted: [],
    remembered: [],
    tasks: [],
    skipped: [],
    bundles: [],
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 },
    warnings: [],
    ...overrides,
  };
}

function repoWithSessions(sessions: Record<string, unknown>): string {
  const { dir } = repos.create();
  for (const [id, content] of Object.entries(sessions)) {
    const session = join(dir, ".ocra", "sessions", id);
    mkdirSync(session, { recursive: true });
    if (content !== undefined) writeFileSync(join(session, "report.json"), JSON.stringify(content));
  }
  return dir;
}

const A = "a".repeat(16);
const B = "b".repeat(16);
const C = "c".repeat(16);

describe("ocra metrics", () => {
  it("counts runs, cost, findings and what became of them, per reviewer", async () => {
    const dir = repoWithSessions({
      "20261001T100000Z-000001": report({
        runId: "20261001T100000Z-000001",
        verdict: "minor_issues",
        findings: [
          finding(A, "correctness"),
          finding(B, "security", "critical"),
          finding(C, "correctness"),
        ],
        tasks: [
          task("correctness-1", "correctness", 0.5),
          task("security-1", "security", 0.25, "failed"),
        ],
        usage: {
          inputTokens: 200,
          outputTokens: 20,
          reasoningTokens: 0,
          cachedTokens: 0,
          costUsd: 0.75,
        },
      }),
      "20261002T100000Z-000002": report({
        runId: "20261002T100000Z-000002",
        verdict: "approved",
        coverage: [{ path: "src/a.ts", status: "unreviewed" }],
        findings: [{ ...finding(C, "correctness"), status: "unfixed" }],
        tasks: [task("correctness-1", "correctness", 0.25)],
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          reasoningTokens: 0,
          cachedTokens: 0,
          costUsd: 0.25,
        },
        rereview: {
          fixed: [
            {
              fingerprint: A,
              title: "a",
              file: "src/a.ts",
              severity: "warning",
              verification: "confirmed",
            },
          ],
          notReproduced: [],
          notRechecked: [],
          unchanged: [],
          dismissed: [
            {
              fingerprint: B,
              title: "b",
              file: "src/a.ts",
              severity: "critical",
              verification: "confirmed",
            },
          ],
        },
      }),
      // Interrupted: no report.
      "20261002T110000Z-000003": undefined,
      // Not a version 1 report.
      "20261002T120000Z-000004": { version: 2 },
    });
    const metrics = await collectMetrics(join(dir, ".ocra", "sessions"));

    expect(metrics.runs).toEqual({
      total: 2,
      byVerdict: { minor_issues: 1, approved: 1 },
      incomplete: 1,
      unreadable: 2,
    });
    expect(metrics.cost).toEqual({ usd: 1, inputTokens: 300, outputTokens: 30, usdPerRun: 0.5 });
    expect(metrics.findings).toEqual({
      reported: 4,
      unique: 3,
      bySeverity: { critical: 1, warning: 3, suggestion: 0 },
      byVerification: { confirmed: 4, uncertain: 0, unchecked: 0 },
    });
    expect(metrics.outcomes).toEqual({ fixed: 1, dismissed: 1, acceptanceRate: 0.5 });
    expect(metrics.reviewers).toEqual({
      correctness: {
        tasks: 2,
        failedTasks: 0,
        findings: 3,
        costUsd: 0.75,
        fixed: 1,
        dismissed: 0,
        acceptanceRate: 1,
      },
      security: {
        tasks: 1,
        failedTasks: 1,
        findings: 1,
        costUsd: 0.25,
        fixed: 0,
        dismissed: 1,
        acceptanceRate: 0,
      },
    });

    const out = capture();
    expect(await metricsCommand(["--format", "json"], out, dir)).toBe(0);
    expect(JSON.parse(out.text())).toMatchObject({ version: 1, runs: { total: 2 } });

    const text = capture();
    expect(await metricsCommand([], text, dir)).toBe(0);
    expect(text.text()).toContain("Runs: 2 (1 incomplete, 2 unreadable)");
    expect(text.text()).toContain("Outcomes: 1 fixed, 1 dismissed, acceptance 50%");
    expect(text.text()).toMatch(/^correctness\s+2\s+0\s+3\s+\$0\.75\s+1\s+0\s+100%$/m);
  });

  it("credits a fix or a dismissal to the reviewer recorded with it, old reports by fingerprint", async () => {
    const prior = (fingerprint: string, reviewer?: string) => ({
      fingerprint,
      title: "t",
      file: "src/a.ts",
      severity: "warning",
      verification: "confirmed",
      ...(reviewer ? { reviewer } : {}),
    });
    // The review that reported A and B left no session here (another machine,
    // or cleaned up): only the recorded reviewer can tell who reported them.
    // C's earlier report predates the field and is credited by fingerprint.
    const dir = repoWithSessions({
      "20261001T100000Z-000001": report({
        runId: "20261001T100000Z-000001",
        findings: [finding(C, "correctness")],
      }),
      "20261002T100000Z-000002": report({
        runId: "20261002T100000Z-000002",
        rereview: {
          fixed: [prior(A, "security"), prior(C)],
          notReproduced: [],
          notRechecked: [],
          unchanged: [],
          dismissed: [prior(B, "performance")],
        },
      }),
    });
    const metrics = await collectMetrics(join(dir, ".ocra", "sessions"));
    expect(metrics.outcomes).toEqual({ fixed: 2, dismissed: 1, acceptanceRate: 2 / 3 });
    expect(metrics.reviewers.security).toMatchObject({ tasks: 0, fixed: 1, dismissed: 0 });
    expect(metrics.reviewers.performance).toMatchObject({ fixed: 0, dismissed: 1 });
    // Without a recorded reviewer, the fingerprint's reporter is credited.
    expect(metrics.reviewers.correctness).toMatchObject({ fixed: 1, dismissed: 0 });
  });

  it("counts a task a resumed run reused at the cost of the run that paid for it", async () => {
    const first = "20261001T100000Z-000001";
    const cost = (usd: number) => ({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      costUsd: usd,
    });
    const dir = repoWithSessions({
      [first]: report({
        runId: first,
        tasks: [
          task("correctness-1", "correctness", 0.5),
          task("security-1", "security", 0, "failed"),
        ],
        usage: cost(0.5),
      }),
      // The resumed run keeps the reused task's earlier usage, marked by reusedFrom.
      "20261001T110000Z-000002": report({
        runId: "20261001T110000Z-000002",
        tasks: [
          { ...task("correctness-1", "correctness", 0.5), reusedFrom: first },
          task("security-1", "security", 0.25),
        ],
        usage: cost(0.25),
      }),
    });
    const metrics = await collectMetrics(join(dir, ".ocra", "sessions"));
    expect(metrics.cost.usd).toBe(0.75);
    expect(metrics.reviewers.correctness).toMatchObject({ tasks: 2, costUsd: 0.5 });
    expect(metrics.reviewers.security).toMatchObject({ tasks: 2, costUsd: 0.25 });
  });

  it("limits the runs with --since, by the start time in the session id", async () => {
    const dir = repoWithSessions({
      "20261001T100000Z-000001": report({ runId: "20261001T100000Z-000001" }),
      "20261002T100000Z-000002": report({ runId: "20261002T100000Z-000002" }),
    });
    const out = capture();
    await metricsCommand(["--since", "2026-10-02", "--format", "json"], out, dir);
    expect(JSON.parse(out.text())).toMatchObject({
      since: "2026-10-02T00:00:00.000Z",
      runs: { total: 1 },
    });
  });

  it("reports an empty directory as no runs, and refuses a bad date or format", async () => {
    const dir = repoWithSessions({});
    const out = capture();
    await metricsCommand(["--format", "json"], out, dir);
    expect(JSON.parse(out.text())).toMatchObject({
      runs: { total: 0, unreadable: 0 },
      cost: { usdPerRun: null },
      outcomes: { acceptanceRate: null },
    });
    await expect(metricsCommand(["--since", "yesterday"], capture(), dir)).rejects.toThrow(
      /ISO 8601/,
    );
    await expect(metricsCommand(["--format", "xml"], capture(), dir)).rejects.toThrow(
      /text or json/,
    );
  });
});
